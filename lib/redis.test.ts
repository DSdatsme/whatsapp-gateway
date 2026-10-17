import { describe, expect, it, vi } from "vitest";

const fromEnv = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@upstash/redis", () => ({ Redis: { fromEnv } }));

import "@/lib/redis";

describe("redis client", () => {
  it("bounds every request with a timeout signal, so a stalled Redis can't hang a handler", () => {
    const config = (fromEnv.mock.calls[0] as unknown as [{ signal: () => AbortSignal }])[0];
    expect(config.signal()).toBeInstanceOf(AbortSignal);
  });
});
