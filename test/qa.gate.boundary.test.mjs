// test/qa.gate.boundary.test.mjs -- node --test test/qa.gate.boundary.test.mjs
//
// INDEPENDENT QA boundary suite for the IN3 (v1.3.0) evaluation-kit gate.
// Discovered by `npm test` / `test:node` via the `test/*.test.mjs` glob (the
// original `.mjs` name did not match and so ran nowhere -- renamed to gate it).
//
// Covers every new Node-visible entry point from this session:
//   - test/browser/heappath.mjs   (sumSamples, sumObserverPath -- pure reducers)
//   - recipes/hud.mjs             (createInpHudBridge)
//   - recipes/beacon.mjs          (createInpBeacon)
//   - recipes/layout.mjs          (createInpLayoutCrossRef)
//   - test/browser/serve.mjs      (startStaticServer -- path resolution)
//
// Peers are the REAL installed devDependencies, per CLAUDE.md ("no test may
// import anything outside this package plus its peers"). node:test only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sumSamples, sumObserverPath, OBSERVER_FRAMES, DEMO_OBSERVER_FRAMES }
    from './browser/heappath.mjs';
import { startStaticServer } from './browser/serve.mjs';
import { runScenarios } from './browser/runner.mjs';

// ===========================================================================
// Shared mocks (same pattern as test/recipes.test.mjs / test/torture.mjs)
// ===========================================================================
let capturedEventCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) { if (opts.type === 'event') capturedEventCb = this._cb; }
    disconnect() { this._cb = null; }
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;

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
const { createLayoutProfiler } = await import('@zakkster/lite-layout-profiler');

function feedInteraction(dur, id) {
    const el = { tagName: 'BUTTON', id: id || 'inject-sync' };
    capturedEventCb({
        getEntries: () => [{
            interactionId: Math.floor(Math.random() * 1e9) + 1, duration: dur, startTime: 0,
            processingStart: 2, processingEnd: 2 + dur * 0.4, name: 'pointerup', target: el
        }]
    });
}

// ===========================================================================
// GROUP A -- test/browser/heappath.mjs pure reducers
// ===========================================================================

test('heappath.sumSamples: 0 samples -> 0', () => {
    assert.equal(sumSamples({ samples: [] }), 0);
});

test('heappath.sumSamples: 1 sample -> exact size', () => {
    assert.equal(sumSamples({ samples: [{ size: 42 }] }), 42);
});

test('heappath.sumSamples: N-1 / N / N+1 samples (N=10)', () => {
    for (const n of [9, 10, 11]) {
        const samples = Array.from({ length: n }, (_, i) => ({ size: 1 }));
        assert.equal(sumSamples({ samples }), n, 'n=' + n);
    }
});

test('heappath.sumSamples: empty profile object (no samples, no head) -> 0', () => {
    assert.equal(sumSamples({}), 0);
});

test('heappath.sumSamples: samples present but size undefined -> treated as 0', () => {
    assert.equal(sumSamples({ samples: [{}, { size: undefined }] }), 0);
});

test('heappath.sumSamples: NaN size does not poison the sum (falsy -> 0)', () => {
    const total = sumSamples({ samples: [{ size: 10 }, { size: NaN }, { size: 5 }] });
    assert.equal(total, 15, 'NaN must not propagate through the sum');
    assert.ok(!Number.isNaN(total));
});

test('heappath.sumSamples: -0 size does not corrupt the sum', () => {
    const total = sumSamples({ samples: [{ size: -0 }, { size: 3 }] });
    assert.equal(total, 3);
    assert.ok(!Object.is(total, -0), 'a lone -0 sample must not make the whole sum -0');
});

test('heappath.sumSamples: null head with no samples array -> 0 (fallback path)', () => {
    assert.equal(sumSamples({ head: null }), 0);
});

test('heappath.sumSamples: undefined profile argument throws (fail-closed, not a silent wrong answer)', () => {
    assert.throws(() => sumSamples(undefined), TypeError);
});

