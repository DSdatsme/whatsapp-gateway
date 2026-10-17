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
      { callbackUrl: "https://consumer.example", correlationId: "c1" }
    );
  });

  it("clamps a non-positive attempts value up to 1 instead of never trying", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" }, 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("deliverCallback hardening", () => {
  it("does not follow redirects, so a callback URL can't bounce the gateway to another host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://consumer.example/hook",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it.each([
    ["query string", "https://consumer.example/hook?token=s3cret"],
    ["path (as in chat webhook URLs)", "https://hooks.example/services/T000/B000/s3cret"],
  ])("keeps a secret in the %s out of the failure log", async (_where, url) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;

    await deliverCallback(url, { correlationId: "c1", value: "approve" }, 1);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain(new URL(url).origin);
    expect(logged).not.toContain("s3cret");
  });
});

describe("deliverCallback timeout", () => {
  it("waits long enough for a slow consumer to acknowledge, since a timed-out request may still be processed", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("gives every attempt a timeout signal so a hung consumer can't hold the work open", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await deliverCallback("https://consumer.example/hook", { correlationId: "c1", value: "approve" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://consumer.example/hook",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
