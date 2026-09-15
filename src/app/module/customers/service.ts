import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/http.js";
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
      ...(input.email ? { email: input.email } : {}),
    },
  });
}
