// POST /v1/claim：认领设备为 owner。契约见 CONTRACT.md 第 2、3 节（G2 安全审查修订版）。
//
// 失败计数（G2 修复 1）：比较认领码之前，先用一条 INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING 原子地「占用一次尝试」，15 分钟滑动窗口的判断、超阈值上锁都写在同一条 SQL
// 里（见 occupyClaimAttempt）。这样多个并发请求各自执行这条语句时，SQLite 单连接顺序
// 提交能保证计数不被绕过——不像之前先 SELECT 再 UPDATE 两步，中间有窗口能被并发穿过。
//
// 原子性说明（认领条件更新 + 插入设备必须在同一次成功/失败中一起生效，G2 修复 3）：
// 不再依赖 SQLite 的 changes()（它读的是“同一连接里上一条已完成语句”的影响行数，
// 语义上容易在不同执行环境/批次结构下出问题）。改为把「谁赢得了认领」这件事本身
// 写成可判断的落库状态：
//   0) 确保 meta.claimed_at / meta.claimed_by 这两行存在（迁移不预置，用 ON CONFLICT
//      DO NOTHING 补一次，不改变已有值）；
//   1) UPDATE meta SET value=<now> WHERE key='claimed_at' AND value IS NULL
//   2) UPDATE meta SET value=<新设备 id> WHERE key='claimed_by' AND value IS NULL
//   3) INSERT INTO devices (...) SELECT ... WHERE
//        (SELECT value FROM meta WHERE key='claimed_by') = <新设备 id>
// 两个并发请求在各自的 batch（= 各自一个事务）里执行时，D1/SQLite 按事务顺序串行提交：
// 先提交的那个事务把 claimed_by 从 NULL 改成了自己的设备 id，随后的子查询取到的正好是
// 自己的 id，插入成功；后提交的事务执行第 2 条语句时，claimed_by 已经非空（是对方的
// id），UPDATE 影响 0 行、值不变，第 3 条语句里的子查询读到的是对方的 id，跟自己的 id
// 不相等，INSERT 完全不执行。最终只需要看第 3 条语句（插入设备）的 D1Result.meta.changes
// 是否为 1，就能判断这次请求是不是赢家；这是最终落库状态本身，不是对某条语句返回值的
// 二次猜测。
import { z } from "zod";
import type { Env } from "../env";
import { generateDeviceToken, sha256Hex, timingSafeEqualString } from "./tokens";

const CLAIM_FAIL_WINDOW_MS = 15 * 60 * 1000;
// 契约：15 分钟窗口内第 6 次起返回 429 并锁定，即累计到 6 次时触发上锁。
const CLAIM_FAIL_THRESHOLD = 6;
const CLAIM_LOCK_MS = 15 * 60 * 1000;
const CLAIM_CODE_MIN_LENGTH = 12;
const CLAIM_RATE_KEY = "claim_rate";

const DeviceNameSchema = z.string().min(1).max(40);
const ClaimCodeSchema = z.string();

export type ClaimResult =
  | { status: 201; body: { deviceId: string; token: string; role: "owner" } }
  | { status: 401; code: "bad_claim_code"; message: string }
  | { status: 409; code: "already_claimed"; message: string }
  | { status: 422; code: "invalid_device_name"; message: string }
  | { status: 429; code: "locked"; message: string }
  | { status: 503; code: "not_configured"; message: string };

interface ClaimRateState {
  windowStart: number;
  count: number;
  lockedUntil: number | null;
}

/**
 * 原子地占用一次认领尝试（G2 修复 1）：单条 SQL 完成「读当前窗口状态 → 判断是否仍在
 * 上锁期 → 判断窗口是否已过期需要重置 → 计数 +1 → 达到阈值则上锁」，用 RETURNING 拿到
 * 落库后的最终状态。窗口状态整体存成一个 JSON 字符串塞进 meta 表的一行（key='claim_rate'），
 * 不需要新增表或列。
 */
