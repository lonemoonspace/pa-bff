// 冻结契约（[gate] P7）。只有 Opus 关口提交可以修改本文件，见 bff/BRIEF.md「契约纪律」。
//
// 管理界面（/admin，只在配置了 Cloudflare Access 时开启）用到的请求与响应形状。
// 规则见 CONTRACT.md 第 2 节「管理界面」与第 8 节。管理接口复用 /v1 的业务逻辑，
// 这里只定义 /admin/api 独有的外形；与 /v1 相同的部分（设备对象、SecretStatus、
// 设置信封、PushLogResult）直接引用或照抄 /v1 的定义。
import { z } from "zod";
import { SourceErrorSchema, SourceStateSchema } from "./dashboard";
import { PushLogPolicySchema, PushLogResultSchema } from "./push";
import { SecretNameSchema, SettingsSchema } from "./settings";

/** GET /admin/api/me：Access JWT 里的身份。 */
export const AdminMeSchema = z.object({ email: z.string() });

/** 与 CONTRACT 第 3 节的 SecretStatus 相同。 */
export const SecretTestSchema = z.object({ ok: z.boolean(), at: z.string(), message: z.string() });
export const SecretStatusSchema = z.object({
  name: SecretNameSchema,
  state: z.enum(["missing", "present", "unreadable"]),
  hint: z.string().nullable(),
  lastTest: SecretTestSchema.nullable(),
});

/** 与 CONTRACT 第 3 节 GET /v1/devices 的设备对象相同，只是没有 self（管理员不是设备）。 */
export const AdminDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "viewer"]),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  hasPushToken: z.boolean(),
});

/** jobs 表一行。 */
export const JobRowSchema = z.object({
  name: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastDurationMs: z.number().int().nullable(),
  failCount: z.number().int(),
  leaseUntil: z.string().nullable(),
});

/**
 * 每个快照来源一行。configMatches：快照的 config_key 是否与当前设置算出的一致
 * （不一致时 dashboard 视其为不存在，见 CONTRACT 第 4 节 snapshots.config_key）。
 * 快照行不存在时 state 为 null、configMatches 为 false。
 */
export const SourceRowSchema = z.object({
  source: z.string(),
  state: SourceStateSchema.nullable(),
  fetchedAt: z.string().nullable(),
  observedAt: z.string().nullable(),
  error: SourceErrorSchema.nullable(),
  configMatches: z.boolean(),
});

/** GET /admin/api/overview。 */
export const OverviewSchema = z.object({
  now: z.string(),
  lastTickAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  settings: z.object({ revision: z.number().int(), updatedAt: z.string().nullable(), updatedBy: z.string().nullable() }),
  devices: z.object({ total: z.number().int(), owners: z.number().int(), withPushToken: z.number().int() }),
  jobs: z.array(JobRowSchema),
  sources: z.array(SourceRowSchema),
  secrets: z.array(SecretStatusSchema),
});

/** GET /admin/api/logs。按 id 降序；nextBefore 为下一页的 before 参数，没有更多时为 null。 */
export const LogEntrySchema = z.object({
  id: z.number().int(),
  at: z.string(),
  level: z.string(),
  source: z.string(),
  message: z.string(),
});
export const LogsResponseSchema = z.object({ entries: z.array(LogEntrySchema), nextBefore: z.number().int().nullable() });

/** GET /admin/api/push-log。result 为解析后的对象；解析失败的行 result 为 null（不让一行坏数据拖垮整页）。 */
export const PushLogEntrySchema = z.object({
  id: z.number().int(),
  at: z.string(),
  policy: PushLogPolicySchema,
  title: z.string(),
  body: z.string(),
  deviceCount: z.number().int(),
  result: PushLogResultSchema.nullable(),
});
export const PushLogResponseSchema = z.object({ entries: z.array(PushLogEntrySchema), nextBefore: z.number().int().nullable() });

/** 列表接口的查询参数：limit 1..100，默认 50；before 为 id（只返回 id < before 的行）。 */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});
export const LogsQuerySchema = PageQuerySchema.extend({
  level: z.enum(["info", "warn", "error"]).optional(),
  source: z.string().max(40).optional(),
});

/** POST /admin/api/push/test：管理员不是设备，只能发给全部设备或指定的一台。 */
export const AdminPushTestRequestSchema = z.object({ deviceId: z.string().min(1).optional() });

/**
 * 设置的导出文件（GET /admin/api/export）与导入（POST /admin/api/import，体为该文件）。
 * **不含任何密钥**：密钥只写不读，换机器时逐个重新填写。
 */
export const SettingsExportSchema = z.object({
  format: z.literal("pa-bff-settings"),
  version: z.literal(1),
  exportedAt: z.string(),
  revision: z.number().int(),
  settings: SettingsSchema,
});
export type SettingsExport = z.infer<typeof SettingsExportSchema>;

/** 可以手动「立即运行」的任务名（与 scheduler 的任务名一致；housekeeping 不开放）。 */
export const RunnableJobSchema = z.enum(["train", "bus", "weather", "traffic_outbound", "traffic_return", "football", "notify"]);

export type Overview = z.infer<typeof OverviewSchema>;
export type LogsResponse = z.infer<typeof LogsResponseSchema>;
export type PushLogResponse = z.infer<typeof PushLogResponseSchema>;
