import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../worker/index.mjs';

const env = { BACKEND_BASE: 'http://backend.test:3001' };
const req = (path, options) => new Request(`https://synbrane.test${path}`, options);
const forbiddenFetch = () => { throw new Error('Unexpected upstream fetch'); };

for (const path of ['/api/patches', '/api/patches?before=1791374400000-0123456789abcdef01234567', '/api/patches/1791374400000-0123456789abcdef01234567', '/api/tunings', '/api/chords?tuningId=edo%3A31&x=a%2Bb&x=two']) {
  test(`forwards GET and raw query: ${path}`, async () => {
    const response = await handleRequest(req(path), env, async (url, init) => {
      assert.equal(url, env.BACKEND_BASE + path);
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, 'manual');
      return Response.json({ result: [1, 2] });
    });
    assert.deepEqual(await response.json(), { result: [1, 2] });
  });
}

for (const route of ['play', 'render', 'patches']) {
  test(`forwards ${route} body without reserializing`, async () => {
    const body = ' { "sequence": [{"tuningId":"edo:31","degrees":[0,10,18]}], "loopCount": 10 }\n';
    await handleRequest(req(`/api/${route}`, { method: 'POST', body, headers: {
      'content-type': 'application/json', cookie: 'private=1', authorization: 'private',
    } }), env, async (url, init) => {
      assert.equal(url, `${env.BACKEND_BASE}/api/${route}`);
      assert.equal(init.method, 'POST');
      assert.equal(await new Response(init.body).text(), body);
      assert.equal(init.headers.get('content-type'), 'application/json');
      assert.equal(init.headers.get('cookie'), null);
      assert.equal(init.headers.get('authorization'), null);
      return Response.json({ file: '/renders/render-harmony-123.wav' });
    });
  });
}

test('preserves upstream error status, body, and relevant headers', async () => {
  for (const status of [400, 404, 422, 429, 500, 503]) {
    const response = await handleRequest(req('/api/render', { method: 'POST' }), env,
      async () => new Response('upstream failure', { status, headers: {
        'content-type': 'text/plain', 'retry-after': '30',
      } }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(await response.text(), 'upstream failure');
  }
});

test('unreachable upstream returns a clear JSON 502', async () => {
  const response = await handleRequest(req('/api/tunings'), env, async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Backend unavailable/);
});

test('every known route rejects unsupported methods with Allow', async () => {
  for (const [route, method] of [['tunings', 'GET'], ['chords', 'GET'],
    ['play', 'POST'], ['render', 'POST'], ['render-file', 'GET']]) {
    for (const unsupported of ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS', 'DELETE'].filter(m => m !== method)) {
      const response = await handleRequest(req(`/api/${route}`, { method: unsupported }), env, forbiddenFetch);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), method);
    }
  }
});

test('unknown API routes return JSON 404, never HTML assets', async () => {
  for (const path of ['/api', '/api/', '/api/unknown', '/api/tunings-extra']) {
    const response = await handleRequest(req(path), { ...env, ASSETS: { fetch: forbiddenFetch } }, forbiddenFetch);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'Unknown API route');
  }
});

test('non-API requests use the assets binding', async () => {
  const request = req('/about.html');
  const response = await handleRequest(request, { ...env, ASSETS: {
    fetch: async actual => { assert.equal(actual, request); return new Response('about'); },
  } }, forbiddenFetch);
  assert.equal(await response.text(), 'about');
});

