const assert = require('assert');
const test = require('node:test');
const { createApp, MemoryStore } = require('./server');

const baseEnv = {
  NODE_ENV: 'development',
  REDIS_URL: 'memory://hardening',
  PAYLOCK_URL: 'http://paylock-core.railway.internal',
  API_KEY: 'hardening-internal-key',
  PAYLOCK_PRIVATE_NETWORK: 'true',
  YAQEEN_TEST_MEMORY_STORE: 'true',
  YAQEEN_OPERATOR_SECRET: 'hardening-operator-secret-that-is-long-enough',
  YAQEEN_SESSION_SECRET: 'hardening-session-secret-that-is-long-enough',
  YAQEEN_RECORD_ENCRYPTION_KEY: 'hardening-record-key-that-is-long-enough',
  YAQEEN_PUBLIC_ORIGIN: 'http://yaqeen.test',
};

async function startApp(fetchImpl) {
  const app = createApp({ env: baseEnv, store: new MemoryStore(), fetchImpl });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

async function providerSession(baseUrl) {
  const { response } = await json(`${baseUrl}/provider/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'hardening-provider' },
    body: JSON.stringify({ operator_secret: baseEnv.YAQEEN_OPERATOR_SECRET, provider_id: 'hardening-provider' }),
  });
  assert.strictEqual(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function createTicket(baseUrl, cookie) {
  const resource = await json(`${baseUrl}/provider/resources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'user-agent': 'hardening-provider' },
    body: JSON.stringify({ title: 'Hardening resource', delivery_url: 'https://delivery.example/resource' }),
  });
  assert.strictEqual(resource.response.status, 201);
  const ticket = await json(`${baseUrl}/provider/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'user-agent': 'hardening-provider' },
    body: JSON.stringify({ resource_id: resource.body.resource.id }),
  });
  assert.strictEqual(ticket.response.status, 201);
  return new URL(ticket.body.delivery_url).pathname.split('/').pop();
}

function successfulCore(url) {
  if (url.endsWith('/v1/session')) return new Response(JSON.stringify({ h0: 'internal-h0-only' }), { status: 200 });
  if (url.endsWith('/v1/signal')) return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
  if (url.endsWith('/v1/unlock')) return new Response(JSON.stringify({ h1: 'internal-h1-only' }), { status: 200 });
  throw new Error(`Unexpected Core route: ${url}`);
}

test('exactly one concurrent redemption wins and no internal evidence identifier reaches the user', async () => {
  const runtime = await startApp(async (url) => successfulCore(url));
  try {
    const cookie = await providerSession(runtime.baseUrl);
    const ticket = await createTicket(runtime.baseUrl, cookie);
    const results = await Promise.all(Array.from({ length: 8 }, () => json(`${runtime.baseUrl}/deliver/${ticket}/open`, {
      method: 'POST', headers: { 'user-agent': 'hardening-user', 'accept-language': 'en-US' },
    })));
    assert.strictEqual(results.filter(({ response }) => response.status === 200).length, 1);
    assert.ok(results.every(({ response }) => [200, 404, 409].includes(response.status)));
    for (const { body } of results) assert.strictEqual(JSON.stringify(body).toLowerCase().includes('h0'), false);
  } finally {
    await runtime.close();
  }
});

test('a Core failure permanently preserves delivery failure without exposing an internal reference', async () => {
  const runtime = await startApp(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
  try {
    const cookie = await providerSession(runtime.baseUrl);
    const ticket = await createTicket(runtime.baseUrl, cookie);
    const outcome = await json(`${runtime.baseUrl}/deliver/${ticket}/open`, { method: 'POST', headers: { 'user-agent': 'failure-user' } });
    assert.strictEqual(outcome.response.status, 502);
    assert.strictEqual(JSON.stringify(outcome.body).toLowerCase().includes('h0'), false);
    const events = await json(`${runtime.baseUrl}/provider/events`, { headers: { cookie, 'user-agent': 'hardening-provider' } });
    assert.strictEqual(events.response.status, 200);
    assert.strictEqual(events.body.events[0].type, 'delivery.failed');
    assert.strictEqual(events.body.events[0].failure_code, 'CORE_503');
    assert.strictEqual(JSON.stringify(events.body).toLowerCase().includes('h0'), false);
  } finally {
    await runtime.close();
  }
});

test('optional Webhook retries retain the disclosure and reuse one event identity without blocking delivery', async () => {
  const webhookAttempts = [];
  const runtime = await startApp(async (url, options = {}) => {
    if (url === 'https://provider.example/webhook') {
      webhookAttempts.push(options);
      return new Response('unavailable', { status: 503 });
    }
    return successfulCore(url);
  });
  try {
    const cookie = await providerSession(runtime.baseUrl);
    const webhook = await json(`${runtime.baseUrl}/provider/webhook`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, 'user-agent': 'hardening-provider' },
      body: JSON.stringify({ enabled: true, endpoint: 'https://provider.example/webhook', secret: 'webhook-secret-that-is-deliberately-long-enough' }),
    });
    assert.strictEqual(webhook.response.status, 200);
    assert.match(webhook.response.headers.get('x-yaqeen-webhook-disclosure'), /financial responsibility/i);
    const ticket = await createTicket(runtime.baseUrl, cookie);
    const outcome = await json(`${runtime.baseUrl}/deliver/${ticket}/open`, { method: 'POST', headers: { 'user-agent': 'webhook-user' } });
    assert.strictEqual(outcome.response.status, 200);
    assert.strictEqual(webhookAttempts.length, 3);
    assert.ok(webhookAttempts.every((attempt) => attempt.headers['x-yaqeen-webhook-disclosure'].includes('financial responsibility')));
    const eventIds = webhookAttempts.map((attempt) => attempt.headers['x-yaqeen-event-id']);
    assert.strictEqual(new Set(eventIds).size, 1);
    const events = await json(`${runtime.baseUrl}/provider/events`, { headers: { cookie, 'user-agent': 'hardening-provider' } });
    const deliveries = events.body.events.filter((event) => event.type === 'webhook.delivery');
    assert.strictEqual(deliveries.length, 3);
    assert.deepStrictEqual(deliveries.map((event) => event.attempt).sort(), [1, 2, 3]);
    assert.ok(deliveries.every((event) => event.status === 'FAILED'));
  } finally {
    await runtime.close();
  }
});

test('delivery rate limiting rejects the thirteenth request in one window', async () => {
  const runtime = await startApp(async (url) => successfulCore(url));
  try {
    const responses = await Promise.all(Array.from({ length: 13 }, () => fetch(`${runtime.baseUrl}/deliver/not-a-ticket`, { headers: { 'user-agent': 'rate-test-user' } })));
    assert.strictEqual(responses.filter((response) => response.status === 429).length, 1);
    assert.strictEqual(responses.filter((response) => response.status === 404).length, 12);
  } finally {
    await runtime.close();
  }
});


test('requester starts H0 before provider acceptance and internal evidence remains encrypted', async () => {
  const calls = [];
  const runtime = await startApp(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return successfulCore(url);
  });
  try {
    const origin = new URL(runtime.baseUrl).origin;
    const started = await json(`${runtime.baseUrl}/request/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ provider_id: 'hardening-provider', service_id: 'requester-first-service', service_name: 'Requester-first service', device_id: 'requester-device' }),
    });
    assert.strictEqual(started.response.status, 201);
    assert.match(started.body.request_token, /^[a-f0-9]{64}$/);
    const requestRecord = await runtime.app.locals.yaqeen.store.get(`yaqeen:request:${started.body.request_id}`);
    assert.ok(requestRecord.includes('h0Ciphertext'));
    assert.strictEqual(requestRecord.includes('internal-h0-only'), false);
    assert.deepStrictEqual(calls.map(call => new URL(call.url).pathname), ['/v1/session']);

    const cookie = await providerSession(runtime.baseUrl);
    const resource = await json(`${runtime.baseUrl}/provider/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ title: 'Requester-first resource', delivery_url: 'https://delivery.example/requester-first' }),
    });
    assert.strictEqual(resource.response.status, 201);
    const accepted = await json(`${runtime.baseUrl}/provider/requests/${started.body.request_id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ provider_ref: 'provider-resource-ready-1' }),
    });
    assert.strictEqual(accepted.response.status, 200);
    const ticket = await json(`${runtime.baseUrl}/provider/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ request_id: started.body.request_id, resource_id: resource.body.resource.id }),
    });
    assert.strictEqual(ticket.response.status, 201);
    const rawTicket = new URL(ticket.body.delivery_url).pathname.split('/').pop();
    const redeemed = await json(`${runtime.baseUrl}/deliver/${rawTicket}/open`, { method: 'POST', headers: { 'user-agent': 'hardening-requester' } });
    assert.strictEqual(redeemed.response.status, 200);
    assert.deepStrictEqual(calls.map(call => new URL(call.url).pathname), ['/v1/session', '/v1/signal', '/v1/unlock']);
    const coreRecord = await runtime.app.locals.yaqeen.store.get(`yaqeen:internal-core-record:${JSON.parse(await runtime.app.locals.yaqeen.store.get(`yaqeen:ticket:${require('./server').sha256(rawTicket)}`)).id}`);
    assert.ok(coreRecord.includes('h0Ciphertext'));
    assert.ok(coreRecord.includes('h1Ciphertext'));
    assert.strictEqual(coreRecord.includes('internal-h0-only'), false);
    assert.strictEqual(coreRecord.includes('internal-h1-only'), false);
    const status = await json(`${runtime.baseUrl}/request/status/${started.body.request_id}`, { headers: { 'x-request-token': started.body.request_token } });
    assert.strictEqual(status.response.status, 200);
    assert.strictEqual(status.body.status, 'DELIVERED');
  } finally {
    await runtime.close();
  }
});

test('state-changing browser routes reject cross-origin requests and private delivery targets', async () => {
  const runtime = await startApp(async (url) => successfulCore(url));
  try {
    const crossOriginLogin = await json(`${runtime.baseUrl}/provider/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ operator_secret: baseEnv.YAQEEN_OPERATOR_SECRET, provider_id: 'hardening-provider' }),
    });
    assert.strictEqual(crossOriginLogin.response.status, 403);
    const cookie = await providerSession(runtime.baseUrl);
    const origin = new URL(runtime.baseUrl).origin;
    const privateResource = await json(`${runtime.baseUrl}/provider/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ title: 'Private target', delivery_url: 'http://127.0.0.1:8080/admin' }),
    });
    assert.strictEqual(privateResource.response.status, 400);
    const crossOriginResource = await json(`${runtime.baseUrl}/provider/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://attacker.example' },
      body: JSON.stringify({ title: 'Cross-origin', delivery_url: 'https://delivery.example/resource' }),
    });
    assert.strictEqual(crossOriginResource.response.status, 403);
    const privateWebhook = await json(`${runtime.baseUrl}/provider/webhook`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ enabled: true, endpoint: 'https://127.0.0.1/webhook', secret: 'webhook-secret-that-is-deliberately-long-enough' }),
    });
    assert.strictEqual(privateWebhook.response.status, 400);
    const crossOriginRequest = await json(`${runtime.baseUrl}/request/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ provider_id: 'hardening-provider', service_id: 'csrf-service', device_id: 'csrf-device' }),
    });
    assert.strictEqual(crossOriginRequest.response.status, 403);
  } finally {
    await runtime.close();
  }
});


test('request status requires the private requester token', async () => {
  const runtime = await startApp(async (url) => successfulCore(url));
  try {
    const origin = new URL(runtime.baseUrl).origin;
    const started = await json(`${runtime.baseUrl}/request/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ provider_id: 'hardening-provider', service_id: 'token-service', device_id: 'token-device' }),
    });
    assert.strictEqual(started.response.status, 201);
    const wrong = await json(`${runtime.baseUrl}/request/status/${started.body.request_id}`, { headers: { 'x-request-token': 'wrong-token' } });
    assert.strictEqual(wrong.response.status, 404);
    const correct = await json(`${runtime.baseUrl}/request/status/${started.body.request_id}`, { headers: { 'x-request-token': started.body.request_token } });
    assert.strictEqual(correct.response.status, 200);
  } finally {
    await runtime.close();
  }
});


