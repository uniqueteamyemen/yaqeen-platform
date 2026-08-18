const assert = require('assert');
const test = require('node:test');
const {
  validateRuntimeConfig,
  MemoryStore,
  safeEqual,
  sha256,
  encryptSecret,
  decryptSecret,
  WEBHOOK_DISCLOSURE,
  SESSION_NOTICE,
} = require('./server');

test('production configuration rejects missing Redis and a public Core boundary', () => {
  assert.throws(() => validateRuntimeConfig({
    NODE_ENV: 'production', PAYLOCK_CORE_API_KEY: 'a'.repeat(32), YAQEEN_OPERATOR_SECRET: 'b'.repeat(32), YAQEEN_SESSION_SECRET: 'c'.repeat(32), YAQEEN_RECORD_ENCRYPTION_KEY: 'd'.repeat(32), YAQEEN_INTERNAL_API_KEY: 'e'.repeat(32), PAYLOCK_PRIVATE_NETWORK: 'false', PAYLOCK_URL: 'https://yaqeen-platform-production.up.railway.app', YAQEEN_PUBLIC_ORIGIN: 'https://provider.example',
  }), /REDIS_URL is required.*private Yaqeen-to-Core boundary.*private service network/i);
});

test('opaque tickets are 256-bit input values represented only by a SHA-256 hash in state', async () => {
  const ticket = require('crypto').randomBytes(32).toString('hex');
  assert.strictEqual(ticket.length, 64);
  const hash = sha256(ticket);
  assert.strictEqual(hash.length, 64);
  assert.notStrictEqual(hash, ticket);
  const store = new MemoryStore();
  await store.set(`ticket:${hash}`, JSON.stringify({ ticket_hash: hash, status: 'ISSUED' }), 'EX', 60);
  const record = JSON.parse(await store.get(`ticket:${hash}`));
  assert.strictEqual(record.ticket_hash, hash);
  assert.strictEqual(JSON.stringify(record).includes(ticket), false);
});

test('operator-secret comparison is constant-time safe for matching and nonmatching values', () => {
  assert.strictEqual(safeEqual('operator-secret', 'operator-secret'), true);
  assert.strictEqual(safeEqual('operator-secret', 'other-secret'), false);
  assert.strictEqual(safeEqual('operator-secret', 'short'), false);
});

test('provider webhook secrets are encrypted at rest and disclose non-financial scope', () => {
  const config = { recordEncryptionKey: 'q'.repeat(48) };
  const secret = 'provider-webhook-secret-which-is-long-enough';
  const encrypted = encryptSecret(secret, config);
  assert.strictEqual(encrypted.includes(secret), false);
  assert.strictEqual(decryptSecret(encrypted, config), secret);
  assert.match(WEBHOOK_DISCLOSURE, /do not create.*financial responsibility/i);
  assert.match(SESSION_NOTICE, /constrained delivery session/i);
});
