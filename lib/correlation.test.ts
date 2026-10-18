import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const zsets = new Map<string, Map<string, number>>();
let failNextPlainSet = false;
let failNextZrem = false;
let loseNextNxResponse = false;
let failNextZremrange = false;
let zrangeCalls = 0;
const stuckMembers = new Set<string>();
const expiries = new Map<string, number>();

vi.mock("@/lib/redis", () => ({
  redis: {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      if (opts?.nx) {
        if (store.has(key)) return null;
        if (loseNextNxResponse) {
          loseNextNxResponse = false;
          store.set(key, value);
          if (opts.ex) expiries.set(key, opts.ex);
          return null;
        }
      } else if (failNextPlainSet) {
        failNextPlainSet = false;
        throw new Error("redis write failed");
      }
      store.set(key, value);
      if (opts?.ex) expiries.set(key, opts.ex);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async zadd(key: string, entry: { score: number; member: string }) {
      const set = zsets.get(key) ?? new Map<string, number>();
      set.set(entry.member, entry.score);
      zsets.set(key, set);
    },
    async zrange(key: string, start: number, stop: number) {
      if (++zrangeCalls > 100) throw new Error("zrange called too many times");
      const set = zsets.get(key);
      if (!set) return [];
      const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
      const normalize = (i: number) => (i < 0 ? sorted.length + i : i);
      return sorted.slice(normalize(start), normalize(stop) + 1).map(([member]) => member);
    },
    async zrem(key: string, member: string) {
      if (failNextZrem) {
        failNextZrem = false;
        throw new Error("redis zrem failed");
      }
      if (!stuckMembers.has(member)) zsets.get(key)?.delete(member);
    },
    async zremrangebyscore(key: string, min: number, max: number) {
      if (failNextZremrange) {
        failNextZremrange = false;
        throw new Error("redis zremrangebyscore failed");
      }
      const set = zsets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const [member, score] of set) {
        if (score >= min && score <= max) {
          set.delete(member);
          removed++;
        }
      }
      return removed;
    },
  },
}));

import {
  createPendingRecord,
  getPendingRecord,
  markReplied,
  pinInboundDecision,
  resolveCorrelationId,
} from "@/lib/correlation";

const RECIPIENT = "15551234567";

beforeEach(() => {
  store.clear();
  zsets.clear();
  failNextPlainSet = false;
  failNextZrem = false;
  loseNextNxResponse = false;
  failNextZremrange = false;
  zrangeCalls = 0;
  stuckMembers.clear();
  expiries.clear();
  process.env.WHATSAPP_RECIPIENT_NUMBER = RECIPIENT;
});

