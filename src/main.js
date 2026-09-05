/**
 * NeuroFlow Core — 极简控制条 + 设置整页
 * 主视图：启停 / 复制令牌 / 设置；设置页承载运行详情、令牌配对、常规、关于
 */

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentToken = "";
let currentMode = "fixed";
let svcEnabled = true;
let extOnline = false;
let settingsOpen = false;
let lastExtMsgAt = 0;

const W = 720;          // 窗口宽度
const H_MAIN = 136;     // 主视图高度（极简控制条）
const H_SET = 660;      // 设置页高度

const ratePeak = { down: 256 * 1024, up: 128 * 1024, minDown: 64 * 1024, minUp: 32 * 1024 };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRate(bytesPerSec) {
  const bps = Math.max(0, Number(bytesPerSec) || 0);
  if (bps < 1024) return { value: bps.toFixed(0), unit: "B/s", bps };
  if (bps < 1024 * 1024) return { value: (bps / 1024).toFixed(1), unit: "KB/s", bps };
  return { value: (bps / (1024 * 1024)).toFixed(2), unit: "MB/s", bps };
}

function barPercent(bps, kind) {
  const key = kind === "up" ? "up" : "down";
  const minKey = kind === "up" ? "minUp" : "minDown";
  ratePeak[key] = Math.max(ratePeak[minKey], bps, ratePeak[key] * 0.92);
  if (ratePeak[key] <= 0) return 0;
  return Math.min(100, Math.round((bps / ratePeak[key]) * 100));
}

