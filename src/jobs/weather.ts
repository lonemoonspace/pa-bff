// weather 任务：从 app/.../data/weather/WeatherRepository.kt、WeatherPointPicker.kt、
// DailyForecastBuilder.kt 移植。卡上只允许改本文件、met.ts、jobs/index.ts，因此纯逻辑
// （选点、逐日汇总）直接写在这里，不新开 domain/ 文件。
import type { CadenceCtx } from "../scheduler/cadence";
import type { WeatherStatus } from "../contract/dashboard";
import type { Env } from "../env";
import { loadSettingsOrFallback } from "../scheduler/tick";
import { SourceFailure, type SourceFailureCode } from "../sources/http";
import { geocodeAddress } from "../sources/entur";
import { fetchWeather, type MetData, type MetTimePoint } from "../sources/met";
import * as snapshot from "../snapshot/store";
import { osloIsoOffset, osloParts } from "../util/time";

const SOURCE = "weather";

// 与 WeatherPointPicker.kt 的两个窗口常量一致。
const WINDOW_BEFORE_MINUTES = 45;
const WINDOW_AFTER_MINUTES = 90;

// 与 DailyForecastBuilder.kt 的 DAYS 一致。
const DAILY_FORECAST_DAYS = 5;

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 从 WeatherPointPicker.kt 移植：窗口（now-45min..now+90min）优先命中原序列里第一个落在
 * 窗口内的点；打不中时取时间上最接近 now 的点，同距时取先出现（更早）的那个；完全解析
 * 不出时刻的序列回退到 items 的第一个元素。与 Kotlin 版一样是泛型的，方便直接对照移植
 * WeatherPointPickerTest 的每个用例（见 test/jobs/weather.test.ts）。
 */
export function pickPoint<T>(items: T[], now: Date, timeOf: (item: T) => Date | null): T | null {
  const timed: { item: T; at: Date }[] = [];
  for (const item of items) {
    const at = timeOf(item);
    if (at) timed.push({ item, at });
  }
  if (timed.length === 0) return items[0] ?? null;

  const windowStart = now.getTime() - WINDOW_BEFORE_MINUTES * 60_000;
  const windowEnd = now.getTime() + WINDOW_AFTER_MINUTES * 60_000;
  const inWindow = timed.find(({ at }) => at.getTime() >= windowStart && at.getTime() <= windowEnd);
  if (inWindow) return inWindow.item;

  let best = timed[0]!;
  let bestDiff = Math.abs(best.at.getTime() - now.getTime());
  for (let i = 1; i < timed.length; i++) {
    const candidate = timed[i]!;
    const diff = Math.abs(candidate.at.getTime() - now.getTime());
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best.item;
}

/**
 * next_1_hours 优先，缺失（对象或其 details 不存在）时退到 next_6_hours/6；两者都没有则 0。
 * 与 Kotlin `current?.data?.next1Hours?.details?.precipitation_amount ?: current?.data
 * ?.next6Hours?.details?.precipitation_amount?.div(6) ?: 0.0` 逐一对应：details 存在时
 * precipitation_amount 本身有默认值 0（不是 null），因此「取到 0」和「取不到」是两回事，
 * 不能用 `?? 0` 一步到位。
 */
function precip1hOf(data: MetData | null | undefined): number {
  const n1 = data?.next_1_hours?.details?.precipitation_amount;
  if (n1 !== undefined && n1 !== null) return n1;
  const n6 = data?.next_6_hours?.details?.precipitation_amount;
  if (n6 !== undefined && n6 !== null) return n6 / 6;
  return 0;
}

/**
 * next_1_hours.summary 存在时用它的 symbol_code（哪怕是空字符串也不回退，因为 Kotlin 的
 * `?:` 只在左边整体为 null 时才走右边）；summary 不存在时退到 next_6_hours，都没有则 ""。
 */
function symbolOf(data: MetData | null | undefined): string {
  if (data?.next_1_hours?.summary != null) return data.next_1_hours.summary.symbol_code;
  return data?.next_6_hours?.summary?.symbol_code ?? "";
}

/** 明天（Oslo 日期，相对 now）06:00–11:00 之间的第一个点，序列里没有则 null。 */
function findTomorrowPoint(series: MetTimePoint[], now: Date): MetTimePoint | null {
  const todayParts = osloParts(now);
  const tomorrowKey = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day) + 24 * 60 * 60_000;
  for (const tp of series) {
    const at = parseIso(tp.time);
    if (!at) continue;
    const p = osloParts(at);
    const key = Date.UTC(p.year, p.month - 1, p.day);
    if (key === tomorrowKey && p.hour >= 6 && p.hour <= 11) return tp;
  }
  return null;
}

interface DailyForecastOut {
  date: string;
  minTemp: number;
  maxTemp: number;
  symbolCode: string;
  precipMm: number;
}

/**
 * 从 DailyForecastBuilder.kt 移植：按 Oslo 日期把 [today, today+4天] 内的点分组，
 * 每天取气温极值、最接近正午的符号、UTC 0/6/12/18 时起算窗口内 next_6_hours 降水之和。
 * 某天没有任何带气温的点时整天跳过（不是补 0）。
 */
