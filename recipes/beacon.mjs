// recipes/beacon.mjs -- report INP once, on page hide, via a beacon.
//
// Repo-only example (never in files[]). INP is a page-lifetime metric: the
// honest moment to report it is when the page is being hidden/unloaded, which
// is the last point the value is final. This wires visibilitychange -> a single
// beacon carrying the current INP and its attribution.
//
// Fail closed: nothing is sent when there is no interaction yet (getINP() is
// null), and the beacon fires at most once per page view (INP is reported once).

export function createInpBeacon(opts) {
    if (!opts || !opts.observer || !opts.url) {
        throw new Error("createInpBeacon: { observer, url } are required");
    }
    const observer = opts.observer;
    const url = opts.url;
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    // Injectable for tests; defaults to navigator.sendBeacon when present.
    const send = opts.sendBeacon ||
        (typeof navigator !== 'undefined' && navigator.sendBeacon
            ? navigator.sendBeacon.bind(navigator) : null);

    let sent = false;

    // Cold path (fires once, on hide): allocating a JSON payload is fine here.
    function buildPayload() {
        const inp = observer.getINP();
        if (inp === null) return null;              // fail closed: nothing final
        const at = inp.attribution;
        return {
            inp: inp.duration,
            inputDelay: inp.inputDelay,
            processingTime: inp.processingTime,
            presentationDelay: inp.presentationDelay,
            eventType: inp.eventType,
            phase: at ? at.phase : null,
            target: at ? at.target : null,
            ts: Date.now()
        };
    }

    function flush() {
        if (sent) return false;
        if (send === null) return false;            // fail closed: no transport
        const payload = buildPayload();
        if (payload === null) return false;
        sent = true;
        return send(url, JSON.stringify(payload));
    }

    function onVisibility() {
        if (doc !== null && doc.visibilityState === 'hidden') flush();
    }

    function start() {
        if (doc !== null) doc.addEventListener('visibilitychange', onVisibility);
        return handle;
    }

    function stop() {
        if (doc !== null) doc.removeEventListener('visibilitychange', onVisibility);
    }

    const handle = { flush: flush, start: start, stop: stop, buildPayload: buildPayload };
    return handle;
}
