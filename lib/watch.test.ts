import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const expiries = new Map<string, number>();

vi.mock("@/lib/redis", () => ({
  redis: {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key: string, value: unknown, opts?: { ex?: number }) {
      store.set(key, value);
      if (opts?.ex) expiries.set(key, opts.ex);
      return "OK";
    },
  },
}));

import { isWatched, watchNumber } from "@/lib/watch";

beforeEach(() => {
  store.clear();
  expiries.clear();
});

describe("watched numbers", () => {
  it("does not watch a number until it is added", async () => {
    expect(await isWatched("919876543210")).toBe(false);
  });

  it("watches a number once added, and only that number", async () => {
    await watchNumber("919876543210");
    expect(await isWatched("919876543210")).toBe(true);
    expect(await isWatched("919876543211")).toBe(false);
  });

  it("stops watching after 7 days, matching how long the inbox keeps messages", async () => {
    await watchNumber("919876543210");
    expect(expiries.get("watch:919876543210")).toBe(60 * 60 * 24 * 7);
  });
});