test('heappath.sumObserverPath: empty tree (head with no children) -> 0 for unknown frame', () => {
    const profile = { head: { callFrame: { functionName: 'unrelated' }, selfSize: 999 } };
    assert.equal(sumObserverPath(profile), 0);
});

test('heappath.sumObserverPath: null head -> 0', () => {
    assert.equal(sumObserverPath({ head: null }), 0);
});

test('heappath.sumObserverPath: undefined profile argument throws (fail-closed)', () => {
    assert.throws(() => sumObserverPath(undefined), TypeError);
});

test('heappath.sumObserverPath: N-1/N/N+1 sibling children, only matching frames counted', () => {
    for (const n of [9, 10, 11]) {
        const children = Array.from({ length: n }, (_, i) => ({
            callFrame: { functionName: i === 0 ? 'onUpdate' : 'noise' },
            selfSize: 100
        }));
        const profile = { head: { callFrame: { functionName: 'root' }, selfSize: 0, children } };
        assert.equal(sumObserverPath(profile), 100, 'n=' + n + ' only the one onUpdate frame counts');
    }
});

test('heappath.sumObserverPath: DEMO_OBSERVER_FRAMES excludes onEventEntry, OBSERVER_FRAMES includes it', () => {
    const profile = {
        head: {
            callFrame: { functionName: 'root' }, selfSize: 0,
            children: [{ callFrame: { functionName: 'onEventEntry' }, selfSize: 777 }]
        }
    };
    assert.equal(sumObserverPath(profile, OBSERVER_FRAMES), 777);
    assert.equal(sumObserverPath(profile, DEMO_OBSERVER_FRAMES), 0);
});

test('heappath.sumObserverPath: NaN selfSize does not poison the total (falsy -> 0)', () => {
    const profile = {
        head: {
            callFrame: { functionName: 'root' }, selfSize: 0,
            children: [
                { callFrame: { functionName: 'onUpdate' }, selfSize: NaN },
                { callFrame: { functionName: 'onUpdate' }, selfSize: 50 }
            ]
        }
    };
    const total = sumObserverPath(profile);
    assert.equal(total, 50);
    assert.ok(!Number.isNaN(total));
});

test('heappath.sumObserverPath ADVERSARIAL: cyclic children graph does not hang or crash the gate silently', () => {
    const node = { callFrame: { functionName: 'onUpdate' }, selfSize: 10, children: null };
    node.children = [node]; // node is its own child -- a malformed/cyclic profile
    const profile = { head: node };
    // The reducer has no cycle guard: a cyclic profile must fail LOUD (stack
    // overflow -> RangeError), never silently return a wrong finite number.
    // This is exactly the shape the gate needs to fail closed on: if a future
    // CDP quirk ever produces a self-referential frame, "sum comes back small
    // and the gate passes" would be worse than a crash.
    assert.throws(() => sumObserverPath(profile), RangeError,
        'a cyclic profile tree must surface as a loud stack-overflow, not a quiet wrong sum');
});

// ===========================================================================
// GROUP B -- recipes/hud.mjs (createInpHudBridge)
// ===========================================================================

test('hud bridge: intervalMs=0 falls back to the 1000ms default (0-as-falsy boundary)', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp0', intervalMs: 0 });
    let calls = 0;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms) => { calls++; assert.equal(ms, 1000, 'intervalMs:0 must not silently become 0ms'); return realSetInterval(fn, 1e9); };
    try {
        bridge.start();
        assert.equal(calls, 1);
    } finally {
        globalThis.setInterval = realSetInterval;
        bridge.stop();
        hud.destroy();
        obs.destroy();
    }
});

test('hud bridge: duplicate stop() is idempotent (no throw, no double-clear)', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp-dup-stop' });
    bridge.start(50);
    assert.doesNotThrow(() => { bridge.stop(); bridge.stop(); bridge.stop(); });
    hud.destroy();
    obs.destroy();
});

