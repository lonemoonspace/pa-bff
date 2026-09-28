import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1 迁移在 Node 侧读取（drizzle-kit 生成的 SQL 文件），再作为绑定注入 worker 测试环境，
// 由各测试文件自己在 beforeAll 里调用 applyD1Migrations(env.DB, env.TEST_MIGRATIONS) 应用。
// 相对路径按 vitest 进程的 cwd（`pnpm -C bff test` 即 bff/ 目录）解析。
const migrations = await readD1Migrations("migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // 测试专用的认领码 / 主密钥，不是真实机密。CLAIM_CODE 需要 >= 12 位。
          CLAIM_CODE: "test-claim-code-12345",
          MASTER_KEY: "iN/Gcnuuu887bqnQ9I/yOgc1ZByf+qkaVUaPe4mYOzY=",
        },
      },
    }),
  ],
});
