import { describe, expect, it } from "vitest";
import { openApiDocument } from "../src/docs/openapi.js";

describe("API contract", () => {
  it("documents authentication, parcels, and real payment endpoints", () => {
    expect(openApiDocument.paths["/auth/google"]).toBeDefined();
    expect(openApiDocument.paths["/parcels"]).toBeDefined();
    expect(openApiDocument.paths["/payments/stripe/checkout"]).toBeDefined();
    expect(openApiDocument.components.schemas.Success).toBeDefined();
    expect(openApiDocument.components.schemas.Error).toBeDefined();
  });
});
