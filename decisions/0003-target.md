# ADR 0003 -- Element attribution: intern tag#id, never store the Node

- Status: accepted
- Date: 2026-08-15
- Context: IN2 (v1.2.0), finding IN-04. See `Inp.js` `internTarget`,
  `describeTarget`, `resolveTarget`, `TARGET_CAP`, `iTargetTag`, `lnTargetTag`;
  and `test/gc.target.mjs`, `test/browser/control.detached.mjs`.

## Context

The field every practitioner asks for first is "which element?" Event Timing's
`PerformanceEventTiming.target` answers it -- but `target` is a live `Node`.
Retaining it is the classic RUM leak: hold the Node and you pin the whole
detached subtree it belongs to, so a SPA that churns DOM across interactions
leaks unboundedly through the very monitor that was supposed to be invisible.

Two shapes were on the table:

1. **Build a CSS selector string** at observer time (what web-vitals does).
   Correct and never retains a Node, but allocates one string per interaction on
   the hot path -- exactly the per-event allocation this package exists to avoid.
2. **Intern the target** to a small integer id, resolved to a string only on the
   cold path.

## Decision

**Intern the target as `tag#id` / `tag.class` (NOT a full CSS selector), keyed by
node identity in a WeakMap, bounded at 128 distinct targets, and NEVER store the
Node. Beyond the cap, and for a null/removed target, fail closed to a sentinel
that resolves to `null`.**

The hot path is exactly one `Int32` write per raised-duration event:

```js
iTargetTag[slot] = internTarget(e.target);
```

`internTarget` (see `Inp.js`):

- `WeakMap.get(node)` -- a hit (the same element re-clicked, the common steady
  state) returns the cached id at **0 B/op** (proven in `test/gc.target.mjs`).
- A genuinely new target builds ONE description string (`describeTarget`) and
  stores `node -> id` in the WeakMap. Bounded to 128 per page view, user-driven,
  never per-event.
- Over the cap, or `node == null`, returns the sentinel `-1` with **no
  allocation and no store**.

## Why interning over a selector

- **Zero hot-path allocation for the common case.** A selector string per
  interaction is per-event heap churn; a WeakMap hit is not. The one string an
  interned target costs is built once and only for a genuinely new element.
- **No Node retention, structurally.** A `WeakMap` holds its keys *weakly*: the
  Node stays collectable, so a detached subtree is freed by GC exactly as if the
  monitor were not there. The interned value is a number and a short string --
  neither references the Node. This is the property `control.detached.mjs`
  asserts: the shipped path retains 0 detached nodes; a variant that stores
  `e.target` retains all of them and is caught.
- **`tag#id` / `tag.class`, not a full selector.** A stable, low-cardinality
  label is what a dashboard groups by. A full path selector is higher-cardinality
  noise and costs more to build. Reduced form is deliberate.

## Why 128, and why fail closed

- **128 distinct targets** covers the interactive surface of essentially any real
  page (buttons, inputs, links a user actually hits) with headroom. It is a hard
  bound on the intern string table -- the memory cost of element attribution can
  never grow beyond 128 short strings + a bounded WeakMap.
- **Beyond the cap: the sentinel, never a wrong element.** Reassigning an
  over-cap Node to some existing id would attribute the interaction to the WRONG
  element. That is worse than admitting we do not know. `resolveTarget` returns
  `null` for the sentinel: **null is not zero, and null is not a wrong answer.**
- The same fail-closed rule covers `target === null`, which the platform reports
  when the element was removed from the DOM before the entry surfaced.

## Reset semantics

`resetState()` (bfcache restore) and `destroy()` both drop the intern map:
a fresh `WeakMap`, a cleared string table, `targetCount = 0`. A restore is a new
page view; reusing ids across it would mis-resolve a re-clicked element to a
stale string. The fresh WeakMap also releases the weak node keys immediately.

## Consequences

- Element attribution is available on `getINP().attribution.target` at zero
  hot-path allocation (0 B/op, `test/gc.target.mjs`, 512 distinct targets driven
  past the 128 cap so the fail-closed overflow is exercised).
- No detached-node retention (`test/browser/control.detached.mjs`); the
  store-the-target control is caught, the shipped path is clean.
- Memory for attribution is hard-bounded: <= 128 short strings + a WeakMap whose
  entries vanish with their (weak) Node keys.
