import { redis } from "@/lib/redis";

const INBOX_KEY = "inbox";
const RETENTION_SECONDS = 60 * 60 * 24 * 7;
const MAX_MESSAGES = 200;

export interface InboxMessage {
  id: string;
  type: string;
  text?: string;
  timestamp: number;
  contextMessageId?: string;
}

// The recipient's messages and each watched number's messages live under separate keys, so none can crowd out another.
function inboxKey(from?: string) {
  return from ? `${INBOX_KEY}:${from}` : INBOX_KEY;
}

// Scored by arrival time: Meta's timestamps are whole seconds, so same-second messages would sort by member text.
// NX keeps a redelivered message at its first position.
export async function addInboxMessage(message: InboxMessage, from?: string): Promise<void> {
  const key = inboxKey(from);
  await redis.zadd(key, { nx: true }, { score: Date.now(), member: message });
  await redis.expire(key, RETENTION_SECONDS);
  await Promise.all([
    redis.zremrangebyscore(key, 0, Date.now() - RETENTION_SECONDS * 1000),
    redis.zremrangebyrank(key, 0, -(MAX_MESSAGES + 1)),
  ]).catch(() => {});
}

export async function listInboxMessages({
  since = 0,
  limit = 50,
  from,
}: { since?: number; limit?: number; from?: string } = {}): Promise<InboxMessage[]> {
  const earliest = Math.max(since, Date.now() - RETENTION_SECONDS * 1000);
  const messages = await redis.zrange<InboxMessage[]>(inboxKey(from), earliest, "+inf", { byScore: true });
  return messages.slice(-limit);
}
