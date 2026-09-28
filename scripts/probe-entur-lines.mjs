#!/usr/bin/env node
// 探索脚本，不在 CI 里运行，不影响验收。
//
// 验证 stopPlace.quays.lines 与 estimatedCalls.serviceJourney.quays 两个字段的真实形状：
// 前者供 GET /v1/lines（src/sources/entur-lines.ts）用，后者供 bus 任务
// （src/sources/entur.ts 的 fetchWatchedLineDepartures）用。
//
// 用法（站 id 通过命令行参数传入，不写死）：
//   node bff/scripts/probe-entur-lines.mjs <stopAId> <stopBId> [lineId]
// 例：node bff/scripts/probe-entur-lines.mjs NSR:StopPlace:418 NSR:StopPlace:6013 RUT:Line:31

const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";

const [stopAId, stopBId, lineId] = process.argv.slice(2);

if (!stopAId || !stopBId) {
  console.error("用法：node bff/scripts/probe-entur-lines.mjs <stopAId> <stopBId> [lineId]");
  process.exitCode = 1;
  throw new Error("缺少参数");
}

const linesQuery = `query Lines($stopA: String!, $stopB: String!) {
  stopA: stopPlace(id: $stopA) {
    name
    quays { lines { id publicCode name transportMode } }
  }
  stopB: stopPlace(id: $stopB) {
    name
    quays { lines { id publicCode name transportMode } }
  }
}`;

const callsQuery = `query Departures($stop: String!, $start: DateTime, $range: Int!, $calls: Int!, $lines: [ID]) {
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
        quays { stopPlace { id } }
      }
    }
  }
}`;

async function postGraphQl(query, variables) {
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
    return null;
  }
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    console.log("响应不是合法 JSON，原文：");
    console.log(text);
    return null;
  }
}

async function main() {
  console.log("== 1. stopPlace.quays.lines（GET /v1/lines 用） ==");
  const linesJson = await postGraphQl(linesQuery, { stopA: stopAId, stopB: stopBId });
  if (linesJson?.errors?.length) {
    console.log("GraphQL errors：");
    console.log(JSON.stringify(linesJson.errors, null, 2));
  } else {
    const stopA = linesJson?.data?.stopA;
    const stopB = linesJson?.data?.stopB;
    const idsOf = (stop) =>
      new Set((stop?.quays ?? []).flatMap((q) => q.lines?.map((l) => l.id) ?? []));
    const idsA = idsOf(stopA);
    const idsB = idsOf(stopB);
    const common = [...idsA].filter((id) => idsB.has(id));
    console.log(`stopA(${stopA?.name ?? "?"})：${idsA.size} 条线路`);
    console.log(`stopB(${stopB?.name ?? "?"})：${idsB.size} 条线路`);
    console.log(`共同线路 ${common.length} 条：${JSON.stringify(common)}`);
  }

  if (!lineId) {
    console.log("\n未传 lineId，跳过 estimatedCalls.serviceJourney.quays 探测。");
    return;
  }

  console.log("\n== 2. estimatedCalls.serviceJourney.quays（bus 任务用） ==");
  const callsJson = await postGraphQl(callsQuery, {
    stop: stopAId,
    start: new Date().toISOString(),
    range: 3600 * 3,
    calls: 50,
    lines: [lineId],
  });
  if (callsJson?.errors?.length) {
    console.log("GraphQL errors：");
    console.log(JSON.stringify(callsJson.errors, null, 2));
    return;
  }
  const calls = callsJson?.data?.stopPlace?.estimatedCalls ?? [];
  console.log(`成功：estimatedCalls 返回 ${calls.length} 班次`);
  const withQuays = calls.filter((c) => Array.isArray(c.serviceJourney?.quays) && c.serviceJourney.quays.length > 0);
  console.log(`其中带非空 serviceJourney.quays 的有 ${withQuays.length} 班`);
  if (withQuays[0]) {
    console.log("示例 quays：", JSON.stringify(withQuays[0].serviceJourney.quays));
  }
}

await main();
