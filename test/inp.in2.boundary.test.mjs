// test/inp.in2.boundary.test.mjs -- node --test test/inp.in2.boundary.test.mjs
//
// QA (independent of the coder/reviewer) boundary suite for the 1.2.0 (IN2)
// surface: `internTarget`/`resolveTarget`/`describeTarget` (element attribution,
// decisions/0003-target.md), `collectLoafs`/`pickPhase`/`buildAttribution` (the
// LoAF correlation rule, decisions/0002-correlation.md), and the target-intern
// portion of `resetState()`/`destroy()`.
//
// None of these functions are exported -- they are closures inside
// createInpObserver(). This file drives them the ONLY way Node can: through the
// REAL hot path (onEventEntry -> internTarget -> maintainLongest) via a mock
// global PerformanceObserver, and reads the REAL cold path (getINP() ->
// buildAttribution -> collectLoafs/pickPhase/resolveTarget), exactly like
// test/inp.in1.boundary.test.mjs and test/gc.target.mjs. Every assertion here
// was measured against the code as reviewer-approved (values verified against
// the running library before being written down); a failure here is a real
// defect to report back to the coder, not a license to loosen the assertion.

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

// --- mock window/document (so resetState's pageshow{persisted:true} path is
// driven through the REAL listener, like test/torture.mjs / inp.in1) ---------
class MockEventTarget {
    constructor() { this._l = new Map(); }
    addEventListener(type, fn) {
        let a = this._l.get(type);
        if (!a) { a = new Set(); this._l.set(type, a); }
        a.add(fn);
    }
    removeEventListener(type, fn) { const a = this._l.get(type); if (a) a.delete(fn); }
    dispatch(type, ev) { const a = this._l.get(type); if (a) for (const fn of a) fn(ev); }
}
const mockWindow = new MockEventTarget();
const mockDocument = new MockEventTarget();
globalThis.window = mockWindow;
globalThis.document = mockDocument;

const { createInpObserver } = await import('../Inp.js');

// --- helpers ----------------------------------------------------------------

function freshObserver(opts) {
    const obs = createInpObserver(opts);
    return { obs: obs, cb: capturedEventCb, loafCb: capturedLoafCb };
}

// Full control over startTime/processingStart/processingEnd/duration/target,
// unlike inp.in1's mkEntry (which derives processingStart/End mechanically) --
// IN2's correlation rule needs precise, independently-chosen window edges.
function mkEntry(id, dur, start, pStart, pEnd, name, target) {
    const e = { interactionId: id, duration: dur, startTime: start, processingStart: pStart, processingEnd: pEnd, name: name || 'pointerup' };
    if (target !== undefined) e.target = target;
    return e;
}
function feed(cb, entry) { cb({ getEntries: () => [entry] }); }
function feedBatch(cb, entries) { cb({ getEntries: () => entries }); }

function mkLoaf(start, dur, styleStart, scripts) {
    return { startTime: start, duration: dur, blockingDuration: 0, styleAndLayoutStart: styleStart || 0, scripts: scripts || [] };
}
function feedLoafs(loafCb, loafs) { loafCb({ getEntries: () => loafs }); }

// Interns `n` distinct low-duration targets so the intern table sits at
// exactly `n` before the interaction under test is fed. Interaction ids and
// target ids are namespaced by `base` so callers can prime independently.
function primeTargets(cb, n, base) {
    for (let k = 0; k < n; k++) {
        feed(cb, mkEntry(base + k, 1 + (k % 3), k, k + 0.1, k + 0.5, 'pointerup', { tagName: 'DIV', id: 'prime' + base + '-' + k }));
    }
}

// Forces liveInpIdx()'s skip to 0 for the duration of the callback, so
// getINP() always reads the CURRENT longest (head of longest-N) regardless of
// how many priming interactions were fed. Mirrors test/gc.target.mjs.
function readAtHead(obs) {
    performance.interactionCount = 1;
    const r = obs.getINP();
    delete performance.interactionCount;
    return r;
}

