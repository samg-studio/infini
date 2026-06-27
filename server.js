const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8088);
const comfyHost = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const root = __dirname;
const basePath = normalizeBasePath(process.env.BASE_PATH || '');
const stateDir = path.join(root, '.infini');
const deletedStorePath = path.join(stateDir, 'deleted.json');
const comfyOutputDir = resolveComfyOutputDir();

const proxyPrefixes = ['/prompt', '/history', '/view', '/interrupt', '/queue', '/system_stats'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function stripBasePath(pathname) {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || '/';
  }
  return pathname;
}

function shouldProxy(urlPath) {
  return proxyPrefixes.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`));
}

function resolveComfyOutputDir() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.COMFY_OUTPUT_DIR,
    path.join(home, 'AI', 'comfyui', 'output'),
    path.join(home, 'ComfyUI', 'output'),
    path.join(home, 'AI', 'ComfyUI', 'output')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch {}
  }

  return path.resolve(candidates[0] || path.join(root, 'output'));
}

function getComfyProxyPath(pathname, search = '') {
  const upstream = new URL(comfyHost);
  const upstreamBase = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/+$/, '');
  return `${upstreamBase}${pathname}${search}`;
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

function getCorsHeaders(req) {
  const origin = req.headers.origin || '*';
  const allowOrigin = allowedOrigins.includes('*') || allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0] || origin;

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-infini-client',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
    'vary': 'origin'
  };
}

function jsonHeaders(req) {
  return {
    ...getCorsHeaders(req),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  };
}

function sendJson(req, res, status, payload) {
  send(res, status, jsonHeaders(req), JSON.stringify(payload));
}

async function readJsonStore(filePath, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonStore(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readDeletedStore() {
  const store = await readJsonStore(deletedStorePath, { version: 1, clients: {} });
  if (!store || typeof store !== 'object') return { version: 1, clients: {} };
  if (!store.clients || typeof store.clients !== 'object') store.clients = {};
  return store;
}

function cleanClientId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, 180);
}

function isUnsafePathPart(value) {
  const text = String(value || '');
  return text.includes('\0') ||
    text.includes('..') ||
    path.isAbsolute(text) ||
    text.split(/[\\/]+/).includes('..');
}

function normalizeImageInfo(info) {
  if (!info || typeof info !== 'object') return null;

  const filename = String(info.filename || '').trim();
  const subfolder = String(info.subfolder || '').trim();
  const type = String(info.type || 'output').trim() || 'output';

  if (!filename.startsWith('Infinite_')) return null;
  if (type !== 'output') return null;
  if (isUnsafePathPart(filename) || isUnsafePathPart(subfolder)) return null;
  if (filename.includes('/') || filename.includes('\\')) return null;

  return { filename, subfolder, type };
}

function imageKey(info) {
  return `${info.filename}|${info.subfolder || ''}|${info.type || 'output'}`;
}

function getOutputFilePath(info) {
  const outputRoot = path.resolve(comfyOutputDir);
  const subfolderParts = info.subfolder
    ? info.subfolder.split(/[\\/]+/).filter(Boolean)
    : [];
  const filePath = path.resolve(outputRoot, ...subfolderParts, info.filename);

  if (!filePath.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error('Refusing to delete outside ComfyUI output');
  }

  return filePath;
}

function getHistoryClientId(historyItem) {
  return historyItem?.prompt?.[3]?.client_id || '';
}

function findHistoryImages(historyItem) {
  const images = [];

  if (Array.isArray(historyItem?.output?.images)) {
    images.push(...historyItem.output.images);
  }

  const outputs = historyItem?.outputs || {};
  for (const output of Object.values(outputs)) {
    if (Array.isArray(output?.images)) images.push(...output.images);
  }

  return images;
}

async function fetchComfyHistory() {
  const upstream = await fetch(`${comfyHost}/history`);
  if (!upstream.ok) throw new Error(`ComfyUI history returned ${upstream.status}`);
  return upstream.json();
}

function collectAllowedImageKeys(history, clientId) {
  const allowed = new Set();

  for (const historyItem of Object.values(history || {})) {
    if (getHistoryClientId(historyItem) !== clientId) continue;

    for (const image of findHistoryImages(historyItem)) {
      const info = normalizeImageInfo(image);
      if (info) allowed.add(imageKey(info));
    }
  }

  return allowed;
}

async function handleDeletedImages(req, res, url) {
  if (req.method === 'OPTIONS') {
    send(res, 204, getCorsHeaders(req), '');
    return;
  }

  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'Use GET for deleted image keys' });
    return;
  }

  const clientId = cleanClientId(url.searchParams.get('clientId'));
  if (!clientId) {
    sendJson(req, res, 400, { error: 'Missing clientId' });
    return;
  }

  const store = await readDeletedStore();
  sendJson(req, res, 200, {
    clientId,
    keys: Array.isArray(store.clients[clientId]) ? store.clients[clientId] : []
  });
}

async function handleDeleteImages(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, getCorsHeaders(req), '');
    return;
  }

  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Use POST to delete images' });
    return;
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    sendJson(req, res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const clientId = cleanClientId(payload.clientId);
  const requested = Array.isArray(payload.images)
    ? payload.images.map(normalizeImageInfo).filter(Boolean)
    : [];

  if (!clientId || requested.length === 0) {
    sendJson(req, res, 400, { error: 'Missing clientId or images' });
    return;
  }

  try {
    const history = await fetchComfyHistory();
    const allowedKeys = collectAllowedImageKeys(history, clientId);
    const deleted = [];
    const rejected = [];

    for (const info of requested) {
      const key = imageKey(info);
      if (!allowedKeys.has(key)) {
        rejected.push({ key, reason: 'not_current_device' });
        continue;
      }

      try {
        const filePath = getOutputFilePath(info);
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
          rejected.push({ key, reason: 'not_file' });
          continue;
        }

        await fs.promises.unlink(filePath);
        deleted.push({ key, ...info });
      } catch (err) {
        if (err.code === 'ENOENT') {
          deleted.push({ key, ...info });
        } else {
          rejected.push({ key, reason: err.message });
        }
      }
    }

    if (deleted.length > 0) {
      const store = await readDeletedStore();
      const existing = new Set(Array.isArray(store.clients[clientId]) ? store.clients[clientId] : []);
      deleted.forEach((item) => existing.add(item.key));
      store.clients[clientId] = [...existing].slice(-5000);
      await writeJsonStore(deletedStorePath, store);
    }

    sendJson(req, res, 200, { deleted, rejected });
  } catch (err) {
    sendJson(req, res, 502, {
      error: 'Delete failed',
      detail: err.message
    });
  }
}

async function proxyToComfy(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    url.pathname = stripBasePath(url.pathname);

    if (req.method === 'OPTIONS') {
      send(res, 204, getCorsHeaders(req), '');
      return;
    }

    if (url.pathname === '/prompt' && req.headers['x-infini-client'] !== '2') {
      send(res, 409, {
        ...getCorsHeaders(req),
        'content-type': 'application/json'
      }, JSON.stringify({
        error: 'Reload infini to use the current play/stop controls'
      }));
      return;
    }

    const body = await readBody(req);
    const upstream = await fetch(`${comfyHost}${url.pathname}${url.search}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json'
      },
      body: body.length > 0 ? body : undefined
    });

    const headers = getCorsHeaders(req);
    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');

    if (contentType) headers['content-type'] = contentType;
    if (contentLength) headers['content-length'] = contentLength;

    const data = Buffer.from(await upstream.arrayBuffer());
    send(res, upstream.status, headers, data);
  } catch (err) {
    send(res, 502, {
      ...getCorsHeaders(req),
      'content-type': 'application/json'
    }, JSON.stringify({
      error: 'ComfyUI proxy failed',
      detail: err.message
    }));
  }
}

