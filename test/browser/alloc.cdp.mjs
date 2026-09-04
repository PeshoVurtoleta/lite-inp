// test/browser/alloc.cdp.mjs -- node test/browser/alloc.cdp.mjs
//
// In-browser allocation gate. Drives a 500-interaction burst of REAL trusted
// input through the SAME runner seam the oracle uses (runScenarios -> ctx.tap /
// ctx.frame, the exact CDP Input.dispatchMouseEvent path that reached 512 unique
// interactions in wrap600), and samples the heap with CDP HeapProfiler around
// the burst.
//
// The gated signal is observerPath: sampled self-size of the library's
// callback frames (onEventEntry, maintainLongest, interning, ...) plus the
// caller's onUpdate. That is the honest floor:
//   - getEntries() arrays, Map.set per unique interaction, event-type interning
//     are all platform/native or amortized -- attributed OUTSIDE our JS frames,
//     so the honest observerPath stays ~0.
//   - real per-interaction OBJECT growth inside our frames would show up here.
// Whole-page `total` is logged for context but NOT gated (page/GC noise).
//
// CONTROL: a second observer whose onUpdate allocates a fresh Array on every
// call. Its observerPath MUST exceed the honest floor -- otherwise the gate has
// no teeth. Fail-closed: if BOTH observerPaths sample 0, the sampler is broken.
//
// Browser policy: FAIL-CLOSED. Missing Chromium fails the gate, unless
// LITE_NO_BROWSER=1 in which case it skips loudly (exit 0).

import { readFileSync } from 'node:fs';
import { runScenarios } from './runner.mjs';
import { installJank, HOTSPOT } from './scenarios.mjs';
import { sumObserverPath, sumSamples } from './heappath.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
if (SKIP) {
    console.log('[alloc.cdp] LITE_NO_BROWSER=1 -- browser alloc gate SKIPPED (Node lanes still gate).');
    console.log('GATE alloc.cdp SKIPPED (LITE_NO_BROWSER=1)');
    process.exit(0);
}

const BURST = 500;              // total interactions per run
const NEW_MAX_EVERY = 20;       // every Nth interaction is a fresh max -> onUpdate
const SAMPLING_INTERVAL = 4096; // bytes; finer than the 32KB default for signal
const MIN_DRIVEN = 450;         // burst must actually record ~all interactions

// TIGHT documented floor for the observer path. The honest path allocates NO
// objects inside its JS frames; what little it samples (~a few KB, platform
// getEntries/Map attribution noise) sits well under this bound. A per-interaction
// object literal in the hot path (500 objects over the burst) would sample far
// above it and break the gate.
const OBSERVER_FLOOR_BYTES = 12 * 1024;   // 12 KiB
// The allocating control must clear the floor by a real margin. Its onUpdate
// churns a fresh 16K-element array each fire, so its observerPath lands far
// above both the floor and the honest path -- well beyond sampling noise.
const CONTROL_MARGIN = 16 * 1024;         // 16 KiB

const INP_SRC = readFileSync(new URL('../../Inp.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '');

// page-side observer setup: honest (noop onUpdate) vs control (allocating).
function setupObserver(cfg) {
    window.__sink = null;
    const onUpdate = cfg.allocating
        ? function () { window.__sink = new Array(16384).fill(0); }
        : function () { /* zero-alloc: primitives only */ };
    // durationThreshold 0 -> the Event Timing spec floor (16 ms) applies; every
    // interaction below drives >= 24 ms so ALL of them register (Map.set floor
    // fully exercised).
    window.__inp = window.createInpObserver({ durationThreshold: 0, onUpdate: onUpdate });
    const total = cfg.burst;
    const step = cfg.step;
    const sched = new Array(total);
    for (let i = 0; i < total; i++) {
        // >= 24 ms so it clears the 16 ms Event Timing floor and registers;
        // every step-th is a strictly rising new max so onUpdate fires.
        sched[i] = (i % step === 0) ? (24 + (i / step) * 8) : 24;
    }
    window.__jank.mode = 'sync';
    window.__jank.schedule = sched;
    window.__jank.idx = 0;
}

const measured = Object.create(null);

async function inject(page) {
    await installJank(page);
    await page.addScriptTag({ content: INP_SRC });
}

function makeScenario(name, allocating) {
    return {
        name: name,
        async run(ctx) {
            await ctx.eval(setupObserver, { allocating: allocating, burst: BURST, step: NEW_MAX_EVERY });
            // Warm one interaction so first-call setup is excluded, then GC and
            // start sampling so only burst allocation is measured.
            await ctx.tap(HOTSPOT.x, HOTSPOT.y);
            await ctx.frame();
            await ctx.cdp.send('HeapProfiler.enable');
            await ctx.cdp.send('HeapProfiler.collectGarbage');
            await ctx.cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL });
            for (let i = 0; i < BURST; i++) {
                await ctx.tap(HOTSPOT.x, HOTSPOT.y);
                await ctx.frame();
            }
            const res = await ctx.cdp.send('HeapProfiler.stopSampling');
            await ctx.cdp.send('HeapProfiler.disable');
            measured[name] = {
                total: sumSamples(res.profile),
                observerBytes: sumObserverPath(res.profile)
            };
        }
    };
}

