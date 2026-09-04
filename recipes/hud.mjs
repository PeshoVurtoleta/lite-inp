// recipes/hud.mjs -- lite-inp INP into a @zakkster/lite-hud panel.
//
// Repo-only example (never in files[]). Polls the zero-alloc getINPInto reader
// at 1 Hz and pushes the current INP into a manual lite-hud channel. The poll
// reuses ONE scratch entry, so the recipe adds no per-tick allocation of its
// own on top of the library's zero-GC observer path.
//
// API surface used, all from @zakkster/lite-hud@2 llms.txt:
//   hud.channel({ name, unit, kind }) -> { push(value) }   -- manual channel
//   ch.push(value)                                         -- one LEVEL record
//
// KIND_LEVEL === 0 (a time-series level). See the lite-hud protocol constants.

const KIND_LEVEL = 0;

export function createInpHudBridge(opts) {
    if (!opts || !opts.observer || !opts.hud) {
        throw new Error("createInpHudBridge: { observer, hud } are required");
    }
    const observer = opts.observer;
    const hud = opts.hud;
    const channelName = opts.channel || 'inp';
    const intervalMs = opts.intervalMs || 1000;

    const ch = hud.channel({ name: channelName, unit: 'ms', kind: KIND_LEVEL });

    // Reused across every poll -- the recipe allocates nothing per tick.
    const scratch = {
        duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
        startTime: 0, eventType: '', interactionId: 0, attribution: null
    };

    let timer = null;

    // Fail closed: getINPInto returns false until an interaction is recorded, and
    // we push nothing rather than a fake zero (null is not zero).
    function poll() {
        if (observer.getINPInto(scratch)) { ch.push(scratch.duration); return true; }
        return false;
    }

    function start(ms) {
        stop();
        timer = setInterval(poll, ms || intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return handle;
    }

    function stop() {
        if (timer !== null) { clearInterval(timer); timer = null; }
    }

    const handle = { poll: poll, start: start, stop: stop, channel: ch };
    return handle;
}
