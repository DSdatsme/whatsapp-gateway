import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  sendWhatsAppMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.WHATSAPP_PHONE_ID = "test-phone-id";
  process.env.WHATSAPP_TOKEN = "test-token";
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("sendWhatsAppMessage", () => {
  it("returns the message id on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.1" }] }),
    }) as unknown as typeof fetch;

    const result = await sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"));
    expect(result).toEqual({ messageId: "wamid.1" });
  });

  it("throws WhatsAppSendError on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid OAuth token" } }),
    }) as unknown as typeof fetch;

    await expect(
      sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"))
    ).rejects.toThrow(WhatsAppSendError);
  });

  it("throws WhatsAppSendError on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(
      sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"))
    ).rejects.toThrow(WhatsAppSendError);
  });
});

describe("buildApprovalPayload", () => {
  it("embeds the correlation id in both button ids, using caller-supplied labels", () => {
    const payload = buildApprovalPayload("1234567890", "proceed?", "corr-1", "Approve", "Deny") as any;
    const buttons = payload.interactive.action.buttons;
    expect(buttons[0]).toEqual({ type: "reply", reply: { id: "approve:corr-1", title: "Approve" } });
    expect(buttons[1]).toEqual({ type: "reply", reply: { id: "deny:corr-1", title: "Deny" } });
  });
});
