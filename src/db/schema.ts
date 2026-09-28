// Drizzle 表结构。与 CONTRACT.md 第 4 节逐列一致，不增不减。
// 时间列一律是 ISO-8601 UTC 字符串（"...Z"），存成 TEXT，便于字典序比较。
import { sql } from "drizzle-orm";
import { check, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** meta：key/value 小表，存 claimed_at / claim_fail_count / claim_fail_window_start / claim_locked_until / last_tick_at 等。 */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/** settings：单行表（id 恒为 1），json 是整份 Settings 的序列化，revision 用于乐观锁。 */
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    json: text("json"),
    revision: integer("revision"),
    updatedAt: text("updated_at"),
    updatedBy: text("updated_by"),
  },
  (table) => [check("settings_id_check", sql`${table.id} = 1`)],
);

/** secrets：第三方密钥密文（secretbox 输出），只写不读——读出的是 hint。 */
export const secrets = sqliteTable("secrets", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext"),
  iv: text("iv"),
  hint: text("hint"),
  lastTestJson: text("last_test_json"),
  updatedAt: text("updated_at"),
});

/** devices：已认领 / 已配对的设备（owner / viewer）。 */
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name"),
  role: text("role"),
  tokenHash: text("token_hash").unique(),
  pushTokenCt: text("push_token_ct"),
  pushTokenIv: text("push_token_iv"),
  createdAt: text("created_at"),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
});

/** pair_codes：owner 生成的一次性配对码（存哈希）。 */
export const pairCodes = sqliteTable("pair_codes", {
  codeHash: text("code_hash").primaryKey(),
  expiresAt: text("expires_at"),
  usedAt: text("used_at"),
  createdBy: text("created_by"),
});

/** jobs：调度器的任务状态（租约、退避、下一次运行时间）。 */
export const jobs = sqliteTable("jobs", {
  name: text("name").primaryKey(),
  nextRunAt: text("next_run_at"),
  leaseUntil: text("lease_until"),
  lastRunAt: text("last_run_at"),
  lastStatus: text("last_status"),
  lastDurationMs: integer("last_duration_ms"),
  failCount: integer("fail_count").default(0),
});

/** snapshots：各数据源最近一次成功/失败结果，configKey 是生成快照时设置的指纹。 */
export const snapshots = sqliteTable("snapshots", {
  source: text("source").primaryKey(),
  json: text("json"),
  state: text("state"),
  fetchedAt: text("fetched_at"),
  observedAt: text("observed_at"),
  errorJson: text("error_json"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  configKey: text("config_key"),
});

/** notify_state：各推送策略的去抖/去重状态。 */
export const notifyState = sqliteTable("notify_state", {
  policy: text("policy").primaryKey(),
  stateJson: text("state_json"),
  version: integer("version"),
});

/** push_log：每次推送尝试的记录，供管理界面查看。 */
export const pushLog = sqliteTable("push_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at"),
  policy: text("policy"),
  title: text("title"),
  body: text("body"),
  deviceCount: integer("device_count"),
  result: text("result"),
});

/** logs：结构化日志，供管理界面查看。 */
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at"),
  level: text("level"),
  source: text("source"),
  message: text("message"),
});

/** rate_buckets：令牌桶限流状态（football-data 等）。 */
export const rateBuckets = sqliteTable("rate_buckets", {
  name: text("name").primaryKey(),
  tokens: real("tokens"),
  updatedAt: text("updated_at"),
});
