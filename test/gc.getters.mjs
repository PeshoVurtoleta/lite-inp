// test/gc.getters.mjs -- node --expose-gc test/gc.getters.mjs
//
// 0-B/op gate for the zero-alloc read surface added in 1.1.0:
//   obs.inp            -- O(1) p98 INP read
//   obs.worstDuration  -- running max
//   obs.getINPInto(t)  -- fill a caller-owned entry, attribution null
//
// Drives the REAL getters through a MOCK global PerformanceObserver (installed
// before createInpObserver runs), exactly like test/gc.longest.mjs -- ZERO
// additions to the public surface for the sake of the test. The longest-N list
// is populated first so inpIdx lands on a real interior slot, then the three
// reads are measured. The gate is the DETERMINISTIC per-call SLOPE (see below),
// NOT a lucky exact-0 batch.
//
// This gate MEASURES; it never prints SKIPPED. measureAllocs needs forced
// settling (--expose-gc, which the npm script supplies). If run without it the
// measurement is inconclusive and the gate FAILS closed rather than skipping.

import assert from 'node:assert/strict';
import { measureAllocs } from '@zakkster/lite-gc-profiler';

// --- mock global PerformanceObserver -------------------------------------
let capturedEventCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) { if (opts.type === 'event') capturedEventCb = this._cb; }
    disconnect() { this._cb = null; }
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;

const { createInpObserver } = await import('../Inp.js');

// --- populate the longest-N list -----------------------------------------
// 120 unique interactions with varied durations so the list fills to LN_CAP
// and inpIdx = floor(120/50) = 2 (a genuine interior slot, not the head).
const obs = createInpObserver();
for (let i = 0; i < 120; i++) {
    const dur = 24 + ((i * 37) % 400);
    capturedEventCb({ getEntries: () => [{
        interactionId: i + 1,
        duration: dur,
        startTime: i,
        processingStart: i + 2,
        processingEnd: i + 2 + dur * 0.5,
        name: 'pointerup'
    }] });
}

// Precondition: the getters agree, and inp is non-null (list populated).
assert.ok(obs.inp !== null, 'inp populated before measurement');
assert.equal(obs.inp, obs.getINP().duration, 'inp === getINP().duration');
assert.ok(obs.worstDuration >= obs.inp, 'worstDuration is the max, >= p98 inp');

// --- REGRESSION: count advances WITHOUT a delivered interaction ----------
// performance.interactionCount also advances on sub-threshold interactions the
// observer never delivers. The getters MUST recompute the p98 skip LIVE, not
// read a cached hot-path index -- a cached index would go stale-low and make
// obs.inp read a LONGER (lower-index) duration than getINP().duration.
// This block is RED against a cached-inpIdx getter and GREEN against the live
// recompute: it is the teeth that catch the shipped-and-rejected bug.
assert.equal(performance.interactionCount, undefined,
    'regression assumes no ambient performance.interactionCount');
const regObs = createInpObserver();  // icBaseline = 0 (no interactionCount)
// Deliver 10 distinct, strictly-descending interactions -> longest-N fills to
// 10, sorted DESC [490,480,...,400]. interactionCount is undefined during
// delivery, so a cached inpIdx settles at floor(10/50) = 0 (the head, 490).
for (let k = 1; k <= 10; k++) {
    const rdur = 500 - k * 10;
    capturedEventCb({ getEntries: () => [{
        interactionId: k, duration: rdur,
        startTime: k, processingStart: k + 2, processingEnd: k + 2 + rdur * 0.5,
        name: 'pointerup'
    }] });
}
// The page-lifetime count now jumps past a /50 boundary with NO delivered
// interaction (100 sub-threshold interactions): skip = floor(100/50) = 2.
performance.interactionCount = 100;
const regLiveInp = regObs.inp;
const regCanonical = regObs.getINP().duration;
const regTarget = {
    duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
    startTime: 0, eventType: '', interactionId: 0, attribution: null
};
const regFilled = regObs.getINPInto(regTarget);
delete performance.interactionCount;  // restore ambient state

assert.equal(regLiveInp, regCanonical,
    'obs.inp must equal getINP().duration when interactionCount advances ' +
    'without a delivered interaction (inp=' + regLiveInp + ' getINP=' + regCanonical +
    '; a cached index would read 490)');
assert.equal(regCanonical, 470,
    'sanity: skip=2 into DESC [490,480,470,...] is the 3rd-largest = 470, not the cached-index 490');
