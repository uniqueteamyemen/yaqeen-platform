#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const repoDir = path.resolve(__dirname, '..');
const backendDir = path.join(repoDir, 'backend');
const coreDir = process.env.PAYLOCK_CORE_DIR || path.resolve(repoDir, '..', 'paylock-core');
const releaseApiKey = 'yaqeen-release-test-key';
const platformSecret = 'yaqeen-release-test-platform-secret';
const processes = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

function startNodeProcess(label, cwd, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += `[${label}] ${chunk}`; });
  child.stderr.on('data', chunk => { output += `[${label}] ${chunk}`; });
  processes.push(child);
  return { child, output: () => output };
}

async function waitFor(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`);
}

async function request(url, method, body, { apiKey = releaseApiKey, includeApiKey = true } = {}) {
  const headers = {
    'content-type': 'application/json'
  };
  if (includeApiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { response, data };
}

async function coreRequest(coreBaseUrl, method, pathName, body) {
  const response = await fetch(`${coreBaseUrl}${pathName}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': releaseApiKey
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { response, data };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function expectProductionKeyRejection(apiKey) {
  const port = await freePort();
  const attempt = startNodeProcess(
    'production-key-guard',
    backendDir,
    'server.js',
    {
      NODE_ENV: 'production',
      ...(apiKey === undefined ? {} : { API_KEY: apiKey }),
      PAYLOCK_URL: 'http://127.0.0.1:1',
      PORT: String(port)
    }
  );
  const [exitCode] = await once(attempt.child, 'exit');
  assert.equal(exitCode, 1, `Yaqeen must reject ${apiKey === undefined ? 'a missing API key' : 'test-key'} in production.`);
  assert.match(attempt.output(), /must be explicitly configured and must not equal "test-key"/);
}

async function stopAll() {
  await Promise.all(processes.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }));
}

