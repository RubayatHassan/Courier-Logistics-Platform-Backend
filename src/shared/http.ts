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

export function ok<T>(
  res: Response,
  data: T,
  statusCode = 200,
  message = "Operation successful",
) {
  return res.status(statusCode).json({
    success: true,
    message,
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
  const prismaMeta =
    typeof error === "object" && error !== null && "meta" in error
      ? (error as { meta?: { target?: unknown; field_name?: unknown } }).meta
      : undefined;
  const uniqueTarget = Array.isArray(prismaMeta?.target)
    ? prismaMeta.target.join(", ")
    : typeof prismaMeta?.target === "string"
      ? prismaMeta.target
      : "field";
  const relationTarget =
    typeof prismaMeta?.field_name === "string"
      ? prismaMeta.field_name
      : "related record";
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
        : prismaCode === "P1001" ||
            prismaCode === "P1002" ||
            prismaCode === "P1017"
          ? new AppError(503, "Database unavailable")
          : prismaCode === "P2007" || prismaCode === "P2021" || prismaCode === "P2022"
            ? new AppError(503, "Database schema is out of date")
            : prismaCode === "P2003"
              ? new AppError(409, "Related record does not exist", [
                  { field: relationTarget, message: "Related record does not exist" },
                ])
              : prismaCode === "P2025"
                ? new AppError(404, "Requested record was not found")
              : prismaCode === "P2002"
                ? new AppError(409, "A record with the same unique value already exists", [
                    {
                      field: uniqueTarget,
                      message: `The value for ${uniqueTarget} is already in use`,
                    },
                  ])
                : new AppError(500, "Internal server error");
  const requestId = (req as Request & { id?: string }).id;
  if (appError.statusCode >= 500) console.error({ error, requestId });
  const errors = Array.isArray(appError.details)
    ? appError.details
    : appError.details
      ? [appError.details]
      : [{ requestId }];
  const errorsWithRequestId = errors.map((item) =>
    typeof item === "object" && item !== null
      ? { ...item, requestId }
      : { message: item, requestId },
  );
  res
    .status(appError.statusCode)
    .json({ success: false, message: appError.message, errors: errorsWithRequestId });
}
