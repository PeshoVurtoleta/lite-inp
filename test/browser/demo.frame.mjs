// test/browser/demo.frame.mjs -- node test/browser/demo.frame.mjs
//
// THE DEMO FRAME-LOOP GATE (demoLoopGate).
// The GC torture harness is structurally blind to a rAF render loop: a forced
// synchronous reflow costs zero bytes and triggers zero GC, so lite-leak and
// lite-gc-profiler both report clean while the demo drops frames. This gate
// drives the REAL demo/inp.html in real Chromium through the SAME runner seam
// the oracle uses, and gates the four things the torture run cannot see:
//
//   1. PARITY + ATTRIBUTION -- for each of the 4 scene-01 injectors, on a fresh
//      demo page, |lite-inp - web-vitals| <= 8 ms; the sync injector's
//      attribution target is exactly 'button#inject-sync'.
//   2. FRAME LOOP -- with the demo self-instrumented by lite-layout-profiler
//      (#profile), drive every scene: 0 forced reflows in the frame loop
//      (the thrash injector's deliberate reflow is NOT tapped here). Telemetry
//      textContent writes stay <= 11/s (the ~10 Hz mask holds).
//   3. ALLOCATION -- a 600-tap burst samples the observer path at <= 12 KiB;
//      scene-04's allocating-onUpdate toggle is the control and climbs >= 16 KiB.
//   4. RETENTION -- 100 scene switches create no DOM and no second observer.
//
// Browser policy: FAIL-CLOSED. Missing Chromium fails, unless LITE_NO_BROWSER=1
// in which case it skips loudly (exit 0) and the Node lanes still gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './runner.mjs';
import { startStaticServer } from './serve.mjs';
import { DEMO_SCENARIOS, demoParityProbe } from './scenarios.mjs';
import { sumObserverPath, sumSamples, DEMO_OBSERVER_FRAMES } from './heappath.mjs';
import { checkNoReflow } from '@zakkster/lite-layout-profiler';

const SKIP = process.env.LITE_NO_BROWSER === '1';
if (SKIP) {
    console.log('[demo.frame] LITE_NO_BROWSER=1 -- demo frame gate SKIPPED (Node lanes still gate).');
    console.log('GATE demo.frame SKIPPED (LITE_NO_BROWSER=1)');
    process.exit(0);
}

const QUANT = 8;                       // ms: Event-Timing quantization budget
const OBSERVER_FLOOR_BYTES = 12 * 1024;
const BURST = 600;
const RAMP_BASE = 20;                  // ms sync-block floor during the burst
const RAMP_BAND = 8;                   // rising band; each step is +8 ms so the
                                       // quantized duration rises -> new worsts
                                       // -> onUpdate fires (the control climbs)
const TELEMETRY_MAX_PER_S = 11;        // ~10 Hz throttle + margin
const MIN_CONTROL_FIRES = 4;           // the toggle must fire onUpdate >= this
// The control climb floor is DERIVED from the injector's known per-fire
// allocation (controlAllocBytes) x the driven fires, discounted for the sampling
// profiler's attribution rate. The control allocates many small on-heap objects
// AT the onUpdate site; at a 4096-B sampling interval the profiler attributes a
// STABLE ~9% of the nominal bytes to onUpdate (measured 8.6-9.4% across repeated
// runs). The discount is set to 0.03 -- a 3x margin under that measured rate --
// so the floor sits far below the stable signal (~330-410 KiB for 8 fires) and
// far above the honest path (~0). It is not a hand-picked byte count.
const CONTROL_SAMPLE_DISCOUNT = 0.03;
const MIN_DRIVEN = 500;                // the burst must actually record interactions

// Served over HTTP (set in the run block) -- ES modules cannot be imported from
// a file:// origin, so the demo must have a real HTTP origin like `npx serve .`.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let DEMO_URL = '';
const WV_SRC = readFileSync(
    new URL('../../node_modules/web-vitals/dist/web-vitals.attribution.iife.js', import.meta.url),
    'utf8'
);