test('hud bridge: re-entrant start() (start while already started) leaves exactly one live timer', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp-reentrant' });
    const seen = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let liveTimers = 0;
    globalThis.setInterval = (fn, ms) => { liveTimers++; return realSetInterval(fn, 1e9); };
    globalThis.clearInterval = (h) => { liveTimers--; return realClearInterval(h); };
    try {
        bridge.start(10);
        bridge.start(10); // re-entrant: must clear the first timer, not stack a second
        bridge.start(10);
        assert.equal(liveTimers, 1, 'start() called 3x must leave exactly 1 live timer, not 3');
    } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        bridge.stop();
        hud.destroy();
        obs.destroy();
    }
});

test('hud bridge: re-entrant poll() (poll invoked from inside a push callback) does not corrupt the shared scratch', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp-reentrant-write' });
    feedInteraction(100);

    const ch = bridge.channel;
    const realPush = ch.push.bind(ch);
    let reentered = false;
    ch.push = function (v) {
        if (!reentered) {
            reentered = true;
            // Re-entrant write: call poll() again from inside the first poll's
            // own push -- the shared `scratch` object is being read from at this
            // exact moment by the caller (ch.push(scratch.duration) already
            // evaluated its argument, but this proves a second full poll cycle
            // mid-callback does not throw or leave scratch in a torn state).
            bridge.poll();
        }
        return realPush(v);
    };

    assert.doesNotThrow(() => bridge.poll());
    const rec = hud.inspect('inp-reentrant-write');
    assert.ok(rec !== null);
    assert.equal(Math.round(rec.last.a), 100, 're-entrant poll must not corrupt the pushed value');

    bridge.stop();
    hud.destroy();
    obs.destroy();
});

test('hud bridge: poll() after observer.destroy() fails closed (false, no throw) -- ADVERSARIAL', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp-post-destroy' });
    feedInteraction(50);
    assert.equal(bridge.poll(), true);
    obs.destroy(); // observer torn down out from under the still-live bridge
    assert.doesNotThrow(() => bridge.poll(),
        'polling a destroyed observer must fail closed, not throw');
    bridge.stop();
    hud.destroy();
});

// ===========================================================================
// GROUP B2 -- recipes/hud.mjs getINPInto poll: 0-alloc (assertion 4)
// ===========================================================================
// Measured independently with --expose-gc: run poll() HOT times against a
// warm observer and assert heapUsed does not grow beyond noise. This is my
// OWN measurement, not a restatement of the coder's number.
if (typeof globalThis.gc === 'function') {
    test('hud bridge: getINPInto poll is 0-alloc over 200000 calls (measured, --expose-gc)', () => {
        const obs = createInpObserver({ durationThreshold: 16 });
        const hud = createHud(null);
        const bridge = createInpHudBridge({ observer: obs, hud, channel: 'inp-alloc' });
        feedInteraction(64);
        // warm up (JIT, first channel.push allocation inside lite-hud, if any)
        for (let i = 0; i < 1000; i++) bridge.poll();
        globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        const HOT = 200000;
        for (let i = 0; i < HOT; i++) bridge.poll();
        globalThis.gc();
        const after = process.memoryUsage().heapUsed;
        const perCall = (after - before) / HOT;
        console.log('  [qa] hud bridge poll(): ' + HOT + ' calls, heap delta ' +
            (after - before) + ' B, ' + perCall.toFixed(3) + ' B/call');
        // Generous noise budget (allocator slack, GC bookkeeping) -- NOT a
        // widened gate, just tolerance for measurement noise; a real per-call
        // allocation of even one small object would blow this by 10-100x.
        assert.ok(perCall < 8, 'poll() must not allocate per call: measured ' + perCall.toFixed(3) + ' B/call');
        bridge.stop();
        hud.destroy();
        obs.destroy();
    });
} else {
    test('hud bridge getINPInto 0-alloc measurement SKIPPED (no --expose-gc)', () => {
        console.log('  [qa] run with `node --expose-gc` to measure this assertion; skipping now is NOT a pass.');
    });
}

// ===========================================================================
// GROUP C -- recipes/beacon.mjs (createInpBeacon)
// ===========================================================================

test('beacon: duplicate stop() is idempotent', () => {
    const doc = new MockEventTarget();
    const obs = createInpObserver({ durationThreshold: 16 });
    const beacon = createInpBeacon({ observer: obs, url: 'https://x/inp', document: doc, sendBeacon: () => true });
    beacon.start();
    assert.doesNotThrow(() => { beacon.stop(); beacon.stop(); beacon.stop(); });
    obs.destroy();
});

