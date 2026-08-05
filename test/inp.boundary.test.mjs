// test/inp.boundary.test.mjs -- node --test test/inp.boundary.test.mjs
//
// QA boundary suite for the IN-01 fix (longest-N page-lifetime SoA).
// Drives the REAL hot path (onEventEntry -> maintainLongest) and the REAL
// cold path (computeINP via obs.getINP()) through a mock global
// PerformanceObserver, exactly like test/gc.longest.mjs. No internal export
// added; nothing beyond the shipped public surface is touched.
//
// This suite intentionally does NOT modify Inp.js. Every assertion here is
// measured against the code as reviewer-approved. If any assertion below
// fails, that is a real behavioral defect to report, not a license to loosen
// the assertion.

import test from 'node:test';
import assert from 'node:assert/strict';

// --- mock global PerformanceObserver -------------------------------------
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

assert.equal(performance.interactionCount, undefined,
    'suite assumes no performance.interactionCount so the raw-iCount fallback is exercised, ' +
    'except where a test explicitly stubs it back out');

const { createInpObserver } = await import('../Inp.js');

// --- helpers ---------------------------------------------------------------

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

function mkLoafEntry(startTime, dur) {
    return {
        startTime: startTime,
        duration: dur,
        blockingDuration: dur * 0.5,
        styleAndLayoutStart: startTime + dur * 0.25,
        scripts: [
            { invoker: 'test-invoker', sourceURL: 'test.js', sourceFunctionName: 'fn', duration: dur }
        ]
    };
}

// Create a fresh observer and capture ITS event + LoAF callbacks (the mock
// only tracks the most recently observe()-d callback per type, so capture
// immediately after construction).
function freshObserver(opts) {
    const obs = createInpObserver(opts);
    const cb = capturedEventCb;
    const loafCb = capturedLoafCb;
    return { obs: obs, cb: cb, loafCb: loafCb };
}

function feedOne(cb, id, dur, startTime, name) {
    const e = mkEntry(id, dur, startTime, name);
    cb({ getEntries: () => [e] });
}

function feedOneLoaf(loafCb, startTime, dur) {
    const e = mkLoafEntry(startTime, dur);
    loafCb({ getEntries: () => [e] });
}

// =============================================================================
// 1. Zero / one -- fail-closed and single-element identity
// =============================================================================

test('boundary: 0 interactions -> getINP() === null (fail closed)', () => {
    const { obs } = freshObserver();
    assert.equal(obs.getINP(), null);
    assert.equal(obs.interactionCount, 0);
    obs.destroy();
});

test('boundary: 0 interactions, but observer WAS driven with an empty entries batch', () => {
    // "empty" entry point: getEntries() returns [] -- must not throw, must not
    // manufacture a phantom interaction.
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => cb({ getEntries: () => [] }));
    assert.equal(obs.getINP(), null);
    assert.equal(obs.interactionCount, 0);
    obs.destroy();
});

test('boundary: exactly 1 interaction -> getINP().duration equals it', () => {
    const { obs, cb } = freshObserver();
    feedOne(cb, 1, 77, 0);
    const entry = obs.getINP();
    assert.notEqual(entry, null);
    assert.equal(entry.duration, 77);
    assert.equal(entry.interactionId, 1);
    assert.equal(obs.interactionCount, 1);
    obs.destroy();
});

// =============================================================================
// 2. interactionCap ring: N-1 / N / N+1 unique interactions, tiny cap so the
//    IN-01 fix is exercised at the smallest possible scale (complements the
//    600-interaction/512-cap proof in test/gc.longest.mjs).
// =============================================================================

