// recipes/layout.mjs -- cross-reference INP against @zakkster/lite-layout-profiler.
//
// Repo-only example (never in files[]). A presentation-dominated INP means the
// paint blocked, and the most common cause is forced synchronous layout in the
// interaction's own handlers. Running lite-layout-profiler on the same page and
// reading both together turns "the paint was slow" into "here is the reflow that
// made it slow" -- the observability suite composing.
//
// API surface used, all from @zakkster/lite-layout-profiler@1.7 llms.txt:
//   createLayoutProfiler(options?) -> profiler
//   profiler.summary()  -- { total, ... }
//   profiler.destroy()  -- unpatch

import { createLayoutProfiler } from '@zakkster/lite-layout-profiler';

export function createInpLayoutCrossRef(opts) {
    if (!opts || !opts.observer) {
        throw new Error("createInpLayoutCrossRef: { observer } is required");
    }
    const observer = opts.observer;
    // Bring your own profiler, or we make a CI-counting one (no stacks, no cost)
    // and own its teardown.
    const ownProfiler = !opts.profiler;
    const profiler = opts.profiler ||
        createLayoutProfiler({ captureStacks: false, measureCost: false });

    // Cold path: reads both instruments and joins them.
    function report() {
        const inp = observer.getINP();
        const summary = profiler.summary();
        const at = inp ? inp.attribution : null;
        const phase = at ? at.phase : null;
        return {
            inp: inp ? inp.duration : null,
            phase: phase,
            target: at ? at.target : null,
            reflows: summary.total,
            // The join: a presentation-dominated INP on a page that is also
            // forcing reflows is a strong signal the paint jank IS the thrash.
            presentationSuspect: phase === 'presentation' && summary.total > 0
        };
    }

    function destroy() {
        if (ownProfiler) profiler.destroy();
    }

    return { report: report, destroy: destroy, profiler: profiler };
}
