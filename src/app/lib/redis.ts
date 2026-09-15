import { createClient } from "redis";
import { env } from "../config/env.js";

export const redis = createClient({
  url: env.REDIS_URL,
  socket: { connectTimeout: 5000, reconnectStrategy: false },
});
redis.on("error", (error) => console.error("Redis error", error));

export async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis.isReady) return null;
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 60) {
  if (redis.isReady)
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
}
