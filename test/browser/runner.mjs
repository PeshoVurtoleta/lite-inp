// test/browser/runner.mjs
//
// runScenarios -- the LIFTABLE SEAM.
// =================================================================
// Package-agnostic Playwright driver for observability harnesses. NOTHING in
// this file's signature or body is lite-inp specific: it launches a real
// browser, opens one fresh page per scenario, lets the CALLER instrument the
// page (`inject`), lets each SCENARIO drive real trusted input (`run`), then
// lets the caller read a JSON snapshot (`collect`). The rest of the
// observability suite (LCP, CLS, long-task, ...) reuses it verbatim.
//
// CDP-OPTIONAL CONTRACT
// ---------------------
// The default engine is Chromium, which exposes CDP -- so ctx.cdp is a live
// CDP session and ctx.tap dispatches trusted input through Input.dispatchMouse-
// Event. When config.browserType is 'firefox' there is NO CDP (Firefox speaks
// Juggler, not the Chrome DevTools Protocol): ctx.cdp is null, every CDP-only
// call (newCDPSession, Input.setIgnoreInputEvents, cdp.detach) is skipped, and
// ctx.tap falls back to page.mouse.move/down/up -- still TRUSTED input under
// Playwright, so interactionId still increments. Any CDP-dependent gate (the
// HeapProfiler allocation lane) is therefore Chromium-only by construction and
// must NOT run under a null-cdp engine.
//
// SEAM CONTRACT
// -------------
// runScenarios({ pageUrl, inject, scenarios, collect, options, browserType })
//   -> Promise<Result[]>
//
//   browserType 'chromium' (default) | 'firefox'
//             Selects the Playwright engine. 'firefox' runs the CDP-optional
//             path above; ctx.cdp is null and no CDP call is issued.
//
//   pageUrl   string
//             URL each scenario page navigates to before instrumentation.
//             'about:blank' is valid; the caller builds the DOM in `inject`.
//
//   inject    async (page, ctx) => void
//             Instruments a freshly navigated page: build DOM, load libraries,
//             start observers, install handlers. Runs ONCE per scenario, after
//             navigation and before any input. `ctx` is the same context object
//             the scenario receives (see below), so `inject` may pre-warm CDP.
//
//   scenarios Array<{ name: string, run: async (ctx) => void }>
//             Each scenario drives input through `ctx` and MUST leave the page
//             settled (all observer callbacks flushed) before returning.
//
//   collect   async (page, ctx) => any
//             Returns a structured-clonable JSON snapshot for the scenario.
//
//   routes    optional { [url: string]: string } | (url) => string | null
//             In-memory HTTP routes. When provided, every navigation request is
//             intercepted: a matching entry is fulfilled with its HTML body, so
//             a scenario can drive real multi-page / bfcache navigation with
//             ctx.goto/ctx.back without a server. Nothing here is domain
//             specific -- a route is just a URL -> HTML string.
//
//   options   { headless?: boolean, viewport?: {width,height}, onLog?: (s)=>void }
//             viewport defaults to 800x600; nothing about it is baked in.
//
// ctx (handed to inject, run, collect) -- generic browser primitives only:
//   ctx.page              Playwright Page.
//   ctx.cdp               Attached CDP session (Chrome DevTools Protocol), or
//                         null under a non-Chromium engine (see CDP-OPTIONAL).
//   ctx.tap(x, y)         Dispatch ONE trusted left click at viewport (x,y):
//                         via CDP Input.dispatchMouseEvent (move+press+release)
//                         under Chromium, or page.mouse.move/down/up when cdp is
//                         null. Both are TRUSTED input, which is what makes
//                         interactionId increment -- synthetic element.click()
//                         does NOT. Resolves after the browser has dispatched
//                         (handlers have run).
//   ctx.frame()           Await two rAFs (one painted frame boundary).
//   ctx.wait(ms)          Await ms of wall time in the page.
//   ctx.eval(fn, ...args) page.evaluate passthrough.
//   ctx.goto(url)         Navigate the page to url (uses config.routes when set).
//   ctx.back()            Navigate back in history (Playwright page.goBack).
//   ctx.log(s)            options.onLog passthrough.
//
// The caller owns Playwright/CDP semantics; this seam owns nothing domain
// specific. Do not add a lite-inp import here -- if you need one, you are in the
// wrong file.
// =================================================================

