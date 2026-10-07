const METHODS = new Map([
  ['/api/tunings', 'GET'],
  ['/api/chords', 'GET'],
  ['/api/play', 'POST'],
  ['/api/render', 'POST'],
  ['/api/render-file', 'GET'],
]);

function error(status, message, headers = {}) {
  return Response.json({ error: message }, { status, headers });
}

// Both current audio engines produce flat, ASCII WAV filenames. Accept only
// that contract: no URLs, subdirectories, percent escapes, or dot segments.
export function isRenderPath(path) {
  return typeof path === 'string' &&
    /^\/renders\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.wav$/i.test(path) &&
    !path.includes('..') && !/\s/.test(path);
}

function backendOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BACKEND_BASE must be an HTTP(S) origin');
  }
  return url.origin;
}

function requestHeaders(request) {
  const headers = new Headers();
  // Do not forward browser cookies, authorization, Host, or hop-by-hop headers.
  for (const name of ['content-type', 'accept', 'range', 'if-range',
    'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream) {
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-encoding',
    'content-disposition', 'content-range', 'accept-ranges', 'cache-control',
    'etag', 'last-modified', 'expires', 'vary', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export async function handleRequest(request, env, fetchUpstream = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return env.ASSETS.fetch(request);
  }
  const patchItem = /^\/api\/patches\/\d{13}-[a-f0-9]{24}$/.test(url.pathname);
  const allowed = url.pathname === '/api/patches' ? ['GET', 'POST']
    : patchItem ? ['GET'] : METHODS.has(url.pathname) ? [METHODS.get(url.pathname)] : [];
  if (!allowed.length) return error(404, 'Unknown API route');
  if (!allowed.includes(request.method)) {
    return error(405, 'Method not allowed', { Allow: allowed.join(', ') });
  }
  const method = request.method;

  let origin;
  try {
    origin = backendOrigin(env.BACKEND_BASE);
  } catch {
    return error(500, 'Invalid BACKEND_BASE configuration');
  }

  let target = `${origin}${url.pathname}${url.search}`;
  if (url.pathname === '/api/render-file') {
    // URLSearchParams is deliberately forgiving; explicitly reject malformed
    // percent escapes / UTF-8 before letting it perform the one query decode.
    try {
      decodeURIComponent(url.search.slice(1).replace(/\+/g, ' '));
    } catch {
      return error(400, 'Malformed render-file query encoding');
    }
    const paths = url.searchParams.getAll('path');
    if (paths.length !== 1 || !isRenderPath(paths[0])) {
      return error(400, 'Expected one path pointing to a /renders/ WAV file');
    }
    target = `${origin}${paths[0]}`;
  }

  let upstream;
  try {
    upstream = await fetchUpstream(target, {
      method,
      headers: requestHeaders(request),
      body: method === 'POST' ? request.body : undefined,
      // Never follow or expose redirects, even to the same host. In particular,
      // a render-file request cannot escape /renders/ via an upstream redirect.
      redirect: 'manual',
    });
  } catch {
    return error(502, 'Backend unavailable: could not reach the audio/API server');
  }

  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    await upstream.body?.cancel();
    return error(502, 'Backend redirect rejected');
  }

  const headers = responseHeaders(upstream);
  if (url.pathname === '/api/render' && upstream.ok) {
    let data;
    try {
      data = await upstream.json();
    } catch {
      return error(502, 'Backend returned invalid render JSON');
    }
    if (!data || !isRenderPath(data.file)) {
      return error(502, 'Backend returned an invalid render file path');
    }
    data.file = `/api/render-file?path=${encodeURIComponent(data.file)}`;
    // These describe the original body and no longer apply after rewriting.
    for (const name of ['content-length', 'content-encoding', 'etag',
      'last-modified', 'content-range', 'accept-ranges']) headers.delete(name);
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { status: upstream.status, headers });
  }

  // Pass the original stream through, including WAV bytes and 206/304/416
  // responses. No text conversion, arrayBuffer(), or whole-file buffering.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    encodeBody: 'manual',
  });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
