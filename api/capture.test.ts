import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures mockSend is available in the vi.mock factory (which is hoisted to the top)
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue({ id: "email-id-123" }),
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
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
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.ALLOWED_ORIGIN = "https://cbamtoolkit.com";
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