function collect(page) {
    return page.evaluate(function () {
        const inp = window.__inp.getINP();
        return { inp: inp ? inp.duration : null, count: window.__inp.interactionCount };
    });
}

// --- run ------------------------------------------------------------------
let exitCode = 0;
try {
    const results = await runScenarios({
        pageUrl: 'about:blank',
        inject: inject,
        scenarios: [makeScenario('honest', false), makeScenario('control', true)],
        collect: collect,
        options: { headless: true, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    const snap = Object.create(null);
    for (const r of results) snap[r.name] = r.snapshot;

    const honest = { m: measured.honest, s: snap.honest };
    const control = { m: measured.control, s: snap.control };

    if (!honest.m || !control.m) {
        fail('a run did not record a heap sample');
    } else {
        console.log('  honest : total=' + kb(honest.m.total) +
            ' observerPath=' + kb(honest.m.observerBytes) +
            ' interactions=' + honest.s.count + ' inp=' + honest.s.inp);
        console.log('  control: total=' + kb(control.m.total) +
            ' observerPath=' + kb(control.m.observerBytes) +
            ' interactions=' + control.s.count + ' inp=' + control.s.inp);
        console.log('  FLOOR(observerPath)=' + kb(OBSERVER_FLOOR_BYTES) +
            ' controlMargin>=' + kb(CONTROL_MARGIN));

        // BUG-A guard: the burst must actually drive ~all interactions.
        if (honest.s.count < MIN_DRIVEN) {
            fail('honest run recorded only ' + honest.s.count + ' interactions (< ' + MIN_DRIVEN + ') -- burst under-drove');
        }
        if (control.s.count < MIN_DRIVEN) {
            fail('control run recorded only ' + control.s.count + ' interactions (< ' + MIN_DRIVEN + ') -- burst under-drove');
        }

        // Fail-closed: both zero means the sampler is broken -> no teeth.
        if (honest.m.observerBytes === 0 && control.m.observerBytes === 0) {
            fail('both observerPaths sampled 0 -- sampler broken, gate has no teeth');
        }

        // 1) Honest observer path at/under the tight documented floor.
        if (honest.m.observerBytes > OBSERVER_FLOOR_BYTES) {
            fail('observer path OVER floor: honest observerPath ' + kb(honest.m.observerBytes) + ' > ' + kb(OBSERVER_FLOOR_BYTES));
        }
        // 2) The allocating control is flagged: over the floor AND clearly above
        //    the honest path.
        const controlFlagged = control.m.observerBytes > OBSERVER_FLOOR_BYTES &&
            (control.m.observerBytes - honest.m.observerBytes) >= CONTROL_MARGIN;
        if (!controlFlagged) {
            fail('allocating-onUpdate control NOT flagged: control observerPath ' +
                kb(control.m.observerBytes) + ' vs honest ' + kb(honest.m.observerBytes) +
                ' (floor ' + kb(OBSERVER_FLOOR_BYTES) + ', margin ' + kb(CONTROL_MARGIN) +
                ') -- gate has no teeth');
        }

        if (exitCode === 0) {
            console.log('GATE alloc.cdp honestObserverPath=' + honest.m.observerBytes +
                'B floor=' + OBSERVER_FLOOR_BYTES + 'B controlObserverPath=' +
                control.m.observerBytes + 'B controlFlagged=true | ok');
        }
    }
} catch (e) {
    console.error('GATE alloc.cdp FAIL: ' + e.message);
    exitCode = 1;
}
process.exit(exitCode);

function fail(msg) { console.error('  FAIL ' + msg); exitCode = 1; }
function kb(b) { return (b / 1024).toFixed(1) + 'KB'; }
