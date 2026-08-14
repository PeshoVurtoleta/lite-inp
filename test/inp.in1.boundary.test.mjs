// test/inp.in1.boundary.test.mjs -- node --test test/inp.in1.boundary.test.mjs
//
// QA (independent of the coder/reviewer) boundary suite for the 1.1.0 (IN1)
// surface: `inp`, `worstDuration`, `getINPInto(target)`, `liveInpIdx` (reached
// only through the three public getters that route through it), the
// `resetState()` bfcache reset wired to a real `pageshow{persisted}` listener,
// the `currentINP` deprecated alias, and the prerender `actOffset` refresh.
//
// This file does NOT modify Inp.js. It drives the REAL hot path (onEventEntry
// -> maintainLongest) and the REAL cold path (getINP/getInp/getINPInto) through
// a mock global PerformanceObserver + mock window/document (so the real
// pageshow/prerenderingchange listeners registered by createInpObserver() are
// exercised), exactly like test/inp.boundary.test.mjs and test/torture.mjs.
// Every assertion here is measured against the code as reviewer-approved. A
// failure here is a real defect to report back to the coder, not a license to
// loosen the assertion.

import test from 'node:test';
import assert from 'node:assert/strict';

// --- mock global PerformanceObserver ---------------------------------------
let capturedEventCb = null;
let capturedLoafCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) {
        if (opts.type === 'event') capturedEventCb = this._cb;
        else if (opts.type === 'long-animation-frame') capturedLoafCb = this._cb;
    }
    disconnect() { }
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;

// --- mock window/document (so pageshow/prerenderingchange listeners are
// really registered and really removed, like test/torture.mjs) -------------
class MockEventTarget {
    constructor() { this._l = new Map(); }
    addEventListener(type, fn) {
        let a = this._l.get(type);
        if (!a) { a = new Set(); this._l.set(type, a); }
        a.add(fn);
    }
    removeEventListener(type, fn) { const a = this._l.get(type); if (a) a.delete(fn); }
    dispatch(type, ev) { const a = this._l.get(type); if (a) for (const fn of a) fn(ev); }
    liveCount() { let n = 0; for (const a of this._l.values()) n += a.size; return n; }
}
const mockWindow = new MockEventTarget();
const mockDocument = new MockEventTarget();
globalThis.window = mockWindow;
globalThis.document = mockDocument;

assert.equal(performance.interactionCount, undefined,
    'suite assumes no ambient performance.interactionCount so the raw-iCount ' +
    'fallback is exercised, except where a test explicitly stubs it out');

const { createInpObserver } = await import('../Inp.js');

// --- helpers ----------------------------------------------------------------

function mkEntry(id, dur, startTime, name) {
    return {
        interactionId: id,
        duration: dur,
        startTime: startTime,
        processingStart: startTime + 2,
        processingEnd: startTime + 2 + dur * 0.5,
        name: name || 'pointerup'
    };
}

function freshObserver(opts) {
    const obs = createInpObserver(opts);
    return { obs: obs, cb: capturedEventCb, loafCb: capturedLoafCb };
}

function feedOne(cb, id, dur, startTime, name) {
    cb({ getEntries: () => [mkEntry(id, dur, startTime, name)] });
}

function freshTarget() {
    return {
        duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
        startTime: 0, eventType: '', interactionId: 0, attribution: null
    };
}

// =============================================================================
// 1. Empty-observer boundary -- every new getter, literal null (not 0).
// =============================================================================

test('IN1 empty: inp === null (literal null, not 0)', () => {
    const { obs } = freshObserver();
    assert.equal(obs.inp, null);
    assert.strictEqual(obs.inp, null, 'must be literal null, not falsy-0');
    obs.destroy();
});

