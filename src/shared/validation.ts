import type { ZodType } from "zod";
import { AppError } from "./http.js";

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(400, "Validation failed", result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })));
  return result.data;
}
