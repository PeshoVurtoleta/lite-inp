# Changelog

## [1.1.0] - 2026-08-15

### Added

- **`obs.inp`** -- the actual p98 INP duration as an O(1), zero-allocation
  getter (the value at the skip index in the page-lifetime longest-N list).
  Returns `null` when no interaction has been recorded (fail closed). Equals
  `getINP()?.duration` -- both recompute the same page-lifetime skip live on
  every read (never a cached index, which would go stale when the platform
  interaction count advances on sub-threshold interactions).
- **`obs.worstDuration`** -- the worst (max) interaction duration seen this
  page view, for callers who want the peak rather than the percentile.
- **`obs.getINPInto(target)`** -- fills a caller-owned entry with the current
  INP and returns a boolean, at zero allocation. `attribution` is set to null;
  `getINP()` stays the ergonomic allocating form.
- **onUpdate flags** -- the reused entry now carries `newWorst` and
  `inpChanged` booleans. `onUpdate` fires when a new worst is recorded OR when
  the p98 INP candidate changes (previously: worst only). Both flags derive
  allocation-free from the longest-N insertion.
- **bfcache restore** handling: a `pageshow` with `event.persisted` resets INP
  state for the new page view. The listener is removed in `destroy()`.
- **prerender activationStart** offset: reported interaction `startTime`s are
  corrected by `activationStart`, read at construction and refreshed on
  `prerenderingchange`. Fail closed to 0 when unavailable.

### Changed

- `computeINP` skip is now `floor((lifetimeCount - icBaseline) / 50)`. The
  `icBaseline` rebaselines the page-lifetime `performance.interactionCount` on
  reset, so the percentile skip is correct across a bfcache restore.
- `obs.currentINP` is **deprecated** (misnamed -- it is the running max, not the
  p98 INP). Use `obs.inp` for the INP or `obs.worstDuration` for the max. Kept
  as an alias of `worstDuration` for this minor.
- `destroy()` now also removes the `pageshow`/`prerenderingchange` listeners and
  routes its state reset through a shared `resetState()`.

### Internal

- Extracted `resetState()` (serves `destroy()`, bfcache restore, and future
  soft-nav) and `fillLongestPrimitives()` (shared zero-alloc fill for
  `getINPInto()` and the cold-path attribution fill).
- New `test/gc.getters.mjs` -- 0 B/op gate over `inp`/`worstDuration`/
  `getINPInto` (50000 iters, `maxBytesPerCall: 0`), wired into `verify`.
- Browser lane: generic `ctx.goto`/`ctx.back` navigation helpers and a
  `config.routes` hook in the runner seam; `bfcache-restore` and
  `prerender-offset` oracle scenarios with web-vitals parity assertions.

## [1.0.2] - 2026-08-05

### Fixed

- Synced the exported `VERSION` constant to the package version. The 1.0.1
  release was bumped manually, bypassing the version-sync step, so it shipped
  with `VERSION === '1.0.0'` at runtime. No other code changed; the published
  tarball is otherwise identical to 1.0.1.

## [1.0.1] - 2026-08-05

### Fixed

- **INP no longer under-reports on long sessions.** `getINP()` previously
  computed the p98 over only the most recent `interactionCap` interactions
  (the recency ring). Once the ring wrapped, the worst interactions from
  earlier in the session were evicted, yet the skip count still used the
  page-lifetime `performance.interactionCount` -- so `getINP()` silently
  under-reported the longer a session ran (SPAs, dashboards). INP is now
  computed over an independent page-lifetime longest-N list (the 10 longest
  interactions seen since page load), maintained allocation-free on the hot
  path, matching the CrUX / `web-vitals` estimator. The recency ring is
  retained for `getInteractions()` detail.
- `destroy()` now resets all internal state. Post-destroy, `getINP()` returns
  `null` and `getInteractions()` / `getLoafs()` return empty, and
  `interactionCount` / `currentINP` are `0` (previously left stale data).

### Internal

- Removed the dead write-only `currentInpSlot` field.
- Unified the sort-comparator convention on a single hoisted `byDurationDesc`.
- Fixed the npm-downloads badge link (pointed at the wrong package).
- Added a boundary/adversarial test suite, a Node-side zero-allocation gate
  for longest-N maintenance (mock `PerformanceObserver` under `--expose-gc`),
  and an IN-01 wrap regression proof (recency-only vs longest-N). 8 -> 28 tests.

## [1.0.0] - 2026-07-07

Initial release. Zero-GC INP attribution via Event Timing + LoAF.

### Added

- `createInpObserver(options?)` -- start observing interactions and LoAF
  entries with preallocated struct-of-arrays storage.
- Observer callbacks write to `Float64Array` / `Int32Array` ring buffers.
  No object creation, no Array.push, no string concatenation per event.
- Event type interning to integer IDs (one-time alloc per unique type).
- Interaction collapsing: multiple events per `interactionId` are
  collapsed to the max duration.
- Phase breakdown: `inputDelay`, `processingTime`, `presentationDelay`
  computed from Event Timing entry timestamps.
- LoAF script attribution: top-3 scripts per LoAF entry by duration,
  with `invoker`, `sourceURL`, `sourceFunctionName`.
- INP computation: p98 of all interactions using
  `performance.interactionCount` for the skip count.
- `onUpdate` callback for real-time worst-interaction tracking with a
  reusable entry object -- zero allocation on the hot path.
  Attribution is deliberately null in the reusable entry (populating
  it would allocate); call `getINP()` from within `onUpdate`, or on
  any cadence you prefer, to compute attribution on the cold path.
- Cold-path methods: `getINP()`, `getInteractions()`, `getLoafs()`.
- Feature detection: `supported` and `loafSupported` properties.
- Full `Inp.d.ts`. 8 tests under `node --test`.
- Interactive demo with simulated slow handlers and live phase bars.
