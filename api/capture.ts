import { createHash } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "@vercel/kv";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// In-memory rate limiter: 10 requests per IP per hour (anti-flood, not quota)
const ipRequests = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = ipRequests.get(ip);

  if (!entry || now > entry.resetAt) {
    ipRequests.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }

  if (entry.count >= 10) return true;
  entry.count++;
  return false;
}

// Free-tier quota: 1 calculation per rolling 30-day window, keyed by email hash.
// Requires Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN env vars).
// If KV is not configured, logs a warning and allows the request (graceful degradation).
const QUOTA_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days

function emailQuotaKey(email: string): string {
  const hash = createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex")
    .slice(0, 32);
  return `cbam-quota:${hash}`;
}

async function isQuotaExceeded(email: string): Promise<boolean> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.warn("cbam-quota: KV not configured — quota check skipped");
    return false;
  }
  const key = emailQuotaKey(email);
  const existing = await kv.get<number>(key);
  return existing !== null;
}

async function recordQuotaUsage(email: string): Promise<void> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return;
  const key = emailQuotaKey(email);
  await kv.set(key, Date.now(), { ex: QUOTA_WINDOW_SECONDS });
}

const CATEGORY_LABELS: Record<string, string> = {
  steel: "Steel &amp; Iron products",
  cement: "Cement",
  aluminum: "Aluminum",
  fertilizers: "Fertilizers",
  hydrogen: "Hydrogen",
  electricity: "Electricity",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatEuros(val: number): string {
  if (val >= 1_000_000) return `€${(val / 1_000_000).toFixed(2)}M`;
  return `€${Math.round(val).toLocaleString("en-EU")}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS: restrict to app domain; fallback to wildcard only in dev
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://cbamtoolkit.com";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please try again later." });
  }

  const {
    email,
    company,
    category,
    volume,
    country,
    obligation,
    totalEmissions,
    emissionsPerTonne,
    etsPriceUsed,
    carbonPaid,
  } = (req.body as Record<string, unknown>) || {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }

  // Free-tier quota check: 1 calculation per rolling 30-day window per email
  // Only applies when the request includes calculator fields (not plain email signups)
  if (category !== undefined) {
    if (await isQuotaExceeded(email as string)) {
      return res.status(429).json({
        code: "QUOTA_EXCEEDED",
        error:
          "You've used your free calculation this month. Upgrade to Single Importer (€29/month) for unlimited calculations.",
      });
    }
  }

  const fromEmail = "reports@cbamtoolkit.com";
  const categoryLabel = escapeHtml(
    CATEGORY_LABELS[category as string] || (category as string) || "N/A",
  );
  const safeVolume = escapeHtml(String(volume || ""));
  const safeCountry = escapeHtml(String(country || ""));
  const obligationNum = Number(obligation) || 0;
  const emissionsNum = Number(totalEmissions) || 0;
  const emissionsPerTonneNum = Number(emissionsPerTonne) || 0;
  const etsPriceNum = Number(etsPriceUsed) || 0;
  const carbonPaidNum = Number(carbonPaid) || 0;

  // Log the lead (visible in Vercel function logs)
  console.log("CBAM lead captured:", {
    email,
    company: company || "N/A",
    category,
    volume,
    country,
    obligation: obligationNum,
    totalEmissions: emissionsNum,
    ip,
    ts: new Date().toISOString(),
  });

  try {
    // D+0: Confirmation email with calculation summary
    await resend.emails.send({
      from: `CBAM Toolkit <${fromEmail}>`,
      to: email as string,
      subject: "Your CBAM Obligation Report",
      html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your CBAM Obligation Report</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#0a0a0c;color:#fafafa;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">

    <!-- Header -->
    <div style="padding:32px 32px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <p style="margin:0 0 16px;font-size:12px;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;color:#71717a;">CBAM Toolkit</p>
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;">Your CBAM Obligation Report</h1>
      <p style="margin:0;font-size:13px;color:#71717a;">Based on EU Commission Implementing Regulation 2023/1603</p>
    </div>

    <!-- Results -->
    <div style="padding:28px 32px;">
      <p style="margin:0 0 20px;font-size:14px;color:#a1a1aa;line-height:1.7;">
        Here is your estimated CBAM obligation based on the data you entered.
        Use this as a planning baseline — verify with your customs advisor before official submission.
      </p>

      <!-- Obligation highlight -->
      ${
        obligationNum > 0
          ? `<div style="background:rgba(71,159,255,0.08);border:1px solid rgba(71,159,255,0.14);border-radius:8px;padding:20px 24px;margin-bottom:20px;text-align:center;">
            <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#71717a;">Estimated Annual Obligation</p>
            <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:-0.03em;color:#479fff;">${formatEuros(obligationNum)}</p>
          </div>`
          : ""
      }

      <!-- Breakdown table -->
      <div style="background:#1a1a1e;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:20px 24px;margin-bottom:20px;">
        <p style="margin:0 0 16px;font-size:12px;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;color:#71717a;">Calculation Details</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${category ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Product category</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">${categoryLabel}</td></tr>` : ""}
          ${safeVolume ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Annual import volume</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">${safeVolume} tonnes</td></tr>` : ""}
          ${safeCountry ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Country of origin</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">${safeCountry}</td></tr>` : ""}
          ${emissionsPerTonneNum > 0 ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Embedded emissions (default factor)</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">${emissionsPerTonneNum.toFixed(2)} tCO₂/t</td></tr>` : ""}
          ${emissionsNum > 0 ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Total embedded emissions</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">${emissionsNum.toLocaleString("en-EU", { maximumFractionDigits: 1 })} tCO₂</td></tr>` : ""}
          ${etsPriceNum > 0 ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">EU ETS carbon price used</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">€${etsPriceNum.toFixed(2)}/tCO₂</td></tr>` : ""}
          ${carbonPaidNum > 0 ? `<tr><td style="padding:8px 0;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06);">Carbon price paid in origin country</td><td style="padding:8px 0;text-align:right;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.06);">€${carbonPaidNum.toFixed(2)}/tCO₂</td></tr>` : ""}
          ${obligationNum > 0 ? `<tr><td style="padding:8px 0;color:#71717a;">Estimated CBAM obligation</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#479fff;">${formatEuros(obligationNum)}</td></tr>` : ""}
        </table>
      </div>

      <!-- Next steps -->
      <div style="background:#1a1a1e;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;">What to do next</p>
        <ol style="margin:0;padding-left:20px;color:#a1a1aa;font-size:14px;line-height:1.8;">
          <li>Register as Authorized CBAM Declarant with your national customs authority</li>
          <li>Collect verified emission data from your non-EU suppliers</li>
          <li>File your annual CBAM declaration by September 30, 2027</li>
        </ol>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="https://cbamtoolkit.com/#pricing" style="display:inline-block;padding:14px 28px;background:#479fff;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;letter-spacing:0.01em;">
          Upgrade to generate your declaration →
        </a>
      </div>
    </div>

    <!-- Disclaimer -->
    <div style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.06);">
      <p style="margin:0;font-size:11px;color:#52525b;line-height:1.7;">
        <strong style="color:#71717a;">Disclaimer:</strong> This is an automated estimate for planning purposes only.
        Actual CBAM obligations depend on verified emission data from your suppliers and official EU Commission
        calculation methodology. Verify with your customs advisor before submitting official CBAM declarations.
        CBAM Toolkit is not affiliated with the European Commission or any national customs authority.
      </p>
    </div>
  </div>
</body>
</html>`,
    });

    // D+3 follow-up: scheduled via external cron (not implemented in serverless function)
    // TODO: Trigger a D+3 follow-up job via Resend Broadcasts or a cron endpoint

    // Record quota usage AFTER successful email send (calculator requests only)
    if (category !== undefined) {
      await recordQuotaUsage(email as string);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Resend email failed:", err);
    return res
      .status(500)
      .json({ error: "Failed to send email. Please try again." });
  }
}
