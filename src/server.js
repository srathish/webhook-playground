#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 4000;
const MAX_EVENTS = 100;

// In-memory ring buffer of captured webhooks.
const events = [];
let seq = 0;

function addEvent(req, bodyBuf) {
  const raw = bodyBuf.toString('utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
  const event = {
    id: ++seq,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.url,
    headers: req.headers,
    body: raw,
    json: parsed,
    size: bodyBuf.length,
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();
  return event;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function replay(event, targetUrl) {
  // Strip hop-by-hop / host headers before replaying.
  const headers = { ...event.headers };
  delete headers.host;
  delete headers['content-length'];
  const res = await fetch(targetUrl, { method: event.method, headers, body: event.body || undefined });
  return { status: res.status, ok: res.ok };
}

function send(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Dashboard UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(ROOT, 'public', 'index.html')));
    return;
  }

  // List captured events
  if (req.method === 'GET' && url.pathname === '/_events') {
    return send(res, 200, { events });
  }

  // Clear
  if (req.method === 'POST' && url.pathname === '/_clear') {
    events.length = 0;
    return send(res, 200, { ok: true });
  }

  // Replay a captured event to a target URL
  if (req.method === 'POST' && url.pathname === '/_replay') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const event = events.find((e) => e.id === body.id);
    if (!event) return send(res, 404, { error: 'event not found' });
    if (!body.target) return send(res, 400, { error: 'target URL required' });
    try {
      const result = await replay(event, body.target);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 502, { error: err.message });
    }
  }

  // Anything else under /hook (any method) is a captured webhook.
  if (url.pathname.startsWith('/hook')) {
    const buf = await readBody(req);
    const event = addEvent(req, buf);
    return send(res, 200, { received: true, id: event.id });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Webhook Playground   → http://localhost:${PORT}`);
  console.log(`Send webhooks to     → http://localhost:${PORT}/hook`);
});
