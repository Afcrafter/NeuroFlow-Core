/**
 * NeuroFlow Core — 紧凑控制面板
 * 事件与命令通过 window.__TAURI__（withGlobalTauri）
 */

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentToken = "";
let currentMode = "fixed";
let svcEnabled = true;      // 本地服务是否启用
let extOnline = false;      // 扩展是否接入过
let detailOpen = false;
let lastExtMsgAt = 0;

const W = 780;              // 面板宽度
const H_COLLAPSED = 236;    // 收起高度（与 tauri.conf 一致）
const H_EXPANDED = 660;     // 展开详情后高度

/** 速率条自适应峰值 */
const ratePeak = { down: 256 * 1024, up: 128 * 1024, minDown: 64 * 1024, minUp: 32 * 1024 };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

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
// 服务状态 UI
// ---------------------------------------------------------------------------

function setServiceUi(enabled) {
  svcEnabled = enabled;
  const dot = $("svc-dot");
  const title = $("svc-title");
  const sub = $("svc-sub");
  const btn = $("btn-service");
  const btnLabel = $("btn-service-label");
  const mini = $("status-dot-mini");
  const msg = $("status-msg");

  if (enabled) {
    dot.className = "svc-dot on";
    mini.className = "status-dot-mini on";
    title.textContent = "本地加速服务运行中";
    sub.textContent = extOnline
      ? "已监听 127.0.0.1:3030 · 浏览器扩展已接入，正在加速"
      : "已监听 127.0.0.1:3030 · 等待浏览器扩展接入…";
    sub.className = "svc-sub mono ok";
    btn.className = "act-btn service-on";
    btnLabel.textContent = "停止服务";
    msg.textContent = "服务已启动 · 转发至本地加速通道";
    msg.className = "status-msg mono ok";
    btn.title = "暂停本地加速服务";
  } else {
    dot.className = "svc-dot off";
    mini.className = "status-dot-mini off";
    title.textContent = "本地加速服务已暂停";
    sub.textContent = "浏览器扩展暂时无法连接 · 点击「启动服务」恢复";
    sub.className = "svc-sub mono alert";
    btn.className = "act-btn service-off";
    btnLabel.textContent = "启动服务";
    msg.textContent = "服务已暂停 · 浏览器扩展将无法连接";
    msg.className = "status-msg mono alert";
    btn.title = "启动本地加速服务";
  }
  refreshLinkState();
}

/** 状态栏右侧：扩展接入指示（避免与左侧重复端口信息） */
function refreshLinkState() {
  const el = $("status-right");
  if (!el) return;
  if (!svcEnabled) {
    el.textContent = "服务已暂停";
    el.className = "status-right mono idle";
  } else if (extOnline) {
    el.textContent = "扩展已接入 · 心跳正常";
    el.className = "status-right mono linked";
  } else {
    el.textContent = "等待扩展接入…";
    el.className = "status-right mono idle";
  }
}

function refreshExtStatus() {
  const el = $("ext-status");
  if (!el) return;
  if (!svcEnabled) {
    el.textContent = "服务已暂停";
    el.className = "";
  } else if (extOnline) {
    el.textContent = "● 已接入（心跳正常）";
    el.className = "on";
  } else {
    el.textContent = "等待接入…";
    el.className = "";
  }
  refreshLinkState();
}

// ---------------------------------------------------------------------------
// 网速 / 健康 UI
// ---------------------------------------------------------------------------

function updateSpeedUi(rxBps, txBps) {
  const down = formatRate(rxBps);
  const up = formatRate(txBps);

  const sd = $("speed-down"), su = $("speed-up");
  const ud = $("unit-down"), uu = $("unit-up");
  const bd = $("bar-down"), bu = $("bar-up");
  const cd = $("chip-down"), cu = $("chip-up");

  if (sd) sd.textContent = down.value;
  if (su) su.textContent = up.value;
  if (ud) ud.textContent = down.unit;
  if (uu) uu.textContent = up.unit;
  if (bd) bd.style.width = `${barPercent(down.bps, "down")}%`;
  if (bu) bu.style.width = `${barPercent(up.bps, "up")}%`;
  if (cd) cd.textContent = `${down.value} ${down.unit}`;
  if (cu) cu.textContent = `${up.value} ${up.unit}`;
}