function proxyWebSocket(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  url.pathname = stripBasePath(url.pathname);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const upstream = new URL(comfyHost);
  const useTls = upstream.protocol === 'https:';
  const upstreamPort = Number(upstream.port || (useTls ? 443 : 80));
  const connect = useTls ? tls.connect : net.connect;
  const upstreamSocket = connect(upstreamPort, upstream.hostname, () => {
    const requestPath = getComfyProxyPath(url.pathname, url.search);
    const lines = [
      `GET ${requestPath} HTTP/1.1`,
      `Host: ${upstream.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket'
    ];

    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'upgrade') continue;
      if (Array.isArray(value)) {
        value.forEach((item) => lines.push(`${name}: ${item}`));
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }

    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  url.pathname = stripBasePath(url.pathname);
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
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
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
  url.pathname = stripBasePath(url.pathname);

  if (url.pathname === '/deleted') {
    handleDeletedImages(req, res, url).catch((err) => {
      sendJson(req, res, 500, { error: 'Deleted index failed', detail: err.message });
    });
    return;
  }

  if (url.pathname === '/delete') {
    handleDeleteImages(req, res).catch((err) => {
      sendJson(req, res, 500, { error: 'Delete failed', detail: err.message });
    });
    return;
  }

  if (shouldProxy(url.pathname)) {
    proxyToComfy(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`infini listening at http://${host}:${port}/`);
  if (basePath) console.log(`mounted at ${basePath}`);
  console.log(`proxying ComfyUI at ${comfyHost}`);
  console.log(`using ComfyUI output at ${comfyOutputDir}`);
});

server.on('upgrade', proxyWebSocket);
