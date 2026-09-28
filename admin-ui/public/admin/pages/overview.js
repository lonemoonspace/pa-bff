// @ts-check
// 「总览」页：调度状态、设置摘要、设备数、任务表（含「立即运行」）、数据源表、密钥状态。
// 页面可见时每 30 秒自动刷新；切换到其它页面（hash 变化）后停止。
import { apiGet, apiSend, ApiError } from "../api.js";
import { osloDateTime, relativeTime, sourceNote, sourceStateLabel, tickHealth } from "../lib/format.js";

/** @type {number | null} */
let refreshTimer = null;

function stopAutoRefresh() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** hash 变化到 overview 以外的页面时停止自动刷新（同一个函数引用，重复 addEventListener 不会重复注册）。 */
function onHashChange() {
  const hash = location.hash.replace(/^#\/?/, "") || "overview";
  if (hash !== "overview") {
    stopAutoRefresh();
  }
}

/**
 * @param {string} text
 * @returns {HTMLTableCellElement}
 */
function td(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

/**
 * @param {string[]} headers
 * @returns {HTMLTableElement}
 */
function makeTable(headers) {
  const table = document.createElement("table");
  table.className = "table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(document.createElement("tbody"));
  return table;
}

/**
 * @param {HTMLElement} main
 */
async function loadAndRender(main) {
  let overview;
  try {
    overview = await apiGet("/admin/api/overview");
  } catch (err) {
    main.textContent = "";
    const p = document.createElement("p");
    p.textContent = err instanceof ApiError ? `加载失败：${err.message}` : "加载失败";
    main.appendChild(p);
    return;
  }

  const nowMs = Date.parse(overview.now);
  main.textContent = "";

  const h2 = document.createElement("h2");
  h2.textContent = "总览";
  main.appendChild(h2);

  // 调度状态
  const tickP = document.createElement("p");
  tickP.textContent = `上次调度：${relativeTime(overview.lastTickAt, nowMs)}`;
  const health = tickHealth(overview.lastTickAt, nowMs);
  if (health !== "ok") {
    const warn = document.createElement("span");
    warn.className = "warn-text";
    warn.textContent = health === "never" ? " 尚未运行过调度（Cron 触发器是否已启用？）" : " 调度可能已停止";
    tickP.appendChild(warn);
  }
  main.appendChild(tickP);

  // 设置摘要
  const settingsP = document.createElement("p");
  settingsP.textContent =
    `设置版本 r${overview.settings.revision}，更新于 ${osloDateTime(overview.settings.updatedAt)}，` +
    `更新者 ${overview.settings.updatedBy ?? "—"}`;
  main.appendChild(settingsP);

  // 设备摘要
  const devicesP = document.createElement("p");
  devicesP.textContent =
    `设备共 ${overview.devices.total} 台（owner ${overview.devices.owners} 台，` +
    `已登记推送令牌 ${overview.devices.withPushToken} 台）`;
  main.appendChild(devicesP);

  // 任务表
  const jobsH3 = document.createElement("h3");
  jobsH3.textContent = "任务";
  main.appendChild(jobsH3);
  const jobsTable = makeTable(["任务", "下次运行", "上次运行", "状态", "耗时(ms)", "失败次数", "操作"]);
  const jobsBody = jobsTable.querySelector("tbody");
  for (const job of overview.jobs) {
    const row = document.createElement("tr");
    row.appendChild(td(job.name));
    row.appendChild(td(osloDateTime(job.nextRunAt)));
    row.appendChild(td(osloDateTime(job.lastRunAt)));
    row.appendChild(td(job.lastStatus ?? "—"));
    row.appendChild(td(job.lastDurationMs === null ? "—" : String(job.lastDurationMs)));
    const failCell = td(String(job.failCount));
    if (job.failCount > 0) failCell.className = "warn-cell";
    row.appendChild(failCell);

    const actionCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "立即运行";
    button.addEventListener("click", () => {
      button.disabled = true;
      apiSend("POST", `/admin/api/jobs/${encodeURIComponent(job.name)}/run`)
        .then(() => loadAndRender(main))
        .catch((err) => {
          button.disabled = false;
          window.alert(err instanceof ApiError ? err.message : "运行失败");
        });
    });
    actionCell.appendChild(button);
    row.appendChild(actionCell);

    jobsBody?.appendChild(row);
  }
  main.appendChild(jobsTable);

  // 数据源表
  const sourcesH3 = document.createElement("h3");
  sourcesH3.textContent = "数据源";
  main.appendChild(sourcesH3);
  const sourcesTable = makeTable(["来源", "状态", "最近获取", "错误", "设置匹配"]);
  const sourcesBody = sourcesTable.querySelector("tbody");
  for (const source of overview.sources) {
    const row = document.createElement("tr");
    row.appendChild(td(source.source));
    row.appendChild(td(sourceStateLabel(source.state)));
    row.appendChild(td(osloDateTime(source.fetchedAt)));
    row.appendChild(td(source.error ? source.error.message : "—"));
    const matchCell = td(sourceNote(source));
    if (source.state !== null && !source.configMatches) matchCell.className = "warn-cell";
    row.appendChild(matchCell);
    sourcesBody?.appendChild(row);
  }
  main.appendChild(sourcesTable);

  // 密钥状态
  const secretsH3 = document.createElement("h3");
  secretsH3.textContent = "密钥状态";
  main.appendChild(secretsH3);
  const secretsTable = makeTable(["名称", "状态", "提示", "最近测试"]);
  const secretsBody = secretsTable.querySelector("tbody");
  for (const secret of overview.secrets) {
    const row = document.createElement("tr");
    row.appendChild(td(secret.name));
    row.appendChild(td(secret.state));
    row.appendChild(td(secret.hint ?? "—"));
    row.appendChild(td(secret.lastTest ? `${secret.lastTest.ok ? "成功" : "失败"}：${secret.lastTest.message}` : "—"));
    secretsBody?.appendChild(row);
  }
  main.appendChild(secretsTable);
}

/** @param {HTMLElement} main */
export function render(main) {
  stopAutoRefresh();
  window.addEventListener("hashchange", onHashChange);
  void loadAndRender(main);
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void loadAndRender(main);
    }
  }, 30_000);
}