// --- page-side helpers (run in the browser) -------------------------------
function installWebVitals() {
    window.__wv = null;
    // eslint-disable-next-line no-undef
    webVitals.onINP(function (m) { window.__wv = m.value; },
        { reportAllChanges: true, durationThreshold: 16 });
}
// Fail closed: reject after a deadline rather than polling forever, so a broken
// demo load (CORS, a bad import) surfaces as a loud gate failure, not a hang.
function waitDemoReady() {
    return new Promise(function (r, j) {
        const t0 = Date.now();
        (function poll() {
            if (window.__demo && window.__demo.ready) r(true);
            else if (Date.now() - t0 > 8000) j(new Error('demo did not initialize within 8s (window.__demo absent)'));
            else setTimeout(poll, 20);
        })();
    });
}
function waitLayoutReady() {
    return new Promise(function (r, j) {
        const t0 = Date.now();
        (function poll() {
            if (window.__demo && window.__demo.ready && window.__layout) r(true);
            else if (Date.now() - t0 > 8000) j(new Error('layout profiler did not attach within 8s (window.__layout absent)'));
            else setTimeout(poll, 20);
        })();
    });
}

async function inject(page) {
    await page.addScriptTag({ content: WV_SRC });
    await page.evaluate(installWebVitals);
    await page.evaluate(waitDemoReady);
}

// --- probes filled by the measurement scenarios ---------------------------
const frameProbe = {};
const allocProbe = {};

// Sample the heap around a BURST of sync-injector taps; returns the raw profile
// so the caller can read BOTH the demo observer-path self-size (our allocation,
// which must stay flat) and the whole-page total (which the scene-04 control
// grows). Each measurement runs on its OWN fresh page (a fresh observer) so the
// worst duration starts at zero and the rising ramp fires onUpdate.
async function sampleBurst(ctx, center) {
    await ctx.cdp.send('HeapProfiler.enable');
    await ctx.cdp.send('HeapProfiler.collectGarbage');
    await ctx.cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096 });
    for (let i = 0; i < BURST; i++) {
        await ctx.tap(center.x, center.y);
        await ctx.frame();
    }
    const res = await ctx.cdp.send('HeapProfiler.stopSampling');
    await ctx.cdp.send('HeapProfiler.disable');
    return res.profile;
}

// Drive one alloc measurement on a fresh demo page. allocating=false is the
// honest floor; true is the scene-04 control.
async function measureAlloc(ctx, allocating) {
    await ctx.eval(function (cfg) {
        window.__demo.scene(0);
        window.__demo.allocOn(cfg.allocating);
        window.__demo.setInjectorMs(cfg.base, cfg.band);
    }, { allocating: allocating, base: RAMP_BASE, band: RAMP_BAND });
    const c = await ctx.eval(injectorCenter, 'inject-sync');
    await ctx.tap(c.x, c.y); await ctx.frame();   // warm, excluded from sample
    const profile = await sampleBurst(ctx, c);
    const state = await ctx.eval(function () {
        return {
            updates: window.__demo.updateCalls,
            count: window.__demo.obs.interactionCount,
            perFireBytes: window.__demo.controlAllocBytes
        };
    });
    return {
        // The control's own allocation frame (onUpdate). onEventEntry's platform
        // getEntries array is excluded, so this is OUR/the-control's bytes, not
        // page churn -- the deterministic quantity. Whole-page total is kept for
        // context only; it is high-variance and NOT gated.
        observerPath: sumObserverPath(profile, DEMO_OBSERVER_FRAMES),
        total: sumSamples(profile),
        updates: state.updates,
        count: state.count,
        perFireBytes: state.perFireBytes
    };
}

