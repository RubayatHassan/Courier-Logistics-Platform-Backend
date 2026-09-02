import type { NextFunction, Request, Response } from "express";

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
  return res.status(statusCode).json({ success: true, data });
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
  const appError =
    error instanceof AppError
      ? error
      : new AppError(500, "Internal server error");
  const requestId = (req as Request & { id?: string }).id;
  if (appError.statusCode >= 500) console.error({ error, requestId });
  res.status(appError.statusCode).json({
    success: false,
    error: {
      message: appError.message,
      details: appError.details,
      requestId,
    },
  });
}
