// test/gc.longest.mjs -- node --expose-gc test/gc.longest.mjs
//
// IN-01 proof for @zakkster/lite-inp.
//
// TWO things are proven here:
//   1. REGRESSION: on a 600-interaction burst that wraps the 512-slot recency
//      ring, the OLD recency-only p98 (reimplemented below as the control) and
//      the NEW page-lifetime longest-N p98 produce DIFFERENT INP, and the NEW
//      value equals the p98 computed over the TRUE lifetime longest set. This
//      is the scenario that would have caught IN-01 before publish.
//   2. ALLOCATION: the longest-N maintenance path is 0 B/op across the burst.
//
// APPROACH -- why no internal export was added:
//   The real hot path (onEventEntry -> maintainLongest) and the real cold path
//   (computeINP via obs.getINP()) are driven through a MOCK global
//   PerformanceObserver installed before createInpObserver() runs. observe()
//   captures the callback the library registers; we then invoke it with mock
//   entry lists. This exercises the *shipped* code with ZERO additions to the
//   public surface (neither the return object at Inp.js nor a new named export).
//   That is the least-surface-polluting choice, so nothing is flagged.

import assert from 'node:assert/strict';
import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

// --- mock global PerformanceObserver -------------------------------------
let capturedEventCb = null;
let capturedLoafCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) {
        if (opts.type === 'event') capturedEventCb = this._cb;
        else if (opts.type === 'long-animation-frame') capturedLoafCb = this._cb;
    }
    disconnect() {}
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;
// Node has no performance.interactionCount, so the library falls back to raw
// iCount (the true lifetime unique count). Assert that precondition holds --
// otherwise the numbers below would not be reproducible.
assert.equal(performance.interactionCount, undefined,
    'test assumes no performance.interactionCount so the raw-iCount fallback is exercised');

const { createInpObserver } = await import('../Inp.js');

// --- shared burst description --------------------------------------------
// 600 unique interactions, interactionCap default 512 -> ring wraps, evicting
// the first 88. The 20 LONGEST interactions all live in the evicted region
// (i < 20 < 88), so a recency-only percentile can never see them.
const CAP = 512;
const TOTAL = 600;
function durationFor(i) {
    // i < 20: the 20 longest, strictly descending 700..510, all evicted.
    // else:   short interactions 100..129 that dominate the live window.
    return i < 20 ? 700 - i * 10 : 100 + (i % 30);
}

// --- controls: pure reimplementations ------------------------------------
// OLD recency-only algorithm (what Inp.js shipped before IN-01). Candidate set
// is only the live ring; skip fallback used the CAPPED count n (no
// performance.interactionCount in node).
function oldRecencyOnlyInp(total, cap) {
    const n = Math.min(total, cap);
    const live = [];
    for (let k = 0; k < n; k++) live.push(durationFor(total - n + k));
    live.sort((a, b) => b - a);
    const skip = Math.floor(n / 50);            // OLD fallback = n
    const targetIdx = Math.min(skip, n - 1);
    return live[targetIdx];
}

// NEW correct target: p98 over the true PAGE-LIFETIME longest set, capped at 10.
function trueLifetimeInp(total) {
    const all = [];
    for (let i = 0; i < total; i++) all.push(durationFor(i));
    all.sort((a, b) => b - a);
    const lnCount = Math.min(all.length, 10);
    const skip = Math.floor(total / 50);        // NEW fallback = raw iCount
    const targetIdx = Math.min(skip, lnCount - 1);
    return all[targetIdx];
}

// --- drive the REAL library through the mock observer ---------------------
const obs = createInpObserver();
assert.equal(obs.supported, true, 'mock PerformanceObserver reports event support');

for (let i = 0; i < TOTAL; i++) {
    const dur = durationFor(i);
    const startTime = i;
    const processingStart = startTime + 2;
    const processingEnd = processingStart + dur * 0.5;
    const entry = {
        interactionId: i + 1,     // 1-based; 0 means "non-interaction"
        duration: dur,
        startTime, processingStart, processingEnd,
        name: 'pointerup'
    };
    capturedEventCb({ getEntries: () => [entry] });
}

const newInp = obs.getINP().duration;
const oldInp = oldRecencyOnlyInp(TOTAL, CAP);
const expected = trueLifetimeInp(TOTAL);

