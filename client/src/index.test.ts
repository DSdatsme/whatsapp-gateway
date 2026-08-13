import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./index";

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
