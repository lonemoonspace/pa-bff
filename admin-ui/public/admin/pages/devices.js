// @ts-check
// 「设备」页：设备表（移除 / 改角色）、生成配对码（含可复制的深链）。
import { apiGet, apiSend, ApiError } from "../api.js";
import { formatPairCode, osloDateTime } from "../lib/format.js";

/**
 * 操作失败时的中文提示；409 last_owner 用固定文案，其余用 ApiError.message。
 * @param {unknown} err
 * @returns {string}
 */
function actionErrorMessage(err) {
  if (err instanceof ApiError) {
    if (err.code === "last_owner") return "不能移除或降级最后一个 owner";
    return err.message;
  }
  return "操作失败";
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
 * 用 <dialog> 弹一个确认框，返回用户是否点了确认。
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const p = document.createElement("p");
    p.textContent = message;
    dialog.appendChild(p);

    const actions = document.createElement("div");
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "取消";
    const okButton = document.createElement("button");
    okButton.type = "button";
    okButton.textContent = "确认";
    actions.appendChild(cancelButton);
    actions.appendChild(okButton);
    dialog.appendChild(actions);

    document.body.appendChild(dialog);

    function finish(/** @type {boolean} */ ok) {
      dialog.close();
      dialog.remove();
      resolve(ok);
    }
    cancelButton.addEventListener("click", () => finish(false));
    okButton.addEventListener("click", () => finish(true));
    dialog.showModal();
  });
}

/**
 * @param {HTMLElement} main
 */
async function loadAndRender(main) {
  /** @type {{ devices: Array<{ id: string, name: string, role: "owner"|"viewer", createdAt: string|null, lastSeenAt: string|null, hasPushToken: boolean }> }} */
  let data;
  try {
    data = await apiGet("/admin/api/devices");
  } catch (err) {
    main.textContent = "";
    const p = document.createElement("p");
    p.textContent = err instanceof ApiError ? `加载失败：${err.message}` : "加载失败";
    main.appendChild(p);
    return;
  }

  main.textContent = "";
  const h2 = document.createElement("h2");
  h2.textContent = "设备";
  main.appendChild(h2);

  const errorP = document.createElement("p");
  errorP.className = "warn-text";
  main.appendChild(errorP);

  // 生成配对码
  const pairSection = document.createElement("div");
  const genButton = document.createElement("button");
  genButton.type = "button";
  genButton.textContent = "生成配对码";
  const pairResult = document.createElement("p");
  genButton.addEventListener("click", () => {
    genButton.disabled = true;
    apiSend("POST", "/admin/api/pair-codes")
      .then((/** @type {{ code: string, expiresAt: string }} */ res) => {
        errorP.textContent = "";
        pairResult.textContent = "";
        const info = document.createElement("span");
        info.textContent = `配对码：${formatPairCode(res.code)}（有效期至 ${osloDateTime(res.expiresAt)}）`;
        pairResult.appendChild(info);
        pairResult.appendChild(document.createElement("br"));
        const link = `personalassistant://pair?server=${encodeURIComponent(location.origin)}&code=${encodeURIComponent(res.code)}`;
        const a = document.createElement("a");
        a.href = link;
        a.textContent = link;
        pairResult.appendChild(a);
      })
      .catch((err) => {
        pairResult.textContent = "";
        errorP.textContent = err instanceof ApiError ? `生成配对码失败：${err.message}` : "生成配对码失败";
      })
      .finally(() => {
        genButton.disabled = false;
      });
  });
  pairSection.appendChild(genButton);
  pairSection.appendChild(pairResult);
  main.appendChild(pairSection);

  const table = makeTable(["名称", "角色", "创建", "最近在线", "推送令牌", "操作"]);
  const body = table.querySelector("tbody");
  for (const device of data.devices) {
    const row = document.createElement("tr");
    row.appendChild(td(device.name));
    row.appendChild(td(device.role));
    row.appendChild(td(osloDateTime(device.createdAt)));
    row.appendChild(td(osloDateTime(device.lastSeenAt)));
    row.appendChild(td(device.hasPushToken ? "✓" : "—"));

    const actionCell = document.createElement("td");

    const nextRole = device.role === "owner" ? "viewer" : "owner";
    const roleButton = document.createElement("button");
    roleButton.type = "button";
    roleButton.textContent = nextRole === "owner" ? "设为 owner" : "设为 viewer";
    roleButton.addEventListener("click", () => {
      void (async () => {
        const ok = await confirmDialog(`确定把「${device.name}」设为 ${nextRole} 吗？`);
        if (!ok) return;
        try {
          await apiSend("PATCH", `/admin/api/devices/${encodeURIComponent(device.id)}`, { role: nextRole });
          await loadAndRender(main);
        } catch (err) {
          errorP.textContent = actionErrorMessage(err);
        }
      })();
    });
    actionCell.appendChild(roleButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "移除";
    removeButton.addEventListener("click", () => {
      void (async () => {
        const ok = await confirmDialog(`确定移除设备「${device.name}」吗？`);
        if (!ok) return;
        try {
          await apiSend("DELETE", `/admin/api/devices/${encodeURIComponent(device.id)}`);
          await loadAndRender(main);
        } catch (err) {
          errorP.textContent = actionErrorMessage(err);
        }
      })();
    });
    actionCell.appendChild(removeButton);

    row.appendChild(actionCell);
    body?.appendChild(row);
  }
  main.appendChild(table);
}

/** @param {HTMLElement} main */
export function render(main) {
  void loadAndRender(main);
}
