import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/message-status", () => ({
  getMessageStatus: vi.fn(),
}));

import { GET } from "@/app/api/messages/[messageId]/route";
import { getMessageStatus } from "@/lib/message-status";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  vi.clearAllMocks();
});

function makeRequest(messageId: string, apiKey = "test-key") {
  return {
    req: new Request(`https://gateway.example/api/messages/${messageId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    params: Promise.resolve({ messageId }),
  };
}

describe("GET /api/messages/:messageId", () => {
  it("rejects an unauthenticated request without looking anything up", async () => {
    const { req, params } = makeRequest("wamid.1", "wrong-key");
    const res = await GET(req, { params });
    expect(res.status).toBe(401);
    expect(getMessageStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when no delivery status has been received for the message yet", async () => {
    vi.mocked(getMessageStatus).mockResolvedValue(null);
    const { req, params } = makeRequest("wamid.1");
    const res = await GET(req, { params });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/no delivery status/i);
  });

  it("returns the stored status", async () => {
    vi.mocked(getMessageStatus).mockResolvedValue({
      messageId: "wamid.1",
      status: "delivered",
      updatedAt: 1_700_000_000_000,
      recipient: "15551234567",
    });
    const { req, params } = makeRequest("wamid.1");
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messageId: "wamid.1",
      status: "delivered",
      updatedAt: 1_700_000_000_000,
      recipient: "15551234567",
    });
    expect(getMessageStatus).toHaveBeenCalledWith("wamid.1");
  });

  it("returns Meta's error for a failed message", async () => {
    vi.mocked(getMessageStatus).mockResolvedValue({
      messageId: "wamid.2",
      status: "failed",
      updatedAt: 1,
      error: { code: 131047, title: "Re-engagement message", details: "more than 24 hours have passed" },
    });
    const { req, params } = makeRequest("wamid.2");
    const res = await GET(req, { params });
    expect(((await res.json()) as { error?: { code?: number } }).error?.code).toBe(131047);
  });
});