// =============================================================================
// 1. internTarget fail-closed
// =============================================================================

test('internTarget: null target -> sentinel -> attribution.target is null', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', null));
    assert.strictEqual(obs.getINP().attribution.target, null);
    obs.destroy();
});

test('internTarget: undefined target (field omitted entirely) -> sentinel -> attribution.target is null', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12)); // no target field at all
    assert.strictEqual(obs.getINP().attribution.target, null);
    obs.destroy();
});

test('internTarget: repeat target (same node identity) returns the cached id -- no re-describe', () => {
    const { obs, cb } = freshObserver();
    const node = { tagName: 'BUTTON', id: 'first' };
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', node));
    // Mutate the SAME node identity after the first intern, then re-feed it as
    // the new worst. A wrong impl that re-describes on every hit would surface
    // the mutated id; the shipped impl must return the FIRST description.
    node.id = 'mutated-should-not-appear';
    feed(cb, mkEntry(2, 500, 10, 12, 60, 'pointerup', node));
    const t = obs.getINP().attribution.target;
    assert.equal(t, 'button#first', 'cached FIRST description survives a repeat hit');
    assert.notEqual(t, 'button#mutated-should-not-appear');
    obs.destroy();
});

test('internTarget: sentinel (-1) never collides with a valid interned id 0', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'A', id: 'zero' })); // interns as id 0
    feed(cb, mkEntry(2, 500, 10, 12, 60, 'pointerup', null)); // new worst, sentinel
    assert.strictEqual(obs.getINP().attribution.target, null,
        'sentinel resolves to null, never falls through to index 0 ("a#zero") by accident');
    obs.destroy();
});

test('internTarget cap boundary: 0 distinct targets interned -> attribution.target is null (no target ever provided)', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12));
    assert.strictEqual(readAtHead(obs).attribution.target, null);
    obs.destroy();
});

test('internTarget cap boundary: 1st distinct target interns and resolves', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', { tagName: 'BUTTON', id: 'only' }));
    assert.equal(readAtHead(obs).attribution.target, 'button#only');
    obs.destroy();
});

test('internTarget cap boundary: N-1 = 127th distinct target (index 126) interns successfully', () => {
    const { obs, cb } = freshObserver();
    primeTargets(cb, 126, 100);
    feed(cb, mkEntry(9001, 9999, 500, 502, 552, 'pointerup', { tagName: 'SPAN', id: 'boundary127' }));
    assert.equal(readAtHead(obs).attribution.target, 'span#boundary127',
        '127th distinct target is index 126, strictly under the 128 cap');
    obs.destroy();
});

test('internTarget cap boundary: N = 128th distinct target (index 127, last one that fits) interns successfully', () => {
    const { obs, cb } = freshObserver();
    primeTargets(cb, 127, 100);
    feed(cb, mkEntry(9001, 9999, 500, 502, 552, 'pointerup', { tagName: 'SPAN', id: 'boundary128' }));
    assert.equal(readAtHead(obs).attribution.target, 'span#boundary128',
        '128th distinct target is index 127, exactly the last id the cap admits');
    obs.destroy();
});

test('internTarget cap boundary: N+1 = 129th distinct target is OVER the cap -> fails closed to null', () => {
    const { obs, cb } = freshObserver();
    primeTargets(cb, 128, 100); // fills the cap completely: indices 0..127
    feed(cb, mkEntry(9001, 9999, 500, 502, 552, 'pointerup', { tagName: 'SPAN', id: 'boundary129' }));
    assert.strictEqual(readAtHead(obs).attribution.target, null,
        '129th distinct target is over the 128 cap: sentinel, never a wrong element');
    obs.destroy();
});