test('boundary: interactionCap N-1/N/N+1 -- eviction happens exactly at N+1, ' +
    'and getINP() survives the eviction of the longest interaction (IN-01, minimal scale)', () => {
    const CAP = 8; // pow2(8) === 8
    const { obs, cb } = freshObserver({ interactionCap: CAP });

    // interaction #1 is the longest ever seen; everything after it is short.
    feedOne(cb, 1, 1000, 0);
    for (let k = 2; k <= 7; k++) feedOne(cb, k, 10 + k, k); // interactions #2..#7

    // N-1 = 7 unique interactions fed. Ring not full yet; #1 still live.
    assert.equal(obs.interactionCount, 7, 'N-1: ring holds all 7, not yet full');
    assert.ok(obs.getInteractions().some((e) => e.interactionId === 1), 'N-1: interaction #1 still in the live ring');
    assert.equal(obs.getINP().duration, 1000, 'N-1: INP is still the live max');

    feedOne(cb, 8, 18, 8); // interaction #8 -> total = N = 8, ring exactly full

    assert.equal(obs.interactionCount, 8, 'N: ring exactly full, capped at CAP');
    assert.ok(obs.getInteractions().some((e) => e.interactionId === 1), 'N: interaction #1 still in the live ring (no eviction yet)');
    assert.equal(obs.getINP().duration, 1000, 'N: INP is still the live max');

    feedOne(cb, 9, 19, 9); // interaction #9 -> total = N+1 = 9, forces first eviction

    assert.equal(obs.interactionCount, 8, 'N+1: interactionCount stays capped at CAP');
    assert.ok(!obs.getInteractions().some((e) => e.interactionId === 1),
        'N+1: interaction #1 has been evicted from the recency ring');
    assert.equal(obs.getINP().duration, 1000,
        'N+1: getINP() still reports 1000 -- the longest-N SoA outlives the ring eviction (this is IN-01)');
    assert.equal(obs.getINP().interactionId, 1);

    obs.destroy();
});

// =============================================================================
// 3. Percentile skip index: 49 vs 50 vs 51 lifetime interactions
//    (skip = floor(lifetimeCount/50) must cross 0 -> 1 exactly between 49 and 50)
// =============================================================================

test('boundary: 49 vs 50 vs 51 interactions -- targetIdx moves off the max at exactly 50', () => {
    const { obs, cb } = freshObserver();
    // Feed strictly-descending durations so the first 10 fed ARE the longest-N
    // list, in fed order: dur(k) = 10000 - k for k = 0..N-1.
    for (let k = 0; k < 49; k++) feedOne(cb, k + 1, 10000 - k, k);

    // 49 interactions: skip = floor(49/50) = 0 -> targetIdx = 0 -> the max.
    assert.equal(obs.getINP().duration, 10000, '49: skip=0, INP is the outright max');

    feedOne(cb, 50, 10000 - 49, 49); // 50th interaction

    // 50 interactions: skip = floor(50/50) = 1 -> targetIdx = 1 -> 2nd longest.
    assert.equal(obs.getINP().duration, 9999, '50: skip=1, INP is the 2nd longest');

    feedOne(cb, 51, 10000 - 50, 50); // 51st interaction

    // 51 interactions: skip = floor(51/50) = 1 -> targetIdx STILL 1 (floor plateau).
    assert.equal(obs.getINP().duration, 9999, '51: skip still 1 (floor plateau) -- same as 50, not a bug');

    obs.destroy();
});

// =============================================================================
// 4. Rising duration across multiple events with the SAME interactionId
//    must hold the longest-N slot ONCE (dedup), never duplicate it.
// =============================================================================

test('boundary: rising duration for one interactionId is held once in longest-N (no duplicate slot)', () => {
    const { obs, cb } = freshObserver();

    // Fill longest-N to exactly LN_CAP=10 with 10 distinct interactions,
    // strictly descending durations 100..91 (ids 1..10). Tail = id 10, dur 91.
    for (let k = 1; k <= 10; k++) feedOne(cb, k, 101 - k, k);

    // Raise interaction id=1's duration via a SECOND event for the same id.
    // Correct behaviour: refresh id 1's stored copy in place and re-bubble;
    // longest-N stays at 10 entries, tail is untouched (still id 10, dur 91).
    feedOne(cb, 1, 150, 100);

    // Now feed a genuinely NEW interaction whose duration (91.5) beats the
    // TRUE tail (91) but would be rejected if the rise above had instead
    // fallen through to the "insert new slot" branch (a phantom duplicate of
    // id 1 sitting at the tail with some stale value >= 91.5, which would
    // wrongly reject this insert).
    feedOne(cb, 11, 91.5, 200);

    // Read rank 9 (the tail of a full 10-element list) by forcing skip=9 via
    // performance.interactionCount, independent of the real lifetime count.
    performance.interactionCount = 450; // floor(450/50) = 9
    const tail = obs.getINP();
    delete performance.interactionCount;

    assert.equal(tail.duration, 91.5,
        'the true tail (91, id 10) was correctly displaced by the new interaction, proving id 1 ' +
        'occupies exactly one longest-N slot after its duration rose');
    assert.equal(tail.interactionId, 11);

    // And rank 0 reflects the raised value, not the original 100.
    performance.interactionCount = 0;
    const head = obs.getINP();
    delete performance.interactionCount;
    assert.equal(head.duration, 150, 'rank 0 reflects the RAISED duration for id 1');
    assert.equal(head.interactionId, 1);

    obs.destroy();
});

