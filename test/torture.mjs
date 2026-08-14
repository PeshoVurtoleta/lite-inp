// test/torture.mjs -- node --expose-gc test/torture.mjs
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import {
  createLeakTracker,
  createOwnerCascadeOrphanKernel,
  createTimerOrphanKernel,
  createListenerOrphanKernel,
  createObserverOrphanKernel,
  createAsyncRetentionKernel,
} from '@zakkster/lite-leak';
import { createRoot, effect } from '@zakkster/lite-signal';

// Node has no browser PerformanceObserver with 'event' support, so install a
// mock BEFORE importing the library. observe() captures the callback the
// library registers; we invoke it to drive the real hot path (onEventEntry ->
// maintainLongest). disconnect() clears the capture so a destroyed observer
// retains nothing.
let capturedEventCb = null;
class MockPerformanceObserver {
  constructor(cb) { this._cb = cb; }
  observe(opts) { if (opts.type === 'event') capturedEventCb = this._cb; }
  disconnect() { this._cb = null; }
  takeRecords() { return []; }
}
MockPerformanceObserver.supportedEntryTypes = ['event', 'long-animation-frame'];
globalThis.PerformanceObserver = MockPerformanceObserver;

// Node has no `window`, so the pageshow/bfcache listener path is never
// exercised in-process. Install a minimal registry-backed window BEFORE
// importing the library so createInpObserver()'s addEventListener('pageshow')
// runs for real -- and destroy()'s removeEventListener runs for real. liveCount
// returning to 0 after the churn proves the listener add/remove does not leak.
class MockEventTarget {
  constructor() { this._l = new Map(); }
  addEventListener(type, fn) {
    let a = this._l.get(type);
    if (!a) { a = new Set(); this._l.set(type, a); }
    a.add(fn);
  }
  removeEventListener(type, fn) { const a = this._l.get(type); if (a) a.delete(fn); }
  dispatch(type, ev) { const a = this._l.get(type); if (a) for (const fn of a) fn(ev); }
  liveCount() { let n = 0; for (const a of this._l.values()) n += a.size; return n; }
}
// window carries the pageshow (bfcache) listener; document carries the
// prerenderingchange listener. Both are added on construct and must be removed
// on destroy -- liveCount()===0 on BOTH after 4096 cycles proves the balance.
const mockWindow = new MockEventTarget();
const mockDocument = new MockEventTarget();
globalThis.window = mockWindow;
globalThis.document = mockDocument;

// >>> WIRE 1: the package under test
const { createInpObserver } = await import('../Inp.js');

const CYCLES = 4096;
const HOT = 200000;
const leaks = [];
const warns = [];

const tracker = createLeakTracker({
  name: 'torture',
  onLeak: (r) => leaks.push(r.kind + ':' + String(r.tag)),
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createTimerOrphanKernel());
tracker.registerKernel(createListenerOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());
tracker.registerKernel(createAsyncRetentionKernel());

// ---- phase 1: retention torture ------------------------------------------
for (let i = 0; i < CYCLES; i++) {
  const dispose = createRoot(() => effect(() => {
    const t = createInpObserver();
    // Fire a bfcache pageshow at the live listener(s) this cycle: exercises
    // resetState() on a restore AND proves the listener registered.
    mockWindow.dispatch('pageshow', { persisted: true });
    // detach the cleanup: capture destroy (which closes over internals, NOT
    // the returned object), never `t` itself, so `t` can be finalized.
    const destroy = t.destroy;
    tracker.track(t, () => destroy(), 'inp', { audit: true });
    // Documented teardown: disconnect observers, removeEventListener('pageshow'),
    // reset state. A global window listener retains the observer's internals
    // until this runs, so destroy() is the ONLY thing that balances the add --
    // listenersLive returning to 0 below is that balance, proven 4096x.
    destroy();
  }));
  dispose();
}

globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

const live = tracker.size();
const findings = tracker.audit();
// Listener add/remove balance: every observer removed BOTH its window pageshow
// and its document prerenderingchange listener in destroy(). A non-zero count on
// either is a real listener leak.
const listenersLive = mockWindow.liveCount() + mockDocument.liveCount();

// ---- phase 2: allocation + GC torture ------------------------------------
const gc = new GcProfiler().start();

// >>> WIRE 2: steady-state instance allocated OUTSIDE the loop, stepped inside.
// Feeds a fresh interaction per step (the real wrap behaviour) through the
// captured event callback, reusing one entry object + one list so the only
// churn is inside the library. Exercises the recency ring AND longest-N.
// onUpdate is a zero-alloc noop: it drives the FULL hot path (the new-worst /
// inpChanged flag computation + fillEntryPrimitives into the reused entry),
// which the null-onUpdate branch would skip. Proving major=0 with it wired is
// the point.
const inst = createInpObserver({ onUpdate: function () {} });
const cb = capturedEventCb;
const entry = {
  interactionId: 0, duration: 0,
  startTime: 0, processingStart: 0, processingEnd: 0, name: 'pointerup'
};
const arr = [entry];
const list = { getEntries: () => arr };

for (let i = 0; i < HOT; i++) {
  const dur = 16 + (i % 400);
  entry.interactionId = i + 1;
  entry.duration = dur;
  entry.startTime = i;
  entry.processingStart = i + 2;
  entry.processingEnd = i + 2 + dur * 0.5;
  cb(list);
  if ((i & 8191) === 0) {
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
  }
}

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
gc.stop();

const ok = report.ok && live === 0 && leaks.length === 0 && findings.length === 0 &&
  listenersLive === 0;
console.log(
  'GATE leak=size ' + live + '/0 findings=' + findings.length +
  ' warnings=' + warns.length + ' listeners=' + listenersLive +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
  for (const v of report.violations) {
    console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  }
  if (listenersLive !== 0) console.error('  leak listeners:' + listenersLive +
    ' (window pageshow=' + mockWindow.liveCount() +
    ' document prerenderingchange=' + mockDocument.liveCount() + ') not removed');
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  for (const l of leaks) console.error('  leak ' + l);
  process.exitCode = 1;
}