// The ring really did wrap.
assert.equal(obs.interactionCount, CAP, 'recency ring capped at 512 after 600 feeds');

// The NEW value is the true lifetime p98...
assert.equal(newInp, expected, 'new INP equals true lifetime longest-set p98');
assert.equal(newInp, 610, 'sanity: 10th-largest lifetime duration is 610');
// ...and it DIFFERS from the buggy recency-only value.
assert.notEqual(newInp, oldInp, 'IN-01: recency-only INP differs from lifetime INP');

console.log('IN-01 regression: OLD(recency-only)=' + oldInp +
    '  NEW(longest-N)=' + newInp + '  expected(lifetime)=' + expected +
    '  -> DIFFER by ' + (newInp - oldInp));

// --- allocation proof: maintainLongest is 0 B/op -------------------------
// measureAllocs requires forced settling, i.e. --expose-gc. Under plain
// `node --test` (no --expose-gc) the regression proof above already ran; skip
// the byte gate here rather than throw, and print how to run the full gate.
if (typeof globalThis.gc !== 'function') {
    console.log('alloc: SKIPPED (run `node --expose-gc test/gc.longest.mjs` for the 0 B/op gate)');
    console.log('GATE longest.mjs regression=pass alloc=skipped | ok');
} else {
// Isolate the maintenance hot path. Warm a fixed set of interactionIds into
// idToSlot (so no Map.set/delete churn during measurement), then feed those
// same ids with strictly-RISING durations. Every feed re-enters the
// "dur > iDuration[slot]" block -> runs maintainLongest -> update/bubble/
// displace across the full 10-slot list. All writes land in preallocated
// arrays; a single reused entry object and a single reused list are the only
// heap objects, created ONCE outside the measured loop.
const allocObs = createInpObserver();
const IDN = 20;
const ids = new Float64Array(IDN);
for (let k = 0; k < IDN; k++) ids[k] = 100000 + k;   // large, distinct ids

let step = 0;
const reEntry = {
    interactionId: 0, duration: 0,
    startTime: 0, processingStart: 0, processingEnd: 0, name: 'pointerup'
};
const reArr = [reEntry];
const reList = { getEntries: () => reArr };

function feedRising() {
    const id = ids[step % IDN];
    // dur rises by IDN each time this id recurs, so it always exceeds the
    // stored max for that slot -> the maintenance block always runs.
    const dur = 20 + step;
    reEntry.interactionId = id;
    reEntry.duration = dur;
    reEntry.startTime = step;
    reEntry.processingStart = step + 2;
    reEntry.processingEnd = step + 2 + dur * 0.5;
    step++;
    capturedEventCb(reList);
}

// Route the mock to allocObs's callback (last observer created).
// createInpObserver above installed capturedEventCb = allocObs's onEventEntry.
const ITER = 50000;
const result = measureAllocs(feedRising, { iterations: ITER, batches: 8, warmup: ITER });
const report = checkAllocs(result, { maxBytesPerCall: 0 });

console.log('alloc: source=' + result.source + ' settled=' + result.settled +
    ' bytesPerCall(min)=' + result.bytesPerCall +
    ' maxBytesPerCall=' + result.maxBytesPerCall +
    ' verdict=' + report.verdict);

// Guard against the observer having been a no-op (would falsely show 0 alloc).
assert.ok(allocObs.getINP() !== null, 'alloc observer actually recorded interactions');
assert.ok(step >= ITER, 'maintenance path was actually driven');

if (report.verdict === 'fail') {
    console.error('FAIL longest-N maintenance allocates: bytesPerCall=' + result.bytesPerCall);
    process.exitCode = 1;
} else if (report.verdict === 'inconclusive') {
    // --expose-gc missing, or no settle. Surface it rather than a false pass.
    console.error('INCONCLUSIVE alloc measurement (run with --expose-gc): ' +
        (report.reasons ? report.reasons.join('; ') : ''));
    process.exitCode = 1;
} else {
    console.log('GATE longest.mjs regression=pass alloc=' +
        (result.bytesPerCall <= 0 ? 0 : result.bytesPerCall) + ' B/op verdict=' +
        report.verdict + ' | ok');
}
}