function injectorCenter(id) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// The measurement scenarios run AFTER the 4 parity scenarios, each on a fresh
// demo page from the shared runner.
const MEASURE_SCENARIOS = [
    {
        name: 'frame-loop',
        async run(ctx) {
            // Reload with #profile so the demo self-instruments layout from frame 0.
            // A hash-only change is a same-document navigation that would NOT
            // re-run the module, so bounce through about:blank to force a real load.
            await ctx.goto('about:blank');
            await ctx.goto(DEMO_URL + '#profile');
            await ctx.eval(waitLayoutReady);
            await ctx.eval(function () { window.__layout.reset(); });
            await ctx.eval(function () { window.__demo.setInjectorMs(24, 0); });

            // Drive the frame loop across every scene WITHOUT tapping thrash.
            const c = await ctx.eval(injectorCenter, 'inject-sync');
            for (let i = 0; i < 4; i++) { await ctx.tap(c.x, c.y); await ctx.frame(); }
            const order = [1, 2, 3, 0];
            for (let k = 0; k < order.length; k++) {
                await ctx.eval(function (n) { window.__demo.scene(n); }, order[k]);
                await ctx.frame(); await ctx.frame(); await ctx.wait(120);
            }

            // Telemetry rate: the timeline scene (index 1) refreshes on the
            // ~10 Hz wall-clock throttle regardless of new interactions, so
            // measure the throttle there over ~1.2 s of wall time.
            await ctx.eval(function () { window.__demo.scene(1); });
            await ctx.frame();
            const t0 = await ctx.eval(function () {
                return { w: window.__demo.telemetryWrites, t: performance.now() };
            });
            await ctx.wait(1200);
            const t1 = await ctx.eval(function () {
                return { w: window.__demo.telemetryWrites, t: performance.now() };
            });
            frameProbe.telemetryWrites = t1.w - t0.w;
            frameProbe.telemetrySeconds = (t1.t - t0.t) / 1000;
            frameProbe.telemetryRate = frameProbe.telemetryWrites / frameProbe.telemetrySeconds;

            // Retention: 100 scene switches must not grow the DOM or spawn a
            // second observer (scenes toggle .hidden -- zero DOM churn).
            frameProbe.nodeBefore = await ctx.eval(function () { return window.__demo.nodeCount; });
            await ctx.eval(function () { for (let i = 0; i < 100; i++) window.__demo.scene(i % 4); });
            await ctx.cdp.send('HeapProfiler.enable');
            await ctx.cdp.send('HeapProfiler.collectGarbage');
            await ctx.cdp.send('HeapProfiler.disable');
            frameProbe.nodeAfter = await ctx.eval(function () { return window.__demo.nodeCount; });
            frameProbe.observerCount = await ctx.eval(function () { return window.__demo.observerCount; });

            // Forced-reflow summary from the demo's own frame loop.
            frameProbe.summary = await ctx.eval(function () { return window.__layout.summary(); });
            await ctx.eval(function () { window.__layout.destroy(); });
        }
    },
    {
        // Honest floor: toggle off. Fresh page (fresh observer) so the rising
        // ramp fires onUpdate. onUpdate is primitives only -> observer path flat.
        name: 'alloc-honest',
        async run(ctx) { allocProbe.honest = await measureAlloc(ctx, false); }
    },
    {
        // The control: toggle on. Same burst on its OWN fresh page -> onUpdate
        // allocates a fresh 16k array per fire, so the whole-page heap climbs.
        name: 'alloc-control',
        async run(ctx) { allocProbe.control = await measureAlloc(ctx, true); }
    }
];

// --- run ------------------------------------------------------------------
let exitCode = 0;
function fail(msg) { console.error('  FAIL ' + msg); exitCode = 1; }
function kb(b) { return (b / 1024).toFixed(1) + 'KB'; }
function fmt(v) { return v === null || v === undefined ? 'null' : (Math.round(v * 10) / 10); }

