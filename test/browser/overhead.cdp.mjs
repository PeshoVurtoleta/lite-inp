// test/browser/overhead.cdp.mjs -- node test/browser/overhead.cdp.mjs
//
// END-TO-END OVERHEAD GATE. Drives the SAME trusted-input burst through two
// pages via the runner seam:
//   - baseline: the jank hotspot, NO observer instrumented.
//   - observed: the same page with createInpObserver running.
// Both sample whole-page allocation with CDP HeapProfiler around an identical
// burst, so the delta is the honest cost of observing INP end to end. The
// observer-path self-size (reused from the alloc gate's summer) is asserted to
// stay under the documented floor on the observed page and to be exactly zero on
// the baseline -- the fingerprint the README quotes.
//
// Browser policy: FAIL-CLOSED. Missing Chromium fails, unless LITE_NO_BROWSER=1
// (skips loudly, Node lanes still gate).

import { readFileSync } from 'node:fs';
import { runScenarios } from './runner.mjs';
import { installJank, HOTSPOT } from './scenarios.mjs';
import { sumSamples, sumObserverPath } from './heappath.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
if (SKIP) {
    console.log('[overhead] LITE_NO_BROWSER=1 -- overhead gate SKIPPED (Node lanes still gate).');
    console.log('GATE overhead.cdp SKIPPED (LITE_NO_BROWSER=1)');
    process.exit(0);
}

const BURST = 300;
const SAMPLING_INTERVAL = 4096;
const MIN_DRIVEN = 260;
const OBSERVER_FLOOR_BYTES = 12 * 1024;   // observed observer-path self-size floor
// Whole-page allocation attributable to observing, per unique interaction. The
// Map<interactionId, slot> entry + one-time interning dominate; everything else
// is preallocated SoA. A per-interaction OBJECT would blow this immediately.
const MAX_BYTES_PER_INTERACTION = 512;

const INP_SRC = readFileSync(new URL('../../Inp.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '');

function setupBurst(cfg) {
    window.__inp = cfg.observe
        ? window.createInpObserver({ durationThreshold: 0, onUpdate: function () {} })
        : null;
    // Every tap >= 24 ms so it clears the Event-Timing floor and registers.
    const sched = new Array(cfg.burst);
    for (let i = 0; i < cfg.burst; i++) sched[i] = (i % 20 === 0) ? (24 + (i / 20) * 6) : 24;
    window.__jank.mode = 'sync';
    window.__jank.schedule = sched;
    window.__jank.idx = 0;
}

const measured = Object.create(null);

async function inject(page) {
    await installJank(page);
    await page.addScriptTag({ content: INP_SRC });
}

function makeScenario(name, observe) {
    return {
        name: name,
        async run(ctx) {
            await ctx.eval(setupBurst, { observe: observe, burst: BURST });
            await ctx.tap(HOTSPOT.x, HOTSPOT.y);   // warm
            await ctx.frame();
            await ctx.cdp.send('HeapProfiler.enable');
            await ctx.cdp.send('HeapProfiler.collectGarbage');
            await ctx.cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL });
            for (let i = 0; i < BURST; i++) { await ctx.tap(HOTSPOT.x, HOTSPOT.y); await ctx.frame(); }
            const res = await ctx.cdp.send('HeapProfiler.stopSampling');
            await ctx.cdp.send('HeapProfiler.disable');
            measured[name] = {
                total: sumSamples(res.profile),
                observerBytes: sumObserverPath(res.profile),
                count: await ctx.eval(function () { return window.__inp ? window.__inp.interactionCount : 0; })
            };
        }
    };
}

let exitCode = 0;
function fail(msg) { console.error('  FAIL ' + msg); exitCode = 1; }
function kb(b) { return (b / 1024).toFixed(1) + 'KB'; }

try {
    await runScenarios({
        pageUrl: 'about:blank',
        inject: inject,
        scenarios: [makeScenario('baseline', false), makeScenario('observed', true)],
        collect: function () { return null; },
        options: { headless: true, onLog: function (s) { console.log('  [overhead] ' + s); } }
    });

    const base = measured.baseline;
    const obs = measured.observed;
    if (!base || !obs) { fail('a run did not record a heap sample'); }
    else {
        console.log('  baseline: total=' + kb(base.total) + ' observerPath=' + kb(base.observerBytes));
        console.log('  observed: total=' + kb(obs.total) + ' observerPath=' + kb(obs.observerBytes) +
            ' interactions=' + obs.count);
        const delta = obs.total - base.total;
        const perInteraction = obs.count > 0 ? delta / obs.count : Infinity;
        console.log('  end-to-end delta=' + kb(delta) + ' over ' + obs.count +
            ' interactions -> ' + perInteraction.toFixed(1) + ' B/interaction (max ' +
            MAX_BYTES_PER_INTERACTION + ')');

        if (obs.count < MIN_DRIVEN) fail('observed burst under-drove: ' + obs.count + ' < ' + MIN_DRIVEN);
        // The baseline has no observer, so no observer frame can appear.
        if (base.observerBytes !== 0) fail('baseline sampled observer frames (' +
            kb(base.observerBytes) + ') -- it should have no observer at all');
        // The observed observer path stays under the documented floor.
        if (obs.observerBytes > OBSERVER_FLOOR_BYTES) fail('observed observer path OVER floor: ' +
            kb(obs.observerBytes) + ' > ' + kb(OBSERVER_FLOOR_BYTES));
        // Per-interaction end-to-end allocation stays bounded (no per-tap object).
        if (perInteraction > MAX_BYTES_PER_INTERACTION) fail('end-to-end overhead ' +
            perInteraction.toFixed(1) + ' B/interaction exceeds ' + MAX_BYTES_PER_INTERACTION);

        if (exitCode === 0) {
            console.log('GATE overhead.cdp baselineTotal=' + base.total + 'B observedTotal=' + obs.total +
                'B deltaPerInteraction=' + perInteraction.toFixed(1) + 'B observedObserverPath=' +
                obs.observerBytes + 'B floor=' + OBSERVER_FLOOR_BYTES + 'B | ok');
        } else {
            console.error('GATE overhead.cdp | FAIL');
        }
    }
} catch (e) {
    console.error('GATE overhead.cdp FAIL: ' + (e && e.stack || e));
    exitCode = 1;
}
process.exit(exitCode);
