import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../utils/http.js";
import type { AuthenticatedRequest } from "../../utils/types.js";
import {
  getVehicles,
  postBranch,
  postHub,
  postHubManager,
  postRider,
  postVehicle,
} from "./controller.js";
import { managedHubScope } from "./scope.js";
import { assignManagerHub } from "./service.js";

export const operationsRouter = Router();
operationsRouter.use(authenticate);
// A transfer destination directory exposes no parcel, customer or rider data.
operationsRouter.get(
  "/transfer-destinations",
  authorize("ADMIN", "HUB_MANAGER"),
  asyncHandler(async (_req, res) => {
    return ok(
      res,
      await prisma.hub.findMany({
        where: { isActive: true },
        select: { id: true, name: true, code: true, city: true },
        orderBy: { code: "asc" },
        take: 100,
      }),
    );
  }),
);
operationsRouter.get(
  "/hubs",
  authorize("ADMIN", "MERCHANT", "HUB_MANAGER"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    if (user.role === "MERCHANT" && !user.merchantId)
      throw new AppError(403, "Merchant context required");
    return ok(
      res,
      await prisma.hub.findMany({
        where: {
          isActive: true,
          ...(user.role === "HUB_MANAGER" ? managedHubScope(user.id) : {}),
          ...(user.role === "MERCHANT"
            ? { OR: [{ merchantId: user.merchantId }, { merchantId: null }] }
            : {}),
        },
        orderBy: { code: "asc" },
        take: 100,
      }),
    );
  }),
);
operationsRouter.get(
  "/vehicles",
  authorize("ADMIN", "HUB_MANAGER"),
  asyncHandler(getVehicles),
);
operationsRouter.get(
  "/riders",
  authorize("ADMIN", "HUB_MANAGER"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const hubId = z.uuid().optional().parse(req.query.hubId);
    return ok(
      res,
      await prisma.rider.findMany({
        where: {
          status: "ACTIVE",
          isAvailable: true,
          ...(hubId ? { hubId } : {}),
          ...(user.role === "HUB_MANAGER"
            ? {
                hub: managedHubScope(user.id),
              }
            : {}),
        },
        select: {
          id: true,
          hubId: true,
          vehicleType: true,
          user: { select: { name: true } },
        },
        take: 100,
      }),
    );
  }),
);
operationsRouter.get(
  "/inbound-transfers",
  authorize("ADMIN", "HUB_MANAGER"),
  asyncHandler(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new AppError(401, "Authentication required");
    const hub =
      user.role === "HUB_MANAGER"
        ? await prisma.hub.findFirst({
            where: managedHubScope(user.id),
            select: { id: true },
          })
        : null;
    if (user.role === "HUB_MANAGER" && !hub)
      throw new AppError(403, "Assign this manager to a hub first");
    const transfers = await prisma.hubTransfer.findMany({
      where: {
        parcel: { status: "IN_TRANSIT" },
        ...(hub ? { toHubId: hub.id } : {}),
      },
      orderBy: { transferredAt: "desc" },
      distinct: ["parcelId"],
      take: 100,
      select: {
        id: true,
        parcelId: true,
        transferredAt: true,
        fromHub: { select: { name: true, code: true } },
        toHub: { select: { id: true, name: true, code: true } },
        parcel: {
          select: {
            id: true,
            trackingNumber: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });
    return ok(res, transfers);
  }),
);
operationsRouter.use(authorize("ADMIN"));
operationsRouter.get(
  "/hub-managers",
  asyncHandler(async (_req, res) =>
    ok(
      res,
      await prisma.user.findMany({
        where: { role: "HUB_MANAGER" },
        select: {
          id: true,
          email: true,
          name: true,
          managedHubId: true,
          managedHub: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ),
  ),
);
operationsRouter.patch(
  "/hub-managers/:id/hub",
  asyncHandler(async (req, res) => {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) throw new AppError(401, "Authentication required");
    const userId = z.uuid().parse(req.params.id);
    const { hubId } = z.object({ hubId: z.uuid() }).parse(req.body);
    return ok(res, await assignManagerHub(userId, hubId, actor.id));
  }),
);
operationsRouter.get(
  "/branches",
  asyncHandler(async (_req, res) =>
    ok(
      res,
      await prisma.warehouseBranch.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
        take: 100,
      }),
    ),
  ),
);
operationsRouter.post("/branches", asyncHandler(postBranch));
operationsRouter.post("/hubs", asyncHandler(postHub));
operationsRouter.post("/vehicles", asyncHandler(postVehicle));
operationsRouter.post("/hub-managers", asyncHandler(postHubManager));
operationsRouter.post("/riders", asyncHandler(postRider));
