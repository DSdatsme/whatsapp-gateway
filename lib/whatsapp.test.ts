import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  buildSelectPayload,
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

  it("sets error.name to WhatsAppSendError, not the generic Error", () => {
    const error = new WhatsAppSendError("boom");
    expect(error.name).toBe("WhatsAppSendError");
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

describe("buildSelectPayload", () => {
  it("builds one list row per option, id-encoded as correlationId:index", () => {
    const payload = buildSelectPayload("1234567890", "pick one", "corr-1", ["Red", "Green", "Blue"]) as any;
    const rows = payload.interactive.action.sections[0].rows;
    expect(rows).toEqual([
      { id: "corr-1:0", title: "Red" },
      { id: "corr-1:1", title: "Green" },
      { id: "corr-1:2", title: "Blue" },
    ]);
    expect(payload.interactive.type).toBe("list");
    expect(payload.interactive.body.text).toBe("pick one");
  });

  it("keeps the correlation id intact even when it contains a colon", () => {
    const payload = buildSelectPayload("1234567890", "pick one", "job:42", ["A", "B"]) as any;
    const rows = payload.interactive.action.sections[0].rows;
    expect(rows[0].id).toBe("job:42:0");
    expect(rows[1].id).toBe("job:42:1");
  });
});