test('internTarget cap boundary: once over cap, FURTHER distinct targets keep failing closed (not a one-shot fluke)', () => {
    const { obs, cb } = freshObserver();
    primeTargets(cb, 128, 100);
    feed(cb, mkEntry(9001, 1000, 500, 502, 552, 'pointerup', { tagName: 'SPAN', id: 'over-a' }));
    feed(cb, mkEntry(9002, 2000, 600, 602, 652, 'pointerup', { tagName: 'SPAN', id: 'over-b' }));
    feed(cb, mkEntry(9003, 3000, 700, 702, 752, 'pointerup', { tagName: 'SPAN', id: 'over-c' }));
    assert.strictEqual(readAtHead(obs).attribution.target, null, 'repeated over-cap targets keep failing closed');
    obs.destroy();
});

// =============================================================================
// 2. resolveTarget fail-closed
// =============================================================================

test('resolveTarget: empty description (no tagName) -> null, not the empty string', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', { id: 'no-tagname' }));
    const t = obs.getINP().attribution.target;
    assert.strictEqual(t, null, 'a target with no usable tag name fails closed to null, not ""');
    assert.notEqual(t, '', 'must not leak the raw empty description string');
    obs.destroy();
});

test('resolveTarget: tagName that is not a string -> empty description -> null', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', { tagName: 123, id: 'weird' }));
    assert.strictEqual(obs.getINP().attribution.target, null);
    obs.destroy();
});

test('resolveTarget: valid id resolves to tag#id form when id is present', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'card-9' }));
    assert.equal(obs.getINP().attribution.target, 'div#card-9');
    obs.destroy();
});

test('resolveTarget: valid id resolves to tag.class form (FIRST class only) when no id but className present', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'DIV', className: 'foo bar baz' }));
    assert.equal(obs.getINP().attribution.target, 'div.foo', 'only the first class token, never the full class list');
    obs.destroy();
});

test('resolveTarget: valid id resolves to bare tag when neither id nor className is present', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'SPAN' }));
    assert.equal(obs.getINP().attribution.target, 'span');
    obs.destroy();
});

test('resolveTarget: id present but empty string -> falls through to className, not tag#""', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: '', className: 'onlyclass' }));
    assert.equal(obs.getINP().attribution.target, 'div.onlyclass');
    obs.destroy();
});

// =============================================================================
// 3. collectLoafs correctness
// =============================================================================

test('collectLoafs: overlaps the UNQUANTIZED processing window, not the full duration -- excludes a LoAF that only overlaps the wider [startTime, startTime+duration) window', () => {
    const { obs, cb, loafCb } = freshObserver();
    // processing-dominated: inputDelay=10, processingTime=4, presentationDelay=1
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup'));
    feedLoafs(loafCb, [
        mkLoaf(2, 4),  // [2,6): inside the FULL window [0,15) but NOT inside [10,14)
        mkLoaf(11, 2), // [11,13): inside the processing window -- the true positive
    ]);
    const attr = obs.getINP().attribution;
    assert.equal(attr.phase, 'processing');
    assert.equal(attr.loafs.length, 1, 'the full-duration-only overlap must be excluded');
    assert.equal(attr.loafs[0].startTime, 11, 'the processing-window overlap is the one that survives');
    obs.destroy();
});

test('collectLoafs: window boundary is EXCLUSIVE -- a LoAF touching exactly processingStart or processingEnd is excluded', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup')); // window [10,14)
    feedLoafs(loafCb, [
        mkLoaf(14, 6), // [14,20): touches exactly at processingEnd
        mkLoaf(4, 6),  // [4,10): touches exactly at processingStart
    ]);
    assert.equal(obs.getINP().attribution.loafs.length, 0, 'exact-touch boundaries must not count as overlap');
    obs.destroy();
});

test('collectLoafs: window boundary INCLUSION just past exact touch is included (proves the exclusion above is a real boundary, not a broken window)', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup')); // window [10,14)
    feedLoafs(loafCb, [
        mkLoaf(13.9, 6), // [13.9,19.9): overlaps by 0.1ms just before processingEnd
    ]);
    const attr = obs.getINP().attribution;
    assert.equal(attr.loafs.length, 1);
    assert.equal(attr.loafs[0].startTime, 13.9);
    obs.destroy();
});

