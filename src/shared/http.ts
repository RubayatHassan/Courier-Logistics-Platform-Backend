import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function ok<T>(res: Response, data: T, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message: "Operation successful",
    data,
  });
}

export function asyncHandler(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const prismaCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const appError =
    error instanceof ZodError
      ? new AppError(
          400,
          "Validation failed",
          error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        )
      : error instanceof AppError
        ? error
        : prismaCode === "P1001" || prismaCode === "P1002" || prismaCode === "P1017"
          ? new AppError(503, "Database unavailable")
          : prismaCode === "P2021" || prismaCode === "P2022"
            ? new AppError(503, "Database schema is out of date")
            : prismaCode === "P2003"
              ? new AppError(409, "Related record does not exist")
              : new AppError(500, "Internal server error");
  const requestId = (req as Request & { id?: string }).id;
  if (appError.statusCode >= 500) console.error({ error, requestId });
  const errors = Array.isArray(appError.details)
    ? appError.details
    : appError.details
      ? [appError.details]
      : [{ requestId }];
  res.status(appError.statusCode).json({ success: false, message: appError.message, errors });
}
