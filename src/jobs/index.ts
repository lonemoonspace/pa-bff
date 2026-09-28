// 集中注册所有任务处理器，由 src/index.ts 引入一次（见 bff/TASKS.md「P3 通用约定」）。
// 导入 "../scheduler/jobs" 会触发该模块自带的 housekeeping 注册（T2.5 起就是这个写法）；
// 后续每张 P3 任务卡只需在这里追加一个 import + registerJob。
import { registerJob } from "../scheduler/jobs";
import { weatherJob } from "./weather";
import { trafficOutboundJob, trafficReturnJob } from "./traffic";
import { footballJob } from "./football";
import { busJob } from "./bus";
import { trainJob } from "./train";
import { notifyJob } from "./notify";

registerJob("weather", weatherJob);
registerJob("traffic_outbound", trafficOutboundJob);
registerJob("traffic_return", trafficReturnJob);
registerJob("football", footballJob);
registerJob("bus", busJob);
registerJob("train", trainJob);
registerJob("notify", notifyJob);
