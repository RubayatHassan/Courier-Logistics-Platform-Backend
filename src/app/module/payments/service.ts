import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { redis } from "../../lib/redis.js";
import { AppError } from "../../utils/http.js";
import { changeParcel, lockParcel } from "../parcels/workflow.js";

export type CheckoutSession = {
  id?: string;
  url?: string;
  payment_status?: string;
  status?: string;
  amount_total?: number;
  currency?: string;
  metadata?: { parcelId?: string; paymentId?: string };
  error?: { message?: string };
};

export async function createStripeCheckout(
  parcelId: string,
  customerCheckout = false,
) {
  if (!env.STRIPE_SECRET_KEY)
    throw new AppError(503, "Stripe payments are not configured");
  const { parcel, payment } = await prisma.$transaction(async (tx) => {
    await lockParcel(tx, parcelId);
    const parcel = await tx.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) throw new AppError(404, "Parcel not found");
    if (customerCheckout && parcel.status !== "OUT_FOR_DELIVERY")
      throw new AppError(
        409,
        "Customer payment is only available while out for delivery",
      );
    if (
      ["DELIVERED", "CANCELLED", "RETURNED", "LOST_DAMAGED"].includes(
        parcel.status,
      )
    )
      throw new AppError(409, "Closed parcels cannot start a payment");
    if (Number(parcel.codAmount) <= 0)
      throw new AppError(
        400,
        "Only positive parcel amounts can be paid online",
      );
    if (await tx.payment.findFirst({ where: { parcelId, status: "PAID" } }))
      throw new AppError(409, "This parcel has already been paid");
    const existing = await tx.payment.findFirst({
      where: { parcelId, method: "ONLINE", status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    const payment =
      existing ??
      (await tx.payment.create({
        data: { parcelId, amount: parcel.codAmount, method: "ONLINE" },
      }));
    return { parcel, payment };
  });

  // The durable payment ID survives request retries and ambiguous network failures.
  const body = new URLSearchParams({
    mode: "payment",
    success_url: checkoutSuccessUrl(),
    cancel_url: env.STRIPE_CANCEL_URL,
    "line_items[0][price_data][currency]": "bdt",
    "line_items[0][price_data][product_data][name]": `Parcel ${parcel.trackingNumber}`,
    "line_items[0][price_data][unit_amount]": String(
      Math.round(Number(payment.amount) * 100),
    ),
    "line_items[0][quantity]": "1",
    "metadata[parcelId]": parcel.id,
    "metadata[paymentId]": payment.id,
  });
  // Stripe retains idempotency keys for at least 24h. Do not recreate an ambiguous
  // session after that window; it requires provider reconciliation first.
  if (
    !payment.providerReference &&
    Date.now() - payment.createdAt.getTime() >= 23 * 3600000
  )
    throw new AppError(
      409,
      "Payment requires provider reconciliation before retrying",
    );
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions${payment.providerReference ? `/${encodeURIComponent(payment.providerReference)}` : ""}`,
    {
      method: payment.providerReference ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `parcel-payment-${payment.id}`,
      },
      ...(payment.providerReference ? {} : { body }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const session = (await response.json()) as CheckoutSession;
  if (!response.ok || !session.id)
    throw new AppError(
      502,
      "Stripe checkout could not be created; retry the same parcel payment",
    );
  await prisma.payment.updateMany({
    where: { id: payment.id, providerReference: null },
    data: { providerReference: session.id },
  });
  if (session.status === "expired") {
    await reconcileCheckout(session, "checkout.session.expired");
    throw new AppError(
      409,
      "Previous checkout expired; retry to start a new payment",
    );
  }
  if (session.payment_status === "paid") {
    await reconcileCheckout(session, "checkout.session.completed");
    throw new AppError(409, "This parcel has already been paid");
  }
  if (!session.url) throw new AppError(409, "Payment is being processed");
  return { checkoutSessionId: session.id, checkoutUrl: session.url };
}

function checkoutSuccessUrl() {
  const successUrl = new URL(env.STRIPE_SUCCESS_URL);
  successUrl.searchParams.delete("session_id");
  successUrl.hash = "";
  const url = successUrl.toString();
  // Stripe replaces this literal after checkout; URLSearchParams would encode
  // the braces and prevent the substitution.
  return `${url}${url.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;
}

export async function refreshCheckoutStatus(sessionId: string) {
  if (!env.STRIPE_SECRET_KEY)
    throw new AppError(503, "Stripe payments are not configured");
  const payment = await prisma.payment.findFirst({
    where: { providerReference: sessionId, method: "ONLINE" },
  });
  if (!payment) throw new AppError(404, "Checkout session not found");

  // The webhook is the primary confirmation path. Retrieve Stripe only while
  // the local payment is pending so a delayed webhook cannot strand checkout.
  if (payment.status === "PENDING") {
    let response: Response;
    try {
      response = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
        {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch {
      throw new AppError(502, "Payment status is temporarily unavailable");
    }
    const session = (await response
      .json()
      .catch(() => null)) as CheckoutSession | null;
    if (!response.ok || !session || session.id !== sessionId)
      throw new AppError(502, "Payment status is temporarily unavailable");
    if (session.status === "expired") {
      await reconcileCheckout(session, "checkout.session.expired");
    } else if (session.payment_status === "paid") {
      await reconcileCheckout(session, "checkout.session.completed");
    }
  }

  const current = await prisma.payment.findFirst({
    where: { id: payment.id },
    include: { parcel: { select: { trackingNumber: true, status: true } } },
  });
  if (!current) throw new AppError(404, "Checkout session not found");
  return {
    paymentStatus: current.status,
    parcelStatus: current.parcel.status,
    trackingNumber: current.parcel.trackingNumber,
  };
}

export async function reconcileCheckout(
  session: CheckoutSession,
  eventType: string,
) {
  if (!session.id) throw new AppError(400, "Checkout session ID is required");
  const success =
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(eventType) && session.payment_status === "paid";
  const failure = [
    "checkout.session.expired",
    "checkout.session.async_payment_failed",
  ].includes(eventType);
  if (!success && !failure) return;
  const payment = await prisma.payment.findFirst({
    where: {
      method: "ONLINE",
      OR: [
        { providerReference: session.id },
        ...(session.metadata?.paymentId
          ? [{ id: session.metadata.paymentId, providerReference: null }]
          : []),
      ],
    },
  });
  // A shared Stripe account can send events for other applications.
  if (!payment) return;
  if (
    (session.metadata?.parcelId &&
      session.metadata.parcelId !== payment.parcelId) ||
    session.currency?.toLowerCase() !== "bdt" ||
    session.amount_total !== Math.round(Number(payment.amount) * 100)
  )
    throw new AppError(
      400,
      "Checkout amount, currency or parcel does not match the payment",
    );
  await prisma.$transaction(async (tx) => {
    await lockParcel(tx, payment.parcelId);
    const parcel = await tx.parcel.findUnique({
      where: { id: payment.parcelId },
    });
    if (!parcel) throw new AppError(404, "Parcel not found");
    const changed = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: {
        status: success ? "PAID" : "FAILED",
        providerReference: session.id,
      },
    });
    if (changed.count !== 1) return;
    if (success)
      await tx.payment.updateMany({
        where: { parcelId: payment.parcelId, method: "COD", status: "PENDING" },
        data: { status: "FAILED" },
      });
    if (success && parcel.status === "OUT_FOR_DELIVERY") {
      const deliveredAt = new Date();
      await changeParcel(tx, parcel, { status: "DELIVERED", deliveredAt });
      await tx.deliveryAssignment.updateMany({
        where: { parcelId: parcel.id, completedAt: null },
        data: {
          status: "DELIVERED",
          completedAt: deliveredAt,
          deliveredAt,
          attemptCount: { increment: 1 },
        },
      });
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          status: "DELIVERED",
          note: "Delivery completed after online payment confirmation",
        },
      });
      await tx.auditLog.create({
        data: {
          action: "PARCEL_DELIVERED_AFTER_ONLINE_PAYMENT",
          entity: "Parcel",
          entityId: parcel.id,
          metadata: { paymentId: payment.id, sessionId: session.id },
        },
      });
    }
    await tx.auditLog.create({
      data: {
        action: success ? "ONLINE_PAYMENT_CONFIRMED" : "ONLINE_PAYMENT_FAILED",
        entity: "Payment",
        entityId: payment.id,
        metadata: { sessionId: session.id, eventType },
      },
    });
  });
  if (success && redis.isReady) {
    try {
      const parcel = await prisma.parcel.findUnique({
        where: { id: payment.parcelId },
        select: { trackingNumber: true },
      });
      if (parcel) await redis.del(`tracking:${parcel.trackingNumber}`);
    } catch {
      // Tracking cache expiry is short; its cleanup must not fail the webhook.
    }
  }
}
