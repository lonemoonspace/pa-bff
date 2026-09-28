// @ts-check
// 管理界面外壳：顶栏、左侧导航、hash 路由。各页面的实际渲染逻辑在 pages/*.js 里，
// 由后续任务卡追加进下面的页面表（只用 Edit 追加一行，避免多张卡同时改这个文件冲突）。
import { ApiError, apiGet } from "./api.js";
import { render as renderOverview } from "./pages/overview.js";
import { render as renderDevices } from "./pages/devices.js";
import { render as renderLogs } from "./pages/logs.js";
import { render as renderPush } from "./pages/push.js";
import { render as renderSettings } from "./pages/settings.js";

/**
 * @typedef {{ label: string, render: (main: HTMLElement) => void }} Page
 */

/** @type {Record<string, Page>} */
const pages = {
  overview: { label: "总览", render: renderOverview },
  devices: { label: "设备", render: renderDevices },
  logs: { label: "日志", render: renderLogs },
  push: { label: "推送", render: renderPush },
  settings: { label: "设置", render: renderSettings },
};

/** @param {HTMLElement} main */
function renderNotImplemented(main) {
  main.textContent = "";
  const p = document.createElement("p");
  p.textContent = "尚未实现";
  main.appendChild(p);
}

/** @returns {string} */
function currentPageKey() {
  const hash = location.hash.replace(/^#\/?/, "");
  return Object.prototype.hasOwnProperty.call(pages, hash) ? hash : "overview";
}

function renderNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.textContent = "";
  const active = currentPageKey();
  for (const key of Object.keys(pages)) {
    const page = pages[key];
    if (!page) continue;
    const a = document.createElement("a");
    a.href = `#${key}`;
    a.textContent = page.label;
    a.className = key === active ? "nav-link active" : "nav-link";
    nav.appendChild(a);
  }
}

function renderPage() {
  renderNav();
  const main = document.getElementById("main");
  if (!main) return;
  const page = pages[currentPageKey()];
  if (page) {
    page.render(main);
  }
}

async function loadMe() {
  const el = document.getElementById("topbar-user");
  if (!el) return;
  try {
    const me = await apiGet("/admin/api/me");
    el.textContent = `已登录：${me.email}`;
  } catch (err) {
    if (err instanceof ApiError) {
      el.textContent = "";
    }
  }
}

window.addEventListener("hashchange", renderPage);
void loadMe();
renderPage();
