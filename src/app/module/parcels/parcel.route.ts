import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { cacheGet, cacheSet } from "../../lib/redis.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../utils/http.js";
import type { AuthenticatedRequest } from "../../utils/types.js";
import { parseInput } from "../../utils/validation.js";
import { managedHubScope, requireManagedHub } from "../operations/scope.js";
import { createParcel, transitionParcel } from "./service.js";
import { changeParcel, lockParcel } from "./workflow.js";

const createSchema = z.object({
  customerId: z.uuid(),
  pickupAddress: z.string().min(5),
  deliveryAddress: z.string().min(5),
  weightGrams: z.number().int().positive(),
  codAmount: z
    .number()
    .nonnegative()
    .max(9999999999.99)
    .multipleOf(0.01)
    .default(0),
  merchantId: z.uuid().optional(),
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
  "IN_TRANSIT",
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
const originHubSchema = z.object({ hubId: z.uuid() });
const dispatchSchema = z.object({
  destinationHubId: z.uuid(),
  vehicleId: z.uuid().optional(),
});
const riderAssignmentSchema = z.object({
  riderId: z.uuid(),
});
export const parcelRouter = Router();
function parcelIdFromRequest(req: Request) {
  const parcelId = req.params.id;
  if (typeof parcelId !== "string")
    throw new AppError(400, "Parcel id is required");
  return z.uuid().parse(parcelId);
}

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
            ? {
                assignments: {
                  some: {
                    completedAt: null,
                    rider: { userId: user.id, status: "ACTIVE" },
                  },
                },
              }
            : user.role === "HUB_MANAGER"
              ? {
                  currentHub: managedHubScope(user.id),
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
    const { merchantId: requestedMerchantId, ...input } = parseInput(
      createSchema,
      req.body,
    );
    const merchantId =
      user.role === "MERCHANT"
        ? user.merchantId
        : (requestedMerchantId ?? user.merchantId);
    if (!merchantId) throw new AppError(400, "Merchant context required");
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, merchantId },
    });
    if (!customer) throw new AppError(404, "Customer not found");
    return ok(
      res,
      await createParcel({
        ...input,
        merchantId,
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .parse(req.header("idempotency-key")),
      }),
      201,
      "Parcel created successfully",
    );
  }),
);

parcelRouter.post(
  "/:id/assign-origin-hub",
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const { hubId } = parseInput(originHubSchema, req.body);
    if (user.role === "MERCHANT" && !user.merchantId)
      throw new AppError(403, "Merchant context required");
    const parcelId = parcelIdFromRequest(req);
    const parcel = await prisma.parcel.findFirst({
      where: {
        id: parcelId,
        ...(user.role === "MERCHANT"
          ? { merchantId: user.merchantId ?? "__no_access__" }
          : {}),
      },
    });
    if (!parcel) throw new AppError(404, "Parcel not found");
    if (
      !["CREATED", "PICKED_UP"].includes(parcel.status) ||
      parcel.currentHubId
    )
      throw new AppError(
        409,
        "Origin hub can only be assigned once, before hub processing",
      );
    const hub = await prisma.hub.findFirst({
      where: {
        id: hubId,
        isActive: true,
        OR: [{ merchantId: parcel.merchantId }, { merchantId: null }],
      },
    });
    if (!hub) throw new AppError(404, "Origin hub not found");
    const updated = await prisma.$transaction(async (tx) => {
      const result = await changeParcel(tx, parcel, {
        currentHubId: hub.id,
        status: "AT_HUB",
      });
      await tx.deliveryAssignment.updateMany({
        where: { parcelId: parcel.id, completedAt: null },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "AT_HUB",
          actorId: user.id,
          location: hub.name,
          note: "Origin hub assigned",
        },
      });
      {
        const managers = await tx.user.findMany({
          where: {
            role: "HUB_MANAGER",
            managedHubId: hub.id,
          },
          select: { id: true },
        });
        if (managers.length > 0)
          await tx.notification.createMany({
            data: managers.map((manager) => ({
              userId: manager.id,
              channel: "IN_APP",
              recipient: manager.id,
              subject: "New parcel assigned to your hub",
              payload: {
                parcelId: parcel.id,
                trackingNumber: parcel.trackingNumber,
                hubId: hub.id,
              },
            })),
          });
      }
      return result;
    });
    return ok(res, updated);
  }),
);

