# Overridable internal service URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stock CloudTAK compose project (services `api`, `tiles`, `store`) can print without DNS failures, and a stack that still names those services `cloudtak-api`, `cloudtak-tiles`, and `cloudtak-store` can point Print at them from `.env`.

**Architecture:** Compose interpolates `API_INTERNAL_URL` and `TILES_INTERNAL_URL` from `PRINT_API_INTERNAL_URL` and `PRINT_TILES_INTERNAL_URL` in the stack `.env`, with stock defaults `http://api:5000` and `http://tiles:5002`. That works because TAK Portal starts the overlay with `docker compose -f <stack compose> -f docker-compose.plugin-print.yml` from the stack directory, so the stack `.env` is the interpolation source, and the `environment:` entry then wins over `env_file:`. `depends_on` stays literal `api`, `tiles`, `store`. TAK Portal's `rewriteComposeDepends` (`takportal/services/cloudtakMarketplace.align.js`) rewrites the overlay file before Compose runs, and its list parser (`[^:#\s]+`) stops at the colon in `${VAR:-api}` and drops the entry. Literal stock names are already in the base compose, so the rewriter keeps them. A renamed stack edits those three lines in its pasted block; it does not get a `.env` knob for `depends_on`.

**Tech Stack:** Docker Compose interpolation, Node `node:test` + `tsx`, TypeScript service config.

## Global Constraints

- Shipped URL defaults are exactly `http://api:5000` and `http://tiles:5002`.
- Override names are exactly `PRINT_API_INTERNAL_URL` and `PRINT_TILES_INTERNAL_URL`. The process still reads `API_INTERNAL_URL` and `TILES_INTERNAL_URL`.
- Do not set `API_URL` on the print service. Public hosts come from `env_file: .env`.
- `depends_on` values in `deploy/compose.service.yml` are the literals `api`, `tiles`, and `store`. No `${...}` on those lines.
- Do not change `deploy/Caddyfile.snippet`, render/style tests, or the allowlist logic. Those tests pass explicit hosts; they are not the defaults.
- `deploy/update.sh` does not edit the stack's `docker-compose.yml`. A pasted block changes only when someone pastes again.

---

### Task 1: Stock defaults in `config()`

**Files:**
- Create: `service/test/config.test.ts`
- Modify: `service/lib/config.ts` (the two fallback strings around lines 102–103)

**Interfaces:**
- Consumes: `config()` and `resetConfig()` from `service/lib/config.ts`. `config()` memoises; tests must call `resetConfig()` before each read.
- Produces: unset `API_INTERNAL_URL` resolves to `http://api:5000`; unset `TILES_INTERNAL_URL` resolves to `http://tiles:5002`. A set value wins over the fallback.

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import config, { resetConfig } from '../lib/config.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetConfig();
    try {
        fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetConfig();
    }
}

test('internal URL fallbacks are the stock CloudTAK service names', () => {
    withEnv(
        {
            SigningSecret: 'test-secret',
            API_INTERNAL_URL: undefined,
            TILES_INTERNAL_URL: undefined,
        },
        () => {
            const c = config();
            assert.equal(c.apiUrl, 'http://api:5000');
            assert.equal(c.tilesInternalUrl, 'http://tiles:5002');
        },
    );
});