test('IN1 empty: getINP() === null', () => {
    const { obs } = freshObserver();
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('IN1 empty: getINPInto(t) === false and target is left untouched', () => {
    const { obs } = freshObserver();
    const t = freshTarget();
    t.duration = 12345; // sentinel: must survive untouched
    t.eventType = 'sentinel';
    t.attribution = 'sentinel-attr';
    const filled = obs.getINPInto(t);
    assert.strictEqual(filled, false);
    assert.equal(t.duration, 12345, 'target.duration untouched on empty observer');
    assert.equal(t.eventType, 'sentinel', 'target.eventType untouched on empty observer');
    assert.equal(t.attribution, 'sentinel-attr', 'target.attribution untouched on empty observer (not force-nulled on false)');
    obs.destroy();
});

test('IN1 empty: worstDuration is 0 (documented empty value, a real number not null)', () => {
    const { obs } = freshObserver();
    assert.strictEqual(obs.worstDuration, 0);
    obs.destroy();
});

test('IN1 empty: currentINP (deprecated alias) is 0, matching worstDuration', () => {
    const { obs } = freshObserver();
    assert.strictEqual(obs.currentINP, 0);
    assert.strictEqual(obs.currentINP, obs.worstDuration);
    obs.destroy();
});

// =============================================================================
// 2. getINPInto contract: boolean return; same fields as getINP(); attribution
//    forced null; target not retained (no cross-contamination); reused target
//    cleanly overwritten.
// =============================================================================

test('IN1 getINPInto: returns a strict boolean (true) on success', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 55, 0);
    const t = freshTarget();
    const r = obs.getINPInto(t);
    assert.strictEqual(typeof r, 'boolean');
    assert.strictEqual(r, true);
    obs.destroy();
});

test('IN1 getINPInto: returns a strict boolean (false) on empty', () => {
    const { obs } = freshObserver();
    const r = obs.getINPInto(freshTarget());
    assert.strictEqual(typeof r, 'boolean');
    assert.strictEqual(r, false);
    obs.destroy();
});

test('IN1 getINPInto: fills the SAME fields getINP() would, and forces attribution null', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 88, 10);
    feedOne(cb, 2, 40, 20);

    const viaGetINP = obs.getINP();
    const t = freshTarget();
    t.attribution = 'must-be-cleared';
    const ok = obs.getINPInto(t);

    assert.strictEqual(ok, true);
    assert.equal(t.duration, viaGetINP.duration);
    assert.equal(t.inputDelay, viaGetINP.inputDelay);
    assert.equal(t.processingTime, viaGetINP.processingTime);
    assert.equal(t.presentationDelay, viaGetINP.presentationDelay);
    assert.equal(t.startTime, viaGetINP.startTime);
    assert.equal(t.eventType, viaGetINP.eventType);
    assert.equal(t.interactionId, viaGetINP.interactionId);
    assert.strictEqual(t.attribution, null, 'getINPInto always nulls attribution, even if the caller pre-seeded it');
    obs.destroy();
});

test('IN1 getINPInto: does not retain target -- two targets, mutate one, no cross-contamination', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 88, 0);

    const t1 = freshTarget();
    const t2 = freshTarget();
    obs.getINPInto(t1);
    obs.getINPInto(t2);
    assert.equal(t1.duration, 88);
    assert.equal(t2.duration, 88);

    // Mutate t1 by hand and by driving a NEW worst interaction that only t2
    // is refreshed against; t1 must not silently change (no retained ref).
    t1.duration = -999;
    feedOne(cb, 2, 500, 1); // new worst
    obs.getINPInto(t2);

    assert.equal(t1.duration, -999, 't1 was never touched again -- observer holds no reference to it');
    assert.equal(t2.duration, 500, 't2 reflects the new worst only because we called getINPInto(t2) again');
    obs.destroy();
});

test('IN1 getINPInto: reused target across calls is overwritten cleanly (no stale leftover fields)', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 30, 0, 'keydown');
    const t = freshTarget();
    obs.getINPInto(t);
    assert.equal(t.duration, 30);
    assert.equal(t.eventType, 'keydown');

    feedOne(cb, 2, 200, 1, 'pointerup'); // new worst, different eventType
    obs.getINPInto(t); // reuse the SAME target object

    assert.equal(t.duration, 200, 'reused target reflects the new call, not the stale 30');
    assert.equal(t.eventType, 'pointerup', 'reused target eventType fully overwritten, not merged with stale keydown');
    assert.equal(t.interactionId, 2);
    obs.destroy();
});