assert.equal(regFilled, true);
assert.equal(regTarget.duration, regCanonical, 'getINPInto uses the live skip too');
regObs.destroy();
console.log('regression: count-advance-without-delivery -> inp==getINP()==' +
    regCanonical + ' (live skip=2, not cached 0/490)');

// --- the measured read path ----------------------------------------------
// One caller-owned target, reused across every call. sink accrues the read
// primitives so the reads are not dead-code-eliminated. No allocation here:
// the getters return numbers and fill primitives + one interned string ref.
const target = {
    duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
    startTime: 0, eventType: '', interactionId: 0, attribution: null
};
let sink = 0;
function readGetters() {
    sink += obs.inp;
    sink += obs.worstDuration;
    obs.getINPInto(target);
    sink += target.duration;
}

// --- DETERMINISTIC per-call allocation via the SLOPE method --------------
// A single measureAllocs min-batch is nondeterministic at exactly 0: fixed GC
// bookkeeping (live closure HeapNumbers, ephemeron upkeep) leaves a small,
// call-count-INDEPENDENT residue that randomly lands at 0 or ~88 bytes. So we do
// NOT gate on min==0. Instead we measure the min-batch total at N and at 4N
// iterations and take the SLOPE:
//
//   perCall = (minBatch@4N - minBatch@N) / (4N - N)
//
// Real per-call allocation scales linearly with iterations and survives the
// subtraction; a fixed residue R cancels (R - R -> ~0). The gate passes iff
// perCall <= EPS, a tight bound the fixed residue satisfies but real per-call
// allocation cannot (the allocating control below lands at ~32 B/op and FAILS).
// This is immune to the exact-0-batch flake. `measureAllocs` clamps negative
// batch deltas to 0, so minBatch is a bounded non-negative floor.
const ITER = 50000;
const EPS = 0.5; // B/op ceiling for "zero per-call" (well under 1; control ~32)

function minBatchBytes(fn, iters, batches) {
    const r = measureAllocs(fn, { iterations: iters, batches: batches, warmup: iters });
    const bb = r.batchBytes.filter((x) => x !== null);
    return { min: Math.min.apply(null, bb), settled: r.settled, source: r.source };
}
function perCallSlope(fn, iters, batches) {
    const a = minBatchBytes(fn, iters, batches);
    const b = minBatchBytes(fn, iters * 4, batches);
    const slope = Math.max(0, (b.min - a.min) / (iters * 4 - iters));
    return { slope: slope, minN: a.min, min4N: b.min, settled: a.settled && b.settled, source: a.source };
}

// One discarded warm pass settles JIT/heap before the two measured arms.
minBatchBytes(readGetters, ITER, 8);
const s = perCallSlope(readGetters, ITER, 16);

console.log('alloc: source=' + s.source + ' settled=' + s.settled +
    ' minBatch@N=' + s.minN + ' minBatch@4N=' + s.min4N +
    ' perCall(slope)=' + s.slope.toFixed(6) + ' B/op eps=' + EPS);

// Guard against a no-op measurement (would falsely show 0 alloc).
assert.ok(sink > 0, 'getters were actually read (sink accrued)');
assert.ok(obs.getINPInto(target) === true && target.attribution === null,
    'getINPInto fills the target and nulls attribution');

// TEETH: the SAME slope method on an allocating control (one object pushed per
// call) must clear EPS by orders of magnitude -- proving the gate detects real
// per-call allocation, not just noise.
const ctrlStore = [];
function allocControl() { ctrlStore.push({ x: 0 }); }
const cs = perCallSlope(allocControl, 40000, 4);
assert.ok(ctrlStore.length > 0, 'control actually allocated');
console.log('control: perCall(slope)=' + cs.slope.toFixed(3) + ' B/op (must exceed eps ' + EPS + ')');

let bad = false;
if (!s.settled) {
    console.error('INCONCLUSIVE alloc measurement (run with --expose-gc): not settled on every batch');
    bad = true;
} else if (s.slope > EPS) {
    console.error('FAIL zero-alloc getters allocate: perCall(slope)=' + s.slope + ' > ' + EPS);
    bad = true;
}
if (cs.slope <= EPS) {
    console.error('FAIL alloc control NOT flagged (slope=' + cs.slope + ' <= ' + EPS + ') -- gate has no teeth');
    bad = true;
}

if (bad) {
    process.exitCode = 1;
} else {
    console.log('GATE getters.mjs perCall=' + s.slope.toFixed(6) + ' B/op eps=' + EPS +
        ' controlSlope=' + cs.slope.toFixed(1) + ' controlFlagged=true | ok');
}
