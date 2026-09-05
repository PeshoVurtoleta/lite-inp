# Changelog

## [1.3.1] - 2026-09-05

The Firefox lane (DEFERRED trigger met: Playwright 1.62.1 bundles Firefox 153.0,
which exposes Event Timing with `interactionId`). No hot-path byte changes:
`Inp.js` gains only the `VERSION` bump to `1.3.1`; the observer callbacks are
untouched. Everything below is cold-path -- repo-only harness and docs (none of
it ships; `files[]` stays the same six entries).

### Added

- **Firefox lane** (`test/browser/firefox.test.mjs`, repo-only; `npm run
  test:browser-ff`). Runs the full differential corpus in real Firefox 153 and
  gates three things CDP is not needed for: parity (`|lite-inp - web-vitals| <=
  8 ms` on every scenario including the ring-wrap catcher, with the v1.0.0
  recency-only control still diverging on wrap600 -- `web-vitals` runs under
  Playwright Firefox, so the oracle is real there); graceful degradation
  (`loafSupported === false`, `attribution !== null`, `attribution.loafs.length
  === 0`, and `attribution.target` a non-null `"tag#id"` string -- element and
  phase attribution work, script/LoAF attribution is absent); and interaction
  grouping (N discrete taps -> `interactionCount === N`, mousedown/mouseup id 0
  never counted). `LITE_NO_BROWSER=1` skips it loudly; a missing Firefox binary
  is a loud failure, never a silent pass.
- **`npm run verify:all`** -- `verify` plus the Firefox lane. `verify` itself
  stays Chromium-only (no Firefox binary is guaranteed in every environment).

### Changed

- **Runner CDP-optional seam** (`test/browser/runner.mjs`, repo-only). The
  liftable scenario runner gains a `browserType` config (`'chromium'` default |
  `'firefox'`). Under Firefox there is no CDP: `ctx.cdp` is `null`, the CDP-only
  calls (`newCDPSession`, `Input.setIgnoreInputEvents`, `cdp.detach`) are
  skipped, and `ctx.tap` falls back to `page.mouse` (still trusted input, so
  `interactionId` still increments). The CDP HeapProfiler allocation gate stays
  Chromium-only by construction.
- **README "Browser support"** turned from a claimed Firefox row into a tested
  one: the measured FF-153 attribution story (INP measurable, element `target`
  and `phase` present, script/LoAF absent -- `attribution` non-null, never
  `null`), and the note that the allocation gate is Chromium-only (Firefox
  speaks Juggler, not CDP).

## [1.3.0] - 2026-09-05

The evaluation kit (IN-05). No hot-path byte changes: `Inp.js` gains only the
`VERSION` bump to `1.3.0`; `onEventEntry` / `maintainLongest` / `internTarget`
are untouched. Everything below is cold-path -- docs, the demo, and repo-only
harness (none of it ships; `files[]` stays the same six entries).

### Added

- **The INP playground demo** (`demo/inp.html`, repo-only). Four scenes: 01
  PLAYGROUND (sync / rAF / thrash / clean injectors, live `obs.inp`, phase bars,
  and the attribution card naming the guilty injector element); 02 TIMELINE
  (interaction phase segments drawn on a time axis, the presentation/paint
  overlap region per `decisions/0002-correlation.md`); 03 PARITY (web-vitals
  beside `getINP()`, both numbers live); 04 ZERO-GC (interaction burst with the
  allocating-`onUpdate` toggle as a control that visibly climbs). Cached `$`
  refs, a preallocated Float64 telemetry ring, a wall-clock ~10 Hz telemetry
  throttle, pointer input, oklch + hex fallback. Serve with `npx serve .`.
- **Demo frame-loop gate** (`test/browser/demo.frame.mjs`). Drives the real demo
  in Chromium through the existing runner seam and gates what the GC torture run
  cannot see: 0 forced reflows in the frame loop (lite-layout-profiler), the
  ~10 Hz telemetry throttle, |lite-inp - web-vitals| <= 8 ms on all four
  injectors, `attribution.target === 'button#inject-sync'`, a flat demo observer
  path over a 600-tap burst with the scene-04 toggle climbing as the control, and
  0 DOM growth / one observer over 100 scene switches.
- **Overhead gate** (`test/browser/overhead.cdp.mjs`). A no-observer baseline
  page vs an observed page over an identical trusted-input burst; the end-to-end
  per-interaction allocation is bounded and fingerprinted.
- **Callback micro-bench** (`bench/inp.bench.mjs`, `npm run bench`). Node
  mocked-feed observer-callback cost: ns/entry and bytes/op. Runnable, not a gate.
