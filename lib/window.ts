import { redis } from "@/lib/redis";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

const INBOUND_KEY = "window:inbound";
const INBOUND_MEMBER = "last";

export interface WindowState {
  open: boolean;
  lastInboundAt: number | null;
  expiresAt: number | null;
}

export async function recordInbound(at: number): Promise<void> {
  await redis.zadd(INBOUND_KEY, { gt: true }, { score: Math.min(at, Date.now()), member: INBOUND_MEMBER });
}

export async function getWindowState(now: number = Date.now()): Promise<WindowState> {
  const lastInboundAt = await redis.zscore(INBOUND_KEY, INBOUND_MEMBER);
  if (lastInboundAt === null) return { open: false, lastInboundAt: null, expiresAt: null };

  const expiresAt = lastInboundAt + WINDOW_MS;
  return { open: now < expiresAt, lastInboundAt, expiresAt };
}
