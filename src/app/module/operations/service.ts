import { prisma } from "../../lib/prisma.js";
import { hashPassword } from "../../middleware/auth.js";
import { AppError } from "../../utils/http.js";
import type {
  BranchInput,
  HubInput,
  HubManagerInput,
  RiderInput,
  VehicleInput,
} from "./interface.js";
export async function createBranch(input: BranchInput) {
  if (await prisma.warehouseBranch.findUnique({ where: { code: input.code } }))
    throw new AppError(409, "Branch code already exists");
  return prisma.warehouseBranch.create({ data: input });
}
export async function createHub(input: HubInput) {
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
  return prisma.hub.create({ data: input });
}
export async function createVehicle(input: VehicleInput) {
  if (
    await prisma.vehicle.findUnique({
      where: { plateNumber: input.plateNumber },
    })
  )
    throw new AppError(409, "Vehicle plate number already exists");
  return prisma.vehicle.create({ data: input });
}
export async function createHubManager(input: HubManagerInput) {
  const hub = await prisma.hub.findFirst({
    where: { id: input.hubId, isActive: true },
  });
  if (!hub) throw new AppError(404, "Active hub not found");
  if (input.branchId && input.branchId !== hub.branchId)
    throw new AppError(400, "Branch must match the selected hub");
  if (await prisma.user.findUnique({ where: { email: input.email } }))
    throw new AppError(409, "Email already registered");
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    const manager = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        role: "HUB_MANAGER",
        managedHubId: hub.id,
        emailVerifiedAt: new Date(),
      },
    });
    if (hub.branchId)
      await tx.userBranch.create({
        data: { userId: manager.id, branchId: hub.branchId },
      });
    return manager;
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    hubId: hub.id,
    branchId: hub.branchId,
  };
}

export async function assignManagerHub(
  userId: string,
  hubId: string,
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    if (!(await tx.hub.findFirst({ where: { id: hubId, isActive: true } })))
      throw new AppError(404, "Active hub not found");
    const changed = await tx.user.updateMany({
      where: { id: userId, role: "HUB_MANAGER" },
      data: { managedHubId: hubId },
    });
    if (changed.count !== 1) throw new AppError(404, "Hub manager not found");
    await tx.auditLog.create({
      data: {
        actorId,
        action: "MANAGER_HUB_ASSIGNED",
        entity: "User",
        entityId: userId,
        metadata: { hubId },
      },
    });
    return { userId, hubId };
  });
}
export async function createRider(input: RiderInput) {
  if (!(await prisma.hub.findUnique({ where: { id: input.hubId } })))
    throw new AppError(404, "Hub not found");
  if (await prisma.user.findUnique({ where: { email: input.email } }))
    throw new AppError(409, "Email already registered");
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
  return {
    id: rider.id,
    userId: rider.userId,
    email: rider.user.email,
    hubId: rider.hubId,
  };
}
export const listHubs = () =>
  prisma.hub.findMany({ where: { isActive: true }, orderBy: { code: "asc" } });
export const listVehicles = () =>
  prisma.vehicle.findMany({
    where: { isActive: true },
    orderBy: { plateNumber: "asc" },
  });
