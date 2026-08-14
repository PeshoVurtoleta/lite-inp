// @zakkster/lite-inp 1.1.0
// Zero-GC INP attribution via Event Timing API + Long Animation Frames.
// Preallocated struct-of-arrays for interactions and LoAF entries.
// The observer callbacks write to typed arrays -- no object creation,
// no array.push, no string concatenation on the hot path.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function supports(type) {
    return typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.includes(type);
}

// Hoisted so we don't allocate a comparator closure per sort. Null-safe body
// serves both the LoAF script sort and the getInteractions result sort.
function byDurationDesc(a, b) { return (b.duration || 0) - (a.duration || 0); }

// ---------------------------------------------------------------------------
// createInpObserver -- the public API
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {number} [options.interactionCap=512]
 *   Max unique interactions tracked. Power-of-two ring; oldest dropped
 *   when full. 512 covers ~10 minutes of heavy interaction.
 * @param {number} [options.loafCap=64]
 *   Max LoAF entries retained for attribution.
 * @param {number} [options.durationThreshold=16]
 *   Minimum event duration (ms) reported by the Event Timing observer.
 *   Lower = more data, higher observer cost. Default 16 catches all
 *   interactions above one frame.
 * @param {(entry: InpEntry) => void} [options.onUpdate]
 *   Fires on the hot path when EITHER a new worst interaction is recorded
 *   (`entry.newWorst === true`) OR the p98 INP candidate changes
 *   (`entry.inpChanged === true`); at least one flag is true on every call.
 *   The entry object is reused across calls -- copy any field you need
 *   before returning. `entry.attribution` is always null here -- computing
 *   attribution allocates, so the observer callback skips it to preserve
 *   zero-GC discipline. Call `obs.getINP()` if you need attribution.
 * @returns {InpObserver}
 */
