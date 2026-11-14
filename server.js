'use strict';
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const password = process.env.SITE_PASSWORD || '';
if (password.length < 16) { console.error('SITE_PASSWORD must be set to at least 16 characters.'); process.exit(1); }
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'));
const maxImage = 20 * 1024 * 1024;
const attempts = new Map();
function send(res, status, data, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, {'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'}); res.end(body);
}
function authenticated(req) {
  try {
    if (!req.headers.authorization?.startsWith('Basic ')) return false;
    const [user, ...parts] = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':');
    const candidate = Buffer.from(parts.join(':')); const expected = Buffer.from(password);
    return user === 'wan' && candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch { return false; }
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {size += c.length; if (size > max) { reject(Object.assign(new Error('Request too large'), {status:413})); req.destroy(); } else chunks.push(c);});
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
function sameOrigin(req) {
  try { const origin = new URL(req.headers.origin); return origin.host === req.headers.host && (origin.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && origin.protocol === 'http:')); } catch { return false; }
}
async function atlas(path, key, opts = {}) {
  const response = await fetch('https://api.atlascloud.ai' + path, {...opts, headers: {...opts.headers, Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(120000)});
  const text = await response.text();
  return {status: response.status, text: text || JSON.stringify({error:'Atlas Cloud returned an empty response'})};
}
const server = http.createServer(async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(); const record = attempts.get(ip);
    if (record && record.until > now) return send(res, 429, {error:'Too many login attempts. Try again later.'});
    if (!authenticated(req)) {
      if (req.headers.authorization) {const r = record && now - record.first < 600000 ? record : {first:now,count:0,until:0}; if (++r.count >= 10) r.until = now + 600000; attempts.set(ip,r); if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);}
      res.writeHead(401, {'WWW-Authenticate':'Basic realm="Wan Studio", charset="UTF-8"','Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8'}); return res.end('Login required');
    }
    attempts.delete(ip);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/health') return send(res, 200, {service:'wan-studio', upload:true});
    if (req.method !== 'POST' || !sameOrigin(req)) return send(res, 403, {error:'Forbidden'});
    if (path === '/api') {
      const request = JSON.parse((await readBody(req, 100000)).toString('utf8')); const key = request.key;
      if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) return send(res, 400, {error:'Invalid API key'});
      let result;
      if (request.action === 'generate' && request.payload && typeof request.payload === 'object') {
        result = await atlas('/api/v1/model/generateVideo', key, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request.payload)});
      } else if (request.action === 'poll' && /^[A-Za-z0-9_-]{1,200}$/.test(request.id || '')) {
        result = await atlas('/api/v1/model/prediction/' + request.id, key);
      } else return send(res, 400, {error:'Invalid request'});
      return send(res, result.status, result.text);
    }
    if (path === '/upload') {
      const key = req.headers['x-api-key']; const type = req.headers['x-file-type'];
      const extensions = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/bmp':'bmp'};
      if (!key || /[\r\n]/.test(key) || !extensions[type]) return send(res, 400, {error:'Invalid image or API key'});
      const bytes = await readBody(req, maxImage); if (!bytes.length) return send(res, 400, {error:'Image is empty'});
      const form = new FormData(); form.append('file', new Blob([bytes], {type}), 'image.' + extensions[type]);
      const result = await atlas('/api/v1/model/uploadMedia', key, {method:'POST', body:form});
      return send(res, result.status, result.text);
    }
    return send(res, 404, {error:'Not found'});
  } catch (error) { if (!res.headersSent && !res.destroyed) send(res, error.status || 500, {error:error.message || 'Request failed'}); }
});
server.requestTimeout = 150000; server.headersTimeout = 30000;
server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('Wan Studio server listening'));
