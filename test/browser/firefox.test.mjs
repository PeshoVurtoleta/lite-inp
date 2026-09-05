// test/browser/firefox.test.mjs -- node --test test/browser/firefox.test.mjs
//
// THE FIREFOX LANE (repo-only harness, never in files[]).
// Runs the SAME differential corpus as oracle.test.mjs, but in real Playwright
// Firefox 153 (bundled with Playwright 1.62.1) through the runner's CDP-OPTIONAL
// seam (browserType: 'firefox' -> ctx.cdp === null -> ctx.tap uses page.mouse).
//
// Firefox speaks Juggler, NOT the Chrome DevTools Protocol, so there is no
// HeapProfiler: the allocation gate stays Chromium-only. This lane proves the
// two things that ARE observable without CDP:
//
//   1. PARITY. |lite-inp INP - web-vitals INP| <= 8 ms on EVERY scenario in the
//      corpus, wrap600 included. web-vitals DOES run under Playwright Firefox
//      (onINP fires, reportAllChanges), so the differential oracle is real here
//      too. Teeth: the v1.0.0 recency-only control diverges >= 8 ms on wrap600.
//
//   2. GRACEFUL DEGRADATION -- the exact, MEASURED Firefox-153 attribution story
//      (not assumed; probed 2026-09-05):
//        - loafSupported === false: `long-animation-frame` is absent from
//          supportedEntryTypes, so there is NO script/LoAF attribution.
//        - attribution !== null: getINP().attribution is still a real object.
//        - attribution.loafs.length === 0: empty, because there is no LoAF feed.
//          TEETH: this is a real degradation signal, not a null-attribution
//          artifact -- attribution is non-null and target IS populated, so an
//          empty loafs[] means specifically "no script attribution", which is
//          what a shimmed LoAF feed (loafs.length > 0) would contradict.
//        - attribution.target is a non-null "tag#id" string: PerformanceEvent-
//          Timing.target IS exposed in FF 153, so ELEMENT attribution WORKS.
//        - attribution.phase is computed (processing vs presentation) from the
//          Event-Timing entry timings alone -- works without LoAF.
//
//   3. INTERACTION GROUPING. N discrete taps -> interactionCount === N: each
//      Playwright click is pointerdown+pointerup+click sharing one interactionId.
//      Control: mousedown/mouseup carry interactionId 0 and the observer's
//      `if (!iid) continue` guard means they never increment the count.
//
// Browser policy: FAIL-CLOSED. LITE_NO_BROWSER=1 -> loud SKIP (exit 0). A
// MISSING Firefox binary is a loud FAILURE, never a silent pass. This lane is
// NOT in `verify` (no FF-binary guarantee in every env); it runs under
// `verify:all` / `test:browser-ff`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { firefox } from 'playwright';
import { runScenarios } from './runner.mjs';
import { SCENARIOS, installJank, HOTSPOT } from './scenarios.mjs';
import { controlV100INP } from './control.v100.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
const QUANT = 8; // ms: Event-Timing duration quantization budget.
const GROUP_TAPS = 3; // discrete taps -> distinct interactionIds -> count 3.

if (SKIP) {
    console.log('GATE firefox-lane SKIPPED (LITE_NO_BROWSER=1) -- Node + Chromium lanes still gate.');
} else {
    // Fail closed: a missing Firefox binary is a loud FAILURE, not a silent pass.
    const bin = firefox.executablePath();
    if (!bin || !existsSync(bin)) {
        console.error('GATE firefox-lane FAIL: Firefox binary not found at ' + bin +
            ' -- run `npx playwright install firefox`. (Fail closed: a missing binary is never a silent pass.)');
        process.exit(1);
    }
}

const INP_SRC = readFileSync(new URL('../../Inp.js', import.meta.url), 'utf8')
    // Harness-only transform: turn the shipped ESM module into a classic script
    // so createInpObserver is a page global. Inp.js on disk is NOT modified.
    .replace(/^export /gm, '');
const WV_SRC = readFileSync(
    new URL('../../node_modules/web-vitals/dist/web-vitals.attribution.iife.js', import.meta.url),
    'utf8'
);

async function inject(page) {
    await installJank(page);
    await page.addScriptTag({ content: WV_SRC });
    await page.addScriptTag({ content: INP_SRC });
    await page.evaluate(function () {
        window.__inp = window.createInpObserver({ durationThreshold: 16 });
        window.__wv = null;
        // eslint-disable-next-line no-undef
        webVitals.onINP(function (m) { window.__wv = m.value; },
            { reportAllChanges: true, durationThreshold: 16 });
    });
}

