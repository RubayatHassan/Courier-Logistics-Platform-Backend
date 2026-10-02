import type { Parcel, Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../utils/http.js";

// All payment and workflow writers lock the parcel first, in the same order.
export async function lockParcel(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "Parcel" WHERE id = ${id} FOR UPDATE`;
}

export async function changeParcel(
  tx: Prisma.TransactionClient,
  parcel: Parcel,
  data: Prisma.ParcelUncheckedUpdateManyInput,
) {
  const changed = await tx.parcel.updateMany({
    where: {
      id: parcel.id,
      status: parcel.status,
      updatedAt: parcel.updatedAt,
    },
    data,
  });
  if (changed.count !== 1)
    throw new AppError(409, "Parcel changed; reload and retry the operation");
  return tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
}

export function calculateDeliveryCharge(weightGrams: number) {
  return 60 + Math.ceil(Math.max(0, weightGrams - 1000) / 1000) * 20;
}
