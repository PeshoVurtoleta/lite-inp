export declare const VERSION: string;

export interface ScriptAttribution {
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
    duration: number;
}

/** One long-animation frame correlated to the INP interaction. */
export interface AttributedLoaf {
    startTime: number;
    duration: number;
    blockingDuration: number;
    styleAndLayoutStart: number;
    scripts: ScriptAttribution[];
}

/**
 * Attribution for the current INP interaction (since 1.2.0).
 *
 * Correlation rule (see decisions/0002-correlation.md): overlap is taken against
 * the UNQUANTIZED processing window (`processingStart..processingEnd`), not the
 * 8ms-quantized full duration. ALL overlapping LoAFs are collected (up to 4),
 * earliest-start first (the deterministic tie-break), not a single best overlap.
 * When the interaction is presentation-dominated (`presentationDelay >
 * processingTime`) correlation targets the style/layout segment of the frame(s)
 * covering the presentation window instead of the processing scripts.
 */
export interface InpAttribution {
    /** Up to 4 LoAFs overlapping the correlation window, earliest-start first. */
    loafs: AttributedLoaf[];
    /**
     * The interned element target as `tag#id` / `tag.class` (NOT a CSS selector),
     * or null. Targets are interned through a WeakMap (the Node is never stored,
     * so detached subtrees stay collectable), bounded at 128 distinct targets;
     * beyond the cap, and for a null/removed target, attribution FAILS CLOSED to
     * null -- never a wrong element (null is not zero). See decisions/0003-target.md.
     */
    target: string | null;
    /** Which phase dominated: 'processing' (scripts) or 'presentation' (paint). */
    phase: 'processing' | 'presentation';
}

export interface InpEntry {
    /** Total interaction duration (ms), quantized to 8ms by the browser. */
    duration: number;
    /** Time from user input to handler start (ms). */
    inputDelay: number;
    /** Time spent in event handlers (ms). */
    processingTime: number;
    /** Time from handler end to next paint (ms). */
    presentationDelay: number;
    /** Interaction start time (ms). */
    startTime: number;
    /** Event type (e.g. 'pointerup', 'keydown', 'click'). */
    eventType: string;
    /** Browser-assigned interaction ID. */
    interactionId: number;
    /**
     * Correlated attribution (loafs[], element target, phase), or null. Populated
     * only by `getINP()` (cold path); always null on `onUpdate` entries and after
     * `getINPInto()`, which stay allocation-free.
     */
    attribution: InpAttribution | null;
    /**
     * onUpdate only: true when this entry is a new worst (max) interaction.
     * Absent on entries filled by getINP()/getINPInto().
     */
    newWorst?: boolean;
    /**
     * onUpdate only: true when the p98 INP candidate changed on this update.
     * Absent on entries filled by getINP()/getINPInto().
     */
    inpChanged?: boolean;
}

export interface LoafEntry {
    startTime: number;
    duration: number;
    blockingDuration: number;
    styleAndLayoutStart: number;
    scripts: ScriptAttribution[];
}

export interface InpObserverOptions {
    /** Max unique interactions tracked. Default 512. */
    interactionCap?: number;
    /** Max LoAF entries retained. Default 64. */
    loafCap?: number;
    /** Min event duration reported (ms). Default 16. */
    durationThreshold?: number;
    /**
     * Fires on the hot path when EITHER a new worst interaction is recorded
     * (`entry.newWorst`) OR the p98 INP candidate changes (`entry.inpChanged`);
     * at least one flag is true on every call. The entry object is reused
     * across calls, so copy any fields you need before returning. The
     * `attribution` field is always null here -- attribution allocates, so the
     * observer callback skips it to preserve zero-GC discipline. Call
     * `obs.getINP()` if you need attribution for the current INP.
     */
    onUpdate?: (entry: InpEntry) => void;
}

export interface InpObserver {
    /** Compute and return the current INP entry with attribution (allocates). */
    getINP(): InpEntry | null;
    /**
     * Fill a caller-owned entry with the current INP (zero allocation).
     * Returns true when filled, false when no interaction has been recorded
     * (target left untouched). `attribution` is set to null; call getINP() for
     * attribution.
     */
    getINPInto(target: InpEntry): boolean;
    /** All tracked interactions, sorted by duration descending. */
    getInteractions(): InpEntry[];
    /** Recent LoAF entries with script attribution. */
    getLoafs(): LoafEntry[];
    /** Disconnect observers, remove listeners, and clear state. */
    destroy(): void;
    /** Number of unique interactions tracked. */
    readonly interactionCount: number;
    /** Number of LoAF entries in the ring buffer. */
    readonly loafCount: number;
    /**
     * The actual p98 INP duration (ms), O(1) zero-alloc read, or null when no
     * interaction has been recorded. Equal to getINP()?.duration -- it
     * recomputes the same page-lifetime skip live on every read.
     */
    readonly inp: number | null;
    /** The worst (max) interaction duration (ms) seen this page view. */
    readonly worstDuration: number;
    /**
     * @deprecated since 1.1.0 -- misnamed: this is the running WORST (max)
     * duration, not the p98 INP. Use `inp` for the actual INP or
     * `worstDuration` for the max. Alias of `worstDuration` for this minor.
     */
    readonly currentINP: number;
    /** True if Event Timing API is supported. */
    readonly supported: boolean;
    /** True if Long Animation Frames API is supported. */
    readonly loafSupported: boolean;
}

export function createInpObserver(options?: InpObserverOptions): InpObserver;
