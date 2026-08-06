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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("retries once after a failed attempt then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("gives up silently after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" }, 2)
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to deliver callback after 2 attempts",
      { callbackUrl: "https://consumer.example/hook", correlationId: "c1" }
    );
  });

  it("clamps a non-positive attempts value up to 1 instead of never trying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" }, 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
