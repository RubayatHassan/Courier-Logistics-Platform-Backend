import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { AppError, asyncHandler, ok } from "../../utils/http.js";
import type { AuthenticatedRequest } from "../../utils/types.js";
import {
  type CheckoutSession,
  createStripeCheckout,
  reconcileCheckout,
} from "./service.js";

const checkoutSchema = z.object({ parcelId: z.uuid() });
const customerCheckoutSchema = z.object({
  trackingNumber: z.string().trim().min(1),
  phone: z.string().trim().min(7),
});
export const paymentRouter = Router();

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
      await createStripeCheckout(parcel.id, true),
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
    if (!user || (user.role === "MERCHANT" && !user.merchantId))
      throw new AppError(403, "Merchant context required");
    const parcel = await prisma.parcel.findFirst({
      where: {
        id: parcelId,
        ...(user.role === "MERCHANT"
          ? { merchantId: user.merchantId ?? "__no_access__" }
          : {}),
      },
    });
    if (!parcel) throw new AppError(404, "Parcel not found");
    return ok(
      res,
      await createStripeCheckout(parcel.id),
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
    if (!Buffer.isBuffer(req.body))
      throw new AppError(400, "Raw webhook body is required");
    const raw = req.body.toString("utf8");
    const timestamp = signature.match(/t=(\d+)/)?.[1];
    const signatures = signature
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("v1="))
      .map((part) => part.slice(3));
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
      !timestamp ||
      !signatures.some(
        (provided) =>
          /^[a-f0-9]{64}$/i.test(provided) &&
          crypto.timingSafeEqual(
            Buffer.from(provided, "hex"),
            Buffer.from(expected, "hex"),
          ),
      )
    )
      throw new AppError(400, "Invalid Stripe signature");
    let event: {
      type?: string;
      data?: { object?: CheckoutSession };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      throw new AppError(400, "Invalid webhook JSON");
    }
    if (!event || typeof event !== "object")
      throw new AppError(400, "Invalid webhook event");
    if (event.type && event.data?.object)
      await reconcileCheckout(event.data.object, event.type);
    return ok(res, { received: true });
  }),
);
