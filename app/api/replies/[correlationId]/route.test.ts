import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/correlation", () => ({
  getPendingRecord: vi.fn(),
}));

import { GET } from "@/app/api/replies/[correlationId]/route";
import { getPendingRecord } from "@/lib/correlation";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  vi.clearAllMocks();
});

function makeRequest(correlationId: string, apiKey = "test-key") {
  return {
    req: new Request(`https://gateway.example/api/replies/${correlationId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    params: Promise.resolve({ correlationId }),
  };
}

describe("GET /api/replies/:correlationId", () => {
  it("rejects an unauthenticated request", async () => {
    const { req, params } = makeRequest("corr-1", "wrong-key");
    const res = await GET(req, { params });
    expect(res.status).toBe(401);
  });

  it("returns 404 when there is no such record", async () => {
    vi.mocked(getPendingRecord).mockResolvedValue(null);
    const { req, params } = makeRequest("corr-1");
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
  });

  it("returns pending status while unresolved", async () => {
    vi.mocked(getPendingRecord).mockResolvedValue({
      status: "pending",
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: 1,
    });
    const { req, params } = makeRequest("corr-1");
    const res = await GET(req, { params });
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("returns the value once replied", async () => {
    vi.mocked(getPendingRecord).mockResolvedValue({
      status: "replied",
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: 1,
      value: "the answer",
      receivedAt: 2,
    });
    const { req, params } = makeRequest("corr-1");
    const res = await GET(req, { params });
    expect(await res.json()).toEqual({ status: "replied", value: "the answer", receivedAt: 2 });
  });
});
