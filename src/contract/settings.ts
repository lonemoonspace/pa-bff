// 冻结契约（G1）。只有 Opus 关口提交可以修改本文件，见 bff/BRIEF.md「契约纪律」。
//
// v1 的设置结构与 Android v5 的 UserSettings（app/.../domain/Models.kt）逐字段对应，
// 这样 App「上传现有设置」就是一次直接拷贝，BFF 的计算结果也能与 App 本地逻辑逐一对照。
// 唯一的差别：googleApiKey 不在这里——所有第三方密钥都走 /v1/secrets，只写不读。
import { z } from "zod";

/** "HH:mm"。无效值不在这里拒绝：与 App 行为一致，由 domain/windows 回退到默认窗口。 */
const hhmm = z.string().max(5);

/** 车票截止时间："yyyy-MM-ddTHH:mm"（兼容旧的纯日期 "yyyy-MM-dd"），空串表示未填写。 */
const ticketUntil = z.string().max(19);

/** Entur 的 NSR / 线路 id，例如 "NSR:StopPlace:12345"、"RUT:Line:123"。空串表示未设置。 */
const enturId = z.string().max(80);

export const SettingsSchema = z.object({
  originAddress: z.string().max(200).default(""),
  destinationAddress: z.string().max(200).default(""),
  // [gate] P9：默认值由具体站名改为空串——不替用户猜车站，未选择时火车来源为 not_configured。
  // 已保存的设置不受影响（App 与 BFF 都把全部字段写进存储，见 CONTRACT 第 9 节）。
  originStation: z.string().max(80).default(""),
  destStation: z.string().max(80).default(""),
  workWindowStart: hhmm.default("07:00"),
  workWindowEnd: hhmm.default("10:00"),
  returnWindowStart: hhmm.default("14:00"),
  returnWindowEnd: hhmm.default("16:00"),
  notifyCommuteDisruption: z.boolean().default(false),
  notifyFootballMatch: z.boolean().default(false),
  notifyMorningBrief: z.boolean().default(false),
  transitPassUntil: ticketUntil.default(""),
  parkingPassUntil: ticketUntil.default(""),
  notifyTicketExpiry: z.boolean().default(false),
  // [gate] P9 关注线路：首页一张卡片，显示两个站之间这条线路双向的最近几班（取代写死的公交卡片）。
  // 六个字段全部非空才算已配置；否则 dashboard 的 bus 来源为 not_configured。
  // lineId 用于 Entur whiteListed 过滤，lineCode 只用于显示；站名只用于显示，匹配一律按 id。
  watchedLineId: enturId.default(""),
  watchedLineCode: z.string().max(20).default(""),
  watchedStopAId: enturId.default(""),
  watchedStopAName: z.string().max(80).default(""),
  watchedStopBId: enturId.default(""),
  watchedStopBName: z.string().max(80).default(""),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** 全部字段取默认值的设置；BFF 首次启动时写入 settings 表的初始行。 */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** 第三方密钥的名字。Miniflux / LLM 不在 Cloudflare 版范围内（新闻留在手机上）。 */
export const SecretNameSchema = z.enum(["google_routes", "football_data", "fcm_service_account"]);
export type SecretName = z.infer<typeof SecretNameSchema>;
