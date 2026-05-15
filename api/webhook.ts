import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

/**
 * Stripe webhook endpoint.
 * Verifies signature using STRIPE_WEBHOOK_SECRET and logs the event.
 * Extend this to handle checkout.session.completed for post-purchase flows.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Signature verification (requires raw body — Vercel provides Buffer)
  if (webhookSecret && signature) {
    try {
      const rawBody =
        typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);

      const [, timestampPart] = signature.split(',');
      const timestamp = timestampPart?.split('=')[1];
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      const receivedSig = signature.split('v1=')[1]?.split(',')[0];
      if (expectedSig !== receivedSig) {
        console.error('Stripe webhook signature mismatch');
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
