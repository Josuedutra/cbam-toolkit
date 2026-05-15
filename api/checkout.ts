import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Redirects to the Stripe Payment Link configured in STRIPE_PAYMENT_LINK env var.
 * This keeps the payment link configurable without redeploying the static HTML.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const stripeLink = process.env.STRIPE_PAYMENT_LINK;

  if (!stripeLink || stripeLink === 'https://buy.stripe.com/xxxx') {
    // Payment link not configured yet — redirect back to pricing section
    res.setHeader('Location', '/#pricing');
    return res.status(302).end();
  }

  res.setHeader('Location', stripeLink);
  return res.status(302).end();
}
