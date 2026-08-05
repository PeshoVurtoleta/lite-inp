# ADR 0001 -- Why 10 longest-N slots suffice for the INP candidate set

- Status: accepted
- Date: 2026-08-05
- Context: IN-01 fix (v1.0.1). See `Inp.js` `LN_CAP`, `maintainLongest`,
  `computeINP`; and `test/gc.longest.mjs`, `test/browser/oracle.test.mjs`.

## Context

INP is a **page-lifetime** percentile: the p98 of every interaction's max
duration seen since page load. lite-inp keeps a recency ring (`interactionCap`,
default 512) for `getInteractions()` detail, but the ring is the wrong
*candidate set* for the percentile -- once it wraps, the worst interactions the
percentile must land on have been evicted. That was IN-01: v1.0.0 computed the
percentile over the recency ring, so on a long session the reported INP drifted
far below the true value (the ring held only recent, short interactions).

The fix is an independent, page-lifetime **longest-N** list that keeps its own
copies of the N longest interactions ever seen, maintained on the hot path with
zero allocation (preallocated SoA, hand-rolled O(N) shifts). `computeINP` indexes

```
skip      = floor(lifetimeCount / 50)          // lifetimeCount = performance.interactionCount, else iCount
targetIdx = min(skip, lnCount - 1)
```

which is exactly the canonical estimator web-vitals ships. The only open
question is: how large must N be?

## Decision

**N = 10** (`LN_CAP = 10` in `Inp.js`).

## Rationale

The estimator skips `floor(lifetimeCount / 50)` of the longest interactions and
reports the next one. The index it needs is therefore `skip`. For the list to
always contain that index, we need `LN_CAP > skip`, i.e. `LN_CAP >= skip + 1`.

- `skip = floor(lifetimeCount / 50)` reaches **9** at `lifetimeCount = 450`
  (`floor(450/50) = 9`) and stays 9 through 499.
- So for **every session below 500 interactions**, `skip <= 9`, and a 10-slot
  list (indices 0..9) always holds the exact element the estimator asks for.
  `computeINP` clamps `targetIdx = min(skip, lnCount - 1)`, so the index is
  always in range.
- At `lifetimeCount = 500`, `skip = 10` would want an 11th slot. But this is
  precisely the point where the estimator's **own sampling error dominates**:
  reporting the 10th- vs 11th-longest of 500+ interactions is within the noise
  of a p98 estimate built from a discrete, browser-8ms-quantized sample. Adding
  slots past 10 chases precision the metric does not have.

This is the same reasoning web-vitals uses: it ships a **10-entry** longest list
and clamps the index to it. Matching N = 10 is what makes lite-inp agree with
web-vitals within the 8 ms quantization budget across the corpus **including the
600-interaction ring-wrap scenario** (`wrap600`), where `lifetimeCount = 600`,
`skip = 12` clamps to index 9, and both libraries read the 10th-longest
lifetime interaction. The v1.0.0 recency-only control, fed the same data,
disagrees by well over 8 ms -- see `test/browser/oracle.test.mjs` and
`test/browser/control.v100.mjs`.

## Consequences

- Fixed, tiny memory: 9 `Float64Array(10)` + 1 `Int32Array(10)`, allocated once.
- Zero allocation maintaining it on the hot path (`maintainLongest`).
- Agreement with the web-vitals oracle is bounded by quantization, not by list
  size, for realistic sessions.
- Sessions far beyond 500 interactions accept the estimator's intrinsic
  sampling error rather than growing the list -- a deliberate, documented trade,
  identical to the reference implementation.
