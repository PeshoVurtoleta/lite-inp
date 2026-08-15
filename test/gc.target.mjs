// test/gc.target.mjs -- node --expose-gc test/gc.target.mjs
//
// 0-B/op gate for the 1.2.0 element-attribution hot path:
//   iTargetTag[slot] = internTarget(e.target)
//
// The shipped path interns element targets through a WeakMap keyed by node
// IDENTITY (the Node is NEVER stored strongly) and a bounded string table capped
// at TARGET_CAP (128). This gate drives the REAL library through a MOCK global
// PerformanceObserver -- exactly like gc.longest.mjs / gc.getters.mjs, so ZERO
// public surface is added for the test -- and asserts the intern write is 0 B/op
// after warmup EVEN when 512 DISTINCT targets (4x the cap) stream past, so the
// overflow/sentinel branch is fully exercised.
//
// WHY the SLOPE method (deterministic; not a lucky exact-0 batch)
// ---------------------------------------------------------------------
// The observer's callback retains a handful of LIVE closure doubles
// (currentInpDuration, lastInp, ...) as HeapNumbers; V8 sometimes reallocates one
// at a fresh address inside a batch, so a min batch shows ~0..88 bytes of RETAINED
// growth. That residue was measured to be CONSTANT regardless of call count (~88
// bytes in the min batch at BOTH 200000 and 800000 iterations -- it does NOT scale
// per-call) and IDENTICAL with and without the target path. So gating on "some
// batch hits exactly 0" is a coin-flip. Instead we measure the min-batch total at
// N and at 4N iterations and take the SLOPE:
//   perCall = (minBatch@4N - minBatch@N) / (4N - N).
// Real per-call allocation scales with iterations and survives the subtraction;
// the fixed residue cancels. The gate passes iff perCall <= EPS -- a tight bound
// the fixed residue satisfies but real per-call allocation cannot.
//
// TEETH: the SAME slope method on a CONTROL that STORES e.target per interaction
// (the classic RUM anti-pattern this design rejects) lands at ~32 B/op and MUST
// clear EPS -- proving the gate detects real per-call allocation, not noise. The
// shipped interned path is GREEN (perCall ~0); the store-the-target control is RED.
//
// This gate MEASURES; it never prints SKIPPED. measureAllocs needs forced
// settling (--expose-gc, which the npm script supplies). Without it the
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

// --- distinct target pool, 4x the intern cap -----------------------------
// 512 distinct node stand-ins: the first 128 encountered are interned (one string
// built each, once), the remaining 384 always fail closed to the sentinel with no
// allocation and no store. Reused cyclically so after warmup every feed is either
// a WeakMap hit or a sentinel return -- both zero-alloc.
const DISTINCT = 512;   // > TARGET_CAP (128)
const pool = new Array(DISTINCT);
for (let k = 0; k < DISTINCT; k++) pool[k] = { tagName: 'BUTTON', id: 'btn-' + k };

// --- CORRECTNESS: the interned path actually produces an element target ----
// A fresh observer fed a known target must resolve it back to tag#id; a null
// target (element removed before the entry surfaced) and an over-cap target must
// both fail closed to null (never a wrong element -- null is not zero).
{
    const c = createInpObserver();
    const ccb = capturedEventCb;
    ccb({ getEntries: () => [{
        interactionId: 1, duration: 300, startTime: 0, processingStart: 2,
        processingEnd: 152, name: 'pointerup', target: pool[0]
    }] });
    assert.equal(c.getINP().attribution.target, 'button#btn-0',
        'interned target resolves to tag#id');
    c.destroy();

    const c2 = createInpObserver();
    const c2cb = capturedEventCb;
    c2cb({ getEntries: () => [{
        interactionId: 1, duration: 300, startTime: 0, processingStart: 2,
        processingEnd: 152, name: 'pointerup', target: null
    }] });
    assert.equal(c2.getINP().attribution.target, null,
        'null target fails closed to null');
    c2.destroy();

    // Over-cap: intern 128 distinct, then a 129th must fail closed to null.
    const c3 = createInpObserver();
    const c3cb = capturedEventCb;
    for (let k = 0; k < 128; k++) {
        c3cb({ getEntries: () => [{
            interactionId: k + 1, duration: 300 - k, startTime: k, processingStart: k + 2,
            processingEnd: k + 152, name: 'pointerup', target: { tagName: 'DIV', id: 'over-' + k }
        }] });
    }
    // The 129th distinct target is over the 128 cap -> sentinel -> null. Feed it as
    // the new WORST so it lands at the head of the longest-N list. Force the p98
    // skip to 0 (interactionCount = 1) so getINP() reads that head entry.
    c3cb({ getEntries: () => [{
        interactionId: 999, duration: 5000, startTime: 500, processingStart: 502,
        processingEnd: 2502, name: 'pointerup', target: { tagName: 'DIV', id: 'over-cap' }
    }] });
    performance.interactionCount = 1;
    const overCap = c3.getINP().attribution;
    delete performance.interactionCount;
    assert.equal(overCap.target, null,
        'the 129th distinct target is over the 128 cap and fails closed to null, never a wrong element');
    c3.destroy();
}

