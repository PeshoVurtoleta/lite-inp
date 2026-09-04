# @zakkster/lite-inp

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-inp.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-inp)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-inp?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-inp)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-inp?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-inp)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-inp?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-inp)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Zero-GC INP attribution. The observer callback writes to typed arrays, not objects.

Interaction to Next Paint is a Core Web Vital. Attribution is genuinely hard. The irony of most monitoring libs is they allocate inside the observer -- GC pauses from the monitoring tool become part of the metric. This library uses preallocated struct-of-arrays for both interactions and LoAF entries so the observer callbacks create nothing on the heap.

```bash
npm install @zakkster/lite-inp
```

## Quick start

```js
import { createInpObserver } from '@zakkster/lite-inp';

const inp = createInpObserver({
    // Hot path -- fires on every new-worst interaction. Zero allocation.
    // `entry.attribution` is null here so the observer callback does not
    // allocate. Copy the primitive fields you need before onUpdate returns.
    onUpdate(entry) {
        myMetric.update(entry.duration, entry.eventType);
    }
});

// Cold path -- call when you're ready to report the metric. This allocates
// the full entry object with LoAF attribution (top-3 scripts, invoker,
// sourceURL, sourceFunctionName).
addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        const current = inp.getINP();
        if (current) sendBeacon('/inp', JSON.stringify(current));
    }
});
```

## What it does

1. **Event Timing observer** (`type: 'event'`, `buffered: true`) captures every interaction with `interactionId > 0`. Multiple events per interaction (pointerdown + pointerup + click) are collapsed to the max duration. Phase breakdown (input delay, processing time, presentation delay) is computed from `startTime`, `processingStart`, `processingEnd`, and `duration`.

2. **Long Animation Frames observer** (`type: 'long-animation-frame'`) captures LoAF entries with script attribution (invoker, sourceURL, sourceFunctionName, duration). Top-3 scripts per LoAF are retained.

3. **INP computation** correlates the p98 worst interaction with every LoAF overlapping its unquantized processing window (`processingStart..processingEnd`), up to 4, plus the element target and the dominant phase -- giving you script- and element-level attribution for why the interaction was slow.

## Zero-GC hot path

The observer callbacks write numeric fields directly into preallocated `Float64Array` / `Int32Array` ring buffers. Event type strings are interned to integer IDs (one-time allocation per unique type). No intermediate objects, no `Array.push`, no string concatenation per event.

The only allocation per unique interaction is a single `Map.set(interactionId, slotIndex)` call. Interactions are user-initiated (clicks, keystrokes) -- maybe 1-5 per minute. This is not frame-rate allocation.

The `onUpdate` callback receives the reusable entry with primitives populated and `attribution` set to `null`. LoAF attribution is a cold-path concern -- computing it means walking the LoAF ring and allocating a scripts array -- so the hot path skips it entirely. If you need attribution for the current INP, call `getINP()` from inside `onUpdate` (or on any cadence you prefer); that's the explicit cold-path allocation.

This split is deliberate: measuring INP shouldn't itself cause GC pauses that perturb what you're measuring.

Cold-path methods (`getINP()`, `getInteractions()`, `getLoafs()`) allocate result objects freely. They're called on demand, not per event.

## API

### `createInpObserver(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `interactionCap` | number | 512 | Max unique interactions tracked (ring, power-of-two) |
| `loafCap` | number | 64 | Max LoAF entries retained |
| `durationThreshold` | number | 16 | Min event duration (ms) reported by Event Timing |
| `onUpdate` | function | null | Called when a new worst interaction is recorded (hot path; `entry.attribution` is null -- call `getINP()` for attribution) |

### `InpObserver`

| Method / Property | Description |
|---|---|
| `getINP()` | Current INP entry with phase breakdown + LoAF attribution |
| `getInteractions()` | All tracked interactions, sorted by duration descending |
| `getLoafs()` | Recent LoAF entries with script attribution |
| `destroy()` | Disconnect observers and reset all state; getters return null/empty afterward |
| `interactionCount` | Number of unique interactions tracked |
| `currentINP` | Current worst duration (ms) |
| `supported` | True if Event Timing API is available |
| `loafSupported` | True if LoAF API is available |

### `InpEntry`

```ts
{
    duration: number;          // total interaction duration (8ms quantized)
    inputDelay: number;        // user input -> handler start
    processingTime: number;    // handler execution
    presentationDelay: number; // handler end -> next paint
    startTime: number;
    eventType: string;         // 'pointerup', 'keydown', 'click', etc.
    interactionId: number;
    // Populated only by getINP() (cold path). null when there is no interaction,
    // on the onUpdate reusable entry, and after getINPInto().
    attribution: {
        loafs: [{                        // up to LOAF_MATCH_CAP (4) overlapping
            startTime: number;           // LoAFs, earliest-start first; empty []
            duration: number;            // when no LoAF overlaps.
            blockingDuration: number;
            styleAndLayoutStart: number;
            scripts: [{
                invoker: string;
                sourceURL: string;
                sourceFunctionName: string;
                duration: number;
            }];
        }];
        target: string | null;           // interned 'tag#id' / 'tag.class' (NOT a
                                         // CSS selector); null when unknown, or
                                         // past the 128-target cap (fail closed).
        phase: 'processing' | 'presentation';  // 'presentation' when the paint
                                         // dominates (presentationDelay >
                                         // processingTime), else 'processing'.
    } | null;
}
```

