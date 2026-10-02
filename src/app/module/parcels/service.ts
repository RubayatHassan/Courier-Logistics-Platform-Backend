import crypto from "node:crypto";
import type { ParcelStatus } from "../../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
import {
  calculateDeliveryCharge,
  changeParcel,
  lockParcel,
} from "./workflow.js";

const transitions: Record<ParcelStatus, ParcelStatus[]> = {
  CREATED: ["PICKUP_ASSIGNED", "CANCELLED"],
  PICKUP_ASSIGNED: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["AT_HUB", "DELIVERY_FAILED"],
  AT_HUB: ["IN_TRANSIT", "SORTING", "OUT_FOR_DELIVERY", "LOST_DAMAGED"],
  IN_TRANSIT: ["AT_HUB", "LOST_DAMAGED"],
  SORTING: ["AT_HUB", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_FAILED", "RESCHEDULED", "RETURNED"],
  DELIVERY_FAILED: ["RESCHEDULED", "RETURNED"],
  RESCHEDULED: ["OUT_FOR_DELIVERY"],
  DELIVERED: [],
  CANCELLED: [],
  RETURNED: [],
  LOST_DAMAGED: [],
};

const roleTransitions: Record<
  NonNullable<Parameters<typeof transitionParcel>[5]>,
  ParcelStatus[]
> = {
  SUPER_ADMIN: Object.keys(transitions) as ParcelStatus[],
  ADMIN: Object.keys(transitions) as ParcelStatus[],
  MERCHANT: ["CANCELLED"],
  HUB_MANAGER: ["SORTING", "RESCHEDULED", "RETURNED", "LOST_DAMAGED"],
  RIDER: [
    "PICKED_UP",
    "DELIVERED",
    "DELIVERY_FAILED",
    "RESCHEDULED",
    "RETURNED",
  ],
  CUSTOMER: ["CANCELLED"],
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
  const deliveryCharge = calculateDeliveryCharge(input.weightGrams);
  const trackingNumber = `CLP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  try {
    return await prisma.$transaction(async (tx) => {
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
      if (input.codAmount > 0)
        await tx.payment.create({
          data: {
            parcelId: parcel.id,
            amount: input.codAmount,
            method: "COD",
          },
        });
      return parcel;
    });
  } catch (error) {
    if (
      input.idempotencyKey &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      const existing = await prisma.parcel.findFirst({
        where: {
          merchantId: input.merchantId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (existing) return createParcel(input);
    }
    throw error;
  }
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
  if (!role || role === "CUSTOMER" || (role === "MERCHANT" && !merchantId))
    throw new AppError(403, "Parcel access is not permitted");
  if (
    ["PICKUP_ASSIGNED", "AT_HUB", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(
      status,
    )
  )
    throw new AppError(
      409,
      "Use the hub or rider workflow endpoint for this transition",
    );
  const scope =
    role === "MERCHANT" && merchantId
      ? { merchantId }
      : role === "RIDER"
        ? {
            assignments: {
              some: {
                completedAt: null,
                rider: { userId: actorId, status: "ACTIVE" },
              },
            },
          }
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
  if (role && !roleTransitions[role].includes(status))
    throw new AppError(403, "Your role cannot perform this parcel transition");
  return prisma.$transaction(async (tx) => {
    await lockParcel(tx, id);
    const onlinePayment =
      status === "DELIVERED"
        ? await tx.payment.findFirst({
            where: {
              parcelId: id,
              method: "ONLINE",
              amount: { gt: 0 },
              status: { in: ["PENDING", "PAID"] },
            },
            orderBy: { createdAt: "desc" },
          })
        : null;
    const pendingOnline = await tx.payment.findFirst({
      where: {
        parcelId: id,
        method: "ONLINE",
        amount: { gt: 0 },
        status: "PENDING",
      },
    });
    if (
      pendingOnline &&
      ["DELIVERED", "CANCELLED", "RETURNED", "LOST_DAMAGED"].includes(status)
    )
      throw new AppError(
        409,
        "Resolve the pending online payment before closing this parcel",
      );
    await changeParcel(tx, parcel, {
      status,
      deliveredAt: status === "DELIVERED" ? new Date() : undefined,
    });
    await tx.trackingEvent.create({
      data: { parcelId: id, status, actorId, note },
    });
    if (
      status === "DELIVERED" &&
      Number(parcel.codAmount) > 0 &&
      onlinePayment?.status !== "PAID"
    ) {
      const collected = await tx.payment.updateMany({
        where: { parcelId: id, method: "COD", status: "PENDING" },
        data: { status: "PAID" },
      });
      if (collected.count !== 1)
        throw new AppError(
          409,
          "A single pending COD payment is required before collection",
        );
      await tx.codLedger.create({
        data: {
          merchantId: parcel.merchantId,
          parcelId: id,
          entryType: "COD_COLLECTED",
          amount: parcel.codAmount,
        },
      });
    }
    if (
      [
        "DELIVERED",
        "DELIVERY_FAILED",
        "RESCHEDULED",
        "CANCELLED",
        "RETURNED",
        "LOST_DAMAGED",
      ].includes(status)
    ) {
      await tx.deliveryAssignment.updateMany({
        where: { parcelId: id, completedAt: null },
        data: {
          status,
          completedAt: new Date(),
          deliveredAt: status === "DELIVERED" ? new Date() : undefined,
          attemptCount: {
            increment:
              status === "DELIVERED" || status === "DELIVERY_FAILED" ? 1 : 0,
          },
        },
      });
    }
    if (["CANCELLED", "RETURNED", "LOST_DAMAGED"].includes(status)) {
      await tx.payment.updateMany({
        where: { parcelId: id, method: "COD", status: "PENDING" },
        data: { status: "FAILED" },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        action: "PARCEL_STATUS_CHANGED",
        entity: "Parcel",
        entityId: id,
        metadata: { from: parcel.status, to: status },
      },
    });
    return tx.parcel.findUniqueOrThrow({ where: { id } });
  });
}
