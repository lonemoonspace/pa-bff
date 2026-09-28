// traffic_outbound / traffic_return 任务：从 app/.../data/traffic/TrafficRepository.kt 移植。
// 两个方向共用同一套逻辑，只是 origin/destination 互换、目标窗口不同（WORK / RETURN），
// 与 cadence.ts 的 nextTraffic(..., "WORK" | "RETURN") 对应。
import type { CadenceCtx } from "../scheduler/cadence";
import type { TrafficStatus } from "../contract/dashboard";
import type { Env } from "../env";
import { resolveWindow } from "../domain/windows";
import { loadSettingsOrFallback } from "../scheduler/tick";
import { getSecretPlain } from "../secrets/store";
import { registerTester } from "../secrets/testers";
import { computeRoute, parseDurationSeconds } from "../sources/routes";
import { geocodeAddress } from "../sources/entur";
import { SourceFailure } from "../sources/http";
import * as snapshot from "../snapshot/store";
import { osloIsoOffset } from "../util/time";

// google_routes 的密钥测试：发一个最小的 computeRoutes 请求（两个固定地址，出发时间取
// 未来 1 分钟，与任务本身的调用方式一致）。401/403 会被 fetchJson 归为 upstream_4xx，
// 这里给出人能看懂的原因；其它失败原样带上 SourceFailure 的 message。
registerTester("google_routes", async (_env, apiKey) => {
  try {
    await computeRoute({
      apiKey,
      origin: "Oslo S",
      destination: "Asker stasjon",
      departureTime: new Date(Date.now() + 60_000),
    });
    return { ok: true, message: "Google Routes API 可用" };
  } catch (err) {
    if (err instanceof SourceFailure && err.code === "upstream_4xx") {
      return { ok: false, message: "Google API Key 无效或未启用 Routes API（HTTP 401/403）" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `测试失败：${message}` };
  }
});

/** 与 Kotlin TrafficRepository.refresh 里的阈值一致：延误秒数 → 等级。 */
function levelOf(delaySec: number): string {
  if (delaySec <= 120) return "CLEAR";
  if (delaySec <= 480) return "SLIGHT";
  if (delaySec <= 1080) return "MODERATE";
  return "SEVERE";
}

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

/** geocodeAddress 的失败按「降级为地址方式」处理，除非是 signal 主动中止。 */
async function safeGeocode(address: string, signal?: AbortSignal) {
  try {
    return await geocodeAddress(address, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

async function runTrafficJob(env: Env, now: Date, signal: AbortSignal, reverse: boolean): Promise<CadenceCtx | void> {
  const source = reverse ? "traffic_return" : "traffic_outbound";
  const target = reverse ? "RETURN" : "WORK";

  const settings = await loadSettingsOrFallback(env, now.toISOString());

  const origin = (reverse ? settings.destinationAddress : settings.originAddress).trim();
  const destination = (reverse ? settings.originAddress : settings.destinationAddress).trim();
  // configKey 约定（P3 通用约定）：traffic_outbound = trim(origin)|trim(dest)，
  // traffic_return 反之——此处 origin/destination 已经是按方向换算过的值。两端地址都
  // 填了才有意义的 configKey，缺一个就是 null（F4：地址为空时不该假装有个有效指纹）。
  const addressConfigKey = origin && destination ? `${origin}|${destination}` : null;

  // 不在对应窗口时不发请求，直接 idle（P3 T3.4 目标）。
  if (resolveWindow(now, settings) !== target) {
    await snapshot.putState(env, source, "idle", addressConfigKey, now);
    return;
  }

  if (!origin || !destination) {
    await snapshot.putState(env, source, "not_configured", null, now);
    return;
  }

  // 用 getSecretPlain 而不是直接读密文：解密失败（换过 MASTER_KEY）必须视同「未配置」，
  // 否则密文会被当成 apiKey 原样发给 Google，每次刷新必然失败
  // （与 Kotlin 侧 SecretField 类的历史缺陷同构，见 TrafficRepositoryTest 的回归用例）。
  const apiKey = await getSecretPlain(env, "google_routes");
  if (!apiKey) {
    // F4：缺密钥时地址本身是齐的，configKey 传 origin|dest（不是 null）——地址没变时，
    // 密钥补上后下一次成功刷新仍能复用同一份指纹，不会因为中间这段 not_configured
    // 把旧数据的可比较性弄丢。
    await snapshot.putState(env, source, "not_configured", addressConfigKey, now);
    return;
  }

  // 此时 origin/destination 都已确认非空，可以放心拼出非空的 configKey。
  const configKey = `${origin}|${destination}`;

  // 地理编码失败返回 null，回退到地址方式；geocodeAddress 的缓存是模块级单例，
  // 与天气任务共享同一份缓存（同一地址一轮刷新只查一次 geocoder）。
  //
  // F2：geocodeAddress 现在会把「没打通请求」的失败（网络错误、超时）重新抛出，不再
  // 静默返回 null。对 traffic 来说这类失败不该让整个任务失败——退回地址方式仍能算
  // 一次正常的 computeRoute 调用（与 TrafficRepository.kt 的原行为一致）；但如果是
  // signal 被主动中止（tick 要我们停下），必须让异常继续往上传，不能悄悄吞掉。
  const [originLatLng, destLatLng] = await Promise.all([
    safeGeocode(origin, signal),
    safeGeocode(destination, signal),
  ]);

  try {
    const route = await computeRoute({
      apiKey,
      origin,
      destination,
      originLatLng,
      destLatLng,
      departureTime: new Date(now.getTime() + 60_000),
      signal,
    });

    const dur = parseDurationSeconds(route.duration);
    const stat = parseDurationSeconds(route.staticDuration);
    const delay = Math.max(dur - stat, 0);

    const status: TrafficStatus = {
      durationSec: dur,
      staticDurationSec: stat,
      delaySec: delay,
      distanceMeters: route.distanceMeters,
      level: levelOf(delay),
      origin,
      destination,
      updatedAt: osloIsoOffset(now),
    };

    await snapshot.putSuccess(env, source, status, { observedAt: now.toISOString(), configKey }, now);
  } catch (err) {
    await snapshot.putFailure(env, source, toSourceFailure(err, now), configKey, now);
  }
}

/** traffic_outbound 任务处理器；由 jobs/index.ts 注册为 "traffic_outbound"。 */
export async function trafficOutboundJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  return runTrafficJob(env, now, signal, false);
}

/** traffic_return 任务处理器；由 jobs/index.ts 注册为 "traffic_return"。 */
export async function trafficReturnJob(env: Env, now: Date, signal: AbortSignal): Promise<CadenceCtx | void> {
  return runTrafficJob(env, now, signal, true);
}
