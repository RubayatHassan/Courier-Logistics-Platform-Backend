import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/courier_test",
      REDIS_URL: "redis://localhost:6379",
      JWT_ACCESS_SECRET: "test-access-secret-at-least-32-characters",
      JWT_REFRESH_SECRET: "test-refresh-secret-at-least-32-characters",
      BCRYPT_SALT_ROUNDS: "10",
      REFRESH_TOKEN_TTL: "1h",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    },
  },
});
