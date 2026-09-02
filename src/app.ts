import cookieParser from "cookie-parser";
import express from "express";
import { prisma } from "./infrastructure/prisma.js";
import { notFound, registerCoreMiddleware } from "./middleware/core.js";
import { authRouter } from "./modules/auth/routes.js";
import { parcelRouter } from "./modules/parcels/routes.js";
import { errorHandler, ok } from "./shared/http.js";

export const app = express();
registerCoreMiddleware(app);
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
      .json({ success: false, error: { message: "Database unavailable" } });
  }
});
app.get("/api/v1/openapi.json", (_req, res) =>
  res.json({
    openapi: "3.0.3",
    info: { title: "Courier Logistics API", version: "1.0.0" },
    servers: [{ url: "/api/v1" }],
    paths: {
      "/auth/login": { post: { summary: "Login" } },
      "/parcels": {
        get: { summary: "List parcels" },
        post: { summary: "Create parcel" },
      },
      "/parcels/track/{trackingNumber}": {
        get: { summary: "Public tracking" },
      },
    },
  }),
);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/parcels", parcelRouter);
app.use(notFound);
app.use(errorHandler);
