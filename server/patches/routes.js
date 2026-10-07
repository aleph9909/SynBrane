const { MAX_UPLOAD_BYTES, PATCH_ID, PatchError } = require('./store');

function readUpload(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new PatchError(413, 'Patch is too large (16 KiB maximum).'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PatchError(400, 'Upload must be valid JSON.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new PatchError(400, 'Upload interrupted.')));
  });
}

function patchRoutes(store) {
  // A global limit works through the Worker without trusting spoofable IP
  // headers or treating every Cloudflare request as a different user.
  let attempts = [];
  return async function handlePatches(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    if (pathname !== '/api/patches' && !pathname.startsWith('/api/patches/')) return false;
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*', ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      const id = pathname.slice('/api/patches/'.length);
      const isCollection = pathname === '/api/patches';
      if (!isCollection && !PATCH_ID.test(id)) throw new PatchError(404, 'Patch not found.');
      const methods = isCollection ? ['GET', 'POST'] : ['GET'];
      if (!methods.includes(req.method)) {
        send(405, { error: 'Method not allowed.' }, { Allow: methods.join(', ') });
        return true;
      }
      if (req.method === 'GET') {
        if (!isCollection) send(200, await store.get(id));
        else {
          const before = parsedUrl.query.before;
          if (before !== undefined && typeof before !== 'string') throw new PatchError(400, 'Invalid page cursor.');
          send(200, await store.list(before));
        }
      } else {
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new PatchError(415, 'Use application/json to upload a patch.');
        }
        attempts = attempts.filter(time => time > Date.now() - 60000);
        if (attempts.length >= 20) throw new PatchError(429, 'Too many uploads. Please wait a minute and try again.');
        attempts.push(Date.now());
        if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) throw new PatchError(413, 'Patch is too large (16 KiB maximum).');
        send(201, { patch: await store.create(await readUpload(req)) });
      }
    } catch (error) {
      req.resume(); // Drain rejected uploads without retaining their bytes.
      if (!error.status) console.error('Patch library error:', error);
      send(error.status || 500, { error: error.status ? error.message : 'The patch library is temporarily unavailable.' },
        error.status === 429 ? { 'Retry-After': '60' } : {});
    }
    return true;
  };
}
module.exports = { patchRoutes };