test('rewrites successful render JSON and removes stale body metadata', async () => {
  const response = await handleRequest(req('/api/render', { method: 'POST' }), env,
    async () => Response.json({ status: 'ok', file: '/renders/render-harmony-123.wav', extra: 42 }, {
      status: 201, headers: { etag: 'stale', 'content-length': '900', 'content-encoding': 'gzip', 'cache-control': 'no-store' },
    }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { status: 'ok', file: '/api/render-file?path=%2Frenders%2Frender-harmony-123.wav', extra: 42 });
  for (const header of ['etag', 'content-length', 'content-encoding']) assert.equal(response.headers.get(header), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

const unsafe = ['', '/renders/', 'https://evil.test/renders/a.wav', '//evil.test/renders/a.wav',
  'http://backend.test:3001/renders/a.wav', '/api/tunings', '/renders/../secret.wav',
  '/renders/a/../../secret.wav', '/renders/%2e%2e/secret.wav', '/renders/%252e%252e/secret.wav',
  '/renders/%2fa.wav', '/renders/%', '/renders/%GG.wav', '/renders/a.wav?x=1',
  '/renders/a.wav#x', '/renders/a\\b.wav', '/renders/a\u0000.wav', '/renders/a\n.wav',
  '/renders/sub/a.wav', '/renders/a.json', '/renders/..wav', '/renders/a.wav\n', '/renders/a.wav\r'];

for (const path of unsafe) {
  test(`rejects unsafe client AND backend path: ${JSON.stringify(path)}`, async () => {
    const response = await handleRequest(req(`/api/render-file?path=${encodeURIComponent(path)}`), env, forbiddenFetch);
    assert.equal(response.status, 400);
    const render = await handleRequest(req('/api/render', { method: 'POST' }), env,
      async () => Response.json({ file: path }));
    assert.equal(render.status, 502);
  });
}

test('rejects missing/duplicate paths and malformed query encoding', async () => {
  for (const query of ['', '?path=%', '?path=%GG', '?path=%C0%AF',
    '?path=%2Frenders%2Fa.wav&path=%2Frenders%2Fb.wav']) {
    const response = await handleRequest(req(`/api/render-file${query}`), env, forbiddenFetch);
    assert.equal(response.status, 400);
  }
});

test('rejects malformed successful render responses', async () => {
  for (const body of ['not json', '{}', 'null', '{"file":12}']) {
    const response = await handleRequest(req('/api/render', { method: 'POST' }), env,
      async () => new Response(body));
    assert.equal(response.status, 502);
  }
});

test('rejects all upstream redirects without following or exposing Location', async () => {
  for (const route of ['/api/tunings', '/api/render-file?path=%2Frenders%2Fa.wav']) {
    for (const location of ['https://evil.test/a.wav', '/api/tunings', '/renders/b.wav', '//evil.test/a.wav']) {
      let calls = 0;
      const response = await handleRequest(req(route), env, async (_url, init) => {
        calls++;
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status: 302, headers: { location } });
      });
      assert.equal(calls, 1);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('location'), null);
    }
  }
});

test('streams binary bytes immediately, preserving range and cache headers', { timeout: 2000 }, async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const wav = Uint8Array.from([82, 73, 70, 70, 0, 255, 128, 10]);
  const response = await handleRequest(req('/api/render-file?path=%2Frenders%2Fa.wav', {
    headers: { range: 'bytes=0-7', 'if-range': 'wav-etag' },
  }), env, async (url, init) => {
    assert.equal(url, `${env.BACKEND_BASE}/renders/a.wav`);
    assert.equal(init.headers.get('range'), 'bytes=0-7');
    assert.equal(init.headers.get('if-range'), 'wav-etag');
    return new Response(stream, { status: 206, headers: {
      'content-type': 'audio/wav', 'content-length': '8', 'content-range': 'bytes 0-7/100',
      'accept-ranges': 'bytes', etag: 'wav-etag', 'last-modified': 'Tue, 06 Oct 2026 12:00:00 GMT',
    } });
  });
  // The handler returned before any bytes exist: whole-file buffering would hang.
  assert.equal(response.body, stream);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-7/100');
  assert.equal(response.headers.get('content-length'), '8');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('etag'), 'wav-etag');
  assert.ok(response.headers.get('last-modified'));
  controller.enqueue(wav);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, wav);
  controller.close();
  assert.equal((await reader.read()).done, true);
});

test('preserves 304 and 416 file responses', async () => {
  for (const status of [304, 416]) {
    const response = await handleRequest(req('/api/render-file?path=/renders/a.wav', {
      headers: { 'if-none-match': 'wav-etag' },
    }), env, async (_url, init) => {
      assert.equal(init.headers.get('if-none-match'), 'wav-etag');
      return new Response(null, { status, headers: { 'content-range': 'bytes */100' } });
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-range'), 'bytes */100');
  }
});

test('configuration must be an HTTP(S) origin', async () => {
  for (const base of [undefined, 'bad', 'file:///etc', 'https://a.test/api', 'https://user:pass@a.test', 'https://a.test/?x=1']) {
    const response = await handleRequest(req('/api/tunings'), { BACKEND_BASE: base }, forbiddenFetch);
    assert.equal(response.status, 500);
  }
});

test('patch collection/item methods and IDs have a closed proxy allowlist', async () => {
  const id = '1791374400000-0123456789abcdef01234567';
  for (const [path, method, status, allow] of [
    ['/api/patches', 'DELETE', 405, 'GET, POST'],
    [`/api/patches/${id}`, 'POST', 405, 'GET'],
    [`/api/patches/${id}`, 'DELETE', 405, 'GET'],
    ['/api/patches/not-an-id', 'GET', 404, null],
    [`/api/patches/${id}/extra`, 'GET', 404, null],
  ]) {
    const response = await handleRequest(req(path, { method }), env, forbiddenFetch);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('allow'), allow);
  }
});
