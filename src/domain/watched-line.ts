// 从 app/.../domain/WatchedLinePolicy.kt 移植：首页「关注线路」卡片的选班纯逻辑，取代
// v1 写死线路与两端站的旧公交卡片（domain/bus280.ts，已删除）。卡上只允许改 domain/watched-line.ts、
// jobs/bus.ts、sources/entur.ts（只追加）、sources/entur-lines.ts、api/lines.ts、api/app.ts
// （只挂载）、snapshot/config-keys.ts（bus 键），因此类型直接从冻结契约 contract/dashboard.ts
// 派生（z.infer），不新增契约内容。
//
// 方向判定为什么不能再靠终点站名字符串匹配：旧版 Bus280Policy 靠
// destinationDisplay.frontText 是否等于对端站名判定方向——这依赖对「这条线路终点文本长
// 什么样」的预先了解，换一条用户自己选的线路就得重新维护一套终点文案表，而且真实线路
// 存在「同一线路号但中途折返」的区间车，文本上可能仍是对端方向却根本到不了对端站。换成
// 设置里任意一条线路后，唯一对任何线路都成立、不需要预先了解终点文案的判定是看这一班次
// 的**站序**里对端站是否出现、且位置在本站之后（见 passesThrough）：只开到中途、不经过
// 对端站的区间车会在站序里找不到对端站 id 而被排除；反向班次的站序里本站本身会排在对端
// 站之后，同样被排除（CONTRACT 第 9 节）。
import { z } from "zod";
import { BusBoardSchema, BusDepartureSchema, type BusStatus } from "../contract/dashboard";
import { osloIsoOffset } from "../util/time";

export type BusBoard = z.infer<typeof BusBoardSchema>;
export type BusDeparture = z.infer<typeof BusDepartureSchema>;

/** 每个方向缓存多少班次（给 visibleBoards 留出余量：前几班开走后不必等下一次刷新）。 */
export const FETCH_LIMIT = 6;

/** 每个方向展示几班（「下一班 + 再下一班」，能看出间隔）。 */
export const VISIBLE_LIMIT = 2;

/** 关注线路里的一个站点：id 用于方向判定，name 只用于展示。 */
export interface WatchedStop {
  id: string;
  name: string;
}

/** 关注线路的完整配置（对应 Settings 的六个 watchedLine* 字段）。 */
export interface WatchedLineConfig {
  lineCode: string;
  stopA: WatchedStop;
  stopB: WatchedStop;
}

/**
 * 站序里的一站（[gate] P10 修正）：设置里的站可能是车站的**父** stop place（多模式枢纽），
 * 而班次站序里给出的是**子** stop place（例如站台）；parentId 是该子站的父站 id（没有父站
 * 时为 null/undefined）。CONTRACT 第 9 节「站的匹配」：一项「是 X」当且仅当 `id === X` 或
 * `parentId === X`。
 */
export interface QuayRef {
  id: string;
  parentId?: string | null;
}

/**
 * 一条 Entur 到站记录里本策略关心的部分。任务处理器负责把网络 DTO
 * （src/sources/entur.ts 的 WatchedLineStopDeparture）映射成本类型，领域层因此不依赖
 * 任何网络类型。
 *
 * quays 是该班次按顺序经过的站（Entur serviceJourney.quays[].stopPlace），方向判定只看它
 * （见 passesThrough），不看 destName。
 */
