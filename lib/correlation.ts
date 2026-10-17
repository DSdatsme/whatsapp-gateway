import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";
import { getRequiredEnv } from "@/lib/env";
import type { PendingRecord } from "@/lib/types";

const PENDING_TTL_SECONDS = 60 * 60 * 24;
const CLAIM_TTL_SECONDS = 60;
const ANSWERED_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_STALE_PROMPT_SKIPS = 20;
const PENDING_PROMPTS_ZSET = "pending-prompts";

function pendingKey(correlationId: string) {
  return `pending:${correlationId}`;
}

function msgIdKey(whatsappMessageId: string) {
  return `msgid:${whatsappMessageId}`;
}

function answeredKey(inboundMessageId: string) {
  return `answered:${inboundMessageId}`;
}

function repliedClaimKey(whatsappMessageId: string) {
  return `replied:${whatsappMessageId}`;
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
    await redis
      .zremrangebyscore(PENDING_PROMPTS_ZSET, 0, Date.now() - PENDING_TTL_SECONDS * 1000)
      .catch(() => {});
  }
}

export async function pinInboundDecision(
  inboundMessageId: string,
  correlationId: string | null
): Promise<string | null> {
  const key = answeredKey(inboundMessageId);
  if (await redis.set(key, { correlationId }, { nx: true, ex: ANSWERED_TTL_SECONDS })) return correlationId;

  const pinned = await redis.get<{ correlationId: string | null }>(key);
  return pinned ? pinned.correlationId : correlationId;
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

  // Meta can deliver the same reply twice at once; only one caller wins the NX claim.
  const claimKey = repliedClaimKey(existing.whatsappMessageId);
  const token = randomUUID();
  const claimed = await redis.set(claimKey, token, { nx: true, ex: CLAIM_TTL_SECONDS });
  // The Redis client retries a request whose response was lost, so a null may be our own earlier attempt.
  if (!claimed && (await redis.get(claimKey)) !== token) {
    // An attempt that claimed but never stored must not swallow the reply: fail so Meta retries.
    if ((await getPendingRecord(correlationId))?.status === "pending") {
      throw new Error(`reply for ${correlationId} is held by another attempt, retry`);
    }
    return null;
  }

  const updated: PendingRecord = {
    ...existing,
    status: "replied",
    value,
    receivedAt: Date.now(),
  };
  try {
    await redis.set(pendingKey(correlationId), updated, { ex: PENDING_TTL_SECONDS });
  } catch (err) {
    // Release the claim so Meta's retry of this webhook can still store the reply.
    await redis.del(claimKey).catch(() => {});
    throw err;
  }
  await redis.zrem(PENDING_PROMPTS_ZSET, correlationId).catch(() => {});
  return updated;
}

async function resolveMostRecentPendingPrompt(): Promise<string | null> {
  for (let skipped = 0; skipped < MAX_STALE_PROMPT_SKIPS; skipped++) {
    const [top] = await redis.zrange<string[]>(PENDING_PROMPTS_ZSET, -1, -1);
    if (!top) return null;

    const record = await getPendingRecord(top);
    if (record && record.status === "pending") return top;

    // Stale entry (expired or already resolved) - drop and check the next one.
    console.log(`[correlation] dropping stale pending-prompt entry: ${top}`);
    await redis.zrem(PENDING_PROMPTS_ZSET, top);
  }
  return null;
}

function resolveFromButton(
  buttonId: string
): { correlationId: string; decision: "approve" | "deny" } | null {
  const separatorIndex = buttonId.indexOf(":");
  if (separatorIndex === -1) return null;
  const decision = buttonId.slice(0, separatorIndex);
  const correlationId = buttonId.slice(separatorIndex + 1);
  if (decision !== "approve" && decision !== "deny") return null;
  if (!correlationId) return null;
  return { correlationId, decision };
}

function resolveFromListReply(
  listReplyId: string
): { correlationId: string; selectedIndex: number } | null {
  const separatorIndex = listReplyId.lastIndexOf(":");
  if (separatorIndex === -1) return null;
  const correlationId = listReplyId.slice(0, separatorIndex);
  const indexPart = listReplyId.slice(separatorIndex + 1);
  if (!correlationId || !/^\d+$/.test(indexPart)) return null;
  return { correlationId, selectedIndex: Number(indexPart) };
}

export async function resolveCorrelationId(input: {
  from: string;
  buttonId?: string;
  contextMessageId?: string;
  listReplyId?: string;
}): Promise<
  { correlationId: string; decision?: "approve" | "deny"; selectedIndex?: number } | null
> {
  // Meta's HMAC signature only proves the webhook call came from Meta's relay,
  // not that the underlying WhatsApp message came from the intended recipient.
  // Anyone can text the business number, so replies must be sender-checked here.
  if (input.from !== getRequiredEnv("WHATSAPP_RECIPIENT_NUMBER")) {
    return null;
  }
  if (input.buttonId) {
    return resolveFromButton(input.buttonId);
  }
  if (input.listReplyId) {
    return resolveFromListReply(input.listReplyId);
  }
  if (input.contextMessageId) {
    const correlationId = await redis.get<string>(msgIdKey(input.contextMessageId));
    return correlationId ? { correlationId } : null;
  }
  const correlationId = await resolveMostRecentPendingPrompt();
  return correlationId ? { correlationId } : null;
}