// =============================================================================
// 3. worstDuration >= inp invariant across a delivered sequence.
// =============================================================================

test('IN1 invariant: worstDuration >= inp holds across a delivered mixed sequence', () => {
    const { obs, cb } = freshObserver();
    const durations = [50, 900, 20, 700, 10, 10, 850, 5, 5, 5, 600, 400, 1];
    for (let i = 0; i < durations.length; i++) {
        feedOne(cb, i + 1, durations[i], i);
        // Invariant holds after EVERY delivered interaction, not just at the end.
        if (obs.inp !== null) {
            assert.ok(obs.worstDuration >= obs.inp,
                'at step ' + i + ': worstDuration(' + obs.worstDuration + ') must be >= inp(' + obs.inp + ')');
        }
    }
    assert.equal(obs.worstDuration, 900, 'sanity: worst is the true max of the sequence');
    obs.destroy();
});

// =============================================================================
// 4. obs.inp === obs.getINP().duration -- node-level equality, every step of a
//    0/1/N-1/N/N+1 walk across the LN_CAP=10 boundary, and across the /50 skip
//    boundary (complements the browser 7-scenario oracle).
// =============================================================================

test('IN1 equality: obs.inp === obs.getINP().duration at every step, 0..N+1 across LN_CAP', () => {
    const { obs, cb } = freshObserver();
    assert.equal(obs.inp, null);
    assert.equal(obs.getINP(), null);

    // 0 -> 1 -> ... -> LN_CAP-1 (9) -> LN_CAP (10) -> LN_CAP+1 (11)
    for (let k = 1; k <= 11; k++) {
        feedOne(cb, k, 1000 - k, k); // strictly descending so every feed is retained/considered
        const viaGetter = obs.inp;
        const viaGetINP = obs.getINP();
        assert.notEqual(viaGetINP, null, 'N=' + k + ': getINP() non-null once >=1 interaction');
        assert.equal(viaGetter, viaGetINP.duration, 'N=' + k + ': obs.inp === obs.getINP().duration');
    }
    obs.destroy();
});

test('IN1 equality: both null together on a freshly destroyed (re-emptied) observer', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    assert.notEqual(obs.inp, null);
    obs.destroy(); // destroy() calls resetState()
    assert.equal(obs.inp, null);
    assert.equal(obs.getINP(), null);
    assert.equal(obs.inp === null, obs.getINP() === null, 'both null together post-destroy');
});

// =============================================================================
// 5. The count-advance-without-delivery invariant (independently re-derived).
//    Re-derives that liveInpIdx() has teeth against a cached-index getter by
//    computing what a CACHED index would have returned and asserting the real
//    getters do NOT match that wrong value, extended to:
//      - MULTIPLE boundary crossings in one run
//      - a crossing landing EXACTLY on a multiple of 50
//      - the lnCount < skip clamp region (few interactions, high count)
// =============================================================================

test('IN1 no-delivery regression: single crossing has teeth (a cached index would read the WRONG value)', () => {
    const { obs, cb } = freshObserver();
    // 10 distinct, strictly-descending durations -> longest-N fills to 10,
    // DESC [990,980,...,900]. No performance.interactionCount during delivery,
    // so a HOT-PATH cached index (inpIdx, refreshed only per delivered
    // interaction against iCount) would settle at floor(10/50)=0 (the head).
    for (let k = 1; k <= 10; k++) feedOne(cb, k, 1000 - k * 10, k);

    const cachedWrongIdx = 0; // what a cached-per-delivery index would read
    const cachedWrongValue = 990;

    // Advance the platform counter across a /50 boundary with ZERO delivered
    // interactions in between (sub-threshold interactions the observer never
    // sees). skip = floor(100/50) = 2 -> the 3rd-longest = 970.
    performance.interactionCount = 100;
    const liveInp = obs.inp;
    const canonical = obs.getINP().duration;
    const t = freshTarget();
    const filled = obs.getINPInto(t);
    delete performance.interactionCount;

    assert.equal(canonical, 970, 'sanity: live skip=2 into DESC[990,980,970,...] is 970');
    assert.notEqual(canonical, cachedWrongValue,
        'the live recompute must NOT equal the wrong cached-index value (' + cachedWrongValue + ') -- proves the regression has teeth');
    assert.equal(liveInp, canonical, 'obs.inp === getINP().duration under a no-delivery boundary crossing');
    assert.equal(filled, true);
    assert.equal(t.duration, canonical, 'getINPInto uses the live skip too, not the cached one');
    void cachedWrongIdx;
    obs.destroy();
});

