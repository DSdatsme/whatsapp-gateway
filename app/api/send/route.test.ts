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

vi.mock("@/lib/watch", () => ({
  watchNumber: vi.fn(async () => {}),
}));

vi.mock("@/lib/window", () => ({
  getWindowState: vi.fn(async () => ({ open: true, lastInboundAt: 1, expiresAt: Date.now() + 60 * 60 * 1000 })),
}));

import { POST } from "@/app/api/send/route";
import {
  buildNotificationPayload,
  buildTemplatePayload,
  sendWhatsAppMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp";
import { createPendingRecord } from "@/lib/correlation";
import { getWindowState } from "@/lib/window";
import { watchNumber } from "@/lib/watch";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  process.env.WHATSAPP_RECIPIENT_NUMBER = "15551234567";
  vi.clearAllMocks();
});

// True if a single logged line contains every one of `parts`.
function loggedLine(spy: { mock: { calls: unknown[][] } }, ...parts: string[]): boolean {
  return spy.mock.calls.some(([line]) => parts.every((part) => String(line).includes(part)));
}

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

  it("sends a notification and returns a generated correlationId and the WhatsApp message id", async () => {
    const res = await POST(request({ type: "notification", text: "hi" }));
    const data = (await res.json()) as { correlationId?: string; messageId?: string; error?: string };
    expect(res.status).toBe(200);
    expect(typeof data.correlationId).toBe("string");
    expect(data.messageId).toBe("wamid.1");
    expect(sendWhatsAppMessage).toHaveBeenCalled();
  });

  it("doesn't store a pending record for a notification, since no reply is tracked", async () => {
    await POST(request({ type: "notification", text: "hi" }));
    expect(createPendingRecord).not.toHaveBeenCalled();
  });


  it("logs the correlationId together with the WhatsApp message id after sending", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(request({ type: "notification", text: "hi", correlationId: "corr-log" }));
    expect(res.status).toBe(200);
    expect(loggedLine(logSpy, "corr-log", "wamid.1")).toBe(true);
    logSpy.mockRestore();
  });

  it("logs that the message already went out when storing the pending record fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createPendingRecord).mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND redis.example"));
    await POST(request({ type: "approval", text: "ok?", correlationId: "corr-redis" }));
    expect(loggedLine(errorSpy, "corr-redis", "wamid.1", "ENOTFOUND")).toBe(true);
    errorSpy.mockRestore();
  });

  it("returns a structured 500 saying the message WAS sent when reply tracking can't be stored", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createPendingRecord).mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND redis.example"));
    const res = await POST(request({ type: "prompt", text: "name?", correlationId: "corr-redis" }));
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error?: string; sent?: boolean; messageId?: string; correlationId?: string };
    expect(data).toMatchObject({ sent: true, messageId: "wamid.1", correlationId: "corr-redis" });
    expect(data.error).toMatch(/was sent/i);
    errorSpy.mockRestore();
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

  it("sends only to the default recipient when 'also' is omitted", async () => {
    const { buildNotificationPayload, sendWhatsAppMessage } = await import("@/lib/whatsapp");
    await POST(request({ type: "notification", text: "hi" }));
    expect(buildNotificationPayload).toHaveBeenCalledTimes(1);
    expect(buildNotificationPayload).toHaveBeenCalledWith("15551234567", "hi");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("sends an additional copy to 'also' without dropping the default recipient", async () => {
    const { buildNotificationPayload, sendWhatsAppMessage } = await import("@/lib/whatsapp");
    const res = await POST(request({ type: "notification", text: "hi", also: "919876543210" }));
    expect(res.status).toBe(200);
    expect(buildNotificationPayload).toHaveBeenNthCalledWith(1, "15551234567", "hi");
    expect(buildNotificationPayload).toHaveBeenNthCalledWith(2, "919876543210", "hi");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  it("doesn't double-send when 'also' matches the default recipient", async () => {
    const { sendWhatsAppMessage } = await import("@/lib/whatsapp");
    await POST(request({ type: "notification", text: "hi", also: "15551234567" }));
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("still succeeds and reports 'alsoError' if the extra send to 'also' fails", async () => {
    const { sendWhatsAppMessage, WhatsAppSendError: SendErr } = await import("@/lib/whatsapp");
    vi.mocked(sendWhatsAppMessage)
      .mockResolvedValueOnce({ messageId: "wamid.1" })
      .mockRejectedValueOnce(new SendErr("also-recipient boom"));
    const res = await POST(request({ type: "notification", text: "hi", also: "919876543210" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { correlationId?: string; alsoError?: string };
    expect(typeof data.correlationId).toBe("string");
    expect(data.alsoError).toMatch(/also-recipient boom/);
  });

  it("rejects an 'also' value that isn't digits-only E.164", async () => {
    const res = await POST(request({ type: "notification", text: "hi", also: "+91 98765-43210" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/also must be digits only/i);
  });

  it("rejects an 'also' value that's too short", async () => {
    const res = await POST(request({ type: "notification", text: "hi", also: "12345" }));
    expect(res.status).toBe(400);
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
    expect(createPendingRecord).not.toHaveBeenCalled();
    expect(buildTemplatePayload).toHaveBeenCalledWith(
      "15551234567",
      "test_utility_basic",
      "en",
      ["backup-service", "OK"]
    );
  });

  it("does not require text for a template send", async () => {
    const res = await POST(
      request({ type: "template", templateName: "hello_world", templateLanguage: "en_US" })
    );
    expect(res.status).toBe(200);
  });

  it("rejects a template request with a non-array templateParams field", async () => {
    const res = await POST(
      request({
        type: "template",
        templateName: "x",
        templateLanguage: "en",
        templateParams: "not-an-array",
      })
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/templateParams/);
  });
});

describe("POST /api/send fallbackTemplate", () => {
  const FALLBACK = { name: "test_utility_basic", language: "en", params: ["backup-service", "Backup finished"] };
  const WINDOW_CLOSED = { open: false, lastInboundAt: null, expiresAt: null };

  it("sends the free-form text when the 24h window is open", async () => {
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate: FALLBACK }));
    const data = (await res.json()) as { viaTemplate?: boolean };
    expect(res.status).toBe(200);
    expect(buildNotificationPayload).toHaveBeenCalledWith("15551234567", "hi");
    expect(buildTemplatePayload).not.toHaveBeenCalled();
    expect(data.viaTemplate).toBeUndefined();
  });

  it("sends the fallback template instead when the 24h window is closed", async () => {
    vi.mocked(getWindowState).mockResolvedValueOnce(WINDOW_CLOSED);
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate: FALLBACK }));
    const data = (await res.json()) as { viaTemplate?: boolean; messageId?: string };
    expect(res.status).toBe(200);
    expect(buildTemplatePayload).toHaveBeenCalledWith("15551234567", "test_utility_basic", "en", [
      "backup-service",
      "Backup finished",
    ]);
    expect(buildNotificationPayload).not.toHaveBeenCalled();
    expect(data).toMatchObject({ viaTemplate: true, messageId: "wamid.1" });
  });

  it("falls back to the template when the window state can't be read, since a template always delivers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getWindowState).mockRejectedValueOnce(new Error("redis down"));
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate: FALLBACK }));
    const data = (await res.json()) as { viaTemplate?: boolean };
    expect(res.status).toBe(200);
    expect(data.viaTemplate).toBe(true);
    errorSpy.mockRestore();
  });

  it("doesn't look at the window at all when no fallbackTemplate is given", async () => {
    await POST(request({ type: "notification", text: "hi" }));
    expect(getWindowState).not.toHaveBeenCalled();
  });

  it("sends the 'also' copy as the template when the window is closed", async () => {
    vi.mocked(getWindowState).mockResolvedValueOnce(WINDOW_CLOSED);
    await POST(request({ type: "notification", text: "hi", also: "919876543210", fallbackTemplate: FALLBACK }));
    expect(buildTemplatePayload).toHaveBeenCalledTimes(2);
    expect(buildTemplatePayload).toHaveBeenNthCalledWith(2, "919876543210", "test_utility_basic", "en", [
      "backup-service",
      "Backup finished",
    ]);
  });

  it("sends the 'also' copy as the template even when the primary's window is open, since only the primary's window is tracked", async () => {
    await POST(request({ type: "notification", text: "hi", also: "919876543210", fallbackTemplate: FALLBACK }));
    expect(buildNotificationPayload).toHaveBeenCalledTimes(1);
    expect(buildNotificationPayload).toHaveBeenCalledWith("15551234567", "hi");
    expect(buildTemplatePayload).toHaveBeenCalledTimes(1);
    expect(buildTemplatePayload).toHaveBeenCalledWith("919876543210", "test_utility_basic", "en", [
      "backup-service",
      "Backup finished",
    ]);
  });

  it("allows an omitted params list on the fallback template", async () => {
    vi.mocked(getWindowState).mockResolvedValueOnce(WINDOW_CLOSED);
    await POST(
      request({ type: "notification", text: "hi", fallbackTemplate: { name: "hello_world", language: "en_US" } })
    );
    expect(buildTemplatePayload).toHaveBeenCalledWith("15551234567", "hello_world", "en_US", []);
  });

  it("rejects fallbackTemplate on a type that can't be replaced by a template", async () => {
    const res = await POST(request({ type: "approval", text: "ok?", fallbackTemplate: FALLBACK }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/fallbackTemplate is only supported for type notification/i);
  });

  it("rejects a fallbackTemplate missing its name or language", async () => {
    const noName = await POST(
      request({ type: "notification", text: "hi", fallbackTemplate: { language: "en" } })
    );
    const noLang = await POST(
      request({ type: "notification", text: "hi", fallbackTemplate: { name: "x" } })
    );
    expect(noName.status).toBe(400);
    expect(noLang.status).toBe(400);
    expect(((await noName.json()) as { error?: string }).error).toMatch(/fallbackTemplate/);
  });

  it("rejects fallbackTemplate params that aren't an array of strings", async () => {
    const res = await POST(
      request({
        type: "notification",
        text: "hi",
        fallbackTemplate: { name: "x", language: "en", params: [1, 2] },
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/fallbackTemplate\.params/);
  });
});

describe("POST /api/send ordering and tracking", () => {
  it("stores the pending record before sending the 'also' copy, so a slow second send can't lose it", async () => {
    await POST(request({ type: "approval", text: "ok?", also: "919876543210" }));
    const stored = vi.mocked(createPendingRecord).mock.invocationCallOrder[0];
    const sends = vi.mocked(sendWhatsAppMessage).mock.invocationCallOrder;
    expect(sends).toHaveLength(2);
    expect(stored).toBeGreaterThan(sends[0]);
    expect(stored).toBeLessThan(sends[1]);
  });

  it("still sends the 'also' copy and reports it when only the reply tracking fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createPendingRecord).mockRejectedValueOnce(new Error("redis down"));
    const res = await POST(request({ type: "approval", text: "ok?", also: "919876543210" }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { sent?: boolean }).sent).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    vi.mocked(console.error).mockRestore();
  });
});

describe("POST /api/send input validation", () => {
  it.each([['"x"'], ['{"a":1}'], ["has space"], ["a".repeat(129)], [""], [123], [["x"]]])(
    "rejects invalid correlationId #%#",
    async (correlationId) => {
      const res = await POST(request({ type: "prompt", text: "hi", correlationId }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toMatch(/correlationId/);
      expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    }
  );

  it.each([["deploy-42"], ["job:123"], ["3f2b8c0e-9d1a-4f7e-8c55-1a2b3c4d5e6f"], ["run_7.attempt-2"]])(
    "accepts correlationId %s",
    async (correlationId) => {
      const res = await POST(request({ type: "prompt", text: "hi", correlationId }));
      expect(res.status).toBe(200);
    }
  );

  it.each([["file:///etc/passwd"], ["javascript:alert(1)"], ["not a url"], ["https://x.example/" + "a".repeat(2048)], [42]])(
    "rejects invalid callbackUrl #%#",
    async (callbackUrl) => {
      const res = await POST(request({ type: "approval", text: "ok?", callbackUrl }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toMatch(/callbackUrl/);
    }
  );

  it("stores a valid https callbackUrl on the pending record", async () => {
    await POST(request({ type: "approval", text: "ok?", callbackUrl: "https://consumer.example/hook" }));
    expect(createPendingRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ callbackUrl: "https://consumer.example/hook" })
    );
  });

  it("rejects a JSON null body with a 400 instead of crashing", async () => {
    const res = await POST(
      new Request("https://gateway.example/api/send", {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: "null",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects an 'also' that is a number rather than a digit string", async () => {
    const res = await POST(request({ type: "notification", text: "hi", also: 919876543210 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/send optional fields and URL checks", () => {
  it.each([
    ["correlationId", { type: "prompt", text: "hi", correlationId: null }],
    ["callbackUrl", { type: "approval", text: "ok?", callbackUrl: null }],
    ["fallbackTemplate", { type: "notification", text: "hi", fallbackTemplate: null }],
  ])("treats a null %s like an omitted one", async (_field, body) => {
    const res = await POST(request(body));
    expect(res.status).toBe(200);
  });

  it.each([
    [{ name: 123, language: "en" }],
    [{ name: "x", language: { code: "en" } }],
    ["just-a-string"],
  ])("rejects a fallbackTemplate that isn't strings: %j", async (fallbackTemplate) => {
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/fallbackTemplate/);
  });

  it("rejects a callbackUrl with embedded credentials, which fetch refuses to call", async () => {
    const res = await POST(request({ type: "approval", text: "ok?", callbackUrl: "https://user:pw@consumer.example/hook" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/callbackUrl/);
  });
});

describe("POST /api/send correlationId on types that don't track replies", () => {
  it.each([
    ["notification", { type: "notification", text: "hi" }],
    ["template", { type: "template", templateName: "hello_world", templateLanguage: "en_US" }],
  ])("doesn't reject an unusual correlationId on a %s, which never uses it", async (_type, body) => {
    const res = await POST(request({ ...body, correlationId: "nightly backup 2026-10-17" }));
    expect(res.status).toBe(200);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/send window margin and empty ids", () => {
  const FALLBACK = { name: "test_utility_basic", language: "en", params: ["a", "b"] };

  it("uses the fallback template when the window is about to close, since the send could land after it does", async () => {
    vi.mocked(getWindowState).mockResolvedValueOnce({ open: true, lastInboundAt: 1, expiresAt: Date.now() + 30_000 });
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate: FALLBACK }));
    expect(((await res.json()) as { viaTemplate?: boolean }).viaTemplate).toBe(true);
  });

  it("still sends free-form text while the window has comfortable time left", async () => {
    vi.mocked(getWindowState).mockResolvedValueOnce({ open: true, lastInboundAt: 1, expiresAt: Date.now() + 10 * 60 * 1000 });
    const res = await POST(request({ type: "notification", text: "hi", fallbackTemplate: FALLBACK }));
    expect(((await res.json()) as { viaTemplate?: boolean }).viaTemplate).toBeUndefined();
  });

  it("replaces an empty correlationId with a generated one instead of echoing it back", async () => {
    const res = await POST(request({ type: "notification", text: "hi", correlationId: "" }));
    const data = (await res.json()) as { correlationId?: string };
    expect(res.status).toBe(200);
    expect(data.correlationId).toMatch(/\S/);
  });
});

describe("POST /api/send copy to an 'also' recipient", () => {
  const ALSO = "919876543210";

  it("returns the message id of the copy so its delivery can be checked", async () => {
    vi.mocked(sendWhatsAppMessage)
      .mockResolvedValueOnce({ messageId: "wamid.primary" })
      .mockResolvedValueOnce({ messageId: "wamid.copy" });
    const res = await POST(request({ type: "notification", text: "hi", also: ALSO }));
    expect(await res.json()).toMatchObject({ messageId: "wamid.primary", alsoMessageId: "wamid.copy" });
  });

  it("returns no copy id when the copy failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendWhatsAppMessage)
      .mockResolvedValueOnce({ messageId: "wamid.primary" })
      .mockRejectedValueOnce(new WhatsAppSendError("copy failed"));
    const data = (await (await POST(request({ type: "notification", text: "hi", also: ALSO }))).json()) as Record<string, string>;
    expect(data.alsoMessageId).toBeUndefined();
    expect(data.alsoError).toMatch(/copy failed/);
    vi.mocked(console.error).mockRestore();
  });

  it("starts watching that number for replies before the copy is sent", async () => {
    await POST(request({ type: "notification", text: "hi", also: ALSO }));
    expect(watchNumber).toHaveBeenCalledWith(ALSO);
    const watched = vi.mocked(watchNumber).mock.invocationCallOrder[0];
    const sends = vi.mocked(sendWhatsAppMessage).mock.invocationCallOrder;
    expect(watched).toBeGreaterThan(sends[0]);
    expect(watched).toBeLessThan(sends[1]);
  });

  it("still sends the copy when watching can't be started, and says its replies may be missed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(watchNumber).mockRejectedValueOnce(new Error("redis down"));
    const res = await POST(request({ type: "notification", text: "hi", also: ALSO }));
    expect(res.status).toBe(200);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    expect(((await res.json()) as { alsoWatchError?: string }).alsoWatchError).toMatch(/replies may not be captured/);
    vi.mocked(console.error).mockRestore();
  });

  it("returns the number as typed when Meta reports no different id", async () => {
    const data = (await (await POST(request({ type: "notification", text: "hi", also: ALSO }))).json()) as Record<string, string>;
    expect(data.alsoNumber).toBe(ALSO);
    expect(data.alsoWatchError).toBeUndefined();
  });

  it("also watches the number Meta resolved when it differs from the one typed, and returns it", async () => {
    vi.mocked(sendWhatsAppMessage)
      .mockResolvedValueOnce({ messageId: "wamid.primary" })
      .mockResolvedValueOnce({ messageId: "wamid.copy", recipientId: "5215512345678" });
    const data = (await (await POST(request({ type: "notification", text: "hi", also: "525512345678" }))).json()) as Record<string, string>;
    expect(watchNumber).toHaveBeenNthCalledWith(1, "525512345678");
    expect(watchNumber).toHaveBeenNthCalledWith(2, "5215512345678");
    expect(data.alsoNumber).toBe("5215512345678");
  });

  it.each([
    ["there is no 'also'", { type: "notification", text: "hi" }],
    ["'also' is the recipient themself", { type: "notification", text: "hi", also: "15551234567" }],
  ])("watches nothing when %s", async (_why, body) => {
    await POST(request(body));
    expect(watchNumber).not.toHaveBeenCalled();
  });
});
