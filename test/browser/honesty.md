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

## Bottom line for a caller

The only allocation you cannot remove is the platform's `getEntries()` array,
and lite-inp does not add object churn on top of it. Do not pass an allocating
`onUpdate` and do not call `getInteractions()`/`getLoafs()`/`getINP()` on a hot
path -- those are cold-path reporting calls that allocate their result by design.
