const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const { parse } = require('node:url');
const { createPatchStore, validatePatch } = require('../server/patches/store');
const { patchRoutes } = require('../server/patches/routes');
const patch = require('./fixtures/patch.cjs');
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'synbrane-patches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createPatchStore({ directory, ...options }) };
}
const upload = () => ({ name: 'Glass spiral', author: 'Test artist', patch: patch() });

test('validation preserves patches, legacy arps and fifth chords; strips extra properties', () => {
  const input = patch();
  assert.deepEqual(validatePatch(input), input);
  input.extra = 'untrusted';
  input.global.synth.extra = 'untrusted';
  input.chords[0].preset = 'major';
  input.loopChordCount = 5;
  delete input.global.arpeggiator;
  input.chords[0].arp.enabled = true;
  const result = validatePatch(input);
  assert.equal(result.extra, undefined);
  assert.equal(result.global.synth.extra, undefined);
  assert.equal(result.global.arpeggiator.enabled, true);
  assert.equal(result.chords[0].preset, 'major-triad');
  assert.equal(result.loopChordCount, 5);
});

test('rejects invalid versions, tunings, presets, notes and unsafe parameter ranges', () => {
  for (const mutate of [p => p.version = 2, p => p.chords = [], p => p.loopChordCount = 6,
    p => p.chords[0].tuningId = '../../secret', p => p.chords[0].preset = 'nope',
    p => p.chords[0].root = 999, p => p.chords[0].notes = [-1],
    p => p.chords[0].notes = [36], p => p.chords[0].notes = [0, 0],
    p => p.global.tempo = '120', p => p.global.tempo = Infinity,
    p => p.global.synth.volume = 100, p => p.global.synth.filter.cutoffHz = 1,
    p => p.global.synth.envelope.releaseMs = 99999, p => p.global.arpeggiator.enabled = 'true']) {
    const input = patch(); mutate(input);
    assert.throws(() => validatePatch(input), error => error.status === 400);
  }
});

test('stores immutable files, reads them after reopening, and paginates without duplicates', async t => {
  let time = Date.now();
  const { directory, store } = await setup(t, { now: () => time++ });
  const records = [];
  for (let n = 0; n < 23; n++) records.push(await store.create({ ...upload(), name: `Patch ${n}` }));
  const reopened = createPatchStore({ directory });
  assert.deepEqual((await reopened.get(records[0].id)).patch, patch());
  const first = await reopened.list();
  assert.equal(first.patches.length, 20);
  const second = await reopened.list(first.nextCursor);
  assert.equal(second.patches.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.patches, ...second.patches].map(p => p.id)).size, 23);
  assert.equal(first.patches[0].name, 'Patch 22');
  assert.equal((await readdir(directory)).length, 23);
  for (const id of ['../../secret', 'unknown', '1-abc']) {
    await assert.rejects(reopened.get(id), error => error.status === 404);
  }
  await assert.rejects(reopened.list('bad cursor'), error => error.status === 400);
});

test('serializes concurrent writes under capacity and hourly limits', async t => {
  const { store } = await setup(t, { maxPatches: 2 });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.create(upload())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 507));
  const limited = await setup(t, { hourlyLimit: 1 });
  await limited.store.create(upload());
  await assert.rejects(limited.store.create(upload()), error => error.status === 429);
  await assert.rejects(store.create({ ...upload(), name: ' \n ' }), error => error.status === 400);
});

test('HTTP create/list/get, validation, size limits, method guards and rate limits', async t => {
  const { store } = await setup(t);
  const handler = patchRoutes(store);
  const server = http.createServer((req, res) => handler(req, res, parse(req.url, true)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, type = 'application/json') => fetch(`${origin}/api/patches`, {
    method: 'POST', headers: { 'Content-Type': type }, body });
  const response = await post(JSON.stringify(upload()));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const id = (await response.json()).patch.id;
  const record = await (await fetch(`${origin}/api/patches/${id}`)).json();
  assert.deepEqual(record.patch, patch());
  assert.equal((await (await fetch(`${origin}/api/patches`)).json()).patches.length, 1);
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.equal((await post('{broken')).status, 400);
  assert.equal((await post('x'.repeat(17000))).status, 413);
  // Streamed request without Content-Length must obey the same limit.
  const streamed = await fetch(`${origin}/api/patches`, { method: 'POST', duplex: 'half',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(17000))); controller.close(); } }) });
  assert.equal(streamed.status, 413);
  assert.equal((await fetch(`${origin}/api/patches/${id}`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${origin}/api/patches/nope`)).status, 404);
  assert.equal((await fetch(`${origin}/api/patches?before=a&before=b`)).status, 400);
  for (let n = 0; n < 16; n++) await post('{}');
  const limited = await post(JSON.stringify(upload()));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
