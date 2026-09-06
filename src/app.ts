import cookieParser from "cookie-parser";
import express from "express";
import { prisma } from "./infrastructure/prisma.js";
import { notFound, registerCoreMiddleware } from "./middleware/core.js";
import { authRouter } from "./modules/auth/routes.js";
import { parcelRouter } from "./modules/parcels/routes.js";
import { errorHandler, ok } from "./shared/http.js";
import { openApiDocument } from "./docs/openapi.js";
import { paymentRouter } from "./modules/payments/routes.js";

export const app = express();
registerCoreMiddleware(app);
app.use("/api/v1/payments/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) =>
  ok(res, { status: "ok", service: "courier-platform" }),
);
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
app.get("/api/v1/openapi.json", (_req, res) =>
  res.json(openApiDocument),
);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/parcels", parcelRouter);
app.use("/api/v1/payments", paymentRouter);
app.use(notFound);
app.use(errorHandler);
