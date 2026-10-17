import { redis } from "@/lib/redis";

const STATUS_TTL_SECONDS = 60 * 60 * 24;

const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 } as const;

export type DeliveryStatus = keyof typeof STATUS_RANK;

interface StatusEntry {
  updatedAt: number;
  recipient?: string;
  error?: { code?: number; title?: string; details?: string };
}

export interface MessageStatusRecord extends StatusEntry {
  messageId: string;
  status: DeliveryStatus;
}

// One hash field per status: concurrent or out-of-order webhooks can't overwrite each other, and the highest rank wins on read.
function statusKey(messageId: string) {
  return `msgstatus:${messageId}`;
}

function isDeliveryStatus(status: string): status is DeliveryStatus {
  return Object.hasOwn(STATUS_RANK, status);
}

export async function recordMessageStatus(update: {
  messageId: string;
  status: string;
  timestamp?: number;
  recipient?: string;
  error?: StatusEntry["error"];
}): Promise<void> {
  if (!isDeliveryStatus(update.status)) return;

  const entry: StatusEntry = {
    updatedAt: update.timestamp ?? Date.now(),
    ...(update.recipient ? { recipient: update.recipient } : {}),
    ...(update.error ? { error: update.error } : {}),
  };
  await redis.hset(statusKey(update.messageId), { [update.status]: entry });
  await redis.expire(statusKey(update.messageId), STATUS_TTL_SECONDS);
}

export async function getMessageStatus(messageId: string): Promise<MessageStatusRecord | null> {
  const entries = await redis.hgetall<Record<string, StatusEntry>>(statusKey(messageId));
  const status = Object.keys(entries ?? {})
    .filter(isDeliveryStatus)
    .sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0];
  return status ? { messageId, status, ...entries![status] } : null;
}
