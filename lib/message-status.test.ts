import { beforeEach, describe, expect, it, vi } from "vitest";

const hashes = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/redis", () => ({
  redis: {
    async hset(key: string, fields: Record<string, unknown>) {
      hashes.set(key, { ...hashes.get(key), ...fields });
      return Object.keys(fields).length;
    },
    async hgetall(key: string) {
      return hashes.get(key) ?? null;
    },
    async expire() {
      return 1;
    },
  },
}));

import { getMessageStatus, recordMessageStatus } from "@/lib/message-status";

beforeEach(() => {
  hashes.clear();
});

describe("recordMessageStatus / getMessageStatus", () => {
  it("returns null for a message id that has no status yet", async () => {
    expect(await getMessageStatus("wamid.nope")).toBeNull();
  });

  it("stores a status and reads it back", async () => {
    await recordMessageStatus({ messageId: "wamid.1", status: "sent", timestamp: 1000, recipient: "15551234567" });
    expect(await getMessageStatus("wamid.1")).toEqual({
      messageId: "wamid.1",
      status: "sent",
      updatedAt: 1000,
      recipient: "15551234567",
    });
  });

  it("moves forward through sent -> delivered -> read", async () => {
    await recordMessageStatus({ messageId: "wamid.1", status: "sent", timestamp: 1000 });
    await recordMessageStatus({ messageId: "wamid.1", status: "delivered", timestamp: 2000 });
    await recordMessageStatus({ messageId: "wamid.1", status: "read", timestamp: 3000 });
    expect((await getMessageStatus("wamid.1"))?.status).toBe("read");
  });

  it("does not let a late 'sent' overwrite 'delivered' (Meta delivers statuses out of order)", async () => {
    await recordMessageStatus({ messageId: "wamid.1", status: "delivered", timestamp: 2000 });
    await recordMessageStatus({ messageId: "wamid.1", status: "sent", timestamp: 1000 });
    const record = await getMessageStatus("wamid.1");
    expect(record?.status).toBe("delivered");
    expect(record?.updatedAt).toBe(2000);
  });

  it("keeps Meta's error code, title and details for a failed message", async () => {
    await recordMessageStatus({
      messageId: "wamid.1",
      status: "failed",
      timestamp: 1000,
      error: { code: 131047, title: "Re-engagement message", details: "more than 24 hours have passed" },
    });
    expect(await getMessageStatus("wamid.1")).toMatchObject({
      status: "failed",
      error: { code: 131047, title: "Re-engagement message", details: "more than 24 hours have passed" },
    });
  });

  it("does not let a late 'sent' overwrite 'failed'", async () => {
    await recordMessageStatus({ messageId: "wamid.1", status: "failed", timestamp: 2000, error: { code: 131047 } });
    await recordMessageStatus({ messageId: "wamid.1", status: "sent", timestamp: 1000 });
    expect((await getMessageStatus("wamid.1"))?.status).toBe("failed");
  });

  it("ends at the highest status when updates are processed concurrently, in any order", async () => {
    await Promise.all([
      recordMessageStatus({ messageId: "wamid.1", status: "read", timestamp: 3000 }),
      recordMessageStatus({ messageId: "wamid.1", status: "delivered", timestamp: 2000 }),
      recordMessageStatus({ messageId: "wamid.1", status: "sent", timestamp: 1000 }),
    ]);
    expect((await getMessageStatus("wamid.1"))?.status).toBe("read");
  });

  it("ignores a status value it doesn't know about", async () => {
    await recordMessageStatus({ messageId: "wamid.1", status: "deleted", timestamp: 1000 });
    expect(await getMessageStatus("wamid.1")).toBeNull();
  });

  it("falls back to the current time when Meta sends no timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5000);
    await recordMessageStatus({ messageId: "wamid.1", status: "sent" });
    expect((await getMessageStatus("wamid.1"))?.updatedAt).toBe(5000);
    nowSpy.mockRestore();
  });
});