describe("resolveCorrelationId", () => {
  it("resolves from a button id", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, buttonId: "approve:abc123" });
    expect(resolved).toEqual({ correlationId: "abc123", decision: "approve" });
  });

  it("resolves from a button id whose correlationId itself contains a colon", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, buttonId: "approve:job:123" });
    expect(resolved).toEqual({ correlationId: "job:123", decision: "approve" });
  });

  it("resolves from a list reply id", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, listReplyId: "abc123:1" });
    expect(resolved).toEqual({ correlationId: "abc123", selectedIndex: 1 });
  });

  it("resolves from a list reply id whose correlationId itself contains a colon", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, listReplyId: "job:42:2" });
    expect(resolved).toEqual({ correlationId: "job:42", selectedIndex: 2 });
  });

  it("returns null for a malformed list reply id (non-numeric index)", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, listReplyId: "abc123:notanumber" });
    expect(resolved).toBeNull();
  });

  it("returns null for a list reply id with no colon", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT, listReplyId: "abc123" });
    expect(resolved).toBeNull();
  });

  it("resolves from context.id via the message-id index", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    const resolved = await resolveCorrelationId({ from: RECIPIENT, contextMessageId: "wamid.1" });
    expect(resolved).toEqual({ correlationId: "abc123" });
  });

  it("falls back to the most recent pending prompt when there is no context", async () => {
    await createPendingRecord("older", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now() - 2000,
    });
    await createPendingRecord("newer", {
      type: "prompt",
      whatsappMessageId: "wamid.2",
      createdAt: Date.now() - 1000,
    });
    const resolved = await resolveCorrelationId({ from: RECIPIENT });
    expect(resolved).toEqual({ correlationId: "newer" });
  });

  it("skips stale zset entries (expired pending records) and resolves to next valid one", async () => {
    await createPendingRecord("older", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now() - 2000,
    });
    await createPendingRecord("newer", {
      type: "prompt",
      whatsappMessageId: "wamid.2",
      createdAt: Date.now() - 1000,
    });
    // Simulate expiry: remove newer's backing record but leave it in the zset (what TTL does in real Redis)
    store.delete("pending:newer");
    const resolved = await resolveCorrelationId({ from: RECIPIENT });
    expect(resolved).toEqual({ correlationId: "older" });
    // Verify the stale entry was removed from the zset
    const zset = zsets.get("pending-prompts");
    expect(zset?.has("newer")).toBe(false);
  });

  it("returns null when nothing is pending and there is no context", async () => {
    const resolved = await resolveCorrelationId({ from: RECIPIENT });
    expect(resolved).toBeNull();
  });

  it("returns null for a well-formed button id from a sender other than the configured recipient", async () => {
    const resolved = await resolveCorrelationId({ from: "19995551234", buttonId: "approve:abc123" });
    expect(resolved).toBeNull();
  });

  it("returns null for an empty sender", async () => {
    const resolved = await resolveCorrelationId({ from: "", buttonId: "approve:abc123" });
    expect(resolved).toBeNull();
  });

  it("returns null for a list reply from a sender other than the configured recipient", async () => {
    expect(await resolveCorrelationId({ from: "19995551234", listReplyId: "abc123:1" })).toBeNull();
  });

  it("returns null for a swipe-reply to a pending prompt from a sender other than the configured recipient", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: Date.now() });
    expect(await resolveCorrelationId({ from: "19995551234", contextMessageId: "wamid.1" })).toBeNull();
  });

  it("does not let an outside sender hijack the most-recent-pending-prompt fallback", async () => {
    await createPendingRecord("real-prompt", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    const resolved = await resolveCorrelationId({ from: "19995551234" });
    expect(resolved).toBeNull();
  });
});

describe("resolveCorrelationId when the recipient number is configured with a +", () => {
  it("still recognises the recipient, since WhatsApp reports the sender as plain digits", async () => {
    process.env.WHATSAPP_RECIPIENT_NUMBER = "+15551234567";
    expect(await resolveCorrelationId({ from: "15551234567", buttonId: "approve:abc123" })).toEqual({
      correlationId: "abc123",
      decision: "approve",
    });
  });
});

describe("markReplied", () => {
  it("marks a pending record as replied and removes it from the prompt index", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    const updated = await markReplied("abc123", "hello");
    expect(updated?.status).toBe("replied");
    expect(updated?.value).toBe("hello");
    expect(await resolveCorrelationId({ from: RECIPIENT })).toBeNull();
  });

  it("returns null for an already-replied record (duplicate webhook delivery)", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    await markReplied("abc123", "hello");
    expect(await markReplied("abc123", "hello again")).toBeNull();
  });

  it("lets exactly one of two concurrent deliveries win (Meta retries a webhook it thinks failed)", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    const results = await Promise.allSettled([markReplied("abc123", "hello"), markReplied("abc123", "hello")]);
    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(winners).toHaveLength(1);
  });

  it("releases its claim when storing the reply fails, so Meta's retry can still resolve it", async () => {
    await createPendingRecord("abc123", {
      type: "prompt",
      whatsappMessageId: "wamid.1",
      createdAt: Date.now(),
    });
    failNextPlainSet = true;
    await expect(markReplied("abc123", "hello")).rejects.toThrow("redis write failed");
    const retried = await markReplied("abc123", "hello");
    expect(retried?.status).toBe("replied");
  });
});

