// train 任务：从 app/.../data/train/TrainRepository.kt 的 I/O 部分移植（纯计算见
// src/domain/train.ts）。[gate] P9：出发站或到达站在 L1 站表里找不到（含空串）时不再
// 回退默认站——写 not_configured（configKey 为 null），不发任何请求（CONTRACT 第 9 节）。
import type { CadenceCtx } from "../scheduler/cadence";
import type { Env } from "../env";
import { buildTrainStatus, type TrainSources } from "../domain/train";
import { resolveStations, trainConfigKey } from "../domain/l1-stations";
import { loadSettingsOrFallback } from "../scheduler/tick";
import * as entur from "../sources/entur";
import { SourceFailure } from "../sources/http";
import * as snapshot from "../snapshot/store";

const SOURCE = "train";

function toSourceFailure(err: unknown, now: Date): { code: string; message: string; at: string } {
  if (err instanceof SourceFailure) {
    return { code: err.code, message: err.message, at: now.toISOString() };
  }
  return {
    code: "upstream_5xx",
    message: err instanceof Error ? err.message : String(err),
    at: now.toISOString(),
  };
}

/** train 任务处理器；由 jobs/index.ts 注册为 "train"。 */
export async function trainJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  const settings = await loadSettingsOrFallback(env, now.toISOString());

  if (resolveStations(settings) === null) {
    // 未选择车站：不发请求，直接写 not_configured（configKey 为 null）。
    await snapshot.putState(env, SOURCE, "not_configured", null, now);
    return;
  }

  const configKey = trainConfigKey(settings);

  const sources: TrainSources = {
    fetchBoth: (originId, destId, from) => entur.fetchBoth(originId, destId, from, from, { signal }),
    fastestTrip: (fromId, toId, at) => entur.fastestTrip(fromId, toId, at, signal),
    fetchStop: (stopId, from) => entur.fetchStop(stopId, from, { signal }),
  };

  try {
    const status = await buildTrainStatus(now, settings, sources, signal);
    await snapshot.putSuccess(env, SOURCE, status, { observedAt: now.toISOString(), configKey }, now);
  } catch (err) {
    await snapshot.putFailure(env, SOURCE, toSourceFailure(err, now), configKey, now);
  }
}
