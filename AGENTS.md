# AGENTS.md — fork notes for AI agents and maintainers

This repository is a fork of [cs-au-dk/jelly](https://github.com/cs-au-dk/jelly) (BSD-3-Clause,
forked at v0.13.0). It adds **disk spill mode** (`--spill`) so the analysis survives inputs whose
points-to state exceeds the V8 heap (the `JavaScript heap out of memory` failures on large
dependency trees). Keep this file updated when the fork diverges further.

## Why the refactor exists

Jelly is a whole-program points-to analyzer: the entire solver state lives in the V8 heap.
Two structures grow **superlinearly** with program size and are the OOM killers:

1. per-constraint-variable **points-to sets** (`FragmentState.tokens`) — total membership is
   the "tokens" number in diagnostics;
2. per-listener **processed-token sets** (`FragmentState.listenersProcessed`) — grows with
   tokens × listeners.

Everything else (token/var objects, ASTs, canonicalization tables, subset edges, listener
closures) grows roughly linearly. The refactor moves ONLY the superlinear sets to disk;
objects stay in the heap and sets store their **integer indices** (`Token.index`,
`ConstraintVar.index`, assigned at canonicalization — domain arrays `GlobalState.tokens` /
`GlobalState.vars` map index → object).

## What was changed (all guarded by `options.spill`; stock behavior untouched when off)

