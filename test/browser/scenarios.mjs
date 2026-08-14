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

// --- lifecycle scenarios (1.1.0) ------------------------------------------
// A synthetic activationStart, large enough to be unambiguous but small enough
// that reported startTimes stay in a sane range.
export const PRERENDER_OFFSET = 50; // ms

// Probes filled in by the lifecycle scenarios and read by the oracle. Kept as
// module state (like alloc.cdp's `measured`) because their signal is captured
// mid-run, not from the end-of-run collect snapshot.
export const bfcacheProbe = { prePeak: null, postInp: null };
export const prerenderProbe = { sBefore: null, sAfter: null, offset: PRERENDER_OFFSET };

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
    },
    {
        // bfcache-restore: a bfcache restore is a NEW page view. Drive a burst
        // whose worst interaction is a clear ~500 ms-class peak, capture that
        // pre-restore INP, fire a genuine persisted pageshow (the exact event
        // and code path the browser dispatches on a real bfcache restore --
        // dispatched in-page so the observer's real listener runs resetState),
        // then drive a smaller second burst. Post-restore INP must reflect ONLY
        // the second page view: the 500 ms peak is gone.
        //
        // Real navigation posture: SYNTHETIC-FIRST. A best-effort real
        // ctx.goto+ctx.back round-trip is attempted first; headless Chromium on
        // an about:blank + addScriptTag page (instrumented once, inject not
        // re-run) is not bfcache-eligible, so it does not preserve the
        // instrumented globals -- the synthetic persisted pageshow is the gate.
        // See test/browser/honesty.md.
        name: 'bfcache-restore',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'sync', schedule: [500, 300, 260] });
            await driveTaps(ctx, 3);
            bfcacheProbe.prePeak = await ctx.eval(function () {
                return window.__inp.inp;
            });

            // Best-effort real bfcache (non-gating, fully guarded, never stalls).
            bfcacheProbe.real = await tryRealBfcacheRestore(ctx);

            // The restore itself: a real PageTransitionEvent with persisted:true.
            // Both lite-inp (resetState) and web-vitals (onBFCacheRestore) reset.
            await ctx.eval(function () {
                window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
            });

            // Second page view: only short interactions.
            await ctx.eval(setJank, { mode: 'sync', schedule: [90] });
            await driveTaps(ctx, 5);
            bfcacheProbe.postInp = await ctx.eval(function () {
                return window.__inp.inp;
            });
        }
    },
    {
        // prerender-offset: interaction timestamps are relative to time origin;
        // after a prerendered page is activated, absolute times must be reported
        // relative to activationStart. Drive interactions, snapshot a reported
        // startTime with actOffset == 0, then expose a synthetic non-zero
        // activationStart and fire the real prerenderingchange event so the
        // observer re-reads it. Re-reading the SAME interaction's startTime must
        // now be smaller by exactly activationStart (duration is a delta -- it is
        // unaffected, so web-vitals parity on the INP value still holds).
        //
        // Real navigation posture: SYNTHETIC-FIRST. A genuine prerender is not
        // drivable in this headless harness, so activationStart is injected via
        // an in-page performance.getEntriesByType shim + a real prerenderingchange
        // event. See test/browser/honesty.md.
        name: 'prerender-offset',
        async run(ctx) {
            await ctx.eval(setJank, { mode: 'sync', schedule: [120] });
            await driveTaps(ctx, 6);
            prerenderProbe.sBefore = await ctx.eval(function () {
                const xs = window.__inp.getInteractions();
                return xs.length ? xs[0].startTime : null;
            });
            prerenderProbe.offset = await ctx.eval(function (offset) {
                // Expose activationStart on the navigation entry without mutating
                // the real one, then fire the real prerenderingchange event.
                const realGet = performance.getEntriesByType.bind(performance);
                performance.getEntriesByType = function (type) {
                    const r = realGet(type);
                    if (type === 'navigation' && r && r[0]) {
                        const proxy = Object.create(r[0]);
                        Object.defineProperty(proxy, 'activationStart', { value: offset });
                        return [proxy];
                    }
                    return r;
                };
                document.dispatchEvent(new Event('prerenderingchange'));
                return offset;
            }, PRERENDER_OFFSET);
            prerenderProbe.sAfter = await ctx.eval(function () {
                const xs = window.__inp.getInteractions();
                return xs.length ? xs[0].startTime : null;
            });
        }
    }
];

// Best-effort real bfcache restore. Non-gating: it must NEVER stall or corrupt
// the instrumented page. In the about:blank + addScriptTag oracle harness the
// page is instrumented once (inject is not re-run on navigation) and about:blank
// is not bfcache-eligible, so a real goto/back round-trip would drop the
// instrumented globals -- this returns false and the caller uses the synthetic
// persisted pageshow. The runner's ctx.goto/ctx.back/routes seam is proven
// separately (see oracle.test.mjs 'runner nav seam'); driving it here would
// require re-instrumentation this seam does not own.
async function tryRealBfcacheRestore(ctx) {
    ctx.log('bfcache-restore: real navigation not drivable on about:blank harness; using synthetic persisted pageshow');
    return false;
}