test('IN1 no-delivery regression: MULTIPLE boundary crossings, no delivery between any of them', () => {
    const { obs, cb } = freshObserver();
    for (let k = 1; k <= 10; k++) feedOne(cb, k, 1000 - k * 10, k); // DESC [990..900]

    const crossings = [50, 100, 150, 200, 260, 999]; // several /50 boundaries, plus deep clamp
    for (const lc of crossings) {
        performance.interactionCount = lc;
        const liveInp = obs.inp;
        const canonical = obs.getINP().duration;
        const t = freshTarget();
        obs.getINPInto(t);
        delete performance.interactionCount;
        assert.equal(liveInp, canonical,
            'lifetimeCount=' + lc + ': obs.inp must equal getINP().duration across a no-delivery multi-crossing walk');
        assert.equal(t.duration, canonical, 'lifetimeCount=' + lc + ': getINPInto agrees too');
    }
    obs.destroy();
});

test('IN1 no-delivery regression: crossing landing EXACTLY on a multiple of 50', () => {
    const { obs, cb } = freshObserver();
    for (let k = 1; k <= 10; k++) feedOne(cb, k, 1000 - k * 10, k); // DESC [990..900]

    // Exactly 50, 100, 150 (not 49/51/149/151 -- the exact multiple itself).
    for (const lc of [50, 100, 150]) {
        performance.interactionCount = lc;
        const expectedSkip = Math.min((lc / 50) | 0, 9); // lnCount=10
        const expectedDuration = 990 - expectedSkip * 10;
        const liveInp = obs.inp;
        const canonical = obs.getINP().duration;
        delete performance.interactionCount;
        assert.equal(canonical, expectedDuration,
            'lifetimeCount EXACTLY ' + lc + ': skip=' + expectedSkip + ' -> duration=' + expectedDuration);
        assert.equal(liveInp, canonical, 'lifetimeCount EXACTLY ' + lc + ': obs.inp === getINP().duration');
    }
    obs.destroy();
});

test('IN1 clamp region: few interactions (lnCount=3), high lifetime count -> skip clamps to lnCount-1, never out of range', () => {
    const { obs, cb } = freshObserver();
    // Only 3 distinct interactions ever delivered -> lnCount stays 3 forever,
    // no matter how high performance.interactionCount later reports.
    feedOne(cb, 1, 300, 0);
    feedOne(cb, 2, 200, 1);
    feedOne(cb, 3, 100, 2);
    assert.equal(obs.interactionCount, 3);

    for (const lc of [150, 500, 5000, 1000000]) {
        performance.interactionCount = lc; // skip would be huge if unclamped
        const liveInp = obs.inp;
        const canonical = obs.getINP().duration;
        const t = freshTarget();
        const filled = obs.getINPInto(t);
        delete performance.interactionCount;

        assert.equal(canonical, 100, 'lifetimeCount=' + lc + ': clamps to lnCount-1 (rank 2) = smallest retained (100), never out of range/undefined');
        assert.equal(liveInp, canonical, 'lifetimeCount=' + lc + ': obs.inp === getINP().duration in the clamp region');
        assert.equal(filled, true);
        assert.equal(t.duration, canonical);
    }
    obs.destroy();
});

test('IN1 clamp region: exactly ONE interaction, huge lifetime count -> never indexes out of range', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 777, 0);
    performance.interactionCount = 999999999;
    const liveInp = obs.inp;
    const canonical = obs.getINP().duration;
    delete performance.interactionCount;
    assert.equal(canonical, 777);
    assert.equal(liveInp, 777);
    obs.destroy();
});

