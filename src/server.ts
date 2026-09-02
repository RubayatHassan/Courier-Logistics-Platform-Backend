import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectRedis } from "./infrastructure/redis.js";

try {
  await connectRedis();
} catch (error) {
  console.warn("Redis unavailable; continuing without cache", error);
}
app.listen(env.PORT, () =>
  console.log(`Courier platform API listening on port ${env.PORT}`),
);
