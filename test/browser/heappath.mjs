// test/browser/heappath.mjs
//
// The CDP HeapProfiler sampling-profile reducers, factored out so the alloc
// gate (alloc.cdp.mjs) and the demo frame gate (demo.frame.mjs) share ONE
// observer-path summer -- the honest floor is defined in exactly one place.
//
// sumObserverPath walks the sampling profile and sums sampled self-size only
// for call frames on the library's callback path (our function names) or the
// caller's onUpdate. Everything else (platform getEntries, GC, page noise) is
// attributed OUTSIDE these frames and does not count. A per-interaction object
// literal inside our frames would show up here and break the gate.

// Frame names on the observer hot path. onUpdate is the caller's callback --
// the demo names its handler `onUpdate`, so an allocating scene-04 toggle lands
// here too, which is the visible control the demo climbs.
export const OBSERVER_FRAMES = new Set([
    'onEventEntry', 'maintainLongest', 'internEventType', 'lnCopyFromSlot',
    'lnBubbleUp', 'lnSwap', 'fillEntryPrimitives', 'onUpdate'
]);

// Demo-lane variant: same helper, narrower frame set. onEventEntry is EXCLUDED
// because its only allocation is the platform `list.getEntries()` array backing
// store, which V8's sampling profiler charges to the JS frame that called it --
// that is platform noise (~50 B/callback), not a per-interaction object of ours.
// Every frame where OUR code could allocate an object stays in: maintainLongest,
// the interning, the longest-N copies, fillEntryPrimitives, and the caller's
// onUpdate (the scene-04 control). A real per-interaction object in our logic
// still shows up here; the getEntries array no longer inflates the floor.
export const DEMO_OBSERVER_FRAMES = new Set([
    'maintainLongest', 'internEventType', 'lnCopyFromSlot',
    'lnBubbleUp', 'lnSwap', 'fillEntryPrimitives', 'onUpdate'
]);

export function sumSamples(profile) {
    let total = 0;
    if (profile.samples && profile.samples.length) {
        for (const s of profile.samples) total += s.size || 0;
        return total;
    }
    return sumSelfSize(profile.head);
}

function sumSelfSize(node) {
    if (!node) return 0;
    let t = node.selfSize || 0;
    if (node.children) for (const c of node.children) t += sumSelfSize(c);
    return t;
}

export function sumObserverPath(profile, frames) {
    const set = frames || OBSERVER_FRAMES;
    if (!profile.head) return 0;
    let total = 0;
    (function walk(node) {
        const fn = node.callFrame ? node.callFrame.functionName : '';
        if (set.has(fn)) total += node.selfSize || 0;
        if (node.children) for (const c of node.children) walk(c);
    })(profile.head);
    return total;
}
