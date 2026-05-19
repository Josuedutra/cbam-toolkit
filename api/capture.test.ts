import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures mockSend is available in the vi.mock factory (which is hoisted to the top)
const { mockSend, mockKvGet, mockKvSet } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue({ id: "email-id-123" }),
  mockKvGet: vi.fn().mockResolvedValue(null),
  mockKvSet: vi.fn().mockResolvedValue("OK"),
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

vi.mock("@vercel/kv", () => ({
  kv: { get: mockKvGet, set: mockKvSet },
}));

import handler from "./capture";

function makeReqRes(body: Record<string, unknown>, ip = "127.0.0.1") {
  const req = {
    method: "POST",
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: ip },
    body,
  } as any;

  let statusCode = 200;
  let responseBody: unknown = null;
  const res = {
    setHeader: vi.fn(),
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: unknown) => {
      responseBody = data;
      return res;
    },
    end: vi.fn(),
    _getStatus: () => statusCode,
    _getBody: () => responseBody,
  } as any;

  return { req, res };
}

describe("capture handler — data pipeline", () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockKvGet.mockClear();
    mockKvSet.mockClear();
    mockKvGet.mockResolvedValue(null); // default: no prior calc
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.ALLOWED_ORIGIN = "https://cbamtoolkit.com";
    process.env.KV_REST_API_URL = "https://test.kv.vercel-storage.com";
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  it("sends email with all calculator fields in body", async () => {
    const { req, res } = makeReqRes({
      email: "test@example.com",
      category: "steel",
      volume: 250,
      country: "India",
      totalEmissions: 472.5,
      obligation: 29484,
      emissionsPerTonne: 1.89,
      etsPriceUsed: 62.4,
      carbonPaid: 0,
    });

    await handler(req, res);

    expect(res._getStatus()).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();

    const sentEmail = mockSend.mock.calls[0][0];
    const html: string = sentEmail.html;

    // Product category
    expect(html).toContain("Steel");

    // Volume
    expect(html).toContain("250 tonnes");

    // Country
    expect(html).toContain("India");

    // Emission factor per tonne
    expect(html).toContain("1.89 tCO₂/t");

    // Total embedded emissions
    expect(html).toContain("472.5 tCO₂");

    // ETS price
    expect(html).toContain("€62.40/tCO₂");

    // Obligation (formatted)
    expect(html).toContain("€29,484");
  });

  it("shows obligation highlight block when obligation > 0", async () => {
    const { req, res } = makeReqRes({
      email: "test@example.com",
      category: "cement",
      volume: 100,
      country: "China",
      totalEmissions: 64,
      obligation: 3997,
      emissionsPerTonne: 0.64,
      etsPriceUsed: 62.4,
    });

    await handler(req, res);

    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).toContain("Estimated Annual Obligation");
    expect(html).toContain("€3,997");
  });

  it("omits emission rows when values are zero", async () => {
    const { req, res } = makeReqRes({
      email: "test@example.com",
      category: "steel",
      volume: 100,
      country: "Turkey",
      totalEmissions: 0,
      obligation: 0,
      emissionsPerTonne: 0,
      etsPriceUsed: 0,
    });

    await handler(req, res);

    const html: string = mockSend.mock.calls[0][0].html;
    // Obligation highlight should be absent
    expect(html).not.toContain("Estimated Annual Obligation");
    // Should still show category, volume, country
    expect(html).toContain("Steel");
    expect(html).toContain("100 tonnes");
    expect(html).toContain("Turkey");
  });

  it("shows carbon paid row only when carbonPaid > 0", async () => {
    const { req, res } = makeReqRes({
      email: "test@example.com",
      category: "aluminium",
      volume: 50,
      country: "Russia",
      totalEmissions: 335.5,
      obligation: 10000,
      emissionsPerTonne: 6.71,
      etsPriceUsed: 62.4,
      carbonPaid: 30,
    });

    await handler(req, res);

    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).toContain("Carbon price paid in origin country");
    expect(html).toContain("€30.00/tCO₂");
  });

  it("does not show carbon paid row when carbonPaid is 0", async () => {
    const { req, res } = makeReqRes({
      email: "test@example.com",
      category: "aluminium",
      volume: 50,
      country: "Russia",
      totalEmissions: 335.5,
      obligation: 20949,
      emissionsPerTonne: 6.71,
      etsPriceUsed: 62.4,
      carbonPaid: 0,
    });

    await handler(req, res);

    const html: string = mockSend.mock.calls[0][0].html;
    expect(html).not.toContain("Carbon price paid in origin country");
  });

  it("returns 400 for missing email", async () => {
    const { req, res } = makeReqRes({ category: "steel", volume: 100 });
    await handler(req, res);
    expect(res._getStatus()).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("handles OPTIONS preflight request", async () => {
    const req = {
      method: "OPTIONS",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body: {},
    } as any;

    let statusCode = 0;
    const res = {
      setHeader: vi.fn(),
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      end: vi.fn(),
      json: vi.fn(),
    } as any;

    await handler(req, res);
    expect(statusCode).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

const calcBody = {
  email: "importer@example.com",
  category: "steel",
  volume: 250,
  country: "India",
  totalEmissions: 472.5,
  obligation: 29484,
  emissionsPerTonne: 1.89,
  etsPriceUsed: 62.4,
  carbonPaid: 0,
};

describe("capture handler — free-tier quota enforcement", () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockKvGet.mockClear();
    mockKvSet.mockClear();
    mockKvGet.mockResolvedValue(null); // default: no prior calc
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.ALLOWED_ORIGIN = "https://cbamtoolkit.com";
    process.env.KV_REST_API_URL = "https://test.kv.vercel-storage.com";
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  it("T1: first calculation succeeds and records quota", async () => {
    mockKvGet.mockResolvedValue(null); // no prior calc
    const { req, res } = makeReqRes(calcBody, "10.0.0.1");
    await handler(req, res);

    expect(res._getStatus()).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockKvSet).toHaveBeenCalledOnce();
    // TTL should be 30 days in seconds
    const setCall = mockKvSet.mock.calls[0];
    expect(setCall[2]).toMatchObject({ ex: 30 * 24 * 60 * 60 });
  });

  it("T2: second calculation from same email is blocked — 429 QUOTA_EXCEEDED", async () => {
    mockKvGet.mockResolvedValue(Date.now() - 1000); // prior calc exists
    const { req, res } = makeReqRes(calcBody, "10.0.0.2");
    await handler(req, res);

    expect(res._getStatus()).toBe(429);
    expect((res._getBody() as any).code).toBe("QUOTA_EXCEEDED");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it("T3: different email succeeds independently", async () => {
    mockKvGet.mockResolvedValue(null); // no prior calc for this email
    const { req, res } = makeReqRes(
      { ...calcBody, email: "other@company.com" },
      "10.0.0.3",
    );
    await handler(req, res);

    expect(res._getStatus()).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("T4: after 30-day TTL expires (KV returns null), same email succeeds", async () => {
    // Simulate KV TTL expiry: key no longer exists
    mockKvGet.mockResolvedValue(null);
    const { req, res } = makeReqRes(calcBody, "10.0.0.4");
    await handler(req, res);

    expect(res._getStatus()).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("T5: plain email signup (no category) bypasses quota check", async () => {
    // Hero form signup — no calculator fields
    const { req, res } = makeReqRes(
      { email: "signup@example.com" },
      "10.0.0.5",
    );
    await handler(req, res);

    // Quota KV should NOT be checked for non-calculator requests
    expect(mockKvGet).not.toHaveBeenCalled();
    // Email send may or may not happen (no category = minimal email), just no quota block
    expect(res._getStatus()).not.toBe(429);
  });

  it("T6: quota check skipped gracefully when KV not configured", async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    // Even if KV says prior calc exists, with no config it should pass through
    mockKvGet.mockResolvedValue(Date.now());
    const { req, res } = makeReqRes(calcBody, "10.0.0.6");
    await handler(req, res);

    // Should succeed — no KV check performed
    expect(mockKvGet).not.toHaveBeenCalled();
    expect(res._getStatus()).toBe(200);
  });
});
