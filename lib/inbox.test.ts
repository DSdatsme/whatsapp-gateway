import { beforeEach, describe, expect, it, vi } from "vitest";

type Entry = { score: number; member: unknown };
const zsets = new Map<string, Map<string, Entry>>();
let failPrune = false;
let now = 2_000_000_000_000;

const DAY = 24 * 60 * 60 * 1000;
const sorted = (key: string) =>
  [...(zsets.get(key)?.values() ?? [])].sort(
    (a, b) => a.score - b.score || JSON.stringify(a.member).localeCompare(JSON.stringify(b.member))
  );

vi.mock("@/lib/redis", () => ({
  redis: {
    async zadd(key: string, opts: { nx?: boolean }, entry: Entry) {
      const members = zsets.get(key) ?? new Map<string, Entry>();
      const id = JSON.stringify(entry.member);
      if (!(opts.nx && members.has(id))) members.set(id, entry);
      zsets.set(key, members);
    },
    async zrange(key: string, min: number, max: number | string, opts?: { byScore?: boolean }) {
      if (!opts?.byScore) throw new Error("ERR value is not an integer or out of range");
      const upper = max === "+inf" ? Infinity : Number(max);
      return sorted(key).filter((e) => e.score >= min && e.score <= upper).map((e) => e.member);
    },
    async zremrangebyscore(key: string, _min: number, max: number) {
      if (failPrune) throw new Error("prune failed");
      for (const [id, e] of zsets.get(key) ?? []) if (e.score <= max) zsets.get(key)!.delete(id);
    },
    async zremrangebyrank(key: string, start: number, stop: number) {
      const all = sorted(key);
      const end = stop < 0 ? all.length + stop : stop;
      if (end < start) return;
      all.slice(start, end + 1).forEach((e) => zsets.get(key)!.delete(JSON.stringify(e.member)));
    },
    async expire() {
      return 1;
    },
  },
}));

import { addInboxMessage, listInboxMessages } from "@/lib/inbox";

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  text: `text ${id}`,
  timestamp: 1_999_999_999_000,
  ...extra,
});
const arrivesAt = async (ms: number, msg: ReturnType<typeof message>) => {
  now = ms;
  await addInboxMessage(msg);
};

beforeEach(() => {
  zsets.clear();
  failPrune = false;
  now = 2_000_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("inbox", () => {
  it("returns nothing when no messages have been recorded", async () => {
    expect(await listInboxMessages()).toEqual([]);
  });

  it("stores a message and lists it back unchanged", async () => {
    const stored = message("m1", { contextMessageId: "wamid.sent" });
    await addInboxMessage(stored);
    expect(await listInboxMessages()).toEqual([stored]);
  });

  it("lists messages oldest first by arrival", async () => {
    await arrivesAt(now + 500, message("late"));
    await arrivesAt(now - 400, message("early"));
    expect((await listInboxMessages()).map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("lists only messages that arrived at or after `since`", async () => {
    const t = now;
    await arrivesAt(t - 1000, message("before"));
    await arrivesAt(t + 800, message("after"));
    expect((await listInboxMessages({ since: t })).map((m) => m.id)).toEqual(["after"]);
  });

  it("returns the newest messages when there are more than `limit`", async () => {
    for (let i = 1; i <= 5; i++) await arrivesAt(now + 1000, message(`m${i}`));
    expect((await listInboxMessages({ limit: 2 })).map((m) => m.id)).toEqual(["m4", "m5"]);
  });

  it("keeps messages sent in the same second in arrival order, whatever their ids sort like", async () => {
    await arrivesAt(now + 1000, message("wamid.Z1"));
    await arrivesAt(now + 1000, message("wamid.A2"));
    expect((await listInboxMessages()).map((m) => m.id)).toEqual(["wamid.Z1", "wamid.A2"]);
    expect((await listInboxMessages({ limit: 1 })).map((m) => m.id)).toEqual(["wamid.A2"]);
  });

  it("does not duplicate or reorder a message Meta redelivers", async () => {
    const t = now;
    await arrivesAt(t, message("m1"));
    await arrivesAt(t + 1000, message("m2"));
    await arrivesAt(t + 5000, message("m1"));
    expect((await listInboxMessages()).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("keeps only the newest 200 messages", async () => {
    for (let i = 1; i <= 205; i++) await arrivesAt(2_000_000_000_000 + i, message(`m${i}`));
    const all = await listInboxMessages({ limit: 1000 });
    expect(all).toHaveLength(200);
    expect(all[0].id).toBe("m6");
  });

  it("still stores the message when pruning old ones fails", async () => {
    failPrune = true;
    await addInboxMessage(message("m1"));
    expect(await listInboxMessages()).toHaveLength(1);
  });

  it("never lists a message older than the retention period, even if nothing has pruned it yet", async () => {
    await arrivesAt(2_000_000_000_000, message("old"));
    now = 2_000_000_000_000 + 8 * DAY;
    expect(await listInboxMessages()).toEqual([]);
  });
});

describe("per-number inboxes", () => {
  const OTHER = "919876543210";

  it("keeps a watched number's messages out of the default list, and the recipient's out of theirs", async () => {
    await addInboxMessage(message("mine"));
    await addInboxMessage(message("theirs"), OTHER);
    expect((await listInboxMessages()).map((m) => m.id)).toEqual(["mine"]);
    expect((await listInboxMessages({ from: OTHER })).map((m) => m.id)).toEqual(["theirs"]);
  });

  it("lists nothing for a number that was never stored", async () => {
    await addInboxMessage(message("mine"));
    expect(await listInboxMessages({ from: "919999999999" })).toEqual([]);
  });

  it("keeps one person's flood from pushing out another's messages", async () => {
    await addInboxMessage(message("mine"));
    for (let i = 1; i <= 205; i++) {
      now = 2_000_000_100_000 + i;
      await addInboxMessage(message(`o${i}`), OTHER);
    }
    expect((await listInboxMessages({ limit: 1000 })).some((m) => m.id === "mine")).toBe(true);
    expect(await listInboxMessages({ from: OTHER, limit: 1000 })).toHaveLength(200);
  });
});