describe("markReplied claim and index cleanup", () => {
  it("fails instead of dropping the reply when another attempt holds the claim but never stored it, so Meta retries", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: Date.now() });
    store.set("replied:wamid.1", 1);
    await expect(markReplied("abc123", "hello")).rejects.toThrow(/retry/);

    store.delete("replied:wamid.1");
    expect((await markReplied("abc123", "hello"))?.status).toBe("replied");
  });

  it("still creates the record when pruning the prompt index fails, since the reply will resolve normally", async () => {
    failNextZremrange = true;
    await expect(
      createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: Date.now() })
    ).resolves.toBeUndefined();
    expect((await getPendingRecord("abc123"))?.status).toBe("pending");
  });

  it("lets a reused correlation id be answered again after an earlier send with that id was answered", async () => {
    await createPendingRecord("deploy-42", { type: "approval", whatsappMessageId: "wamid.1", createdAt: Date.now() });
    await markReplied("deploy-42", "approve");
    await createPendingRecord("deploy-42", { type: "approval", whatsappMessageId: "wamid.2", createdAt: Date.now() });
    expect((await markReplied("deploy-42", "deny"))?.value).toBe("deny");
  });

  it("holds its claim only briefly, so a crash between claiming and storing can't block Meta's retry for a day", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: Date.now() });
    await markReplied("abc123", "hello");
    const claims = [...expiries].filter(([key]) => key.startsWith("replied:"));
    expect(claims).not.toHaveLength(0);
    expect(claims.every(([, ex]) => ex <= 120)).toBe(true);
  });

  it("still returns the stored reply when removing it from the prompt index fails", async () => {
    await createPendingRecord("abc123", { type: "prompt", whatsappMessageId: "wamid.1", createdAt: Date.now() });
    failNextZrem = true;
    expect((await markReplied("abc123", "hello"))?.status).toBe("replied");
  });

  it("gives up on index entries it can't remove instead of looping forever", async () => {
    for (let i = 0; i < 30; i++) {
      zsets.set("pending-prompts", (zsets.get("pending-prompts") ?? new Map()).set(`stuck-${i}`, i));
      stuckMembers.add(`stuck-${i}`);
    }
    expect(await resolveCorrelationId({ from: RECIPIENT })).toBeNull();
  });
});

describe("pinInboundDecision", () => {
  it("pins the first decision for an inbound message and returns it to every later caller", async () => {
    expect(await pinInboundDecision("wamid.in1", "p2")).toBe("p2");
    expect(await pinInboundDecision("wamid.in1", "p1")).toBe("p2");
  });

  it("pins 'no match' too, so a redelivered message can't later match a prompt created after it", async () => {
    expect(await pinInboundDecision("wamid.in1", null)).toBeNull();
    expect(await pinInboundDecision("wamid.in1", "p-new")).toBeNull();
  });

  it("keeps decisions for different inbound messages independent", async () => {
    await pinInboundDecision("wamid.in1", "p2");
    expect(await pinInboundDecision("wamid.in2", "p1")).toBe("p1");
  });

  it("remembers a decision for days, long enough to outlast Meta's redelivery retries", async () => {
    await pinInboundDecision("wamid.in1", "p2");
    expect(expiries.get("answered:wamid.in1")).toBeGreaterThanOrEqual(60 * 60 * 24 * 2);
  });
});

describe("markReplied when the claim write is retried by the client", () => {
  it("recognises its own claim when the first attempt was applied but its response was lost", async () => {
    await createPendingRecord("a1", { type: "approval", whatsappMessageId: "wamid.a1", createdAt: Date.now() });
    loseNextNxResponse = true;
    expect((await markReplied("a1", "approve"))?.status).toBe("replied");
  });
});

describe("getPendingRecord", () => {
  it("returns null for an unknown correlation id", async () => {
    expect(await getPendingRecord("nope")).toBeNull();
  });
});

describe("createPendingRecord zset pruning", () => {
  // Must match PENDING_TTL_SECONDS in lib/correlation.ts.
  const PENDING_TTL_MS = 60 * 60 * 24 * 1000;

  it("prunes pending-prompt zset entries older than the TTL window on the next prompt write", async () => {
    const t0 = 1_000_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);

    await createPendingRecord("older", {
      type: "prompt",
      whatsappMessageId: "wamid.older",
      createdAt: t0,
    });
    expect(zsets.get("pending-prompts")?.has("older")).toBe(true);

    // Simulate enough time passing that "older" now falls outside the TTL
    // window, then write a new prompt - this should opportunistically prune it.
    nowSpy.mockReturnValue(t0 + PENDING_TTL_MS + 1000);
    await createPendingRecord("newer", {
      type: "prompt",
      whatsappMessageId: "wamid.newer",
      createdAt: t0 + PENDING_TTL_MS + 1000,
    });

    const zset = zsets.get("pending-prompts");
    expect(zset?.has("older")).toBe(false);
    expect(zset?.has("newer")).toBe(true);

    nowSpy.mockRestore();
  });
});
