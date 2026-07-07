import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../Inp.js';

// The observer callbacks use browser-only PerformanceObserver, so we can't
// test them in node:test. What we CAN test: the module loads, exports the
// expected shape, and VERSION is set. The data path (SoA writes, INP
// computation, LoAF attribution) is tested via the interactive demo in a
// real browser.

test('VERSION is set', () => {
    assert.equal(VERSION, '1.0.0');
});

test('createInpObserver is exported and callable', async () => {
    const { createInpObserver } = await import('../Inp.js');
    assert.equal(typeof createInpObserver, 'function');
});

test('createInpObserver returns correct shape in non-browser env', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver();
    assert.equal(typeof obs.getINP, 'function');
    assert.equal(typeof obs.getInteractions, 'function');
    assert.equal(typeof obs.getLoafs, 'function');
    assert.equal(typeof obs.destroy, 'function');
    assert.equal(obs.interactionCount, 0);
    assert.equal(obs.loafCount, 0);
    assert.equal(obs.currentINP, 0);
    assert.equal(obs.supported, false, 'no PerformanceObserver in node');
    assert.equal(obs.loafSupported, false);
    obs.destroy();
});

test('getINP returns null when no interactions recorded', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver();
    assert.equal(obs.getINP(), null);
    obs.destroy();
});

test('getInteractions returns empty array when no interactions', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver();
    const list = obs.getInteractions();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
    obs.destroy();
});

test('getLoafs returns empty array when no LoAFs', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver();
    const list = obs.getLoafs();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
    obs.destroy();
});

test('destroy is idempotent', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver();
    assert.doesNotThrow(() => { obs.destroy(); obs.destroy(); });
});

test('options are accepted without error', async () => {
    const { createInpObserver } = await import('../Inp.js');
    const obs = createInpObserver({
        interactionCap: 256,
        loafCap: 32,
        durationThreshold: 40,
        onUpdate: function () {}
    });
    assert.equal(obs.interactionCount, 0);
    obs.destroy();
});
