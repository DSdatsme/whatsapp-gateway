import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp", () => ({
  buildNotificationPayload: vi.fn((to: string, text: string) => ({ to, text })),
  buildApprovalPayload: vi.fn((to: string, text: string, correlationId: string) => ({
    to,
    text,
    correlationId,
  })),
  sendWhatsAppMessage: vi.fn(async () => ({ messageId: "wamid.1" })),
  WhatsAppSendError: class WhatsAppSendError extends Error {},
}));

vi.mock("@/lib/correlation", () => ({
  createPendingRecord: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/send/route";
import { sendWhatsAppMessage, WhatsAppSendError } from "@/lib/whatsapp";
import { createPendingRecord } from "@/lib/correlation";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  process.env.WHATSAPP_RECIPIENT_NUMBER = "15551234567";
  vi.clearAllMocks();
});

function request(body: unknown, apiKey = "test-key"): Request {
  return new Request("https://gateway.example/api/send", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/send", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await POST(request({ type: "notification", text: "hi" }, "wrong-key"));
    expect(res.status).toBe(401);
  });

  it("rejects a request missing required fields", async () => {
    const res = await POST(request({ type: "notification" }));
    expect(res.status).toBe(400);
  });

  it("sends a notification and returns a generated correlationId", async () => {
    const res = await POST(request({ type: "notification", text: "hi" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(typeof data.correlationId).toBe("string");
    expect(sendWhatsAppMessage).toHaveBeenCalled();
    expect(createPendingRecord).toHaveBeenCalledWith(
      data.correlationId,
      expect.objectContaining({ type: "notification" })
    );
  });

  it("returns 502 when the Graph API call fails", async () => {
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new WhatsAppSendError("boom"));
    const res = await POST(request({ type: "notification", text: "hi" }));
    expect(res.status).toBe(502);
  });
});
