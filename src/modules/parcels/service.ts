import crypto from "node:crypto";
import type { ParcelStatus } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../shared/http.js";

const transitions: Record<ParcelStatus, ParcelStatus[]> = {
  CREATED: ["PICKUP_ASSIGNED", "CANCELLED"],
  PICKUP_ASSIGNED: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["AT_HUB", "DELIVERY_FAILED"],
  AT_HUB: ["IN_TRANSIT", "SORTING", "OUT_FOR_DELIVERY", "LOST_DAMAGED"],
  IN_TRANSIT: ["AT_HUB", "LOST_DAMAGED"],
  SORTING: ["AT_HUB", "OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_FAILED", "RESCHEDULED", "RETURNED"],
  DELIVERY_FAILED: ["RESCHEDULED", "RETURNED"],
  RESCHEDULED: ["OUT_FOR_DELIVERY"],
  DELIVERED: [],
  CANCELLED: [],
  RETURNED: [],
  LOST_DAMAGED: [],
};

export async function createParcel(input: {
  merchantId: string;
  customerId: string;
  pickupAddress: string;
  deliveryAddress: string;
  weightGrams: number;
  codAmount: number;
  description?: string;
  idempotencyKey?: string;
}) {
  if (input.idempotencyKey) {
    const existing = await prisma.parcel.findFirst({
      where: {
        merchantId: input.merchantId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (existing) {
      const samePayload =
        existing.customerId === input.customerId &&
        existing.pickupAddress === input.pickupAddress &&
        existing.deliveryAddress === input.deliveryAddress &&
        existing.weightGrams === input.weightGrams &&
        Number(existing.codAmount) === input.codAmount &&
        (existing.description ?? undefined) === input.description;

      if (!samePayload)
        throw new AppError(
          409,
          "Idempotency key has already been used with a different parcel payload. Use a new Idempotency-Key.",
        );

      return existing;
    }
  }
  const deliveryCharge = Math.max(
    60,
    60 + Math.ceil(Math.max(0, input.weightGrams - 1000) / 1000) * 20,
  );
  const trackingNumber = `CLP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  return prisma.$transaction(async (tx) => {
    const parcel = await tx.parcel.create({
      data: {
        ...input,
        trackingNumber,
        deliveryCharge,
        codAmount: input.codAmount,
        status: "CREATED",
      },
    });
    await tx.trackingEvent.create({
      data: { parcelId: parcel.id, status: "CREATED", note: "Parcel booked" },
    });
    await tx.payment.create({
      data: {
        parcelId: parcel.id,
        amount: input.codAmount,
        method: input.codAmount > 0 ? "COD" : "ONLINE",
      },
    });
    return parcel;
  });
}

export async function transitionParcel(
  id: string,
  merchantId: string | null,
  status: ParcelStatus,
  actorId: string,
  note?: string,
  role?:
    | "SUPER_ADMIN"
    | "ADMIN"
    | "MERCHANT"
    | "HUB_MANAGER"
    | "RIDER"
    | "CUSTOMER",
) {
  const scope = merchantId
    ? { merchantId }
    : role === "RIDER"
      ? { assignments: { some: { rider: { userId: actorId } } } }
      : role === "HUB_MANAGER"
        ? {
            currentHub: {
              branch: { userBranches: { some: { userId: actorId } } },
            },
          }
        : {};
  const parcel = await prisma.parcel.findFirst({
    where: { id, ...scope },
  });
  if (!parcel) throw new AppError(404, "Parcel not found");
  if (!(transitions[parcel.status] ?? []).includes(status))
    throw new AppError(
      409,
      `Cannot move parcel from ${parcel.status} to ${status}`,
    );
  return prisma.$transaction(async (tx) => {
    const updated = await tx.parcel.update({
      where: { id },
      data: {
        status,
        deliveredAt: status === "DELIVERED" ? new Date() : undefined,
      },
    });
    await tx.trackingEvent.create({
      data: { parcelId: id, status, actorId, note },
    });
    if (status === "DELIVERED" && Number(parcel.codAmount) > 0)
      await tx.codLedger.create({
        data: {
          merchantId: parcel.merchantId,
          parcelId: id,
          entryType: "COD_COLLECTED",
          amount: parcel.codAmount,
        },
      });
    return updated;
  });
}
