import { describe, expect, it } from "vitest";
import { ok } from "../src/shared/http.js";

describe("HTTP response envelope", () => {
  it("returns the required success shape", () => {
    const payload: Record<string, unknown> = {};
    const response = { status: () => response, json: (value: unknown) => { Object.assign(payload, value); return response; } } as never;
    ok(response, { id: "demo" });
    expect(payload).toEqual({ success: true, message: "Operation successful", data: { id: "demo" } });
  });
});