test('requester, provider, and delivery interfaces are reachable and do not expose Core credentials', async () => {
  const runtime = await startApp(async (url) => successfulCore(url));
  try {
    const root = await fetch(runtime.baseUrl, { redirect: 'manual' });
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.headers.get('location'), '/request');
    const requester = await fetch(`${runtime.baseUrl}/request`);
    const requesterHtml = await requester.text();
    assert.strictEqual(requester.status, 200);
    assert.match(requesterHtml, /Start with a/);
    assert.match(requesterHtml, /Check request status/);
    assert.strictEqual(requesterHtml.includes('hardening-internal-key'), false);
    const cookie = await providerSession(runtime.baseUrl);
    const provider = await fetch(`${runtime.baseUrl}/provider`, { headers: { cookie } });
    const providerHtml = await provider.text();
    assert.strictEqual(provider.status, 200);
    assert.match(providerHtml, /Review a protected request/);
    assert.match(providerHtml, /Accept protected request/);
    assert.strictEqual(providerHtml.includes('hardening-internal-key'), false);
    const resource = await json(`${runtime.baseUrl}/provider/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Interface resource', delivery_url: 'https://delivery.example/interface' }),
    });
    const ticket = await json(`${runtime.baseUrl}/provider/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ resource_id: resource.body.resource.id }),
    });
    const rawTicket = new URL(ticket.body.delivery_url).pathname.split('/').pop();
    const delivery = await fetch(`${runtime.baseUrl}/deliver/${rawTicket}`);
    const deliveryHtml = await delivery.text();
    assert.strictEqual(delivery.status, 200);
    assert.match(deliveryHtml, /Open assigned resource/);
    assert.strictEqual(deliveryHtml.includes('hardening-internal-key'), false);
  } finally {
    await runtime.close();
  }
});