export function createInpObserver(options) {
    const opts = options || {};

    // -- environment handles (captured once; null when absent -> fail closed) --
    const perf = typeof performance !== 'undefined' ? performance : null;
    const win = typeof window !== 'undefined' ? window : null;
    const doc = typeof document !== 'undefined' ? document : null;

    // -- feature detection --
    const hasEvent = supports('event');
    const hasLoaf = supports('long-animation-frame');

    // -- interaction SoA (indexed by slot) --
    const iCap = pow2(opts.interactionCap || 512);
    const iMask = iCap - 1;
    const iInteractionId = new Float64Array(iCap);  // interaction IDs can be large
    const iDuration = new Float64Array(iCap);
    const iStartTime = new Float64Array(iCap);
    const iProcessingStart = new Float64Array(iCap);
    const iProcessingEnd = new Float64Array(iCap);
    const iInputDelay = new Float64Array(iCap);
    const iProcessingTime = new Float64Array(iCap);
    const iPresentationDelay = new Float64Array(iCap);
    const iEventType = new Int32Array(iCap);  // interned tag id
    let iCount = 0;

    // interaction ID -> slot index (one-time alloc per unique interaction)
    const idToSlot = new Map();

    // event-type interning
    const eventTypes = [];
    const eventTypeMap = new Map();
    function internEventType(name) {
        let id = eventTypeMap.get(name);
        if (id === undefined) { id = eventTypes.length; eventTypes.push(name); eventTypeMap.set(name, id); }
        return id;
    }

    // -- LoAF SoA (ring buffer) --
    const lCap = pow2(opts.loafCap || 64);
    const lMask = lCap - 1;
    const lStart = new Float64Array(lCap);
    const lDuration = new Float64Array(lCap);
    const lBlocking = new Float64Array(lCap);
    const lStyleStart = new Float64Array(lCap);
    // Script attribution: store top-3 scripts per LoAF (by duration).
    // Each script slot: invoker, sourceURL, sourceFunctionName, duration.
    // Strings are stored as references (cold path reads only).
    const SCRIPTS_PER_LOAF = 3;
    const lScriptInvoker = new Array(lCap * SCRIPTS_PER_LOAF);
    const lScriptSourceURL = new Array(lCap * SCRIPTS_PER_LOAF);
    const lScriptSourceFn = new Array(lCap * SCRIPTS_PER_LOAF);
    const lScriptDuration = new Float64Array(lCap * SCRIPTS_PER_LOAF);
    const lScriptCount = new Uint8Array(lCap);
    let lHead = 0;
    let lCount = 0;

    // Scratch buffer for sorting LoAF scripts when count > SCRIPTS_PER_LOAF.
    // Grown on demand; reused thereafter. Amortized zero-alloc after the first
    // large LoAF; the browser's own scripts array is never mutated.
    let scratchScripts = null;

    // -- longest-N SoA (page-lifetime, sorted by duration DESC) --
    // INP is a page-lifetime percentile, but the recency ring above evicts
    // early interactions once it wraps -- so the worst interaction that the
    // p98 skip lands on may already be garbage. This independent list keeps
    // its OWN copies of the 10 longest interactions ever seen, so computeINP
    // never depends on a live ring slot. 10 slots suffice: the web-vitals
    // estimator caps skip at 9 (floor(count/50)) below ~500 interactions,
    // beyond which estimator error dominates anyway.
    const LN_CAP = 10;
    const lnDuration = new Float64Array(LN_CAP);
    const lnStartTime = new Float64Array(LN_CAP);
    const lnProcessingStart = new Float64Array(LN_CAP);
    const lnProcessingEnd = new Float64Array(LN_CAP);
    const lnInputDelay = new Float64Array(LN_CAP);
    const lnProcessingTime = new Float64Array(LN_CAP);
    const lnPresentationDelay = new Float64Array(LN_CAP);
    const lnEventType = new Int32Array(LN_CAP);       // interned tag id
    const lnInteractionId = new Float64Array(LN_CAP); // ids can be large
    let lnCount = 0;

    // -- INP tracking --
    // INP = p98 of all interactions' max durations.
    // For < 50 interactions, it's the worst.
    // currentInpDuration is the running MAX (the worst duration seen); it is
    // NOT the p98 INP. The honest p98 INP is lnDuration at the LIVE skip index
    // (see liveInpIdx): the getters recompute that index on every read, because
    // performance.interactionCount also advances on sub-threshold interactions
    // the observer never delivers -- a cached index would go stale-low.
    // inpIdx below is a hot-path APPROXIMATION of that index, refreshed per
    // delivered interaction and used ONLY to detect an INP change for the
    // onUpdate callback (lastInp caches the last value fired). It is never read
    // by the getters.
    let currentInpDuration = 0;
    let inpIdx = 0;
    let lastInp = 0;

    // Page-lifetime skip baseline. INP's skip is floor((lifetimeCount -
    // icBaseline) / 50). performance.interactionCount is a monotonic
    // page-lifetime counter the platform does NOT reset on bfcache restore, so
    // on a restore (or destroy) we rebaseline it here -- a restored page is a
    // fresh page view and its INP must start from zero interactions again.
    let icBaseline = (perf !== null && perf.interactionCount) || 0;

    // activationStart offset (prerender). Interaction timestamps are relative
    // to time origin; after a prerendered page is activated, absolute times
    // must be reported relative to activationStart. Read once at construction
    // and refreshed on prerenderingchange. Fail closed: 0 when unavailable.
    let actOffset = readActivationStart();

    // -- reusable entry object for onUpdate (zero alloc per callback) --
    const reusableEntry = {
        duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
        startTime: 0, eventType: '', interactionId: 0, attribution: null,
        newWorst: false, inpChanged: false
    };

    const onUpdate = opts.onUpdate || null;

    // Read navigation activationStart (prerender offset). Cold path: allocates
    // the platform's navigation-entry array, but runs only at construction and
    // on prerenderingchange, never per interaction.
    function readActivationStart() {
        if (perf === null || typeof perf.getEntriesByType !== 'function') return 0;
        const nav = perf.getEntriesByType('navigation');
        if (!nav || nav.length === 0) return 0;
        const as = nav[0].activationStart;
        return typeof as === 'number' && as > 0 ? as : 0;
    }

    // -----------------------------------------------------------------------
    // Event Timing observer callback -- HOT PATH
    // -----------------------------------------------------------------------

    function onEventEntry(list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const iid = e.interactionId;
            if (!iid) continue;  // non-interaction event (scroll, etc.)

            const dur = e.duration;
            const inputDelay = e.processingStart - e.startTime;
            const processingTime = e.processingEnd - e.processingStart;
            const presentationDelay = dur - inputDelay - processingTime;

            let slot = idToSlot.get(iid);
            if (slot === undefined) {
                // New interaction -- allocate a slot.
                // If full, overwrite oldest (simple modular index).
                slot = iCount & iMask;
                if (iCount >= iCap) {
                    // Evict: remove the old interactionId mapping
                    idToSlot.delete(iInteractionId[slot]);
                }
                idToSlot.set(iid, slot);
                iInteractionId[slot] = iid;
                iDuration[slot] = 0;  // will be set below
                iCount++;
                // Refresh the hot-path INP index APPROXIMATION for the onUpdate
                // inpChanged flag only. This is NOT the source of truth for the
                // `inp` getter -- that recomputes the skip live, because
                // performance.interactionCount can advance on sub-threshold
                // interactions that are never delivered here. Branchless
                // arithmetic, zero allocation.
                inpIdx = (((perf !== null && perf.interactionCount ? perf.interactionCount : iCount) - icBaseline) / 50) | 0;
            }

            // Take the max duration across events in the same interaction
            // (pointerdown + pointerup + click -> same interactionId).
            if (dur > iDuration[slot]) {
                iDuration[slot] = dur;
                iStartTime[slot] = e.startTime;
                iProcessingStart[slot] = e.processingStart;
                iProcessingEnd[slot] = e.processingEnd;
                iInputDelay[slot] = inputDelay;
                iProcessingTime[slot] = processingTime;
                iPresentationDelay[slot] = presentationDelay > 0 ? presentationDelay : 0;
                iEventType[slot] = internEventType(e.name);

                // The recency ring may evict this interaction later, but INP is
                // a page-lifetime percentile -- so maintain the independent
                // longest-N list now, while the raised duration is fresh. Runs
                // only when the duration actually rose (this block), never per
                // event. Zero allocation: hand-rolled O(LN_CAP) shifts.
                maintainLongest(slot);
            }

            // onUpdate contract: fire when a NEW WORST interaction is recorded
            // OR when the p98 INP candidate CHANGES (the longest-N insert above
            // moved the value at inpIdx). Both are derived allocation-free from
            // the list state; the single call site below reuses one entry.
            if (onUpdate !== null) {
                const newWorst = dur > currentInpDuration;
                if (newWorst) currentInpDuration = dur;
                const idx = inpIdx < lnCount ? inpIdx : lnCount - 1;
                const cur = idx >= 0 ? lnDuration[idx] : 0;
                const inpChanged = cur !== lastInp;
                if (inpChanged) lastInp = cur;
                if (newWorst || inpChanged) {
                    // Hot path: primitives only, no allocation. Attribution is
                    // a cold-path concern (call getINP() when reporting) so the
                    // observer callback never allocates per interaction. The
                    // reusable entry's `attribution` is null on this code path;
                    // consumers wanting attribution can call obs.getINP() from
                    // inside onUpdate at the cost of one heap object.
                    fillEntryPrimitives(reusableEntry, slot);
                    reusableEntry.attribution = null;
                    reusableEntry.newWorst = newWorst;
                    reusableEntry.inpChanged = inpChanged;
                    onUpdate(reusableEntry);
                }
            } else if (dur > currentInpDuration) {
                currentInpDuration = dur;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Longest-N maintenance -- HOT PATH (runs inside the event observer)
    // -----------------------------------------------------------------------
    // All writes go into preallocated arrays. No push, no closure sort, no
    // object literals -- hand-rolled O(LN_CAP) shifts only.

    function lnCopyFromSlot(pos, slot) {
        lnDuration[pos] = iDuration[slot];
        lnStartTime[pos] = iStartTime[slot];
        lnProcessingStart[pos] = iProcessingStart[slot];
        lnProcessingEnd[pos] = iProcessingEnd[slot];
        lnInputDelay[pos] = iInputDelay[slot];
        lnProcessingTime[pos] = iProcessingTime[slot];
        lnPresentationDelay[pos] = iPresentationDelay[slot];
        lnEventType[pos] = iEventType[slot];
        lnInteractionId[pos] = iInteractionId[slot];
    }

    function lnSwap(a, b) {
        let t;
        t = lnDuration[a]; lnDuration[a] = lnDuration[b]; lnDuration[b] = t;
        t = lnStartTime[a]; lnStartTime[a] = lnStartTime[b]; lnStartTime[b] = t;
        t = lnProcessingStart[a]; lnProcessingStart[a] = lnProcessingStart[b]; lnProcessingStart[b] = t;
        t = lnProcessingEnd[a]; lnProcessingEnd[a] = lnProcessingEnd[b]; lnProcessingEnd[b] = t;
        t = lnInputDelay[a]; lnInputDelay[a] = lnInputDelay[b]; lnInputDelay[b] = t;
        t = lnProcessingTime[a]; lnProcessingTime[a] = lnProcessingTime[b]; lnProcessingTime[b] = t;
        t = lnPresentationDelay[a]; lnPresentationDelay[a] = lnPresentationDelay[b]; lnPresentationDelay[b] = t;
        t = lnEventType[a]; lnEventType[a] = lnEventType[b]; lnEventType[b] = t;
        t = lnInteractionId[a]; lnInteractionId[a] = lnInteractionId[b]; lnInteractionId[b] = t;
    }

    // Move entry at pos toward index 0 while it is longer than its predecessor.
    // Duration only ever rises for an existing entry, and a fresh insert lands
    // at the tail, so a single upward bubble always restores DESC order.
    function lnBubbleUp(pos) {
        while (pos > 0 && lnDuration[pos] > lnDuration[pos - 1]) {
            lnSwap(pos, pos - 1);
            pos--;
        }
    }

    // Called only when iDuration[slot] just rose. Dedup by interactionId:
    // the same interaction must never occupy two longest-N slots.
    function maintainLongest(slot) {
        const id = iInteractionId[slot];
        const dur = iDuration[slot];
        for (let k = 0; k < lnCount; k++) {
            if (lnInteractionId[k] === id) {
                // Already present -- refresh its stored copy and re-sort.
                lnCopyFromSlot(k, slot);
                lnBubbleUp(k);
                return;
            }
        }
        // Absent: insert if there is room, else displace the smallest (last)
        // entry only if this interaction is strictly longer than it.
        if (lnCount < LN_CAP) {
            lnCopyFromSlot(lnCount, slot);
            lnBubbleUp(lnCount);
            lnCount++;
        } else if (dur > lnDuration[LN_CAP - 1]) {
            lnCopyFromSlot(LN_CAP - 1, slot);
            lnBubbleUp(LN_CAP - 1);
        }
    }

    // -----------------------------------------------------------------------
    // LoAF observer callback
    // -----------------------------------------------------------------------

    function onLoafEntry(list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const slot = lHead & lMask;
            lStart[slot] = e.startTime;
            lDuration[slot] = e.duration;
            lBlocking[slot] = e.blockingDuration || 0;
            lStyleStart[slot] = e.styleAndLayoutStart || 0;

            // Store top-3 scripts by duration
            const scripts = e.scripts;
            const base = slot * SCRIPTS_PER_LOAF;
            let sCount = 0;
            if (scripts && scripts.length > 0) {
                let sorted;
                if (scripts.length <= SCRIPTS_PER_LOAF) {
                    sorted = scripts;
                } else {
                    // Rare path: LoAF with >3 scripts. Reuse a scratch array so
                    // we don't allocate a slice per entry. Grow once when needed;
                    // the browser's scripts array is not mutated.
                    if (scratchScripts === null || scratchScripts.length < scripts.length) {
                        scratchScripts = new Array(scripts.length);
                    }
                    for (let s = 0; s < scripts.length; s++) scratchScripts[s] = scripts[s];
                    // Truncate to actual populated length before sort so stale
                    // tail refs from a previous larger LoAF don't contaminate.
                    scratchScripts.length = scripts.length;
                    scratchScripts.sort(byDurationDesc);
                    sorted = scratchScripts;
                }
                const limit = sorted.length < SCRIPTS_PER_LOAF ? sorted.length : SCRIPTS_PER_LOAF;
                for (let s = 0; s < limit; s++) {
                    const sc = sorted[s];
                    lScriptInvoker[base + s] = sc.invoker || sc.name || '';
                    lScriptSourceURL[base + s] = sc.sourceURL || '';
                    lScriptSourceFn[base + s] = sc.sourceFunctionName || '';
                    lScriptDuration[base + s] = sc.duration || 0;
                    sCount++;
                }
            }
            // Clear unused script slots
            for (let s = sCount; s < SCRIPTS_PER_LOAF; s++) {
                lScriptInvoker[base + s] = null;
                lScriptSourceURL[base + s] = null;
                lScriptSourceFn[base + s] = null;
                lScriptDuration[base + s] = 0;
            }
            lScriptCount[slot] = sCount;

            lHead++;
            if (lCount < lCap) lCount++;
        }
    }

    // -----------------------------------------------------------------------
    // Start observers
    // -----------------------------------------------------------------------

    let eventObs = null;
    let loafObs = null;

    if (hasEvent) {
        eventObs = new PerformanceObserver(onEventEntry);
        eventObs.observe({
            type: 'event',
            buffered: true,
            durationThreshold: opts.durationThreshold !== undefined ? opts.durationThreshold : 16
        });
    }

    if (hasLoaf) {
        loafObs = new PerformanceObserver(onLoafEntry);
        loafObs.observe({ type: 'long-animation-frame', buffered: true });
    }

    // -----------------------------------------------------------------------
    // Attribution -- cold path
    // -----------------------------------------------------------------------

    function findLoafForInteraction(startTime, endTime) {
        // Find the LoAF entry whose time window overlaps the interaction.
        let bestSlot = -1;
        let bestOverlap = 0;
        const n = Math.min(lCount, lCap);
        for (let k = 0; k < n; k++) {
            const slot = (lHead - n + k + lCap) & lMask;
            const lEnd = lStart[slot] + lDuration[slot];
            const overlapStart = startTime > lStart[slot] ? startTime : lStart[slot];
            const overlapEnd = endTime < lEnd ? endTime : lEnd;
            const overlap = overlapEnd - overlapStart;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestSlot = slot;
            }
        }
        return bestSlot;
    }

    function buildAttribution(loafSlot) {
        if (loafSlot < 0) return null;
        const base = loafSlot * SCRIPTS_PER_LOAF;
        const scripts = [];
        for (let s = 0; s < lScriptCount[loafSlot]; s++) {
            scripts.push({
                invoker: lScriptInvoker[base + s],
                sourceURL: lScriptSourceURL[base + s],
                sourceFunctionName: lScriptSourceFn[base + s],
                duration: lScriptDuration[base + s]
            });
        }
        return {
            loafDuration: lDuration[loafSlot],
            loafBlockingDuration: lBlocking[loafSlot],
            loafStyleAndLayoutStart: lStyleStart[loafSlot],
            scripts: scripts
        };
    }

    function fillEntryPrimitives(target, slot) {
        target.duration = iDuration[slot];
        target.inputDelay = iInputDelay[slot];
        target.processingTime = iProcessingTime[slot];
        target.presentationDelay = iPresentationDelay[slot];
        // startTime is the only absolute timestamp; correct it for a prerender
        // activationStart (0 on a normally-loaded page). Unconditional single
        // subtraction -- no branch, no allocation.
        target.startTime = iStartTime[slot] - actOffset;
        target.eventType = eventTypes[iEventType[slot]] || '';
        target.interactionId = iInteractionId[slot];
    }

    // Zero-alloc primitive fill from the longest-N SoA (no attribution). Shared
    // by getINPInto() (hot-callable) and fillEntryFromLongest() (cold path).
    function fillLongestPrimitives(target, idx) {
        target.duration = lnDuration[idx];
        target.inputDelay = lnInputDelay[idx];
        target.processingTime = lnProcessingTime[idx];
        target.presentationDelay = lnPresentationDelay[idx];
        target.startTime = lnStartTime[idx] - actOffset;
        target.eventType = eventTypes[lnEventType[idx]] || '';
        target.interactionId = lnInteractionId[idx];
    }

    // Cold path: full entry including LoAF attribution, read from the
    // longest-N SoA (which holds its own copies -- never a live ring slot).
    // Called by getINP(); allocates the returned entry by design.
    function fillEntryFromLongest(target, idx) {
        fillLongestPrimitives(target, idx);
        // LoAF attribution is still correlated at getINP() time from the stored
        // startTime/duration window -- so cold-path attribution keeps working.
        // Correlation runs in raw (un-offset) time to match the LoAF ring's
        // stored startTimes.
        const endTime = lnStartTime[idx] + lnDuration[idx];
        const loafSlot = findLoafForInteraction(lnStartTime[idx], endTime);
        target.attribution = buildAttribution(loafSlot);
    }

    // -----------------------------------------------------------------------
    // INP computation -- cold path, called on demand
    // -----------------------------------------------------------------------

    // Live p98 skip index into the (DESC-sorted) longest-N list. The single
    // source of truth for every INP read: computeINP, getInp, getINPInto.
    // INP is a PAGE-LIFETIME percentile, so the skip uses the true lifetime
    // unique-interaction count -- performance.interactionCount when available,
    // else raw iCount. It is recomputed on EVERY read, never cached: the
    // platform counter also advances on sub-threshold interactions the observer
    // never delivers, so a cached index would go stale-low and read a longer
    // (lower-index) duration than the canonical skip. icBaseline scopes the
    // skip to this page view (correct across a bfcache restore). Pure integer
    // arithmetic, zero allocation. Returns -1 when the list is empty.
    function liveInpIdx() {
        if (lnCount === 0) return -1;
        const lc = perf !== null && perf.interactionCount ? perf.interactionCount : iCount;
        const skip = (((lc - icBaseline) / 50) | 0);
        return skip < lnCount ? skip : lnCount - 1;
    }

    function computeINP() {
        // Fail closed: no interactions -> no INP (null is not zero).
        const targetIdx = liveInpIdx();
        if (targetIdx < 0) return null;

        // Read from the longest-N list -- no durations/slots/indices arrays,
        // no sort. Only the returned entry (+ attribution) allocates.
        const entry = {
            duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
            startTime: 0, eventType: '', interactionId: 0, attribution: null
        };
        fillEntryFromLongest(entry, targetIdx);
        return entry;
    }

    // -----------------------------------------------------------------------
    // Public surface
    // -----------------------------------------------------------------------

    function getINP() {
        return computeINP();
    }

    function getInteractions() {
        const n = Math.min(iCount, iCap);
        const result = [];
        for (let k = 0; k < n; k++) {
            const slot = iCount <= iCap ? k : ((iCount - iCap + k) & iMask);
            const entry = {
                duration: iDuration[slot],
                inputDelay: iInputDelay[slot],
                processingTime: iProcessingTime[slot],
                presentationDelay: iPresentationDelay[slot],
                startTime: iStartTime[slot] - actOffset,
                eventType: eventTypes[iEventType[slot]] || '',
                interactionId: iInteractionId[slot]
            };
            result.push(entry);
        }
        result.sort(byDurationDesc);
        return result;
    }

    function getLoafs() {
        const n = Math.min(lCount, lCap);
        const result = [];
        for (let k = 0; k < n; k++) {
            const slot = (lHead - n + k + lCap) & lMask;
            const base = slot * SCRIPTS_PER_LOAF;
            const sc = lScriptCount[slot];
            const scripts = new Array(sc);
            for (let s = 0; s < sc; s++) {
                scripts[s] = {
                    invoker: lScriptInvoker[base + s],
                    sourceURL: lScriptSourceURL[base + s],
                    sourceFunctionName: lScriptSourceFn[base + s],
                    duration: lScriptDuration[base + s]
                };
            }
            result.push({
                startTime: lStart[slot],
                duration: lDuration[slot],
                blockingDuration: lBlocking[slot],
                styleAndLayoutStart: lStyleStart[slot],
                scripts: scripts
            });
        }
        return result;
    }

    // Reusable state reset -- serves destroy(), a bfcache pageshow restore, and
    // any future soft-navigation reset. Fail closed: every counter goes to zero
    // so getters return null/empty rather than stale data; the p98 tracking
    // (inpIdx/lastInp) is zeroed and icBaseline is rebaselined to the current
    // page-lifetime interaction count so the next page view's skip starts fresh.
    function resetState() {
        idToSlot.clear();
        iCount = 0;
        lnCount = 0;
        currentInpDuration = 0;
        lCount = 0;
        lHead = 0;
        inpIdx = 0;
        lastInp = 0;
        icBaseline = (perf !== null && perf.interactionCount) || 0;
    }

    // A bfcache restore is a NEW page view: the same document is re-shown, but
    // its INP must be measured from zero again. event.persisted distinguishes a
    // real bfcache restore from an ordinary pageshow.
    function onPageShow(event) {
        if (event && event.persisted) resetState();
    }

    // Prerender activation: refresh the activationStart offset so absolute
    // timestamps reported after activation are relative to activation.
    function onPrerenderingChange() {
        actOffset = readActivationStart();
    }

    if (win !== null) win.addEventListener('pageshow', onPageShow);
    if (doc !== null) doc.addEventListener('prerenderingchange', onPrerenderingChange);

    function destroy() {
        if (eventObs) { eventObs.disconnect(); eventObs = null; }
        if (loafObs) { loafObs.disconnect(); loafObs = null; }
        if (win !== null) win.removeEventListener('pageshow', onPageShow);
        if (doc !== null) doc.removeEventListener('prerenderingchange', onPrerenderingChange);
        // Observers are nulled and listeners removed above, so nothing
        // re-observes; the interning arrays are harmless to keep.
        resetState();
    }

    // O(1), zero-alloc read of the actual p98 INP: the value at the LIVE skip
    // index in the longest-N list. Fail closed: null when no interaction has
    // been recorded (null is not zero). Equal to getINP().duration because it
    // recomputes the same skip live (liveInpIdx), not from a cached index.
    function getInp() {
        const idx = liveInpIdx();
        return idx < 0 ? null : lnDuration[idx];
    }

    // Zero-alloc INP read into a caller-owned entry. Returns true when filled,
    // false when there is no interaction yet (target left untouched). attribution
    // is set to null -- computing it allocates; call getINP() for attribution.
    function getINPInto(target) {
        const idx = liveInpIdx();
        if (idx < 0) return false;
        fillLongestPrimitives(target, idx);
        target.attribution = null;
        return true;
    }

    return {
        getINP: getINP,
        getINPInto: getINPInto,
        getInteractions: getInteractions,
        getLoafs: getLoafs,
        destroy: destroy,
        get interactionCount() { return Math.min(iCount, iCap); },
        get loafCount() { return Math.min(lCount, lCap); },
        // The actual p98 INP (ms), O(1) zero alloc, null when empty.
        get inp() { return getInp(); },
        // The worst (max) interaction duration (ms) seen this page view.
        get worstDuration() { return currentInpDuration; },
        /**
         * @deprecated since 1.1.0 -- misnamed. This is the running WORST
         * (max) duration, NOT the p98 INP. Use `inp` for the actual INP or
         * `worstDuration` for the max. Kept as an alias of `worstDuration`
         * for this minor; a future major removes it.
         */
        get currentINP() { return currentInpDuration; },
        get supported() { return hasEvent; },
        get loafSupported() { return hasLoaf; }
    };
}
