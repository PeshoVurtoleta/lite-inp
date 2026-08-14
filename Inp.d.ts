export declare const VERSION: string;

export interface ScriptAttribution {
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
    duration: number;
}

export interface LoafAttribution {
    loafDuration: number;
    loafBlockingDuration: number;
    loafStyleAndLayoutStart: number;
    scripts: ScriptAttribution[];
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
    /** LoAF attribution for the overlapping long animation frame, or null. */
    attribution: LoafAttribution | null;
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
