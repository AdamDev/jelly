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

- Only the superlinear sets are spilled. ASTs, canonicalization maps, subset edges
  (`subsetEdges`/`reverseSubsetEdges` — next candidate), and listener closures still grow
  linearly in the heap, so very large repos can still OOM from those; combine with the
  consumer's sharded analysis (see the Reachability workspace, ADR 0002).
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
