import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, GatewayError } from "./index";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const client = createClient({ baseUrl: "https://gateway.example", apiKey: "test-key" });

describe("sendApproval", () => {
  it("polls until replied and resolves true for approve", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ correlationId: "corr-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "replied", value: "approve" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.sendApproval("proceed?", { pollIntervalMs: 0, timeoutMs: 200 });
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting poll attempts without a reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ correlationId: "corr-1" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ status: "pending" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      client.sendApproval("proceed?", { pollIntervalMs: 5, timeoutMs: 30 })
    ).rejects.toThrow(/timed out/);
  });

  it("rejects combining callbackUrl with the polling convenience method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      client.sendApproval("proceed?", { callbackUrl: "https://consumer.example/hook" })
    ).rejects.toThrow(/callback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendNotification", () => {
  it("sends a notification without polling for a reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendNotification("fyi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendSelect", () => {
  it("sends the options array and polls until replied, resolving to the picked label", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ correlationId: "corr-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "replied", value: "Green" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.sendSelect("pick one", ["Red", "Green", "Blue"], {
      pollIntervalMs: 0,
      timeoutMs: 200,
    });
    expect(result).toBe("Green");

    const sendCall = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(sendCall[1].body);
    expect(sentBody).toEqual({
      type: "select",
      text: "pick one",
      options: ["Red", "Green", "Blue"],
      correlationId: undefined,
    });
  });

  it("rejects combining callbackUrl with the polling convenience method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      client.sendSelect("pick one", ["A", "B"], { callbackUrl: "https://consumer.example/hook" })
    ).rejects.toThrow(/callback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendTemplate", () => {
  it("sends a template message without polling for a reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendTemplate("test_utility_basic", "en", ["backup-service", "OK"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const sendCall = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(sendCall[1].body);
    expect(sentBody).toEqual({
      type: "template",
      templateName: "test_utility_basic",
      templateLanguage: "en",
      templateParams: ["backup-service", "OK"],
      correlationId: undefined,
    });
  });

  it("defaults templateParams to an empty array when omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendTemplate("hello_world", "en_US");
    const sendCall = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(sendCall[1].body);
    expect(sentBody.templateParams).toEqual([]);
  });

  it("passes a caller-supplied correlationId through", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "my-id" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendTemplate("hello_world", "en_US", [], { correlationId: "my-id" });
    const sendCall = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(sendCall[1].body);
    expect(sentBody.correlationId).toBe("my-id");
  });
});

describe("GatewayError", () => {
  it("sets error.name to GatewayError, not the generic Error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "bad key" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client.sendNotification("fyi")).rejects.toMatchObject({ name: "GatewayError" });
  });
});

describe("sendNotification", () => {
  it("returns the ids the gateway sent back, including whether a fallback template was used", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ correlationId: "corr-1", messageId: "wamid.1", viaTemplate: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await client.sendNotification("hi");
    expect(result).toEqual({ correlationId: "corr-1", messageId: "wamid.1", viaTemplate: true });
  });

  it("passes fallbackTemplate through so the gateway can use it when the 24h window is closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ correlationId: "corr-1" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendNotification("hi", {
      fallbackTemplate: { name: "test_utility_basic", language: "en", params: ["backup", "done"] },
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      type: "notification",
      text: "hi",
      fallbackTemplate: { name: "test_utility_basic", language: "en", params: ["backup", "done"] },
    });
  });
});

describe("getMessageStatus", () => {
  it("returns the delivery status for a message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messageId: "wamid.1", status: "delivered", updatedAt: 1 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await client.getMessageStatus("wamid.1");
    expect(status).toEqual({ messageId: "wamid.1", status: "delivered", updatedAt: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/api/messages/wamid.1",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("returns null when the gateway says no status has been received yet", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "no delivery status for this message id (yet, or it expired)" }),
    }) as unknown as typeof fetch;
    expect(await client.getMessageStatus("wamid.1")).toBeNull();
  });

  it("throws on a 404 that isn't the gateway's own answer, e.g. a wrong baseUrl or an older gateway", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }) as unknown as typeof fetch;
    await expect(client.getMessageStatus("wamid.1")).rejects.toThrow(GatewayError);
  });

  it("throws GatewayError on any other failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(client.getMessageStatus("wamid.1")).rejects.toThrow(/401/);
  });
});

describe("getWindow", () => {
  it("returns whether free-form messages can be delivered and when the window closes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ open: true, lastInboundAt: 1000, expiresAt: 2000 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await client.getWindow()).toEqual({ open: true, lastInboundAt: 1000, expiresAt: 2000 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/api/window",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("throws GatewayError when the gateway rejects the request", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(client.getWindow()).rejects.toThrow(/401/);
  });
});

describe("response handling", () => {
  it("url-encodes the correlation id it polls with", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ correlationId: "a/b?c#d" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "replied", value: "approve" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.sendApproval("go?", { pollIntervalMs: 0, timeoutMs: 200 });
    expect(fetchMock.mock.calls[1][0]).toBe("https://gateway.example/api/replies/a%2Fb%3Fc%23d");
  });

  it("raises GatewayError, not a parse error, when the gateway answers with a non-JSON error page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }) as unknown as typeof fetch;

    await expect(client.sendNotification("hi")).rejects.toThrow(GatewayError);
    await expect(client.sendNotification("hi")).rejects.toThrow(/502/);
  });

  it("raises GatewayError when a success response carries no correlationId", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(client.sendNotification("hi")).rejects.toThrow(GatewayError);
  });
});

describe("getInbox", () => {
  it("returns the recent messages the recipient sent to the business number", async () => {
    const messages = [{ id: "m1", type: "text", text: "ok", timestamp: 1_700_000_000_000 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await client.getInbox()).toEqual(messages);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/api/inbox",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("passes since and limit as query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.getInbox({ since: 1_700_000_000_000, limit: 5 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example/api/inbox?since=1700000000000&limit=5");
  });

  it("throws GatewayError when the gateway rejects the request", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(client.getInbox()).rejects.toThrow(/401/);
  });
});
