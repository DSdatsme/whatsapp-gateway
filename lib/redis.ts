import { Redis } from "@upstash/redis";

const REQUEST_TIMEOUT_MS = 5_000;

export const redis = Redis.fromEnv({ signal: () => AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
