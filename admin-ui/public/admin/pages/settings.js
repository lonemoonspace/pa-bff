// @ts-check
// 「设置」页：分组表单（地址 / 车站 / 时间窗 / 通知 / 车票）+ 密钥管理 + 导出导入。
import { apiGet, apiSend, ApiError } from "../api.js";
import { buildFields, collectValues, diffSettings } from "../lib/schema-form.js";

/** @typedef {import("../lib/schema-form.js").Field} Field */

/** 按 App DashboardSettingsTab.kt 的中文标签保持一致，顺序即分组内渲染顺序。 */
const LABELS = [
  { key: "originAddress", label: "出发地址", group: "地址" },
  { key: "destinationAddress", label: "目的地址", group: "地址" },
  { key: "originStation", label: "出发站", group: "车站" },
  { key: "destStation", label: "到达站", group: "车站" },
  { key: "workWindowStart", label: "上班开始", group: "时间窗" },
  { key: "workWindowEnd", label: "上班结束", group: "时间窗" },
  { key: "returnWindowStart", label: "下班开始", group: "时间窗" },
  { key: "returnWindowEnd", label: "下班结束", group: "时间窗" },
  { key: "notifyCommuteDisruption", label: "列车取消/延误提醒", group: "通知" },
  { key: "notifyFootballMatch", label: "皇马开赛/终场提醒", group: "通知" },
  { key: "notifyMorningBrief", label: "早间简报", group: "通知" },
  { key: "notifyTicketExpiry", label: "车票到期提醒", group: "通知" },
  { key: "transitPassUntil", label: "乘车月票到期", group: "车票" },
  { key: "parkingPassUntil", label: "停车票到期", group: "车票" },
  // [gate] P9 T9.4：关注线路（CONTRACT 第 9 节）六个字段，管理界面上没有站点/线路搜索器，
  // 只暴露原始字段供直接编辑（与 App 的选择器分属两条独立的编辑路径）。
  { key: "watchedLineId", label: "线路 id", group: "关注线路" },
  { key: "watchedLineCode", label: "线路号", group: "关注线路" },
  { key: "watchedStopAId", label: "站 A id", group: "关注线路" },
  { key: "watchedStopAName", label: "站 A 名称", group: "关注线路" },
  { key: "watchedStopBId", label: "站 B id", group: "关注线路" },
  { key: "watchedStopBName", label: "站 B 名称", group: "关注线路" },
];

const SECRET_LABELS = {
  google_routes: "Google Routes",
  football_data: "football-data.org",
  fcm_service_account: "FCM 服务账号",
};

const MAX_FCM_FILE_BYTES = 64 * 1024;

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
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof ApiError ? err.message : "请求失败";
}

/**
 * @param {Field[]} fields
 * @returns {Map<string, Field[]>}
 */
function groupFields(fields) {
  /** @type {Map<string, Field[]>} */
  const groups = new Map();
  for (const field of fields) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  return groups;
}

/**
 * @param {HTMLElement} main
 */
