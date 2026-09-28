// 各数据源快照的 configKey：与 src/api/dashboard.ts 原先内联的算法逐字一致（P3 通用约定），
// 抽成一个函数是为了给 notify（T5.3）与 dashboard 复用同一份逻辑——两处必须用同一个
// configKey，否则 notify 读到的「有效」快照与 dashboard 展示的不是同一份数据。
import type { Settings } from "../contract/settings";
import { trainConfigKey } from "../domain/l1-stations";

export interface ConfigKeys {
  weather: string | null;
  train: string | null;
  traffic_outbound: string | null;
  traffic_return: string | null;
  bus: string | null;
  football: string;
}

/**
 * 关注线路的 configKey：`<lineId>|<stopAId>|<stopBId>`，六个字段都非空才算已配置，否则
 * 返回 null（CONTRACT 第 9 节）。与 jobs/bus.ts 写快照时用的是同一个函数，保证两边算出
 * 同一个 configKey（包括 null 的情形），dashboard.ts 读取时才不会把「未配置」误判成
 * 「配置变了、旧缓存不可见」之外的另一种状态。
 */
export function watchedLineConfigKey(settings: Settings): string | null {
  const { watchedLineId, watchedLineCode, watchedStopAId, watchedStopAName, watchedStopBId, watchedStopBName } =
    settings;
  if (
    !watchedLineId ||
    !watchedLineCode ||
    !watchedStopAId ||
    !watchedStopAName ||
    !watchedStopBId ||
    !watchedStopBName
  ) {
    return null;
  }
  return `${watchedLineId}|${watchedStopAId}|${watchedStopBId}`;
}

/** 与 dashboard.ts 原实现逐字一致：地址判空前先 trim。 */
export function configKeysFor(settings: Settings): ConfigKeys {
  const originAddress = settings.originAddress.trim();
  const destinationAddress = settings.destinationAddress.trim();

  const weather = originAddress || null;
  const traffic_outbound = originAddress && destinationAddress ? `${originAddress}|${destinationAddress}` : null;
  const traffic_return = originAddress && destinationAddress ? `${destinationAddress}|${originAddress}` : null;
  // [gate] P9：车站未选择（含无效站名）时 trainConfigKey 返回 null，与 jobs/train.ts
  // 写快照时用的是同一个函数，保证两边算出同一个 configKey（包括 null 的情形）。
  const train = trainConfigKey(settings);
  const bus = watchedLineConfigKey(settings);

  return { weather, train, traffic_outbound, traffic_return, bus, football: "86" };
}
