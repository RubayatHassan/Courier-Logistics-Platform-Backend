import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/prisma.js";
import {
  authenticate,
  authorize,
  hashPassword,
} from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";
import { parseInput } from "../../shared/validation.js";

const branchSchema = z.object({
  name: z.string().min(2),
  code: z.string().min(2).max(20),
  type: z.string().min(2),
  phone: z.string().optional(),
  email: z.email().optional(),
});
const hubSchema = z.object({
  name: z.string().min(2),
  code: z.string().min(2).max(20),
  address: z.string().min(5),
  city: z.string().min(2),
  branchId: z.uuid().optional(),
  merchantId: z.uuid().optional(),
});
const vehicleSchema = z.object({
  type: z.string().min(2),
  plateNumber: z.string().min(3),
  capacityKg: z.number().positive().optional(),
});
const riderSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
  name: z.string().min(2),
  phone: z.string().min(7).max(20).optional(),
  hubId: z.uuid(),
  vehicleType: z.string().optional(),
});
const hubManagerSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
  name: z.string().min(2),
  branchId: z.uuid(),
});

export const operationsRouter = Router();
operationsRouter.use(authenticate, authorize("ADMIN"));

operationsRouter.post(
  "/branches",
  asyncHandler(async (req, res) => {
    const input = parseInput(branchSchema, req.body);
    if (
      await prisma.warehouseBranch.findUnique({ where: { code: input.code } })
    )
      throw new AppError(409, "Branch code already exists");
    return ok(
      res,
      await prisma.warehouseBranch.create({ data: input }),
      201,
      "Branch created successfully",
    );
  }),
);

operationsRouter.post(
  "/hubs",
  asyncHandler(async (req, res) => {
    const input = parseInput(hubSchema, req.body);
    if (await prisma.hub.findUnique({ where: { code: input.code } }))
      throw new AppError(409, "Hub code already exists");
    if (
      input.branchId &&
      !(await prisma.warehouseBranch.findUnique({
        where: { id: input.branchId },
      }))
    )
      throw new AppError(404, "Branch not found");
    if (
      input.merchantId &&
      !(await prisma.merchant.findUnique({ where: { id: input.merchantId } }))
    )
      throw new AppError(404, "Merchant not found");
    return ok(
      res,
      await prisma.hub.create({ data: input }),
      201,
      "Hub created successfully",
    );
  }),
);

operationsRouter.post(
  "/vehicles",
  asyncHandler(async (req, res) => {
    const input = parseInput(vehicleSchema, req.body);
    if (
      await prisma.vehicle.findUnique({
        where: { plateNumber: input.plateNumber },
      })
    )
      throw new AppError(409, "Vehicle plate number already exists");
    return ok(
      res,
      await prisma.vehicle.create({ data: input }),
      201,
      "Vehicle created successfully",
    );
  }),
);

operationsRouter.post(
  "/hub-managers",
  asyncHandler(async (req, res) => {
    const input = parseInput(hubManagerSchema, req.body);
    const branch = await prisma.warehouseBranch.findUnique({
      where: { id: input.branchId },
    });
    if (!branch) throw new AppError(404, "Branch not found");
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "Email already registered");
    const user = await prisma.$transaction(async (tx) => {
      const manager = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          role: "HUB_MANAGER",
          emailVerifiedAt: new Date(),
        },
      });
      await tx.userBranch.create({
        data: { userId: manager.id, branchId: input.branchId },
      });
      return manager;
    });
    return ok(
      res,
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        branchId: input.branchId,
      },
      201,
      "Hub manager created successfully",
    );
  }),
);

operationsRouter.post(
  "/riders",
  asyncHandler(async (req, res) => {
    const input = parseInput(riderSchema, req.body);
    const hub = await prisma.hub.findUnique({ where: { id: input.hubId } });
    if (!hub) throw new AppError(404, "Hub not found");
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "Email already registered");
    const rider = await prisma.$transaction(async (tx) => {
      const riderUser = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          phone: input.phone,
          passwordHash: await hashPassword(input.password),
          role: "RIDER",
          emailVerifiedAt: new Date(),
        },
      });
      return tx.rider.create({
        data: {
          userId: riderUser.id,
          hubId: input.hubId,
          phone: input.phone,
          vehicleType: input.vehicleType,
        },
        include: { user: true },
      });
    });
    return ok(
      res,
      {
        id: rider.id,
        userId: rider.userId,
        email: rider.user.email,
        hubId: rider.hubId,
      },
      201,
      "Rider created successfully",
    );
  }),
);

operationsRouter.get(
  "/hubs",
  asyncHandler(async (_req, res) =>
    ok(
      res,
      await prisma.hub.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
      }),
    ),
  ),
);
operationsRouter.get(
  "/vehicles",
  asyncHandler(async (_req, res) =>
    ok(
      res,
      await prisma.vehicle.findMany({
        where: { isActive: true },
        orderBy: { plateNumber: "asc" },
      }),
    ),
  ),
);
