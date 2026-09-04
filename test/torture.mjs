// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Phase-1 retention gate is a FINALIZATION AUTHORITY, not a counter trick.
// Each cycle builds a REAL createInpObserver(), exercises it, destroy()s it,
// then tracks the observer with lite-leak OUTSIDE any owner and WITHOUT
// untracking it (cleanup NOOP + numeric tag capture NOTHING, so the observer is
// held only WEAKLY). After the loop we settle HARD and assert the finalization
// residual tracker.size() <= RES: an observer that was really released is
// collected (size--), one that leaked is not.
//
// (An earlier version tracked `t` INSIDE a createRoot(effect(...)) owner and
// asserted size()===0 -- a VACUOUS TAUTOLOGY: lite-leak auto-registers
// onCleanup(untrack) under an active owner, so size() fell to 0 on owner
// disposal BY CONSTRUCTION regardless of GC. Empirically, pinning all 4096 real
// observers still left that gate green. Fixed here to the finalization pattern
// so the gate FAILS on a retained observer.)
//
// RED control: LITE_INP_TORTURE_LEAK=1 pins each tracked observer in a module
// sink -> residual stays ~CYCLES and BLOWS RES, tripping the gate directly.
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

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
const warns = [];

// AUTHORITY residual ceiling. A clean run finalizes to single digits; a real
// retention leak leaves ~CYCLES observers uncollected.
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16

// A SHARED cleanup that closes over NOTHING and a numeric tag that closes over
// nothing: the finalization contract requires the tracker's own cleanup + tag
// to hold no reference to the target, or the hold is defeated and the harness
// silently reports clean. NOOP + the integer cycle index satisfy that.
const NOOP = function () {};

// RED control (LITE_INP_TORTURE_LEAK=1): pin every tracked observer here so it
// can NEVER be finalized -> tracker.size() stays ~CYCLES and BLOWS RES.
const LEAK = process.env.LITE_INP_TORTURE_LEAK === '1';
const __leakSink = [];

// Plain tracker: NO orphan kernels (they flag HELD objects) and NO onLeak (it
// fires on COLLECTION -- the SUCCESS signal for finalization -- so gating on it
// would fail a clean baseline). The authority is size() after a hard settle.
const tracker = createLeakTracker({
  name: 'torture',
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});

// The finalization residual is only measurable when gc() can be forced. The
// package's `npm test` runs this file in a plain `node --test` glob WITHOUT
// --expose-gc (a smoke run); the AUTHORITATIVE gate is `npm run test:torture`
// (--expose-gc). Under the smoke run the residual assertion is skipped rather
// than failed -- see `residualOk` below.
const HAS_GC = typeof globalThis.gc === 'function';

// Hard settle: run FinalizationRegistry callbacks to ground before size(). gc()
// is guarded so the no --expose-gc smoke run does not throw.
async function settleHard() {
  for (let k = 0; k < 10; k++) {
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 15));
  }
}

// A per-cycle target NODE stand-in. Feeding it before the pageshow populates the
// target intern map (a WeakMap keyed by this node + one interned string), so the
// bfcache resetState() has a live intern map to clear -- and the WeakMap holding
// the node WEAKLY (never stored strongly) is why `t` still finalizes to size 0.
// The node is a fresh literal per cycle and is NEVER captured by the cleanup or
// tag, so nothing retains it.
function makeTargetNode(i) { return { tagName: 'BUTTON', id: 'b' + (i & 15) }; }

// ---- phase 1: retention torture ------------------------------------------
// NO createRoot/effect owner here: track() must run with getOwner() undefined so
// NO auto-untrack is armed and finalization is the ONLY release path. `t` is a
// per-cycle const captured by nothing after the iteration ends, so a properly
// destroyed observer is collectable and its only surviving reference is the
// tracker's WEAK one.
for (let i = 0; i < CYCLES; i++) {
  const t = createInpObserver();
  // Feed one interaction WITH a target so the intern map (WeakMap + string) is
  // populated before the restore, proving resetState() actually clears it.
  capturedEventCb({ getEntries: () => [{
    interactionId: 1, duration: 40, startTime: 0, processingStart: 2,
    processingEnd: 22, name: 'pointerup', target: makeTargetNode(i)
  }] });
  // Fire a bfcache pageshow at the live listener(s) this cycle: exercises
  // resetState() on a restore AND proves the listener registered.
  mockWindow.dispatch('pageshow', { persisted: true });
  // Documented teardown: disconnect observers, removeEventListener('pageshow'),
  // reset state. A global window listener retains the observer's internals until
  // this runs, so destroy() is the ONLY thing that balances the add --
  // listenersLive returning to 0 below is that balance, proven 4096x. The
  // tracker's release is NOT tied to destroy() (NOOP cleanup) -- destroy() runs
  // for the listener-balance oracle; finalization decides the observer's fate.
  t.destroy();
  // AUTHORITY: track the REAL observer OUTSIDE any owner and DON'T untrack it.
  // NOOP + the numeric tag `i` capture nothing, so `t` is held only WEAKLY.
  tracker.track(t, NOOP, i);
  if (LEAK) __leakSink.push(t); // RED control: pin -> can NEVER be finalized.
}

await settleHard();

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
// A pool of DISTINCT target nodes larger than the 128 intern cap, reused
// cyclically. After the first pass every node is either interned (WeakMap hit,
// zero alloc) or over-cap (sentinel, zero alloc), so the hot path -- including
// the new iTargetTag[slot] = internTarget(e.target) write -- must hold major=0.
const TARGET_POOL = 200;
const targetPool = new Array(TARGET_POOL);
for (let k = 0; k < TARGET_POOL; k++) targetPool[k] = { tagName: 'DIV', id: 'd' + k };
const entry = {
  interactionId: 0, duration: 0,
  startTime: 0, processingStart: 0, processingEnd: 0, name: 'pointerup', target: null
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
  entry.target = targetPool[i % TARGET_POOL];
  cb(list);
  if ((i & 8191) === 0) {
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
  }
}

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
gc.stop();

// AUTHORITY: finalization residual (live <= RES), NOT ===0 -- a straggler or two
// is noise; a real leak leaves ~CYCLES. Listener-balance and phase-2 alloc gates
// are the two INDEPENDENT oracles kept intact alongside it.
// residual is only meaningful with a forced gc(); the plain smoke run skips it
// (the alloc, listener-balance and findings oracles still gate there).
const residualOk = HAS_GC ? (live <= RES) : true;
const ok = report.ok && residualOk && findings.length === 0 &&
  listenersLive === 0;
// Read __leakSink AFTER the settle so V8 cannot elide it under this module's
// top-level await: the read keeps the sink (and every observer it pins under
// LITE_INP_TORTURE_LEAK=1) reachable ACROSS settleHard(), which is what makes
// the RED control actually retain -- without this, a never-read module sink is
// treated as dead and the pinned observers are collected anyway (size -> 0).
console.log(
  'GATE residual size=' + live + '/' + RES + (HAS_GC ? '' : ' [skipped: run test:torture]') +
  ' findings=' + findings.length +
  ' warnings=' + warns.length + ' listeners=' + listenersLive +
  ' pinned=' + __leakSink.length +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
  for (const v of report.violations) {
    console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  }
  if (HAS_GC && live > RES) console.error('  AUTHORITY residual size()=' + live + ' > ' + RES +
    ' -- an observer outlived its destroy()');
  if (listenersLive !== 0) console.error('  leak listeners:' + listenersLive +
    ' (window pageshow=' + mockWindow.liveCount() +
    ' document prerenderingchange=' + mockDocument.liveCount() + ') not removed');
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  process.exitCode = 1;
}
