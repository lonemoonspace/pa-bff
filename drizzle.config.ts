// drizzle-kit 生成迁移用的配置：`pnpm -C bff db:generate`。
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
