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