// =============================================================================
// 6. resetState completeness (bfcache pageshow{persisted:true}) -- driven
//    through the REAL window.addEventListener('pageshow', ...) listener, not a
//    direct internal call. pageshow{persisted:false} must NOT reset.
// =============================================================================

test('IN1 resetState: pageshow{persisted:true} resets EVERY read-surface getter to its empty state', () => {
    const { obs, cb, loafCb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    feedOne(cb, 2, 300, 1);
    if (loafCb) loafCb({ getEntries: () => [{
        startTime: 0, duration: 60, blockingDuration: 30, styleAndLayoutStart: 5,
        scripts: [{ invoker: 'x', sourceURL: 'y', sourceFunctionName: 'z', duration: 60 }]
    }] });

    // Sanity: populated BEFORE the reset (so the reset assertions below can
    // actually fail if resetState regresses).
    assert.notEqual(obs.inp, null, 'sanity: inp populated pre-reset');
    assert.ok(obs.worstDuration > 0, 'sanity: worstDuration populated pre-reset');
    assert.notEqual(obs.getINP(), null, 'sanity: getINP() populated pre-reset');
    assert.equal(obs.interactionCount, 2, 'sanity: interactionCount populated pre-reset');
    assert.ok(obs.currentINP > 0, 'sanity: currentINP populated pre-reset');
    const preTarget = freshTarget();
    assert.equal(obs.getINPInto(preTarget), true, 'sanity: getINPInto fills pre-reset');

    // The REAL bfcache-restore code path: dispatch a real persisted pageshow
    // at the listener createInpObserver() registered on window.
    mockWindow.dispatch('pageshow', { persisted: true });

    // Every read-surface getter, post-reset:
    assert.strictEqual(obs.inp, null, 'inp is null post-reset (not 0)');
    assert.strictEqual(obs.worstDuration, 0, 'worstDuration reset to its empty value 0');
    assert.strictEqual(obs.currentINP, 0, 'currentINP (alias) reset to 0');
    assert.equal(obs.getINP(), null, 'getINP() null post-reset');
    assert.equal(obs.interactionCount, 0, 'interactionCount rebaselined to 0');
    assert.equal(obs.getInteractions().length, 0, 'getInteractions() empty post-reset');
    assert.equal(obs.loafCount, 0, 'loafCount reset to 0');
    assert.equal(obs.getLoafs().length, 0, 'getLoafs() empty post-reset');
    const postTarget = freshTarget();
    postTarget.duration = 424242;
    assert.strictEqual(obs.getINPInto(postTarget), false, 'getINPInto returns false post-reset');
    assert.equal(postTarget.duration, 424242, 'getINPInto leaves target untouched post-reset');

    // No stale value survives on ANY getter: feed a fresh interaction and
    // confirm the NEW page-lifetime state is used, not anything pre-reset.
    feedOne(cb, 3, 42, 100);
    assert.equal(obs.inp, 42, 'post-reset state starts genuinely fresh (page-lifetime count rebaselined)');
    assert.equal(obs.worstDuration, 42);

    obs.destroy();
});

test('IN1 resetState: pageshow{persisted:false} does NOT reset', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    feedOne(cb, 2, 300, 1);
    const before = { inp: obs.inp, worst: obs.worstDuration, count: obs.interactionCount };

    mockWindow.dispatch('pageshow', { persisted: false });

    assert.equal(obs.inp, before.inp, 'inp unchanged by a non-persisted pageshow');
    assert.equal(obs.worstDuration, before.worst, 'worstDuration unchanged by a non-persisted pageshow');
    assert.equal(obs.interactionCount, before.count, 'interactionCount unchanged by a non-persisted pageshow');
    assert.notEqual(obs.inp, null, 'state remains populated -- non-persisted pageshow is a true no-op');
    obs.destroy();
});

