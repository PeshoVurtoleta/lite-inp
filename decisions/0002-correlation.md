# ADR 0002 -- LoAF correlation rule for INP attribution

- Status: accepted
- Date: 2026-08-15
- Context: IN2 (v1.2.0), finding IN-04. See `Inp.js` `collectLoafs`,
  `pickPhase`, `buildAttribution`, `LOAF_MATCH_CAP`; and
  `test/browser/scenarios.mjs` fixtures + `test/browser/oracle.test.mjs`.

## Context

Through v1.1.0, attribution picked the single LoAF with maximum overlap over
`[startTime, startTime + duration)` (`findLoafForInteraction`). That rule was
under-specified in three ways (IN-04):

1. `duration` is quantized to 8ms by the browser, so the overlap window was
   fuzzy at exactly the resolution that matters.
2. An interaction whose processing spans a frame boundary overlaps several
   LoAFs; reporting only the best-overlap one silently drops the rest.
3. The paint frequently lands in a LATER frame than the processing, so a
   presentation-dominated interaction was correlated against the wrong frame's
   scripts.

Attribution is the package's reason to exist. An under-specified rule is "vibes
with a `sourceURL` attached." IN2 makes the rule explicit, deterministic, and
tested.

## Decision

**Correlate against the unquantized processing window, collect all overlapping
LoAFs up to a fixed cap, and pick the correlation segment by phase.**

Concretely (`buildAttribution` in `Inp.js`):

- **Window.** Overlap is taken against `processingStart..processingEnd` (both
  raw Event-Timing timestamps, unquantized), NOT the 8ms-quantized full
  `duration`. This is the segment where the handlers actually ran.
- **Collect all, capped.** `collectLoafs` walks the LoAF ring oldest-first and
  collects EVERY LoAF whose relevant segment overlaps the window, up to
  `LOAF_MATCH_CAP = 4`, into a preallocated `matchSlots` scratch. It is not a
  single best-overlap pick.
- **Deterministic tie-break: earliest LoAF start.** The ring is append-ordered
  in time, so walking it oldest-first yields matches in ascending `lStart`; the
  first `LOAF_MATCH_CAP` overlaps are therefore the earliest-starting ones. No
  sort, no scan-order dependence -- identical input yields byte-identical output
  (asserted across 3 replays in the oracle).
- **Phase (`pickPhase`).** When `presentationDelay > processingTime` the
  interaction is **presentation-dominated**: its cost is the paint, so overlap is
  taken against the **style/layout segment** (`styleAndLayoutStart..lEnd`) of the
  frame(s) covering the presentation window `[processingEnd, interactionEnd]`.
  Otherwise it is **processing-dominated** and overlap is taken against the full
  frame covering `[processingStart, processingEnd]` (the scripts).

`styleAndLayoutStart` was already captured in the LoAF ring since v1.0.0 and was
unused; IN2 puts it to work.

## Intentional divergences from web-vitals (stated out loud)

Matching the INP **value** is parity and is non-negotiable (the oracle asserts
`|lite-inp - web-vitals| <= 8ms` on every scenario, and IN2 does not touch the
value). Attribution is allowed to be *better* than the incumbent -- but only if
the divergence is deliberate and documented. The divergences:

- **We report up to 4 LoAFs, not one.** web-vitals attributes the single LoAF
  intersecting the interaction. A long interaction that spans frame boundaries
  genuinely has cost in several frames; collecting them (bounded at 4) is more
  informative and still O(cap). The 3-LoAF fixture proves exactly 3 slots fill.
- **We split correlation by phase.** web-vitals does not re-target the paint
  frame for presentation-dominated interactions. We do, because "which frame's
  style/layout blocked the paint" is a different and often more actionable answer
  than "which handler ran."
- **`LOAF_MATCH_CAP = 4`.** Four frames at ~16ms is ~64ms of frame coverage --
  comfortably beyond a single INP interaction's span in practice. Beyond four we
  stop collecting: the fifth frame's contribution is below the noise of an
  8ms-quantized metric, the same reasoning that bounds the longest-N list at 10
  (ADR 0001).

## Consequences

- Deterministic, testable attribution: every edge the rule claims to handle has
  a hand-derived fixture (`paintAfterProcessing`, `twoInOneLoaf`,
  `spanThreeLoafs` in `scenarios.mjs`).
- Zero hot-path cost: correlation runs entirely on the cold path (`getINP()`).
  `matchSlots` is preallocated and reused; only the returned `loafs[]` array
  allocates, by design.
- The INP value is untouched, so web-vitals parity within 8ms still holds.
