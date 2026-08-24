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
  async del(key) { this.values.delete(key); this.lists.delete(key); return 1; }
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
  return String(request.headers.cookie || '').split(';').reduce((result, part) => { const [name, ...value] = part.trim().split('='); if (name) { try { result[name] = decodeURIComponent(value.join('=')); } catch (_) { result[name] = ''; } } return result; }, {});
}
function safeText(value, max = 160) { return String(value || '').trim().replace(/[<>]/g, '').slice(0, max); }
function validUrl(value, production) { try { const parsed = new URL(value); return parsed.protocol === 'https:' || (!production && parsed.protocol === 'http:'); } catch (_) { return false; } }
function safePublicUrl(value, production) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !production)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' || host === '127.0.0.1' || host === '::1' || host.startsWith('10.') || host.startsWith('192.168.') || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(host) || host.startsWith('169.254.')) return false;
    return true;
  } catch (_) { return false; }
}
function sameOrigin(request) {
  const raw = String(request.headers.origin || request.headers.referer || '').trim();
  if (!raw) return true;
  try { return new URL(raw).origin === `${request.protocol}://${request.get('host')}`; } catch (_) { return false; }
}
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
  const response = await fetchImpl(`${config.paylockUrl}${path}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-api-key': config.coreApiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
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

const UI_STYLE = `<style>
:root{--graphite:#111311;--bone:#eeeadd;--lime:#b8f56a;--soft:#171a17;--muted:#9da097;--border:rgba(238,234,221,.16);--rust:#b7684b;--serif:"Cormorant Garamond",Georgia,serif;--sans:Manrope,Arial,sans-serif;--mono:"IBM Plex Mono",monospace}*{box-sizing:border-box}html{background:var(--graphite)}body{margin:0;background:radial-gradient(circle at 82% 0%,rgba(184,245,106,.07),transparent 32rem),var(--graphite);color:var(--bone);font-family:var(--sans);line-height:1.55}a{color:inherit;text-decoration:none}.shell{width:min(1120px,calc(100% - 48px));margin:0 auto;padding:34px 0 64px}.topline{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:24px;border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:12px}.mark{position:relative;display:inline-flex;align-items:center;gap:0;width:70px;height:35px;padding:0 8px;border:2px solid var(--bone);font:700 19px/.8 Arial,sans-serif;letter-spacing:-.2em}.mark:before{content:"";position:absolute;left:-2px;bottom:-2px;width:22px;height:2px;background:var(--graphite)}.mark i{position:absolute;right:-7px;top:11px;width:10px;height:10px;border-radius:50%;background:var(--rust)}.brand-copy{display:flex;flex-direction:column;gap:2px}.brand-copy strong{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase}.brand-copy span,.eyebrow,.label,.status,.meta{color:var(--muted);font:9px var(--mono);letter-spacing:.12em;text-transform:uppercase}.eyebrow{display:flex;align-items:center;gap:8px;color:var(--lime)}.eyebrow i{width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 12px rgba(184,245,106,.6)}h1,h2{margin:0;font:500 clamp(48px,7vw,92px)/.86 var(--serif);letter-spacing:-.06em}h1 em,h2 em{color:var(--lime);font-style:italic}.intro{max-width:680px;margin:52px 0 38px}.intro p,.panel p{color:#aeb1a7;font-size:15px;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.panel{padding:24px;background:linear-gradient(145deg,rgba(184,245,106,.055),rgba(23,26,23,.94));border:1px solid rgba(184,245,106,.28);box-shadow:0 22px 56px rgba(0,0,0,.18)}.panel h2{font-size:37px;margin:0 0 18px}.panel-title{display:flex;justify-content:space-between;gap:18px;margin-bottom:16px}.panel-title h2{margin:0}.panel-title .status{color:var(--lime)}form{display:grid;gap:12px;margin-top:18px}label{display:grid;gap:6px;color:#b9bdb4;font:9px var(--mono);letter-spacing:.1em;text-transform:uppercase}input,button{width:100%;padding:12px;border-radius:0;font:14px var(--sans)}input{border:1px solid rgba(238,234,221,.2);background:rgba(10,13,10,.72);color:var(--bone)}input:focus{outline:2px solid var(--lime);outline-offset:2px;border-color:var(--lime)}button{border:1px solid var(--lime);background:var(--lime);color:var(--graphite);font:600 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;cursor:pointer}button:hover{background:#d1f9a0;transform:translateY(-1px)}button:active{transform:scale(.98)}.outline{background:transparent;color:var(--bone);border-color:rgba(238,234,221,.42)}.outline:hover{color:var(--lime);border-color:var(--lime);background:transparent}.wide{grid-column:1/-1}.result{min-height:34px;margin:16px 0 0;padding:12px;background:rgba(10,13,10,.62);border-left:2px solid var(--lime);color:#c7cbbf;white-space:pre-wrap;font:11px/1.55 var(--mono)}.notice{padding:15px;border-left:1px solid var(--lime);background:rgba(184,245,106,.045);color:#aeb1a7;font:11px/1.55 var(--mono)}.footer{display:flex;justify-content:space-between;gap:20px;margin-top:44px;padding-top:18px;border-top:1px solid var(--border);color:#797f76;font:9px var(--mono);letter-spacing:.08em;text-transform:uppercase}.delivery{max-width:760px;margin:78px auto}.delivery .panel{padding:32px}.delivery h1{font-size:clamp(54px,8vw,102px);margin:18px 0 24px}.delivery .notice{margin:24px 0}.delivery button{max-width:260px}.success{color:var(--lime)}.error{color:#efad93}@media(max-width:720px){.shell{width:min(100% - 32px,600px);padding-top:20px}.topline{align-items:flex-start}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.footer{display:block}.footer span{display:block;margin-top:8px}}
</style>`;
function pageFrame(title, body) { return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>' + escapeHtml(title) + ' — Yaqeen</title>' + UI_STYLE + '</head><body>' + body + '</body></html>'; }
function brandHeader(section) { return '<header class="topline"><div class="brand"><span class="mark" aria-hidden="true"><span>D</span><span>S</span><span>D</span><i></i></span><span class="brand-copy"><strong>YAQEEN</strong><span>Delivery proof layer / ' + escapeHtml(section) + '</span></span></div><span class="eyebrow"><i></i>PAYLOCK BOUNDARY</span></header>'; }
function providerPage(authenticated) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = authenticated ? `<main class="shell"><div>${brandHeader('PROVIDER WORKSPACE')}</div><section class="intro"><span class="eyebrow"><i></i>REQUEST / ACCEPT / RELEASE</span><h1>Make the delivery<br><em>record clear.</em></h1><p>Review a protected request, accept it on its existing PayLock session, and release one constrained access link. PayLock credentials never enter this browser.</p></section><div class="grid"><section class="panel wide"><div class="panel-title"><h2>Incoming requests</h2><span class="status">REQUEST QUEUE</span></div><p>Requests begin with the service requester. Acceptance records the provider signal on the same protected session.</p><form id="q"><button>Load incoming requests</button></form><pre class="result" id="requests">No requests loaded.</pre></section><section class="panel"><div class="panel-title"><h2>Accept request</h2><span class="status">ACK / H0</span></div><form id="a"><label>Request ID<input name="request_id" placeholder="Request ID" required></label><label>Provider reference<input name="provider_ref" placeholder="Resource-ready reference"></label><button>Accept protected request</button></form></section><section class="panel"><div class="panel-title"><h2>Create resource</h2><span class="status">RESOURCE READY</span></div><form id="r"><label>Resource title<input name="title" placeholder="Resource title" required></label><label>Delivery URL<input name="delivery_url" placeholder="https://delivery.example/resource" required></label><button>Create delivery resource</button></form></section><section class="panel wide"><div class="panel-title"><h2>Issue access</h2><span class="status">ONE-TIME GATE</span></div><form id="t"><label>Accepted request ID<input name="request_id" placeholder="Accepted request ID" required></label><label>Resource ID<input name="resource_id" placeholder="Resource ID" required></label><button>Issue one-time link</button></form><pre class="result" id="out">Awaiting provider action.</pre></section></div><footer class="footer"><span>Yaqeen / delivery proof layer</span><span>PayLock boundary / server-only</span></footer><script nonce="${nonce}">const out=document.getElementById("out");const show=async(url,options,target=out)=>{const r=await fetch(url,options);target.textContent=JSON.stringify(await r.json(),null,2)};document.getElementById("q").onsubmit=async e=>{e.preventDefault();await show("/provider/requests",undefined,document.getElementById("requests"))};document.getElementById("a").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));await show("/provider/requests/"+encodeURIComponent(f.request_id)+"/accept",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider_ref:f.provider_ref})})};for(const x of [["r","/provider/resources"],["t","/provider/tickets"]])document.getElementById(x[0]).onsubmit=async e=>{e.preventDefault();await show(x[1],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))})}</script></main>` : `<main class="shell"><div>${brandHeader('PROVIDER ACCESS')}</div><section class="intro"><span class="eyebrow"><i></i>CONTROLLED ACCESS</span><h1>Provider<br><em>workspace.</em></h1><p>Sign in to operate the delivery layer. This secret authenticates the provider operator; it is not an end-user API key.</p><section class="panel"><form id="l"><label>Operator secret<input name="operator_secret" type="password" placeholder="Operator secret" required></label><button>Enter workspace</button></form></section></section><footer class="footer"><span>Yaqeen / delivery proof layer</span><span>PayLock boundary / server-only</span></footer><script nonce="${nonce}">document.getElementById("l").onsubmit=async e=>{e.preventDefault();const r=await fetch("/provider/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});if(r.ok)location.reload();else document.getElementById("l").insertAdjacentHTML("beforeend","<p class=\"error\">Authentication failed.</p>")}</script></main>`;
  return { nonce, html: pageFrame(authenticated ? 'Provider Workspace' : 'Provider Access', body) };
}
function deliveryPage(ticket, resource, rawTicket) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const title = escapeHtml(resource.title);
  const body = `<main class="delivery shell"><div>${brandHeader('ASSIGNED DELIVERY')}</div><section class="panel"><span class="eyebrow"><i></i>ONE-TIME ACCESS / ${escapeHtml(ticket.status)}</span><h1>${title}</h1><div class="notice">${escapeHtml(SESSION_NOTICE)}</div><p>This assigned link can be opened once. Yaqeen will verify the protected delivery state before releasing the resource.</p><button id="open">Open assigned resource</button><p class="result" id="out">Ready when you are.</p></section><footer class="footer"><span>Yaqeen / delivery proof layer</span><span>Execution evidence / timestamped</span></footer><script nonce="${nonce}">document.getElementById("open").onclick=async()=>{const button=document.getElementById("open");const out=document.getElementById("out");button.disabled=true;out.textContent="Opening your assigned resource…";const r=await fetch("/deliver/${encodeURIComponent(rawTicket)}/open",{method:"POST"});const d=await r.json();if(r.ok)location.assign(d.redirect_url);else{button.disabled=false;out.textContent=d.error||"Delivery unavailable."}}</script></main>`;
  return { nonce, html: pageFrame('Open Delivery', body) };
}
function issueOpaqueTicket(store, resource, requestId, ttl = 86400) {
  const rawTicket = crypto.randomBytes(32).toString('hex');
  const ticket = { id: crypto.randomUUID(), ticketHash: sha256(rawTicket), requestId: requestId || null, resourceId: resource.id, providerId: resource.providerId, status: 'ISSUED', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  return { rawTicket, ticket };
}
function requesterPage() {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = `<main class="shell"><div>${brandHeader('REQUESTER ACCESS')}</div><section class="intro"><span class="eyebrow"><i></i>REQUEST / PROTECT / VERIFY</span><h1>Start with a<br><em>clear request.</em></h1><p>Yaqeen creates the protected PayLock session before the provider accepts the work. Your request token is private and is required to check its status.</p></section><div class="grid"><section class="panel"><div class="panel-title"><h2>Start request</h2><span class="status">H0 / INITIATE</span></div><form id="s"><label>Provider ID<input name="provider_id" placeholder="Provider ID" required></label><label>Service ID<input name="service_id" placeholder="Service ID" required></label><label>Service name<input name="service_name" placeholder="Service name"></label><label>Device reference<input name="device_id" placeholder="Device reference" required></label><button>Start protected request</button></form></section><section class="panel"><div class="panel-title"><h2>Track request</h2><span class="status">STATUS / PRIVATE</span></div><form id="v"><label>Request ID<input name="request_id" placeholder="Request ID" required></label><label>Private request token<input name="request_token" placeholder="Private request token" required></label><button class="outline">Check request status</button></form></section><section class="panel wide"><div class="notice">Yaqeen is the delivery proof layer. PayLock remains the protected protocol boundary. No PayLock credential is shown in this interface.</div><pre class="result" id="out">Awaiting request.</pre></section></div><footer class="footer"><span>Yaqeen / delivery proof layer</span><span>PayLock boundary / server-only</span></footer><script nonce="${nonce}">const out=document.getElementById("out");document.getElementById("s").onsubmit=async e=>{e.preventDefault();const r=await fetch("/request/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const d=await r.json();out.textContent=JSON.stringify(d,null,2)+(d.request_token?"\\n\\nKeep this private request token to check status.":"")};document.getElementById("v").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const r=await fetch("/request/status/"+encodeURIComponent(f.request_id),{headers:{"x-request-token":f.request_token}});out.textContent=JSON.stringify(await r.json(),null,2)}</script></main>`;
  return { nonce, html: pageFrame('Start a Request', body) };
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
  const providerLimit = rateLimit(store, 'provider', 30); const deliveryLimit = rateLimit(store, 'delivery', 12); const requesterLimit = rateLimit(store, 'requester', 20); const internalLimit = rateLimit(store, 'internal', 60);
  const requireProvider = (request, response, next) => { const session = readSession(cookies(request).yaqeen_operator, config); if (!session) return response.status(401).json({ error: 'Provider operator authentication is required.' }); request.provider = session; return next(); };
  const requireInternal = (request, response, next) => safeEqual(request.headers['x-api-key'], config.internalApiKey) ? next() : response.status(401).json({ error: 'Unauthorized' });
  const requireSameOrigin = (request, response, next) => sameOrigin(request) ? next() : response.status(403).json({ error: 'Cross-origin state change rejected.' });
  const disclosure = (request, response, next) => { response.setHeader('X-Yaqeen-Webhook-Disclosure', WEBHOOK_DISCLOSURE); next(); };

  app.get('/healthz', async (request, response) => { try { await store.ping(); return response.json({ status: 'ok' }); } catch (_) { return response.status(503).json({ status: 'unavailable' }); } });
  app.get('/', (request, response) => response.redirect(302, '/request'));
  app.get('/request', requesterLimit, (request, response) => { const page = requesterPage(); response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`); response.type('html').send(page.html); });
  app.post('/request/start', requesterLimit, requireSameOrigin, async (request, response) => {
    const providerId = safeText(request.body && request.body.provider_id, 64);
    const serviceId = safeText(request.body && request.body.service_id, 120);
    const serviceName = safeText(request.body && request.body.service_name, 160);
    const deviceId = safeText(request.body && request.body.device_id, 160);
    if (!providerId || !serviceId || !deviceId) return response.status(400).json({ error: 'provider_id, service_id, and device_id are required.' });
    const requestId = crypto.randomUUID();
    const rawRequestToken = crypto.randomBytes(32).toString('hex');
    try {
      const session = await coreRequest(config, fetchImpl, '/v1/session', { service_id: serviceId, service_name: serviceName || null, provider_id: providerId, device_id: deviceId, receipt_id: `yaqeen-request:${requestId}` });
      if (!session.h0) throw new Error('PayLock Core did not return H0.');
      const record = { id: requestId, requestTokenHash: sha256(rawRequestToken), providerId, serviceId, serviceName: serviceName || serviceId, deviceId, h0Ciphertext: encryptSecret(session.h0, config), status: 'REQUESTED', createdAt: new Date().toISOString() };
      await putJson(store, key('request', requestId), record, 86400);
      await appendEvent(store, providerId, { type: 'request.created', request_id: requestId, service_id: serviceId, status: 'REQUESTED', notice: SESSION_NOTICE });
      return response.status(201).json({ request_id: requestId, request_token: rawRequestToken, status: 'REQUESTED', notice: 'Your protected service request has been created. The provider can now review and complete delivery.' });
    } catch (error) { return response.status(error.status || 502).json({ error: 'The protected request could not be created.' }); }
  });
  app.get('/request/status/:requestId', requesterLimit, async (request, response) => { const id = safeText(request.params.requestId, 80); const token = String(request.headers['x-request-token'] || ''); const record = await getJson(store, key('request', id)); if (!record || !token || !safeEqual(sha256(token), record.requestTokenHash)) return response.status(404).json({ error: 'Request not found.' }); return response.json({ request_id: record.id, status: record.status, service_name: record.serviceName, delivery_url: record.deliveryUrl || null, notice: record.status === 'DELIVERED' ? SESSION_NOTICE : 'The protected request is being processed.' }); });
  app.get('/provider', providerLimit, (request, response) => { const page = providerPage(Boolean(readSession(cookies(request).yaqeen_operator, config))); response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`); response.type('html').send(page.html); });
  app.post('/provider/login', providerLimit, requireSameOrigin, (request, response) => { if (!safeEqual(request.body && request.body.operator_secret, config.operatorSecret)) return response.status(401).json({ error: 'Invalid provider operator secret.' }); const providerId = safeText(request.body.provider_id || 'default-provider', 64) || 'default-provider'; response.cookie('yaqeen_operator', makeSession(providerId, config), { httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' }); return response.json({ status: 'authenticated', provider_id: providerId }); });
  app.post('/provider/resources', providerLimit, requireSameOrigin, requireProvider, async (request, response) => { const title = safeText(request.body && request.body.title); const deliveryUrl = String(request.body && request.body.delivery_url || '').trim(); if (!title) return response.status(400).json({ error: 'A resource title is required.' }); if (!safePublicUrl(deliveryUrl, config.production)) return response.status(400).json({ error: 'A valid public HTTPS delivery URL is required.' }); const now = new Date().toISOString(); const resource = { id: crypto.randomUUID(), providerId: request.provider.providerId, title, deliveryUrl, active: true, createdAt: now }; await putJson(store, key('resource', resource.id), resource); await appendEvent(store, resource.providerId, { type: 'resource.created', resource_id: resource.id, status: 'RECORDED' }); return response.status(201).json({ resource: { id: resource.id, title: resource.title, active: resource.active, created_at: resource.createdAt } }); });
  app.get('/provider/requests', providerLimit, requireProvider, async (request, response) => { const events = (await store.lrange(key('events', request.provider.providerId), 0, 499)).map((event) => parseJson(event)).filter((event) => event && event.type === 'request.created'); const requests = []; for (const event of events) { const record = await getJson(store, key('request', event.request_id)); if (record && record.providerId === request.provider.providerId) requests.push({ request_id: record.id, service_id: record.serviceId, service_name: record.serviceName, status: record.status, created_at: record.createdAt }); } return response.json({ requests }); });
  app.post('/provider/requests/:requestId/accept', providerLimit, requireSameOrigin, requireProvider, async (request, response) => { const requestId = safeText(request.params.requestId, 80); const record = await getJson(store, key('request', requestId)); if (!record || record.providerId !== request.provider.providerId) return response.status(404).json({ error: 'Request not found.' }); if (record.status !== 'REQUESTED') return response.status(409).json({ error: 'Request is not awaiting provider acceptance.' }); const providerRef = safeText(request.body && request.body.provider_ref, 160) || `yaqeen-provider:${request.provider.providerId}:${record.id}`; let h0; try { h0 = decryptSecret(record.h0Ciphertext, config); } catch (_) { return response.status(500).json({ error: 'The protected request record is invalid.' }); } await coreRequest(config, fetchImpl, '/v1/signal', { h0, signal_type: 'provider_ack', signal_ref: providerRef }); record.status = 'ACCEPTED'; record.providerRef = providerRef; record.acceptedAt = new Date().toISOString(); await putJson(store, key('request', record.id), record, 86400); await appendEvent(store, record.providerId, { type: 'request.accepted', request_id: record.id, status: 'ACCEPTED', notice: SESSION_NOTICE }); return response.json({ request_id: record.id, status: record.status, notice: 'The provider accepted the protected request. A delivery link can now be issued.' }); });
  app.post('/provider/tickets', providerLimit, requireSameOrigin, requireProvider, async (request, response) => { const resource = await getJson(store, key('resource', safeText(request.body && request.body.resource_id, 80))); if (!resource || resource.providerId !== request.provider.providerId || !resource.active) return response.status(404).json({ error: 'Active delivery resource not found.' }); const requestId = safeText(request.body && request.body.request_id, 80); const linkedRequest = requestId ? await getJson(store, key('request', requestId)) : null; if (linkedRequest && (linkedRequest.providerId !== request.provider.providerId || linkedRequest.status !== 'ACCEPTED')) return response.status(409).json({ error: 'The request must be accepted before a delivery link is issued.' }); if (!linkedRequest && config.production) return response.status(409).json({ error: 'A delivery link must be tied to an accepted protected request.' }); const candidate = Number(request.body && request.body.expires_in_seconds || 86400); const ttl = Number.isInteger(candidate) ? Math.min(Math.max(candidate, 60), 604800) : 86400; const { rawTicket, ticket } = issueOpaqueTicket(store, resource, linkedRequest ? linkedRequest.id : null, ttl); await putJson(store, key('ticket', ticket.ticketHash), ticket, ttl); await appendEvent(store, ticket.providerId, { type: 'delivery.session_issued', delivery_id: ticket.id, request_id: linkedRequest ? linkedRequest.id : null, resource_id: resource.id, status: 'ISSUED', notice: SESSION_NOTICE }); if (linkedRequest) { linkedRequest.status = 'LINK_ISSUED'; linkedRequest.resourceId = resource.id; linkedRequest.deliveryUrl = new URL(`/deliver/${rawTicket}`, config.publicOrigin).toString(); await putJson(store, key('request', linkedRequest.id), linkedRequest, 86400); } return response.status(201).json({ delivery_url: new URL(`/deliver/${rawTicket}`, config.publicOrigin).toString(), expires_at: ticket.expiresAt, notification: SESSION_NOTICE }); });
  app.put('/provider/webhook', providerLimit, requireSameOrigin, disclosure, requireProvider, async (request, response) => { const enabled = request.body && request.body.enabled === true; const endpoint = String(request.body && request.body.endpoint || '').trim(); const secret = String(request.body && request.body.secret || ''); if (enabled && !safePublicUrl(endpoint, config.production)) return response.status(400).json({ error: 'A valid public HTTPS Webhook endpoint is required.', disclosure: WEBHOOK_DISCLOSURE }); if (enabled && secret.length < 32) return response.status(400).json({ error: 'Webhook secret must contain at least 32 characters.', disclosure: WEBHOOK_DISCLOSURE }); const saved = { id: request.provider.providerId, webhook: enabled ? { enabled: true, endpoint, secretCiphertext: encryptSecret(secret, config) } : { enabled: false }, updatedAt: new Date().toISOString() }; await putJson(store, key('provider', saved.id), saved); await appendEvent(store, saved.id, { type: 'webhook.configuration', status: enabled ? 'ENABLED' : 'DISABLED', disclosure: WEBHOOK_DISCLOSURE }); return response.json({ webhook: { enabled, endpoint: enabled ? endpoint : null }, disclosure: WEBHOOK_DISCLOSURE }); });
  app.get('/provider/events', providerLimit, requireProvider, async (request, response) => response.json({ events: (await store.lrange(key('events', request.provider.providerId), 0, 99)).map((event) => parseJson(event)).filter(Boolean) }));
  app.get('/deliver/:ticket', deliveryLimit, async (request, response) => { const ticket = await getJson(store, key('ticket', sha256(request.params.ticket))); if (!ticket || ticket.status !== 'ISSUED') return response.status(404).type('html').send('<p>This delivery link is unavailable or already used.</p>'); const resource = await getJson(store, key('resource', ticket.resourceId)); if (!resource || !resource.active) return response.status(410).type('html').send('<p>This delivery resource is unavailable.</p>'); const page = deliveryPage(ticket, resource, request.params.ticket); response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`); return response.type('html').send(page.html); });
  app.post('/deliver/:ticket/open', deliveryLimit, async (request, response) => { const ticketHash = sha256(request.params.ticket); const ticket = await getJson(store, key('ticket', ticketHash)); if (!ticket || ticket.status !== 'ISSUED') return response.status(404).json({ error: 'This delivery link is unavailable or already used.' }); const resource = await getJson(store, key('resource', ticket.resourceId)); if (!resource || !resource.active) return response.status(410).json({ error: 'This delivery resource is unavailable.' }); if (!await store.set(key('ticket-claim', ticketHash), ticket.id, 'NX', 'EX', 86400)) return response.status(409).json({ error: 'This one-time delivery link has already been redeemed.' }); ticket.status = 'REDEEMING'; ticket.redeemedAt = new Date().toISOString(); await putJson(store, key('ticket', ticketHash), ticket, 86400); await appendEvent(store, ticket.providerId, { type: 'delivery.redeeming', delivery_id: ticket.id, resource_id: resource.id, status: 'REDEEMING', notice: SESSION_NOTICE }); let requestRecord = null; try { const fingerprint = sha256(`${ticketHash}:${request.headers['user-agent'] || 'unknown'}:${request.headers['accept-language'] || ''}`); requestRecord = ticket.requestId ? await getJson(store, key('request', ticket.requestId)) : null; if (ticket.requestId && (!requestRecord || requestRecord.providerId !== ticket.providerId || !requestRecord.h0Ciphertext || !['ACCEPTED', 'LINK_ISSUED'].includes(requestRecord.status))) throw new Error('The protected request is not in a deliverable state.'); const session = requestRecord ? { h0: decryptSecret(requestRecord.h0Ciphertext, config) } : await coreRequest(config, fetchImpl, '/v1/session', { service_id: resource.id, device_id: fingerprint }); if (!session.h0) throw new Error('PayLock Core session response omitted its internal reference.'); if (!requestRecord) await coreRequest(config, fetchImpl, '/v1/signal', { h0: session.h0, signal_type: 'provider_ack', signal_ref: `yaqeen-resource:${resource.id}` }); const unlock = await coreRequest(config, fetchImpl, '/v1/unlock', { h0: session.h0, device_fingerprint: fingerprint }); const resolved = unlock.h1 ? unlock : await coreRequest(config, fetchImpl, '/v1/resolve', { h0: session.h0 }); if (!resolved.h1) throw new Error('PayLock Core did not produce delivery evidence.'); await putJson(store, key('internal-core-record', ticket.id), { delivery_id: ticket.id, h0Ciphertext: encryptSecret(session.h0, config), h1Ciphertext: encryptSecret(resolved.h1, config), stored_at: new Date().toISOString() }); ticket.status = 'DELIVERED'; ticket.deliveredAt = new Date().toISOString(); await putJson(store, key('ticket', ticketHash), ticket, 86400); if (requestRecord) { requestRecord.status = 'DELIVERED'; requestRecord.deliveredAt = ticket.deliveredAt; requestRecord.deliveryUrl = resource.deliveryUrl; await putJson(store, key('request', requestRecord.id), requestRecord, 86400); } await appendEvent(store, ticket.providerId, { type: 'delivery.completed', delivery_id: ticket.id, request_id: ticket.requestId, resource_id: resource.id, status: 'DELIVERED', notice: SESSION_NOTICE }); const provider = await getJson(store, key('provider', ticket.providerId)); if (provider) await sendWebhook(store, config, fetchImpl, provider, ticket); return response.json({ status: 'delivered', redirect_url: resource.deliveryUrl, notice: SESSION_NOTICE }); } catch (error) { ticket.status = 'FAILED'; ticket.failureCode = error.status ? `CORE_${error.status}` : 'DELIVERY_TRANSITION_FAILED'; await putJson(store, key('ticket', ticketHash), ticket, 86400); if (requestRecord) { requestRecord.status = 'FAILED'; requestRecord.failureCode = ticket.failureCode; await putJson(store, key('request', requestRecord.id), requestRecord, 86400); } await appendEvent(store, ticket.providerId, { type: 'delivery.failed', delivery_id: ticket.id, request_id: ticket.requestId, resource_id: resource.id, status: 'FAILED', failure_code: ticket.failureCode, notice: SESSION_NOTICE }); return response.status(502).json({ error: 'The delivery transition could not be completed. This link remains unavailable to preserve one-time delivery control.' }); } });
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