async function loadAndRender(main) {
  main.textContent = "";

  /** @type {{ properties?: Record<string, { type?: string, maxLength?: number, default?: unknown }> }} */
  let schema;
  /** @type {{ revision: number, settings: Record<string, unknown>, updatedAt: string }} */
  let record;
  /** @type {{ secrets: Array<{ name: string, state: string, hint: string|null, lastTest: { ok: boolean, message: string, at: string }|null }> }} */
  let secretsData;
  try {
    [schema, record, secretsData] = await Promise.all([
      apiGet("/admin/api/settings/schema"),
      apiGet("/admin/api/settings"),
      apiGet("/admin/api/secrets"),
    ]);
  } catch (err) {
    const p = document.createElement("p");
    p.textContent = `加载失败：${errorMessage(err)}`;
    main.appendChild(p);
    return;
  }

  const fields = buildFields(schema, LABELS);
  const state = { revision: record.revision };

  const h2 = document.createElement("h2");
  h2.textContent = "设置";
  main.appendChild(h2);

  const form = document.createElement("form");
  form.addEventListener("submit", (e) => e.preventDefault());

  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  /** @type {Record<string, HTMLElement>} */
  const issueEls = {};

  for (const [groupName, groupFieldList] of groupFields(fields)) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = groupName;
    fieldset.appendChild(legend);

    for (const field of groupFieldList) {
      const row = document.createElement("div");
      row.className = "form-row";

      const label = document.createElement("label");
      label.textContent = field.label;
      label.htmlFor = `field-${field.key}`;

      const value = record.settings[field.key];
      const input = document.createElement("input");
      input.id = `field-${field.key}`;
      if (field.kind === "boolean") {
        input.type = "checkbox";
        input.checked = Boolean(value);
      } else {
        input.type = "text";
        input.value = typeof value === "string" ? value : "";
        if (field.maxLength !== null) input.maxLength = field.maxLength;
      }

      const issueP = document.createElement("p");
      issueP.className = "field-issue";

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(issueP);
      fieldset.appendChild(row);

      inputs[field.key] = input;
      issueEls[field.key] = issueP;
    }
    form.appendChild(fieldset);
  }

  const conflictBox = document.createElement("div");
  conflictBox.className = "conflict-box";
  form.appendChild(conflictBox);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "保存";
  const saveStatus = document.createElement("p");

  /** @returns {Record<string, unknown>} */
  function readForm() {
    /** @type {Record<string, unknown>} */
    const raw = {};
    for (const field of fields) {
      raw[field.key] = field.kind === "boolean" ? inputs[field.key].checked : inputs[field.key].value;
    }
    return collectValues(fields, raw);
  }

  /**
   * @param {Record<string, unknown>} values
   */
  function applyToForm(values) {
    for (const field of fields) {
      const input = inputs[field.key];
      const value = values[field.key];
      if (field.kind === "boolean") input.checked = Boolean(value);
      else input.value = typeof value === "string" ? value : "";
    }
  }

  /**
   * @param {Record<string, unknown>} mine
   * @param {{ revision: number, settings: Record<string, unknown> }} current
   */
  function showConflict(mine, current) {
    conflictBox.textContent = "";
    const title = document.createElement("p");
    title.textContent = "设置已被其他人修改，以下字段不同：";
    conflictBox.appendChild(title);

    const list = document.createElement("ul");
    for (const key of diffSettings(mine, current.settings)) {
      const field = fields.find((f) => f.key === key);
      const label = field ? field.label : key;
      const li = document.createElement("li");
      li.textContent = `${label}：我的「${String(mine[key])}」 / 服务器「${String(current.settings[key])}」`;
      list.appendChild(li);
    }
    conflictBox.appendChild(list);

    const loadServerButton = document.createElement("button");
    loadServerButton.type = "button";
    loadServerButton.textContent = "载入服务器版本";
    loadServerButton.addEventListener("click", () => {
      applyToForm(current.settings);
      state.revision = current.revision;
      conflictBox.textContent = "";
    });

    const overwriteButton = document.createElement("button");
    overwriteButton.type = "button";
    overwriteButton.textContent = "用我的覆盖";
    overwriteButton.addEventListener("click", () => {
      void (async () => {
        try {
          const res = await apiSend("PUT", "/admin/api/settings", { settings: mine }, { "If-Match": `"r${current.revision}"` });
          state.revision = res.revision;
          conflictBox.textContent = "";
          saveStatus.textContent = "已保存";
        } catch (err) {
          window.alert(errorMessage(err));
        }
      })();
    });

    conflictBox.appendChild(loadServerButton);
    conflictBox.appendChild(overwriteButton);
  }

  saveButton.addEventListener("click", () => {
    void (async () => {
      for (const field of fields) issueEls[field.key].textContent = "";
      saveStatus.textContent = "";
      conflictBox.textContent = "";
      saveButton.disabled = true;
      const settings = readForm();
      try {
        const res = await apiSend("PUT", "/admin/api/settings", { settings }, { "If-Match": `"r${state.revision}"` });
        state.revision = res.revision;
        saveStatus.textContent = "已保存";
      } catch (err) {
        if (err instanceof ApiError && err.code === "revision_conflict") {
          const current = /** @type {{ current: { revision: number, settings: Record<string, unknown> } }} */ (err.body).current;
          showConflict(settings, current);
        } else if (err instanceof ApiError && err.code === "invalid_settings") {
          const issues = /** @type {{ issues?: Array<{ path: string, message: string }> }} */ (err.body).issues ?? [];
          for (const issue of issues) {
            const el = issueEls[issue.path];
            if (el) el.textContent = issue.message;
          }
          saveStatus.textContent = "有字段不合法，请检查";
        } else {
          saveStatus.textContent = errorMessage(err);
        }
      } finally {
        saveButton.disabled = false;
      }
    })();
  });

  form.appendChild(saveButton);
  form.appendChild(saveStatus);
  main.appendChild(form);

  renderSecrets(main, secretsData, () => void loadAndRender(main));
  renderExportImport(main, fields, () => record.settings, state, () => void loadAndRender(main));
}

/**
 * @param {HTMLElement} main
 * @param {{ secrets: Array<{ name: string, state: string, hint: string|null, lastTest: { ok: boolean, message: string, at: string }|null }> }} data
 * @param {() => void} reload
 */
