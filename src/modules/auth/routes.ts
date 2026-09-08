import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import type { Request, Response } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { Role } from "../../generated/prisma/client.js";
import {
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "../../infrastructure/mail.js";
import { prisma } from "../../infrastructure/prisma.js";
import {
  cacheGet,
  cacheSet,
  connectRedis,
  redis,
} from "../../infrastructure/redis.js";
import {
  authenticate,
  authorize,
  hashPassword,
  revokeRefreshTokens,
  setRefreshCookie,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
} from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";
import type { AuthenticatedRequest } from "../../shared/types.js";
import { parseInput } from "../../shared/validation.js";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");
const emailSchema = z.email().transform((value) => value.trim().toLowerCase());
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(2),
  phone: z.string().optional(),
  merchantName: z.string().min(2).optional(),
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});
const googleSchema = z.object({ credential: z.string().min(20) });
const adminCreateSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(2),
});
const profileUpdateSchema = z
  .object({
    name: z.string().min(2).optional(),
    phone: z.string().min(7).max(20).nullable().optional(),
  })
  .refine((input) => input.name !== undefined || input.phone !== undefined, {
    message: "At least one profile field is required",
  });
const emailActionSchema = z
  .object({
    email: emailSchema.optional(),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    token: z.string().min(20).optional(),
  })
  .refine(
    (input) => input.code || input.token,
    "A verification code or token is required",
  );
const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z
  .object({
    password: passwordSchema,
    email: emailSchema.optional(),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    token: z.string().min(20).optional(),
  })
  .refine(
    (input) => input.code || input.token,
    "A reset code or token is required",
  );
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
const profileView = (user: {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  merchantId: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  phone: user.phone,
  role: user.role,
  merchantId: user.merchantId,
  emailVerifiedAt: user.emailVerifiedAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export const authRouter = Router();
authRouter.use(cookieParser());

authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const profile = await prisma.user.findUnique({ where: { id: user.id } });
    if (!profile) throw new AppError(404, "User profile not found");
    return ok(res, profileView(profile));
  }),
);

authRouter.patch(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const input = parseInput(profileUpdateSchema, req.body);
    const profile = await prisma.user.update({
      where: { id: user.id },
      data: input,
    });
    return ok(res, profileView(profile));
  }),
);

authRouter.post(
  "/admins",
  authenticate,
  authorize("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const input = parseInput(adminCreateSchema, req.body);
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "Email already registered");
    const admin = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: "ADMIN",
        emailVerifiedAt: new Date(),
      },
    });
    return ok(res, publicUser(admin), 201, "Admin created successfully");
  }),
);

const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");
const generateCode = () => crypto.randomInt(100000, 1000000).toString();

type PendingRegistration = {
  email: string;
  name: string;
  phone?: string;
  merchantName?: string;
  passwordHash: string;
  codeHash: string;
  tokenHash: string;
};

const pendingKey = (email: string) =>
  `pending-registration:${email.toLowerCase()}`;
const pendingTokenKey = (tokenHash: string) =>
  `pending-registration-token:${tokenHash}`;

async function issueVerificationEmail(input: {
  email: string;
  name: string;
  phone?: string;
  merchantName?: string;
  passwordHash: string;
}) {
  await connectRedis();
  const token = crypto.randomBytes(32).toString("hex");
  const code = generateCode();
  const tokenHash = hashToken(token);
  const pending: PendingRegistration = {
    ...input,
    codeHash: await hashPassword(code),
    tokenHash,
  };
  await cacheSet(pendingKey(input.email), pending, 15 * 60);
  await cacheSet(
    pendingTokenKey(tokenHash),
    input.email.toLowerCase(),
    15 * 60,
  );
  const message = verificationEmail(input.name, code, token);
  await sendEmail(input.email, message.subject, message.html);
}

