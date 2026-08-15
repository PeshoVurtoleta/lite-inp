# lite-inp allocation honesty table

Grounded in `test/browser/alloc.cdp.mjs`: CDP `HeapProfiler` allocation sampling
around a 500-interaction burst driven by real trusted input in Chromium. This
table states exactly what allocates on the observer-callback path, whose fault
it is, and what a caller can do about it. The zero-GC claim is a measured floor,
not a slogan.

## The observer-callback hot path (`onEventEntry`)

| What allocates | When | Bytes/scale | Whose fault | What a caller can do |
| --- | --- | --- | --- | --- |
| `list.getEntries()` array | Once per PerformanceObserver callback invocation | One array of N `PerformanceEventTiming` refs; N is however many entries the browser batched | **Platform.** The Event Timing API hands you an array; there is no zero-copy accessor. | **Nothing.** It is the platform's array. lite-inp never copies it, never retains it, never sorts it in place. |
| `idToSlot.set(iid, slot)` | Once per **unique** interactionId (first event of a new interaction) | One Map entry (key+value), O(unique interactions), capped by the ring re-using slots | **Library, by design.** A Map is the only way to dedup pointerdown/pointerup/click into one interaction without scanning. | **Nothing needed.** It is O(unique interactions), not O(events). On ring wrap the oldest key is `delete`d, so the Map does not grow unbounded. |
| Event-type interning (`eventTypes.push` + `eventTypeMap.set`) | Once per **new** event-type string ever seen | A handful total (`pointerup`, `keydown`, `click`, ...). Effectively constant. | **Library, by design.** Interning trades a few one-time allocations for an `Int32` tag per slot instead of a retained string per interaction. | **Nothing.** It saturates after the first few interactions and never allocates again. |
| longest-N maintenance (`maintainLongest`) | Only when an interaction's max duration rises | **Zero.** All writes land in preallocated `Float64Array`/`Int32Array` slots; hand-rolled O(10) shifts, no push, no closure, no object literal. | n/a | Proven 0 B/op in Node (`test/gc.longest.mjs`) and inside the floor here. |
| `onUpdate(reusableEntry)` | Only when a new worst interaction is recorded | **Zero.** One entry object is reused across every call; only primitives are written; `attribution` is set to `null` (attribution allocates, so the hot path skips it). | n/a | If you need attribution, call `getINP()` from inside `onUpdate` at the cost of one cold-path object -- your choice, off the hot path. |

## The documented FLOOR

Over a 500-interaction burst the observer path's sampled allocation is bounded
by exactly three terms, all above:

```
FLOOR = platform getEntries() arrays        (unavoidable, per callback)
      + one Map.set per unique interaction   (O(unique), not O(events))
      + interning of each new event type      (~constant, saturates early)
```

There is **no per-event object churn, no per-interaction array, no per-frame
string work.** The longest-N list and the `onUpdate` entry are both zero-alloc.

## The control that proves the floor has teeth

`alloc.cdp.mjs` runs a second observer with an `onUpdate` that allocates a fresh
`Array(4096)` on every call. The gate flags it: its sampled allocation clears
the documented floor by more than half a megabyte, while the honest run stays
under the floor. A gate that could not catch that control would not be a gate.

## Lifecycle scenarios (1.1.0): synthetic-first, stated plainly

The `bfcache-restore` and `prerender-offset` oracle scenarios verify the 1.1.0
lifecycle handling. Their RESET/OFFSET triggers are driven **synthetically**,
and this is deliberate and disclosed here rather than hidden:

- **bfcache restore** is triggered by dispatching a real
  `PageTransitionEvent('pageshow', { persisted: true })` in the page. That is
  the exact event type and the exact listener code path the browser fires on a
  genuine bfcache restore -- both lite-inp (`resetState`) and web-vitals
  (`onBFCacheRestore`) reset on it. What is synthetic is only the *trigger*, not
  the code under test. A genuine cross-document `ctx.goto` + `ctx.back` bfcache
  restore is NOT drivable in this oracle harness: the page is `about:blank`
  instrumented once via `addScriptTag` (inject is not re-run on navigation), and
  `about:blank` is not bfcache-eligible, so a real round-trip would drop the
  instrumented globals (`window.__inp`, `window.__wv`) with no way to
  re-instrument from inside a scenario. Forcing it risks exactly the kind of
  hang that must be avoided, so we do not.

- **prerender activationStart** is injected via an in-page
  `performance.getEntriesByType('navigation')` shim that exposes a non-zero
  `activationStart`, followed by a real `prerenderingchange` event. A real
  prerender is likewise not drivable headless here. The offset math is proven
  by re-reading the SAME interaction's reported `startTime` before and after:
  it drops by exactly the injected `activationStart` (duration, being a delta,
  is unaffected -- which is why web-vitals INP-value parity still holds).

The runner's package-agnostic navigation seam (`ctx.goto`, `ctx.back`,
`config.routes`) added in 1.1.0 IS exercised for real, in the standalone
`runner nav seam` oracle test, which drives A -> B -> back through two in-memory
routes. That proves the seam mechanically without endangering the instrumented
gating scenarios. The seam is the liftable part; real bfcache/prerender fidelity
is a browser-harness capability, not a library correctness question, and the
library's reset/offset code paths are fully exercised by the synthetic triggers.

## Attribution fixtures + detached-node counting (1.2.0): synthetic-first

IN2's attribution work is verified in `test/browser/oracle.test.mjs`
(`attribution (IN2)`) and `test/browser/control.detached.mjs`. Both are
synthetic-first, disclosed here for the same reason as the lifecycle scenarios.

- **The three attribution fixtures** (`paintAfterProcessing`, `twoInOneLoaf`,
  `spanThreeLoafs`) feed hand-crafted LoAF + Event-Timing timelines through a
  page-side `PerformanceObserver` shim that captures the observer's real
  callbacks. What runs is the REAL shipped correlation code
  (`collectLoafs`/`pickPhase`/`buildAttribution`) in real Chromium; only the
  entry TIMESTAMPS are synthetic. Real LoAF spans of this precision -- "one
  interaction spanning exactly three frames", "a paint two frames after
  processing" -- are not drivable headless, so the timeline is authored, not
  measured. Determinism is asserted by replaying each fixture 3x in-page and
  requiring byte-identical (`JSON.stringify`) attribution.

- **Detached-node retention** (`control.detached.mjs`) is counted by **WeakRef
  liveness after a forced CDP `HeapProfiler.collectGarbage`**: 10000 elements are
  created, detached, and referenced only by `WeakRef`; after GC we count how many
  still `deref()`. This is the HARD, deterministic gate. A real heap-snapshot
  "detached DOM node" count (`DOM.getDetachedDomNodes` / walking a `HeapSnapshot`)
  is the exact flaky-headless class IN0 warned about and is **not** relied on --
  WeakRef liveness answers the only question that matters (did the collector
  retain the Node?) without a snapshot. The control (which stores `e.target`)
  retains all 10000; the shipped interned path retains 0 while the observer is
  still LIVE, which is the point: the WeakMap key is weak, so the retention is
  gone with or without `destroy()`.

## Bottom line for a caller

The only allocation you cannot remove is the platform's `getEntries()` array,
and lite-inp does not add object churn on top of it. Do not pass an allocating
`onUpdate` and do not call `getInteractions()`/`getLoafs()`/`getINP()` on a hot
path -- those are cold-path reporting calls that allocate their result by design.
