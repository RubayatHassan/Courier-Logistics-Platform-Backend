import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { connectRedis, redis } from "../lib/redis.js";
import { AppError } from "../utils/http.js";

const sensitive = new Set([
  "/register",
  "/login",
  "/google",
  "/verify-email",
  "/resend-verification",
  "/forgot-password",
  "/reset-password",
  "/refresh",
]);
const increment = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n`;

export const authRateLimit: RequestHandler = async (req, res, next) => {
  if (
    !sensitive.has(req.path) ||
    (req.method !== "POST" && req.path !== "/verify-email")
  )
    return next();
  try {
    await connectRedis();
    const window = 600;
    const input = req.method === "GET" ? req.query : req.body;
    const account =
      typeof input?.email === "string"
        ? input.email.trim().toLowerCase()
        : undefined;
    const keys = [
      { value: `ip:${req.ip ?? req.socket.remoteAddress}`, limit: 60 },
    ];
    if (account)
      keys.push({
        value: `account:${account}`,
        limit: ["/verify-email", "/reset-password"].includes(req.path) ? 5 : 15,
      });
    for (const item of keys) {
      const hash = crypto.createHash("sha256").update(item.value).digest("hex");
      const count = Number(
        await redis.eval(increment, {
          keys: [`auth-rate:${req.path}:${hash}`],
          arguments: [String(window)],
        }),
      );
      if (count > item.limit) {
        res.setHeader("Retry-After", window);
        return next(new AppError(429, "Too many attempts; try again later"));
      }
    }
    next();
  } catch {
    next(
      new AppError(503, "Authentication protection is temporarily unavailable"),
    );
  }
};
