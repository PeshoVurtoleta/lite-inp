# @zakkster/lite-inp

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-inp.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-inp)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-inp?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-inp)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-inp?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-cleanup)
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

3. **INP computation** correlates the p98 worst interaction with the LoAF entry whose time window overlaps it, giving you the script-level attribution for why the interaction was slow.

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
| `destroy()` | Disconnect observers, clear state |
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
    attribution: {             // null on hot path (onUpdate reusable entry)
        loafDuration: number;  //   and when no overlapping LoAF exists;
        loafBlockingDuration: number;  // populated on cold path
        scripts: [{                    // (getINP, getInteractions).
            invoker: string;
            sourceURL: string;
            sourceFunctionName: string;
            duration: number;
        }]
    } | null;
}
```

## Browser support

| Feature | Chrome | Firefox | Safari |
|---------|--------|---------|--------|
| Event Timing (`interactionId`) | 96+ | 144+ | -- |
| LoAF (script attribution) | 123+ | -- | -- |

The library feature-detects both APIs. If Event Timing is unavailable, `supported` returns false and no observers are started. If LoAF is unavailable, INP is still computed but `attribution` is null.

## INP calculation

INP is the p98 of all interactions' max durations. For pages with fewer than 50 interactions, it's the worst. The library uses `performance.interactionCount` (when available) for the p98 skip count, matching the spec definition.

## License

MIT (c) Zahary Shinikchiev
