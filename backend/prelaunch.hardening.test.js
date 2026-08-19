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