| File | Change |
|---|---|
| `src/misc/spillstore.ts` | **New.** `SpillEnv` (LMDB root env, per-pid scratch dir, deleted on exit) and `SpilledIntSetStore`: integer sets keyed by non-negative int id, stored as insertion-ordered `Uint32Array` buffers in LMDB, with an in-heap LRU of decoded `Set<number>` (bounded by `--spill-cache-size` total members) and dirty write-back on eviction. Per-id member counts and the id universe stay in the heap (O(#ids)). |
| `src/analysis/fragmentstate.ts` | Hybrid representation. `tokens` slot type is now `Token \| Set<Token> \| Spilled`; a heap `Set` that reaches `--spill-threshold` members is migrated (`migrate()`) to `spilledTokens` and the slot holds the `Spilled` sentinel. All accessors (`getTokens`, `getTokensSize`, `getSizeAndHas`, `hasToken`, `addToken`, `addTokens`, `deleteVar`, `getAllVarsAndTokens`, `getLargestTokenSetSize`, `isEmpty`, `getNumberOfVarsWithTokens`) handle the sentinel. Same for `listenersProcessed` via the new `listenerProcessed(id, t): boolean` API (dense int numbering of spilled listener ids in `listenerIdIndex`, since `ListenerID` is a bigint and LMDB keys are uint32). |
| `src/analysis/solver.ts` | `callTokenListener` / `callTokenListener2` now use `fragmentState.listenerProcessed(...)` instead of reaching into the map. |
| `src/options.ts`, `src/main.ts` | New options: `--spill <dir>` (scratch location; enables the mode), `--spill-threshold <n>` (default 256), `--spill-cache-size <n>` (default 4,000,000 members). |
| `package.json` | New dependency: `lmdb` (synchronous, memory-mapped — matches the solver's synchronous hot loop; prebuilt native binaries). |

## Invariants an agent must preserve when touching this code

- **Insertion order is part of the semantics.** Spilled sets are serialized in insertion order
  and decoded back into a `Set<number>` in that order, so iteration order matches the stock
  in-heap `Set<Token>` behavior. Do not "optimize" to sorted storage without checking every
  consumer.
- **All token-set access must go through the FragmentState methods.** That encapsulation is
  what made the refactor safe (verified: no direct `.tokens` access outside `fragmentstate.ts`).
  If you add a new accessor, it must handle the `Spilled` sentinel.
- **`addToken`'s AncestorsVar guard applies only in `addToken`, not `addTokens`** — this
  mirrors stock behavior exactly; do not "fix" the asymmetry.
- **Mutation during iteration:** `getTokens` on a spilled set returns a lazy generator over the
  live cached `Set<number>`. If the entry is evicted mid-iteration, adds made after eviction go
  to a fresh decoded copy and are not seen by the ongoing iteration. This is acceptable because
  the solver is a fixpoint worklist — newly added tokens are independently enqueued — but it is
  a divergence from strict stock semantics; keep it in mind for non-solver consumers.
- **Single-threaded only.** The store has no locking; it relies on Jelly's synchronous solver.
- **Scratch data is disposable.** LMDB is opened with `noSync`; the per-pid directory is
  removed on process exit. Never point `--spill` at a directory whose contents matter.

## Validation performed (2026-07-21, Apple silicon, Node 25)

- **Correctness:** output `cg.json` is semantically identical (entries/files/functions/calls/
  fun2fun/call2fun as location sets) between stock and spill on: the `vuln-reachability-test`
  app (also with `--spill-threshold 4` to force near-universal spilling), `@babel/core`
  (270 modules, 540K memberships), and a synthetic points-to blowup (~40M memberships).
- **Memory:** on the blowup fixture, stock needs ~2.5 GB RSS and dies at a 1 GB
  `--max-old-space-size` cap; spill mode **completes at the same 1 GB cap** (~9× slower under
  cache thrash) with an identical graph.
- **No-regression:** on `@babel/core` (a workload dominated by ASTs, not sets — max set 747),
  spill at the default threshold matches stock's memory floor with no measurable overhead.

## Tuning notes

- `--spill-threshold`: below ~256 the churn on medium sets can cost more than it saves
  (measured: threshold 32 made `@babel/core` OOM at a cap where stock passed; 256 removed the
  penalty). Blowup sets are ≫256, so the default only spills what matters.
- `--spill-cache-size`: bigger is not always better — eviction flushes half the cache in one
  wave; on the blowup fixture a 1M cache (80s) beat the 4M default (169s). Tune per workload.

## Known limitations / future work

- **AST retention — not the spillable sets — is the real per-shard dominator** (measured on
  vscode s50, `pocs/spill-memory-profile/RESULTS.md`: ~5 GB live at OOM — NodePath 534 MB /
  Position+SourceLocation 728 MB / Node 330 MB / node-`parent` chain pinning ~30 GB of strings —
  vs all solver `Set`s combined ~42 MB). The earlier "next candidate = `subsetEdges`" belief is
  **disproven** for AST-heavy repos (spilling subset edges reclaims <200 MB). **Root cause
  (confirmed by a second snapshot after a naive fix failed): the `@babel/traverse` NodePath /
  Scope / Binding / TraversalContext graph is pinned by SOLVER LISTENER CLOSURES that capture a
  `NodePath` (e.g. `operations.ts` `callComponent`/`callFunction` register
  `addForAllTokensConstraint(..., (t) => { ... path ... })` callbacks that close over `path`).**
  A post-`visit()` sweep that nulls `node.parent`/comments and clears Babel's path cache does
  NOT help — the live closures hold the paths directly (verified: a second s50 snapshot still had
  2.6M NodePaths, `NodePath via parentPath` 595 MB, `TraversalContext via context` 177 MB). The
  fix is to stop deferred listeners from capturing a `NodePath` — hoist `const node = path.node`
  out of the callback and reference only `node`. **Landed (all lossless, 2865/3520 preserved):**
  `callComponent` (`operations.ts`), `IMPORT_BASE` and `OBJECT_SPREAD` (`astvisitor.ts`).
  **Still open — the dominant one: the `CALL_*` listeners** (`operations.ts` `callFunction` →
  `handleCall` → `callFunctionBound`, one per call expression). They cannot use a plain
  `path.node` hoist because `callFunctionBound` needs a live `NodePath` at listener-firing time
  (`getAdjustedCallNodePath`, `path.isNewExpression()`, `expVar(arg, path)`, native
  `t.invoke({path})`). Removing that capture is a deeper refactor of the native-model API
  (`NativeFunctionParams.path`) + `expVar`'s path dependency. Also audit
  `FragmentState.maybeEmptyMethodCalls` (Map keyed by `Node`, held until `patchMethodCalls`).
- Canonicalization maps and listener closures still grow linearly in the heap; combine with the
  consumer's sharded analysis (see the Reachability workspace, ADR 0002) for very large repos.
- `cg.json` carries no function names (stock schema: `functions` maps index →
  `"fileIdx:sl:sc:el:ec"`), although `FunctionInfo.name` exists in memory. A backwards-
  compatible extension would emit an optional top-level `"names": {funIndex: name}` map from
  `saveCallGraph` in `src/output/analysisstatereporter.ts` (skip anonymous), leaving existing
  consumers untouched. Not yet implemented.
- No PR has been opened against upstream; the spill commit is self-contained to ease rebasing.

## Build & test

```bash
npm install && npm run build      # tsc -> lib/
node lib/main.js --spill /tmp/scratch -b <dir> -j out.json <dir>
npm test                          # upstream jest suite (unchanged)
```
