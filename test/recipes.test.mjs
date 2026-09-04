// test/recipes.test.mjs -- node --test test/recipes.test.mjs
//
// Exercises the repo-only suite recipes (recipes/*.mjs) against the REAL
// installed peers -- @zakkster/lite-hud and @zakkster/lite-layout-profiler --
// using only APIs documented in each peer's shipped llms.txt. Node has no
// browser PerformanceObserver, so we install a mock BEFORE creating an observer
// and drive one real interaction through the captured Event-Timing callback,
// then run each recipe end to end.

import test from 'node:test';
import assert from 'node:assert/strict';

// --- mock the browser surfaces createInpObserver feature-detects -----------
let capturedEventCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) { if (opts.type === 'event') capturedEventCb = this._cb; }
    disconnect() { this._cb = null; }
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;

// A minimal EventTarget so the observer's pageshow/prerender listeners register.
class MockEventTarget {
    constructor() { this._l = new Map(); this.visibilityState = 'visible'; }
    addEventListener(type, fn) {
        let a = this._l.get(type);
        if (!a) { a = new Set(); this._l.set(type, a); }
        a.add(fn);
    }
    removeEventListener(type, fn) { const a = this._l.get(type); if (a) a.delete(fn); }
    dispatchEvent(ev) { const a = this._l.get(ev.type); if (a) for (const fn of a) fn(ev); }
    liveCount() { let n = 0; for (const a of this._l.values()) n += a.size; return n; }
}
globalThis.window = new MockEventTarget();
globalThis.document = new MockEventTarget();

const { createInpObserver } = await import('../Inp.js');
const { createInpHudBridge } = await import('../recipes/hud.mjs');
const { createInpBeacon } = await import('../recipes/beacon.mjs');
const { createInpLayoutCrossRef } = await import('../recipes/layout.mjs');
const { createHud } = await import('@zakkster/lite-hud');
const { createLayoutProfiler, VERSION: LP_VERSION } = await import('@zakkster/lite-layout-profiler');

// Feed one above-threshold interaction with a target through the real hot path.
function feedInteraction(obs, dur, id) {
    const el = { tagName: 'BUTTON', id: id || 'inject-sync' };
    capturedEventCb({ getEntries: function () {
        return [{
            interactionId: 1, duration: dur, startTime: 0,
            processingStart: 2, processingEnd: 2 + dur * 0.4,
            name: 'pointerup', target: el
        }];
    } });
}

test('hud recipe: getINPInto polls into a real lite-hud channel', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);        // headless: no mount -> no canvas needed
    const bridge = createInpHudBridge({ observer: obs, hud: hud, channel: 'inp' });

    // Before any interaction: fail closed, nothing pushed.
    assert.equal(bridge.poll(), false, 'poll returns false before any interaction');
    assert.equal(hud.inspect('inp'), null, 'no record pushed yet');

    feedInteraction(obs, 128);
    assert.equal(bridge.poll(), true, 'poll returns true once an INP exists');

    const rec = hud.inspect('inp');
    assert.ok(rec !== null, 'a record landed in the hud channel');
    assert.equal(rec.count, 1, 'exactly one record pushed');
    assert.equal(Math.round(rec.last.a), 128, 'the pushed value is the INP duration');

    bridge.stop();
    hud.destroy();
    obs.destroy();
});

test('beacon recipe: fires once, on hidden, with the INP payload', () => {
    const doc = new MockEventTarget();
    const obs = createInpObserver({ durationThreshold: 16 });
    const sends = [];
    const beacon = createInpBeacon({
        observer: obs,
        url: 'https://rum.example/inp',
        document: doc,
        sendBeacon: function (url, body) { sends.push({ url: url, body: body }); return true; }
    });
    beacon.start();

    // Hidden before any interaction: fail closed, no beacon.
    doc.visibilityState = 'hidden';
    doc.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(sends.length, 0, 'no beacon when there is no interaction to report');

    // Record an interaction, then hide again.
    doc.visibilityState = 'visible';
    feedInteraction(obs, 240, 'inject-sync');
    doc.visibilityState = 'hidden';
    doc.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(sends.length, 1, 'exactly one beacon on hide');

    const payload = JSON.parse(sends[0].body);
    assert.equal(sends[0].url, 'https://rum.example/inp');
    assert.equal(Math.round(payload.inp), 240, 'payload carries the INP duration');
    assert.equal(payload.target, 'button#inject-sync', 'payload names the attributed element');
    assert.ok(payload.phase === 'processing' || payload.phase === 'presentation', 'payload carries a phase');

    // A second hide must NOT double-report (INP is reported once).
    doc.visibilityState = 'visible';
    doc.dispatchEvent({ type: 'visibilitychange' });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(sends.length, 1, 'INP is reported at most once per page view');

    beacon.stop();
    obs.destroy();
});

test('layout recipe: cross-references INP against a real layout profiler', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const xref = createInpLayoutCrossRef({ observer: obs });

    // Sanity on the peer we are composing with.
    assert.equal(LP_VERSION, '1.7.0', 'exercising the installed lite-layout-profiler');

    feedInteraction(obs, 96);
    const r = xref.report();
    assert.equal(Math.round(r.inp), 96, 'report carries the INP');
    assert.ok(r.phase === 'processing' || r.phase === 'presentation', 'report carries the phase');
    assert.equal(typeof r.reflows, 'number', 'report carries a reflow count from the profiler');
    // Node forces no layout, so there are no reflows and nothing is a suspect.
    assert.equal(r.reflows, 0, 'no forced reflows in a headless Node run');
    assert.equal(r.presentationSuspect, false, 'nothing to suspect without reflows');

    xref.destroy();
    obs.destroy();
});

test('bridge/beacon/xref construction fails closed on missing wiring', () => {
    assert.throws(() => createInpHudBridge({}), /observer.*hud|required/i);
    assert.throws(() => createInpBeacon({ observer: {} }), /url|required/i);
    assert.throws(() => createInpLayoutCrossRef({}), /observer|required/i);
});