test('IN1 resetState: pageshow with no event object / missing persisted does NOT reset (fails closed on ambiguous input)', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    assert.doesNotThrow(() => mockWindow.dispatch('pageshow', undefined));
    assert.doesNotThrow(() => mockWindow.dispatch('pageshow', {}));
    assert.notEqual(obs.inp, null, 'undefined/missing-persisted pageshow event must not reset (fail closed: reset only on an EXPLICIT persisted:true)');
    obs.destroy();
});

// =============================================================================
// 7. currentINP deprecated alias -- must not silently diverge from
//    worstDuration within this minor, across a live delivered sequence too
//    (not just at rest).
// =============================================================================

test('IN1 currentINP alias: tracks worstDuration exactly across a live sequence', () => {
    const { obs, cb } = freshObserver();
    const durations = [10, 500, 20, 5, 800, 1, 400];
    for (let i = 0; i < durations.length; i++) {
        feedOne(cb, i + 1, durations[i], i);
        assert.equal(obs.currentINP, obs.worstDuration,
            'currentINP must equal worstDuration at step ' + i);
    }
    assert.equal(obs.currentINP, 800);
    obs.destroy();
});

// =============================================================================
// 8. Listener balance / harness teeth: prove the window+document mocks used
//    above actually catch a leaked listener (adversarial re-derivation of
//    torture.mjs's `listenersLive === 0` gate -- if this ever silently passed
//    with a real leak, the torture gate would be worthless).
// =============================================================================

test('IN1 harness teeth: a deliberately un-removed listener IS detected by liveCount()', () => {
    const w = new MockEventTarget();
    const d = new MockEventTarget();
    // Simulate what createInpObserver() does on construct...
    function leakyOnPageShow() {}
    function leakyOnPrerenderingChange() {}
    w.addEventListener('pageshow', leakyOnPageShow);
    d.addEventListener('prerenderingchange', leakyOnPrerenderingChange);
    // ...but deliberately DO NOT call the equivalent of destroy()'s
    // removeEventListener for the window listener (the leak).
    d.removeEventListener('prerenderingchange', leakyOnPrerenderingChange);

    const listenersLive = w.liveCount() + d.liveCount();
    assert.equal(listenersLive, 1, 'exactly the deliberately-leaked window listener remains');
    assert.notEqual(listenersLive, 0, 'a real leak MUST make listenersLive !== 0 -- proves torture.mjs\'s gate has teeth');
});

test('IN1 harness teeth: correctly balanced add/remove yields liveCount() === 0 (positive control)', () => {
    const w = new MockEventTarget();
    const d = new MockEventTarget();
    function onPageShow() {}
    function onPrerenderingChange() {}
    w.addEventListener('pageshow', onPageShow);
    d.addEventListener('prerenderingchange', onPrerenderingChange);
    w.removeEventListener('pageshow', onPageShow);
    d.removeEventListener('prerenderingchange', onPrerenderingChange);
    assert.equal(w.liveCount() + d.liveCount(), 0, 'balanced add/remove -> 0, matching what destroy() must do');
});

// Real observer construct/destroy cycle (not the reimplemented mock above):
// proves createInpObserver()/destroy() themselves balance to 0 on the SAME
// mockWindow/mockDocument instances used throughout this file.
test('IN1 real observer: construct/destroy balances window+document listeners to 0', () => {
    const before = mockWindow.liveCount() + mockDocument.liveCount();
    const obs = createInpObserver();
    assert.ok(mockWindow.liveCount() + mockDocument.liveCount() > before, 'construct adds listeners');
    obs.destroy();
    assert.equal(mockWindow.liveCount() + mockDocument.liveCount(), before, 'destroy() removes exactly what construct added');
});

// =============================================================================
// 9. Adversarial: getINPInto(null) as the target -- an invalid, non-object
//    argument passed to a NEW entry point. Documents actual behavior (does it
//    throw cleanly, or corrupt observer state?) since the shipped surface has
//    no runtime guard on `target`.
// =============================================================================

test('adversarial: getINPInto(null) on an EMPTY observer does not throw (idx<0 short-circuits before touching target)', () => {
    const { obs } = freshObserver();
    assert.doesNotThrow(() => {
        const r = obs.getINPInto(null);
        assert.strictEqual(r, false);
    });
    obs.destroy();
});

