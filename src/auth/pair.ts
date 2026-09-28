// 配对码：owner 生成一次性 8 位 Crockford base32 码（10 分钟有效），
// 其他设备用它换取 viewer 令牌。契约见 CONTRACT.md 第 2、3 节（G2 安全审查修订版）。
import { z } from "zod";
import type { Env } from "../env";
import { generateDeviceToken, generatePairCode, sha256Hex } from "./tokens";

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

export interface PairCodeCreated {
  code: string;
  expiresAt: string;
}

/** POST /v1/devices/pair-codes：owner 生成配对码，只存哈希。 */
export async function createPairCode(env: Env, createdBy: string, now: Date = new Date()): Promise<PairCodeCreated> {
  const code = generatePairCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO pair_codes (code_hash, expires_at, used_at, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(codeHash, expiresAt, createdBy)
    .run();
  return { code, expiresAt };
}

const RedeemRequestSchema = z.object({
  code: z.string(),
  deviceName: z.string().min(1).max(40),
});

export type RedeemResult =
  | { status: 201; body: { deviceId: string; token: string; role: "viewer" } }
  | { status: 401; code: "bad_pair_code"; message: string };

/**
 * 规范化用户输入的配对码（G2 修复 8）：转大写、I/L→1、O→0、去掉空格和连字符。
 * 方便用户手抄配对码时不必严格区分大小写、易混淆字符和分隔符。
 */
export function normalizePairCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/**
 * POST /v1/pair/redeem：把配对码兑换成 viewer 令牌。
 *
 * 单次使用的原子性（G2 修复 3，不依赖 changes()）：核销时把「本次核销」写成一个唯一值
 * ——用随机 id 拼进 used_at 里（`<时间戳>#<核销 id>`）——而不是只写时间戳。插入设备的
 * 语句以「pair_codes 这一行当前的 used_at 就是本次核销写下的那个唯一值」为条件（子查询
 * 比较，不用 SQL 的 changes()）。两个并发兑换请求各自的事务串行提交时，先提交的把
 * used_at 从 NULL 改成了自己的核销 id，随后子查询读到的是自己的值，插入成功；后提交的
 * 请求执行 UPDATE 时 used_at 已非空，不会再被改写，子查询读到的是对方的核销 id，跟自己
 * 的不相等，插入不执行，返回 401。
 */
export async function redeemPairCode(env: Env, rawBody: unknown, now: Date = new Date()): Promise<RedeemResult> {
  const parsed = RedeemRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 401, code: "bad_pair_code", message: "配对码不正确" };
  }
  const { deviceName } = parsed.data;
  const code = normalizePairCode(parsed.data.code);
  const codeHash = await sha256Hex(code);
  const nowIso = now.toISOString();
  const redemptionId = crypto.randomUUID();
  const usedAtMarker = `${nowIso}#${redemptionId}`;

  const deviceId = crypto.randomUUID();
  const token = generateDeviceToken();
  const tokenHash = await sha256Hex(token);

  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
    ).bind(usedAtMarker, codeHash, nowIso),
    env.DB.prepare(
      `INSERT INTO devices (id, name, role, token_hash, created_at)
       SELECT ?, ?, 'viewer', ?, ?
       WHERE (SELECT used_at FROM pair_codes WHERE code_hash = ?) = ?`,
    ).bind(deviceId, deviceName, tokenHash, nowIso, codeHash, usedAtMarker),
  ]);

  const inserted = results[1]?.meta.changes === 1;
  if (!inserted) {
    return { status: 401, code: "bad_pair_code", message: "配对码不正确、已过期或已被使用" };
  }
  return { status: 201, body: { deviceId, token, role: "viewer" } };
}
