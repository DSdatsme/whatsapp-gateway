import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scores = new Map<string, number>();

vi.mock("@/lib/redis", () => ({
  redis: {
    async zadd(key: string, opts: { gt?: boolean }, entry: { score: number; member: string }) {
      const id = `${key}/${entry.member}`;
      const current = scores.get(id);
      if (current === undefined || !opts.gt || entry.score > current) scores.set(id, entry.score);
      return 1;
    },
    async zscore(key: string, member: string) {
      return scores.get(`${key}/${member}`) ?? null;
    },
  },
}));

import { getWindowState, recordInbound, WINDOW_MS } from "@/lib/window";

const NOW = 1_800_000_000_000;

beforeEach(() => {
  scores.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getWindowState", () => {
  it("reports the window closed and unknown when nothing has ever been received", async () => {
    expect(await getWindowState(NOW)).toEqual({ open: false, lastInboundAt: null, expiresAt: null });
  });

  it("reports the window open for 24h after the last inbound message", async () => {
    await recordInbound(NOW - 60_000);
    expect(await getWindowState(NOW)).toEqual({
      open: true,
      lastInboundAt: NOW - 60_000,
      expiresAt: NOW - 60_000 + WINDOW_MS,
    });
  });

  it("reports the window closed once 24h have passed, still showing when it closed", async () => {
    const last = NOW - WINDOW_MS - 1;
    await recordInbound(last);
    expect(await getWindowState(NOW)).toEqual({ open: false, lastInboundAt: last, expiresAt: last + WINDOW_MS });
  });

  it("restarts the window on every new inbound message", async () => {
    await recordInbound(NOW - WINDOW_MS + 1000);
    await recordInbound(NOW);
    expect((await getWindowState(NOW)).expiresAt).toBe(NOW + WINDOW_MS);
  });
});

describe("recordInbound", () => {
  it("keeps the newest timestamp when an older message is processed late", async () => {
    await recordInbound(NOW);
    await recordInbound(NOW - 5000);
    expect((await getWindowState(NOW)).lastInboundAt).toBe(NOW);
  });
});

describe("recordInbound concurrency", () => {
  it.each([
    ["older first", [NOW - 10_000, NOW]],
    ["newer first", [NOW, NOW - 10_000]],
  ])("keeps the newest timestamp when two webhooks are processed at once (%s)", async (_label, timestamps) => {
    await Promise.all(timestamps.map((at) => recordInbound(at)));
    expect((await getWindowState()).lastInboundAt).toBe(NOW);
  });
});

describe("clock handling", () => {
  it("defaults 'now' to the current time", async () => {
    await recordInbound(NOW - 1000);
    expect((await getWindowState()).open).toBe(true);

    scores.clear();
    await recordInbound(NOW - WINDOW_MS - 1);
    expect((await getWindowState()).open).toBe(false);
  });

  it("clamps a timestamp from the future so one bad value can't pin the window open", async () => {
    await recordInbound(NOW + 10 * WINDOW_MS);
    expect((await getWindowState()).lastInboundAt).toBe(NOW);
  });
});