async function occupyClaimAttempt(env: Env, now: Date): Promise<ClaimRateState> {
  const nowMs = now.getTime();
  const initial: ClaimRateState = { windowStart: nowMs, count: 1, lockedUntil: null };

  const row = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = (
       CASE
         WHEN CAST(json_extract(meta.value, '$.lockedUntil') AS INTEGER) > ?
           THEN meta.value
         WHEN ? - CAST(json_extract(meta.value, '$.windowStart') AS INTEGER) >= ?
           THEN json_object('windowStart', ?, 'count', 1, 'lockedUntil', NULL)
         ELSE json_object(
           'windowStart', json_extract(meta.value, '$.windowStart'),
           'count', json_extract(meta.value, '$.count') + 1,
           'lockedUntil', CASE
             WHEN json_extract(meta.value, '$.count') + 1 >= ? THEN ?
             ELSE NULL
           END
         )
       END
     )
     RETURNING value`,
  )
    .bind(
      CLAIM_RATE_KEY,
      JSON.stringify(initial),
      nowMs,
      nowMs,
      CLAIM_FAIL_WINDOW_MS,
      nowMs,
      CLAIM_FAIL_THRESHOLD,
      nowMs + CLAIM_LOCK_MS,
    )
    .first<{ value: string }>();

  return JSON.parse(row?.value ?? JSON.stringify(initial)) as ClaimRateState;
}

/** 认领成功后清零失败计数（不再依赖旧的分散 key，直接删掉整行）。 */
async function clearClaimFailures(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(CLAIM_RATE_KEY).run();
}

function extractClaimCode(rawBody: unknown): string {
  const parsed = ClaimCodeSchema.safeParse(
    typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>).claimCode : undefined,
  );
  return parsed.success ? parsed.data : "";
}

/**
 * 处理 POST /v1/claim。
 * 顺序（G2 修复 7）：先校验认领码，认领码正确后才校验 deviceName——
 * deviceName 不合法返回 422 invalid_device_name，且不计入失败次数。
 */
export async function claim(env: Env, rawBody: unknown, now: Date = new Date()): Promise<ClaimResult> {
  if (!env.CLAIM_CODE || env.CLAIM_CODE.length < CLAIM_CODE_MIN_LENGTH) {
    return { status: 503, code: "not_configured", message: "尚未配置认领码" };
  }

  // 比较认领码之前，先原子占用一次尝试（G2 修复 1）：这一步本身就完成了窗口判断和上锁。
  const rate = await occupyClaimAttempt(env, now);
  if (rate.lockedUntil !== null && rate.lockedUntil > now.getTime()) {
    return { status: 429, code: "locked", message: "认领码错误次数过多，请稍后再试" };
  }

  const claimCodeInput = extractClaimCode(rawBody);
  const ok = await timingSafeEqualString(claimCodeInput, env.CLAIM_CODE);
  if (!ok) {
    return { status: 401, code: "bad_claim_code", message: "认领码不正确" };
  }

  await clearClaimFailures(env);

  const deviceNameRaw =
    typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>).deviceName : undefined;
  const deviceNameParsed = DeviceNameSchema.safeParse(deviceNameRaw);
  if (!deviceNameParsed.success) {
    return { status: 422, code: "invalid_device_name", message: "设备名称不合法" };
  }
  const deviceName = deviceNameParsed.data;

  const deviceId = crypto.randomUUID();
  const token = generateDeviceToken();
  const tokenHash = await sha256Hex(token);
  const nowIso = now.toISOString();

  // G3 修复 8：先写 claimed_by、再写 claimed_at，且两条语句互相校验对方——避免「claimed_at
  // 已经被写过、claimed_by 还没写」这类遗留状态（例如迁移/手工操作留下的半成品）被这次请求
  // 绕过检查、单方面把 claimed_by 补上，最终两个字段各自来自不同的「认领事件」。
  //   1) 写 claimed_by 的条件里同时要求 claimed_at 仍是 NULL：claimed_at 已经非空
  //      （遗留状态）时，claimed_by 保持不变，本次请求肯定拿不到「赢家」身份；
  //   2) 写 claimed_at 的条件要求 claimed_by 已经等于本设备：只有真正刚刚赢得 claimed_by
  //      的这次请求才能顺带把 claimed_at 也写成功，不会出现「只写了一半」的组合。
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('claimed_at', NULL) ON CONFLICT(key) DO NOTHING"),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('claimed_by', NULL) ON CONFLICT(key) DO NOTHING"),
    env.DB.prepare(
      `UPDATE meta SET value = ? WHERE key = 'claimed_by' AND value IS NULL
         AND (SELECT value FROM meta WHERE key = 'claimed_at') IS NULL`,
    ).bind(deviceId),
    env.DB.prepare(
      `UPDATE meta SET value = ? WHERE key = 'claimed_at' AND value IS NULL
         AND (SELECT value FROM meta WHERE key = 'claimed_by') = ?`,
    ).bind(nowIso, deviceId),
    env.DB.prepare(
      `INSERT INTO devices (id, name, role, token_hash, created_at)
       SELECT ?, ?, 'owner', ?, ?
       WHERE (SELECT value FROM meta WHERE key = 'claimed_by') = ?`,
    ).bind(deviceId, deviceName, tokenHash, nowIso, deviceId),
  ]);

  const inserted = results[4]?.meta.changes === 1;
  if (!inserted) {
    return { status: 409, code: "already_claimed", message: "已经被认领过" };
  }

  return { status: 201, body: { deviceId, token, role: "owner" } };
}