test('beacon: dispose-during-iteration -- stop() called from inside the visibilitychange handler itself', () => {
    const doc = new MockEventTarget();
    const obs = createInpObserver({ durationThreshold: 16 });
    feedInteraction(80);
    const sends = [];
    const beacon = createInpBeacon({
        observer: obs, url: 'https://x/inp', document: doc,
        sendBeacon: (u, b) => { sends.push(b); return true; }
    });
    beacon.start();
    // Wrap the listener set so stop() runs mid-dispatch (removing the very
    // listener currently iterating over doc's listener Set).
    const origDispatch = doc.dispatchEvent.bind(doc);
    doc.visibilityState = 'hidden';
    assert.doesNotThrow(() => {
        // A second listener that disposes the beacon while the first is
        // still executing inside the same dispatchEvent() iteration.
        doc.addEventListener('visibilitychange', () => beacon.stop());
        origDispatch({ type: 'visibilitychange' });
    }, 'disposing mid-dispatch must not throw or corrupt the Set being iterated');
    assert.equal(sends.length, 1, 'the flush that was already in flight still completed');
    obs.destroy();
});

test('beacon: re-entrant write -- a new interaction recorded from inside flush() does not double-send or throw', () => {
    const doc = new MockEventTarget();
    const obs = createInpObserver({ durationThreshold: 16 });
    feedInteraction(60);
    const sends = [];
    const beacon = createInpBeacon({
        observer: obs, url: 'https://x/inp', document: doc,
        sendBeacon: (u, b) => {
            // Re-entrant write: a new interaction lands WHILE the beacon body
            // is being serialized (simulates a straggler event firing during
            // the same task as visibilitychange).
            feedInteraction(999);
            sends.push(b);
            return true;
        }
    });
    beacon.start();
    doc.visibilityState = 'hidden';
    assert.doesNotThrow(() => doc.dispatchEvent({ type: 'visibilitychange' }));
    assert.equal(sends.length, 1, 'still exactly one beacon despite a re-entrant write during flush');
    doc.dispatchEvent({ type: 'visibilitychange' }); // must not re-fire even though a new interaction now exists
    assert.equal(sends.length, 1, 'the "sent" guard holds even though state changed after the first send');
    obs.destroy();
});

test('beacon ADVERSARIAL: sendBeacon transport throws -- flush must not silently mark itself sent on failure path it cannot detect', () => {
    const doc = new MockEventTarget();
    const obs = createInpObserver({ durationThreshold: 16 });
    feedInteraction(70);
    const beacon = createInpBeacon({
        observer: obs, url: 'https://x/inp', document: doc,
        sendBeacon: () => { throw new Error('network transport exploded'); }
    });
    beacon.start();
    doc.visibilityState = 'hidden';
    // Document actual behavior: the recipe has no try/catch around send(), so a
    // throwing transport propagates. This is measured, not assumed.
    assert.throws(() => doc.dispatchEvent({ type: 'visibilitychange' }),
        /network transport exploded/,
        'beacon.flush() does not swallow a throwing transport (measured behavior)');
    obs.destroy();
});

// ===========================================================================
// GROUP D -- recipes/layout.mjs (createInpLayoutCrossRef)
// ===========================================================================

test('layout xref: duplicate destroy() is idempotent when owning its own profiler', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const xref = createInpLayoutCrossRef({ observer: obs });
    assert.doesNotThrow(() => { xref.destroy(); xref.destroy(); },
        'destroying an owned profiler twice must not throw');
    obs.destroy();
});

test('layout xref: BYO profiler is never destroyed by xref.destroy() (ownership boundary)', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const profiler = createLayoutProfiler({ captureStacks: false, measureCost: false });
    let destroyed = false;
    const wrapped = { summary: profiler.summary.bind(profiler), destroy: () => { destroyed = true; } };
    const xref = createInpLayoutCrossRef({ observer: obs, profiler: wrapped });
    xref.destroy();
    assert.equal(destroyed, false, 'a caller-supplied profiler must not be torn down by the recipe');
    profiler.destroy();
    obs.destroy();
});

