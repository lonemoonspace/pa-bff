// @ts-check
// 「推送」页：推送记录表（分页）与测试推送（全部或指定设备）。
import { apiGet, apiSend, ApiError } from "../api.js";
import { osloDateTime } from "../lib/format.js";

const PAGE_SIZE = 50;

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
 * 设备选择框：第一项「全部设备」，其余为实际设备；没有推送令牌的禁用并标注。
 * @param {Array<{ id: string, name: string, hasPushToken: boolean }>} devices
 * @returns {HTMLSelectElement}
 */
function buildDeviceSelect(devices) {
  const select = document.createElement("select");
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "全部设备";
  select.appendChild(allOption);
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.hasPushToken ? device.name : `${device.name}（无推送令牌）`;
    if (!device.hasPushToken) option.disabled = true;
    select.appendChild(option);
  }
  return select;
}

/** @param {HTMLElement} main */
export function render(main) {
  main.textContent = "";
  const h2 = document.createElement("h2");
  h2.textContent = "推送";
  main.appendChild(h2);

  // 测试推送
  const testSection = document.createElement("div");
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.textContent = "测试推送";
  testButton.disabled = true;
  const testResult = document.createElement("p");

  /** @type {HTMLSelectElement | null} */
  let deviceSelect = null;
  apiGet("/admin/api/devices")
    .then((/** @type {{ devices: Array<{ id: string, name: string, hasPushToken: boolean }> }} */ data) => {
      deviceSelect = buildDeviceSelect(data.devices);
      testSection.insertBefore(deviceSelect, testButton);
      testButton.disabled = false;
    })
    .catch((err) => {
      testResult.textContent = err instanceof ApiError ? `设备列表加载失败：${err.message}` : "设备列表加载失败";
    });

  testButton.addEventListener("click", () => {
    testButton.disabled = true;
    testResult.textContent = "";
    const deviceId = deviceSelect ? deviceSelect.value : "";
    const body = deviceId.length > 0 ? { deviceId } : {};
    apiSend("POST", "/admin/api/push/test", body)
      .then((/** @type {{ deviceCount: number, result: { status: string, reason: string | null } }} */ res) => {
        const reasonText = res.result.reason ? `（${res.result.reason}）` : "";
        testResult.textContent = `设备数 ${res.deviceCount}，结果：${res.result.status}${reasonText}`;
      })
      .catch((err) => {
        testResult.textContent = err instanceof ApiError ? `失败：${err.message}` : "失败";
      })
      .finally(() => {
        testButton.disabled = false;
      });
  });
  testSection.appendChild(testButton);
  testSection.appendChild(testResult);
  main.appendChild(testSection);

  const h3 = document.createElement("h3");
  h3.textContent = "推送记录";
  main.appendChild(h3);

  const table = makeTable(["时间", "类别", "标题", "状态", "原因", "发送/失败/注销台数"]);
  main.appendChild(table);
  const tbody = table.querySelector("tbody");

  const errorP = document.createElement("p");
  main.appendChild(errorP);

  const loadMoreButton = document.createElement("button");
  loadMoreButton.type = "button";
  loadMoreButton.textContent = "加载更多";
  main.appendChild(loadMoreButton);

  /** @type {number | null} */
  let nextBefore = null;

  async function loadPage() {
    errorP.textContent = "";
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (nextBefore !== null) query.set("before", String(nextBefore));

    try {
      /**
       * @type {{
       *   entries: Array<{
       *     id: number, at: string, policy: string, title: string, body: string, deviceCount: number,
       *     result: { status: string, reason: string | null, sent: number, failed: number, unregistered: number } | null,
       *   }>,
       *   nextBefore: number | null,
       * }}
       */
      const res = await apiGet(`/admin/api/push-log?${query.toString()}`);
      for (const entry of res.entries) {
        const row = document.createElement("tr");
        row.appendChild(td(osloDateTime(entry.at)));
        row.appendChild(td(entry.policy));
        row.appendChild(td(entry.title));
        row.appendChild(td(entry.result ? entry.result.status : "—"));
        row.appendChild(td(entry.result && entry.result.reason ? entry.result.reason : "—"));
        row.appendChild(td(entry.result ? `${entry.result.sent}/${entry.result.failed}/${entry.result.unregistered}` : "—"));
        tbody?.appendChild(row);
      }
      nextBefore = res.nextBefore;
      loadMoreButton.disabled = nextBefore === null;
    } catch (err) {
      errorP.textContent = err instanceof ApiError ? `加载失败：${err.message}` : "加载失败";
    }
  }

  loadMoreButton.addEventListener("click", () => void loadPage());
  void loadPage();
}