- **Suite recipes** (`recipes/`, repo-only) wired against the real published
  peers, APIs from each peer's `llms.txt`: `hud.mjs` (poll `getINPInto` at 1 Hz
  into a `@zakkster/lite-hud` channel), `beacon.mjs` (report INP once on hide),
  `layout.mjs` (cross-reference INP against `@zakkster/lite-layout-profiler`).
  Exercised in CI by `test/recipes.test.mjs`.
- **README** rewritten around the differential-oracle parity table (scenario x
  {lite-inp, web-vitals} x INP) and an allocation honesty table that names the
  platform `getEntries()` floor.

## [1.2.1] - 2026-08-31

### Changed

- Phase-1 retention gate in `test/torture.mjs` converted to the
  finalization-authority pattern. It previously tracked the observer inside a
  `createRoot`/effect owner, so dispose auto-untracked it -- a vacuous variant-2
  tautology. It now tracks the real observer OUTSIDE any owner, with no untrack,
  a hard settle, and a residual bound of `RES = 16`. The independent
  listener-balance and phase-2 allocation oracles are unchanged. Library source
  (`Inp.js`) is not touched by this release.

### Added

- `LITE_INP_TORTURE_LEAK=1` control in `test/torture.mjs` that pins observers to
  force the retention gate RED (residual ~4096), proving the gate is not vacuous.

## [1.2.0] - 2026-08-15

### Added

- **Element attribution** -- `getINP().attribution.target` now names the element,
  as `tag#id` / `tag.class` (NOT a CSS selector). Targets are interned through a
  WeakMap keyed by node identity, so the Node is **never stored** and detached
  subtrees stay collectable (no RUM leak). The intern map is bounded at **128
  distinct targets**; beyond the cap -- and for a null/removed target -- the
  attribution **fails closed to `null`**, never a wrong element (null is not
  zero). The hot path gains exactly one `Int32` write per raised-duration event
  (`iTargetTag[slot] = internTarget(e.target)`); a repeat target is a single
  WeakMap hit (0 B/op), a genuinely new target builds one string. See
  `decisions/0003-target.md`.
- **Multi-LoAF correlation** -- `attribution.loafs[]` now collects ALL long
  animation frames overlapping the interaction (up to 4), instead of a single
  best overlap. Overlap is taken against the **unquantized processing window**
  (`processingStart..processingEnd`), not the 8ms-quantized full duration.
  Deterministic tie-break: earliest LoAF start. See `decisions/0002-correlation.md`.
- **Phase-aware attribution** -- `attribution.phase` is `'presentation'` when
  `presentationDelay > processingTime` (the paint dominates: correlation targets
  the style/layout segment of the frame(s) covering the presentation window, via
  `styleAndLayoutStart`) or `'processing'` otherwise (the scripts dominate).

### Changed

- **`attribution` shape (breaking within attribution only).** It was
  `{ loafDuration, loafBlockingDuration, loafStyleAndLayoutStart, scripts }` for a
  single LoAF; it is now `{ loafs: AttributedLoaf[], target, phase }`. Each entry
  in `loafs[]` carries `startTime`/`duration`/`blockingDuration`/
  `styleAndLayoutStart`/`scripts`. The INP **value** is unchanged -- IN2 touches
  attribution only; web-vitals parity still holds within 8ms on every scenario.
- `resetState()` (bfcache restore) and `destroy()` now also clear the target
  intern map (fresh WeakMap, cleared string table, `targetCount = 0`) so a new
  page view never mis-resolves a re-clicked element's stale id.

### Internal

- `collectLoafs()` replaces `findLoafForInteraction()`; overlapping LoAFs are
  collected into a preallocated `matchSlots` scratch (`LOAF_MATCH_CAP = 4`) --
  only the cold-path `loafs[]` array copied out of it allocates.
- New `iTargetTag`/`lnTargetTag` `Int32` columns carry the interned target id
  through the recency ring and the page-lifetime longest-N list.
- New `test/gc.target.mjs` -- 0 B/op gate over the intern write (200000 entries,
  512 distinct targets > the 128 cap, so the fail-closed overflow path is
  exercised), with a store-the-target control the gate flags. Wired into `verify`.
- New `test/browser/control.detached.mjs` -- the detached-DOM leak control (a
  variant retaining `e.target`) the lane catches, while the shipped interned path
  retains 0 detached nodes. Wired into `verify`.
- Browser lane: `churnTargets` (10k interactions with DOM churn) and three
  hand-derived attribution fixtures (paint after processing; two interactions in
  one LoAF; one interaction spanning three LoAFs). The oracle asserts attribution
  is byte-identical across 3 replays and the 3-LoAF fixture fills exactly 3 slots.

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
