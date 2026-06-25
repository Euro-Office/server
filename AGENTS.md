# server — Euro-Office

@../AGENTS.md

Guidance for Claude Code (and other AI agents) working in **server** — the Node.js backend.

## What this repo is
The stateful backend services for Euro-Office Document Server. Forked from `ONLYOFFICE/server`. Licensed **AGPL-3.0**.

## Architecture & Workflow
- **Async patterns:** Uses `function*` + `co` for async flows. **Do not** refactor to `async/await` unless the entire call chain is updated. Mixing patterns causes race conditions in co-editing state.
- **Storage:** All I/O must pass through the storage abstraction in `Common/sources/storage/` (`storage-base.js` + per-backend drivers `storage-fs.js` / `storage-s3.js` / `storage-az.js`). Never write directly to disk.
- **Persistence:** Database schema lives in `schema/<db>/` (one set per backend: `postgresql`, `mysql`, `mssql`, `oracle`, `dameng`), with `createdb.sql` and an `upgrade/` folder. A schema change must be applied across all backends, never mutated ad-hoc.
- **Packaging:** Uses `pkg`. Adding native modules (`.node`) requires updating `pkg` config.

## Rules
- **Never** modify `SpellChecker/` without installing its dependencies separately — it has its own `package.json` with a native C++ dependency (`nodehun`, built via node-gyp) and is excluded from the main ESLint config. Treat it as an isolated sub-service.
- **Never** commit `.node` binaries or `pkg` artifacts.
- **Never** bypass the storage abstraction in `Common/sources/storage/`.
- **Never** change the co-editing logic in `DocService/sources/` (e.g. `DocsCoServer.js`) without running the full unit test suite (`npm run "unit tests"`).
- **Always** run `npm run code:check` before PR.

## Findings & Long-tail
No centralized findings store exists in this repository yet. Edge-case debugging recipes and co-editing race conditions should be documented in code comments or tracked as GitHub issues until a findings store is established.
