// test/browser/oracle.test.mjs -- node --test test/browser/oracle.test.mjs
//
// THE DIFFERENTIAL ORACLE.
// Runs each scenario in one real Chromium, side by side:
//   - web-vitals (attribution build, onINP, reportAllChanges) -- the oracle.
//   - this package's getINP().duration.
// Both consume the SAME browser Event-Timing feed at the SAME durationThreshold,
// so any disagreement beyond 8 ms quantization is a real algorithm difference.
//
// Asserts |lite-inp - web-vitals| <= 8 ms across the corpus, INCLUDING wrap600
// (the ring-wrap catcher). Then feeds the SAME data to the v1.0.0 recency-only
// control and asserts THAT disagrees with web-vitals by >= 8 ms on wrap600 --
// proving the oracle has teeth.
//
// Browser policy: FAIL-CLOSED. Missing Chromium is a failure, NOT a skip, unless
// LITE_NO_BROWSER=1, in which case this lane skips loudly and the Node lanes
// still gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenarios } from './runner.mjs';
import { SCENARIOS, installJank } from './scenarios.mjs';
import { controlV100INP } from './control.v100.mjs';

const SKIP = process.env.LITE_NO_BROWSER === '1';
const QUANT = 8; // ms: Event-Timing duration quantization budget.

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
        return {
            liteInp: inp ? inp.duration : null,
            liteCurrent: window.__inp.currentINP,
            webVitals: window.__wv,
            interactions: durs,
            interactionCount: window.__inp.interactionCount,
            lifetimeCount: performance.interactionCount || 0
        };
    });
}

test('oracle: lite-inp agrees with web-vitals across the scenario corpus', { skip: SKIP }, async () => {
    const results = await runScenarios({
        pageUrl: 'about:blank',
        inject: inject,
        scenarios: SCENARIOS,
        collect: collect,
        options: { headless: true, onLog: function (s) { console.log('  [runner] ' + s); } }
    });

    // A silently dropped scenario must fail the lane, not just a missing wrap600.
    assert.equal(results.length, SCENARIOS.length,
        'expected ' + SCENARIOS.length + ' scenario results, got ' + results.length);

    let wrapSeen = false;
    for (const r of results) {
        const s = r.snapshot;
        console.log('  ' + r.name.padEnd(14) +
            ' lite=' + fmt(s.liteInp) +
            ' web-vitals=' + fmt(s.webVitals) +
            ' interactions=' + s.interactionCount +
            ' lifetime=' + s.lifetimeCount);

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
    assert.ok(wrapSeen, 'wrap600 scenario did not run');
});

function fmt(v) { return v === null || v === undefined ? 'null' : (Math.round(v * 10) / 10); }

if (SKIP) console.log('[oracle] LITE_NO_BROWSER=1 -- browser lane SKIPPED (Node lanes still gate).');
