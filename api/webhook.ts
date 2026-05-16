import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Parse the Stripe-Signature header.
 * Format: t=TIMESTAMP,v1=HMAC[,v1=HMAC2,...]
 */
export function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(',');

  let timestamp = '';
  const signatures: string[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

/**
 * Verify a Stripe webhook signature.
 * Returns true if at least one v1 signature matches and timestamp is within tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceMs = FIVE_MINUTES_MS,
): { valid: boolean; reason?: string } {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);

  if (!timestamp || signatures.length === 0) {
    return { valid: false, reason: 'Malformed signature header' };
  }

  const timestampMs = Number(timestamp) * 1000;
  if (isNaN(timestampMs)) {
    return { valid: false, reason: 'Invalid timestamp' };
  }

  if (Math.abs(Date.now() - timestampMs) > toleranceMs) {
    return { valid: false, reason: 'Timestamp too old or too far in the future' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const matched = signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'));
    } catch {
      return false;
    }
  });

  if (!matched) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

/**
 * Stripe webhook endpoint.
 * Verifies signature using STRIPE_WEBHOOK_SECRET and logs the event.
 * Extend this to handle checkout.session.completed for post-purchase flows.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    try {
      const rawBody =
        typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

      const result = verifyStripeSignature(rawBody, signature, webhookSecret);

      if (!result.valid) {
        console.error('Stripe webhook signature failed:', result.reason);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return res.status(400).json({ error: 'Signature verification failed' });
    }
  }

  const event = req.body as { type?: string; data?: { object?: Record<string, unknown> } };
  console.log('Stripe webhook received:', event.type, new Date().toISOString());

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data?.object;
      console.log('New subscription:', {
        customer_email: session?.customer_email,
        amount_total: session?.amount_total,
        subscription: session?.subscription,
      });
      // TODO: Send welcome email, provision access, etc.
      break;
    }
    default:
      console.log('Unhandled event type:', event.type);
  }

  return res.status(200).json({ received: true });
}
