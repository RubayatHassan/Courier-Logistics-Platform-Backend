import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { Role } from "../generated/prisma/client.js";
import { prisma } from "../infrastructure/prisma.js";
import { AppError } from "../shared/http.js";
import type { AuthenticatedRequest, AuthUser } from "../shared/types.js";

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
  });
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/api/v1/auth",
  });
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new AppError(401, "Authentication required"));
  try {
    (req as AuthenticatedRequest).user = jwt.verify(
      token,
      env.JWT_ACCESS_SECRET,
    ) as AuthUser;
    next();
  } catch {
    next(new AppError(401, "Invalid or expired access token"));
  }
}

export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !roles.includes(user.role))
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
