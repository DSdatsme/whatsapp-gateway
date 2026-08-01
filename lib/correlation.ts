import { redis } from "@/lib/redis";
import type { PendingRecord, PendingType } from "@/lib/types";

const PENDING_TTL_SECONDS = 60 * 60 * 24;
const PENDING_PROMPTS_ZSET = "pending-prompts";

function pendingKey(correlationId: string) {
  return `pending:${correlationId}`;
}

function msgIdKey(whatsappMessageId: string) {
  return `msgid:${whatsappMessageId}`;
}

export async function createPendingRecord(
  correlationId: string,
  record: Omit<PendingRecord, "status">
): Promise<void> {
  const full: PendingRecord = { ...record, status: "pending" };
  await redis.set(pendingKey(correlationId), full, { ex: PENDING_TTL_SECONDS });

  if (record.type === "prompt") {
    await redis.set(msgIdKey(record.whatsappMessageId), correlationId, {
      ex: PENDING_TTL_SECONDS,
    });
    await redis.zadd(PENDING_PROMPTS_ZSET, { score: record.createdAt, member: correlationId });
  }
}

export async function getPendingRecord(correlationId: string): Promise<PendingRecord | null> {
  return redis.get<PendingRecord>(pendingKey(correlationId));
}

export async function markReplied(
  correlationId: string,
  value: string
): Promise<PendingRecord | null> {
  const existing = await getPendingRecord(correlationId);
  if (!existing || existing.status === "replied") return null;

  const updated: PendingRecord = {
    ...existing,
    status: "replied",
    value,
    receivedAt: Date.now(),
  };
  await redis.set(pendingKey(correlationId), updated, { ex: PENDING_TTL_SECONDS });
  await redis.zrem(PENDING_PROMPTS_ZSET, correlationId);
  return updated;
}

async function resolveMostRecentPendingPrompt(): Promise<string | null> {
  while (true) {
    const [top] = await redis.zrange<string[]>(PENDING_PROMPTS_ZSET, -1, -1);
    if (!top) return null;

    const record = await getPendingRecord(top);
    if (record && record.status === "pending") return top;

    // Stale entry (expired or already resolved) - drop and check the next one.
    await redis.zrem(PENDING_PROMPTS_ZSET, top);
  }
}

function resolveFromButton(
  buttonId: string
): { correlationId: string; decision: "approve" | "deny" } | null {
  const [decision, correlationId] = buttonId.split(":");
  if (decision !== "approve" && decision !== "deny") return null;
  if (!correlationId) return null;
  return { correlationId, decision };
}

export async function resolveCorrelationId(input: {
  buttonId?: string;
  contextMessageId?: string;
}): Promise<{ correlationId: string; decision?: "approve" | "deny" } | null> {
  if (input.buttonId) {
    return resolveFromButton(input.buttonId);
  }
  if (input.contextMessageId) {
    const correlationId = await redis.get<string>(msgIdKey(input.contextMessageId));
    return correlationId ? { correlationId } : null;
  }
  const correlationId = await resolveMostRecentPendingPrompt();
  return correlationId ? { correlationId } : null;
}
