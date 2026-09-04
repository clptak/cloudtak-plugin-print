#!/usr/bin/env bash
#
# Submit a harvested print job, wait for it, and save the result.
#
#   bash deploy/submit-job.sh ~/print-job.json [output.png]
#
# Run this on the VPS. The print service listens on loopback only, so the job
# file has to be on that box:
#
#   scp ~/Downloads/print-job.json you@vps:~/
#
set -euo pipefail

JOB_FILE=${1:?usage: submit-job.sh <print-job.json> [output.png]}
OUT=${2:-./sheet.png}
BASE=${BASE:-http://127.0.0.1:5010}
CONTAINER=${PRINT_CONTAINER:-cloudtak-print}

[ -f "$JOB_FILE" ] || { echo "no such file: $JOB_FILE" >&2; exit 1; }

# Minted inside the container from the shared secret, and never printed.
TOKEN=$(docker exec "$CONTAINER" node -e '
const jwt = require("jsonwebtoken");
process.stdout.write(jwt.sign({ email: "fidelity@local", access: "user" }, process.env.SigningSecret));
')
[ -n "$TOKEN" ] || { echo "could not mint a token — is SigningSecret set in $CONTAINER?" >&2; exit 1; }

# PROBE=1 renders tiny and fails fast: same style, same sources, 480x320, 60s.
# For diagnosing a stuck render without paying for a full sheet.
SEND="$JOB_FILE"
if [ "${PROBE:-0}" = "1" ]; then
    SEND=$(mktemp /tmp/print-probe-XXXXXX.json)
    python3 -c '
import json, sys
job = json.load(open(sys.argv[1]))
job["probe"] = True
json.dump(job, open(sys.argv[2], "w"))
' "$JOB_FILE" "$SEND"
    echo "PROBE MODE — small viewport, 60s timeout, not a usable sheet"
fi

echo "submitting $(du -h "$SEND" | cut -f1) payload..."

RESP=$(curl -sS -X POST "$BASE/print-api/jobs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data-binary @"$SEND")

ID=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("job",""))' 2>/dev/null || true)

if [ -z "$ID" ]; then
    echo "submission failed:" >&2
    printf '%s\n' "$RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESP"
    exit 1
fi

printf '%s' "$RESP" | python3 -m json.tool
echo "job $ID — waiting..."

START=$(date +%s)
STATUS=""
for _ in $(seq 1 200); do
    S=$(curl -sS "$BASE/print-api/jobs/$ID" -H "Authorization: Bearer $TOKEN")
    STATUS=$(printf '%s' "$S" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
    case "$STATUS" in
        complete|failed)
            echo
            echo "===== ${STATUS} in $(( $(date +%s) - START ))s ====="
            printf '%s' "$S" | python3 -m json.tool
            break ;;
    esac
    sleep 3
done

if [ "$STATUS" != "complete" ]; then
    echo "job did not complete (status=${STATUS:-unknown})" >&2
    exit 1
fi

curl -sS "$BASE/print-api/jobs/$ID/result" -H "Authorization: Bearer $TOKEN" -o "$OUT"
echo
echo "saved $OUT  ($(du -h "$OUT" | cut -f1))"
command -v file >/dev/null && file "$OUT"
echo
echo "Read the 'warnings' array above — it names any source that was dropped and why."
