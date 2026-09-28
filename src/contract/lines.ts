// 冻结契约（[gate] P9）。只有 Opus 关口提交可以修改本文件，见 bff/BRIEF.md「契约纪律」。
//
// 关注线路的选择：GET /v1/lines?stopA=&stopB= 返回同时经过两个站的线路，供 App 与管理界面
// 在选定两个站之后列出可选线路。规则见 CONTRACT.md 第 9 节。
import { z } from "zod";

export const LinesQuerySchema = z.object({
  stopA: z.string().regex(/^NSR:StopPlace:\d+$/),
  stopB: z.string().regex(/^NSR:StopPlace:\d+$/),
});

export const LineSchema = z.object({
  id: z.string(),
  publicCode: z.string(),
  name: z.string(),
  transportMode: z.string(),
});

/** 按 transportMode、再按 publicCode（数字按数值）排序；同一线路 id 只出现一次。 */
export const LinesResponseSchema = z.object({ lines: z.array(LineSchema) });

export type Line = z.infer<typeof LineSchema>;
