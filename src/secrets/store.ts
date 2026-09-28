// secrets 表存取：第三方密钥的写入、删除、读明文（供数据源用）、列出状态（供 /v1/secrets 用）。
// 契约见 CONTRACT.md 第 3 节（secrets 四行）与第 1 节表格上方的 SecretStatus 定义。
//
// purpose 固定为 "secret:<name>"，与 secretbox 的 additionalData 绑定，防止密文被挪用到
// 别的用途下解密（例如把 google_routes 的密文冒充 fcm_service_account）。
import { eq } from "drizzle-orm";
import { SecretNameSchema, type SecretName } from "../contract/settings";
import { hintOf, importMasterKey, open, seal } from "../crypto/secretbox";
import { db } from "../db/client";
import { secrets } from "../db/schema";
import type { Env } from "../env";
import { parseServiceAccount } from "../notify/fcm";
import { runTester } from "./testers";

export { SecretNameSchema, type SecretName };

function purposeOf(name: SecretName): string {
  return `secret:${name}`;
}

export interface SecretTestRecord {
  ok: boolean;
  at: string;
  message: string;
}

export interface SecretStatus {
  name: SecretName;
  state: "missing" | "present" | "unreadable";
  hint: string | null;
  lastTest: SecretTestRecord | null;
}

export type PutSecretResult = { ok: true; status: SecretStatus } | { ok: false; code: "invalid_value" };

// fcm_service_account 的值必须是含 project_id / client_email / private_key 的 JSON
// （[gate] P5 修订，第 6.4 节）；校验规则与 notify/fcm.ts 签发访问令牌时的解析规则完全
// 一致（直接复用 parseServiceAccount），不在这里重复定义一份可能走样的 schema。

/** fcm_service_account 必须是合法 JSON 且含所需字段；其余密钥只要求去空白后非空。 */
function isValidValue(name: SecretName, value: string): boolean {
  if (name === "fcm_service_account") {
    return parseServiceAccount(value) !== null;
  }
  return value.trim().length > 0;
}

function parseLastTest(json: string | null): SecretTestRecord | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SecretTestRecord;
  } catch {
    return null;
  }
}

type SecretRow = typeof secrets.$inferSelect;

/**
 * 「行 → SecretStatus」的唯一实现，getSecretStatus 与 listStatus 共用（调度员复核 T7.2：
 * 两处各写一份判定逻辑，安全相关代码迟早会走样）。row 为 undefined 或密文/IV 缺失 → missing；
 * 解密失败（主密钥被换）→ unreadable；否则 present。
 */
async function statusFromRow(name: SecretName, row: SecretRow | undefined, key: CryptoKey): Promise<SecretStatus> {
  if (!row || row.ciphertext === null || row.iv === null) {
    return { name, state: "missing", hint: null, lastTest: null };
  }
  const plaintext = await open(key, { ciphertext: row.ciphertext, iv: row.iv }, purposeOf(name));
  return {
    name,
    state: plaintext === null ? "unreadable" : "present",
    hint: row.hint ?? null,
    lastTest: parseLastTest(row.lastTestJson),
  };
}

/**
 * 写入密钥并立即做一次真实测试，结果落库到 last_test_json。
 * value 不合法（fcm_service_account 格式错误，或其他密钥为空串）时不写库，返回 invalid_value。
 */
export async function putSecret(
  env: Env,
  name: SecretName,
  value: string,
  now: Date = new Date(),
): Promise<PutSecretResult> {
  if (!isValidValue(name, value)) {
    return { ok: false, code: "invalid_value" };
  }

  const key = await importMasterKey(env.MASTER_KEY);
  const sealed = await seal(key, value, purposeOf(name));
  const hint = hintOf(value);
  const updatedAt = now.toISOString();

  // 先落库再测试：即使 tester 抛出未捕获异常（runTester 已兜底吞掉），密钥本身也已经保存，
  // 不会出现「测试失败导致密钥没保存上」这种反直觉行为。
  await db(env)
    .insert(secrets)
    .values({ name, ciphertext: sealed.ciphertext, iv: sealed.iv, hint, lastTestJson: null, updatedAt })
    .onConflictDoUpdate({
      target: secrets.name,
      set: { ciphertext: sealed.ciphertext, iv: sealed.iv, hint, updatedAt },
    });

  const test = await runTester(env, name, value);
  const lastTest: SecretTestRecord = { ok: test.ok, at: updatedAt, message: test.message };
  await db(env).update(secrets).set({ lastTestJson: JSON.stringify(lastTest) }).where(eq(secrets.name, name));

  return { ok: true, status: { name, state: "present", hint, lastTest } };
}

/** 删除密钥；不存在时也当成功处理（幂等），由 API 层根据「删除前是否存在」决定 404 与否。 */
export async function deleteSecret(env: Env, name: SecretName): Promise<void> {
  await db(env).delete(secrets).where(eq(secrets.name, name));
}

/** 供数据源模块读取明文。不存在、或解密失败（主密钥被换）一律返回 null，不抛异常。 */
export async function getSecretPlain(env: Env, name: SecretName): Promise<string | null> {
  const rows = await db(env).select().from(secrets).where(eq(secrets.name, name)).limit(1);
  const row = rows[0];
  if (!row || row.ciphertext === null || row.iv === null) return null;
  const key = await importMasterKey(env.MASTER_KEY);
  return open(key, { ciphertext: row.ciphertext, iv: row.iv }, purposeOf(name));
}

/** 单个密钥的当前状态：不存在→missing；存在但解密失败→unreadable；否则 present。 */
export async function getSecretStatus(env: Env, name: SecretName): Promise<SecretStatus> {
  const rows = await db(env).select().from(secrets).where(eq(secrets.name, name)).limit(1);
  const key = await importMasterKey(env.MASTER_KEY);
  return statusFromRow(name, rows[0], key);
}

/**
 * GET /v1/secrets（与管理界面总览页共用）：固定按 SecretNameSchema 声明的顺序列出全部
 * 密钥的状态。**一条** `SELECT * FROM secrets` 取全部行，在内存里按名字对齐——不逐个
 * 密钥名各查一次（那样 3 个密钥名就是 3 次 D1 查询），管理总览页的 D1 预算（≤6 次）
 * 靠的就是这里只算 1 次。
 */
export async function listStatus(env: Env): Promise<SecretStatus[]> {
  const rows = await db(env).select().from(secrets);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const key = await importMasterKey(env.MASTER_KEY);
  return Promise.all(SecretNameSchema.options.map((name) => statusFromRow(name, byName.get(name), key)));
}

/**
 * POST /v1/secrets/:name/test：用当前存储的密文重新测试一次。
 * 密钥缺失或解密失败时测不了，直接返回当前状态（不写 last_test_json，避免用无意义的失败
 * 覆盖上一次有意义的测试记录）。
 */
export async function retest(env: Env, name: SecretName, now: Date = new Date()): Promise<SecretStatus> {
  const plaintext = await getSecretPlain(env, name);
  if (plaintext === null) {
    return getSecretStatus(env, name);
  }
  const test = await runTester(env, name, plaintext);
  const lastTest: SecretTestRecord = { ok: test.ok, at: now.toISOString(), message: test.message };
  await db(env).update(secrets).set({ lastTestJson: JSON.stringify(lastTest) }).where(eq(secrets.name, name));
  const status = await getSecretStatus(env, name);
  return { ...status, lastTest };
}
