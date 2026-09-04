#!/usr/bin/env bash
#
# Collects everything needed to finish configuring the print service.
# Read-only apart from submitting one render job to the print service itself.
# Prints nothing secret: no token, no password, no SigningSecret.
#
# Usage:  bash deploy/collect-report.sh
#
set -uo pipefail

PRINT_CONTAINER=${PRINT_CONTAINER:-cloudtak-print}
PG_CONTAINER=${PG_CONTAINER:-cloudtak-postgis}
BASE=${BASE:-http://127.0.0.1:5010}

say() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

pp() {  # pretty-print JSON if possible, else pass through
    if have python3; then python3 -m json.tool 2>/dev/null || cat; else cat; fi
}

echo "cloudtak-print report — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

say "1. CONTAINER"
docker ps --filter "name=^/${PRINT_CONTAINER}$" --format '{{.Names}}  {{.Status}}  {{.Image}}' 2>&1
if ! docker ps --format '{{.Names}}' | grep -qx "$PRINT_CONTAINER"; then
    echo "!! ${PRINT_CONTAINER} is not running. Start it first, then re-run this script."
    exit 1
fi

say "2. STARTUP LOG"
docker logs --tail 25 "$PRINT_CONTAINER" 2>&1

say "3. CHROMIUM SOURCE"
docker exec "$PRINT_CONTAINER" sh -c '
    if [ -n "${PRINT_CHROMIUM_PATH:-}" ]; then
        echo "PRINT_CHROMIUM_PATH=$PRINT_CHROMIUM_PATH"
        "$PRINT_CHROMIUM_PATH" --version 2>&1 || echo "(could not run it)"
    else
        echo "PRINT_CHROMIUM_PATH unset — using the Playwright-managed build"
        ls /ms-playwright 2>/dev/null || echo "(no /ms-playwright)"
    fi
' 2>&1

say "4. HEALTH + CONFIG"
curl -sS --max-time 15 "$BASE/print-api/health" 2>&1; echo
curl -sS --max-time 15 "$BASE/print-api" 2>&1 | pp

# Token is minted inside the container from the shared secret and never printed.
TOKEN=$(docker exec "$PRINT_CONTAINER" node -e '
const jwt = require("jsonwebtoken");
process.stdout.write(jwt.sign({ email: "print-report@local", access: "user" }, process.env.SigningSecret));
' 2>/dev/null)

if [ -z "$TOKEN" ]; then
    echo "!! Could not mint a token — is SigningSecret set in the container env?"
    exit 1
fi

say "5. WEBGL  <<< the important one"
curl -sS --max-time 120 "$BASE/print-api/smoke/webgl" -H "Authorization: Bearer $TOKEN" 2>&1 | pp

say "6. SMOKE RENDER"
HTTP=$(curl -sS --max-time 180 "$BASE/print-api/smoke/render?scale=2" \
    -H "Authorization: Bearer $TOKEN" -o /tmp/print-smoke.png -w '%{http_code}' 2>&1)
echo "http=$HTTP  bytes=$(wc -c < /tmp/print-smoke.png 2>/dev/null || echo 0)  saved=/tmp/print-smoke.png"
have file && file /tmp/print-smoke.png

say "7. FULL ANSI D SHEET — TIMING"
START=$(date +%s)
JOB=$(curl -sS --max-time 60 -X POST "$BASE/print-api/jobs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"title":"timing probe","scale":24000,"paper":{"size":"ansi-d","orientation":"portrait"},"center":[-111.65,35.2]}' 2>&1)
echo "$JOB" | pp

ID=$(printf '%s' "$JOB" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("job",""))' 2>/dev/null)

if [ -n "$ID" ]; then
    for _ in $(seq 1 90); do
        S=$(curl -sS --max-time 15 "$BASE/print-api/jobs/$ID" -H "Authorization: Bearer $TOKEN" 2>&1)
        ST=$(printf '%s' "$S" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
        case "$ST" in
            complete|failed)
                echo "status=$ST  elapsed=$(( $(date +%s) - START ))s"
                echo "$S" | pp
                break ;;
        esac
        sleep 2
    done
else
    echo "!! No job id came back."
fi

say "8. BASEMAP HOST CENSUS  <<< sets PRINT_ALLOW_HOSTS"
if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker exec -i "$PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' <<'SQL' 2>&1
\pset border 2
SELECT host, count(*) AS uses, string_agg(DISTINCT src, ', ') AS found_in
FROM (
  SELECT substring(url from '^[a-zA-Z]+://([^/:?]+)') AS host, 'basemaps'        AS src FROM basemaps         WHERE url IS NOT NULL
  UNION ALL
  SELECT substring(url from '^[a-zA-Z]+://([^/:?]+)'),      'basemaps_source'        FROM basemaps_source  WHERE url IS NOT NULL
  UNION ALL
  SELECT substring(url from '^[a-zA-Z]+://([^/:?]+)'),      'profile_overlays'       FROM profile_overlays WHERE url IS NOT NULL
) t
WHERE host IS NOT NULL
GROUP BY host
ORDER BY uses DESC;
SQL
else
    echo "!! ${PG_CONTAINER} not running — skipped."
fi

say "9. BASEMAP DETAIL"
if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker exec -i "$PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' <<'SQL' 2>&1
\pset border 2
SELECT name, type, protocol, overlay, hidden, left(url, 80) AS url
FROM basemaps
ORDER BY hidden, overlay, name;
SQL
fi

say "END OF REPORT"
echo "Paste everything from the top of this output. /tmp/print-smoke.png is a"
echo "separate file — send it if section 6 looks wrong."