function buildDaily(series: MetTimePoint[], now: Date, days = DAILY_FORECAST_DAYS): DailyForecastOut[] {
  const todayParts = osloParts(now);
  const todayKey = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  const lastDayKey = todayKey + (days - 1) * 24 * 60 * 60_000;

  interface Bucketed {
    hour: number;
    minute: number;
    utcHour: number;
    tp: MetTimePoint;
  }
  const byDate = new Map<string, Bucketed[]>();

  for (const tp of series) {
    const at = parseIso(tp.time);
    if (!at) continue;
    const p = osloParts(at);
    const dateKey = Date.UTC(p.year, p.month - 1, p.day);
    if (dateKey < todayKey || dateKey > lastDayKey) continue;
    const dateStr = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const bucket = byDate.get(dateStr) ?? [];
    bucket.push({ hour: p.hour, minute: p.minute, utcHour: at.getUTCHours(), tp });
    byDate.set(dateStr, bucket);
  }

  const result: DailyForecastOut[] = [];
  for (const dateStr of [...byDate.keys()].sort()) {
    const points = byDate.get(dateStr)!;
    const temps = points
      .map(({ tp }) => tp.data?.instant?.details?.air_temperature)
      .filter((t): t is number => t !== undefined && t !== null);
    if (temps.length === 0) continue;

    let bestSymbol = "";
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const { hour, minute, tp } of points) {
      const code =
        (tp.data?.next_6_hours?.summary?.symbol_code || tp.data?.next_1_hours?.summary?.symbol_code) ?? "";
      if (!code) continue;
      const diff = Math.abs(hour * 60 + minute - 12 * 60);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSymbol = code;
      }
    }

    let precip = 0;
    for (const { utcHour, tp } of points) {
      if (utcHour % 6 === 0) precip += tp.data?.next_6_hours?.details?.precipitation_amount ?? 0;
    }

    result.push({
      date: dateStr,
      minTemp: Math.min(...temps),
      maxTemp: Math.max(...temps),
      symbolCode: bestSymbol,
      precipMm: precip,
    });
  }
  return result;
}

function toSourceFailure(err: unknown, now: Date): { code: SourceFailureCode; message: string; at: string } {
  if (err instanceof SourceFailure) {
    return { code: err.code, message: err.message, at: now.toISOString() };
  }
  return {
    code: "upstream_5xx",
    message: err instanceof Error ? err.message : String(err),
    at: now.toISOString(),
  };
}

/** weather 任务处理器；由 jobs/index.ts 注册为 "weather"。 */
export async function weatherJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  const settings = await loadSettingsOrFallback(env, now.toISOString());
  const originAddress = settings.originAddress.trim();
  if (!originAddress) {
    await snapshot.putState(env, SOURCE, "not_configured", null, now);
    return;
  }
  // configKey 约定（P3 通用约定）：weather = trim(originAddress)。
  const configKey = originAddress;

  // F2：geocodeAddress 现在会把「没打通请求」的失败（超时、网络错误）重新抛出（只有
  // 上游明确给出结果——HTTP 错误/解析失败——才会静默返回 null），必须并入下面这个
  // try，否则这类异常会直接从 weatherJob 里逃逸出去，而不是像其它失败一样落进快照。
  try {
    const geo = await geocodeAddress(originAddress, signal);
    if (!geo) {
      await snapshot.putFailure(
        env,
        SOURCE,
        { code: "upstream_4xx", message: `无法定位天气地址：${originAddress}`, at: now.toISOString() },
        configKey,
        now,
      );
      return;
    }

    // F6：改用 snapshot.getValidators 而不是直接查 snapshots 表——configKey 不匹配、
    // 没有行、或者上次其实没有成功过（json 为 null）都统一由它判断，不在这里重复一份。
    const validators = await snapshot.getValidators(env, SOURCE, configKey);
    const ifModifiedSince = validators?.lastModified ?? null;

    const result = await fetchWeather(geo.lat, geo.lon, { ifModifiedSince, signal });

    const ctx: CadenceCtx = {};
    const expiresAt = parseIso(result.expires);
    if (expiresAt) ctx.weatherExpiresAt = expiresAt;

    if (result.notModified) {
      await snapshot.putNotModified(env, SOURCE, now);
      return ctx;
    }

    const series = result.envelope?.properties?.timeseries ?? [];
    const current = pickPoint(series, now, (tp) => parseIso(tp.time));
    const currentAt = current ? parseIso(current.time) : null;
    const tomorrow = findTomorrowPoint(series, now);

    const status: WeatherStatus = {
      temperature: current?.data?.instant?.details?.air_temperature ?? 0,
      windSpeed: current?.data?.instant?.details?.wind_speed ?? 0,
      precip1h: precip1hOf(current?.data),
      symbolCode: symbolOf(current?.data),
      tomorrowMorningTemp: tomorrow?.data?.instant?.details?.air_temperature ?? null,
      tomorrowSymbol: symbolOf(tomorrow?.data),
      updatedAt: osloIsoOffset(now),
      observedAt: currentAt ? osloIsoOffset(currentAt) : "",
      locationKey: originAddress,
      daily: buildDaily(series, now),
    };

    await snapshot.putSuccess(
      env,
      SOURCE,
      status,
      {
        observedAt: currentAt ? currentAt.toISOString() : null,
        etag: result.etag,
        lastModified: result.lastModified,
        configKey,
      },
      now,
    );

    return ctx;
  } catch (err) {
    await snapshot.putFailure(env, SOURCE, toSourceFailure(err, now), configKey, now);
  }
}
