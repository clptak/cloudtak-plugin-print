#!/usr/bin/env bash
#
# Pull cloudtak-plugin-print and rebuild ONLY the cloudtak-print container.
#
# Does not touch CloudTAK, CloudTAK/app/plugins, the CloudTAK API, or any other
# service. Plugin (panel) changes under plugin/ reach CloudTAK through your own
# CloudTAK update, not this script.
#
#   ./cloudtak-plugin-print/deploy/update-service.sh
#
# Assumes the repo sits next to the stack's docker-compose.yml:
#
#   <stack>/docker-compose.yml
#   <stack>/cloudtak-plugin-print/
#
# Set STACK_DIR if yours differs.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="${STACK_DIR:-$(dirname "$REPO_DIR")}"

[ -f "$STACK_DIR/docker-compose.yml" ] || { echo "!! no docker-compose.yml in $STACK_DIR (set STACK_DIR)" >&2; exit 1; }

echo "== Pulling $(git -C "$REPO_DIR" branch --show-current)"
git -C "$REPO_DIR" pull --ff-only

cd "$STACK_DIR"
docker compose config --services | grep -qx cloudtak-print \
    || { echo "!! no cloudtak-print service in $STACK_DIR/docker-compose.yml" >&2; exit 1; }

echo "== Building cloudtak-print"
docker compose build cloudtak-print

echo "== Replacing cloudtak-print only"
docker compose up -d --no-deps cloudtak-print

echo "== GDAL in the new container"
docker exec cloudtak-print gdal_translate --version
