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
// reads are measured with measureAllocs at maxBytesPerCall: 0.
//
// This gate MEASURES; it never prints SKIPPED. measureAllocs needs forced
// settling (--expose-gc, which the npm script supplies). If run without it the
// measurement is inconclusive and the gate FAILS closed rather than skipping.

import assert from 'node:assert/strict';
import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

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

const ITER = 50000;
const result = measureAllocs(readGetters, { iterations: ITER, batches: 8, warmup: ITER });
const report = checkAllocs(result, { maxBytesPerCall: 0 });

console.log('alloc: source=' + result.source + ' settled=' + result.settled +
    ' bytesPerCall(min)=' + result.bytesPerCall +
    ' maxBytesPerCall=' + result.maxBytesPerCall +
    ' verdict=' + report.verdict);

// Guard against a no-op measurement (would falsely show 0 alloc).
assert.ok(sink > 0, 'getters were actually read (sink accrued)');
assert.ok(obs.getINPInto(target) === true && target.attribution === null,
    'getINPInto fills the target and nulls attribution');

if (report.verdict === 'fail') {
    console.error('FAIL zero-alloc getters allocate: bytesPerCall=' + result.bytesPerCall);
    process.exitCode = 1;
} else if (report.verdict === 'inconclusive') {
    // --expose-gc missing, or no settle. Surface it rather than a false pass.
    console.error('INCONCLUSIVE alloc measurement (run with --expose-gc): ' +
        (report.reasons ? report.reasons.join('; ') : ''));
    process.exitCode = 1;
} else {
    console.log('GATE getters.mjs alloc=' +
        (result.bytesPerCall <= 0 ? 0 : result.bytesPerCall) + ' B/op verdict=' +
        report.verdict + ' | ok');
}
