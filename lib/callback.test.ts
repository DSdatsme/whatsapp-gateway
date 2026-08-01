import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverCallback } from "@/lib/callback";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("deliverCallback", () => {
  it("succeeds on the first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a failed attempt then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up silently after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" }, 2)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