test('collectLoafs: collects at most LOAF_MATCH_CAP=4, earliest-start first -- NOT a best-overlap pick', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 200, 0, 0, 100, 'pointerup')); // wide processing window [0,100)
    feedLoafs(loafCb, [
        mkLoaf(0, 5), mkLoaf(10, 5), mkLoaf(20, 5), mkLoaf(30, 5),
        mkLoaf(45, 1000), // huge overlap, but arrives 5th -- must be dropped despite being the "best" overlap
        mkLoaf(50, 5),
    ]);
    const attr = obs.getINP().attribution;
    assert.equal(attr.loafs.length, 4, 'capped at LOAF_MATCH_CAP');
    assert.deepEqual(attr.loafs.map((l) => l.startTime), [0, 10, 20, 30],
        'earliest-start tie-break: the 5th (huge-overlap) and 6th LoAFs are dropped despite arriving after the cap fills');
    obs.destroy();
});

test('collectLoafs: zero overlaps -> loafs is an empty array, not null/undefined', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup')); // window [10,14)
    feedLoafs(loafCb, [mkLoaf(100, 10)]); // entirely disjoint
    const attr = obs.getINP().attribution;
    assert.ok(Array.isArray(attr.loafs), 'loafs must be a real array');
    assert.equal(attr.loafs.length, 0);
    assert.notEqual(attr.loafs, null);
    obs.destroy();
});

test('collectLoafs: presentation phase correlates against the style/layout segment, not the full frame start -- excludes a LoAF whose style segment lands past the window', () => {
    const { obs, cb, loafCb } = freshObserver();
    // presentation-dominated: inputDelay=1, processingTime=2, presentationDelay=17>2.
    // presentation window = [processingEnd=3, interEnd=start+dur=20) = [3,20).
    feed(cb, mkEntry(1, 20, 0, 1, 3, 'pointerup'));
    // Frame [2,27) fully covers the window using its FULL start (would be
    // included under a naive full-frame rule), but its style/layout segment
    // starts at 21 -- past the window end (20) -- so the style-seg rule excludes it.
    feedLoafs(loafCb, [mkLoaf(2, 25, 21)]);
    const attr = obs.getINP().attribution;
    assert.equal(attr.phase, 'presentation');
    assert.equal(attr.loafs.length, 0,
        'style/layout segment (starts at 21) is used, not the frame start (2) -- correctly excluded');
    obs.destroy();
});

test('collectLoafs: presentation phase falls back to the frame start when styleAndLayoutStart is 0 (unavailable)', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 20, 0, 1, 3, 'pointerup')); // same presentation window [3,20)
    feedLoafs(loafCb, [mkLoaf(2, 25, 0)]); // styleAndLayoutStart=0 -> falls back to lStart=2
    const attr = obs.getINP().attribution;
    assert.equal(attr.phase, 'presentation');
    assert.equal(attr.loafs.length, 1, 'falls back to frame start and is included');
    assert.equal(attr.loafs[0].startTime, 2);
    obs.destroy();
});

test('collectLoafs: processing phase ignores styleAndLayoutStart entirely -- a LoAF excluded under style-seg rules is still evaluated by full frame start', () => {
    const { obs, cb, loafCb } = freshObserver();
    // processing-dominated: inputDelay=10, processingTime=4, presentationDelay=1 (<=4)
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup')); // processing window [10,14)
    // styleAndLayoutStart(=13, inside window) is irrelevant here; the frame's
    // OWN start (11) is what collectLoafs uses for processing phase.
    feedLoafs(loafCb, [mkLoaf(11, 2, 13)]); // [11,13), overlaps [10,14)
    const attr = obs.getINP().attribution;
    assert.equal(attr.phase, 'processing');
    assert.equal(attr.loafs.length, 1, 'processing phase uses the frame start regardless of styleAndLayoutStart');
    obs.destroy();
});

test('collectLoafs: NaN LoAF duration fails closed to excluded, no throw, no NaN leaking into the result', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup'));
    feedLoafs(loafCb, [mkLoaf(11, NaN)]);
    let attr;
    assert.doesNotThrow(() => { attr = obs.getINP().attribution; });
    assert.equal(attr.loafs.length, 0, 'a NaN-duration LoAF can never satisfy the overlap comparison -- excluded');
    obs.destroy();
});