function parseNetSpeedPayload(payload) {
  if (payload == null) return { rx: 0, tx: 0 };
  if (Array.isArray(payload)) return { rx: Number(payload[0]) || 0, tx: Number(payload[1]) || 0 };
  if (typeof payload === "object") {
    if ("0" in payload || "1" in payload) {
      return {
        rx: Number(payload[0] ?? payload["0"]) || 0,
        tx: Number(payload[1] ?? payload["1"]) || 0,
      };
    }
    return {
      rx: Number(payload.rx ?? payload.download ?? 0) || 0,
      tx: Number(payload.tx ?? payload.upload ?? 0) || 0,
    };
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
// 后端事件（只注册一次）
// ---------------------------------------------------------------------------

function setupListeners() {
  listen("net-speed", (e) => updateSpeedUi(...Object.values(parseNetSpeedPayload(e.payload))));

  listen("browser-url", (e) => {
    const el = $("url-display");
    if (el) el.textContent = e.payload || "等待捕获...";
  });

  listen("network-pulse", (e) => updateHealth(e.payload || {}));

  listen("network-mode", (e) => {
    const mode = e.payload;
    if (mode === "LOW_DATA") addLog("已切换至省流模式（移动网络）", "NET");
    else if (mode === "HIGH_SPEED") addLog("已恢复极速模式", "NET");
  });

  listen("memory-warning", (e) => {
    addLog(`内存告警：占用约 ${e.payload}%`, "MEM");
    const chip = $("chip-ram");
    if (chip) {
      const wrap = chip.closest(".chip");
      if (wrap) wrap.classList.add("warn");
    }
  });

  listen("preload-log", (e) => {
    addLog(String(e.payload ?? ""), "LOG");
  });

  listen("auto-fix-triggered", (e) => {
    const type = e.payload?.type ?? e.payload ?? "unknown";
    addLog(`自动修复已执行：${type}`, "FIX");
  });

  // 本地服务启停（面板 / 后端广播）
  listen("service-state", (e) => {
    setServiceUi(Boolean(e.payload));
    refreshExtStatus();
    addLog(e.payload ? "本地服务已启动" : "本地服务已暂停", "SVC");
  });

  // 浏览器扩展心跳（server.rs 在 mcp ping 时回推）
  listen("extension-ping", () => {
    const now = Date.now();
    if (!extOnline) {
      extOnline = true;
      addLog("浏览器扩展已接入（完成安全握手）", "LINK");
      const sub = $("svc-sub");
      if (sub && svcEnabled) sub.textContent = "已监听 127.0.0.1:3030 · 浏览器扩展已接入，正在加速";
      const msg = $("status-msg");
      if (msg) {
        msg.textContent = "扩展心跳正常 · 加速通道已就绪";
        msg.className = "status-msg mono ok";
      }
    }
    // 每 60s 刷新一次状态栏，避免刷屏
    if (now - lastExtMsgAt > 60000) {
      lastExtMsgAt = now;
      const msg = $("status-msg");
      if (msg && svcEnabled) msg.textContent = "扩展心跳正常 · 加速通道已就绪";
    }
    refreshExtStatus();
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
  try {
    localStorage.setItem("neuro_token", currentToken);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 详情面板开合（含窗口尺寸同步）
// ---------------------------------------------------------------------------

async function setDetail(open) {
  detailOpen = open;
  const panel = $("detail-panel");
  const btn = $("btn-detail");
  const label = $("btn-detail-label");
  if (panel) panel.classList.toggle("open", open);
  if (panel) panel.setAttribute("aria-hidden", String(!open));
  if (btn) btn.classList.toggle("open", open);
  if (label) label.textContent = open ? "收起" : "详情";
  try {
    await invoke("ui_resize", { width: W, height: open ? H_EXPANDED : H_COLLAPSED });
  } catch (_) {
    // 窗口 API 不可用时仅切换内容
  }
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

  // 详情开合
  $("btn-detail")?.addEventListener("click", () => setDetail(!detailOpen));

  // 复制令牌（主面板快捷）
  $("btn-token")?.addEventListener("click", async () => {
    if (!currentToken) {
      toast("令牌尚未就绪，请稍后重试", "bad");
      return;
    }
    const ok = await copyText(currentToken);
    toast(ok ? "令牌已复制，粘贴到浏览器扩展即可配对" : "复制失败，请到设置中手动复制", ok ? "good" : "bad");
  });

  // ---- 设置对话框 ----
  $("btn-settings")?.addEventListener("click", async () => {
    openModal("settings-overlay");
    refreshExtStatus();
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
  });

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
        addLog(
          mode === "random" ? "随机模式：令牌已轮换，请同步扩展" : "固定模式：Token 已落盘",
          "SEC"
        );
        toast(mode === "random" ? "已切换随机模式，令牌已轮换" : "已切换固定模式", "good");
      } catch (err) {
        toast(`设置失败: ${err}`, "bad");
      }
    });
  });

  // 开机自启
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

  // 关闭 → 托盘
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

  // ---- 关于 ----
  $("btn-about")?.addEventListener("click", () => openModal("about-overlay"));

  // ---- 详情区操作 ----
  $("add-rule-btn")?.addEventListener("click", async () => {
    const source = $("source-domain")?.value?.trim();
    const target = $("target-sub")?.value?.trim();
    if (!source || !target) {
      toast("请填写主域名与预载子域", "bad");
      return;
    }
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

  $("btn-emergency-fix")?.addEventListener("click", async () => {
    const btn = $("btn-emergency-fix");
    const msgEl = $("fix-msg");
    if (btn) btn.disabled = true;
    if (msgEl) {
      msgEl.textContent = "正在扫描 ShaderCache…";
      msgEl.className = "fix-msg mono";
    }
    try {
      const r = await invoke("clean_gpu_cache");
      if (msgEl) {
        msgEl.textContent = String(r);
        msgEl.className = "fix-msg mono done";
      }
      addLog(String(r), "GPU");
    } catch (error) {
      if (msgEl) {
        msgEl.textContent = `失败: ${error}`;
        msgEl.className = "fix-msg mono err";
      }
      addLog(`GPU 清理失败: ${error}`, "ERR");
    } finally {
      setTimeout(() => {
        if (btn) btn.disabled = false;
      }, 2500);
    }
  });

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

  // 模态框通用关闭
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".overlay").forEach((ov) => {
    ov.addEventListener("mousedown", (e) => {
      if (e.target === ov) closeModal(ov.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".overlay:not(.hidden)").forEach((ov) => closeModal(ov.id));
    }
  });
}

function openModal(id) {
  const ov = $(id);
  if (ov) ov.classList.remove("hidden");
}

function closeModal(id) {
  const ov = $(id);
  if (ov) ov.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

function startPolling() {
  const refreshMem = async () => {
    try {
      const mem = await invoke("get_memory_percent");
      const pct = Math.max(0, Math.min(100, Math.round(Number(mem) || 0)));
      const el = $("chip-ram");
      if (el) el.textContent = `${pct}%`;
      const wrap = el?.closest(".chip");
      if (wrap) wrap.classList.toggle("warn", pct > 90);
      const memLine = $("mem-display");
      if (memLine) {
        const total = await invoke("get_memory_usage").catch(() => "");
        if (total) memLine.textContent = total;
      }
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
    const bv = $("brand-ver");
    const av = $("about-ver");
    if (bv) bv.textContent = `v${ver}`;
    if (av) av.textContent = ver;
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

// 供调试
window.__neuroflow = { formatRate, updateSpeedUi, applyToken, setServiceUi, setDetail };
