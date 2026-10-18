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

// Scored by arrival time: Meta's timestamps are whole seconds, so same-second messages would sort by member text.
// NX keeps a redelivered message at its first position.
export async function addInboxMessage(message: InboxMessage): Promise<void> {
  await redis.zadd(INBOX_KEY, { nx: true }, { score: Date.now(), member: message });
  await redis.expire(INBOX_KEY, RETENTION_SECONDS);
  await Promise.all([
    redis.zremrangebyscore(INBOX_KEY, 0, Date.now() - RETENTION_SECONDS * 1000),
    redis.zremrangebyrank(INBOX_KEY, 0, -(MAX_MESSAGES + 1)),
  ]).catch(() => {});
}

export async function listInboxMessages({ since = 0, limit = 50 } = {}): Promise<InboxMessage[]> {
  const from = Math.max(since, Date.now() - RETENTION_SECONDS * 1000);
  const messages = await redis.zrange<InboxMessage[]>(INBOX_KEY, from, "+inf", { byScore: true });
  return messages.slice(-limit);
}
