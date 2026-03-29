# AGENTS.md — DeltaSync

This file orients coding agents and contributors working in this repository.

## What this project is

**DeltaSync** (`delta-sync` on npm) is a lightweight TypeScript library for bi-directional data sync: local and remote `DatabaseAdapter` implementations, versioned records (`_ver`), incremental sync via checkpoints, tombstones for deletes, and optional auto pull/push. The main entry point is `SyncEngine` in `core/SyncEngine.ts`.

## Repository layout

| Path | Role |
|------|------|
| `index.ts` | Public exports (`types`, `SyncEngine`, `SyncView`, `option`, `clear`) |
| `core/types.ts` | `DatabaseAdapter`, sync types, `SyncStatus`, tombstone store name |
| `core/SyncEngine.ts` | Orchestration: save/delete, push/pull, full/incremental sync, timers |
| `core/SyncView.ts` | Lightweight view metadata and diffing for sync |
| `core/sync.ts` | Applying diffs and changes to adapters |
| `core/option.ts` | `SyncOptions` and defaults |
| `core/clear.ts` | Tombstone retention / cleanup |
| `readme.md` | User-facing documentation and API examples |
| `README.zh-CN.md` | Chinese readme |

`package.json` also declares subpath exports for `./adapters/indexeddb` and `./adapters/memory`; if those paths are absent in a checkout, treat them as optional or not yet present in tree.

## Commands

- **Build**: `npm run build` (TypeScript → `dist/`)
- **Watch build**: `npm run dev`
- **Tests**: `npm test` (Vitest)
- **Clean**: `npm run clean`

## Conventions for changes

- **Language**: TypeScript, `"type": "module"`, `strict` mode. Match existing style in touched files (indentation, quotes, naming).
- **Public API**: Prefer exporting through `index.ts`; avoid breaking `DatabaseAdapter` contracts documented in `readme.md` (`listStoreItems` ordering, `since`/`before`, `id` + `_ver` on items).
- **Versions**: `_ver` is managed by the engine; do not encourage manual `_ver` mutation in docs or new APIs unless there is a deliberate exception.
- **Scope**: Keep edits focused on the requested behavior; avoid unrelated refactors or new docs unless asked.
- **User docs**: Primary narrative lives in `readme.md` / `README.zh-CN.md`; update those when user-visible behavior changes.

## Quick mental model

1. Adapters implement storage; `SyncEngine` owns scheduling, pending change sets, and coordination with `SyncView` + `sync.ts`.
2. Deletes propagate via the tombstone store when it is included in `storesToSync`.
3. Conflict policy is “latest `_ver` wins” unless you introduce a clearly documented alternative.

When in doubt, cross-check behavior against `readme.md` and existing tests before changing sync semantics.
