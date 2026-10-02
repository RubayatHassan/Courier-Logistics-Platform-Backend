import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app/config/env.js", () => ({
  env: {
    NODE_ENV: "production",
    APP_URL: "https://courier.test",
    SMTP_HOST: undefined,
  },
}));

import {
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "../src/app/lib/mail.js";

describe("production email", () => {
  it("does not log verification secrets when SMTP is missing", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        sendEmail("recipient@test.com", "Verification", "secret-code"),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("escapes untrusted names in verification and reset messages", () => {
    for (const render of [verificationEmail, passwordResetEmail]) {
      const html = render(
        '<img src=x onerror="attack()">',
        "123456",
        "token",
      ).html;
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
    }
  });
});