Attribution correlates against the **unquantized processing window**
(`processingStart..processingEnd`), collecting **all** overlapping LoAFs up to
`LOAF_MATCH_CAP = 4` (earliest-start first, the deterministic tie-break) -- not a
single best overlap. Presentation-dominated interactions correlate against the
next frame's style/layout segment (`styleAndLayoutStart`) instead of the
processing scripts. `target` is interned through a WeakMap keyed by node identity,
so the Node is **never stored** and detached subtrees stay collectable (no RUM
leak); the intern map is bounded at 128 distinct targets and fails closed to
`null` beyond it (null is not a wrong element). See the ADRs
(`decisions/0002-correlation.md`, `decisions/0003-target.md` in the repository).

## Browser support

| Feature | Chrome | Firefox | Safari |
|---------|--------|---------|--------|
| Event Timing (`interactionId`) | 96+ | 144+ | -- |
| LoAF (script attribution) | 123+ | -- | -- |

The library feature-detects both APIs. If Event Timing is unavailable, `supported` returns false and no observers are started. If LoAF is unavailable, INP is still computed and `getINP().attribution` is still an object -- its `loafs[]` is simply empty, while `target` and `phase` are still set. `attribution` is `null` only when there is no interaction, on the `onUpdate` hot-path entry, and after `getINPInto()`.

## INP calculation

INP is the p98 of the page's interactions: the worst interaction after skipping the `floor(interactionCount / 50)` slowest, or simply the worst for pages with fewer than 50 interactions. `performance.interactionCount` (when available) supplies the skip count, matching the spec definition.

Because INP is a *page-lifetime* percentile, the library maintains an independent longest-N list -- the 10 longest interactions seen since page load -- separate from the `interactionCap` recency ring. The percentile is computed from that list, so INP stays correct on long-lived pages (SPAs, dashboards) even after thousands of interactions have cycled through and been evicted from the ring. The recency ring is retained for `getInteractions()` detail. The longest-N list is maintained allocation-free on the hot path, and matches the estimator used by CrUX and `web-vitals`.

## Differential oracle: parity with web-vitals

Same number, silent observer. lite-inp and `web-vitals` consume the *same*
browser Event-Timing feed at the same `durationThreshold`, so any disagreement
beyond the 8 ms Event-Timing quantization is a real algorithm difference. The
browser lane (`npm run test:browser`, and the demo's scene 03) runs both side by
side and asserts `|lite-inp - web-vitals| <= 8 ms` on every scenario -- including
the ring-wrap catcher, where a recency-only estimator (the pre-1.1 bug) provably
disagrees by more than 8 ms.

One gated run of the four playground injectors (the gate asserts the 8 ms bound
on *every* run; absolute values are workload-dependent):

| injector | dominant phase | lite-inp | web-vitals | \|delta\| |
|----------|----------------|---------:|-----------:|---------:|
| sync block (320 ms) | processing | 328 ms | 328 ms | 0 ms |
| rAF chain | presentation | 96 ms | 96 ms | 0 ms |
| layout thrash | processing | 144 ms | 144 ms | 0 ms |
| clean handler | -- | none | sub-threshold | agree (both none) |

Scene 01's attribution names the element that ran the interaction -- for the sync
injector, `attribution.target === 'button#inject-sync'`: the demo's own button.

## Allocation honesty

The observer callback allocates nothing per interaction. The honest floor is the
platform's own `getEntries()` array -- the browser allocates it, and a sampling
profiler charges it to whichever JS frame called it. That is the irreducible
cost of reading the feed, not an object we create.

| path | per-interaction allocation | whose |
|------|----------------------------|-------|
| observer callback (`onEventEntry`, `maintainLongest`, interning, longest-N) | **0 B** | ours -- preallocated SoA, no object / `push` / concat |
| `performance ... getEntries()` array | ~a few dozen bytes / callback | the **platform's** -- the floor |
| `Map.set(interactionId, slot)` | one entry per **unique** interaction | ours -- user-initiated (clicks/keys), not per frame |
| `getINP()` + `.attribution` | allocates, by design | ours -- **cold path**, on demand |
| scene-04 allocating-`onUpdate` (the control) | ~0.5 MiB / fire (16384 small objects) | deliberately wrong -- the demo's visible climb |

Gated: the demo frame-loop's honest observer path sampled **~0 KiB** over a
600-tap burst (gate floor 12 KiB), while flipping the scene-04 toggle made the
same burst climb **~300 KiB** on the control's own `onUpdate` frame (measured
280-340 KiB across eight back-to-back runs, against a derived floor of ~123 KiB)
-- the control has teeth and the margin is deterministic. The climb is read on
the control's allocation frame, not the whole-page total (which is high-variance
sampling noise). The end-to-end overhead lane (`npm run test:overhead`)
fingerprints a no-observer baseline page against an observed one over an
identical burst and bounds the per-interaction delta.

## License

MIT (c) Zahary Shinikchiev
