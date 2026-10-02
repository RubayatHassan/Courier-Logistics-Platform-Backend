import cookieParser from "cookie-parser";
import express from "express";
import { prisma } from "./app/lib/prisma.js";
import { notFound, registerCoreMiddleware } from "./app/middleware/core.js";
import { authRouter } from "./app/module/auth/auth.route.js";
import { customerRouter } from "./app/module/customers/customer.route.js";
import { operationsRouter } from "./app/module/operations/operations.route.js";
import { parcelRouter } from "./app/module/parcels/parcel.route.js";
import { paymentRouter } from "./app/module/payments/payment.route.js";
import { errorHandler, ok } from "./app/utils/http.js";

export const app = express();
registerCoreMiddleware(app);
app.use(
  "/api/v1/payments/stripe/webhook",
  express.raw({ type: "application/json" }),
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) =>
  ok(res, { status: "ok", service: "courier-platform" }),
);
app.get("/payment/success", async (req, res, next) => {
  const sessionId =
    typeof req.query.session_id === "string" ? req.query.session_id : "";
  let paymentConfirmed = false;
  if (sessionId) {
    try {
      paymentConfirmed = Boolean(
        await prisma.payment.findFirst({
          where: {
            providerReference: sessionId,
            method: "ONLINE",
            status: "PAID",
          },
          select: { id: true },
        }),
      );
    } catch (error) {
      return next(error);
    }
  }
  const escapedSessionId = sessionId.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment successful</title></head>
  <body style="font-family:Arial,sans-serif;max-width:640px;margin:80px auto;padding:24px;text-align:center">
    <h1>${paymentConfirmed ? "Payment successful" : "Payment verification pending"}</h1>
    <p>${paymentConfirmed ? "Your parcel payment was received successfully." : "Payment is being verified. Please try again shortly."}</p>
    ${sessionId ? `<p>Payment reference: <code>${escapedSessionId}</code></p>` : ""}
  </body>
</html>`);
});
app.get("/payment/cancel", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment cancelled</title></head>
  <body style="font-family:Arial,sans-serif;max-width:640px;margin:80px auto;padding:24px;text-align:center">
    <h1>Payment cancelled</h1>
    <p>Your payment was cancelled. You can try again when the parcel is out for delivery.</p>
  </body>
</html>`);
});
app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return ok(res, { status: "ready" });
  } catch {
    return res
      .status(503)
      .json({ success: false, message: "Database unavailable", errors: [] });
  }
});
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/parcels", parcelRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/customers", customerRouter);
app.use("/api/v1/operations", operationsRouter);
app.use(notFound);
app.use(errorHandler);