test('collectLoafs: -0 LoAF duration (zero-width frame) fails closed to excluded, no throw', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup'));
    feedLoafs(loafCb, [mkLoaf(12, -0)]); // lEnd = 12 + (-0) = 12, zero-width
    let attr;
    assert.doesNotThrow(() => { attr = obs.getINP().attribution; });
    assert.equal(attr.loafs.length, 0, 'a zero-width frame has no positive overlap under the strict > rule');
    obs.destroy();
});

// =============================================================================
// 4. pickPhase
// =============================================================================

test('pickPhase: presentationDelay > processingTime -> presentation-dominated', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 100, 0, 2, 12, 'pointerup')); // inputDelay=2, processingTime=10, presDelay=88
    assert.equal(obs.getINP().attribution.phase, 'presentation');
    obs.destroy();
});

test('pickPhase: presentationDelay < processingTime -> processing-dominated', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 20, 0, 2, 12, 'pointerup')); // inputDelay=2, processingTime=10, presDelay=8
    assert.equal(obs.getINP().attribution.phase, 'processing');
    obs.destroy();
});

test('pickPhase: EXACT tie (presentationDelay === processingTime) defaults to processing (fail-closed, strict >)', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 22, 0, 2, 12, 'pointerup')); // inputDelay=2, processingTime=10, presDelay=10
    assert.equal(obs.getINP().attribution.phase, 'processing',
        'a wrong impl using >= would report presentation on an exact tie');
    obs.destroy();
});

test('pickPhase: presentationDelay clamped to 0 (negative raw value) never reports presentation', () => {
    const { obs, cb } = freshObserver();
    // processingStart-startTime + processingEnd-processingStart > duration -> raw
    // presentationDelay negative; the hot path clamps iPresentationDelay to 0.
    feed(cb, mkEntry(1, 5, 0, 2, 20, 'pointerup')); // inputDelay=2, processingTime=18, dur=5 -> raw presDelay=-15 -> clamped 0
    assert.equal(obs.getINP().attribution.phase, 'processing', '0 is never > processingTime(18)');
    obs.destroy();
});

// =============================================================================
// 5. buildAttribution shape (matches Inp.d.ts InpAttribution)
// =============================================================================

test('buildAttribution: shape is exactly { loafs, target, phase } with correct types', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup', { tagName: 'BUTTON', id: 'shape' }));
    feedLoafs(loafCb, [mkLoaf(2, 8)]);
    const attr = obs.getINP().attribution;
    assert.deepEqual(Object.keys(attr).sort(), ['loafs', 'phase', 'target']);
    assert.ok(Array.isArray(attr.loafs));
    assert.ok(attr.target === null || typeof attr.target === 'string');
    assert.ok(attr.phase === 'processing' || attr.phase === 'presentation');
    obs.destroy();
});

test('buildAttribution: AttributedLoaf entries have the full Inp.d.ts shape (startTime, duration, blockingDuration, styleAndLayoutStart, scripts[])', () => {
    const { obs, cb, loafCb } = freshObserver();
    feed(cb, mkEntry(1, 15, 0, 10, 14, 'pointerup'));
    feedLoafs(loafCb, [mkLoaf(11, 2, 5, [{ invoker: 'x', sourceURL: 'y.js', sourceFunctionName: 'z', duration: 2 }])]);
    const loaf = obs.getINP().attribution.loafs[0];
    assert.equal(loaf.startTime, 11);
    assert.equal(loaf.duration, 2);
    assert.equal(loaf.blockingDuration, 0);
    assert.equal(loaf.styleAndLayoutStart, 5);
    assert.equal(loaf.scripts.length, 1);
    assert.equal(loaf.scripts[0].sourceFunctionName, 'z');
    obs.destroy();
});

