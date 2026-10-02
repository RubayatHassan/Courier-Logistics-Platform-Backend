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

export const operationsRouter = Router();
operationsRouter.use(authenticate);
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
                hub: {
                  branch: { userBranches: { some: { userId: user.id } } },
                },
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
operationsRouter.use(authorize("ADMIN"));
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