async function issuePasswordResetEmail(user: {
  id: string;
  name: string;
  email: string;
}) {
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, consumedAt: null },
  });
  const token = crypto.randomBytes(32).toString("hex");
  const code = generateCode();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      codeHash: await hashPassword(code),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  const message = passwordResetEmail(user.name, code, token);
  await sendEmail(user.email, message.subject, message.html);
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "Email already registered");
    await issueVerificationEmail({
      email: input.email,
      name: input.name,
      phone: input.phone,
      merchantName: input.merchantName,
      passwordHash: await hashPassword(input.password),
    });
    return ok(
      res,
      {
        emailVerificationRequired: true,
        message:
          "Check your email to verify your account. The account will be created after verification.",
      },
      201,
    );
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (!user || !(await verifyPassword(input.password, user.passwordHash)))
      throw new AppError(401, "Invalid email or password");
    if (!user.emailVerifiedAt)
      throw new AppError(403, "Please verify your email before logging in");
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
  "/google",
  asyncHandler(async (req, res) => {
    const input = parseInput(googleSchema, req.body);
    if (!env.GOOGLE_CLIENT_ID)
      throw new AppError(503, "Google login is not configured");
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.credential)}`,
    );
    if (!response.ok) throw new AppError(401, "Invalid Google credential");
    const profile = (await response.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      aud?: string;
      email_verified?: string;
    };
    if (
      !profile.sub ||
      !profile.email ||
      profile.aud !== env.GOOGLE_CLIENT_ID ||
      profile.email_verified !== "true"
    )
      throw new AppError(401, "Google account could not be verified");
    const googleId = profile.sub;
    const email = profile.email.toLowerCase();
    const existingGoogleUser = await prisma.user.findUnique({
      where: { googleId },
    });
    const existingEmailUser = existingGoogleUser
      ? null
      : await prisma.user.findUnique({ where: { email } });
    const user = existingGoogleUser
      ? await prisma.user.update({
          where: { id: existingGoogleUser.id },
          data: {
            ...(profile.name ? { name: profile.name } : {}),
            emailVerifiedAt: new Date(),
          },
        })
      : existingEmailUser
        ? await prisma.user.update({
            where: { id: existingEmailUser.id },
            data: {
              googleId,
              ...(profile.name ? { name: profile.name } : {}),
              emailVerifiedAt: new Date(),
            },
          })
        : await prisma.user.create({
            data: {
              googleId,
              email,
              name: profile.name ?? email.split("@")[0] ?? "Google user",
              passwordHash: await hashPassword(
                crypto.randomBytes(32).toString("hex"),
              ),
              role: "CUSTOMER",
              emailVerifiedAt: new Date(),
            },
          });
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

async function verifyEmailAction(req: Request, res: Response) {
  await connectRedis();
  const input = emailActionSchema.parse(
    req.method === "GET" ? req.query : req.body,
  );
  let email = input.email?.toLowerCase();
  if (input.token)
    email =
      (await cacheGet<string>(pendingTokenKey(hashToken(input.token)))) ??
      undefined;
  if (!email)
    throw new AppError(400, "Invalid or expired verification code/link");
  const pending = await cacheGet<PendingRegistration>(pendingKey(email));
  if (!pending || (input.token && pending.tokenHash !== hashToken(input.token)))
    throw new AppError(400, "Invalid or expired verification code/link");
  if (input.code && !(await verifyPassword(input.code, pending.codeHash)))
    throw new AppError(400, "Invalid or expired verification code/link");
  const existing = await prisma.user.findUnique({
    where: { email: pending.email },
  });
  if (existing) {
    await redis.del(pendingKey(email));
    await redis.del(pendingTokenKey(pending.tokenHash));
    throw new AppError(409, "Email already registered");
  }
  const user = await prisma.$transaction(async (tx) => {
    let merchantId: string | undefined;
    if (pending.merchantName) {
      const merchant = await tx.merchant.create({
        data: {
          name: pending.merchantName,
          slug: `${pending.merchantName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
          email: pending.email,
          phone: pending.phone,
        },
      });
      merchantId = merchant.id;
    }
    return tx.user.create({
      data: {
        email: pending.email,
        name: pending.name,
        phone: pending.phone,
        passwordHash: pending.passwordHash,
        role: merchantId ? "MERCHANT" : "CUSTOMER",
        merchantId,
        emailVerifiedAt: new Date(),
      },
    });
  });
  await redis.del(pendingKey(email));
  await redis.del(pendingTokenKey(pending.tokenHash));
  return ok(res, {
    verified: true,
    user: publicUser(user),
    message:
      "Email verified and account created successfully. You can now log in.",
  });
}

authRouter.post("/verify-email", asyncHandler(verifyEmailAction));
authRouter.get("/verify-email", asyncHandler(verifyEmailAction));
authRouter.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const input = forgotSchema.parse(req.body);
    const pending = await cacheGet<PendingRegistration>(
      pendingKey(input.email),
    );
    if (pending) await issueVerificationEmail(pending);
    return ok(res, {
      message:
        "If the account exists and is unverified, a verification email has been sent.",
    });
  }),
);

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const input = forgotSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (user?.emailVerifiedAt) await issuePasswordResetEmail(user);
    return ok(res, {
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  }),
);

async function resetPasswordAction(req: Request, res: Response) {
  const input = resetSchema.parse(req.method === "GET" ? req.query : req.body);
  let record: { id: string; userId: string } | null = null;
  if (input.token)
    record = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: hashToken(input.token),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });
  else if (input.email && input.code) {
    const user = await prisma.user.findFirst({
      where: { email: input.email, emailVerifiedAt: { not: null } },
    });
    const candidates = user
      ? await prisma.passwordResetToken.findMany({
          where: {
            userId: user.id,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
        })
      : [];
    const code = input.code;
    const match = code
      ? (
          await Promise.all(
            candidates.map(async (candidate) =>
              (await verifyPassword(code, candidate.codeHash))
                ? candidate
                : null,
            ),
          )
        ).find(Boolean)
      : null;
    if (match) record = { id: match.id, userId: match.userId };
  }
  if (!record)
    throw new AppError(400, "Invalid or expired password reset code/link");
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new AppError(400, "Invalid or expired password reset code/link");
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(input.password) },
    });
    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  return ok(res, {
    passwordReset: true,
    message: "Password changed successfully. Please log in again.",
  });
}

authRouter.post("/reset-password", asyncHandler(resetPasswordAction));
authRouter.get(
  "/reset-password",
  asyncHandler(async (req, res) =>
    ok(res, {
      message: "Submit this token with a new password to reset your password.",
      token: req.query.token,
    }),
  ),
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
        const p = jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub?: string };
        if (p?.sub) await revokeRefreshTokens(p.sub);
      } catch {}
    }
    res.clearCookie("refreshToken", { path: "/api/v1/auth" });
    return ok(res, { loggedOut: true });
  }),
);
