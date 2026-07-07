# Changelog

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
