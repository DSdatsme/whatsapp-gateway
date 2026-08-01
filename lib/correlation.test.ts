import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const zsets = new Map<string, Map<string, number>>();

vi.mock("@/lib/redis", () => ({
  redis: {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async zadd(key: string, entry: { score: number; member: string }) {
      const set = zsets.get(key) ?? new Map<string, number>();
      set.set(entry.member, entry.score);
      zsets.set(key, set);
    },
    async zrange(key: string, start: number, stop: number) {
      const set = zsets.get(key);
      if (!set) return [];
      const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
      const normalize = (i: number) => (i < 0 ? sorted.length + i : i);
      return sorted.slice(normalize(start), normalize(stop) + 1).map(([member]) => member);
    },
    async zrem(key: string, member: string) {
      zsets.get(key)?.delete(member);
    },
  },
}));

import {
  createPendingRecord,
  getPendingRecord,
  markReplied,
  resolveCorrelationId,
} from "@/lib/correlation";

beforeEach(() => {
  store.clear();
  zsets.clear();
});

describe("resolveCorrelationId", () => {
  it("resolves from a button id", async () => {
    const resolved = await resolveCorrelationId({ buttonId: "approve:abc123" });
    expect(resolved).toEqual({ correlationId: "abc123", decision: "approve" });
  });

  it("resolves from context.id via the message-id index", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: 1,
    });
    const resolved = await resolveCorrelationId({ contextMessageId: "wamid.1" });
    expect(resolved).toEqual({ correlationId: "abc123" });
  });

  it("falls back to the most recent pending prompt when there is no context", async () => {
    await createPendingRecord("older", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: 1 });
    await createPendingRecord("newer", { type: "prompt", whatsappMessageId: "wamid.2", createdAt: 2 });
    const resolved = await resolveCorrelationId({});
    expect(resolved).toEqual({ correlationId: "newer" });
  });

  it("skips stale zset entries (expired pending records) and resolves to next valid one", async () => {
    await createPendingRecord("older", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: 1 });
    await createPendingRecord("newer", { type: "prompt", whatsappMessageId: "wamid.2", createdAt: 2 });
    // Simulate expiry: remove newer's backing record but leave it in the zset (what TTL does in real Redis)
    store.delete("pending:newer");
    const resolved = await resolveCorrelationId({});
    expect(resolved).toEqual({ correlationId: "older" });
    // Verify the stale entry was removed from the zset
    const zset = zsets.get("pending-prompts");
    expect(zset?.has("newer")).toBe(false);
  });

  it("returns null when nothing is pending and there is no context", async () => {
    const resolved = await resolveCorrelationId({});
    expect(resolved).toBeNull();
  });
});

describe("markReplied", () => {
  it("marks a pending record as replied and removes it from the prompt index", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: 1 });
    const updated = await markReplied("abc123", "hello");
    expect(updated?.status).toBe("replied");
    expect(updated?.value).toBe("hello");
    expect(await resolveCorrelationId({})).toBeNull();
  });

  it("returns null for an already-replied record (duplicate webhook delivery)", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: 1 });
    await markReplied("abc123", "hello");
    expect(await markReplied("abc123", "hello again")).toBeNull();
  });
});

describe("getPendingRecord", () => {
  it("returns null for an unknown correlation id", async () => {
    expect(await getPendingRecord("nope")).toBeNull();
  });
});
