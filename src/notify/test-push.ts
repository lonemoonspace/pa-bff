// 测试推送的业务逻辑：从 api/push.ts 抽出，供 /v1/push/test 与 /admin/api/push/test
// （T7.3）共用同一条节流 + 投递路径（CONTRACT.md 第 3、6.5 节）。HTTP 状态码由各自路由决定。
import { PushTestResponseSchema, TEST_PUSH_BODY, TEST_PUSH_TITLE, type PushLogResult } from "../contract/push";
import type { Env } from "../env";
import { deliver, toOutgoing } from "./push";

const THROTTLE_MS = 30_000;

/**
 * 30 秒内最多一次的原子占用：把「距上次是否已过 30 秒」写进同一条 SQL 的 WHERE 条件，
 * 两个并发请求（不论来自 /v1 还是 /admin/api，都是同一条 meta.push_test_at）只有一个能
 * 真正写入，与 refresh.ts 的 tryAcquireRefreshThrottle 同一写法。
 */
async function tryAcquirePushTestThrottle(env: Env, now: Date): Promise<boolean> {
  const nowMs = String(now.getTime());
  const earliestAllowedMs = String(now.getTime() - THROTTLE_MS);
  const row = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('push_test_at', ?1)
     ON CONFLICT(key) DO UPDATE SET value = ?1
     WHERE meta.value IS NULL OR CAST(meta.value AS INTEGER) <= ?2
     RETURNING value`,
  )
    .bind(nowMs, earliestAllowedMs)
    .first<{ value: string }>();
  return row !== null;
}

export type RunTestPushResult =
  | { ok: true; deviceCount: number; result: PushLogResult }
  | { ok: false; code: "too_soon" | "no_push_token" | "fcm_not_configured" };

/**
 * 占用 meta.push_test_at → deliver（policy = "test"，文案固定）。
 * deviceIds 为 undefined 时发给全部有 push token 的设备；传入数组则只发给这些设备
 * （管理接口指定单台设备，或 /v1 的 scope = "self" 只发本机）。
 */
export async function runTestPush(env: Env, now: Date, deviceIds?: string[]): Promise<RunTestPushResult> {
  const acquired = await tryAcquirePushTestThrottle(env, now);
  if (!acquired) {
    return { ok: false, code: "too_soon" };
  }

  const outgoing = toOutgoing("test", { title: TEST_PUSH_TITLE, body: TEST_PUSH_BODY });
  const opts = deviceIds !== undefined ? { deviceIds } : undefined;

  const [result] = await deliver(env, [outgoing], now, AbortSignal.timeout(20_000), opts);
  if (!result) {
    // deliver 对非空 items 数组总是返回等长结果；这个分支只是满足类型检查，不会真正触发。
    return { ok: false, code: "fcm_not_configured" };
  }

  if (result.status === "skipped" && result.reason === "no_devices") {
    return { ok: false, code: "no_push_token" };
  }
  if (result.status === "skipped" && result.reason === "fcm_not_configured") {
    return { ok: false, code: "fcm_not_configured" };
  }

  // 已排除 no_devices / fcm_not_configured 两种「deviceCount 无意义」的早退分支，其余情况下
  // sent + failed + unregistered 恰好等于本次实际锁定的目标设备数。
  const deviceCount = result.sent + result.failed + result.unregistered;
  const body = PushTestResponseSchema.parse({ deviceCount, result });
  return { ok: true, deviceCount: body.deviceCount, result: body.result };
}
