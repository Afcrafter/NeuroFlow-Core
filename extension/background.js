// --- 配置常量 ---
// 统一存储 Key，与 content.js 保持一致
const STORAGE_KEYS = {
    TOKEN: "neuro_token",
    NET_MODE: "net_mode",
    LAST_URL: "last_url"
};

// --- 核心发送函数 (修复鉴权) ---
// 适配 Rust 的数据结构，向后端报告行为或错误
async function notifyRust(payload, endpoint = "predict") {
    // 1. 动态获取 Token (解决鉴权失败问题)
    const storage = await chrome.storage.local.get(STORAGE_KEYS.TOKEN);
    const token = storage[STORAGE_KEYS.TOKEN];

    if (!token) {
        // console.warn("后台未配置 Token，跳过上报");
        return;
    }

    try {
        await fetch(`http://127.0.0.1:3030/${endpoint}`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-neuro-token": token // 💎 [核心修复] 加上身份牌
            },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        // 后端未启动时静默处理
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

// --- 场景 3: 网络异常监测 (修复版 - 解决无限刷新) ---
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
    // 1. 仅处理主框架，忽略 iframe 报错
    if (details.frameId !== 0) return; 
    
    // [关键修复 1] 获取插件本地错误页的真实地址
    const errorPageUrl = chrome.runtime.getURL("error.html");

    // [关键修复 2] 死循环熔断器：
    // 如果当前出错的 URL 已经是我们的错误页了，说明发生了二次错误，必须立即停止，否则会无限刷新
    if (details.url.startsWith(errorPageUrl)) return;
    
    // 3. 忽略插件内部页面和其他非 HTTP 协议 (防止把设置页或空白页也拦截了)
    if (details.url.startsWith("chrome-extension://") || details.url.startsWith("about:")) return;

    console.warn("捕获到加载错误，正在介入:", details.error);

    // 4. 上报给 Rust (保持原有逻辑，用于桌面端日志显示)
    notifyRust({
        url: details.url,
        error: details.error
    }, "report_error");

    // 5. 跳转到本地错误页 (带上参数)
    // 我们把原始 URL 和错误原因编码后传给 error.html，让 HTML 自己去渲染内容
    const targetUrl = encodeURIComponent(details.url);
    const reason = encodeURIComponent(details.error);
    
    // 构造最终跳转地址： extension://xxxx/error.html?url=...&reason=...
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
});

// --- 辅助逻辑函数 ---

function performSemanticFreeze() {
    chrome.tabs.query({ active: false, discarded: false, pinned: false }, (tabs) => {
        tabs.forEach(tab => {
            // 向 tab 发送消息需要该 tab 注入了 content script
            chrome.tabs.sendMessage(tab.id, { action: "QUERY_PAGE_STATUS" }, (response) => {
                if (!chrome.runtime.lastError && response && !response.isHighValue) {
                    console.log("执行语义化冷冻:", tab.url);
                    chrome.tabs.discard(tab.id);
                } else if (chrome.runtime.lastError) {
                    // 如果连接失败（可能没加载 content script），默认可以冷冻
                    // chrome.tabs.discard(tab.id);
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
    try {
        await fetch(url, {
            method: 'HEAD',
            mode: 'no-cors', 
            credentials: 'include',
            priority: 'low'
        });
    } catch (e) {}
}