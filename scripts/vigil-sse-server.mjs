#!/usr/bin/env node
// SSE alert server — streams Vigil findings as Server-Sent Events
// so the trenchwork.org/security dashboard updates in real time.
// Runs on port 4201 by default. Connect to /events for the stream.

import { createServer } from 'node:http';
import { readFileSync, existsSync, watchFile } from 'node:fs';
import { join } from 'node:path';

const PORT = parseInt(process.env.VIGIL_SSE_PORT || '4201', 10);
const SITE_DIR = join(process.cwd(), 'site', 'vigil-web', 'public', 'security');
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// Watch for changes to latest.json
const latestPath = join(SITE_DIR, 'latest.json');
let lastData = null;

function checkAndBroadcast() {
  if (!existsSync(latestPath)) return;
  try {
    const raw = readFileSync(latestPath, 'utf8');
    const data = JSON.parse(raw);
    const hash = JSON.stringify(data);
    if (hash !== lastData) {
      lastData = hash;
      broadcast('findings-update', {
        timestamp: new Date().toISOString(),
        total: data.findings?.passes?.['npm-audit']?.totalAdvisories || 0,
        critical: data.findings?.passes?.['npm-audit']?.bySeverity?.critical || 0,
        high: data.findings?.passes?.['npm-audit']?.bySeverity?.high || 0,
        severity: data.severity,
      });
    }
  } catch {}
}

// Poll every 10 seconds for file changes
setInterval(checkAndBroadcast, 10000);
if (existsSync(latestPath)) {
  try { watchFile(latestPath, { interval: 5000 }, checkAndBroadcast); } catch {}
}

const server = createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({timestamp: new Date().toISOString()})}\n\n`);
    clients.add(res);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch { clearInterval(heartbeat); clients.delete(res); }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status:'ok', clients:clients.size, uptime:process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end('Vigil SSE Alert Server — /events for stream, /health for status');
});

server.listen(PORT, () => {
  console.log(`[vigil-sse] Alert server listening on http://localhost:${PORT}`);
  console.log(`[vigil-sse] Stream endpoint: http://localhost:${PORT}/events`);
  console.log(`[vigil-sse] Watching: ${latestPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  for (const res of clients) { try { res.end(); } catch {} }
  server.close();
  process.exit(0);
});