async function run() {
  assert.ok(fs.existsSync(path.join(coreDir, 'platform.js')), `PayLock Core was not found at ${coreDir}. Set PAYLOCK_CORE_DIR to a valid checkout.`);

  await expectProductionKeyRejection(undefined);
  await expectProductionKeyRejection('test-key');

  const corePort = await freePort();
  const yaqeenPort = await freePort();
  const core = startNodeProcess('paylock-core', coreDir, 'platform.js', {
    NODE_ENV: 'test',
    PLATFORM_SECRET: platformSecret,
    API_KEY: releaseApiKey,
    PORT: String(corePort),
    REDIS_URL: ''
  });
  await waitFor(`http://127.0.0.1:${corePort}/v1/health`);

  const yaqeen = startNodeProcess('yaqeen', backendDir, 'server.js', {
    NODE_ENV: 'production',
    API_KEY: releaseApiKey,
    PAYLOCK_URL: `http://127.0.0.1:${corePort}`,
    PORT: String(yaqeenPort),
    REDIS_URL: ''
  });
  await waitFor(`http://127.0.0.1:${yaqeenPort}/api/health`, { 'x-api-key': releaseApiKey });

  const baseUrl = `http://127.0.0.1:${yaqeenPort}/api`;
  const unique = Date.now().toString(36);

  // The Yaqeen credential is a server-bound API credential. A browser-facing
  // or otherwise unauthenticated request cannot invoke the platform API.
  const noKey = await request(`${baseUrl}/health`, 'GET', undefined, { includeApiKey: false });
  assert.equal(noKey.response.status, 401, JSON.stringify(noKey.data));
  assert.equal(noKey.data.error, 'Unauthorized');
  const wrongKey = await request(`${baseUrl}/health`, 'GET', undefined, { apiKey: 'not-the-yaqeen-server-key' });
  assert.equal(wrongKey.response.status, 401, JSON.stringify(wrongKey.data));
  assert.equal(wrongKey.data.error, 'Unauthorized');
  assert.equal(noKey.response.headers.get('x-powered-by'), null, 'Yaqeen must not disclose the Express server header.');

  const session = await request(`${baseUrl}/session`, 'POST', {
    service_id: `release-service-${unique}`,
    provider_id: 'release-provider',
    device_id: `release-device-${unique}`
  });
  assert.equal(session.response.status, 200, JSON.stringify(session.data));
  assert.equal(session.data.status, 'INITIATED');
  assert.match(session.data.h0, /^[a-f0-9]{64}$/);
  const { h0 } = session.data;

  const acknowledgement = await request(`${baseUrl}/signal`, 'POST', {
    h0,
    signal_type: 'provider_ack',
    signal_ref: `release-resource-${unique}`
  });
  assert.equal(acknowledgement.response.status, 200, JSON.stringify(acknowledgement.data));
  assert.equal(acknowledgement.data.signal_recorded, true);

  const unlock = await request(`${baseUrl}/unlock`, 'POST', {
    h0,
    device_fingerprint: `fingerprint-${unique}`
  });
  assert.equal(unlock.response.status, 200, JSON.stringify(unlock.data));
  assert.equal(unlock.data.status, 'EXECUTION_PROVEN');
  assert.match(unlock.data.h1, /^[a-f0-9]{64}$/);

  const verification = await request(`${baseUrl}/verify`, 'POST', { h0, h1: unlock.data.h1 });
  assert.equal(verification.response.status, 200, JSON.stringify(verification.data));
  assert.equal(verification.data.valid, true);

  const replay = await request(`${baseUrl}/unlock`, 'POST', {
    h0,
    device_fingerprint: `fingerprint-${unique}`
  });
  assert.equal(replay.response.status, 409, JSON.stringify(replay.data));
  assert.match(replay.data.error, /user_unlock already recorded/);

  // A client may arrive before the provider response. No H1 may be issued until
  // the delayed provider acknowledgement is recorded, after which resolve
  // converges on exactly one H1 without a second user-unlock request.
  const delayedSession = await request(`${baseUrl}/session`, 'POST', {
    service_id: `delayed-provider-service-${unique}`,
    provider_id: 'delayed-provider',
    device_id: `delayed-device-${unique}`
  });
  assert.equal(delayedSession.response.status, 200, JSON.stringify(delayedSession.data));
  const delayedUnlock = await request(`${baseUrl}/unlock`, 'POST', {
    h0: delayedSession.data.h0,
    device_fingerprint: `delayed-fingerprint-${unique}`
  });
  assert.equal(delayedUnlock.response.status, 400, JSON.stringify(delayedUnlock.data));
  assert.equal(delayedUnlock.data.error, 'Missing required signals');
  assert.equal(delayedUnlock.data.missing.provider_ack, true);
  assert.equal(delayedUnlock.data.missing.user_unlock, false);
  await wait(150);
  const delayedAck = await request(`${baseUrl}/signal`, 'POST', {
    h0: delayedSession.data.h0,
    signal_type: 'provider_ack',
    signal_ref: `late-resource-${unique}`
  });
  assert.equal(delayedAck.response.status, 200, JSON.stringify(delayedAck.data));
  const delayedResolve = await request(`${baseUrl}/resolve`, 'POST', { h0: delayedSession.data.h0 });
  assert.equal(delayedResolve.response.status, 200, JSON.stringify(delayedResolve.data));
  assert.match(delayedResolve.data.h1, /^[a-f0-9]{64}$/);
  const delayedUnlockReplay = await request(`${baseUrl}/unlock`, 'POST', {
    h0: delayedSession.data.h0,
    device_fingerprint: `delayed-fingerprint-${unique}`
  });
  assert.equal(delayedUnlockReplay.response.status, 409, JSON.stringify(delayedUnlockReplay.data));
  assert.match(delayedUnlockReplay.data.error, /user_unlock already recorded/);
  const delayedRetryResolve = await request(`${baseUrl}/resolve`, 'POST', { h0: delayedSession.data.h0 });
  assert.equal(delayedRetryResolve.response.status, 200, JSON.stringify(delayedRetryResolve.data));
  assert.equal(delayedRetryResolve.data.h1, delayedResolve.data.h1);

  // A provider-side cancellation closes the session. Neither a later client
  // unlock nor resolution may turn the cancelled session into an H1.
  const cancelledReceipt = `cancel-receipt-${unique}`;
  const cancelledSession = await request(`${baseUrl}/session`, 'POST', {
    service_id: `cancelled-provider-service-${unique}`,
    provider_id: 'cancelled-provider',
    device_id: `cancelled-device-${unique}`,
    receipt_id: cancelledReceipt
  });
  assert.equal(cancelledSession.response.status, 200, JSON.stringify(cancelledSession.data));
  const cancelledAck = await request(`${baseUrl}/signal`, 'POST', {
    h0: cancelledSession.data.h0,
    signal_type: 'provider_ack',
    signal_ref: `cancelled-resource-${unique}`
  });
  assert.equal(cancelledAck.response.status, 200, JSON.stringify(cancelledAck.data));
  const cancellation = await coreRequest(
    `http://127.0.0.1:${corePort}`,
    'POST',
    '/v1/webhook/cancel',
    { h0: cancelledSession.data.h0, receipt_id: cancelledReceipt, reason: 'provider_aborted' }
  );
  assert.equal(cancellation.response.status, 200, JSON.stringify(cancellation.data));
  assert.equal(cancellation.data.status, 'CANCELLED');
  const cancelledUnlock = await request(`${baseUrl}/unlock`, 'POST', {
    h0: cancelledSession.data.h0,
    device_fingerprint: `cancelled-fingerprint-${unique}`
  });
  assert.equal(cancelledUnlock.response.status, 409, JSON.stringify(cancelledUnlock.data));

  // A connection aborted before dispatch must not create user_unlock or H1. A
  // later clean retry is the single effective unlock and proof-creation path.
  const interruptedSession = await request(`${baseUrl}/session`, 'POST', {
    service_id: `interrupted-client-service-${unique}`,
    provider_id: 'interrupted-client-provider',
    device_id: `interrupted-device-${unique}`
  });
  assert.equal(interruptedSession.response.status, 200, JSON.stringify(interruptedSession.data));
  const interruptedAck = await request(`${baseUrl}/signal`, 'POST', {
    h0: interruptedSession.data.h0,
    signal_type: 'provider_ack',
    signal_ref: `interrupted-resource-${unique}`
  });
  assert.equal(interruptedAck.response.status, 200, JSON.stringify(interruptedAck.data));
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    fetch(`${baseUrl}/unlock`, {
      method: 'POST',
      signal: abortController.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': releaseApiKey },
      body: JSON.stringify({ h0: interruptedSession.data.h0, device_fingerprint: `interrupted-fingerprint-${unique}` })
    }),
    error => error?.name === 'AbortError'
  );
  const interruptedResolve = await request(`${baseUrl}/resolve`, 'POST', { h0: interruptedSession.data.h0 });
  assert.equal(interruptedResolve.response.status, 400, JSON.stringify(interruptedResolve.data));
  assert.equal(interruptedResolve.data.error, 'Missing required signals');
  assert.equal(interruptedResolve.data.missing.user_unlock, true);
  const interruptedRetry = await request(`${baseUrl}/unlock`, 'POST', {
    h0: interruptedSession.data.h0,
    device_fingerprint: `interrupted-fingerprint-${unique}`
  });
  assert.equal(interruptedRetry.response.status, 200, JSON.stringify(interruptedRetry.data));
  assert.match(interruptedRetry.data.h1, /^[a-f0-9]{64}$/);

  console.log(JSON.stringify({
    result: 'PASS',
    claim: 'local PayLock–Yaqeen release sequence',
    steps: [
      'H0 session', 'provider_ack', 'user_unlock', 'single H1', 'verify', 'replay rejection',
      'delayed provider acknowledgement', 'cancelled provider path', 'client abort before dispatch and clean retry',
      'missing and incorrect Yaqeen server-key rejection'
    ],
    h0_redacted: `${h0.slice(0, 8)}…`,
    h1_redacted: `${unlock.data.h1.slice(0, 8)}…`
  }));
  void core;
  void yaqeen;
}

run()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(stopAll);