let httpServer = null;
try {
    httpServer = await startStaticServer(ROOT);
    DEMO_URL = httpServer.url + '/demo/inp.html';
    console.log('  [demo] serving ' + ROOT + ' at ' + httpServer.url);
    const scenarios = DEMO_SCENARIOS.concat(MEASURE_SCENARIOS);
    await runScenarios({
        pageUrl: DEMO_URL,
        inject: inject,
        scenarios: scenarios,
        collect: function () { return null; },
        options: { headless: true, onLog: function (s) { console.log('  [demo] ' + s); } }
    });

    // 1) PARITY + ATTRIBUTION -------------------------------------------------
    for (const inj of DEMO_SCENARIOS) {
        const p = demoParityProbe[inj.name];
        if (!p) { fail('no parity probe for ' + inj.name); continue; }
        console.log('  ' + inj.name.padEnd(14) +
            ' lite=' + fmt(p.liteInp) + ' web-vitals=' + fmt(p.webVitals) +
            ' interactions=' + p.interactionCount + ' target=' + p.target);
        if (p.liteInp === null || p.webVitals === null) {
            // Agreement includes agreeing on "none" (both below threshold).
            if (!(p.liteInp === null && (p.webVitals === null || p.webVitals <= QUANT))) {
                fail(inj.name + ': one side null but the other reported ' +
                    fmt(p.liteInp) + ' / ' + fmt(p.webVitals));
            }
        } else {
            const d = Math.abs(p.liteInp - p.webVitals);
            if (d > QUANT) fail(inj.name + ': |lite-inp - web-vitals| = ' + d.toFixed(1) + ' ms > ' + QUANT);
        }
    }
    const syncTarget = demoParityProbe['inject-sync'] && demoParityProbe['inject-sync'].target;
    if (syncTarget !== 'button#inject-sync') {
        fail("scene-01 attribution target must be 'button#inject-sync', got " + syncTarget);
    }

    // 2) FRAME LOOP -----------------------------------------------------------
    const sum = frameProbe.summary;
    if (!sum) {
        fail('no layout summary captured');
    } else {
        const report = checkNoReflow(sum, { maxReflows: 0 });
        console.log('  frame-loop reflows=' + sum.total + ' patched.complete=' +
            (sum.patched && sum.patched.complete) + ' verdict=' +
            (report.ok ? 'clean' : 'DIRTY') + ' verified=' + report.verified);
        if (!report.ok || !report.verified) {
            fail('frame loop forced reflow(s): total=' + sum.total +
                ' ok=' + report.ok + ' verified=' + report.verified);
            for (const v of report.violations) console.error('    violation ' + v.metric + ' actual=' + v.actual);
        }
    }
    console.log('  telemetry writes=' + frameProbe.telemetryWrites +
        ' over ' + frameProbe.telemetrySeconds.toFixed(2) + 's -> ' +
        frameProbe.telemetryRate.toFixed(1) + '/s (max ' + TELEMETRY_MAX_PER_S + ')');
    if (!(frameProbe.telemetryRate <= TELEMETRY_MAX_PER_S)) {
        fail('telemetry write rate ' + frameProbe.telemetryRate.toFixed(1) +
            '/s exceeds ' + TELEMETRY_MAX_PER_S + '/s -- the ~10 Hz mask is not holding');
    }
    if (frameProbe.telemetryWrites <= 0) {
        fail('telemetry never flushed -- rate gate has no teeth');
    }

    // 4) RETENTION ------------------------------------------------------------
    console.log('  retention nodes ' + frameProbe.nodeBefore + ' -> ' + frameProbe.nodeAfter +
        ' observerCount=' + frameProbe.observerCount + ' (100 scene switches)');
    if (frameProbe.nodeAfter !== frameProbe.nodeBefore) {
        fail('scene switching grew the DOM: ' + frameProbe.nodeBefore + ' -> ' + frameProbe.nodeAfter);
    }
    if (frameProbe.observerCount !== 1) {
        fail('scene switching created ' + frameProbe.observerCount + ' observers (expected 1)');
    }

    // 3) ALLOCATION -----------------------------------------------------------
    // The scene-04 control climb is measured on the control's OWN allocation
    // frame (onUpdate), NOT the whole-page HeapProfiler total -- page churn is
    // high-variance and swamps a few fires, whereas the control's many small
    // on-heap objects, allocated at the onUpdate site, are attributed there and
    // converge (law of large numbers) to a stable ~9%-of-nominal sampled sum. The
    // threshold is derived from the injector's known per-fire bytes x the driven
    // fires, discounted for that sampling rate; it is not a hand-picked constant.
    const h = allocProbe.honest, c = allocProbe.control;
    console.log('  alloc honest  observerPath=' + kb(h.observerPath) + ' updates=' + h.updates +
        ' interactions=' + h.count + ' (total=' + kb(h.total) + ', not gated)');
    console.log('  alloc control observerPath=' + kb(c.observerPath) + ' updates=' + c.updates +
        ' interactions=' + c.count + ' (total=' + kb(c.total) + ', not gated)');
    const climb = c.observerPath - h.observerPath;
    const expected = c.updates * c.perFireBytes;
    const climbFloor = Math.round(expected * CONTROL_SAMPLE_DISCOUNT);
    console.log('  FLOOR(honest observerPath)=' + kb(OBSERVER_FLOOR_BYTES) +
        ' | scene-04 control climb=' + kb(climb) +
        ' (need >= ' + kb(climbFloor) + ' = ' + c.updates + ' fires x ' + kb(c.perFireBytes) +
        ' x ' + CONTROL_SAMPLE_DISCOUNT + ')');
    if (h.count < MIN_DRIVEN) fail('honest burst under-drove: ' + h.count + ' interactions (< ' + MIN_DRIVEN + ')');
    if (c.count < MIN_DRIVEN) fail('control burst under-drove: ' + c.count + ' interactions (< ' + MIN_DRIVEN + ')');
    // The honest demo observer path (our allocation sites, onEventEntry's
    // platform getEntries array excluded) stays under the floor.
    if (h.observerPath > OBSERVER_FLOOR_BYTES) {
        fail('demo observer path OVER floor: honest ' + kb(h.observerPath) + ' > ' + kb(OBSERVER_FLOOR_BYTES));
    }
    // Teeth: the toggle must actually have fired onUpdate enough times, and the
    // control's own allocation frame must climb to the derived floor.
    if (c.updates < MIN_CONTROL_FIRES) {
        fail('control onUpdate fired only ' + c.updates + ' times (< ' + MIN_CONTROL_FIRES + ') -- toggle gate has no teeth');
    }
    if (climb < climbFloor) {
        fail('scene-04 allocating toggle did NOT climb: control onUpdate frame ' + kb(c.observerPath) +
            ' vs honest ' + kb(h.observerPath) + ' (climb ' + kb(climb) + ' < derived floor ' +
            kb(climbFloor) + ') -- no teeth');
    }

    if (exitCode === 0) {
        console.log('GATE demo.frame parity<=' + QUANT + 'ms/4 target=button#inject-sync' +
            ' reflows=' + (frameProbe.summary ? frameProbe.summary.total : '?') +
            ' telemetry=' + frameProbe.telemetryRate.toFixed(1) + '/s' +
            ' honestObserverPath=' + h.observerPath + 'B controlClimb=' + climb + 'B/floor' + climbFloor + 'B' +
            ' retain=nodes' + frameProbe.nodeAfter + '/obs' + frameProbe.observerCount + ' | ok');
    } else {
        console.error('GATE demo.frame | FAIL');
    }
} catch (e) {
    console.error('GATE demo.frame FAIL: ' + (e && e.stack || e));
    exitCode = 1;
} finally {
    if (httpServer) await httpServer.close();
}
process.exit(exitCode);
