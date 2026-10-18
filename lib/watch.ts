import { redis } from "@/lib/redis";

const WATCH_SECONDS = 60 * 60 * 24 * 7;

function watchKey(number: string) {
  return `watch:${number}`;
}

export async function watchNumber(number: string): Promise<void> {
  await redis.set(watchKey(number), 1, { ex: WATCH_SECONDS });
}

export async function isWatched(number: string): Promise<boolean> {
  return (await redis.get(watchKey(number))) !== null;
}