test('adversarial: getINPInto(null) on a POPULATED observer throws a clean TypeError, and does not corrupt subsequent reads', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 42, 0);

    let threw = null;
    try { obs.getINPInto(null); } catch (e) { threw = e; }
    assert.ok(threw instanceof TypeError,
        'getINPInto(null) with data present throws TypeError (no runtime guard on target) -- documented, not silently swallowed');

    // State integrity after the throw: subsequent real reads still correct.
    assert.equal(obs.inp, 42, 'observer state is NOT corrupted by the getINPInto(null) throw');
    assert.equal(obs.getINP().duration, 42);
    const t = freshTarget();
    assert.equal(obs.getINPInto(t), true, 'a subsequent valid getINPInto call still works after the null-target throw');
    assert.equal(t.duration, 42);
    obs.destroy();
});

// =============================================================================
// 10. Adversarial: performance.interactionCount regressing backward (a value
//     LOWER than icBaseline) -- an input the planner's boundary list does not
//     explicitly name (not 0/1/N/N+1/null/undefined/NaN/-0), but is a real
//     external-state hazard for liveInpIdx's arithmetic (negative skip).
// =============================================================================

test('adversarial: performance.interactionCount regresses below icBaseline -- liveInpIdx never indexes negative/out-of-range', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    feedOne(cb, 2, 300, 1);
    feedOne(cb, 3, 100, 2);

    // icBaseline was captured as 0 at construction (no ambient interactionCount).
    // A large negative regression: skip = floor(-500/50) = -10 -> targetIdx
    // clamps only against lnCount on the upper side; verify no throw and no
    // undefined-duration read (NaN) leaks out as if it were a real number.
    performance.interactionCount = -500;
    let threw = null;
    let liveInp, canonical;
    try {
        liveInp = obs.inp;
        canonical = obs.getINP();
    } catch (e) { threw = e; }
    delete performance.interactionCount;

    assert.equal(threw, null, 'a regressed (negative-delta) interactionCount must not throw');
    // Fail-closed contract: liveInpIdx returns a negative skip in this case,
    // and both getInp()/computeINP() explicitly check `idx < 0` -> null.
    assert.equal(liveInp, null, 'negative skip -> fails closed to null, not a garbage index read');
    assert.equal(canonical, null, 'getINP() agrees: null, not a garbage index read');
    obs.destroy();
});

test('adversarial: performance.interactionCount === NaN falls back to raw iCount (fail closed, not NaN propagation)', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 42, 0);
    performance.interactionCount = NaN;
    const liveInp = obs.inp;
    delete performance.interactionCount;
    assert.equal(liveInp, 42, 'NaN interactionCount is falsy -> falls back to iCount, same as no ambient counter at all');
    assert.ok(!Number.isNaN(liveInp), 'result must never be NaN');
    obs.destroy();
});

test('adversarial: performance.interactionCount === -0 behaves identically to 0/undefined (falsy fallback)', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 42, 0);
    performance.interactionCount = -0;
    const liveInp = obs.inp;
    delete performance.interactionCount;
    assert.equal(liveInp, 42);
    obs.destroy();
});

test('IN1 resetState: pageshow dispatched with a literal null event does not reset (fails closed)', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 500, 0);
    assert.doesNotThrow(() => mockWindow.dispatch('pageshow', null));
    assert.notEqual(obs.inp, null, 'a literal null event must not reset');
    obs.destroy();
});

// =============================================================================
// 11. Duplicate dispose -- extended to the NEW getters specifically (inp,
//     worstDuration, getINPInto), not just getINP()/interactionCount as the
//     pre-IN1 suite already covers.
// =============================================================================