test('buildAttribution: loafs is empty array (not null) when the observer has no LoAF entries at all', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 50, 0, 2, 12, 'pointerup'));
    const attr = obs.getINP().attribution;
    assert.ok(Array.isArray(attr.loafs));
    assert.equal(attr.loafs.length, 0);
    obs.destroy();
});

// =============================================================================
// 6. resetState/destroy -- target-intern portion
// =============================================================================

test('resetState: intern map + string table + targetCount fully cleared -- the 128 cap is LIFTED after a bfcache reset', () => {
    const { obs, cb } = freshObserver();
    primeTargets(cb, 128, 100); // fill the cap
    feed(cb, mkEntry(9001, 9999, 500, 502, 552, 'pointerup', { tagName: 'SPAN', id: 'pre-reset-over-cap' }));
    assert.strictEqual(readAtHead(obs).attribution.target, null, 'sanity: cap is full pre-reset');

    mockWindow.dispatch('pageshow', { persisted: true }); // resetState()

    feed(cb, mkEntry(7001, 12345, 0, 2, 12, 'pointerup', { tagName: 'BUTTON', id: 'fresh-after-reset' }));
    assert.equal(obs.getINP().attribution.target, 'button#fresh-after-reset',
        'a fresh distinct target interns successfully post-reset -- the cap was truly lifted, not merely one slot freed');
    obs.destroy();
});

test('resetState: a target interned before reset does NOT survive -- the same node identity is re-described fresh (no stale WeakMap entry)', () => {
    const { obs, cb } = freshObserver();
    const node = { tagName: 'A', id: 'before-reset' };
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', node));
    assert.equal(obs.getINP().attribution.target, 'a#before-reset', 'sanity: interned pre-reset');

    mockWindow.dispatch('pageshow', { persisted: true }); // resetState()

    node.id = 'after-reset-mutated'; // mutate the SAME node identity
    feed(cb, mkEntry(2, 500, 0, 2, 12, 'pointerup', node));
    assert.equal(obs.getINP().attribution.target, 'a#after-reset-mutated',
        'a fresh WeakMap re-describes the SAME node identity post-reset -- proves the old cached id/string does not survive');
    obs.destroy();
});

test('resetState: getINP() and its attribution are null immediately after reset, with no target machinery leaking through', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'x' }));
    assert.notEqual(obs.getINP(), null, 'sanity: populated pre-reset');

    mockWindow.dispatch('pageshow', { persisted: true });

    assert.equal(obs.getINP(), null, 'getINP() is null post-reset, so there is no attribution object to inspect at all');
    obs.destroy();
});

test('destroy(): duplicate dispose after target intern is populated fails closed repeatedly, never throws', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'x' }));
    assert.notEqual(obs.getINP(), null, 'sanity: populated pre-dispose');

    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());

    assert.equal(obs.getINP(), null, 'getINP() fails closed after repeated destroy()');
});

// =============================================================================
// 7. INP value unchanged -- IN2 must not move the number
// =============================================================================

test('INP value unchanged: the IN1 mixed-sequence scenario reports the SAME duration with attribution now attached', () => {
    const { obs, cb } = freshObserver();
    // Same sequence/expected worst (900) as inp.in1.boundary.test.mjs's invariant test.
    const durations = [50, 900, 20, 700, 10, 10, 850, 5, 5, 5, 600, 400, 1];
    for (let i = 0; i < durations.length; i++) {
        feed(cb, mkEntry(i + 1, durations[i], i, i + 1, i + 1 + durations[i] * 0.3, 'pointerup', { tagName: 'DIV', id: 'n' + i }));
    }
    assert.equal(obs.worstDuration, 900, 'IN2 must not move worstDuration');
    const entry = obs.getINP();
    assert.equal(entry.duration, obs.inp, 'obs.inp === getINP().duration, exactly like IN1');
    assert.notEqual(entry.attribution, null, 'attribution is now populated (the IN2 addition)');
    obs.destroy();
});

