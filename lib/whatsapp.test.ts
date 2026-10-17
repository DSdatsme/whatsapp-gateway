import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  buildSelectPayload,
  buildTemplatePayload,
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

  it("logs Meta's error code and trace id when the Graph API rejects a send", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: "Recipient phone number not in allowed list", code: 131030, fbtrace_id: "AbCdEf123" },
      }),
    }) as unknown as typeof fetch;

    await expect(
      sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"))
    ).rejects.toThrow(WhatsAppSendError);
    expect(
      errorSpy.mock.calls.some(([line]) => String(line).includes("131030") && String(line).includes("AbCdEf123"))
    ).toBe(true);
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

describe("buildTemplatePayload", () => {
  it("builds a template payload with positional text parameters", () => {
    const payload = buildTemplatePayload(
      "1234567890",
      "test_utility_basic",
      "en",
      ["backup-service", "OK"]
    ) as any;
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      to: "1234567890",
      type: "template",
      template: {
        name: "test_utility_basic",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "backup-service" },
              { type: "text", text: "OK" },
            ],
          },
        ],
      },
    });
  });

  it("omits components entirely when there are no parameters", () => {
    const payload = buildTemplatePayload("1234567890", "hello_world", "en_US", []) as any;
    expect(payload.template).toEqual({
      name: "hello_world",
      language: { code: "en_US" },
    });
    expect(payload.template.components).toBeUndefined();
  });
});

describe("sendWhatsAppMessage resilience", () => {
  it("gives the Graph API call a timeout signal so a hung request can't stall the function", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.1" }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/messages"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("reports a timeout as a WhatsAppSendError that says the message may still have gone out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })) as unknown as typeof fetch;

    const attempt = sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"));
    await expect(attempt).rejects.toThrow(WhatsAppSendError);
    await expect(attempt).rejects.toThrow(/timed out.*may or may not have been sent/i);
  });

  it("reports a non-JSON error body (e.g. an HTML 502 from a proxy) with the HTTP status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }) as unknown as typeof fetch;

    await expect(sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"))).rejects.toThrow(
      /Graph API error \(502\)/
    );
  });

  it("rejects a success response that carries no message id instead of crashing on it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const attempt = sendWhatsAppMessage(buildNotificationPayload("1234567890", "hi"));
    await expect(attempt).rejects.toThrow(WhatsAppSendError);
    await expect(attempt).rejects.toThrow(/no message id.*may have been sent/i);
  });
});
