import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/prisma.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";
import type { AuthenticatedRequest } from "../../shared/types.js";
import { parseInput } from "../../shared/validation.js";

const createCustomerSchema = z.object({
  merchantId: z.uuid().optional(),
  name: z.string().min(2),
  phone: z.string().min(7).max(20),
  email: z.email().optional(),
});

export const customerRouter = Router();
customerRouter.use(authenticate);

customerRouter.get(
  "/",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const merchantId =
      user.role === "MERCHANT"
        ? user.merchantId
        : typeof req.query.merchantId === "string"
          ? req.query.merchantId
          : undefined;
    if (!merchantId) throw new AppError(400, "Merchant context is required");
    const customers = await prisma.customer.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, customers);
  }),
);

customerRouter.post(
  "/",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const input = parseInput(createCustomerSchema, req.body);
    const merchantId =
      user.role === "MERCHANT" ? user.merchantId : input.merchantId;
    if (!merchantId) throw new AppError(400, "Merchant context is required");
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });
    if (!merchant) throw new AppError(404, "Merchant not found");
    const existing = await prisma.customer.findUnique({
      where: { merchantId_phone: { merchantId, phone: input.phone } },
    });
    if (existing)
      throw new AppError(
        409,
        "Customer phone already exists for this merchant",
      );
    const customer = await prisma.customer.create({
      data: {
        merchantId,
        name: input.name,
        phone: input.phone,
        ...(input.email ? { email: input.email } : {}),
      },
    });
    return ok(res, customer, 201, "Customer created successfully");
  }),
);
