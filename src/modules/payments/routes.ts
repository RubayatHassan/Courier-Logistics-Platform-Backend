import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { Parcel } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/prisma.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../shared/http.js";
import type { AuthenticatedRequest } from "../../shared/types.js";

const checkoutSchema = z.object({ parcelId: z.uuid() });
const customerCheckoutSchema = z.object({
  trackingNumber: z.string().trim().min(1),
  phone: z.string().trim().min(7),
});
export const paymentRouter = Router();

async function createStripeCheckout(
  parcel: Pick<Parcel, "id" | "trackingNumber" | "codAmount">,
) {
  if (!env.STRIPE_SECRET_KEY)
    throw new AppError(503, "Stripe payments are not configured");
  if (Number(parcel.codAmount) <= 0)
    throw new AppError(400, "Only positive parcel amounts can be paid online");

  const existingPayment = await prisma.payment.findFirst({
    where: {
      parcelId: parcel.id,
      method: "ONLINE",
      status: { in: ["PENDING", "PAID"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingPayment?.status === "PAID")
    throw new AppError(409, "This parcel has already been paid");
  if (existingPayment?.providerReference)
    throw new AppError(409, "A payment checkout is already in progress");

  const body = new URLSearchParams({
    mode: "payment",
    success_url: env.STRIPE_SUCCESS_URL,
    cancel_url: env.STRIPE_CANCEL_URL,
    "line_items[0][price_data][currency]": "bdt",
    "line_items[0][price_data][product_data][name]": `Parcel ${parcel.trackingNumber}`,
    "line_items[0][price_data][unit_amount]": String(
      Math.round(Number(parcel.codAmount) * 100),
    ),
    "line_items[0][quantity]": "1",
    "metadata[parcelId]": parcel.id,
    "metadata[trackingNumber]": parcel.trackingNumber,
  });
  const stripeResponse = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const session = (await stripeResponse.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!stripeResponse.ok || !session.id || !session.url)
    throw new AppError(
      502,
      session.error?.message ?? "Stripe checkout could not be created",
    );
  await prisma.payment.create({
    data: {
      parcelId: parcel.id,
      amount: parcel.codAmount,
      method: "ONLINE",
      providerReference: session.id,
    },
  });
  return { checkoutSessionId: session.id, checkoutUrl: session.url };
}

paymentRouter.post(
  "/stripe/customer-checkout",
  asyncHandler(async (req, res) => {
    const input = customerCheckoutSchema.parse(req.body);
    const parcel = await prisma.parcel.findFirst({
      where: {
        trackingNumber: input.trackingNumber,
        customer: { phone: input.phone },
      },
    });
    if (!parcel)
      throw new AppError(
        404,
        "Parcel not found for the supplied tracking number and phone",
      );
    if (parcel.status !== "OUT_FOR_DELIVERY")
      throw new AppError(
        409,
        "Online payment is available when the parcel is out for delivery",
      );
    return ok(
      res,
      await createStripeCheckout(parcel),
      201,
      "Customer payment checkout created successfully",
    );
  }),
);

paymentRouter.post(
  "/stripe/checkout",
  authenticate,
  authorize("MERCHANT", "ADMIN"),
  asyncHandler(async (req, res) => {
    const { parcelId } = checkoutSchema.parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    const parcel = await prisma.parcel.findFirst({
      where: {
        id: parcelId,
        ...(user?.merchantId ? { merchantId: user.merchantId } : {}),
      },
    });
    if (!parcel) throw new AppError(404, "Parcel not found");
    return ok(
      res,
      await createStripeCheckout(parcel),
      201,
      "Stripe checkout created successfully",
    );
  }),
);

paymentRouter.post(
  "/stripe/webhook",
  asyncHandler(async (req, res) => {
    if (!env.STRIPE_WEBHOOK_SECRET)
      throw new AppError(503, "Stripe webhook is not configured");
    const signature = req.header("stripe-signature");
    if (!signature) throw new AppError(400, "Stripe signature is required");
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);
    const timestamp = signature.match(/t=(\d+)/)?.[1];
    const provided = signature.match(/v1=([^,]+)/)?.[1];
    const timestampSeconds = timestamp ? Number(timestamp) : NaN;
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(Date.now() / 1000 - timestampSeconds) > 300
    )
      throw new AppError(400, "Expired Stripe signature");
    const expected = timestamp
      ? crypto
          .createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
          .update(`${timestamp}.${raw}`)
          .digest("hex")
      : "";
    if (
      !provided ||
      !timestamp ||
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    )
      throw new AppError(400, "Invalid Stripe signature");
    const event = JSON.parse(raw) as {
      type?: string;
      data?: { object?: { id?: string; payment_status?: string } };
    };
    if (
      event.type === "checkout.session.completed" &&
      event.data?.object?.id &&
      event.data.object.payment_status === "paid"
    )
      await prisma.payment.updateMany({
        where: { providerReference: event.data.object.id, status: "PENDING" },
        data: { status: "PAID" },
      });
    return ok(res, { received: true });
  }),
);
