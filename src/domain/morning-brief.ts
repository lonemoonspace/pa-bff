// 从 app/.../domain/MorningBriefPolicy.kt 逐行移植：判断「早间简报是否该发」。
// 按「上次发送日期」去重，跟内容是否变化无关；只有三个来源全部缺失时才不发（且不消耗当天机会）。
import type { TrafficStatus, TrainStatus, WeatherStatus } from "../contract/dashboard";
import { formatIsoHm, formatMinutes } from "../util/time";
import type { CommuteWindow } from "./windows";
import { toZh } from "./weather-symbols";

export interface MorningBriefDecision {
  shouldNotify: boolean;
  title: string;
  body: string;
  /** 未发送时原样透传输入的 lastSentDate。 */
  newLastSentDate: string | null;
}

const NO_DATA = "暂无数据";

function weatherText(weather: WeatherStatus | null): string | null {
  if (!weather) return null;
  // Double.toInt() 向零截断；-0.5 截断为 -0，String(-0) 在 JS 里就是 "0"，与 Kotlin "0" 一致。
  return `${Math.trunc(weather.temperature)}°C ${toZh(weather.symbolCode)}`;
}

function trainText(train: TrainStatus | null): string | null {
  const leg = train?.work.legs[0];
  if (!leg) return null;
  const at = formatIsoHm(leg.depTime);
  let statusText: string;
  if (leg.cancelled) {
    statusText = "已取消";
  } else if (!leg.delayKnown) {
    // delayKnown 为 false 时 delayMin 不可信（占位默认值），不能当成「正点」。
    statusText = "实时未知";
  } else if (leg.delayMin >= 5) {
    statusText = `延误 ${leg.delayMin} 分钟`;
  } else {
    statusText = "正点";
  }
  return `${leg.line} ${at} ${statusText}`;
}

function trafficText(traffic: TrafficStatus | null): string | null {
  if (!traffic) return null;
  return `预计用时 ${formatMinutes(traffic.durationSec)}`;
}

export function evaluate(
  weather: WeatherStatus | null,
  train: TrainStatus | null,
  traffic: TrafficStatus | null,
  window: CommuteWindow,
  today: string,
  lastSentDate: string | null,
): MorningBriefDecision {
  // 窗口外不判定，原样透传 lastSentDate。
  if (window !== "WORK") {
    return { shouldNotify: false, title: "", body: "", newLastSentDate: lastSentDate };
  }
  // 同一天（Oslo 本地日期）已经发过，不重复发。
  if (lastSentDate === today) {
    return { shouldNotify: false, title: "", body: "", newLastSentDate: lastSentDate };
  }

  const w = weatherText(weather);
  const t = trainText(train);
  const tr = trafficText(traffic);
  if (w === null && t === null && tr === null) {
    // 三个来源全部缺失：不发送，也不消耗当天的发送机会。
    return { shouldNotify: false, title: "", body: "", newLastSentDate: lastSentDate };
  }

  const body = [w ?? NO_DATA, t ?? NO_DATA, tr ?? NO_DATA].join(" · ");
  return { shouldNotify: true, title: "早间简报", body, newLastSentDate: today };
}

/** notify_state.state_json 的外形：{ lastSentDate: "yyyy-MM-dd" | null }。 */
export interface MorningBriefState {
  lastSentDate: string | null;
}

/** 每次返回新对象字面量，不返回共享的模块级单例，理由同 football-notify.ts 的 initialState。 */
function initialState(): MorningBriefState {
  return { lastSentDate: null };
}

// Kotlin 端用 `LocalDate.parse` 解析 lastSentDate（见 RefreshWorker.kt 的
// `runCatching { LocalDate.parse(raw) }.getOrNull()`）：只接受严格的 "yyyy-MM-dd"（4 位年、
// 2 位月、2 位日，均需补零），且必须是真实存在的日期；前后多余字符、缺补零、多余符号
// （包括时间部分）一律解析失败。不能直接把字符串原样当日期用。
const STRICT_LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonthStrict(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 31;
}

function isValidLocalDate(value: string): boolean {
  const match = STRICT_LOCAL_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonthStrict(year, month)) return false;
  return true;
}

/** 解析持久化状态；null、非法 JSON、外形不对、日期不是真实存在的 "yyyy-MM-dd" 都回退初始值。 */
export function parseMorningBriefState(json: string | null): MorningBriefState {
  if (json === null) return initialState();
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "lastSentDate" in parsed &&
      (typeof (parsed as { lastSentDate: unknown }).lastSentDate === "string" ||
        (parsed as { lastSentDate: unknown }).lastSentDate === null)
    ) {
      const lastSentDate = (parsed as { lastSentDate: string | null }).lastSentDate;
      if (lastSentDate === null) return { lastSentDate: null };
      return { lastSentDate: isValidLocalDate(lastSentDate) ? lastSentDate : null };
    }
    return initialState();
  } catch {
    return initialState();
  }
}