test('layout xref: report() with no interaction yet fails closed (inp/phase/target all null)', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const xref = createInpLayoutCrossRef({ observer: obs });
    const r = xref.report();
    assert.equal(r.inp, null);
    assert.equal(r.phase, null);
    assert.equal(r.target, null);
    assert.equal(r.presentationSuspect, false);
    xref.destroy();
    obs.destroy();
});

// ===========================================================================
// GROUP E -- construction fail-closed boundary (0 / null / undefined / NaN args)
// ===========================================================================

test('construction boundary: NaN durationThreshold does not throw at observer construction', () => {
    assert.doesNotThrow(() => {
        const o = createInpObserver({ durationThreshold: NaN });
        o.destroy();
    });
});

test('construction boundary: hud bridge with channel="" (falsy string) falls back to default name -- documented "||" pitfall', () => {
    const obs = createInpObserver({ durationThreshold: 16 });
    const hud = createHud(null);
    const bridge = createInpHudBridge({ observer: obs, hud, channel: '' });
    feedInteraction(33);
    bridge.poll();
    // hud.channel() has no public `.name`; observe the fallback through the
    // side effect instead -- the recipe's own `opts.channel || 'inp'` means an
    // empty string silently becomes the 'inp' channel, not a channel named "".
    assert.equal(hud.inspect(''), null, 'no channel was actually created under the empty-string name');
    const rec = hud.inspect('inp');
    assert.ok(rec !== null, 'empty-string channel silently becomes the "inp" default -- measured, not assumed');
    bridge.stop();
    hud.destroy();
    obs.destroy();
});

test('construction boundary: beacon with url="" throws (falsy required field, fail closed)', () => {
    assert.throws(() => createInpBeacon({ observer: {}, url: '' }), /url|required/i);
});

test('construction boundary: null opts object throws for all three recipes', () => {
    assert.throws(() => createInpHudBridge(null));
    assert.throws(() => createInpBeacon(null));
    assert.throws(() => createInpLayoutCrossRef(null));
});

test('construction boundary: undefined opts throws for all three recipes', () => {
    assert.throws(() => createInpHudBridge(undefined));
    assert.throws(() => createInpBeacon(undefined));
    assert.throws(() => createInpLayoutCrossRef(undefined));
});

// ===========================================================================
// GROUP F -- test/browser/serve.mjs (startStaticServer) -- pure Node, no browser
// ===========================================================================

let tmpRoot;
test.before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'lite-inp-qa-'));
    writeFileSync(join(tmpRoot, 'index.html'), '<html></html>');
    mkdirSync(join(tmpRoot, 'demo'));
    writeFileSync(join(tmpRoot, 'demo', 'inp.html'), '<html>demo</html>');
    mkdirSync(join(tmpRoot, '..', 'lite-inp-qa-secret-sibling'), { recursive: true });
});
test.after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

test('serve.mjs: root path (empty pathname) serves via 404 (no directory index) -- boundary "empty"', async () => {
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/');
        // '' + sep + '' resolves to the root dir itself; readFile on a directory
        // rejects -> the handler's catch -> 404. Documented, not assumed.
        assert.equal(res.status, 404);
    } finally { await srv.close(); }
});

test('serve.mjs: existing nested file serves 200 with correct MIME', async () => {
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/demo/inp.html');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
    } finally { await srv.close(); }
});

test('serve.mjs: nonexistent file -> 404', async () => {
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/does/not/exist.js');
        assert.equal(res.status, 404);
    } finally { await srv.close(); }
});

test('serve.mjs: unknown extension falls back to octet-stream', async () => {
    writeFileSync(join(tmpRoot, 'weird.xyz'), 'bytes');
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/weird.xyz');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    } finally { await srv.close(); }
});

test('serve.mjs ADVERSARIAL: literal ../ path traversal is blocked (403 or 404, never escapes root)', async () => {
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/../lite-inp-qa-secret-sibling/');
        assert.notEqual(res.status, 200, 'a raw ../ must never serve a file outside the root');
    } finally { await srv.close(); }
});

