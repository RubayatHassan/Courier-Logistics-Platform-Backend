import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { Role } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/prisma.js";
import {
  hashPassword,
  revokeRefreshTokens,
  setRefreshCookie,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
} from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().min(2),
  phone: z.string().optional(),
  merchantName: z.string().min(2).optional(),
});
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
const publicUser = (user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  merchantId: string | null;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  merchantId: user.merchantId,
});

export const authRouter = Router();
authRouter.use(cookieParser());

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "Email already registered");
    const user = await prisma.$transaction(async (tx) => {
      let merchantId: string | undefined;
      if (input.merchantName) {
        const merchant = await tx.merchant.create({
          data: {
            name: input.merchantName,
            slug: `${input.merchantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
            email: input.email,
            phone: input.phone,
          },
        });
        merchantId = merchant.id;
      }
      return tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          phone: input.phone,
          passwordHash: await hashPassword(input.password),
          role: merchantId ? "MERCHANT" : "CUSTOMER",
          merchantId,
        },
      });
    });
    const authUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      merchantId: user.merchantId,
    };
    const refreshToken = signRefreshToken(user.id);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: await hashPassword(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    setRefreshCookie(res, refreshToken);
    return ok(
      res,
      { user: publicUser(user), accessToken: signAccessToken(authUser) },
      201,
    );
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (!user || !(await verifyPassword(input.password, user.passwordHash)))
      throw new AppError(401, "Invalid email or password");
    const refreshToken = signRefreshToken(user.id);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: await hashPassword(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    setRefreshCookie(res, refreshToken);
    return ok(res, {
      user: publicUser(user),
      accessToken: signAccessToken({
        id: user.id,
        email: user.email,
        role: user.role,
        merchantId: user.merchantId,
      }),
    });
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) throw new AppError(401, "Refresh token required");
    let payload: { sub?: string };
    try {
      payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub?: string };
    } catch {
      throw new AppError(401, "Invalid refresh token");
    }
    if (!payload.sub) throw new AppError(401, "Invalid refresh token");
    const tokens = await prisma.refreshToken.findMany({
      where: {
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    const valid = await Promise.all(
      tokens.map(async (item) =>
        (await verifyPassword(token, item.tokenHash)) ? item : null,
      ),
    );
    const found = valid.find(Boolean);
    if (!found) throw new AppError(401, "Refresh token revoked or expired");
    await prisma.refreshToken.update({
      where: { id: (found as { id: string }).id },
      data: { revokedAt: new Date() },
    });
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new AppError(401, "User not found");
    const refreshToken = signRefreshToken(user.id);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: await hashPassword(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    setRefreshCookie(res, refreshToken);
    return ok(res, {
      accessToken: signAccessToken({
        id: user.id,
        email: user.email,
        role: user.role,
        merchantId: user.merchantId,
      }),
    });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.refreshToken as string | undefined;
    if (token) {
      try {
        const p = jwt.decode(token) as { sub?: string } | null;
        if (p?.sub) await revokeRefreshTokens(p.sub);
      } catch {}
    }
    res.clearCookie("refreshToken", { path: "/api/v1/auth" });
    return ok(res, { loggedOut: true });
  }),
);