// =============================================================================
// 5. Tie at the tail of a full longest-N list is DROPPED (strict >), matching
//    web-vitals semantics.
// =============================================================================

test('boundary: a tie at the tail of a full longest-N list is dropped (strict >)', () => {
    const { obs, cb } = freshObserver();
    // Fill to exactly 10, strictly descending, tail = id 10, dur 91.
    for (let k = 1; k <= 10; k++) feedOne(cb, k, 101 - k, k);

    // A brand-new interaction with duration EQUAL to the tail (91) must be
    // rejected (dur > tail required, not >=).
    feedOne(cb, 11, 91, 200);

    performance.interactionCount = 450; // rank 9 (tail)
    const tailAfterTie = obs.getINP();
    delete performance.interactionCount;
    assert.equal(tailAfterTie.duration, 91, 'tie duration does not displace the tail');
    assert.equal(tailAfterTie.interactionId, 10, 'the ORIGINAL tail interaction is retained, not the tied newcomer');

    // Positive control: a strictly-greater duration DOES displace the tail.
    feedOne(cb, 12, 91.001, 201);
    performance.interactionCount = 450;
    const tailAfterGreater = obs.getINP();
    delete performance.interactionCount;
    assert.equal(tailAfterGreater.duration, 91.001, 'strictly greater duration displaces the tail');
    assert.equal(tailAfterGreater.interactionId, 12);

    obs.destroy();
});

// =============================================================================
// 6. More than 10 large interactions -> only the 10 longest retained,
//    correctly ordered (ascending feed order to exercise real displacement).
// =============================================================================

test('boundary: more than 10 large interactions -> only the 10 longest retained, correctly ordered', () => {
    const { obs, cb } = freshObserver();
    // 15 distinct interactions fed in ASCENDING duration order (200..214),
    // ids 1..15, so every later feed must displace the current tail.
    for (let i = 0; i < 15; i++) feedOne(cb, i + 1, 200 + i, i);

    // Expected retained set: durations 205..214 (the 10 largest), descending.
    const expectedDesc = [214, 213, 212, 211, 210, 209, 208, 207, 206, 205];
    for (let rank = 0; rank < 10; rank++) {
        performance.interactionCount = rank * 50; // floor(rank*50/50) === rank
        const at = obs.getINP();
        delete performance.interactionCount;
        assert.equal(at.duration, expectedDesc[rank], 'rank ' + rank + ' should be ' + expectedDesc[rank]);
    }

    // The 5 smallest (200..204) must NOT be reachable at all -- rank 9 (last
    // possible index, since lnCount caps at 10) is the smallest RETAINED
    // value 205, never 204 or below.
    performance.interactionCount = 9999; // skip clamps to lnCount-1 = 9
    const clamped = obs.getINP();
    delete performance.interactionCount;
    assert.equal(clamped.duration, 205, 'skip clamps to the last retained rank, never falls through to an evicted value');

    obs.destroy();
});

// =============================================================================
// 7. Duplicate dispose
// =============================================================================

