const assert = require('node:assert/strict');
const { test } = require('node:test');
const { orderFrequencies } = require('../public/arp-pattern');
const { validatePatch, createPatchStore } = require('../server/patches/store');
const patch = require('./fixtures/patch.cjs');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

test('ARP repeats remain consecutive after pitch ordering and up/down turnarounds', () => {
  const pitches = [300, 100, 200];
  const repeats = [3, 2, 1];
  assert.deepEqual(orderFrequencies(pitches, 'up', repeats), [100, 100, 200, 300, 300, 300]);
  assert.deepEqual(orderFrequencies(pitches, 'down', repeats), [300, 300, 300, 200, 100, 100]);
  assert.deepEqual(orderFrequencies(pitches, 'updown', repeats), [100, 100, 200, 300, 300, 300, 200]);
  assert.deepEqual(orderFrequencies([100], 'updown', [4]), [100, 100, 100, 100]);
  assert.deepEqual(orderFrequencies([200, 100], 'up'), [100, 200]);
  for (let iteration = 0; iteration < 10; iteration++) {
    const random = orderFrequencies(pitches, 'random', repeats);
    assert.equal(random.length, 6);
    assert.deepEqual(random.slice(random.indexOf(300), random.indexOf(300) + 3), [300, 300, 300]);
    assert.deepEqual(random.slice(random.indexOf(100), random.indexOf(100) + 2), [100, 100]);
  }
  assert.deepEqual(orderFrequencies([100, 200, 300], 'up', [999, -1, '4']), [100, 100, 100, 100, 200, 300]);
});

test('shared patch repeats survive disk storage; malformed or unselected counts are rejected', async t => {
  const input = patch();
  input.chords[0].repeats = { 0: 2, 7: 4 };
  assert.deepEqual(validatePatch(input), input);
  const directory = await mkdtemp(join(tmpdir(), 'synbrane-repeats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = await createPatchStore({ directory }).create({ name: 'Repeated notes', patch: input });
  assert.deepEqual((await createPatchStore({ directory }).get(record.id)).patch, input);
  for (const repeats of [{ 0: 0 }, { 0: 5 }, { 0: 1.5 }, { 0: '2' }, { 3: 2 }, { '-1': 2 }, { '00': 2 }, [], null]) {
    input.chords[0].repeats = repeats;
    assert.throws(() => validatePatch(input), error => error.status === 400);
  }
  assert.equal(validatePatch(patch()).chords[0].repeats, undefined);
});

test('repeated ARP rendering uses Node when the legacy SuperCollider bridge is enabled', async () => {
  const config = require('../server/config');
  const bridge = require('../server/audio/supercolliderClient');
  const engine = require('../server/audio/engine');
  const audio = require('../server/audio');
  const original = { enabled: config.superColliderEnabled, bridge: bridge.renderToFile, engine: engine.renderToFile };
  try {
    config.superColliderEnabled = true;
    bridge.renderToFile = async () => 'supercollider';
    engine.renderToFile = async () => 'node';
    const arpeggio = { enabled: true, repeats: [1, 3] };
    assert.equal(await audio.renderToFile({ mode: 'harmony', arpeggio }), 'node');
    assert.equal(await audio.renderToFile({ mode: 'harmony', events: [{ arpeggio }] }), 'node');
    assert.equal(await audio.renderToFile({ mode: 'harmony', arpeggio: { enabled: false, repeats: [3] } }), 'supercollider');
  } finally {
    config.superColliderEnabled = original.enabled;
    bridge.renderToFile = original.bridge;
    engine.renderToFile = original.engine;
  }
});
