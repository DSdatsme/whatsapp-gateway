import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const zsets = new Map<string, Map<string, number>>();
let fault: { match: (key: string, value: unknown) => boolean; applyFirst: boolean } | null = null;

vi.mock("@/lib/redis", () => ({
  redis: {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean }) {
      if (fault?.match(key, value)) {
        const { applyFirst } = fault;
        fault = null;
        if (applyFirst) store.set(key, value);
        throw new Error("injected redis failure");
      }
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async zadd(key: string, entry: { score: number; member: string }) {
      zsets.set(key, (zsets.get(key) ?? new Map()).set(entry.member, entry.score));
    },
    async zrange(key: string, start: number, stop: number) {
      const sorted = [...(zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1]);
      const index = (i: number) => (i < 0 ? sorted.length + i : i);
      return sorted.slice(index(start), index(stop) + 1).map(([member]) => member);
    },
    async zrem(key: string, member: string) {
      zsets.get(key)?.delete(member);
    },
    async zremrangebyscore() {
      return 0;
    },
  },
}));
vi.mock("@/lib/window", () => ({ recordInbound: vi.fn(async () => {}) }));
vi.mock("@/lib/message-status", () => ({ recordMessageStatus: vi.fn(async () => {}) }));
vi.mock("@/lib/callback", () => ({ deliverCallback: vi.fn(async () => {}) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void task(),
}));

import { POST } from "@/app/api/webhook/route";
import { createPendingRecord, getPendingRecord } from "@/lib/correlation";
import { deliverCallback } from "@/lib/callback";
import { recordInbound } from "@/lib/window";

const APP_SECRET = "test-app-secret";
const SENDER = "15551234567";

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_RECIPIENT_NUMBER = SENDER;
  store.clear();
  zsets.clear();
  fault = null;
  vi.clearAllMocks();
});

function delivery(text: string, id = "wamid.in1") {
  const raw = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id, from: SENDER, type: "text", timestamp: "1700000000", text: { body: text } }] } }] }],
  });
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  return POST(new Request("https://gateway.example/api/webhook", { method: "POST", headers: { "x-hub-signature-256": signature }, body: raw }));
}

async function twoPendingPrompts() {
  const now = Date.now();
  await createPendingRecord("p1", { type: "prompt", whatsappMessageId: "wamid.p1", createdAt: now - 2000, callbackUrl: "https://c.example/p1" });
  await createPendingRecord("p2", { type: "prompt", whatsappMessageId: "wamid.p2", createdAt: now - 1000, callbackUrl: "https://c.example/p2" });
}

describe("webhook redelivery with the real correlation code", () => {
  const expectOnlyP2Answered = async () => {
    expect((await getPendingRecord("p2"))?.status).toBe("replied");
    expect((await getPendingRecord("p1"))?.status).toBe("pending");
  };

  it("does not answer a second pending prompt when Meta redelivers a text after a later write failed", async () => {
    await twoPendingPrompts();
    vi.mocked(recordInbound).mockRejectedValueOnce(new Error("redis blip"));

    await expect(delivery("release-7")).rejects.toThrow("redis blip");
    expect((await delivery("release-7")).status).toBe(200);

    await expectOnlyP2Answered();
    expect(deliverCallback).toHaveBeenCalledTimes(1);
    expect(deliverCallback).toHaveBeenCalledWith("https://c.example/p2", { correlationId: "p2", value: "release-7" });
  });

  it("answers only the pinned prompt when the decision write fails and Meta redelivers", async () => {
    await twoPendingPrompts();
    fault = { match: (key) => key.startsWith("answered:"), applyFirst: false };

    await expect(delivery("release-7")).rejects.toThrow("injected");
    expect((await delivery("release-7")).status).toBe(200);

    await expectOnlyP2Answered();
    expect(deliverCallback).toHaveBeenCalledTimes(1);
  });

  it("answers only one prompt when storing the reply was applied but reported as failed", async () => {
    await twoPendingPrompts();
    fault = { match: (key, value) => key === "pending:p2" && (value as { status?: string }).status === "replied", applyFirst: true };

    await expect(delivery("release-7")).rejects.toThrow("injected");
    expect((await delivery("release-7")).status).toBe(200);

    await expectOnlyP2Answered();
  });

  it("answers only one prompt when the same message is delivered twice at once", async () => {
    await twoPendingPrompts();

    await Promise.allSettled([delivery("release-7"), delivery("release-7")]);
    await delivery("release-7");

    await expectOnlyP2Answered();
  });

  it("does not let a redelivered chat message answer a prompt created after it was sent", async () => {
    vi.mocked(recordInbound).mockRejectedValueOnce(new Error("redis blip"));
    await expect(delivery("lol ok", "wamid.chat")).rejects.toThrow("redis blip");

    await createPendingRecord("p-new", { type: "prompt", whatsappMessageId: "wamid.new", createdAt: Date.now(), callbackUrl: "https://c.example/new" });
    expect((await delivery("lol ok", "wamid.chat")).status).toBe(200);

    expect((await getPendingRecord("p-new"))?.status).toBe("pending");
    expect(deliverCallback).not.toHaveBeenCalled();
  });

  it("still answers the next prompt for a genuinely new message", async () => {
    await twoPendingPrompts();
    await delivery("first", "wamid.in1");
    await delivery("second", "wamid.in2");

    expect((await getPendingRecord("p2"))?.value).toBe("first");
    expect((await getPendingRecord("p1"))?.value).toBe("second");
  });
});
