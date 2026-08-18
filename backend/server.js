const crypto = require('crypto');
const express = require('express');
const Redis = require('ioredis');

const WEBHOOK_DISCLOSURE = 'Optional provider Webhooks are delivery notifications only. They do not create, transfer, confirm, govern, or establish financial responsibility for PayLock or Yaqeen.';
const SESSION_NOTICE = 'This is a constrained delivery session. Yaqeen preserves an encrypted, timestamped technical record of delivery activity. That record concerns delivery evidence only; it is not payment, settlement, refund, or funds evidence.';
const RATE_WINDOW_SECONDS = 60;

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function validateRuntimeConfig(source = process.env) {
  const production = (source.NODE_ENV || 'development') === 'production';
  const config = {
    production,
    redisUrl: source.REDIS_URL,
    paylockUrl: source.PAYLOCK_URL || 'http://127.0.0.1:4100',
    coreApiKey: source.PAYLOCK_CORE_API_KEY || source.API_KEY,
    internalApiKey: source.YAQEEN_INTERNAL_API_KEY || source.API_KEY || (production ? '' : 'development-internal-api-key'),
    operatorSecret: source.YAQEEN_OPERATOR_SECRET || (production ? '' : 'development-operator-secret'),
    sessionSecret: source.YAQEEN_SESSION_SECRET || (production ? '' : 'development-session-secret'),
    recordEncryptionKey: source.YAQEEN_RECORD_ENCRYPTION_KEY || (production ? '' : 'development-record-encryption-key'),
    publicOrigin: source.YAQEEN_PUBLIC_ORIGIN || 'http://localhost:4000',
    privateNetworkConfirmed: source.PAYLOCK_PRIVATE_NETWORK === 'true',
    allowTestMemoryStore: source.YAQEEN_TEST_MEMORY_STORE === 'true',
  };
  if (!production) return config;
  const errors = [];
  if (!config.redisUrl) errors.push('REDIS_URL is required in production.');
  if (!config.coreApiKey || config.coreApiKey === 'test-key') errors.push('PAYLOCK_CORE_API_KEY must be explicitly configured and must not equal "test-key" in production.');
  for (const [name, value] of Object.entries({ YAQEEN_OPERATOR_SECRET: config.operatorSecret, YAQEEN_SESSION_SECRET: config.sessionSecret, YAQEEN_RECORD_ENCRYPTION_KEY: config.recordEncryptionKey, YAQEEN_INTERNAL_API_KEY: config.internalApiKey })) {
    if (!value || value.length < 24 || value === 'test-key' || value.includes('development-')) errors.push(`${name} must be a non-test production secret.`);
  }
  if (!config.privateNetworkConfirmed) errors.push('PAYLOCK_PRIVATE_NETWORK=true is required after verifying the private Yaqeen-to-Core boundary.');
  if (!/^https:\/\//.test(config.publicOrigin)) errors.push('YAQEEN_PUBLIC_ORIGIN must be an HTTPS origin in production.');
  let url;
  try { url = new URL(config.paylockUrl); } catch (_) { errors.push('PAYLOCK_URL must be a valid private service URL.'); }
  if (url && /\.railway\.app$/i.test(url.hostname)) errors.push('PAYLOCK_URL must point to the private service network, not a public Railway hostname.');
  if (config.redisUrl && config.redisUrl.startsWith('memory://') && !config.allowTestMemoryStore) errors.push('A memory Redis substitute is permitted only in the explicit automated test harness.');
  if (errors.length) throw new Error(`Yaqeen production configuration invalid: ${errors.join(' ')}`);
  return config;
}

class MemoryStore {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  entry(key) { const item = this.values.get(key); if (item && item.expiresAt && item.expiresAt <= Date.now()) { this.values.delete(key); return null; } return item; }
  async get(key) { const item = this.entry(key); return item ? item.value : null; }
  async set(key, value, ...args) {
    const existing = this.entry(key);
    if (args.includes('NX') && existing) return null;
    const index = args.indexOf('EX');
    const seconds = index === -1 ? null : Number(args[index + 1]);
    this.values.set(key, { value: String(value), expiresAt: seconds ? Date.now() + seconds * 1000 : null });
    return 'OK';
  }
  async incr(key) { const item = this.entry(key); const value = Number(item ? item.value : 0) + 1; this.values.set(key, { value: String(value), expiresAt: item ? item.expiresAt : null }); return value; }
  async expire(key, seconds) { const item = this.entry(key); if (!item) return 0; item.expiresAt = Date.now() + Number(seconds) * 1000; this.values.set(key, item); return 1; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(String(value)); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, end) { const list = this.lists.get(key) || []; this.lists.set(key, list.slice(Number(start), Number(end) + 1)); return 'OK'; }
  async lrange(key, start, end) { const list = this.lists.get(key) || []; const finalEnd = Number(end) < 0 ? list.length : Number(end) + 1; return list.slice(Number(start), finalEnd); }
  async ping() { return 'PONG'; }
  async quit() { return 'OK'; }
}

function createStore(config, injected) {
  if (injected) return injected;
  if (!config.redisUrl || config.redisUrl.startsWith('memory://')) return new MemoryStore();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on('error', (error) => console.error('Yaqeen Redis error:', error.message));
  return redis;
}

const key = (type, id) => `yaqeen:${type}:${id}`;
const getJson = async (store, redisKey) => parseJson(await store.get(redisKey));
const putJson = async (store, redisKey, value, ttl) => ttl ? store.set(redisKey, JSON.stringify(value), 'EX', ttl) : store.set(redisKey, JSON.stringify(value));
async function appendEvent(store, providerId, event) {
  const record = { event_id: crypto.randomUUID(), at: new Date().toISOString(), ...event };
  await store.lpush(key('events', providerId), JSON.stringify(record));
  await store.ltrim(key('events', providerId), 0, 499);
  return record;
}

function encryptSecret(value, config) {
  const secretKey = crypto.createHash('sha256').update(config.recordEncryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptSecret(value, config) {
  const [iv, tag, encrypted] = String(value).split('.');
  const secretKey = crypto.createHash('sha256').update(config.recordEncryptionKey).digest();
  const cipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(iv, 'base64url'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8');
}

function makeSession(providerId, config) {
  const payload = Buffer.from(JSON.stringify({ providerId, exp: Date.now() + 8 * 60 * 60 * 1000, nonce: crypto.randomUUID() })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')}`;
}
function readSession(cookie, config) {
  const [payload, signature] = String(cookie || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  const data = parseJson(Buffer.from(payload, 'base64url').toString('utf8'));
  return data && data.providerId && data.exp > Date.now() ? data : null;
}
function cookies(request) {
  return String(request.headers.cookie || '').split(';').reduce((result, part) => { const [name, ...value] = part.trim().split('='); if (name) result[name] = decodeURIComponent(value.join('=')); return result; }, {});
}
function safeText(value, max = 160) { return String(value || '').trim().replace(/[<>]/g, '').slice(0, max); }
function validUrl(value, production) { try { const parsed = new URL(value); return parsed.protocol === 'https:' || (!production && parsed.protocol === 'http:'); } catch (_) { return false; } }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

function rateLimit(store, name, maximum) {
  return async (request, response, next) => {
    try {
      const window = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
      const identity = sha256(`${request.ip || 'unknown'}:${request.headers['user-agent'] || ''}`);
      const redisKey = key('rate', `${name}:${window}:${identity}`);
      const count = await store.incr(redisKey);
      if (count === 1) await store.expire(redisKey, RATE_WINDOW_SECONDS + 1);
      response.setHeader('RateLimit-Limit', maximum);
      response.setHeader('RateLimit-Remaining', Math.max(0, maximum - count));
      if (count > maximum) return response.status(429).json({ error: 'Too many requests. Please try again shortly.' });
      return next();
    } catch (_) { return response.status(503).json({ error: 'Delivery records are temporarily unavailable.' }); }
  };
}

async function coreRequest(config, fetchImpl, path, body) {
  const response = await fetchImpl(`${config.paylockUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.coreApiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const data = parseJson(await response.text(), { error: 'PayLock Core returned a non-JSON response.' });
  if (!response.ok) { const error = new Error(`PayLock Core request failed with ${response.status}.`); error.status = response.status; error.payload = data; throw error; }
  return data;
}

async function sendWebhook(store, config, fetchImpl, provider, delivery) {
  if (!provider.webhook || !provider.webhook.enabled) return;
  const event = { id: crypto.randomUUID(), type: 'delivery.lifecycle', occurred_at: new Date().toISOString(), resource_ref: delivery.resourceId, delivery_ref: delivery.id, status: delivery.status, disclosure: WEBHOOK_DISCLOSURE };
  const payload = JSON.stringify(event);
  const signature = crypto.createHmac('sha256', decryptSecret(provider.webhook.secretCiphertext, config)).update(payload).digest('hex');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let delivered = false; let failure = null; let receiverStatus;
    try {
      const receiver = await fetchImpl(provider.webhook.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-yaqeen-event-id': event.id, 'x-yaqeen-timestamp': event.occurred_at, 'x-yaqeen-signature': `sha256=${signature}`, 'x-yaqeen-webhook-disclosure': WEBHOOK_DISCLOSURE }, body: payload, signal: AbortSignal.timeout(5_000) });
      receiverStatus = receiver.status; delivered = receiver.ok; if (!delivered) failure = `HTTP ${receiver.status}`;
    } catch (_) { failure = 'network_or_timeout'; }
    await appendEvent(store, provider.id, { type: 'webhook.delivery', delivery_id: delivery.id, resource_id: delivery.resourceId, webhook_event_id: event.id, attempt, status: delivered ? 'DELIVERED' : 'FAILED', receiver_status: receiverStatus, failure });
    if (delivered) return;
  }
}

function providerPage(authenticated) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = authenticated
    ? '<h1>Yaqeen Provider Workspace</h1><p>Create a resource and issue one constrained access link. No PayLock credential is available to this browser.</p><form id="r"><input name="title" placeholder="Resource title" required><input name="delivery_url" placeholder="https://delivery.example/resource" required><button>Create resource</button></form><form id="t"><input name="resource_id" placeholder="Resource ID" required><button>Issue one-time link</button></form><pre id="out"></pre><script nonce="' + nonce + '">for(const x of [["r","/provider/resources"],["t","/provider/tickets"]])document.getElementById(x[0]).onsubmit=async e=>{e.preventDefault();const r=await fetch(x[1],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});out.textContent=JSON.stringify(await r.json(),null,2)}</script>'
    : '<h1>Yaqeen Provider Workspace</h1><p>Sign in with the operator secret configured for this provider-isolated stack. This is not an end-user API key.</p><form id="l"><input name="operator_secret" type="password" placeholder="Operator secret" required><button>Sign in</button></form><script nonce="' + nonce + '">document.getElementById("l").onsubmit=async e=>{e.preventDefault();const r=await fetch("/provider/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});if(r.ok)location.reload()}</script>';
  return { nonce, html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Yaqeen Provider Workspace</title><style>body{background:#111311;color:#eeeadd;font-family:system-ui;max-width:680px;margin:0 auto;padding:48px}form{display:grid;gap:12px;padding:20px;border:1px solid #394137;margin:20px 0}input,button{padding:10px;font:inherit}button{background:#b8f56a;color:#111311;border:0;font-weight:700}</style></head><body>' + body + '</body></html>' };
}
function deliveryPage(ticket, resource, rawTicket) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const title = escapeHtml(resource.title);
  return { nonce, html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Open delivery</title><style>body{background:#111311;color:#eeeadd;font-family:system-ui;max-width:680px;margin:0 auto;padding:48px}main{padding:28px;border:1px solid #394137}button{background:#b8f56a;color:#111311;border:0;padding:12px;font:inherit;font-weight:700}</style></head><body><main><h1>' + title + '</h1><p>' + escapeHtml(SESSION_NOTICE) + '</p><p>This link can be opened once.</p><button id="open">Open assigned resource</button><p id="out"></p></main><script nonce="' + nonce + '">document.getElementById("open").onclick=async()=>{open.disabled=true;out.textContent="Opening your assigned resource…";const r=await fetch("/deliver/' + encodeURIComponent(rawTicket) + '/open",{method:"POST"});const d=await r.json();if(r.ok)location.assign(d.redirect_url);else out.textContent=d.error||"Delivery unavailable."}</script></body></html>' };
}

function createApp(options = {}) {
  const config = options.config || validateRuntimeConfig(options.env || process.env);
  const store = createStore(config, options.store);
  const fetchImpl = options.fetchImpl || global.fetch;
  const app = express();
  app.set('trust proxy', 1); app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((error, request, response, next) => error instanceof SyntaxError && 'body' in error ? response.status(400).json({ error: 'Invalid JSON request body.' }) : next(error));
  app.use((request, response, next) => { response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  const providerLimit = rateLimit(store, 'provider', 30); const deliveryLimit = rateLimit(store, 'delivery', 12); const internalLimit = rateLimit(store, 'internal', 60);
  const requireProvider = (request, response, next) => { const session = readSession(cookies(request).yaqeen_operator, config); if (!session) return response.status(401).json({ error: 'Provider operator authentication is required.' }); request.provider = session; return next(); };
  const requireInternal = (request, response, next) => safeEqual(request.headers['x-api-key'], config.internalApiKey) ? next() : response.status(401).json({ error: 'Unauthorized' });
  const disclosure = (request, response, next) => { response.setHeader('X-Yaqeen-Webhook-Disclosure', WEBHOOK_DISCLOSURE); next(); };

  app.get('/healthz', async (request, response) => { try { await store.ping(); return response.json({ status: 'ok' }); } catch (_) { return response.status(503).json({ status: 'unavailable' }); } });
  app.get('/provider', providerLimit, (request, response) => { const page = providerPage(Boolean(readSession(cookies(request).yaqeen_operator, config))); response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`); response.type('html').send(page.html); });
  app.post('/provider/login', providerLimit, (request, response) => { if (!safeEqual(request.body && request.body.operator_secret, config.operatorSecret)) return response.status(401).json({ error: 'Invalid provider operator secret.' }); const providerId = safeText(request.body.provider_id || 'default-provider', 64) || 'default-provider'; response.cookie('yaqeen_operator', makeSession(providerId, config), { httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' }); return response.json({ status: 'authenticated', provider_id: providerId }); });
  app.post('/provider/resources', providerLimit, requireProvider, async (request, response) => { const title = safeText(request.body && request.body.title); const deliveryUrl = String(request.body && request.body.delivery_url || '').trim(); if (!title) return response.status(400).json({ error: 'A resource title is required.' }); if (!validUrl(deliveryUrl, config.production)) return response.status(400).json({ error: 'A valid HTTPS delivery URL is required.' }); const now = new Date().toISOString(); const resource = { id: crypto.randomUUID(), providerId: request.provider.providerId, title, deliveryUrl, active: true, createdAt: now }; await putJson(store, key('resource', resource.id), resource); await appendEvent(store, resource.providerId, { type: 'resource.created', resource_id: resource.id, status: 'RECORDED' }); return response.status(201).json({ resource: { id: resource.id, title: resource.title, active: resource.active, created_at: resource.createdAt } }); });
  app.post('/provider/tickets', providerLimit, requireProvider, async (request, response) => { const resource = await getJson(store, key('resource', safeText(request.body && request.body.resource_id, 80))); if (!resource || resource.providerId !== request.provider.providerId || !resource.active) return response.status(404).json({ error: 'Active delivery resource not found.' }); const candidate = Number(request.body && request.body.expires_in_seconds || 86400); const ttl = Number.isInteger(candidate) ? Math.min(Math.max(candidate, 60), 604800) : 86400; const rawTicket = crypto.randomBytes(32).toString('hex'); const ticket = { id: crypto.randomUUID(), ticketHash: sha256(rawTicket), resourceId: resource.id, providerId: resource.providerId, status: 'ISSUED', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; await putJson(store, key('ticket', ticket.ticketHash), ticket, ttl); await appendEvent(store, ticket.providerId, { type: 'delivery.session_issued', delivery_id: ticket.id, resource_id: resource.id, status: 'ISSUED', notice: SESSION_NOTICE }); return response.status(201).json({ delivery_url: new URL(`/deliver/${rawTicket}`, config.publicOrigin).toString(), expires_at: ticket.expiresAt, notification: SESSION_NOTICE }); });
  app.put('/provider/webhook', providerLimit, disclosure, requireProvider, async (request, response) => { const enabled = request.body && request.body.enabled === true; const endpoint = String(request.body && request.body.endpoint || '').trim(); const secret = String(request.body && request.body.secret || ''); if (enabled && !/^https:\/\//.test(endpoint)) return response.status(400).json({ error: 'An HTTPS Webhook endpoint is required.', disclosure: WEBHOOK_DISCLOSURE }); if (enabled && secret.length < 32) return response.status(400).json({ error: 'Webhook secret must contain at least 32 characters.', disclosure: WEBHOOK_DISCLOSURE }); const saved = { id: request.provider.providerId, webhook: enabled ? { enabled: true, endpoint, secretCiphertext: encryptSecret(secret, config) } : { enabled: false }, updatedAt: new Date().toISOString() }; await putJson(store, key('provider', saved.id), saved); await appendEvent(store, saved.id, { type: 'webhook.configuration', status: enabled ? 'ENABLED' : 'DISABLED', disclosure: WEBHOOK_DISCLOSURE }); return response.json({ webhook: { enabled, endpoint: enabled ? endpoint : null }, disclosure: WEBHOOK_DISCLOSURE }); });
  app.get('/provider/events', providerLimit, requireProvider, async (request, response) => response.json({ events: (await store.lrange(key('events', request.provider.providerId), 0, 99)).map((event) => parseJson(event)).filter(Boolean) }));
  app.get('/deliver/:ticket', deliveryLimit, async (request, response) => { const ticket = await getJson(store, key('ticket', sha256(request.params.ticket))); if (!ticket || ticket.status !== 'ISSUED') return response.status(404).type('html').send('<p>This delivery link is unavailable or already used.</p>'); const resource = await getJson(store, key('resource', ticket.resourceId)); if (!resource || !resource.active) return response.status(410).type('html').send('<p>This delivery resource is unavailable.</p>'); const page = deliveryPage(ticket, resource, request.params.ticket); response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`); return response.type('html').send(page.html); });
  app.post('/deliver/:ticket/open', deliveryLimit, async (request, response) => { const ticketHash = sha256(request.params.ticket); const ticket = await getJson(store, key('ticket', ticketHash)); if (!ticket || ticket.status !== 'ISSUED') return response.status(404).json({ error: 'This delivery link is unavailable or already used.' }); const resource = await getJson(store, key('resource', ticket.resourceId)); if (!resource || !resource.active) return response.status(410).json({ error: 'This delivery resource is unavailable.' }); if (!await store.set(key('ticket-claim', ticketHash), ticket.id, 'NX', 'EX', 86400)) return response.status(409).json({ error: 'This one-time delivery link has already been redeemed.' }); ticket.status = 'REDEEMING'; ticket.redeemedAt = new Date().toISOString(); await putJson(store, key('ticket', ticketHash), ticket, 86400); await appendEvent(store, ticket.providerId, { type: 'delivery.redeeming', delivery_id: ticket.id, resource_id: resource.id, status: 'REDEEMING', notice: SESSION_NOTICE }); try { const fingerprint = sha256(`${ticketHash}:${request.headers['user-agent'] || 'unknown'}:${request.headers['accept-language'] || ''}`); const session = await coreRequest(config, fetchImpl, '/v1/session', { service_id: resource.id, device_id: fingerprint }); if (!session.h0) throw new Error('PayLock Core session response omitted its internal reference.'); await coreRequest(config, fetchImpl, '/v1/signal', { h0: session.h0, signal_type: 'provider_ack', signal_ref: `yaqeen-resource:${resource.id}` }); const unlock = await coreRequest(config, fetchImpl, '/v1/unlock', { h0: session.h0, device_fingerprint: fingerprint }); const resolved = unlock.h1 ? unlock : await coreRequest(config, fetchImpl, '/v1/resolve', { h0: session.h0 }); if (!resolved.h1) throw new Error('PayLock Core did not produce delivery evidence.'); await putJson(store, key('internal-core-record', ticket.id), { delivery_id: ticket.id, h0: session.h0, h1: resolved.h1, stored_at: new Date().toISOString() }); ticket.status = 'DELIVERED'; ticket.deliveredAt = new Date().toISOString(); await putJson(store, key('ticket', ticketHash), ticket, 86400); await appendEvent(store, ticket.providerId, { type: 'delivery.completed', delivery_id: ticket.id, resource_id: resource.id, status: 'DELIVERED', notice: SESSION_NOTICE }); const provider = await getJson(store, key('provider', ticket.providerId)); if (provider) await sendWebhook(store, config, fetchImpl, provider, ticket); return response.json({ status: 'delivered', redirect_url: resource.deliveryUrl, notice: SESSION_NOTICE }); } catch (error) { ticket.status = 'FAILED'; ticket.failureCode = error.status ? `CORE_${error.status}` : 'DELIVERY_TRANSITION_FAILED'; await putJson(store, key('ticket', ticketHash), ticket, 86400); await appendEvent(store, ticket.providerId, { type: 'delivery.failed', delivery_id: ticket.id, resource_id: resource.id, status: 'FAILED', failure_code: ticket.failureCode, notice: SESSION_NOTICE }); return response.status(502).json({ error: 'The delivery transition could not be completed. This link remains unavailable to preserve one-time delivery control.' }); } });
  // Server-only legacy compatibility endpoints, retained for the existing direct Core release suite. The unsafe demo execute route is intentionally absent.
  app.use('/api', internalLimit, requireInternal);
  app.get('/api/health', (request, response) => response.json({ status: 'ok', service: 'yaqeen-platform' }));
  for (const [route, coreRoute] of [['/session', '/v1/session'], ['/signal', '/v1/signal'], ['/resolve', '/v1/resolve']]) app.post(`/api${route}`, async (request, response) => { try { return response.json(await coreRequest(config, fetchImpl, coreRoute, request.body)); } catch (error) { return response.status(error.status || 502).json(error.payload || { error: 'Core request failed.' }); } });
  app.post('/api/unlock', async (request, response) => {
    const body = request.body || {};
    try {
      const unlock = await coreRequest(config, fetchImpl, '/v1/unlock', { h0: body.h0, device_fingerprint: body.device_fingerprint || 'server-only-client' });
      const resolved = unlock.h1 ? unlock : await coreRequest(config, fetchImpl, '/v1/resolve', { h0: body.h0 });
      if (!resolved.h1) return response.status(409).json({ error: 'H1 was not generated.' });
      return response.json({ h0: body.h0, h1: resolved.h1, status: 'EXECUTION_PROVEN', proof_status: 'EXECUTION_PROVEN' });
    } catch (error) { return response.status(error.status || 502).json(error.payload || { error: 'Unlock failed.' }); }
  });
  app.post('/api/verify', async (request, response) => { const { h0, h1 } = request.body || {}; if (!h0 || !h1) return response.status(400).json({ error: 'Missing h0 or h1.' }); try { const resolved = await coreRequest(config, fetchImpl, '/v1/resolve', { h0 }); return response.json({ valid: resolved.h1 === h1 }); } catch (error) { return response.status(error.status || 502).json(error.payload || { error: 'Verification failed.' }); } });
  app.locals.yaqeen = { config, store };
  return app;
}

async function start() { const config = validateRuntimeConfig(process.env); const store = createStore(config); if (config.production) await store.ping(); const app = createApp({ config, store }); const port = process.env.PORT || 4000; app.listen(port, '0.0.0.0', () => console.log(`Yaqeen delivery platform listening on port ${port}`)); }
if (require.main === module) start().catch((error) => { console.error(`FATAL: ${error.message}`); process.exit(1); });
module.exports = { createApp, validateRuntimeConfig, MemoryStore, safeEqual, sha256, encryptSecret, decryptSecret, WEBHOOK_DISCLOSURE, SESSION_NOTICE };