test('INP value unchanged: a /50 skip-boundary crossing (from inp.in1) still selects the correct duration with targets on every slot', () => {
    const { obs, cb } = freshObserver();
    // DESC [990..900], 10 distinct targets, mirroring IN1's no-delivery-regression fixture.
    for (let k = 1; k <= 10; k++) {
        feed(cb, mkEntry(k, 1000 - k * 10, k, k + 1, k + 1 + 2, 'pointerup', { tagName: 'DIV', id: 't' + k }));
    }
    performance.interactionCount = 100; // skip = floor(100/50) = 2 -> 3rd-longest = 970
    const canonical = obs.getINP();
    delete performance.interactionCount;
    assert.equal(canonical.duration, 970, 'the value is untouched by IN2 -- same as IN1');
    assert.equal(canonical.attribution.target, 'div#t3', 'and the attribution now correctly names the 3rd interaction (970 = k=3)');
    obs.destroy();
});

// =============================================================================
// 8. Dispose-during-iteration (IN2 surface: target intern reset mid-batch)
// =============================================================================

test('dispose-during-iteration: destroy() called mid-batch resets target intern state, so only post-reset entries have a resolvable target', () => {
    let firedOnce = false;
    let obsRef = null;
    const obs = createInpObserver({
        onUpdate: () => {
            if (!firedOnce) { firedOnce = true; obsRef.destroy(); }
        }
    });
    obsRef = obs;
    const cb = capturedEventCb;

    const batch = [
        mkEntry(1, 500, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'wiped-by-reset' }), // triggers the mid-batch destroy()
        mkEntry(2, 10, 1, 3, 4, 'pointerup', { tagName: 'SPAN', id: 'a' }),
        mkEntry(3, 300, 2, 4, 20, 'pointerup', { tagName: 'BUTTON', id: 'survivor' }),
    ];
    assert.doesNotThrow(() => feedBatch(cb, batch));

    const entry = obs.getINP();
    assert.notEqual(entry, null, 'entries 2 and 3 were processed against the fresh post-reset state');
    assert.equal(entry.duration, 300, 'the max of the surviving entries (10 and 300), matching IN1\'s dispose-during-iteration proof');
    assert.equal(entry.attribution.target, 'button#survivor', 'attribution reflects only the post-reset target intern table');

    assert.doesNotThrow(() => obs.destroy());
    assert.equal(obs.getINP(), null);
});

// =============================================================================
// 9. Re-entrant write (IN2 surface: attribution read mid-callback, then a
//    re-entrant feed with a DIFFERENT target lands before the callback returns)
// =============================================================================

test('re-entrant write: attribution read from inside onUpdate is unaffected by a synchronous re-entrant feed with a different target', () => {
    let reentered = false;
    let cbRef = null;
    let targetSeenImmediately = null;
    let targetSeenAfterReentry = null;

    const obs = createInpObserver({
        onUpdate: () => {
            if (!reentered) {
                reentered = true;
                targetSeenImmediately = obs.getINP().attribution.target;
                cbRef({ getEntries: () => [mkEntry(999, 5000, 100, 102, 152, 'pointerup', { tagName: 'DIV', id: 'reentrant' })] });
                targetSeenAfterReentry = obs.getINP().attribution.target;
            }
        }
    });
    cbRef = capturedEventCb;

    assert.doesNotThrow(() => cbRef({ getEntries: () => [mkEntry(1, 100, 0, 2, 12, 'pointerup', { tagName: 'SPAN', id: 'first' })] }));

    assert.equal(targetSeenImmediately, 'span#first', 'read before the reentrant write reflects the interaction being processed');
    assert.equal(targetSeenAfterReentry, 'div#reentrant', 'read after the reentrant write reflects it immediately (live recompute, no stale attribution cache)');
    assert.equal(obs.getINP().attribution.target, 'div#reentrant', 'final state after both interactions');
    obs.destroy();
});

// =============================================================================
// 10. Adversarial: a non-Node (primitive) target -- an input the platform
//     never actually sends (Event Timing's target is always a Node or null),
//     but a hot-path throw would abandon the rest of the PerformanceObserver
//     batch (silent metric loss). internTarget's top guard fails closed on ANY
//     non-object (and null): a primitive target resolves to the sentinel (null)
//     and NEVER reaches WeakMap.set, so no throw, no batch abandonment.
//     These tests have teeth: they FAIL against the old unguarded (throwing)
//     implementation and PASS against the guarded one.
// =============================================================================

