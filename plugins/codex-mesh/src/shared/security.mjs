import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function verifySecret(secret, expectedHash) {
  if (typeof secret !== 'string' || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(prefix = 'cmesh', bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function bearerToken(headers) {
  const value = headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}