let toastTimer = null;
function toast(msg, kind = "") {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function addLog(msg, tag = "AI") {
  const list = $("log-list");
  if (!list) return;
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  li.innerHTML = `<span class="log-tag">[${escapeHtml(tag)}]</span><span class="log-time">${time}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
  list.prepend(li);
  while (list.children.length > 60) list.removeChild(list.lastElementChild);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 服务状态 UI（主视图单行 + 设置页心跳状态）
// ---------------------------------------------------------------------------

function setServiceUi(enabled) {
  svcEnabled = enabled;
  const dot = $("svc-dot");
  const title = $("svc-title");
  const btn = $("btn-service");
  const label = $("btn-service-label");

  if (enabled) {
    if (dot) { dot.className = "svc-dot on"; }
    if (title) { title.textContent = "服务运行中"; title.className = "svc-title"; }
    if (btn) { btn.className = "act-btn service-on"; btn.title = "暂停本地加速服务"; }
    if (label) label.textContent = "停止服务";
  } else {
    if (dot) { dot.className = "svc-dot off"; }
    if (title) { title.textContent = "服务已暂停"; title.className = "svc-title off"; }
    if (btn) { btn.className = "act-btn service-off"; btn.title = "启动本地加速服务"; }
    if (label) label.textContent = "启动服务";
  }
  refreshExtState();
}

function refreshExtState() {
  const el = $("ext-state");
  const st = $("ext-status");
  if (el) {
    if (!svcEnabled) { el.textContent = "服务已暂停"; el.className = "ext-state alert"; }
    else if (extOnline) { el.textContent = "扩展已接入 · 心跳正常"; el.className = "ext-state linked"; }
    else { el.textContent = "等待扩展接入…"; el.className = "ext-state"; }
  }
  if (st) {
    if (!svcEnabled) { st.textContent = "服务已暂停"; st.className = ""; }
    else if (extOnline) { st.textContent = "● 已接入（心跳正常）"; st.className = "on"; }
    else { st.textContent = "等待接入…"; st.className = ""; }
  }
}

// ---------------------------------------------------------------------------
// 视图切换（主视图 ⇄ 设置整页）
// ---------------------------------------------------------------------------

async function setView(openSettings) {
  settingsOpen = openSettings;
  const main = $("view-main");
  const page = $("page-settings");
  if (main) main.classList.toggle("hidden", openSettings);
  if (page) page.classList.toggle("hidden", !openSettings);
  try {
    await invoke("ui_resize", { width: W, height: openSettings ? H_SET : H_MAIN });
  } catch (_) {}
  if (openSettings) {
    refreshExtState();
    try {
      const [auto, tray] = await Promise.all([
        invoke("get_autostart").catch(() => false),
        invoke("get_close_to_tray").catch(() => true),
      ]);
      const a = $("opt-autostart");
      const t = $("opt-tray");
      if (a) a.checked = Boolean(auto);
      if (t) t.checked = Boolean(tray);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 网速 / 健康
// ---------------------------------------------------------------------------

function updateSpeedUi(rxBps, txBps) {
  const down = formatRate(rxBps);
  const up = formatRate(txBps);
  const map = [
    ["speed-down", down.value], ["unit-down", down.unit],
    ["speed-up", up.value], ["unit-up", up.unit],
  ];
  map.forEach(([id, v]) => { const el = $(id); if (el) el.textContent = v; });
  const bd = $("bar-down");
  const bu = $("bar-up");
  if (bd) bd.style.width = `${barPercent(down.bps, "down")}%`;
  if (bu) bu.style.width = `${barPercent(up.bps, "up")}%`;
}

function parseNetSpeedPayload(payload) {
  if (payload == null) return { rx: 0, tx: 0 };
  if (Array.isArray(payload)) return { rx: Number(payload[0]) || 0, tx: Number(payload[1]) || 0 };
  if (typeof payload === "object") {
    if ("0" in payload || "1" in payload) {
      return { rx: Number(payload[0] ?? payload["0"]) || 0, tx: Number(payload[1] ?? payload["1"]) || 0 };
    }
    return { rx: Number(payload.rx ?? payload.download ?? 0) || 0, tx: Number(payload.tx ?? payload.upload ?? 0) || 0 };
  }
  return { rx: 0, tx: 0 };
}

function updateHealth(pulse) {
  const score = Number(pulse.quality_score) || 0;
  const scoreEl = $("health-score");
  const barEl = $("health-bar");
  const diagEl = $("health-diag");
  if (scoreEl) {
    scoreEl.textContent = `${score}/100`;
    scoreEl.className = score < 40 ? "bad" : score < 60 ? "weak" : "";
  }
  if (barEl) {
    barEl.style.width = `${Math.min(100, score)}%`;
    barEl.style.background = score < 40 ? "var(--red)" : score < 60 ? "var(--amber)" : "var(--green)";
  }
  if (diagEl) {
    const dns = pulse.dns_time_ms != null ? `${pulse.dns_time_ms}ms DNS` : "";
    const tcp = pulse.tcp_handshake_ms != null ? `${pulse.tcp_handshake_ms}ms TCP` : "";
    const detail = [dns, tcp].filter(Boolean).join(" · ");
    diagEl.textContent = pulse.diagnosis
      ? detail ? `${pulse.diagnosis}（${detail}）` : pulse.diagnosis
      : "数据分析中…";
  }
}

// ---------------------------------------------------------------------------
// 后端事件
// ---------------------------------------------------------------------------

function setupListeners() {
  listen("net-speed", (e) => {
    const { rx, tx } = parseNetSpeedPayload(e.payload);
    updateSpeedUi(rx, tx);
  });

  listen("browser-url", (e) => {
    const el = $("url-display");
    if (el) el.textContent = e.payload || "等待捕获...";
  });

  listen("network-pulse", (e) => updateHealth(e.payload || {}));

  listen("network-mode", (e) => {
    if (e.payload === "LOW_DATA") addLog("已切换至省流模式（移动网络）", "NET");
    else if (e.payload === "HIGH_SPEED") addLog("已恢复极速模式", "NET");
  });

  listen("memory-warning", (e) => {
    addLog(`内存告警：占用约 ${e.payload}%`, "MEM");
  });

  listen("preload-log", (e) => addLog(String(e.payload ?? ""), "LOG"));

  listen("auto-fix-triggered", (e) => {
    addLog(`自动修复已执行：${e.payload?.type ?? e.payload ?? "unknown"}`, "FIX");
  });

  listen("service-state", (e) => {
    setServiceUi(Boolean(e.payload));
    addLog(e.payload ? "本地服务已启动" : "本地服务已暂停", "SVC");
  });

  // 扩展心跳回显（server.rs 在 mcp ping 时回推）
  listen("extension-ping", () => {
    const now = Date.now();
    if (!extOnline) {
      extOnline = true;
      addLog("浏览器扩展已接入（完成安全握手）", "LINK");
    }
    if (now - lastExtMsgAt > 60000) {
      lastExtMsgAt = now;
    }
    refreshExtState();
  });

  // 关闭窗口 → 驻留托盘
  listen("to-tray", () => {
    toast("已最小化到托盘，服务继续运行 — 点击托盘图标恢复面板", "good");
  });
}

// ---------------------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------------------

function applyToken(token, mode) {
  currentToken = token || "";
  if (mode) currentMode = String(mode).toLowerCase();
  const el = $("settings-token");
  if (el) el.textContent = currentToken || "无令牌";
  const radio = document.querySelector(`input[name="token_mode"][value="${currentMode}"]`);
  if (radio) radio.checked = true;
  try { localStorage.setItem("neuro_token", currentToken); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 交互绑定
// ---------------------------------------------------------------------------

function setupUi() {
  // 窗口控制
  $("win-min")?.addEventListener("click", () => invoke("ui_minimize").catch(() => {}));
  $("win-close")?.addEventListener("click", () => invoke("ui_close").catch(() => {}));

  // 服务启停
  $("btn-service")?.addEventListener("click", async () => {
    try {
      await invoke("set_service_enabled", { enabled: !svcEnabled });
    } catch (err) {
      toast(`操作失败: ${err}`, "bad");
    }
  });

  // 复制令牌（主视图）
  $("btn-token")?.addEventListener("click", async () => {
    if (!currentToken) { toast("令牌尚未就绪，请稍后重试", "bad"); return; }
    const ok = await copyText(currentToken);
    toast(ok ? "令牌已复制，粘贴到浏览器扩展即可配对" : "复制失败，请到设置中手动复制", ok ? "good" : "bad");
  });

  // 设置页开合
  $("btn-settings")?.addEventListener("click", () => setView(true));
  $("btn-back")?.addEventListener("click", () => setView(false));

  // 令牌操作（设置页）
  $("settings-copy")?.addEventListener("click", async () => {
    if (!currentToken) return;
    const ok = await copyText(currentToken);
    toast(ok ? "令牌已复制到剪贴板" : "复制失败", ok ? "good" : "bad");
  });

  $("settings-rotate")?.addEventListener("click", async () => {
    try {
      const t = await invoke("rotate_token");
      applyToken(t, currentMode);
      addLog("令牌已轮换，请在扩展中重新粘贴", "SEC");
      toast("令牌已轮换", "good");
    } catch (err) {
      toast(`轮换失败: ${err}`, "bad");
    }
  });

  document.querySelectorAll('input[name="token_mode"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const mode = radio.value;
      try {
        const newToken = await invoke("set_token_mode", { mode, currentToken });
        applyToken(newToken, mode);
        addLog(mode === "random" ? "随机模式：令牌已轮换，请同步扩展" : "固定模式：Token 已落盘", "SEC");
        toast(mode === "random" ? "已切换随机模式，令牌已轮换" : "已切换固定模式", "good");
      } catch (err) {
        toast(`设置失败: ${err}`, "bad");
      }
    });
  });

  // 开机自启 / 驻留托盘
  $("opt-autostart")?.addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      await invoke("set_autostart", { enabled: on });
      toast(on ? "已开启开机自启" : "已关闭开机自启", "good");
    } catch (err) {
      toast(`设置失败: ${err}`, "bad");
      e.target.checked = !on;
    }
  });

  $("opt-tray")?.addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      await invoke("set_close_to_tray_cmd", { enabled: on });
      toast(on ? "关闭窗口后将驻留托盘" : "关闭窗口将完全退出（服务停止）", "good");
    } catch (err) {
      toast(`设置失败: ${err}`, "bad");
      e.target.checked = !on;
    }
  });

  // 预载规则
  $("add-rule-btn")?.addEventListener("click", async () => {
    const source = $("source-domain")?.value?.trim();
    const target = $("target-sub")?.value?.trim();
    if (!source || !target) { toast("请填写主域名与预载子域", "bad"); return; }
    try {
      await invoke("save_manual_rule", { source, target, allowCookie: false });
      addLog(`规则已添加: ${source} → ${target}`, "RULE");
      toast("规则已生效", "good");
      if ($("source-domain")) $("source-domain").value = "";
      if ($("target-sub")) $("target-sub").value = "";
    } catch (e) {
      toast(`添加失败: ${e}`, "bad");
    }
  });

  // 一键急救
  $("btn-emergency-fix")?.addEventListener("click", async () => {
    const btn = $("btn-emergency-fix");
    const msgEl = $("fix-msg");
    if (btn) btn.disabled = true;
    if (msgEl) { msgEl.textContent = "正在扫描 ShaderCache…"; msgEl.className = "fix-msg mono"; }
    try {
      const r = await invoke("clean_gpu_cache");
      if (msgEl) { msgEl.textContent = String(r); msgEl.className = "fix-msg mono done"; }
      addLog(String(r), "GPU");
    } catch (error) {
      if (msgEl) { msgEl.textContent = `失败: ${error}`; msgEl.className = "fix-msg mono err"; }
      addLog(`GPU 清理失败: ${error}`, "ERR");
    } finally {
      setTimeout(() => { if (btn) btn.disabled = false; }, 2500);
    }
  });

  // 智能扫描
  $("btn-scan")?.addEventListener("click", async () => {
    try {
      const est = await invoke("get_estimated_savings");
      const el = $("estimate-val");
      if (el) el.textContent = est;
      await invoke("get_background_tabs_list");
      addLog("智能扫描已触发，向扩展请求标签列表…", "SCAN");
      toast("扫描请求已发送给扩展", "good");
    } catch (e) {
      toast(`扫描失败: ${e}`, "bad");
    }
  });

  // ESC 返回主视图
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen) setView(false);
  });
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

function startPolling() {
  const refreshMem = async () => {
    try {
      const mem = await invoke("get_memory_percent");
      const pct = Math.max(0, Math.min(100, Math.round(Number(mem) || 0)));
      const memLine = $("mem-display");
      const total = await invoke("get_memory_usage").catch(() => "");
      if (memLine) memLine.textContent = total ? `${total}（${pct}%）` : `${pct}%`;
    } catch (_) {}
  };
  refreshMem();
  setInterval(refreshMem, 4000);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  setupListeners();
  setupUi();
  startPolling();

  // 版本
  try {
    const ver = await invoke("get_app_version");
    ["brand-ver", "page-ver", "about-ver"].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = el.id === "brand-ver" || el.id === "page-ver" ? `v${ver}` : ver;
    });
  } catch (_) {}

  // 令牌
  try {
    const info = await invoke("get_token_info");
    applyToken(info.token, (info.mode || "fixed").toString().toLowerCase());
  } catch (_) {
    try {
      const t = await invoke("get_session_token");
      applyToken(t, "fixed");
    } catch (_) {
      const el = $("settings-token");
      if (el) el.textContent = "连接失败";
    }
  }

  // 服务状态
  try {
    const enabled = await invoke("get_service_state");
    setServiceUi(Boolean(enabled));
  } catch (_) {
    setServiceUi(true);
  }

  updateSpeedUi(0, 0);
  addLog("核心引擎已就绪", "SYSTEM");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

window.__neuroflow = { formatRate, updateSpeedUi, applyToken, setServiceUi, setView };
