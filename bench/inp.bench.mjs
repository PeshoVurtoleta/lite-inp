// bench/inp.bench.mjs -- node bench/inp.bench.mjs
//
// Repo-only micro-bench (never in files[]). Measures the observer-callback cost
// per Event-Timing entry with a MOCKED feed in Node: it installs a mock
// PerformanceObserver, creates a real observer, and drives N entries straight
// through the captured hot-path callback (onEventEntry -> maintainLongest ->
// interning). Reports nanoseconds per entry and bytes/op (heapUsed delta / N).
// Runnable, NOT a gate -- the authoritative zero-GC proof is test/torture.mjs
// and the browser alloc/overhead lanes; this is a human-readable fingerprint.

// --- mock the browser surfaces --------------------------------------------
let capturedEventCb = null;
class MockPerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe(opts) { if (opts.type === 'event') capturedEventCb = this._cb; }
    disconnect() { this._cb = null; }
    takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;
class MockEventTarget {
    constructor() { this._l = new Map(); }
    addEventListener(t, f) { let a = this._l.get(t); if (!a) { a = new Set(); this._l.set(t, a); } a.add(f); }
    removeEventListener(t, f) { const a = this._l.get(t); if (a) a.delete(f); }
}
globalThis.window = new MockEventTarget();
globalThis.document = new MockEventTarget();

const { createInpObserver, VERSION } = await import('../Inp.js');

const N = Number(process.env.BENCH_N || 500000);
const TARGET_POOL = 200;

const obs = createInpObserver({ onUpdate: function () {} });
const cb = capturedEventCb;

// A pool of distinct target nodes > the 128 intern cap, reused cyclically, so
// after the first pass every internTarget is a WeakMap hit or an over-cap
// sentinel -- zero-alloc, the steady state. One reused entry + list; only the
// library churns (which is the point of the measurement).
const pool = new Array(TARGET_POOL);
for (let k = 0; k < TARGET_POOL; k++) pool[k] = { tagName: 'DIV', id: 'd' + k };
const entry = {
    interactionId: 0, duration: 0, startTime: 0,
    processingStart: 0, processingEnd: 0, name: 'pointerup', target: null
};
const arr = [entry];
const list = { getEntries: function () { return arr; } };

function drive(count) {
    for (let i = 0; i < count; i++) {
        const dur = 16 + (i % 400);
        entry.interactionId = i + 1;
        entry.duration = dur;
        entry.startTime = i;
        entry.processingStart = i + 2;
        entry.processingEnd = i + 2 + dur * 0.5;
        entry.target = pool[i % TARGET_POOL];
        cb(list);
    }
}

// Warm the JIT.
drive(50000);

globalThis.gc && globalThis.gc();
const h0 = process.memoryUsage().heapUsed;
const t0 = process.hrtime.bigint();
drive(N);
const t1 = process.hrtime.bigint();
const h1 = process.memoryUsage().heapUsed;

const ns = Number(t1 - t0);
const nsPerEntry = ns / N;
const bytesPerOp = (h1 - h0) / N;

console.log('lite-inp@' + VERSION + ' observer-callback bench (Node, mocked feed)');
console.log('  entries      : ' + N.toLocaleString());
console.log('  ns/entry     : ' + nsPerEntry.toFixed(1));
console.log('  M entries/s  : ' + (1000 / nsPerEntry).toFixed(2));
console.log('  heap delta   : ' + ((h1 - h0) / 1024).toFixed(1) + ' KiB (post-warm, one GC)');
console.log('  bytes/op     : ' + bytesPerOp.toFixed(2) + ' (steady-state target: ~0)');
console.log('BENCH inp.callback nsPerEntry=' + nsPerEntry.toFixed(1) +
    ' bytesPerOp=' + bytesPerOp.toFixed(2));
