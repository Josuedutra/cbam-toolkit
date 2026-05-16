import crypto from 'crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseStripeSignature, verifyStripeSignature } from './webhook';

const SECRET = 'whsec_test_secret_1234567890abcdef';
const BODY = '{"type":"checkout.session.completed","data":{"object":{}}}';

function buildSignatureHeader(timestamp: number, body: string, secret: string): string {
  const signedPayload = `${timestamp}.${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

describe('parseStripeSignature', () => {
  it('extracts timestamp and v1 signature correctly', () => {
    const { timestamp, signatures } = parseStripeSignature('t=1234567890,v1=abc123');
    expect(timestamp).toBe('1234567890');
    expect(signatures).toEqual(['abc123']);
  });

  it('handles multiple v1 signatures', () => {
    const { signatures } = parseStripeSignature('t=1234567890,v1=aaa,v1=bbb');
    expect(signatures).toEqual(['aaa', 'bbb']);
  });

  it('returns empty values for malformed header', () => {
    const { timestamp, signatures } = parseStripeSignature('garbage');
    expect(timestamp).toBe('');
    expect(signatures).toHaveLength(0);
  });
});

describe('verifyStripeSignature', () => {
  const NOW_S = 1_700_000_000;
  const NOW_MS = NOW_S * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns valid=true for a correct signature', () => {
    const header = buildSignatureHeader(NOW_S, BODY, SECRET);
    const result = verifyStripeSignature(BODY, header, SECRET);
    expect(result.valid).toBe(true);
  });

  it('returns valid=false for wrong HMAC', () => {
    const header = `t=${NOW_S},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    const result = verifyStripeSignature(BODY, header, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature mismatch');
  });

  it('returns valid=false for wrong secret', () => {
    const header = buildSignatureHeader(NOW_S, BODY, 'wrong_secret');
    const result = verifyStripeSignature(BODY, header, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature mismatch');
  });

  it('returns valid=false for expired timestamp (>5min old)', () => {
    const oldTimestamp = NOW_S - 301; // 5min 1s ago
    const header = buildSignatureHeader(oldTimestamp, BODY, SECRET);
    const result = verifyStripeSignature(BODY, header, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Timestamp');
  });

  it('accepts timestamp within 5min tolerance', () => {
    const recentTimestamp = NOW_S - 299; // 4min 59s ago — within tolerance
    const header = buildSignatureHeader(recentTimestamp, BODY, SECRET);
    const result = verifyStripeSignature(BODY, header, SECRET);
    expect(result.valid).toBe(true);
  });

  it('returns valid=false for malformed header (no t= or v1=)', () => {
    const result = verifyStripeSignature(BODY, 'garbage', SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Malformed signature header');
  });
});
