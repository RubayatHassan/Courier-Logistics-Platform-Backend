import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../utils/http.js";
import type { AuthenticatedRequest, AuthUser } from "../utils/types.js";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
}
export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
  });
}
export function signRefreshToken(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.REFRESH_TOKEN_TTL as jwt.SignOptions["expiresIn"],
    jwtid: crypto.randomUUID(),
  });
}

export function refreshTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiry(token: string) {
  const payload = jwt.decode(token) as jwt.JwtPayload;
  if (!payload?.exp) throw new Error("Refresh token requires an expiry");
  return new Date(payload.exp * 1000);
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.max(0, refreshTokenExpiry(token).getTime() - Date.now()),
    path: "/api/v1/auth",
  });
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const token = req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return next(new AppError(401, "Authentication required"));
  let payload: AuthUser;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
    }) as AuthUser;
    if (!payload || typeof payload.id !== "string")
      throw new Error("Invalid subject");
  } catch {
    return next(new AppError(401, "Invalid or expired access token"));
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, email: true, role: true, merchantId: true },
    });
    if (!user) return next(new AppError(401, "User not found"));
    (req as AuthenticatedRequest).user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || (user.role !== "SUPER_ADMIN" && !roles.includes(user.role)))
      return next(new AppError(403, "Insufficient permissions"));
    next();
  };
}

export async function revokeRefreshTokens(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
