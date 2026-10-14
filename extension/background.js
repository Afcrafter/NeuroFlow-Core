// --- 配置常量 ---
// 统一存储 Key，与 content.js 保持一致
const STORAGE_KEYS = {
    TOKEN: "neuro_token",
    NET_MODE: "net_mode",
    LAST_URL: "last_url"
};

// --- 核心发送函数（Origin = chrome-extension://，配合后端 CORS 白名单） ---
async function notifyRust(payload, endpoint = "predict") {
    const storage = await chrome.storage.local.get(STORAGE_KEYS.TOKEN);
    const token = storage[STORAGE_KEYS.TOKEN];

    if (!token) {
        return { ok: false, error: "no_token" };
    }

    try {
        const response = await fetch(`http://127.0.0.1:3030/${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-neuro-token": token
            },
            body: JSON.stringify(payload)
        });

        const ct = response.headers.get("content-type") || "";
        let data = null;
        if (ct.includes("application/json")) {
            data = await response.json();
        } else {
            data = await response.text();
        }

        if (!response.ok) {
            return { ok: false, status: response.status, data };
        }
        return { ok: true, status: response.status, data };
    } catch (e) {
        // 后端未启动时静默
        return { ok: false, error: String(e) };
    }
}

// --- 场景 1: 智能 URL 跳转监测 ---
// 使用 storage 替代全局变量，防止 Service Worker 休眠导致数据丢失
async function handleUrlChange(url, actionType = "load") {
    if (!url || !url.startsWith('http')) return;

    // 读取上一次的 URL 和当前网络模式
    const data = await chrome.storage.local.get([STORAGE_KEYS.LAST_URL, STORAGE_KEYS.NET_MODE]);
    const lastUrl = data[STORAGE_KEYS.LAST_URL] || "";
    const currentNetMode = data[STORAGE_KEYS.NET_MODE] || "HIGH_SPEED";

    if (url === lastUrl && actionType === "load") return;

    // 更新 Last URL
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_URL]: url });

    // 环境感知：如果处于省流模式，降低上报频率
    if (currentNetMode === "LOW_DATA") {
        console.log("省流模式生效，仅记录核心跳转行为。");
    }

    notifyRust({
        current_url: url,
        target_url: null,
        action_type: actionType
    });
}

// --- 场景 2: 监听浏览器原生事件 ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        handleUrlChange(tab.url, "load");
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab && tab.url) {
            handleUrlChange(tab.url, "load");
        }
    } catch (e) {}
});

// --- 场景 3: 网络异常监测 (仅真正连不上才拦截) ---
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
    // 1. 仅处理主框架，忽略 iframe 报错
    if (details.frameId !== 0) return;

    // 2. 死循环熔断器：错误页自身 / 扩展内部页不处理，避免无限刷新
    const errorPageUrl = chrome.runtime.getURL("error.html");
    if (details.url.startsWith(errorPageUrl)) return;
    if (details.url.startsWith("chrome-extension://") || details.url.startsWith("about:")) return;

    // 3. 【核心削减】可恢复/瞬时错误一律不拦截，放行给浏览器自行恢复正常：
    //    - 超时、连接重置、网络切换、代理变化、缓存未命中、重定向过多……
    //      这些往往“延迟一下就能进”，强行转错误页反而把本可打开的页面锁死。
    //    只对“确定连不上”的致命错误才接管。
    const err = details.error || "";
    // 可恢复/瞬时错误关键字：命中任意一个即放行（延迟、网络切换、代理变化、缓存问题等，浏览器重试即可）
    const RECOVERABLE = /TIMED_OUT|CONNECTION_RESET|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|CONNECTION_CLOSED|CONNECTION_ABORTED|CACHE_MISS|TOO_MANY_REDIRECTS|INCOMPLETE_CHUNKED_ENCODING|RESPONSE_HEADERS_TOO_BIG|EMPTY_RESPONSE|CONTENT_LENGTH_MISMATCH|ABORTED|PROXY_CONNECTION_FAILED/i;
    if (RECOVERABLE.test(err)) {
        console.warn("[NeuroFlow] 瞬时/可恢复错误，不介入（由浏览器重试）:", err);
        notifyRust({ url: details.url, error: err }, "report_error");
        return;
    }

    // 走到这说明是“确定连不上”（DNS 解析失败 / 拒绝连接 / 断网等），才接管到错误页
    console.warn("捕获到致命加载错误，接管:", err);

    // 4. 上报给 Rust (用于桌面端日志显示)
    notifyRust({
        url: details.url,
        error: err
    }, "report_error");

    // 5. 跳转到本地错误页 (带上参数)，错误页内会提供“返回上一页”回退
    const targetUrl = encodeURIComponent(details.url);
    const reason = encodeURIComponent(err);
    const finalUrl = `${errorPageUrl}?url=${targetUrl}&reason=${reason}`;

    chrome.tabs.update(details.tabId, { url: finalUrl });
});

// --- 场景 4: 资源调度与自动化指令 ---
// 💎 [核心修复] 合并所有的 onMessage 监听器，防止冲突
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
    // A. 设置网络模式
    if (message.type === "SET_NET_MODE") {
        const mode = message.mode;
        // 存入 storage
        chrome.storage.local.set({ [STORAGE_KEYS.NET_MODE]: mode });
        console.log("插件网络模式切换至:", mode);
        sendResponse({ status: "ok" });
    }

    // B. 执行语义化冷冻
    else if (message.type === "FREEZE_TABS") {
        performSemanticFreeze();
    }

    // C. 获取可优化的后台标签页列表
    else if (message.action === "FETCH_TAB_LIST") {
        getOptimizableTabs().then(tabs => sendResponse(tabs));
        return true; // 保持异步通道开启
    }

    // D. 执行选定 ID 的冷冻
    else if (message.action === "FREEZE_SPECIFIC") {
        if (message.ids && message.ids.length) {
            chrome.tabs.discard(message.ids.map(Number)); // 确保是数字ID
        }
        sendResponse({ status: "done" });
    }

    // E. 接收 AI 自动修复指令
    else if (message.type === "EXECUTE_AI_FIX") {
        const { action } = message;
        if (action.script_type === "BROWSER_JS" && action.action_id === "clean_cookie") {
             // 执行清理 Cookie 的逻辑
             if (message.url) {
                chrome.browsingData.remove({
                    "origins": [new URL(message.url).origin]
                }, { "cookies": true }, () => {
                    if (sender.tab && sender.tab.id) {
                        chrome.tabs.reload(sender.tab.id);
                    }
                });
             }
        }
    }

    // F. L2 预加载
    else if (message.type === "L2_PRELOAD" && message.url) {
        executeL2Preload(message.url);
    }

    // G. content script 代理转发（避免网页 Origin 触发 CORS 拒绝）
    else if (message.type === "BACKEND_REQUEST") {
        const endpoint = message.endpoint || "predict";
        const payload = message.payload || {};
        notifyRust(payload, endpoint).then((result) => {
            sendResponse(result);
        });
        return true; // 异步
    }
});

// --- 辅助逻辑函数 ---

// --- 心跳保活：每 60s 静默上报一次，让桌面端保持「已接入」状态 ---
// （否则桌面端以近 120s 无请求判定断开，即使扩展已连接也会回落）
async function sendHeartbeat() {
    const res = await notifyRust({ method: "ping", id: Date.now(), params: {} }, "mcp");
    if (res && res.status === 401) {
        // 令牌已失效（后端轮换过）：复位连接状态，避免假绿
        const cur = await chrome.storage.local.get("connection_status");
        if (cur.connection_status === "connected") {
            chrome.storage.local.set({ connection_status: "disconnected" });
        }
    }
    return res;
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create("nf-heartbeat", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "nf-heartbeat") {
        sendHeartbeat();
    }
});

function performSemanticFreeze() {
    chrome.tabs.query({ active: false, discarded: false, pinned: false }, (tabs) => {
        tabs.forEach(tab => {
            // 向 tab 发送消息需要该 tab 注入了 content script
            chrome.tabs.sendMessage(tab.id, { action: "QUERY_PAGE_STATUS" }, (response) => {
                if (!chrome.runtime.lastError && response && !response.isHighValue) {
                    console.log("执行语义化冷冻:", tab.url);
                    chrome.tabs.discard(tab.id);
                }
            });
        });
    });
}

async function getOptimizableTabs() {
    const tabs = await chrome.tabs.query({
        active: false,
        pinned: false,
        audible: false,
        discarded: false
    });
    return tabs.map(t => ({
        id: t.id,
        title: t.title || "未知页面",
        url: t.url,
        favIcon: t.favIconUrl
    }));
}

async function executeL2Preload(url) {
    if (!/^https?:\/\//.test(url)) return;
    try {
        // L2 预载（带凭证）：真实 GET 拉取页面并写入 HTTP 缓存，下次导航可直接命中
        // 相比旧版 HEAD（不缓存正文），GET 才真正让预载规则生效
        await fetch(url, {
            method: 'GET',
            mode: 'no-cors',
            credentials: 'include',
            priority: 'low',
            cache: 'default'
        });
    } catch (e) { /* 站点拒绝 / 离线时静默 */ }
}