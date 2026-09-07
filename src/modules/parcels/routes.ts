import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/prisma.js";
import { cacheGet, cacheSet } from "../../infrastructure/redis.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";
import type { AuthenticatedRequest } from "../../shared/types.js";
import { parseInput } from "../../shared/validation.js";
import { createParcel, transitionParcel } from "./service.js";

const createSchema = z.object({
  customerId: z.uuid(),
  pickupAddress: z.string().min(5),
  deliveryAddress: z.string().min(5),
  weightGrams: z.number().int().positive(),
  codAmount: z.number().nonnegative().default(0),
  description: z.string().optional(),
});
const statusSchema = z.object({
  status: z.enum([
    "PICKUP_ASSIGNED",
    "PICKED_UP",
    "AT_HUB",
    "SORTING",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "DELIVERY_FAILED",
    "RESCHEDULED",
    "CANCELLED",
    "RETURNED",
    "LOST_DAMAGED",
  ]),
  note: z.string().optional(),
});
const parcelStatusQuery = z.enum([
  "CREATED",
  "PICKUP_ASSIGNED",
  "PICKED_UP",
  "AT_HUB",
  "SORTING",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RESCHEDULED",
  "CANCELLED",
  "RETURNED",
  "LOST_DAMAGED",
]);
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: parcelStatusQuery.optional(),
});
export const parcelRouter = Router();

parcelRouter.get(
  "/track/:trackingNumber",
  asyncHandler(async (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    if (typeof trackingNumber !== "string")
      throw new AppError(400, "Tracking number is required");
    const key = `tracking:${trackingNumber}`;
    const cached = await cacheGet(key);
    if (cached) return ok(res, cached);
    const parcel = await prisma.parcel.findUnique({
      where: { trackingNumber },
      select: {
        trackingNumber: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        trackingEvents: {
          orderBy: { createdAt: "asc" },
          select: { status: true, note: true, location: true, createdAt: true },
        },
      },
    });
    if (!parcel) throw new AppError(404, "Tracking number not found");
    await cacheSet(key, parcel, 30);
    return ok(res, parcel);
  }),
);

parcelRouter.use(authenticate);
parcelRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const { page, limit, status } = parseInput(listQuerySchema, req.query);
    const roleScope =
      user.role === "ADMIN" || user.role === "SUPER_ADMIN"
        ? {}
        : user.role === "MERCHANT" && user.merchantId
          ? { merchantId: user.merchantId }
          : user.role === "RIDER"
            ? { assignments: { some: { rider: { userId: user.id } } } }
            : user.role === "HUB_MANAGER"
              ? {
                  currentHub: {
                    branch: { userBranches: { some: { userId: user.id } } },
                  },
                }
              : { id: "__no_access__" };
    const where = { ...roleScope, ...(status ? { status } : {}) };
    const [items, total] = await prisma.$transaction([
      prisma.parcel.findMany({
        where,
        include: { customer: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.parcel.count({ where }),
    ]);
    return ok(res, {
      items,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }),
);

parcelRouter.post(
  "/",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    if (!user.merchantId) throw new AppError(400, "Merchant context required");
    const input = parseInput(createSchema, req.body);
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, merchantId: user.merchantId },
    });
    if (!customer) throw new AppError(404, "Customer not found");
    return ok(
      res,
      await createParcel({
        ...input,
        merchantId: user.merchantId,
        idempotencyKey: req.header("idempotency-key") ?? undefined,
      }),
      201,
    );
  }),
);

parcelRouter.patch(
  "/:id/status",
  authorize("ADMIN", "MERCHANT", "HUB_MANAGER", "RIDER"),
  asyncHandler(async (req, res) => {
    const input = statusSchema.parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const parcelId = req.params.id;
    if (typeof parcelId !== "string")
      throw new AppError(400, "Parcel id is required");
    if (user.role === "MERCHANT" && !user.merchantId)
      throw new AppError(403, "Merchant context required");
    return ok(
      res,
      await transitionParcel(
        parcelId,
        user.role === "ADMIN" ? null : user.merchantId,
        input.status,
        user.id,
        input.note,
        user.role,
      ),
    );
  }),
);