function collect(page) {
    return page.evaluate(function () {
        const inp = window.__inp.getINP();
        const inters = window.__inp.getInteractions();
        const durs = new Array(inters.length);
        for (let i = 0; i < inters.length; i++) durs[i] = inters[i].duration;
        const at = inp ? inp.attribution : null;
        return {
            liteInp: inp ? inp.duration : null,
            liteInpGetter: window.__inp.inp,
            webVitals: window.__wv,
            interactions: durs,
            interactionCount: window.__inp.interactionCount,
            lifetimeCount: performance.interactionCount || 0,
            loafSupported: window.__inp.loafSupported,
            attributionIsNull: at === null,
            attributionLoafsIsArray: at ? Array.isArray(at.loafs) : null,
            attributionLoafsLen: at ? at.loafs.length : null,
            attributionTarget: at ? at.target : null,
            attributionPhase: at ? at.phase : null
        };
    });
}

// A dedicated grouping scenario: GROUP_TAPS discrete 100 ms sync taps on the
// installJank hotspot (div#hotspot), each above the 16 ms threshold, on a fresh
// page. Owns its tap count so the grouping assertion is explicit, not coupled to
// another scenario's driveTaps.
const groupingScenario = {
    name: 'ff-grouping',
    async run(ctx) {
        await ctx.eval(function () {
            window.__jank.mode = 'sync';
            window.__jank.schedule = [100];
            window.__jank.idx = 0;
        });
        for (let i = 0; i < GROUP_TAPS; i++) {
            await ctx.tap(HOTSPOT.x, HOTSPOT.y);
            await ctx.frame();
        }
        await ctx.wait(400);
        await ctx.frame();
    }
};

const FF_SCENARIOS = SCENARIOS.concat([groupingScenario]);