test('serve.mjs ADVERSARIAL: percent-encoded traversal (%2e%2e/) is blocked identically to the literal form', async () => {
    const srv = await startStaticServer(tmpRoot);
    try {
        const res = await fetch(srv.url + '/%2e%2e/%2e%2e/etc/passwd');
        assert.notEqual(res.status, 200, 'percent-decoding must not reopen the traversal the literal form blocks');
    } finally { await srv.close(); }
});

test('serve.mjs: duplicate close() does not throw (duplicate dispose)', async () => {
    const srv = await startStaticServer(tmpRoot);
    await srv.close();
    await assert.doesNotReject(() => srv.close());
});

// ===========================================================================
// test/browser/runner.mjs -- runScenarios' new `browserType` seam (1.3.1).
// ONLY the synchronous-before-launch validation is Node-visible without an
// actual browser: `inject`/`collect` typeof checks and the browserType
// allowlist all run and reject/throw BEFORE `engine.launch()` is ever awaited
// (see runner.mjs: the checks precede `const browser = await engine.launch`).
// Every case below asserts a rejection so no Chromium/Firefox process is ever
// spawned in the plain `node:test` lane -- this locks the fail-closed CONTRACT
// of the seam, not its browser-dependent behavior (that is firefox.test.mjs's
// job). Falsy browserType values (undefined, null, '', 0, NaN, false) are
// intentionally NOT covered here: `config.browserType || 'chromium'` treats
// them all as "default to chromium" and would actually launch a browser --
// out of scope for this Node-only boundary suite.
// ===========================================================================

const NOOP_ASYNC = async () => {};

test('runner.mjs: browserType outside the allowlist rejects before any browser launches', async () => {
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, collect: NOOP_ASYNC, scenarios: [], browserType: 'safari' }),
        /browserType must be 'chromium' or 'firefox', got safari/
    );
});

test('runner.mjs ADVERSARIAL: browserType is case-sensitive ("Chromium" !== "chromium")', async () => {
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, collect: NOOP_ASYNC, scenarios: [], browserType: 'Chromium' }),
        /browserType must be 'chromium' or 'firefox', got Chromium/
    );
});

test('runner.mjs ADVERSARIAL: trailing whitespace on an otherwise-valid browserType is rejected, not trimmed', async () => {
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, collect: NOOP_ASYNC, scenarios: [], browserType: 'firefox ' }),
        /browserType must be 'chromium' or 'firefox', got firefox /
    );
});

test('runner.mjs ADVERSARIAL: a non-string truthy browserType (type confusion) is rejected, not silently coerced', async () => {
    // A plain object is truthy, so `config.browserType || 'chromium'` does NOT
    // default it away -- the strict !== allowlist check must still catch it,
    // proving the seam does not just duck-type on truthiness.
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, collect: NOOP_ASYNC, scenarios: [], browserType: { toString: () => 'chromium' } }),
        /browserType must be 'chromium' or 'firefox'/
    );
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, collect: NOOP_ASYNC, scenarios: [], browserType: 1 }),
        /browserType must be 'chromium' or 'firefox', got 1/
    );
});

test('runner.mjs: missing inject rejects fail-closed before browserType is even consulted', async () => {
    await assert.rejects(
        () => runScenarios({ collect: NOOP_ASYNC, scenarios: [] }),
        /runScenarios: inject must be a function/
    );
    await assert.rejects(
        () => runScenarios({ inject: null, collect: NOOP_ASYNC, scenarios: [] }),
        /runScenarios: inject must be a function/
    );
    await assert.rejects(
        () => runScenarios({ inject: 'not-a-function', collect: NOOP_ASYNC, scenarios: [] }),
        /runScenarios: inject must be a function/
    );
});

test('runner.mjs: missing collect rejects fail-closed', async () => {
    await assert.rejects(
        () => runScenarios({ inject: NOOP_ASYNC, scenarios: [] }),
        /runScenarios: collect must be a function/
    );
});