test('IN1 duplicate dispose: fails closed on inp/worstDuration/getINPInto, proven against POPULATED state', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 42, 0);
    feedOne(cb, 2, 17, 5);

    // Sanity: populated before destroy().
    assert.notEqual(obs.inp, null, 'sanity: inp populated pre-dispose');
    assert.ok(obs.worstDuration > 0, 'sanity: worstDuration populated pre-dispose');
    const preT = freshTarget();
    assert.equal(obs.getINPInto(preT), true, 'sanity: getINPInto fills pre-dispose');

    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());

    assert.strictEqual(obs.inp, null, 'inp fails closed after (repeated) destroy()');
    assert.strictEqual(obs.worstDuration, 0, 'worstDuration resets after (repeated) destroy()');
    const postT = freshTarget();
    postT.duration = -1;
    assert.strictEqual(obs.getINPInto(postT), false, 'getINPInto fails closed after (repeated) destroy()');
    assert.equal(postT.duration, -1, 'getINPInto leaves target untouched after (repeated) destroy()');
});

// =============================================================================
// 12. Dispose-during-iteration, exercised through the NEW getters: destroy()
//     called from inside onUpdate mid-batch, then obs.inp / getINPInto are read
//     immediately after the (truncated) batch finishes processing.
// =============================================================================

test('IN1 dispose-during-iteration: obs.inp / getINPInto reflect the post-reset state, never the pre-reset one', () => {
    let firedOnce = false;
    let obsRef = null;
    const obs = createInpObserver({
        onUpdate: (entry) => {
            if (!firedOnce) {
                firedOnce = true;
                obsRef.destroy(); // dispose WHILE onEventEntry is still looping the batch
            }
        }
    });
    obsRef = obs;
    const cb = capturedEventCb;

    const batch = [mkEntry(1, 500, 0), mkEntry(2, 10, 1), mkEntry(3, 20, 2)];
    assert.doesNotThrow(() => cb({ getEntries: () => batch }));

    // Same fail-closed consequence as the pre-existing getINP() proof: entry 1
    // (which triggered the reset) is wiped; only entries 2 and 3 survive.
    assert.equal(obs.inp, 20, 'obs.inp reflects only the post-reset entries (max of 10 and 20)');
    assert.equal(obs.worstDuration, 20);
    const t = freshTarget();
    assert.equal(obs.getINPInto(t), true);
    assert.equal(t.duration, 20, 'getINPInto agrees with obs.inp post-mid-iteration-reset');

    assert.doesNotThrow(() => obs.destroy());
    assert.equal(obs.inp, null, 'obs.inp fails closed after the final destroy()');
});

// =============================================================================
// 13. Re-entrant write through the NEW getters: onUpdate reads obs.inp /
//     obs.getINPInto() and THEN re-enters the hot path synchronously before
//     returning -- proves the live-recompute getters are safe to call
//     mid-callback and reflect the re-entrant write once it lands.
// =============================================================================

test('IN1 re-entrant: obs.inp / getINPInto read from inside onUpdate stay consistent across a synchronous re-entrant feed', () => {
    let reentered = false;
    let cbRef = null;
    let inpSeenImmediately = null;
    let inpSeenAfterReentry = null;
    const targetInsideCallback = freshTarget();

    const obs = createInpObserver({
        onUpdate: () => {
            if (!reentered) {
                reentered = true;
                inpSeenImmediately = obs.inp; // read the live getter mid-callback
                obs.getINPInto(targetInsideCallback);
                // Re-entrant write: feed a larger interaction from inside the
                // callback that is still processing the first one.
                cbRef({ getEntries: () => [mkEntry(999, 5000, 100)] });
                inpSeenAfterReentry = obs.inp; // live getter recomputes fresh
            }
        }
    });
    cbRef = capturedEventCb;

    assert.doesNotThrow(() => cbRef({ getEntries: () => [mkEntry(1, 100, 0)] }));

    assert.equal(inpSeenImmediately, 100, 'obs.inp read synchronously before reentry is correct (live recompute, not stale)');
    assert.equal(inpSeenAfterReentry, 5000, 'obs.inp read AFTER the reentrant write reflects it immediately (live recompute)');
    assert.equal(targetInsideCallback.duration, 100, 'getINPInto captured inside the callback BEFORE the reentrant write, unaffected by the later write (no retained ref)');
    assert.equal(obs.inp, 5000, 'final state after both interactions: inp reflects the larger one');
    assert.equal(obs.worstDuration, 5000);
    obs.destroy();
});