test('firefox lane: parity, graceful degradation, interaction grouping', { skip: SKIP }, async () => {
    const results = await runScenarios({
        browserType: 'firefox',
        pageUrl: 'about:blank',
        inject: inject,
        scenarios: FF_SCENARIOS,
        collect: collect,
        options: { headless: true, onLog: function (s) { console.log('  [ff] ' + s); } }
    });

    // A silently dropped scenario must fail the lane, not just a missing wrap600.
    assert.equal(results.length, FF_SCENARIOS.length,
        'expected ' + FF_SCENARIOS.length + ' scenario results, got ' + results.length);

    const byName = {};
    for (const r of results) byName[r.name] = r.snapshot;

    // --- 1. PARITY across the whole corpus ----------------------------------
    let wrapSeen = false;
    for (const r of results) {
        const s = r.snapshot;
        console.log('  ' + r.name.padEnd(16) +
            ' lite=' + fmt(s.liteInp) +
            ' web-vitals=' + fmt(s.webVitals) +
            ' interactions=' + s.interactionCount +
            ' lifetime=' + s.lifetimeCount);

        // obs.inp (the O(1) zero-alloc getter) must equal getINP().duration on
        // EVERY scenario, and both null together when nothing above-threshold.
        assert.equal(s.liteInp === null, s.liteInpGetter === null,
            r.name + ': obs.inp and getINP() disagree on null (inp=' +
            fmt(s.liteInpGetter) + ' getINP=' + fmt(s.liteInp) + ')');
        if (s.liteInp !== null) {
            assert.equal(s.liteInpGetter, s.liteInp,
                r.name + ': obs.inp (' + fmt(s.liteInpGetter) +
                ') must equal getINP().duration (' + fmt(s.liteInp) + ')');
        }

        // Both read the same threshold-16 feed: either both see an above-
        // threshold INP, or neither does. Agreement includes agreeing on "none".
        if (s.liteInp === null || s.webVitals === null) {
            assert.ok(s.liteInp === null && (s.webVitals === null || s.webVitals <= QUANT),
                r.name + ': one side null but the other reported ' +
                fmt(s.liteInp) + ' / ' + fmt(s.webVitals));
            continue;
        }

        const delta = Math.abs(s.liteInp - s.webVitals);
        assert.ok(delta <= QUANT,
            r.name + ': |lite-inp - web-vitals| = ' + delta.toFixed(1) +
            ' ms exceeds ' + QUANT + ' ms (lite=' + s.liteInp + ' wv=' + s.webVitals + ')');

        if (r.name === 'wrap600') {
            wrapSeen = true;
            // The ring really wrapped.
            assert.ok(s.lifetimeCount >= 512,
                'wrap600: expected the recency ring to wrap (lifetimeCount ' +
                s.lifetimeCount + ' < 512)');

            // TEETH: the v1.0.0 recency-only control, fed the SAME data, must
            // disagree with web-vitals by >= 8 ms. If it does not, the harness
            // could not have caught IN-01 and this oracle is worthless.
            const control = controlV100INP(s.interactions, s.lifetimeCount);
            const controlDelta = Math.abs(control - s.webVitals);
            console.log('  wrap600 control(v1.0.0 recency-only)=' + fmt(control) +
                ' -> disagrees with web-vitals by ' + controlDelta.toFixed(1) + ' ms');
            assert.ok(controlDelta >= QUANT,
                'wrap600: v1.0.0 control must disagree with web-vitals by >= ' +
                QUANT + ' ms, got ' + controlDelta.toFixed(1) +
                ' (control=' + control + ' wv=' + s.webVitals + ') -- oracle has no teeth');
        }
    }
    assert.ok(wrapSeen, 'wrap600 scenario did not run under Firefox');

    // --- 2. GRACEFUL DEGRADATION (measured FF-153 story) --------------------
    // Read from sync-block: a clear above-threshold INP with a targeted element.
    const deg = byName['sync-block'];
    console.log('  degradation      loafSupported=' + deg.loafSupported +
        ' attributionNull=' + deg.attributionIsNull +
        ' loafs=' + deg.attributionLoafsLen +
        ' target=' + deg.attributionTarget +
        ' phase=' + deg.attributionPhase);
    assert.equal(deg.loafSupported, false,
        'FF 153: long-animation-frame is absent from supportedEntryTypes -> loafSupported === false');
    assert.notEqual(deg.liteInp, null,
        'sync-block: expected a recorded above-threshold interaction to read attribution from');
    assert.equal(deg.attributionIsNull, false,
        'FF: getINP().attribution is a NON-NULL object even without LoAF (do NOT claim it is null)');
    assert.equal(deg.attributionLoafsIsArray, true,
        'FF: attribution.loafs must be a real Array, not merely {length:0} -- got isArray=' +
        deg.attributionLoafsIsArray);
    assert.equal(deg.attributionLoafsLen, 0,
        'FF: attribution.loafs is EMPTY -- no LoAF feed, so no script attribution');
    assert.ok(typeof deg.attributionTarget === 'string' && /^[a-z][a-z0-9]*[#.]/.test(deg.attributionTarget),
        'FF: element attribution WORKS -- target is a non-null tag#id / tag.class string, got ' +
        JSON.stringify(deg.attributionTarget));
    assert.ok(deg.attributionPhase === 'processing' || deg.attributionPhase === 'presentation',
        'FF: phase is computed from Event-Timing timings alone, got ' + deg.attributionPhase);

    // --- 3. INTERACTION GROUPING --------------------------------------------
    // GROUP_TAPS discrete taps -> exactly GROUP_TAPS distinct interactionIds.
    // Control: mousedown/mouseup carry interactionId 0 and never increment the
    // count (the observer's `if (!iid) continue` guard), so the count equals the
    // click count, not the raw pointer-event count.
    const grp = byName['ff-grouping'];
    console.log('  grouping         taps=' + GROUP_TAPS +
        ' interactionCount=' + grp.interactionCount +
        ' lifetime=' + grp.lifetimeCount);
    assert.equal(grp.interactionCount, GROUP_TAPS,
        'ff-grouping: ' + GROUP_TAPS + ' taps must yield ' + GROUP_TAPS +
        ' distinct interactions (each click = one interactionId), got ' + grp.interactionCount);
    assert.equal(grp.lifetimeCount, GROUP_TAPS,
        'ff-grouping: performance.interactionCount must count exactly ' + GROUP_TAPS +
        ' interactions (mousedown/mouseup id 0 excluded), got ' + grp.lifetimeCount);

    console.log('GATE firefox-lane parity<=8ms=ok loafSupported=false attribution!=null loafs=0' +
        ' target=' + deg.attributionTarget + ' grouping=' + grp.interactionCount + '/' + GROUP_TAPS +
        ' scenarios=' + results.length + ' | ok');
});

function fmt(v) { return v === null || v === undefined ? 'null' : (Math.round(v * 10) / 10); }