function renderSecrets(main, data, reload) {
  const h3 = document.createElement("h3");
  h3.textContent = "密钥";
  main.appendChild(h3);

  for (const secret of data.secrets) {
    const box = document.createElement("div");
    box.className = "secret-box";

    const label = SECRET_LABELS[/** @type {keyof typeof SECRET_LABELS} */ (secret.name)] ?? secret.name;
    const title = document.createElement("p");
    title.textContent = `${label}：${secret.state}${secret.hint ? `（${secret.hint}）` : ""}`;
    box.appendChild(title);

    if (secret.lastTest) {
      const testP = document.createElement("p");
      testP.textContent = `最近测试：${secret.lastTest.ok ? "成功" : "失败"}：${secret.lastTest.message}`;
      box.appendChild(testP);
    }

    const status = document.createElement("p");

    if (secret.name === "fcm_service_account") {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "application/json";
      box.appendChild(fileInput);

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "上传并保存";
      saveButton.addEventListener("click", () => {
        void (async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) {
            status.textContent = "请先选择文件";
            return;
          }
          if (file.size > MAX_FCM_FILE_BYTES) {
            status.textContent = "文件超过 64 KB，拒绝上传";
            return;
          }
          const text = await file.text();
          try {
            await apiSend("PUT", `/admin/api/secrets/${encodeURIComponent(secret.name)}`, { value: text });
            reload();
          } catch (err) {
            status.textContent = errorMessage(err);
          }
        })();
      });
      box.appendChild(saveButton);
    } else {
      const passwordInput = document.createElement("input");
      passwordInput.type = "password";
      passwordInput.placeholder = "输入新值以替换";
      box.appendChild(passwordInput);

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "保存";
      saveButton.addEventListener("click", () => {
        void (async () => {
          const value = passwordInput.value;
          passwordInput.value = "";
          if (!value) {
            status.textContent = "请先输入值";
            return;
          }
          try {
            await apiSend("PUT", `/admin/api/secrets/${encodeURIComponent(secret.name)}`, { value });
            reload();
          } catch (err) {
            status.textContent = errorMessage(err);
          }
        })();
      });
      box.appendChild(saveButton);
    }

    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.textContent = "测试";
    testButton.addEventListener("click", () => {
      void (async () => {
        try {
          await apiSend("POST", `/admin/api/secrets/${encodeURIComponent(secret.name)}/test`);
          reload();
        } catch (err) {
          status.textContent = errorMessage(err);
        }
      })();
    });
    box.appendChild(testButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => {
      void (async () => {
        const ok = await confirmDialog(`确定删除密钥「${label}」吗？`);
        if (!ok) return;
        try {
          await apiSend("DELETE", `/admin/api/secrets/${encodeURIComponent(secret.name)}`);
          reload();
        } catch (err) {
          status.textContent = errorMessage(err);
        }
      })();
    });
    box.appendChild(deleteButton);

    box.appendChild(status);
    main.appendChild(box);
  }
}

/**
 * @param {HTMLElement} main
 * @param {Field[]} fields
 * @param {() => Record<string, unknown>} getCurrentSettings
 * @param {{ revision: number }} state
 * @param {() => void} reload
 */
function renderExportImport(main, fields, getCurrentSettings, state, reload) {
  const h3 = document.createElement("h3");
  h3.textContent = "导出 / 导入";
  main.appendChild(h3);

  const status = document.createElement("p");

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "导出设置";
  exportButton.addEventListener("click", () => {
    void (async () => {
      status.textContent = "";
      try {
        const res = await fetch("/admin/api/export", { headers: { "X-PA-Admin": "1" } });
        if (!res.ok) {
          status.textContent = "导出失败";
          return;
        }
        const disposition = res.headers.get("Content-Disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const filename = match ? match[1] : "pa-bff-settings.json";
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        status.textContent = "导出失败";
      }
    })();
  });
  main.appendChild(exportButton);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json";
  main.appendChild(fileInput);

  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "导入设置";
  importButton.addEventListener("click", () => {
    void (async () => {
      status.textContent = "";
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        status.textContent = "请先选择文件";
        return;
      }
      /** @type {{ format?: unknown, version?: unknown, revision?: unknown, settings?: Record<string, unknown> }} */
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        status.textContent = "文件不是合法的 JSON";
        return;
      }
      const incomingSettings = parsed && typeof parsed.settings === "object" && parsed.settings !== null ? parsed.settings : {};
      const changed = diffSettings(getCurrentSettings(), incomingSettings);
      const summary = changed.length > 0
        ? `将改动以下字段：${changed
            .map((key) => fields.find((f) => f.key === key)?.label ?? key)
            .join("、")}`
        : "与当前设置没有差异";
      const ok = await confirmDialog(`${summary}\n确定导入并覆盖当前设置吗？`);
      if (!ok) return;
      try {
        const res = await apiSend("POST", "/admin/api/import", parsed, { "If-Match": `"r${state.revision}"` });
        state.revision = res.revision;
        status.textContent = "导入成功";
        reload();
      } catch (err) {
        status.textContent = errorMessage(err);
      }
    })();
  });
  main.appendChild(importButton);
  main.appendChild(status);
}

/** @param {HTMLElement} main */
export function render(main) {
  void loadAndRender(main);
}
