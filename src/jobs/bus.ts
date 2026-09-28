// bus 任务（首页「关注线路」卡片）：从 app/.../data/bus/WatchedLineRepository.kt 移植，
// 取代 v1 写死线路与两端站的 Bus280Repository（domain/bus280.ts 已删除，改用
// domain/watched-line.ts）。[gate] P9：六个 watchedLine* 字段都非空才算已配置，否则写
// not_configured（configKey 为 null），不发请求（CONTRACT 第 9 节）。
import type { CadenceCtx } from "../scheduler/cadence";
import * as watchedLine from "../domain/watched-line";
import type { Env } from "../env";
import { loadSettingsOrFallback } from "../scheduler/tick";
import { watchedLineConfigKey } from "../snapshot/config-keys";
import { fetchWatchedLineDepartures, type WatchedLineStopDeparture } from "../sources/entur";
import { SourceFailure, type SourceFailureCode } from "../sources/http";
import * as snapshot from "../snapshot/store";
import { osloIsoOffset } from "../util/time";

const SOURCE = "bus";

function toBusCall(call: WatchedLineStopDeparture): watchedLine.BusCall {
  return {
    line: call.serviceJourney?.journeyPattern?.line?.publicCode ?? "",
    destName: call.destinationDisplay?.frontText ?? "",
    aimedDep: call.aimedDepartureTime,
    expectedDep: call.expectedDepartureTime,
    realtime: call.realtime,
    cancelled: call.cancellation,
    quayIds: (call.serviceJourney?.quays ?? [])
      .map((q) => q.stopPlace?.id)
      .filter((id): id is string => id !== null && id !== undefined),
  };
}

function toSourceFailure(err: unknown, now: Date): { code: SourceFailureCode | string; message: string; at: string } {
  if (err instanceof SourceFailure) {
    return { code: err.code, message: err.message, at: now.toISOString() };
  }
  return {
    code: "upstream_5xx",
    message: err instanceof Error ? err.message : String(err),
    at: now.toISOString(),
  };
}

/** bus 任务处理器；由 jobs/index.ts 注册为 "bus"。 */
export async function busJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  const settings = await loadSettingsOrFallback(env, now.toISOString());
  const configKey = watchedLineConfigKey(settings);

  if (configKey === null) {
    // 未设置关注线路：不发请求，直接写 not_configured（configKey 为 null）。
    await snapshot.putState(env, SOURCE, "not_configured", null, now);
    return;
  }

  const config: watchedLine.WatchedLineConfig = {
    lineCode: settings.watchedLineCode,
    stopA: { id: settings.watchedStopAId, name: settings.watchedStopAName },
    stopB: { id: settings.watchedStopBId, name: settings.watchedStopBName },
  };

  // startTime 往前 1 分钟：抵消设备与 Entur 的秒级时钟偏差，以及 startTime 边界是开区间
  // 还是闭区间的不确定性——否则一辆恰好在此刻发车的车可能查不出来。已经开走的班次由
  // watchedLine.board 自己剔除（只留 dep >= now），这 1 分钟不会把过期班次带进快照。
  const from = new Date(now.getTime() - 60_000);

  try {
    const calls = await fetchWatchedLineDepartures(
      [config.stopA.id, config.stopB.id],
      settings.watchedLineId,
      from,
      { rangeMinutes: 180, maxCalls: 50, signal },
    );

    const status = watchedLine.status(
      config,
      (calls.get(config.stopA.id) ?? []).map(toBusCall),
      (calls.get(config.stopB.id) ?? []).map(toBusCall),
      now,
      osloIsoOffset(now),
    );

    await snapshot.putSuccess(env, SOURCE, status, { observedAt: now.toISOString(), configKey }, now);
  } catch (err) {
    await snapshot.putFailure(env, SOURCE, toSourceFailure(err, now), configKey, now);
  }
}
