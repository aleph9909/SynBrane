// Real local Worker runtime + repository backend (Node DSP); no remote services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const renderDir = await mkdtemp(join(tmpdir(), 'synbrane-worker-'));
const backendPort = process.env.TEST_BACKEND_PORT || '13001';
const workerPort = process.env.TEST_WORKER_PORT || '18787';
const backend = `http://127.0.0.1:${backendPort}`;
const origin = `http://127.0.0.1:${workerPort}`;
const children = [];
function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  children.push(child);
  return { child, output: () => output };
}
async function ready(url, processState) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (processState.child.exitCode !== null) throw new Error(processState.output());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { await response.body?.cancel(); return; }
      await response.body?.cancel();
    } catch { /* wait for local startup */ }
    await delay(200);
  }
  throw new Error(`Startup timed out: ${url}\n${processState.output()}`);
}

try {
  const server = start(['server/index.js'], { HOST: '127.0.0.1', PORT: backendPort,
    RENDER_OUTPUT_DIR: renderDir, SUPER_COLLIDER_ENABLED: 'false' });
  await ready(`${backend}/api/tunings`, server);
  const worker = start(['node_modules/wrangler/bin/wrangler.js', 'dev', '--local',
    '--ip', '127.0.0.1', '--port', workerPort, '--inspector-port', '0',
    '--var', `BACKEND_BASE:${backend}`]);
  await ready(origin, worker);

  for (const [url, file, mime] of [['/', 'index.html', 'text/html'],
    ['/about.html', 'about.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'],
    ['/main.js', 'main.js', 'javascript']]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').includes(mime));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(`public/${file}`));
    console.log(`PASS static asset ${url} (identical bytes, after any canonical redirect)`);
  }
  for (const path of ['/api/tunings', '/api/chords?tuningId=edo%3A31']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), await (await fetch(backend + path)).json());
    console.log(`PASS real local backend ${path}`);
  }
  const missing = await fetch(`${origin}/api/unknown`, { headers: { 'sec-fetch-mode': 'navigate' } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Unknown API route');
  assert.equal((await fetch(`${origin}/api/chords`, { method: 'POST' })).status, 405);
  const missingStatic = await fetch(`${origin}/missing.html`);
  assert.equal(missingStatic.status, 404);

  for (const mode of ['harmony', 'rhythm']) {
    const response = await fetch(`${origin}/api/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, bpm: 300, loopCount: 2, rhythmSpeed: 0.3,
        arpeggio: { enabled: true, pattern: 'up', rate: '1/8' },
        synthSettings: { waveform: 'sine', volume: 0.5, detuneCents: 3 },
        sequence: [{ tuningId: 'edo:31', root: 0, customChord: { degrees: [0, 10, 18] },
          bar: 0, durationBars: 1, arpeggio: { enabled: true, pattern: 'up', rate: '1/8' } }],
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.file.startsWith('/api/render-file?path='));
    const wavResponse = await fetch(origin + data.file, { headers: { range: 'bytes=0-43' } });
    // Current backend has no Range support, so correctly passes its full 200.
    assert.equal(wavResponse.status, 200);
    assert.equal(wavResponse.headers.get('content-type'), 'audio/wav');
    const wav = Buffer.from(await wavResponse.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 44);
    const path = new URL(origin + data.file).searchParams.get('path');
    const direct = await fetch(backend + path);
    assert.deepEqual(wav, Buffer.from(await direct.arrayBuffer()));
    console.log(`PASS ${mode} render → rewritten URL → byte-identical WAV (${wav.length} bytes)`);
  }
  console.log('PASS local Worker integration (SuperCollider disabled; real Node DSP)');
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  await rm(renderDir, { recursive: true, force: true });
}
