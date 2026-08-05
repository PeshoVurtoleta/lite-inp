# Changelog

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