import { chromium, firefox } from 'playwright';

export async function runScenarios(config) {
    const pageUrl = config.pageUrl || 'about:blank';
    const inject = config.inject;
    const scenarios = config.scenarios || [];
    const collect = config.collect;
    const routes = config.routes || null;
    const options = config.options || {};
    const headless = options.headless !== false;
    const viewport = options.viewport || { width: 800, height: 600 };
    const onLog = typeof options.onLog === 'function' ? options.onLog : function () {};
    const browserType = config.browserType || 'chromium';

    if (typeof inject !== 'function') throw new Error('runScenarios: inject must be a function');
    if (typeof collect !== 'function') throw new Error('runScenarios: collect must be a function');
    if (browserType !== 'chromium' && browserType !== 'firefox')
        throw new Error("runScenarios: browserType must be 'chromium' or 'firefox', got " + browserType);

    const isChromium = browserType === 'chromium';
    const engine = isChromium ? chromium : firefox;

    const browser = await engine.launch({ headless: headless });
    const results = [];
    try {
        for (let i = 0; i < scenarios.length; i++) {
            const scenario = scenarios[i];
            const page = await browser.newPage({ viewport: viewport });
            // CDP is Chromium-only. Under Firefox there is no CDP session:
            // cdp stays null and ctx.tap falls back to page.mouse (see makeCtx).
            let cdp = null;
            if (isChromium) {
                cdp = await page.context().newCDPSession(page);
                await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(function () {});
            }

            if (routes !== null) await registerRoutes(page, routes);

            const ctx = makeCtx(page, cdp, onLog);

            await page.goto(pageUrl);
            await inject(page, ctx);
            onLog('scenario ' + scenario.name + ': injected');
            await scenario.run(ctx);
            const snapshot = await collect(page, ctx);
            onLog('scenario ' + scenario.name + ': collected');
            results.push({ name: scenario.name, snapshot: snapshot });

            if (cdp !== null) await cdp.detach().catch(function () {});
            await page.close();
        }
    } finally {
        await browser.close();
    }
    return results;
}

function makeCtx(page, cdp, onLog) {
    async function tap(x, y) {
        // cdp === null (Firefox): fall back to Playwright's trusted mouse input.
        // page.mouse.move/down/up is a real pointerdown+pointerup+click sharing
        // one interactionId, exactly as Input.dispatchMouseEvent is under CDP.
        if (cdp === null) {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.up();
            return;
        }
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0
        });
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1
        });
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1
        });
    }
    function frame() {
        return page.evaluate(function () {
            return new Promise(function (r) {
                requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); });
            });
        });
    }
    function wait(ms) {
        return page.evaluate(function (m) {
            return new Promise(function (r) { setTimeout(r, m); });
        }, ms);
    }
    function goto(url) { return page.goto(url); }
    function back() { return page.goBack(); }
    return {
        page: page,
        cdp: cdp,
        tap: tap,
        frame: frame,
        wait: wait,
        goto: goto,
        back: back,
        eval: function (fn) {
            const args = Array.prototype.slice.call(arguments, 1);
            return page.evaluate(fn, ...args);
        },
        log: onLog
    };
}

// Register in-memory HTTP routes. `routes` is either a { url: html } map or a
// function (url) -> html|null. Any navigation whose URL resolves to an HTML
// body is fulfilled from memory; everything else continues to the network (or
// 404s under Playwright's default). Package-agnostic: a route is URL -> HTML.
async function registerRoutes(page, routes) {
    const lookup = typeof routes === 'function'
        ? routes
        : function (url) {
            if (routes[url] !== undefined) return routes[url];
            for (const key in routes) {
                if (url.indexOf(key) !== -1) return routes[key];
            }
            return null;
        };
    await page.route('**/*', async function (route) {
        const body = lookup(route.request().url());
        if (body != null) {
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
        } else {
            await route.continue();
        }
    });
}
