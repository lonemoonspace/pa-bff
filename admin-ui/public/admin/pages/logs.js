// @ts-check
// 「日志」页：级别 / 来源筛选，按 id 降序分页，「加载更多」。
import { apiGet, ApiError } from "../api.js";
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

/** @param {HTMLElement} main */
export function render(main) {
  main.textContent = "";
  const h2 = document.createElement("h2");
  h2.textContent = "日志";
  main.appendChild(h2);

  const filterBar = document.createElement("div");
  const levelSelect = document.createElement("select");
  for (const [value, label] of [
    ["", "全部级别"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ]) {
    const option = document.createElement("option");
    option.value = value ?? "";
    option.textContent = label ?? "";
    levelSelect.appendChild(option);
  }
  const sourceInput = document.createElement("input");
  sourceInput.type = "text";
  sourceInput.placeholder = "来源（可选）";
  const filterButton = document.createElement("button");
  filterButton.type = "button";
  filterButton.textContent = "筛选";
  filterBar.appendChild(levelSelect);
  filterBar.appendChild(sourceInput);
  filterBar.appendChild(filterButton);
  main.appendChild(filterBar);

  const table = makeTable(["时间", "级别", "来源", "消息"]);
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
    if (levelSelect.value) query.set("level", levelSelect.value);
    if (sourceInput.value.trim()) query.set("source", sourceInput.value.trim());

    try {
      /** @type {{ entries: Array<{ id: number, at: string, level: string, source: string, message: string }>, nextBefore: number | null }} */
      const res = await apiGet(`/admin/api/logs?${query.toString()}`);
      for (const entry of res.entries) {
        const row = document.createElement("tr");
        row.appendChild(td(osloDateTime(entry.at)));
        row.appendChild(td(entry.level));
        row.appendChild(td(entry.source));
        row.appendChild(td(entry.message));
        tbody?.appendChild(row);
      }
      nextBefore = res.nextBefore;
      loadMoreButton.disabled = nextBefore === null;
    } catch (err) {
      errorP.textContent = err instanceof ApiError ? `加载失败：${err.message}` : "加载失败";
    }
  }

  function reload() {
    if (tbody) tbody.textContent = "";
    nextBefore = null;
    void loadPage();
  }

  filterButton.addEventListener("click", reload);
  loadMoreButton.addEventListener("click", () => void loadPage());

  void loadPage();
}