test('API_INTERNAL_URL and TILES_INTERNAL_URL override the stock fallbacks', () => {
    withEnv(
        {
            SigningSecret: 'test-secret',
            API_INTERNAL_URL: 'http://cloudtak-api:5000',
            TILES_INTERNAL_URL: 'http://cloudtak-tiles:5002',
        },
        () => {
            const c = config();
            assert.equal(c.apiUrl, 'http://cloudtak-api:5000');
            assert.equal(c.tilesInternalUrl, 'http://cloudtak-tiles:5002');
        },
    );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd service && npx tsx --test test/config.test.ts`

Expected: FAIL. `c.apiUrl` is `http://cloudtak-api:5000`.

- [ ] **Step 3: Change the two fallbacks**

In `service/lib/config.ts`, replace:

```ts
        apiUrl: process.env.API_INTERNAL_URL || 'http://cloudtak-api:5000',
        tilesInternalUrl: process.env.TILES_INTERNAL_URL || 'http://cloudtak-tiles:5002',
```

with:

```ts
        apiUrl: process.env.API_INTERNAL_URL || 'http://api:5000',
        tilesInternalUrl: process.env.TILES_INTERNAL_URL || 'http://tiles:5002',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd service && npx tsx --test test/config.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add service/lib/config.ts service/test/config.test.ts
git commit -m "$(cat <<'EOF'
fix: default print internal URLs to stock CloudTAK service names

EOF
)"
```

---

### Task 2: Compose URLs overridable, depends_on stock literals

**Files:**
- Modify: `deploy/compose.service.yml` (depends_on block and the two URL lines)

**Interfaces:**
- Consumes: nothing from Task 1. Compose sets `API_INTERNAL_URL` before the process starts, so the Task 1 fallback is only for a process launched without that variable.
- Produces: `docker compose config` (from a throwaway project whose `.env` is empty) resolves `API_INTERNAL_URL=http://api:5000` and `TILES_INTERNAL_URL=http://tiles:5002`, and `depends_on` is `api`, `tiles`, `store`. With `PRINT_API_INTERNAL_URL` and `PRINT_TILES_INTERNAL_URL` set, those resolved values replace the defaults. TAK Portal's rewriter, given a base file whose services are `api`, `tiles`, and `store`, leaves those three `depends_on` entries in place.

- [ ] **Step 1: Replace the depends_on list and the two URL assignments**

In `deploy/compose.service.yml`, replace the `depends_on` list and the two internal URL lines so the service block contains this. Leave every other key as it is.

```yaml
    # Stock CloudTAK service names (dfpc-coe/CloudTAK docker-compose.yml).
    # A stack that names them cloudtak-api / cloudtak-tiles / cloudtak-store
    # replaces these three lines in its pasted block. Do not write ${VAR:-api}
    # here: TAK Portal rewrites this file before Compose interpolates, and its
    # depends_on parser stops at ':' and drops the entry.
    depends_on:
      - api
      - tiles
      - store
```

```yaml
      - API_INTERNAL_URL=${PRINT_API_INTERNAL_URL:-http://api:5000}
      - TILES_INTERNAL_URL=${PRINT_TILES_INTERNAL_URL:-http://tiles:5002}
```

The comment sits immediately above `depends_on:`. The URL lines replace the two hardcoded `http://cloudtak-*` assignments inside `environment:`. `PRINT_CONCURRENCY` and the lines below it stay.

- [ ] **Step 2: Prove Compose interpolation**

Run from the repo root:

```bash
tmpdir=$(mktemp -d)
cat > "$tmpdir/compose.yml" <<'EOF'
services:
  api:
    image: busybox
  tiles:
    image: busybox
  store:
    image: busybox
EOF
# The shipped file is a fragment. Wrap it the way TAK Portal does: a services: key
# and two extra spaces of indent.
{
  echo "services:"
  sed 's/^/  /' deploy/compose.service.yml
} > "$tmpdir/print.yml"
# Drop the build so config does not need the service directory.
sed -i '' '/build:/,/dockerfile:/d' "$tmpdir/print.yml" 2>/dev/null || sed -i '/build:/,/dockerfile:/d' "$tmpdir/print.yml"

echo "--- defaults ---"
docker compose --project-directory "$tmpdir" -f "$tmpdir/compose.yml" -f "$tmpdir/print.yml" config \
  | awk '/cloudtak-print:/,/^  [^ ]/'

PRINT_API_INTERNAL_URL=http://cloudtak-api:5000 \
PRINT_TILES_INTERNAL_URL=http://cloudtak-tiles:5002 \
  docker compose --project-directory "$tmpdir" -f "$tmpdir/compose.yml" -f "$tmpdir/print.yml" config \
  | awk '/API_INTERNAL_URL/,/TILES_INTERNAL_URL/'

rm -rf "$tmpdir"
```

Expected under defaults: `API_INTERNAL_URL: http://api:5000`, `TILES_INTERNAL_URL: http://tiles:5002`, and depends_on entries `api`, `tiles`, `store`. Expected under the two env vars: `http://cloudtak-api:5000` and `http://cloudtak-tiles:5002`.

If `docker compose` is unavailable, stop and say so. Do not claim this step passed.

- [ ] **Step 3: Prove TAK Portal keeps the literal depends_on**

Run from the repo root. The align script lives in the sibling checkout `../takportal`. If that path is missing, skip this step and say it was not run.

```bash
node --input-type=module -e '
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const align = require("../takportal/services/cloudtakMarketplace.align.js");
const fragment = readFileSync("deploy/compose.service.yml", "utf8");
const overlay = "services:\n" + fragment.split("\n").map((l) => (l.length ? "  " + l : l)).join("\n");
const base = "services:\n  api:\n    image: x\n  tiles:\n    image: x\n  store:\n    image: x\n";
const known = align.composeServiceNames(base);
const result = align.rewriteComposeDepends(overlay, known, "cloudtak");
const deps = result.text.split("\n").filter((l) => /^\s+-\s+/.test(l) && /api|tiles|store/.test(l));
console.log(result.notes);
console.log(deps.map((l) => l.trim()).join("\n"));
if (!deps.some((l) => l.includes("- api"))) process.exit(1);
if (!deps.some((l) => l.includes("- tiles"))) process.exit(1);
if (!deps.some((l) => l.includes("- store"))) process.exit(1);
if (result.notes.some((n) => n.startsWith("dropped"))) process.exit(1);
'
```

Expected: notes empty or only identity mappings, and the three lines `- api`, `- tiles`, `- store`. Exit code 0.

`composeServiceNames` and `rewriteComposeDepends` are on the module exports (`cloudtakMarketplace.align.js` assigns them in `module.exports`). If a name is missing, read the exports at the bottom of that file and call the exported function; do not reimplement the rewriter.

- [ ] **Step 4: Commit**

```bash
git add deploy/compose.service.yml
git commit -m "$(cat <<'EOF'
fix: let stacks override print API and tiles URLs from .env

EOF
)"
```

---

### Task 3: Document the override and the upgrade path

**Files:**
- Modify: `service/.env.example` (lines 1–6)
- Modify: `README.md` (Install step 2, after the paragraph that says only `SigningSecret` is required; and a short subsection under Updating)
- Modify: `docs/DESIGN.md` section 9 compose sample: the `depends_on` line and `TILES_INTERNAL_URL` line, plus one paragraph under Notes

**Interfaces:**
- Consumes: the variable names and defaults from Task 2.
- Produces: a reader of the README can set the two URL overrides and knows `depends_on` is a three-line edit. A reader of Updating knows `update.sh` does not patch the live compose file.

- [ ] **Step 1: Replace the internal-URL block in `service/.env.example`**

Replace the comment and the two assignments at the top (through `TILES_INTERNAL_URL=...`) with:

```bash
# Shared with the CloudTAK API, tiles, and events services. Required.
SigningSecret=

# Compose interpolates these into the print service. Unset means a stock
# CloudTAK stack (service names api, tiles, store). A stack whose services
# are named cloudtak-api / cloudtak-tiles sets the two variables below in
# the stack .env. depends_on is not read from here; edit those three lines
# in the pasted compose block.
# PRINT_API_INTERNAL_URL=http://cloudtak-api:5000
# PRINT_TILES_INTERNAL_URL=http://cloudtak-tiles:5002

# What the Node process reads. Compose sets these from the PRINT_* values
# above. Set them yourself only when running the service outside Compose.
# API_INTERNAL_URL=http://api:5000
# TILES_INTERNAL_URL=http://tiles:5002
```

Keep the rest of the file, including the `API_URL` / `PMTILES_URL` comment that follows.

- [ ] **Step 2: Add the override paragraph to README Install step 2**

Immediately after the paragraph that begins "Copy `service/.env.example`", add:

```markdown
The shipped service block calls the API at `http://api:5000` and tiles at `http://tiles:5002`, and waits for services `api`, `tiles`, and `store`. That matches upstream CloudTAK. A stack that names those containers `cloudtak-api`, `cloudtak-tiles`, and `cloudtak-store` sets this in the stack `.env`:

```sh
PRINT_API_INTERNAL_URL=http://cloudtak-api:5000
PRINT_TILES_INTERNAL_URL=http://cloudtak-tiles:5002
```

and changes the three `depends_on` entries in the pasted block to those service names. Compose reads `PRINT_*` while interpolating the file. Putting `API_INTERNAL_URL` in `.env` alone does nothing: the service's `environment:` list wins over `env_file:`.
```

- [ ] **Step 3: Add the upgrade note under README Updating**

After the paragraph that starts "Pulls, installs the plugin", add:

```markdown
`update.sh` pulls this repository and rebuilds images. It does not edit the `cloudtak-print` block already pasted into the stack `docker-compose.yml`. After pulling a change to `deploy/compose.service.yml`, re-paste that block (or edit the live one to match) and recreate the container. On this renamed stack the `.env` must contain `PRINT_API_INTERNAL_URL=http://cloudtak-api:5000` and `PRINT_TILES_INTERNAL_URL=http://cloudtak-tiles:5002`, and `depends_on` must stay `cloudtak-api`, `cloudtak-tiles`, `cloudtak-store`. Check the resolved file with `docker compose config` and, from inside the print container, `getent hosts` on the host in `API_INTERNAL_URL`. A marketplace install does not need those variables: TAK Portal composes the overlay from the stack directory, so an unset `PRINT_*` becomes `http://api:5000` and `http://tiles:5002`, and the literal `depends_on` names are ones Portal already keeps.
```

- [ ] **Step 4: Update the DESIGN.md section 9 sample**

In the section 9 compose sample, replace:

```yaml
    depends_on: [cloudtak-api, cloudtak-tiles, cloudtak-store]
```

with:

```yaml
    depends_on: [api, tiles, store]
```

Replace:

```yaml
      - TILES_INTERNAL_URL=http://cloudtak-tiles:5002
```

with:

```yaml
      - API_INTERNAL_URL=${PRINT_API_INTERNAL_URL:-http://api:5000}
      - TILES_INTERNAL_URL=${PRINT_TILES_INTERNAL_URL:-http://tiles:5002}
```

Under Notes, add this bullet:

```markdown
- **Internal URLs default to `api:5000` and `tiles:5002`.** `PRINT_API_INTERNAL_URL` and `PRINT_TILES_INTERNAL_URL` in the stack `.env` override them. `depends_on` is the literal service names `api`, `tiles`, and `store`; a renamed stack edits those three names in the pasted block. `${VAR:-api}` is not used there, because TAK Portal's depends_on rewriter drops any entry containing `:`.
```

Do not otherwise rewrite section 9. It still describes one deployment's CPU limit and build context.

- [ ] **Step 5: Commit**

```bash
git add service/.env.example README.md docs/DESIGN.md
git commit -m "$(cat <<'EOF'
docs: describe print internal URL overrides and the compose re-paste

EOF
)"
```

---

## Self-review

- Issue requirement "URLs overridable, stock defaults `http://api:5000` and `http://tiles:5002`": Task 2.
- Issue requirement "same for depends_on": Task 2 uses literal stock names, not `.env` interpolation, because Portal's rewriter drops `${VAR:-api}`. Documented in the compose comment, README, and DESIGN.
- `config.ts` fallbacks match the compose defaults: Task 1.
- Portal does not rewrite `environment:` values: no Portal change in this plan. Interpolation happens at `docker compose -f base -f override` in the stack directory, which is how Portal starts the service.
- This repo's `update.sh` will not carry the compose edit onto a VPS by itself: Task 3.

## Upgrade path (this repository)

The change lives in `clptak/cloudtak-plugin-print` on the working branch until it is pushed. `deploy/update.sh` git-pulls and rebuilds; it leaves `~/tak-stack/docker-compose.yml` alone, so the running service keeps `http://cloudtak-api:5000` until the pasted block is edited and the container is recreated. After the edit, the renamed stack sets the two `PRINT_*` variables and keeps `depends_on` on `cloudtak-api`, `cloudtak-tiles`, and `cloudtak-store`. Verify with `docker compose config` and `getent hosts` inside `cloudtak-print`. A stock marketplace install needs no `.env` change. Nothing here is a CloudTAK core patch, so an upstream CloudTAK update does not drop it. TAK Portal does not need a matching change for this fix.
