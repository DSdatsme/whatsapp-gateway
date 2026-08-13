import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp", () => ({
  buildNotificationPayload: vi.fn((to: string, text: string) => ({ to, text })),
  buildApprovalPayload: vi.fn((to: string, text: string, correlationId: string) => ({
    to,
    text,
    correlationId,
  })),
  buildSelectPayload: vi.fn((to: string, text: string, correlationId: string, options: string[]) => ({
    to,
    text,
    correlationId,
    options,
  })),
  buildTemplatePayload: vi.fn(
    (to: string, templateName: string, templateLanguage: string, templateParams: string[]) => ({
      to,
      templateName,
      templateLanguage,
      templateParams,
    })
  ),
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

  it("rejects a malformed JSON body", async () => {
    const malformedRequest = new Request("https://gateway.example/api/send", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(malformedRequest);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/invalid JSON/i);
  });

  it("rejects an invalid type value", async () => {
    const res = await POST(request({ type: "bogus", text: "hi" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/type must be one of/i);
  });

  it("sends a notification and returns a generated correlationId", async () => {
    const res = await POST(request({ type: "notification", text: "hi" }));
    const data = (await res.json()) as { correlationId?: string; error?: string };
    expect(res.status).toBe(200);
    expect(typeof data.correlationId).toBe("string");
    expect(sendWhatsAppMessage).toHaveBeenCalled();
    expect(createPendingRecord).toHaveBeenCalledWith(
      data.correlationId,
      expect.objectContaining({ type: "notification" })
    );
  });

  it("returns 502 when the Graph API call fails, and never creates a pending record", async () => {
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new WhatsAppSendError("boom"));
    const res = await POST(request({ type: "notification", text: "hi" }));
    expect(res.status).toBe(502);
    expect(createPendingRecord).not.toHaveBeenCalled();
  });

  it("rejects a select request with fewer than 2 options", async () => {
    const res = await POST(request({ type: "select", text: "pick one", options: ["Only one"] }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/2-10/);
  });

  it("rejects a select request with more than 10 options", async () => {
    const options = Array.from({ length: 11 }, (_, i) => `Option ${i}`);
    const res = await POST(request({ type: "select", text: "pick one", options }));
    expect(res.status).toBe(400);
  });

  it("rejects a select request with a non-array options field", async () => {
    const res = await POST(request({ type: "select", text: "pick one", options: "not-an-array" }));
    expect(res.status).toBe(400);
  });

  it("sends a select message and stores its options on the pending record", async () => {
    const options = ["Red", "Green", "Blue"];
    const res = await POST(request({ type: "select", text: "pick one", options }));
    const data = (await res.json()) as { correlationId?: string };
    expect(res.status).toBe(200);
    expect(createPendingRecord).toHaveBeenCalledWith(
      data.correlationId,
      expect.objectContaining({ type: "select", options })
    );
  });

  it("rejects a template request missing templateName", async () => {
    const res = await POST(request({ type: "template", templateLanguage: "en" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/templateName/);
  });

  it("rejects a template request missing templateLanguage", async () => {
    const res = await POST(request({ type: "template", templateName: "test_utility_basic" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/templateLanguage/);
  });

  it("sends a template message and returns a generated correlationId", async () => {
    const res = await POST(
      request({
        type: "template",
        templateName: "test_utility_basic",
        templateLanguage: "en",
        templateParams: ["backup-service", "OK"],
      })
    );
    const data = (await res.json()) as { correlationId?: string };
    expect(res.status).toBe(200);
    expect(typeof data.correlationId).toBe("string");
    expect(createPendingRecord).toHaveBeenCalledWith(
      data.correlationId,
      expect.objectContaining({ type: "template" })
    );
  });

  it("does not require text for a template send", async () => {
    const res = await POST(
      request({ type: "template", templateName: "hello_world", templateLanguage: "en_US" })
    );
    expect(res.status).toBe(200);
  });
});
