// 冻结契约（[gate] P5）。只有 Opus 关口提交可以修改本文件，见 bff/BRIEF.md「契约纪律」。
//
// 推送相关的共享类型：notify 任务、FCM 客户端、测试推送接口、管理界面（P7）与
// App 的 FirebaseMessagingService（P6 T6.6）都以这里为准。行为规则见 CONTRACT.md 第 6 节。
import { z } from "zod";

/** notify_state.policy 的取值；也是 push_log.policy 的取值（另加 "test"）。 */
export const NotifyPolicySchema = z.enum(["commute_disruption", "morning_brief", "football", "ticket"]);
export type NotifyPolicy = z.infer<typeof NotifyPolicySchema>;

/** 一轮 notify 里评估与发送的固定顺序（与 RefreshWorker 的调用顺序一致）。 */
export const NOTIFY_POLICY_ORDER: readonly NotifyPolicy[] = ["morning_brief", "commute_disruption", "football", "ticket"];

export const PushLogPolicySchema = z.enum(["commute_disruption", "morning_brief", "football", "ticket", "test"]);
export type PushLogPolicy = z.infer<typeof PushLogPolicySchema>;

/** App 端已有的四个通知渠道 id（app/.../notify/NotificationChannels.kt）。 */
export const ChannelIdSchema = z.enum(["commute_disruption", "morning_brief", "football_match", "ticket_expiry"]);
export type ChannelId = z.infer<typeof ChannelIdSchema>;

/** App 已有的深链（app/.../ui/nav/Routes.kt）。 */
export const DeepLinkSchema = z.enum(["personalassistant://home", "personalassistant://football"]);
export type DeepLink = z.infer<typeof DeepLinkSchema>;

/**
 * 每类推送的路由：渠道、深链、FCM android.ttl 与 collapse_key（null 表示不带该字段）。
 * notificationKey 的写法见 PushDataSchema。
 */
export const PUSH_ROUTING: Readonly<
  Record<PushLogPolicy, { channelId: ChannelId; deepLink: DeepLink; ttl: string; collapseKey: string | null }>
> = {
  commute_disruption: { channelId: "commute_disruption", deepLink: "personalassistant://home", ttl: "900s", collapseKey: "commute_disruption" },
  morning_brief: { channelId: "morning_brief", deepLink: "personalassistant://home", ttl: "3600s", collapseKey: "morning_brief" },
  football: { channelId: "football_match", deepLink: "personalassistant://football", ttl: "3600s", collapseKey: null },
  ticket: { channelId: "ticket_expiry", deepLink: "personalassistant://home", ttl: "43200s", collapseKey: null },
  test: { channelId: "morning_brief", deepLink: "personalassistant://home", ttl: "300s", collapseKey: null },
};

/**
 * FCM message.data（FCM 要求所有值都是字符串）。只发 data、不带 notification 块，
 * 由 App 用现有 NotificationSender 按 channelId / deepLink 出通知。
 *
 * notificationKey：App 据此派生 Android 通知 id（同 key 互相替换）——
 *   commute_disruption | morning_brief | football:<matchId> | ticket:TRANSIT | ticket:PARKING | test
 */
export const PushDataSchema = z.object({
  v: z.literal("1"),
  policy: PushLogPolicySchema,
  channelId: ChannelIdSchema,
  deepLink: DeepLinkSchema,
  notificationKey: z.string().min(1),
  title: z.string(),
  body: z.string(),
  /** 发送轮次的 now，ISO-8601 UTC（"...Z"）。 */
  sentAt: z.string(),
});
export type PushData = z.infer<typeof PushDataSchema>;

/** 单台设备一次发送的结果（CONTRACT.md 第 6.4 节的错误映射表）。 */
export const PushOutcomeSchema = z.enum([
  "ok",
  "unregistered",
  "invalid_argument",
  "auth_error",
  "sender_mismatch",
  "rate_limited",
  "upstream_4xx",
  "upstream_5xx",
  "timeout",
  "network",
  "token_unreadable",
  "skipped_auth",
  "skipped_rate_limited",
  "skipped_budget",
  "aborted",
]);
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

/**
 * push_log.result 列（JSON 字符串）与测试推送响应里的 result。
 *
 * status：
 *   sent    目标设备全部 ok（deviceCount > 0）
 *   partial 至少一台 ok、至少一台不是 ok
 *   failed  发出过 FCM 请求，但没有一台 ok
 *   skipped 没有发出任何 FCM 请求；此时 reason 非空
 * reason：只在 skipped 时非空。未发出任何请求时按优先级取：aborted > budget > fcm_auth_failed >
 *   rate_limited > token_unreadable；no_devices / fcm_not_configured 为早退；deliver 兜底捕获的意外
 *   异常为 internal（[gate] P5 抽查补）。
 * codes：除 ok 以外各 outcome 的台数；sent + Σcodes = deviceCount（skipped 且 reason 为
 *   no_devices / fcm_not_configured 时 codes 为 {}；fcm_auth_failed / budget / aborted 时
 *   codes 里按台数记 skipped_auth / skipped_budget / aborted）。
 * unregistered 等于 codes.unregistered（冗余，便于管理界面直接显示）。
 */
export const PushLogResultSchema = z.object({
  status: z.enum(["sent", "partial", "failed", "skipped"]),
  reason: z
    .enum(["no_devices", "fcm_not_configured", "fcm_auth_failed", "budget", "aborted", "rate_limited", "token_unreadable", "internal"])
    .nullable(),
  sent: z.number().int(),
  failed: z.number().int(),
  unregistered: z.number().int(),
  codes: z.record(z.string(), z.number().int()),
});
export type PushLogResult = z.infer<typeof PushLogResultSchema>;

/** POST /v1/push/test 的请求与响应。 */
export const PushTestRequestSchema = z.object({
  scope: z.enum(["self", "all"]).default("self"),
});
export const PushTestResponseSchema = z.object({
  deviceCount: z.number().int(),
  result: PushLogResultSchema,
});
export type PushTestResponse = z.infer<typeof PushTestResponseSchema>;

/** 测试推送的固定文案（不带时刻，便于断言）。 */
export const TEST_PUSH_TITLE = "测试推送";
export const TEST_PUSH_BODY = "这是一条来自 BFF 的测试通知，收到说明推送链路正常。";

/** notify 处理器单轮 FCM 发送上限（不含 oauth 那一次），见 CONTRACT.md 第 6.4 节。 */
export const MAX_FCM_SENDS_PER_RUN = 10;
