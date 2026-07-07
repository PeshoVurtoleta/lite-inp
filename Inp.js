// @zakkster/lite-inp 1.0.0
// Zero-GC INP attribution via Event Timing API + Long Animation Frames.
// Preallocated struct-of-arrays for interactions and LoAF entries.
// The observer callbacks write to typed arrays -- no object creation,
// no array.push, no string concatenation on the hot path.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

export const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function supports(type) {
    return typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.includes(type);
}

// Hoisted so we don't allocate a comparator closure per LoAF entry that has
// more than SCRIPTS_PER_LOAF scripts.
function scriptDurDesc(a, b) { return (b.duration || 0) - (a.duration || 0); }

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
 *   Called whenever a new worst-or-near-worst interaction is recorded.
 *   Fires on the hot path; the entry object is reused across calls.
 *   `entry.attribution` is always null here -- computing attribution
 *   allocates, so the observer callback skips it to preserve zero-GC
 *   discipline. Call `obs.getINP()` if you need attribution.
 * @returns {InpObserver}
 */
export function createInpObserver(options) {
    const opts = options || {};

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

    // -- INP tracking --
    // INP = p98 of all interactions' max durations.
    // For < 50 interactions, it's the worst.
    // We track the current worst for the onUpdate callback.
    let currentInpDuration = 0;
    let currentInpSlot = -1;

    // -- reusable entry object for onUpdate (zero alloc per callback) --
    const reusableEntry = {
        duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
        startTime: 0, eventType: '', interactionId: 0, attribution: null
    };

    const onUpdate = opts.onUpdate || null;

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
            }

            // Update current INP candidate
            if (dur > currentInpDuration) {
                currentInpDuration = dur;
                currentInpSlot = slot;
                if (onUpdate !== null) {
                    // Hot path: primitives only, no allocation. Attribution is
                    // a cold-path concern (call getINP() when reporting) so the
                    // observer callback never allocates per interaction. The
                    // reusable entry's `attribution` is null on this code path;
                    // consumers wanting attribution can call obs.getINP() from
                    // inside onUpdate at the cost of one heap object.
                    fillEntryPrimitives(reusableEntry, slot);
                    reusableEntry.attribution = null;
                    onUpdate(reusableEntry);
                }
            }
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
                    scratchScripts.sort(scriptDurDesc);
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
        target.startTime = iStartTime[slot];
        target.eventType = eventTypes[iEventType[slot]] || '';
        target.interactionId = iInteractionId[slot];
    }

    // Cold path: full entry including LoAF attribution. Called by getINP()
    // and from the demo's on-demand refresh -- allocates by design.
    function fillEntry(target, slot) {
        fillEntryPrimitives(target, slot);
        const endTime = iStartTime[slot] + iDuration[slot];
        const loafSlot = findLoafForInteraction(iStartTime[slot], endTime);
        target.attribution = buildAttribution(loafSlot);
    }

    // -----------------------------------------------------------------------
    // INP computation -- cold path, called on demand
    // -----------------------------------------------------------------------

    function computeINP() {
        const n = Math.min(iCount, iCap);
        if (n === 0) return null;

        // Collect all interaction durations into a sortable array.
        // This allocates -- it's a cold path called on demand.
        const durations = new Float64Array(n);
        const slots = new Int32Array(n);
        for (let k = 0; k < n; k++) {
            // Walk the live slots
            const slot = iCount <= iCap ? k : ((iCount - iCap + k) & iMask);
            durations[k] = iDuration[slot];
            slots[k] = slot;
        }

        // Sort descending
        const indices = Array.from({ length: n }, function (_, i) { return i; });
        indices.sort(function (a, b) { return durations[b] - durations[a]; });

        // p98: skip floor(n/50) worst interactions
        const interactionCount = typeof performance !== 'undefined' && performance.interactionCount
            ? performance.interactionCount
            : n;
        const skip = Math.floor(interactionCount / 50);
        const targetIdx = Math.min(skip, n - 1);
        const inpIdx = indices[targetIdx];
        const inpSlot = slots[inpIdx];

        const entry = {
            duration: 0, inputDelay: 0, processingTime: 0, presentationDelay: 0,
            startTime: 0, eventType: '', interactionId: 0, attribution: null
        };
        fillEntry(entry, inpSlot);
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
                startTime: iStartTime[slot],
                eventType: eventTypes[iEventType[slot]] || '',
                interactionId: iInteractionId[slot]
            };
            result.push(entry);
        }
        result.sort(function (a, b) { return b.duration - a.duration; });
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

    function destroy() {
        if (eventObs) { eventObs.disconnect(); eventObs = null; }
        if (loafObs) { loafObs.disconnect(); loafObs = null; }
        idToSlot.clear();
    }

    return {
        getINP: getINP,
        getInteractions: getInteractions,
        getLoafs: getLoafs,
        destroy: destroy,
        get interactionCount() { return Math.min(iCount, iCap); },
        get loafCount() { return Math.min(lCount, lCap); },
        get currentINP() { return currentInpDuration; },
        get supported() { return hasEvent; },
        get loafSupported() { return hasLoaf; }
    };
}