export interface BusCall {
  line?: string | null;
  destName?: string | null;
  aimedDep?: string | null;
  expectedDep?: string | null;
  realtime?: boolean;
  cancelled?: boolean;
  quays?: QuayRef[];
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 与 Java Duration.toMinutes() 一致：截断（不是四舍五入），并 coerceAtLeast(0)。 */
function delayMinutes(aimed: string | null | undefined, expected: string | null | undefined): number | null {
  const a = parseIso(aimed);
  const e = parseIso(expected);
  if (!a || !e) return null;
  const minutes = Math.trunc((e.getTime() - a.getTime()) / 60_000);
  return Math.max(minutes, 0);
}

function effectiveDep(call: BusCall): string | null {
  const expected = call.expectedDep;
  if (expected && expected.trim()) return expected;
  const aimed = call.aimedDep;
  if (aimed && aimed.trim()) return aimed;
  return null;
}

function departureOf(call: BusCall): BusDeparture {
  const delay = delayMinutes(call.aimedDep, call.expectedDep);
  const depDate = parseIso(effectiveDep(call));
  return {
    depTime: depDate ? osloIsoOffset(depDate) : "",
    destName: call.destName ?? "",
    delayMin: delay ?? 0,
    cancelled: call.cancelled ?? false,
    // 与 TrainRepository.realtimeKnown 同一口径：取消本身就是「已知」；没有实时数据时
    // delayMin 是占位值，不能当成「正点」（把「不知道」说成「准点」是相反的安全方向）。
    delayKnown: (call.cancelled ?? false) || ((call.realtime ?? false) && delay !== null),
  };
}

/**
 * 站序里的一项是否「是」某个设置里的站 id（[gate] P10 修正，CONTRACT 第 9 节「站的匹配」）：
 * 设置里存的可能是父站 id，而站序给出子站；`id === target` 或 `parentId === target` 都算。
 */
function quayMatches(quay: QuayRef, target: string): boolean {
  return quay.id === target || quay.parentId === target;
}

/**
 * 方向判定（CONTRACT 第 9 节）：该班次的站序里，toId 是否出现、且位置在 fromId 之后。
 * 两者有一个不在站序里（含只开到中途、不经过对端站的区间车；或反向班次）都不算数。
 */
export function passesThrough(quays: QuayRef[], fromId: string, toId: string): boolean {
  if (!fromId || !toId) return false;
  const fromIndex = quays.findIndex((q) => quayMatches(q, fromId));
  const toIndex = quays.findIndex((q) => quayMatches(q, toId));
  return fromIndex >= 0 && toIndex >= 0 && toIndex > fromIndex;
}

/**
 * 从某站的到站记录里挑出开往对端站的关注线路未来班次：过滤线路 → 过滤方向（站序判定）→
 * 剔除已发车 → 按发车时间升序 → 最多 FETCH_LIMIT 班。
 */
export function board(
  calls: BusCall[],
  lineCode: string,
  fromId: string,
  toId: string,
  boardStop: string,
  towardStop: string,
  now: Date,
): BusBoard {
  const timed: Array<{ departure: BusDeparture; dep: Date }> = [];
  for (const call of calls) {
    if ((call.line ?? "") !== lineCode) continue;
    if (!passesThrough(call.quays ?? [], fromId, toId)) continue;
    const dep = parseIso(effectiveDep(call));
    if (!dep) continue;
    if (dep.getTime() < now.getTime()) continue;
    timed.push({ departure: departureOf(call), dep });
  }
  timed.sort((a, b) => a.dep.getTime() - b.dep.getTime());
  return {
    boardStop,
    towardStop,
    departures: timed.slice(0, FETCH_LIMIT).map((x) => x.departure),
  };
}

/** 两个方向的完整快照（顺序固定：先 A、后 B），供任务处理器写入快照。 */
export function status(
  config: WatchedLineConfig,
  callsA: BusCall[],
  callsB: BusCall[],
  now: Date,
  updatedAt: string,
): BusStatus {
  return {
    boards: [
      board(callsA, config.lineCode, config.stopA.id, config.stopB.id, config.stopA.name, config.stopB.name, now),
      board(callsB, config.lineCode, config.stopB.id, config.stopA.id, config.stopB.name, config.stopA.name, now),
    ],
    updatedAt,
    lineCode: config.lineCode,
  };
}

/** 按当前时钟重新裁剪缓存：剔除已发车（或时刻不可解析）的班次，每方向只留 limit 班。 */
export function visibleBoard(b: BusBoard, now: Date, limit: number = VISIBLE_LIMIT): BusBoard {
  const future = b.departures.filter((d) => {
    const at = parseIso(d.depTime);
    return at !== null && at.getTime() >= now.getTime();
  });
  return { ...b, departures: future.slice(0, limit) };
}

export function visibleBoards(
  busStatus: BusStatus | null,
  now: Date,
  limit: number = VISIBLE_LIMIT,
): BusStatus | null {
  if (!busStatus) return null;
  return { ...busStatus, boards: busStatus.boards.map((b) => visibleBoard(b, now, limit)) };
}

/**
 * 「还有 N 分钟」文案。已发车（或时刻不可解析）返回 null——调用方此时不该渲染这一班，
 * 返回 null 是让「不该显示」有唯一的表达方式，而不是靠 UI 自己判空。
 */
export function countdownText(now: Date, depTimeIso: string | null | undefined): string | null {
  const dep = parseIso(depTimeIso);
  if (!dep) return null;
  const minutes = Math.trunc((dep.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return null;
  if (minutes === 0) return "即将发车";
  return `还有 ${minutes} 分钟`;
}
