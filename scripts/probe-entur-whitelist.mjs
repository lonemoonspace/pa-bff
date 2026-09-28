#!/usr/bin/env node
// 探索脚本，不在 CI 里运行，不影响验收。
//
// Kotlin 源码注释提到 Entur v3 已经移除 `whiteListedLines` 参数（实测报
// UnknownArgument），所以 fetchStopDepartures 只能拉一大堆班次再在客户端按线路号
// 筛。这里单独发一次真实请求，用 estimatedCalls(whiteListed: { lines: [...] })
// 试探这个参数在当前 API 版本里到底还在不在，把探索结果打印出来，供汇报引用。
//
// 用法：node bff/scripts/probe-entur-whitelist.mjs <stopPlaceId> <lineId> [publicCode]
//（需要联网；不传参数时用下面的默认值，默认值只是示例站/示例线路，不代表任何人的通勤路线）

const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";

const STOP_ID = process.argv[2] ?? "NSR:StopPlace:59616"; // 默认 Asker stasjon，仅作探针默认值
const LINE_ID = process.argv[3] ?? "RUT:Line:42"; // 探索用，猜测常见命名，查不到也无妨——本脚本本身就是在验证这条路径是否可行
const PUBLIC_CODE = process.argv[4] ?? "42";

const query = `query Departures($stop: String!, $start: DateTime, $range: Int!, $calls: Int!, $lines: [ID]) {
  stopPlace(id: $stop) {
    name
    estimatedCalls(
      startTime: $start
      timeRange: $range
      numberOfDepartures: $calls
      whiteListed: { lines: $lines }
    ) {
      aimedDepartureTime
      serviceJourney {
        journeyPattern { line { publicCode } }
      }
    }
  }
}`;

const variables = {
  stop: STOP_ID,
  start: new Date().toISOString(),
  range: 3600 * 3,
  calls: 100,
  lines: [LINE_ID],
};

async function main() {
  console.log(`POST ${JOURNEY_PLANNER_URL}`);
  console.log(`variables: ${JSON.stringify(variables)}`);

  let response;
  try {
    response = await fetch(JOURNEY_PLANNER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ET-Client-Name": "personal-assistant-bff-probe",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    console.error("请求失败（网络层）：", err);
    process.exitCode = 1;
    return;
  }

  const text = await response.text();
  console.log(`HTTP ${response.status}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log("响应不是合法 JSON，原文：");
    console.log(text);
    process.exitCode = 1;
    return;
  }

  if (json.errors?.length) {
    console.log("GraphQL errors：");
    console.log(JSON.stringify(json.errors, null, 2));
    process.exitCode = 1;
    return;
  }

  const calls = json.data?.stopPlace?.estimatedCalls ?? [];
  console.log(`成功：estimatedCalls 返回 ${calls.length} 班次`);
  const matched = calls.filter((c) => c.serviceJourney?.journeyPattern?.line?.publicCode === PUBLIC_CODE);
  console.log(`其中 publicCode === "${PUBLIC_CODE}" 的有 ${matched.length} 班`);
}

await main();
