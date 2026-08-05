// test/browser/control.v100.mjs
//
// CONTROL -- NOT SHIPPED. Test-only reimplementation of the v1.0.0
// recency-only computeINP, kept so the oracle has teeth: on wrap600 this MUST
// disagree with web-vitals by >= 8 ms, proving the 1.0.1 longest-N fix (IN-01)
// was necessary and that the differential harness can actually detect the bug.
//
// v1.0.0's candidate set was the recency ring ONLY: the most-recent
// interactionCap interactions, sorted by duration DESC. computeINP indexed
// p98 = min(floor(lifetimeCount / 50), n - 1) into THAT set. When the ring
// wraps, the longest interactions have been evicted, so the index lands inside
// the surviving-but-short window -> the INP reads far too low.
//
// This function takes exactly what a v1.0.0 observer could see: the live
// recency window's durations (== obs.getInteractions() durations, already the
// capped ring) plus the true lifetime interaction count.

/**
 * @param {number[]} recencyDurations durations of the live recency ring
 *   (order irrelevant; sorted here). This is obs.getInteractions() mapped to
 *   .duration -- the capped window, NOT the page-lifetime longest set.
 * @param {number} lifetimeCount performance.interactionCount (page lifetime).
 * @returns {number|null} recency-only INP, or null when no interactions.
 */
export function controlV100INP(recencyDurations, lifetimeCount) {
    const n = recencyDurations.length;
    if (n === 0) return null;
    const sorted = recencyDurations.slice().sort(function (a, b) { return b - a; });
    const skip = Math.floor(lifetimeCount / 50);
    const targetIdx = skip < n ? skip : n - 1;
    return sorted[targetIdx];
}
