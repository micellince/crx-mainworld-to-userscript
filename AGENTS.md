# AGENTS.md

Instructions for coding agents (and humans) working in this repository.

## Ground rules

- **Zero runtime dependencies.** `src/` may only use Node.js built-ins (`node:fs/promises`, `node:path`, `node:crypto`, `node:vm`, `node:os`, …). Do not add `dependencies` to `package.json`.
- **Keep the verifier strict.** Never weaken a verification check to make a build pass. If a genuine platform limitation appears, document it in `docs/compatibility.md` and emit a conversion warning instead.
- **Tests are the contract.** `npm test` must stay green. Add a test for every behavior change (including changes to warnings and gating).
- **Warnings are public output.** `bundle.warnings` is printed by the CLI and appears in `--json`; keep wording actionable and specific.
- **Keep the compatibility matrix in sync.** If the parser learns about a new browser API, category, or conversion behavior, update `docs/compatibility.md` and `README.md` at the same time.
- **Versioning:** bump `version` in `package.json` and `GENERATOR` in `src/compiler.mjs` together (same version).
- **Security:** any change to parser file handling must preserve the `realpath()` containment check; any change to the verifier must keep recomputing payload hashes from the artifact.
- **No secrets** in tests, fixtures, or generated artifacts.

## Commands

```bash
npm test                    # 22 node:test cases (Node 20.11+ recommended)
npm run convert:fixture     # self-contained fixture → dist/generic-companion.user.js, verified
node src/cli.mjs convert <extension-dir> -o <out.user.js> --verify
node src/cli.mjs verify <out.user.js> --source <extension-dir> --json
```

## Architecture

```
parser.mjs   manifest.json + files → generic bundle
             (matches/gates/run_at/world, content scripts, importScripts graph,
              page scripts, CSS, binary assets, storage usage, unsupported APIs)
compiler.mjs bundle → single .user.js
             (runtime template serialized via Function#toString,
              chrome.* shims, GM_xhr-backed fetch, HTML injection, gating)
verifier.mjs .user.js + source bundle → 4-stage report
index.mjs    public API + convenience wrappers
cli.mjs      argument parsing, human/JSON output, exit codes
```

Generated userscript layout:

```text
==UserScript== header
// __CRX2USER_AUDIT_JSON__: {...}    metadata + declared hashes
(function crx2userRuntime() {
  var PAYLOADS = JSON.parse("...")   // embedded source of truth (extractable + re-hashable)
  ... background boot, chrome shims, CSS, content scripts, page scripts ...
})();
```

Do not rename or reformat the `var PAYLOADS = JSON.parse("…");` assignment without updating `parseEmbeddedPayloads()` in `src/verifier.mjs` — it is the anchor for byte-level verification.

## Test fixture

`tests/fixtures/generic-mv3-ext/` is a self-contained generic MV3 extension covering: recursive `importScripts`, multiple content-script groups, `exclude_matches`, `world: "MAIN"`, content CSS, web-accessible JS/CSS/PNG, `chrome.storage`, `getManifest`, `getURL`. If you extend the converter, extend the fixture or add a temp-extension test instead of hardcoding a product.

## Release checklist

1. `npm test`
2. `npm run convert:fixture`
3. Convert a real extension (e.g. `node src/cli.mjs convert ../dist/fc27-enhancer-ext -o /tmp/x.user.js --verify`) and inspect the warnings.
4. Bump `package.json` version + `GENERATOR`.
5. Commit, push, tag `vX.Y.Z`, create a GitHub release.
