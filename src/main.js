/**
 * NeuroFlow CORE — 前端唯一逻辑入口
 * 样式见 styles.css；本文件负责事件监听、网速展示、Token、交互
 */

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentToken = "";
let currentMode = "fixed";

/** 自适应峰值（字节/秒），用于进度条映射，避免固定 10MB 失真 */
const ratePeak = {
  down: 256 * 1024, // 起步 256 KB/s
  up: 128 * 1024,
  minDown: 64 * 1024,
  minUp: 32 * 1024,
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 将 B/s 格式化为合适单位
 * @param {number} bytesPerSec
 * @returns {{ value: string, unit: string, bps: number }}
 */
function formatRate(bytesPerSec) {
  const bps = Math.max(0, Number(bytesPerSec) || 0);
  if (bps < 1024) {
    return { value: bps.toFixed(0), unit: "B/s", bps };
  }
  if (bps < 1024 * 1024) {
    return { value: (bps / 1024).toFixed(1), unit: "KB/s", bps };
  }
  return { value: (bps / (1024 * 1024)).toFixed(2), unit: "MB/s", bps };
}

/**
 * 自适应进度条百分比（峰值缓慢衰减，突发抬升）
 */
function barPercent(bps, kind) {
  const key = kind === "up" ? "up" : "down";
  const minKey = kind === "up" ? "minUp" : "minDown";
  // 峰值：取 max(当前, 衰减后的旧峰值, 最小值)
  ratePeak[key] = Math.max(ratePeak[minKey], bps, ratePeak[key] * 0.92);
  if (ratePeak[key] <= 0) return 0;
  return Math.min(100, Math.round((bps / ratePeak[key]) * 100));
}

function $(id) {
  return document.getElementById(id);
}

function addLog(msg, tag = "AI") {
  const list = $("log-list");
  if (!list) return;
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  li.innerHTML = `<span class="log-tag">[${tag}]</span> <span class="log-time">${time}</span> ${msg}`;
  list.prepend(li);
  while (list.children.length > 50) {
    list.removeChild(list.lastElementChild);
  }
}

function applyTokenToUi(token, mode) {
  currentToken = token || "";
  if (mode) {
    currentMode = String(mode).toLowerCase();
  }
  const el = $("token-display");
  if (el) el.textContent = currentToken || "无令牌";
  try {
    localStorage.setItem("neuro_token", currentToken);
  } catch (_) {}
  const radio = document.querySelector(
    `input[name="token_mode"][value="${currentMode}"]`
  );
  if (radio) radio.checked = true;
}

/**
 * 更新上下行数字 + 单位 + 进度条
 * @param {number} rxBps 下行 B/s
 * @param {number} txBps 上行 B/s
 */
function updateSpeedUi(rxBps, txBps) {
  const down = formatRate(rxBps);
  const up = formatRate(txBps);

  const sd = $("speed-down");
  const su = $("speed-up");
  const ud = $("unit-down");
  const uu = $("unit-up");
  const bd = $("bar-down");
  const bu = $("bar-up");

  if (sd) sd.textContent = down.value;
  if (su) su.textContent = up.value;
  if (ud) ud.textContent = down.unit;
  if (uu) uu.textContent = up.unit;
  if (bd) bd.style.width = `${barPercent(down.bps, "down")}%`;
  if (bu) bu.style.width = `${barPercent(up.bps, "up")}%`;
}

/**
 * 解析 net-speed payload：兼容 [rx,tx] / {0,1} / 对象
 */
function parseNetSpeedPayload(payload) {
  if (payload == null) return { rx: 0, tx: 0 };
  if (Array.isArray(payload)) {
    return { rx: Number(payload[0]) || 0, tx: Number(payload[1]) || 0 };
  }
  if (typeof payload === "object") {
    // serde 元组有时序列化为 { "0": rx, "1": tx }
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

// ---------------------------------------------------------------------------
// 事件监听（只注册一次）
// ---------------------------------------------------------------------------

function setupListeners() {
  // 网速：后端已是 B/s（2 秒间隔的字节差 / 2）
  listen("net-speed", (e) => {
    const { rx, tx } = parseNetSpeedPayload(e.payload);
    updateSpeedUi(rx, tx);
  });

  listen("browser-url", (e) => {
    const el = $("url-display");
    if (el) el.textContent = e.payload || "等待捕获...";
  });

  listen("network-pulse", (e) => {
    const pulse = e.payload || {};
    const score = Number(pulse.quality_score) || 0;
    const scoreEl = $("health-score");
    const barEl = $("health-bar");
    const diagEl = $("health-diag");

    if (scoreEl) scoreEl.textContent = `${score}`;
    if (barEl) {
      barEl.style.width = `${Math.min(100, score)}%`;
      let color = "var(--neon-blue)";
      if (score < 60) color = "var(--warning)";
      if (score < 40) color = "var(--danger)";
      barEl.style.background = color;
      scoreEl && (scoreEl.style.color = color);
    }
    if (diagEl) {
      const dns = pulse.dns_time_ms != null ? `${pulse.dns_time_ms}ms DNS` : "";
      const tcp =
        pulse.tcp_handshake_ms != null ? `${pulse.tcp_handshake_ms}ms TCP` : "";
      const detail = [dns, tcp].filter(Boolean).join(" · ");
      diagEl.textContent = pulse.diagnosis
        ? detail
          ? `${pulse.diagnosis}（${detail}）`
          : pulse.diagnosis
        : "数据分析中…";
    }
  });

  listen("network-mode", (e) => {
    const mode = e.payload;
    if (mode === "LOW_DATA") {
      addLog("已切换至省流模式 (移动网络)", "NET");
    } else if (mode === "HIGH_SPEED") {
      addLog("已恢复极速模式", "NET");
    }
  });

  listen("memory-warning", (e) => {
    addLog(`内存告警：占用约 ${e.payload}%`, "MEM");
  });

  listen("preload-log", (e) => {
    addLog(String(e.payload ?? ""), "LOG");
  });

  listen("auto-fix-triggered", (e) => {
    const type = e.payload?.type ?? e.payload ?? "unknown";
    const dot = $("status-dot");
    const text = $("status-text");
    if (dot) {
      dot.classList.add("alert");
      dot.classList.remove("active");
    }
    if (text) {
      text.textContent = `已修复: ${type}`;
      text.style.color = "var(--neon-blue)";
    }
    setTimeout(() => {
      if (dot) {
        dot.classList.remove("alert");
        dot.classList.add("active");
      }
      if (text) {
        text.textContent = "NeuroFlow 守护中";
        text.style.color = "";
      }
    }, 3000);
  });

  listen("ai-suggestions", (e) => {
    const suggestions = Array.isArray(e.payload) ? e.payload : [];
    const container = document.querySelector(".col-right");
    if (!container) return;

    suggestions.forEach((item) => {
      const card = document.createElement("div");
      card.className = "card suggestion-card emergency-glow";
      card.innerHTML = `
        <div class="s-head">
          <div class="s-icon">💡</div>
          <div>
            <h3 class="s-title">${escapeHtml(item.title || "建议")}</h3>
            <div class="s-desc">${escapeHtml(item.desc || "")}</div>
          </div>
        </div>
        ${
          item.button_text
            ? `<button type="button" class="glow-button">${escapeHtml(
                item.button_text
              )}</button>`
            : ""
        }
      `;
      container.insertBefore(card, container.firstChild);

      if (item.action_type) {
        const btn = card.querySelector("button");
        if (btn) {
          btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = "执行中…";
            try {
              await invoke("execute_fix_action", {
                actionType: item.action_type,
              });
              addLog(`已执行: ${item.action_type}`, "FIX");
            } catch (err) {
              addLog(`执行失败: ${err}`, "ERR");
            } finally {
              card.remove();
            }
          };
        }
      }
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 交互绑定
// ---------------------------------------------------------------------------

function setupUi() {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const panel = $(btn.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  // Token
  $("btn-copy-token")?.addEventListener("click", () => {
    if (!currentToken) return;
    navigator.clipboard.writeText(currentToken).then(
      () => addLog("令牌已复制到剪贴板", "SEC"),
      () => alert("复制失败")
    );
  });

  $("btn-rotate-token")?.addEventListener("click", async () => {
    try {
      const newToken = await invoke("rotate_token");
      applyTokenToUi(newToken, currentMode);
      addLog("令牌已轮换，请同步到插件", "SEC");
    } catch (err) {
      alert("轮换失败: " + err);
    }
  });

  document.querySelectorAll('input[name="token_mode"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const mode = radio.value;
      try {
        const newToken = await invoke("set_token_mode", {
          mode,
          currentToken,
        });
        applyTokenToUi(newToken, mode);
        addLog(
          mode === "random"
            ? "随机模式：令牌已轮换（请同步插件）"
            : "固定模式：Token 已落盘",
          "SEC"
        );
      } catch (err) {
        alert("设置失败: " + err);
      }
    });
  });

  // 扫描
  const overlay = $("scan-overlay");
  $("execute-scan-btn")?.addEventListener("click", async () => {
    overlay?.classList.remove("hidden");
    try {
      const est = await invoke("get_estimated_savings");
      const estEl = $("estimate-val");
      if (estEl) estEl.textContent = est;
      await invoke("get_background_tabs_list");
      addLog("智能扫描已触发", "SCAN");
    } catch (e) {
      console.warn(e);
    } finally {
      setTimeout(() => overlay?.classList.add("hidden"), 1800);
    }
  });
  $("cancel-scan")?.addEventListener("click", () => {
    overlay?.classList.add("hidden");
  });

  // 急救
  $("btn-emergency-fix")?.addEventListener("click", async () => {
    const btn = $("btn-emergency-fix");
    const feedback = $("fix-feedback");
    const msgEl = $("fix-msg");
    const statusText = $("gpu-status-text");

    if (btn) btn.disabled = true;
    feedback?.classList.add("show");
    if (msgEl) msgEl.textContent = "正在扫描 ShaderCache…";

    try {
      const response = await invoke("clean_gpu_cache");
      if (msgEl) msgEl.textContent = String(response);
      if (statusText) statusText.textContent = "系统已净化";
      addLog(String(response), "GPU");
    } catch (error) {
      if (msgEl) msgEl.textContent = "失败: " + error;
      addLog("GPU 清理失败: " + error, "ERR");
    } finally {
      setTimeout(() => {
        if (btn) btn.disabled = false;
      }, 2500);
    }
  });

  // 手动规则
  $("add-rule-btn")?.addEventListener("click", async () => {
    const source = $("source-domain")?.value?.trim();
    const target = $("target-sub")?.value?.trim();
    if (!source || !target) {
      alert("请填写主域名与预载子域");
      return;
    }
    try {
      await invoke("save_manual_rule", {
        source,
        target,
        allowCookie: false,
      });
      addLog(`规则已添加: ${source} → ${target}`, "RULE");
      if ($("source-domain")) $("source-domain").value = "";
      if ($("target-sub")) $("target-sub").value = "";
    } catch (e) {
      alert("添加失败: " + e);
    }
  });
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

function startPolling() {
  // 内存：后端返回可读字符串，不再错误追加 %
  const refreshMem = async () => {
    try {
      const mem = await invoke("get_memory_usage");
      const el = $("mem-display");
      if (el) el.textContent = mem;
    } catch (_) {}
  };
  refreshMem();
  setInterval(refreshMem, 4000);

  // 悬停估算
  const scanBtn = $("execute-scan-btn");
  if (scanBtn) {
    scanBtn.addEventListener("mouseenter", async () => {
      try {
        const est = await invoke("get_estimated_savings");
        const el = $("estimate-val");
        if (el) el.textContent = est;
      } catch (_) {}
    });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  setupListeners();
  setupUi();
  startPolling();

  try {
    const info = await invoke("get_token_info");
    const mode = (info.mode || "fixed").toString().toLowerCase();
    applyTokenToUi(info.token, mode);
  } catch (e) {
    try {
      const t = await invoke("get_session_token");
      applyTokenToUi(t, "fixed");
    } catch (e2) {
      if ($("token-display")) $("token-display").textContent = "连接失败";
    }
  }

  // 初始网速显示 0
  updateSpeedUi(0, 0);
  addLog("NeuroFlow 内核已连接", "SYSTEM");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// 供调试
window.__neuroflow = { formatRate, updateSpeedUi, applyTokenToUi };