test('boundary: duplicate dispose is idempotent and fails closed (all state reset) -- ' +
    'proven against POPULATED state, not the Node no-support default', () => {
    const { obs, cb, loafCb } = freshObserver();

    // Populate every piece of state destroy() is responsible for resetting:
    // two interactions (so interactionCount, currentINP, and the longest-N
    // list all have real content) and one LoAF entry (so loafCount/getLoafs
    // and LoAF attribution have real content too).
    feedOne(cb, 1, 42, 0);
    feedOne(cb, 2, 17, 5);
    feedOneLoaf(loafCb, 0, 30);

    // --- BEFORE destroy(): every getter must reflect the populated state.
    // If destroy() were a no-op, every one of these assertions would still
    // hold after destroy() too -- which is exactly what the AFTER block
    // below checks does NOT happen.
    assert.notEqual(obs.getINP(), null, 'sanity: getINP() is non-null before destroy()');
    assert.equal(obs.getINP().duration, 42, 'sanity: getINP() reflects the worst interaction before destroy()');
    assert.equal(obs.interactionCount, 2, 'sanity: interactionCount > 0 before destroy()');
    assert.equal(obs.currentINP, 42, 'sanity: currentINP reflects the worst duration before destroy()');
    assert.equal(obs.getInteractions().length, 2, 'sanity: getInteractions() reflects data before destroy()');
    assert.equal(obs.getLoafs().length, 1, 'sanity: getLoafs() reflects data before destroy()');
    assert.equal(obs.getLoafs()[0].duration, 30, 'sanity: getLoafs() content is correct before destroy()');

    // destroy() now resets ALL state (IN-06): post-destroy getters must fail
    // closed rather than return stale data. This proof CAN fail: state is
    // genuinely populated above via the mock observer, so if the reset lines
    // in destroy() were removed, every assertion below would fail (getINP()
    // would still return the entry with duration 42, interactionCount would
    // still be 2, etc).
    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());
    assert.doesNotThrow(() => obs.destroy());

    // --- AFTER destroy(): fail-closed across every reset field.
    assert.equal(obs.getINP(), null, 'getINP() fails closed after destroy()');
    assert.equal(obs.interactionCount, 0, 'interactionCount reset after destroy()');
    assert.equal(obs.currentINP, 0, 'currentINP reset after destroy()');
    assert.equal(obs.getInteractions().length, 0, 'getInteractions() empty after destroy()');
    assert.equal(obs.getLoafs().length, 0, 'getLoafs() empty after destroy()');
});

// =============================================================================
// 8. Dispose-during-iteration: destroy() called from inside onUpdate, mid-way
//    through a multi-entry PerformanceObserver callback batch.
// =============================================================================

test('boundary: dispose-during-iteration does not truncate the remaining entries in the same batch', () => {
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

    // The batch loop is not truncated by the mid-iteration destroy() --
    // onEventEntry does not consult observer-lifecycle state mid-loop, so
    // entries 2 and 3 are still processed after entry 1 triggers destroy().
    // But destroy() now resets ALL state (IN-06): entry 1's data (which
    // fired the reset) is wiped, and only the two entries recorded after the
    // reset remain. This is the deliberate fail-closed consequence.
    assert.equal(obs.interactionCount, 2, 'entries 2 and 3 recorded after the mid-loop reset; entry 1 was wiped');
    assert.equal(obs.getINP().duration, 20, 'INP reflects only the post-reset entries (max of 10 and 20)');

    // Duplicate dispose after a mid-iteration dispose is still safe and
    // re-fails-closed.
    assert.doesNotThrow(() => obs.destroy());
    assert.equal(obs.getINP(), null, 'getINP() fails closed after the final destroy()');
});

// =============================================================================
// 9. Re-entrant write: onUpdate calls back into the observer's own event
//    callback synchronously, before the outer invocation returns.
// =============================================================================