test('adversarial: a primitive (non-object) target FAILS CLOSED to the sentinel -- internTarget does not throw', () => {
    const { obs, cb } = freshObserver();
    // TEETH: the old unguarded impl threw TypeError at WeakMap.set here.
    assert.doesNotThrow(
        () => feed(cb, mkEntry(1, 500, 0, 2, 12, 'pointerup', 'a-primitive-string-target')),
        'a primitive target must fail closed, not throw at WeakMap.set');
    assert.equal(obs.getINP().attribution.target, null,
        'a primitive target resolves to null (sentinel), never a wrong element (null is not zero)');
    obs.destroy();
});

test('adversarial: a primitive target mid-batch does NOT abandon the rest of the batch -- later legitimate entries in the SAME callback still register', () => {
    const { obs, cb } = freshObserver();
    const batch = [
        mkEntry(1, 300, 0, 2, 12, 'pointerup', 'primitive-oops'),   // fails closed, still registers
        mkEntry(2, 500, 5, 7, 17, 'pointerup', null),               // the real worst -- previously dropped
        mkEntry(3, 200, 10, 12, 22, 'pointerup', null),
    ];
    // TEETH: the old impl threw on entry 1 and abandoned entries 2/3.
    assert.doesNotThrow(() => feedBatch(cb, batch),
        'a primitive target no longer throws mid-batch');
    assert.equal(obs.interactionCount, 3,
        'all three entries registered -- none dropped by a mid-batch throw (old impl left this at 1)');
    assert.equal(obs.inp, 500,
        'the worst interaction (500) -- silently discarded when the primitive threw -- is now recorded');
    assert.equal(obs.getINP().attribution.target, null,
        'the worst entry (2) had a null target -> attribution.target is null');
    obs.destroy();
});

test('adversarial: every non-object target kind fails closed without throwing (number / boolean / string / function)', () => {
    const { obs, cb } = freshObserver();
    // number/boolean/string threw at WeakMap.set in the old impl (TEETH); a
    // function is a valid WeakMap key but never a real Event Timing target, so
    // failing it closed too is the safer, documented contract.
    const kinds = [42, true, 'str', function () {}];
    for (let i = 0; i < kinds.length; i++) {
        assert.doesNotThrow(
            () => feed(cb, mkEntry(i + 1, 100 + i, i, i + 2, i + 12, 'pointerup', kinds[i])),
            'non-object target kind #' + i + ' must fail closed, not throw');
    }
    assert.equal(obs.interactionCount, kinds.length, 'every non-object target still registered its interaction');
    // Skip is 0 for < 50 interactions, so getINP() is the worst = the last fed
    // (dur 103, the function target) -> its target fails closed to null.
    assert.equal(obs.getINP().attribution.target, null,
        'a function target (valid WeakMap key, never a real target) also fails closed to null');
    obs.destroy();
});

// =============================================================================
// 11. Boundary matrix leftovers for the numeric entry points touched by IN2:
//     -0 / NaN interactionId reaching internTarget's caller.
// =============================================================================

test('-0 interactionId is treated as falsy (no interaction) -- internTarget is never even reached, matching a real 0', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(-0, 500, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'should-not-intern' }));
    assert.equal(obs.getINP(), null, '-0 interactionId is falsy, so the entry is skipped entirely (the "!iid" guard)');
    obs.destroy();
});

test('NaN interactionId is treated as falsy (no interaction) -- skipped, no NaN slot corruption', () => {
    const { obs, cb } = freshObserver();
    feed(cb, mkEntry(NaN, 500, 0, 2, 12, 'pointerup', { tagName: 'DIV', id: 'should-not-intern' }));
    assert.equal(obs.getINP(), null, 'NaN is falsy, so "!iid" skips the entry before any target work happens');
    obs.destroy();
});
