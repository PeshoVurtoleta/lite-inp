// test/browser/control.detached.mjs -- node test/browser/control.detached.mjs
//
// The DETACHED-DOM leak control for IN2's element attribution.
//
// The shipped path interns element targets through a WeakMap keyed by node
// IDENTITY: the Node is NEVER stored strongly, so a detached subtree stays
// collectable even while the observer is LIVE. This lane proves that, with teeth:
//
//   SHIPPED : feed 10000 fresh-then-detached elements as targets to a LIVE
//             lite-inp observer, drop all strong refs, force GC -> ~0 survive.
//   CONTROL : the same 10000 elements fed to a naive collector that STORES
//             e.target (the classic RUM anti-pattern) -> ALL 10000 survive.
//
// COUNTING -- synthetic-first (see test/browser/honesty.md). The HARD gate is
// WeakRef liveness after a forced CDP HeapProfiler.collectGarbage: we hold a
// WeakRef to every created element and count how many still deref() after GC. A
// WeakRef that still resolves is a node the collector RETAINED. This is
// deterministic and robust headless. A real heap-snapshot "detached DOM node"
// count (DOM.getDetachedDomNodes / HeapSnapshot walking) is the flaky-headless
// class IN0 warned about; it is NOT relied on here (carved into honesty.md).
//
// Browser policy: FAIL-CLOSED. Missing Chromium fails the gate, unless
// LITE_NO_BROWSER=1 in which case it skips loudly (exit 0).

import { readFileSync } from 'node:fs';
import { runScenarios } from './runner.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
if (SKIP) {
    console.log('[control.detached] LITE_NO_BROWSER=1 -- detached leak lane SKIPPED (Node lanes still gate).');
    console.log('GATE control.detached SKIPPED (LITE_NO_BROWSER=1)');
    process.exit(0);
}

const N = 10000;
// Shipped tolerance: a handful of transient survivors from an incomplete GC are
// acceptable; a RETAINING collector keeps ALL N. The margin between 0-ish and N
// is enormous, so the gate is unambiguous.
const SHIPPED_MAX_ALIVE = 50;
const CONTROL_MIN_ALIVE = N;         // the control must retain every one

const INP_SRC = readFileSync(new URL('../../Inp.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '');

// page-side: SHIPPED path. Shim PerformanceObserver so a fresh lite-inp observer's
// event callback is captured, feed N detached elements as targets, keep a WeakRef
// to each, drop every strong ref. The observer stays LIVE (not destroyed) so this
// proves the WeakMap itself does not retain -- not merely that destroy() clears.
function pageShipped(n) {
    const RealPO = window.PerformanceObserver;
    let evCb = null;
    function Shim(cb) { this._cb = cb; }
    Shim.prototype.observe = function (o) { if (o.type === 'event') evCb = this._cb; };
    Shim.prototype.disconnect = function () {};
    Shim.prototype.takeRecords = function () { return []; };
    Shim.supportedEntryTypes = ['event', 'long-animation-frame'];
    window.PerformanceObserver = Shim;
    // Kept live for the whole measurement -- the point is the WeakMap is weak.
    window.__obs = window.createInpObserver({ durationThreshold: 16 });
    window.PerformanceObserver = RealPO;

    window.__refs = new Array(n);
    const box = [null];
    const feed = { getEntries: function () { return box; } };
    for (let i = 0; i < n; i++) {
        const el = document.createElement('button');
        el.id = 'shipped-' + i;
        document.body.appendChild(el);
        window.__refs[i] = new WeakRef(el);
        box[0] = {
            interactionId: i + 1, duration: 24 + (i % 400),
            startTime: i, processingStart: i + 2, processingEnd: i + 14,
            name: 'pointerup', target: el
        };
        evCb(feed);
        document.body.removeChild(el);   // detach; drop the only strong ref next iter
    }
    box[0] = null;                        // drop the last element's strong ref
    return n;
}

// page-side: CONTROL path. The naive anti-pattern -- STORE e.target. Same N
// detached elements, but pushed (strongly) into an array that stays live. Every
// element is retained; every WeakRef still deref()s after GC.
function pageControl(n) {
    window.__store = [];
    window.__refs = new Array(n);
    // A minimal "observer": mimic the hot path but store the node (the leak).
    function naiveOnEvent(list) {
        const es = list.getEntries();
        for (let i = 0; i < es.length; i++) window.__store.push(es[i].target);
    }
    const box = [null];
    const feed = { getEntries: function () { return box; } };
    for (let i = 0; i < n; i++) {
        const el = document.createElement('button');
        el.id = 'control-' + i;
        document.body.appendChild(el);
        window.__refs[i] = new WeakRef(el);
        box[0] = { interactionId: i + 1, target: el };
        naiveOnEvent(feed);
        document.body.removeChild(el);
    }
    box[0] = null;
    return n;
}

function countAlive() {
    let alive = 0;
    for (let i = 0; i < window.__refs.length; i++) {
        if (window.__refs[i].deref() !== undefined) alive++;
    }
    return alive;
}

const measured = Object.create(null);

async function forceGc(ctx) {
    await ctx.cdp.send('HeapProfiler.enable').catch(function () {});
    // Collect a few times: WeakRef clearing can trail one full-GC cycle.
    for (let i = 0; i < 4; i++) await ctx.cdp.send('HeapProfiler.collectGarbage');
    await ctx.cdp.send('HeapProfiler.disable').catch(function () {});
}

function makeScenario(name, pageFn) {
    return {
        name: name,
        async run(ctx) {
            await ctx.eval(pageFn, N);
            await forceGc(ctx);
            measured[name] = await ctx.eval(countAlive);
        }
    };
}

let exitCode = 0;
try {
    await runScenarios({
        pageUrl: 'about:blank',
        inject: async function (page) { await page.addScriptTag({ content: INP_SRC }); },
        scenarios: [makeScenario('shipped', pageShipped), makeScenario('control', pageControl)],
        collect: function () { return null; },
        options: { headless: true, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    const shipped = measured.shipped;
    const control = measured.control;
    console.log('  shipped: created=' + N + ' retainedAfterGC=' + shipped);
    console.log('  control: created=' + N + ' retainedAfterGC=' + control);

    if (shipped === undefined || control === undefined) {
        fail('a run did not report a retained count');
    } else {
        // Fail-closed: if the control did NOT retain, WeakRef counting is broken
        // and the gate has no teeth.
        if (control < CONTROL_MIN_ALIVE) {
            fail('store-the-target CONTROL retained only ' + control + ' of ' + N +
                ' detached nodes -- WeakRef/GC counting is broken, gate has no teeth');
        }
        // The shipped interned path must retain ~none.
        if (shipped > SHIPPED_MAX_ALIVE) {
            fail('shipped interned path RETAINED ' + shipped + ' detached nodes (> ' +
                SHIPPED_MAX_ALIVE + ') -- the WeakMap is holding the Node');
        }
        if (exitCode === 0) {
            console.log('GATE control.detached shippedRetained=' + shipped +
                ' controlRetained=' + control + '/' + N +
                ' controlFlagged=true teeth=red-against-store-the-target/green-shipped | ok');
        }
    }
} catch (e) {
    console.error('GATE control.detached FAIL: ' + e.message);
    exitCode = 1;
}
process.exit(exitCode);

function fail(msg) { console.error('  FAIL ' + msg); exitCode = 1; }