parcelRouter.post(
  "/:id/dispatch",
  authorize("HUB_MANAGER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const input = parseInput(dispatchSchema, req.body);
    const parcelId = parcelIdFromRequest(req);
    const parcel = await prisma.parcel.findUnique({
      where: { id: parcelId },
      include: { currentHub: true },
    });
    if (!parcel?.currentHub)
      throw new AppError(404, "Parcel or current hub not found");
    if (user.role === "HUB_MANAGER")
      await requireManagedHub(user.id, parcel.currentHub.id);
    if (!["AT_HUB", "SORTING"].includes(parcel.status))
      throw new AppError(
        409,
        "Only parcels at a hub or being sorted can be dispatched",
      );
    const destination = await prisma.hub.findFirst({
      where: {
        id: input.destinationHubId,
        isActive: true,
        OR: [{ merchantId: parcel.merchantId }, { merchantId: null }],
      },
    });
    if (!destination) throw new AppError(404, "Destination hub not found");
    if (destination.id === parcel.currentHubId)
      throw new AppError(409, "Destination must differ from the current hub");
    if (
      input.vehicleId &&
      !(await prisma.vehicle.findFirst({
        where: { id: input.vehicleId, isActive: true },
      }))
    )
      throw new AppError(404, "Vehicle not found");
    const result = await prisma.$transaction(async (tx) => {
      const updated = await changeParcel(tx, parcel, { status: "IN_TRANSIT" });
      await tx.hubTransfer.create({
        data: {
          parcelId: parcel.id,
          fromHubId: parcel.currentHubId,
          toHubId: destination.id,
          vehicleId: input.vehicleId ?? null,
        },
      });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "IN_TRANSIT",
          actorId: user.id,
          location: destination.name,
          note: "Dispatched to destination hub",
        },
      });
      return updated;
    });
    return ok(res, result, 200, "Parcel dispatched successfully");
  }),
);

parcelRouter.post(
  "/:id/mark-arrived",
  authorize("HUB_MANAGER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const parcelId = parcelIdFromRequest(req);
    const parcel = await prisma.parcel.findUnique({
      where: { id: parcelId },
      include: {
        transfers: {
          orderBy: { transferredAt: "desc" },
          take: 1,
          include: { toHub: true },
        },
      },
    });
    const transfer = parcel?.transfers[0];
    if (!parcel || !transfer)
      throw new AppError(404, "Pending hub transfer not found");
    if (parcel.status !== "IN_TRANSIT")
      throw new AppError(409, "Parcel is not in transit");
    if (user.role === "HUB_MANAGER") {
      await requireManagedHub(user.id, transfer.toHubId);
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await changeParcel(tx, parcel, {
        currentHubId: transfer.toHubId,
        status: "AT_HUB",
      });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "AT_HUB",
          actorId: user.id,
          location: transfer.toHub.name,
          note: "Arrived at destination hub",
        },
      });
      return result;
    });
    return ok(res, updated);
  }),
);

parcelRouter.post(
  "/:id/assign-rider",
  authorize("HUB_MANAGER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const input = parseInput(riderAssignmentSchema, req.body);
    const parcelId = parcelIdFromRequest(req);
    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel?.currentHubId)
      throw new AppError(404, "Parcel or current hub not found");
    if (
      !["AT_HUB", "SORTING", "DELIVERY_FAILED", "RESCHEDULED"].includes(
        parcel.status,
      )
    )
      throw new AppError(
        409,
        "Parcel must be at a hub, sorted, failed or rescheduled before rider assignment",
      );
    if (user.role === "HUB_MANAGER") {
      await requireManagedHub(user.id, parcel.currentHubId);
    }
    const rider = await prisma.rider.findFirst({
      where: {
        id: input.riderId,
        hubId: parcel.currentHubId,
        isAvailable: true,
        status: "ACTIVE",
      },
    });
    if (!rider)
      throw new AppError(404, "Available rider not found at this hub");
    const result = await prisma.$transaction(async (tx) => {
      await lockParcel(tx, parcel.id);
      await changeParcel(tx, parcel, { status: "OUT_FOR_DELIVERY" });
      await tx.deliveryAssignment.updateMany({
        where: { parcelId: parcel.id, completedAt: null },
        data: { status: "REASSIGNED", completedAt: new Date() },
      });
      const assignment = await tx.deliveryAssignment.create({
        data: {
          parcelId: parcel.id,
          riderId: rider.id,
          status: "ASSIGNED",
        },
      });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "OUT_FOR_DELIVERY",
          actorId: user.id,
          note: "Rider assigned for delivery",
        },
      });
      return assignment;
    });
    return ok(res, result, 201, "Rider assigned successfully");
  }),
);

parcelRouter.patch(
  "/:id/status",
  authorize("ADMIN", "MERCHANT", "HUB_MANAGER", "RIDER"),
  asyncHandler(async (req, res) => {
    const input = statusSchema.parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const parcelId = parcelIdFromRequest(req);
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
