// 让 vitest-pool-workers 的 cloudflare:test 模块（其 `env` 类型是全局 Cloudflare.Env）
// 拿到我们自己的 Env 类型，外加测试专用的 TEST_MIGRATIONS 绑定。
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {
      /** vitest.config.ts 注入：drizzle-kit 生成的迁移，测试文件自己 applyD1Migrations 应用。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
