import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
import { changeParcel, lockParcel } from "../parcels/workflow.js";
import type { CreateCustomerInput, CustomerActor } from "./interface.js";

function resolveMerchantId(actor: CustomerActor, requestedMerchantId?: string) {
  const merchantId =
    actor.role === "MERCHANT" ? actor.merchantId : requestedMerchantId;
  if (!merchantId) throw new AppError(400, "Merchant context is required");
  return merchantId;
}

export async function listCustomers(
  actor: CustomerActor,
  requestedMerchantId?: string,
) {
  const merchantId = resolveMerchantId(actor, requestedMerchantId);
  return prisma.customer.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createCustomer(
  actor: CustomerActor,
  input: CreateCustomerInput,
) {
  const merchantId = resolveMerchantId(actor, input.merchantId);
  const email = input.email?.trim().toLowerCase();
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });
  if (!merchant) throw new AppError(404, "Merchant not found");

  const existing = await prisma.customer.findUnique({
    where: { merchantId_phone: { merchantId, phone: input.phone } },
  });
  if (existing)
    throw new AppError(409, "Customer phone already exists for this merchant");

  return prisma.customer.create({
    data: {
      merchantId,
      name: input.name,
      phone: input.phone,
      ...(email ? { email } : {}),
    },
  });
}

export async function listOwnParcels(
  email: string,
  page: number,
  limit: number,
) {
  const where = {
    customer: { email: { equals: email, mode: "insensitive" as const } },
  };
  const [items, total] = await prisma.$transaction([
    prisma.parcel.findMany({
      where,
      select: {
        id: true,
        trackingNumber: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        deliveryAddress: true,
        codAmount: true,
        trackingEvents: {
          orderBy: { createdAt: "asc" },
          select: { status: true, note: true, location: true, createdAt: true },
        },
        payments: {
          select: { method: true, amount: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.parcel.count({ where }),
  ]);
  return {
    items,
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function cancelOwnParcel(
  email: string,
  actorId: string,
  parcelId: string,
  reason: string,
) {
  return prisma.$transaction(async (tx) => {
    await lockParcel(tx, parcelId);
    const parcel = await tx.parcel.findFirst({
      where: {
        id: parcelId,
        customer: { email: { equals: email, mode: "insensitive" } },
      },
    });
    if (!parcel) throw new AppError(404, "Parcel not found");
    if (!["CREATED", "PICKUP_ASSIGNED"].includes(parcel.status))
      throw new AppError(409, "Parcel can only be cancelled before pickup");
    const updated = await changeParcel(tx, parcel, {
      status: "CANCELLED",
    });
    await tx.deliveryAssignment.updateMany({
      where: { parcelId, completedAt: null },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    await tx.payment.updateMany({
      where: { parcelId, method: "COD", status: "PENDING" },
      data: { status: "FAILED" },
    });
    await tx.trackingEvent.create({
      data: {
        parcelId,
        status: "CANCELLED",
        actorId,
        note: `Cancelled by customer: ${reason}`,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "CUSTOMER_CANCELLED_PARCEL",
        entity: "Parcel",
        entityId: parcelId,
        metadata: { from: parcel.status, reason },
      },
    });
    return {
      id: updated.id,
      trackingNumber: updated.trackingNumber,
      status: updated.status,
      updatedAt: updated.updatedAt,
    };
  });
}
