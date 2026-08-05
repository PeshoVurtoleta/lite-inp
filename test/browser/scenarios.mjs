// test/browser/scenarios.mjs
//
// Deterministic, replayable interaction scenarios + the shared page jank
// instrumentation they drive. Package-agnostic: the jank handler produces real
// Event-Timing interactions; nothing here reads lite-inp. A caller's `inject`
// calls installJank(page) to wire the hotspot + handler, then loads whatever
// observers it wants on top.
//
// JANK CONTRACT (page globals owned by installJank):
//   window.__jank = { mode, schedule, idx, rafSteps }
//     mode      'sync'  busy-wait schedule[idx] ms synchronously in the handler
//               'raf'   spread schedule[idx] ms across rafSteps rAFs (grows the
//                       presentation delay, not the input delay)
//               'thrash' forced-reflow loop for ~schedule[idx] ms
//     schedule  Float64 array of target busy-ms, one value consumed per
//               interaction (idx advances, wraps on overflow). DETERMINISTIC:
//               a seeded fixed array + a busy-wait spinning on performance.now()
//               until the target elapsed -- never Math.random, never a timer.
//   window.__hotspot = { x, y }  viewport coords of the clickable target.
//
// Each scenario.run(ctx) sets __jank via ctx.eval, dispatches N trusted taps at
// __hotspot through ctx.tap, and settles before returning so every observer
// callback has flushed.

export const HOTSPOT = { x: 200, y: 200 };

// installJank -- build the hotspot DOM + the deterministic jank handler.
// Called from a caller's `inject`. page.evaluate runs pageInit in the page.
export function installJank(page) {
    return page.evaluate(function (hotspot) {
        // Deterministic busy-wait: spin until `ms` of wall time elapse. No RNG.
        window.__busywait = function (ms) {
            const end = performance.now() + ms;
            // Touch a live accumulator so the loop is not dead-code-eliminated.
            let acc = 0;
            while (performance.now() < end) { acc += 1; }
            window.__jankAcc = (window.__jankAcc | 0) + (acc & 1);
        };

        window.__jank = { mode: 'sync', schedule: [0], idx: 0, rafSteps: 4 };
        window.__hotspot = { x: hotspot.x, y: hotspot.y };

        const el = document.createElement('div');
        el.id = 'hotspot';
        el.textContent = 'hotspot';
        el.style.cssText =
            'position:fixed;left:0;top:0;width:400px;height:400px;' +
            'background:#4477ff;color:#fff;font:16px sans-serif;' +
            'display:flex;align-items:center;justify-content:center;' +
            'user-select:none;touch-action:none;';
        document.body.appendChild(el);

        function nextMs() {
            const j = window.__jank;
            const s = j.schedule;
            const ms = s[j.idx % s.length];
            j.idx++;
            return ms;
        }

        function thrash(ms) {
            const end = performance.now() + ms;
            let acc = 0;
            while (performance.now() < end) {
                el.style.width = (400 + (acc & 7)) + 'px';
                acc += el.offsetHeight; // forced synchronous reflow every read
            }
            window.__jankAcc = (window.__jankAcc | 0) + (acc & 1);
        }

        function rafChain(ms, steps) {
            const chunk = ms / steps;
            let left = steps;
            function tick() {
                window.__busywait(chunk);
                left--;
                if (left > 0) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        }

        // The interaction driver. INP counts the pointerup as the interaction's
        // driving event; blocking here inflates the recorded duration.
        el.addEventListener('pointerup', function () {
            const j = window.__jank;
            const ms = nextMs();
            if (j.mode === 'thrash') { thrash(ms); return; }
            if (j.mode === 'raf') { rafChain(ms, j.rafSteps); return; }
            window.__busywait(ms); // 'sync' (and 'clean' with ms 0)
        });
    }, hotspot());
}

function hotspot() { return { x: HOTSPOT.x, y: HOTSPOT.y }; }

// setJank -- page-side helper body used via ctx.eval to load a schedule.
function setJank(cfg) {
    window.__jank.mode = cfg.mode;
    window.__jank.schedule = cfg.schedule;
    window.__jank.rafSteps = cfg.rafSteps || 4;
    window.__jank.idx = 0;
}

// Drive `count` trusted taps, one painted frame between each, then settle so
// web-vitals' idle/animation-frame flush and lite-inp's observer have both run.
async function driveTaps(ctx, count) {
    const h = HOTSPOT;
    for (let i = 0; i < count; i++) {
        await ctx.tap(h.x, h.y);
        await ctx.frame();
    }
    await ctx.wait(400);
    await ctx.frame();
}

// --- wrap600 schedule -----------------------------------------------------
// 600 interactions, interactionCap default 512 -> the recency ring wraps and
// evicts the first 88. The LARGE interactions all fall in the evicted region:
// a recency-only estimator (the v1.0.0 bug, IN-01) can never see them, but the
// page-lifetime longest-N list -- and web-vitals -- do. This is the catcher.
export const WRAP_LARGE = 15; // count of large early interactions (< 88 evicted)
function buildWrap600Schedule() {
    const total = 600;
    const s = new Array(total);
    for (let i = 0; i < total; i++) {
        // i < 15: large, strictly descending 500..220 (step 20), all evicted.
        // else:   short 40 ms, above the 16 ms threshold, dominate live window.
        s[i] = i < WRAP_LARGE ? (500 - i * 20) : 40;
    }
    return s;
}

export const SCENARIOS = [
    {
        name: 'sync-block',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'sync', schedule: [120] });
            await driveTaps(ctx, 6);
        }
    },
    {
        name: 'raf-chain',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'raf', schedule: [120], rafSteps: 6 });
            await driveTaps(ctx, 6);
        }
    },
    {
        name: 'layout-thrash',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'thrash', schedule: [100] });
            await driveTaps(ctx, 6);
        }
    },
    {
        name: 'clean',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'sync', schedule: [0] });
            await driveTaps(ctx, 8);
        }
    },
    {
        name: 'wrap600',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'sync', schedule: buildWrap600Schedule() });
            await driveTaps(ctx, 600);
        }
    }
];