test('boundary: re-entrant write from inside onUpdate does not corrupt state, ' +
    'and documents the reused-entry-object aliasing hazard', () => {
    let reentered = false;
    let capturedRef = null;
    let durationSeenImmediately = null;
    let durationSeenAfterReentry = null;
    let cb2 = null;

    const obs2 = createInpObserver({
        onUpdate: (entry) => {
            if (!reentered) {
                reentered = true;
                capturedRef = entry;
                durationSeenImmediately = entry.duration; // captured BEFORE the reentrant call
                // Re-entrant write: feed another, larger interaction from
                // inside the callback that is still processing the first one.
                cb2({ getEntries: () => [mkEntry(999, 5000, 100)] });
                // The entry object is documented as reused across calls
                // (see Inp.js onUpdate JSDoc): reading it again AFTER the
                // reentrant call must reflect the reentrant call's data.
                durationSeenAfterReentry = capturedRef.duration;
            }
        }
    });
    cb2 = capturedEventCb;

    assert.doesNotThrow(() => cb2({ getEntries: () => [mkEntry(1, 100, 0)] }));

    assert.equal(durationSeenImmediately, 100, 'primitives read synchronously before reentry are correct');
    assert.equal(durationSeenAfterReentry, 5000,
        'the SAME reused entry object was mutated in place by the reentrant call -- ' +
        'this is the documented zero-alloc aliasing contract, not corruption');
    assert.equal(capturedRef.duration, 5000, 'object identity confirms reuse: still the same reference, now showing the reentrant value');

    // State integrity after the reentrant write: both interactions were
    // actually recorded (no interaction lost/clobbered by the reentry).
    assert.equal(obs2.interactionCount, 2);
    assert.equal(obs2.getINP().duration, 5000, 'INP reflects the larger, re-entrantly-written interaction');

    // A SEPARATE (non-nested) subsequent call reuses the identical object
    // reference again, confirming the zero-alloc contract holds beyond the
    // reentrant case too.
    let secondCallRef = null;
    obs2.destroy();
    const obs3 = createInpObserver({
        onUpdate: (entry) => { secondCallRef = entry; }
    });
    const cb3 = capturedEventCb;
    cb3({ getEntries: () => [mkEntry(1, 10, 0)] });
    const firstRef = secondCallRef;
    cb3({ getEntries: () => [mkEntry(2, 20, 1)] });
    assert.equal(secondCallRef, firstRef, 'the reusable entry object is the SAME reference across separate (non-nested) onUpdate calls');
    assert.equal(secondCallRef.duration, 20);

    obs3.destroy();
});

// =============================================================================
// 10. null / undefined / NaN / -0 interactionId and duration inputs
// =============================================================================

test('boundary: interactionId === null is skipped (falsy -> non-interaction), no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, null, 999, 0));
    assert.equal(obs.interactionCount, 0);
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('boundary: interactionId === undefined is skipped (falsy -> non-interaction), no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, undefined, 999, 0));
    assert.equal(obs.interactionCount, 0);
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('boundary: interactionId === NaN is skipped (falsy -> non-interaction), no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, NaN, 999, 0));
    assert.equal(obs.interactionCount, 0);
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('boundary: interactionId === -0 is skipped (falsy, same as 0), no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, -0, 999, 0));
    assert.equal(obs.interactionCount, 0);
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('boundary: duration === NaN on a valid interactionId never wins the max comparison, no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, 1, NaN, 0));
    // The slot is created (interactionId is truthy), but `NaN > 0` is false,
    // so the interaction is never promoted into longest-N -- fail closed.
    assert.equal(obs.interactionCount, 1, 'a slot is allocated for the truthy id');
    assert.equal(obs.getINP(), null, 'an interaction whose duration never exceeds the comparison stays out of longest-N');
    obs.destroy();
});

test('boundary: duration === -0 on a valid interactionId never wins the max comparison (-0 > 0 is false), no throw', () => {
    const { obs, cb } = freshObserver();
    assert.doesNotThrow(() => feedOne(cb, 1, -0, 0));
    assert.equal(obs.interactionCount, 1);
    assert.equal(obs.getINP(), null, '-0 is not strictly greater than the initial 0, so it never enters longest-N');
    obs.destroy();
});

// =============================================================================
// 11. Adversarial case the planner did not think of: interactionCap === 1,
//     the smallest legal ring, exercising IN-01 at the absolute extreme
//     (every single new unique interaction evicts the previous one).
// =============================================================================

test('adversarial: interactionCap=1 -- IN-01 fix holds when the recency ring can hold only ONE live interaction', () => {
    const { obs, cb } = freshObserver({ interactionCap: 1 });

    feedOne(cb, 1, 900, 0);   // the longest interaction ever seen, live for one feed only
    feedOne(cb, 2, 10, 1);    // evicts #1 from the ring immediately
    feedOne(cb, 3, 20, 2);    // evicts #2
    feedOne(cb, 4, 15, 3);    // evicts #3

    assert.equal(obs.interactionCount, 1, 'ring can hold exactly 1 live interaction');
    assert.ok(!obs.getInteractions().some((e) => e.interactionId === 1), 'interaction #1 long gone from the ring');
    assert.equal(obs.getINP().duration, 900, 'longest-N still remembers the page-lifetime max despite a 1-slot ring');
    assert.equal(obs.getINP().interactionId, 1);

    obs.destroy();
});
