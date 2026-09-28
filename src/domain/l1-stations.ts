// 从 app/.../domain/L1Stations.kt 逐行移植：L1 线路站表（同序）、按名字精确匹配
// （不 trim、大小写敏感，与 Kotlin `list.find { it.name == name }` 一致）。
// [gate] P9：找不到时不再回退默认站——车站是「未选择」的状态，由调用方（train 任务）
// 判定 not_configured，不发请求（CONTRACT 第 9 节）。
import type { Settings } from "../contract/settings";

export interface L1Station {
  name: string;
  stopId: string;
}

export const L1_STATIONS: readonly L1Station[] = [
  { name: "Spikkestad", stopId: "NSR:StopPlace:60736" },
  { name: "Røyken", stopId: "NSR:StopPlace:58838" },
  { name: "Heggedal", stopId: "NSR:StopPlace:58851" },
  { name: "Gullhella", stopId: "NSR:StopPlace:60735" },
  { name: "Bondivann", stopId: "NSR:StopPlace:60737" },
  { name: "Asker", stopId: "NSR:StopPlace:59616" },
  { name: "Høn", stopId: "NSR:StopPlace:58852" },
  { name: "Vakås", stopId: "NSR:StopPlace:61466" },
  { name: "Hvalstad", stopId: "NSR:StopPlace:61464" },
  { name: "Billingstad", stopId: "NSR:StopPlace:62393" },
  { name: "Slependen", stopId: "NSR:StopPlace:62392" },
  { name: "Sandvika", stopId: "NSR:StopPlace:610" },
  { name: "Blommenholm", stopId: "NSR:StopPlace:58843" },
  { name: "Høvik", stopId: "NSR:StopPlace:59646" },
  { name: "Stabekk", stopId: "NSR:StopPlace:59654" },
  { name: "Lysaker", stopId: "NSR:StopPlace:58856" },
  { name: "Skøyen", stopId: "NSR:StopPlace:59651" },
  { name: "Nationaltheatret", stopId: "NSR:StopPlace:58404" },
  { name: "Oslo S", stopId: "NSR:StopPlace:59872" },
  { name: "Bryn", stopId: "NSR:StopPlace:61897" },
  { name: "Alna", stopId: "NSR:StopPlace:62308" },
  { name: "Nyland", stopId: "NSR:StopPlace:59650" },
  { name: "Grorud", stopId: "NSR:StopPlace:59620" },
  { name: "Haugenstua", stopId: "NSR:StopPlace:59653" },
  { name: "Høybråten", stopId: "NSR:StopPlace:313" },
  { name: "Lørenskog", stopId: "NSR:StopPlace:58857" },
  { name: "Hanaborg", stopId: "NSR:StopPlace:41" },
  { name: "Fjellhamar", stopId: "NSR:StopPlace:59641" },
  { name: "Strømmen", stopId: "NSR:StopPlace:58862" },
  { name: "Sagdalen", stopId: "NSR:StopPlace:101" },
  { name: "Lillestrøm", stopId: "NSR:StopPlace:62339" },
];

/** 精确匹配（不 trim、大小写敏感），与 Kotlin `L1Stations.find` 一致。 */
export function findStation(name: string): L1Station | null {
  return L1_STATIONS.find((s) => s.name === name) ?? null;
}

export interface ResolvedStations {
  origin: L1Station;
  dest: L1Station;
}

/**
 * 设置里的出发/到达站名解析成 L1Station；任一站在 L1 站表里找不到（含空串）时
 * 返回 null——「未选择车站」，不再回退到任何默认站（CONTRACT 第 9 节）。
 */
export function resolveStations(settings: Settings): ResolvedStations | null {
  const origin = findStation(settings.originStation);
  const dest = findStation(settings.destStation);
  if (origin === null || dest === null) return null;
  return { origin, dest };
}

/** train 快照的 configKey；车站未选择时为 null（P3/P9 通用约定：not_configured 时 configKey 为 null）。 */
export function trainConfigKey(settings: Settings): string | null {
  const resolved = resolveStations(settings);
  if (resolved === null) return null;
  return `${resolved.origin.name}|${resolved.dest.name}`;
}
