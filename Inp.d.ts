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
     * Called when a new worst-or-near-worst interaction is recorded.
     * Fires on the hot path; the entry object is reused across calls, so
     * copy any fields you need before returning. The `attribution` field
     * is always null here -- attribution allocates, so the observer
     * callback skips it to preserve zero-GC discipline. Call
     * `obs.getINP()` if you need attribution for the current INP.
     */
    onUpdate?: (entry: InpEntry) => void;
}

export interface InpObserver {
    /** Compute and return the current INP entry with attribution. */
    getINP(): InpEntry | null;
    /** All tracked interactions, sorted by duration descending. */
    getInteractions(): InpEntry[];
    /** Recent LoAF entries with script attribution. */
    getLoafs(): LoafEntry[];
    /** Disconnect observers and clear state. */
    destroy(): void;
    /** Number of unique interactions tracked. */
    readonly interactionCount: number;
    /** Number of LoAF entries in the ring buffer. */
    readonly loafCount: number;
    /** Current worst interaction duration (ms). */
    readonly currentINP: number;
    /** True if Event Timing API is supported. */
    readonly supported: boolean;
    /** True if Long Animation Frames API is supported. */
    readonly loafSupported: boolean;
}

export function createInpObserver(options?: InpObserverOptions): InpObserver;