// --- the measured hot path (shared builder) ------------------------------
// Warm a fixed set of interactionIds into idToSlot (so no Map.set/delete churn
// during measurement), then feed those ids with strictly-RISING durations so the
// "dur > iDuration[slot]" block -- which holds the internTarget write -- runs on
// EVERY feed. The target cycles through the 512-pool, driving both the interned
// (WeakMap hit) and over-cap (sentinel) branches.
function makeFeed() {
    const obs = createInpObserver();
    const cb = capturedEventCb;
    const IDN = 32;
    const ids = new Float64Array(IDN);
    for (let k = 0; k < IDN; k++) ids[k] = 100000 + k;
    let step = 0;
    const entry = {
        interactionId: 0, duration: 0,
        startTime: 0, processingStart: 0, processingEnd: 0, name: 'pointerup', target: null
    };
    const arr = [entry];
    const list = { getEntries: () => arr };
    function feed() {
        const dur = 20 + step;               // rises -> maintenance block always runs
        entry.interactionId = ids[step % IDN];
        entry.duration = dur;
        entry.startTime = step;
        entry.processingStart = step + 2;
        entry.processingEnd = step + 2 + dur * 0.5;
        entry.target = pool[step % DISTINCT];
        step++;
        cb(list);
    }
    return { feed, obs, steps: () => step };
}

const ITER = 200000;
const BATCHES = 16;
const EPS = 0.5; // B/op ceiling for "zero per-call" (well under 1; control ~32)

// --- DETERMINISTIC per-call allocation via the SLOPE method --------------
// A single min-batch is nondeterministic at exactly 0: fixed GC bookkeeping
// (live closure HeapNumbers, ephemeron upkeep) leaves a small, call-count-
// INDEPENDENT residue that randomly lands at 0 or ~88 bytes. So we do NOT gate on
// min==0. We measure the min-batch total at N and at 4N iterations and take the
// SLOPE:  perCall = (minBatch@4N - minBatch@N) / (4N - N).
// Real per-call allocation scales with iterations and survives the subtraction; a
// fixed residue R cancels (R - R -> ~0). The gate passes iff perCall <= EPS -- a
// tight bound the fixed residue satisfies but real per-call allocation cannot
// (the store-the-target control lands at ~32 B/op and FAILS). Immune to the
// exact-0-batch flake; measureAllocs clamps negative deltas so minBatch >= 0.
function minBatchBytes(fn, iters, batches) {
    const r = measureAllocs(fn, { iterations: iters, batches: batches, warmup: iters });
    const bb = r.batchBytes.filter((x) => x !== null);
    return { min: Math.min.apply(null, bb), settled: r.settled, source: r.source };
}
function perCallSlope(makeFn, iters, batches) {
    const fa = makeFn(); const a = minBatchBytes(fa.fn, iters, batches); fa.done();
    const fb = makeFn(); const b = minBatchBytes(fb.fn, iters * 4, batches); fb.done();
    const slope = Math.max(0, (b.min - a.min) / (iters * 4 - iters));
    return { slope: slope, minN: a.min, min4N: b.min, settled: a.settled && b.settled, source: a.source };
}

// A fresh interned-target feed per measurement arm.
function makeShipped() {
    const f = makeFeed();
    return { fn: f.feed, done: function () { f.obs.destroy(); } };
}

// One discarded warm pass settles JIT/heap before the measured arms.
{ const w = makeShipped(); minBatchBytes(w.fn, ITER, 8); w.done(); }
const s = perCallSlope(makeShipped, ITER, BATCHES);

console.log('alloc: source=' + s.source + ' settled=' + s.settled +
    ' minBatch@N=' + s.minN + ' minBatch@4N=' + s.min4N +
    ' perCall(slope)=' + s.slope.toFixed(6) + ' B/op eps=' + EPS);
console.log('scaling: minBatchBytes@200k=' + s.minN + ' minBatchBytes@800k=' + s.min4N +
    ' (per-call would 4x; a fixed residue cancels in the slope)');

// Sanity: the intern path was actually driven and recorded interactions.
{ const chk = makeFeed();
  for (let i = 0; i < 200; i++) chk.feed();
  assert.ok(chk.obs.getINP() !== null, 'observer actually recorded interactions');
  chk.obs.destroy(); }

// --- CONTROL: store the target per interaction (MUST be flagged) ---------
// The naive RUM anti-pattern: retain the target (a wrapper object) per
// interaction. Its per-call growth is real and shows up as a ~32 B/op SLOPE that
// clears EPS by orders of magnitude -- proving the gate detects real per-call
// allocation, not noise. A fresh store per arm keeps memory bounded.
function makeControl() {
    const store = [];
    let cstep = 0;
    return {
        fn: function () { store.push({ target: pool[cstep % DISTINCT] }); cstep++; },
        done: function () { store.length = 0; }
    };
}
const cs = perCallSlope(makeControl, 40000, 4);
console.log('control: perCall(slope)=' + cs.slope.toFixed(3) + ' B/op (must exceed eps ' + EPS + ')');

// --- verdicts ------------------------------------------------------------
let bad = false;
if (!s.settled) {
    console.error('INCONCLUSIVE alloc measurement (run with --expose-gc): not settled on every batch');
    bad = true;
} else if (s.slope > EPS) {
    console.error('FAIL interned target path allocates: perCall(slope)=' + s.slope + ' > ' + EPS);
    bad = true;
}
// TEETH: the store-the-target control MUST be flagged, or the gate is toothless.
if (cs.slope <= EPS) {
    console.error('FAIL control (store-the-target) NOT flagged (slope=' + cs.slope +
        ' <= ' + EPS + ') -- gate has no teeth');
    bad = true;
}

if (bad) {
    process.exitCode = 1;
} else {
    console.log('GATE gc.target perCall=' + s.slope.toFixed(6) + ' B/op eps=' + EPS +
        ' controlSlope=' + cs.slope.toFixed(1) +
        ' controlFlagged=true teeth=red-against-store-the-target/green-shipped | ok');
}
