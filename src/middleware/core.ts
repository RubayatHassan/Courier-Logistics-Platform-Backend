import crypto from "node:crypto";
import cors from "cors";
import type { Express, NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { env } from "../config/env.js";
import { AppError } from "../shared/http.js";
import type { AuthenticatedRequest } from "../shared/types.js";

export function registerCoreMiddleware(app: Express) {
  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).id =
      req.header("x-request-id") ?? crypto.randomUUID();
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("x-request-id", (req as AuthenticatedRequest).id);
    next();
  });
}

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, `Route not found: ${req.method} ${req.path}`));
}
