#!/usr/bin/env bash
#
# Update a cloudtak-plugin-print deployment.
#
# Pulls the repository, installs the plugin into CloudTAK's web tree, and rebuilds
# only what actually changed -- the cloudtak-api image takes minutes and carries
# the whole CloudTAK web build, so rebuilding it for a service-only change is
# several minutes of downtime for nothing.
#
#   ./cloudtak-plugin-print/deploy/update.sh              pull and rebuild what changed
#   ./cloudtak-plugin-print/deploy/update.sh --force      rebuild both regardless
#   ./cloudtak-plugin-print/deploy/update.sh --check      report state, change nothing
#
# Assumes the layout the README documents:
#
#   <stack>/docker-compose.yml
#   <stack>/CloudTAK/
#   <stack>/cloudtak-plugin-print/
#
# Override with STACK_DIR and CLOUDTAK_DIR if yours differs. Set PRINT_HOST to
# have the public route checked through Caddy at the end.

set -euo pipefail

FORCE=0
CHECK_ONLY=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --check) CHECK_ONLY=1 ;;
        -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

say()  { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die()  { printf '!! %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="${STACK_DIR:-$(dirname "$REPO_DIR")}"
CLOUDTAK_DIR="${CLOUDTAK_DIR:-$STACK_DIR/CloudTAK}"

PLUGIN_SRC="$REPO_DIR/plugin"
PLUGIN_DEST="$CLOUDTAK_DIR/api/web/plugins/print"

[ -f "$STACK_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $STACK_DIR (set STACK_DIR)"
[ -d "$CLOUDTAK_DIR/api/web" ]         || die "no CloudTAK web tree at $CLOUDTAK_DIR (set CLOUDTAK_DIR)"
[ -d "$PLUGIN_SRC" ]                   || die "no plugin/ directory in $REPO_DIR"

say "Paths"
printf '   stack     %s\n   cloudtak  %s\n   repo      %s\n' "$STACK_DIR" "$CLOUDTAK_DIR" "$REPO_DIR"

# ---- the configuration trap ------------------------------------------------
# PRINT_LAYOUT_DPI=96 makes markScale exactly 1. Before the put() fix that got the
# whole style rejected; it still means laying out at 96 and enlarging, which is
# what produced ghost contours and blocky hillshade. The code default is 0.
for f in "$STACK_DIR/docker-compose.yml" "$STACK_DIR/.env"; do
    [ -f "$f" ] || continue
    if grep -qE '^[^#]*PRINT_LAYOUT_DPI=.*\b96\b' "$f"; then
        warn "PRINT_LAYOUT_DPI is set to 96 in $(basename "$f")."
        warn "Set it to 0 (lay out at output resolution) or sheets print soft."
    fi
done

# ---- what changed ----------------------------------------------------------
cd "$REPO_DIR"

[ -z "$(git status --porcelain)" ] || die "uncommitted changes in $REPO_DIR -- commit, stash or discard them first"

BEFORE="$(git rev-parse HEAD)"

if [ "$CHECK_ONLY" -eq 1 ]; then
    say "Check only, fetching without merging"
    git fetch --quiet
    BEHIND="$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)"
    printf '   at %s, %s commit(s) behind\n' "$(git rev-parse --short HEAD)" "$BEHIND"
    exit 0
fi

say "Pulling"
git pull --ff-only

AFTER="$(git rev-parse HEAD)"

BUILD_PLUGIN=0
BUILD_SERVICE=0

if [ "$BEFORE" = "$AFTER" ]; then
    if [ "$FORCE" -eq 0 ]; then
        say "Already up to date at $(git rev-parse --short HEAD). Nothing to do."
        echo "   (--force rebuilds anyway)"
        exit 0
    fi
    BUILD_PLUGIN=1
    BUILD_SERVICE=1
else
    CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"
    printf '   %s -> %s\n' "${BEFORE:0:7}" "${AFTER:0:7}"
    while IFS= read -r line; do printf '     %s\n' "$line"; done <<< "$CHANGED"

    echo "$CHANGED" | grep -q '^plugin/'  && BUILD_PLUGIN=1
    echo "$CHANGED" | grep -q '^service/' && BUILD_SERVICE=1
fi

if [ "$FORCE" -eq 1 ]; then BUILD_PLUGIN=1; BUILD_SERVICE=1; fi

if [ "$BUILD_PLUGIN" -eq 0 ] && [ "$BUILD_SERVICE" -eq 0 ]; then
    say "Only docs changed. No rebuild needed."
    exit 0
fi

# ---- install the plugin ----------------------------------------------------
if [ "$BUILD_PLUGIN" -eq 1 ]; then
    say "Installing the plugin into CloudTAK"

    # Belt and braces before an rm -rf on someone's machine.
    case "$PLUGIN_DEST" in
        */api/web/plugins/print) ;;
        *) die "refusing to remove $PLUGIN_DEST -- not a plugins/print path" ;;
    esac

    rm -rf "$PLUGIN_DEST"
    cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"
    printf '   %s\n' "$PLUGIN_DEST"
fi

# ---- rebuild ---------------------------------------------------------------
cd "$STACK_DIR"

TARGETS=()
[ "$BUILD_SERVICE" -eq 1 ] && TARGETS+=(cloudtak-print)
[ "$BUILD_PLUGIN"  -eq 1 ] && TARGETS+=(cloudtak-api)

say "Building: ${TARGETS[*]}"
if [ "$BUILD_PLUGIN" -eq 1 ]; then
    echo "   cloudtak-api rebuilds the whole CloudTAK web app; this takes a few minutes."
fi

docker compose build "${TARGETS[@]}"
docker compose up -d "${TARGETS[@]}"

# ---- verify ----------------------------------------------------------------
say "Verifying"

if [ "$BUILD_SERVICE" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
    for _ in $(seq 1 30); do
        if docker compose exec -T cloudtak-print node -e \
            "fetch('http://localhost:5010/print-api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            break
        fi
        sleep 2
    done

    docker compose logs --tail 40 cloudtak-print | grep -E 'layoutDpi|chromium ready' | sed 's/^/   /' || true
fi

# Through Caddy, which is the path the browser actually takes. Both URLs, because
# /print-api/health passing proves only that /print-api/<something> routes -- the
# panel calls the bare /print-api first, and a handle /print-api/* matcher misses it.
if [ -n "${PRINT_HOST:-}" ]; then
    printf '   health   %s\n' "$(curl -sS "https://$PRINT_HOST/print-api/health" || echo FAILED)"
    TYPE="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "https://$PRINT_HOST/print-api" || echo FAILED)"
    printf '   info     %s\n' "$TYPE"
    case "$TYPE" in
        *json*) ;;
        *) warn "GET /print-api did not return JSON. Caddy is not routing it -- see deploy/Caddyfile.snippet." ;;
    esac
else
    echo "   set PRINT_HOST=your.cloudtak.host to also check the public route"
fi

say "Done at $(git -C "$REPO_DIR" rev-parse --short HEAD)"
