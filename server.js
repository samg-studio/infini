const http = require('http');
const fs = require('fs');
const path = require('path');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8088);
const comfyHost = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const root = __dirname;

const proxyPrefixes = ['/prompt', '/history', '/view', '/interrupt', '/system_stats'];

function shouldProxy(urlPath) {
  return proxyPrefixes.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function proxyToComfy(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/prompt' && req.headers['x-infini-client'] !== '2') {
      send(res, 409, { 'content-type': 'application/json' }, JSON.stringify({
        error: 'Reload infini to use the current play/stop controls'
      }));
      return;
    }

    const body = await readBody(req);
    const upstream = await fetch(`${comfyHost}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json'
      },
      body: body.length > 0 ? body : undefined
    });

    const headers = {};
    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');

    if (contentType) headers['content-type'] = contentType;
    if (contentLength) headers['content-length'] = contentLength;

    const data = Buffer.from(await upstream.arrayBuffer());
    send(res, upstream.status, headers, data);
  } catch (err) {
    send(res, 502, { 'content-type': 'application/json' }, JSON.stringify({
      error: 'ComfyUI proxy failed',
      detail: err.message
    }));
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(root, path.normalize(pathname));

  if (!filePath.startsWith(root)) {
    send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    send(res, 200, {
      'content-type': types[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    }, data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (shouldProxy(url.pathname)) {
    proxyToComfy(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`infini listening at http://${host}:${port}/`);
  console.log(`proxying ComfyUI at ${comfyHost}`);
});
