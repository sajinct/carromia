import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/carromia') { res.writeHead(302, { Location: '/carromia/' }); return res.end(); }
  if (!url.pathname.startsWith('/carromia/') || url.pathname.includes('..')) { res.writeHead(404); return res.end('Not found'); }
  const path = join(import.meta.dirname, '..', 'dist', url.pathname.slice('/carromia/'.length) || 'index.html');
  if (!existsSync(path)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/plain' }); res.end(readFileSync(path));
}).listen(3001, '127.0.0.1', () => console.log('Pages preview: http://localhost:3001/carromia/'));
