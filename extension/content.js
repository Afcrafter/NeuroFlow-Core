// ==========================================
// 1. 配置与状态管理
// ==========================================
const CONFIG = {
    CHECK_INTERVAL: 3000,       // 视频检测频率 (3s)
    HEARTBEAT_INTERVAL: 30000,  // 心跳上报频率 (30s)
    HOVER_DELAY: 300,           // 悬停预加载阈值
};

// 全局状态
let state = {
    lastHeartbeat: 0,
    hoverTimer: null
};

// ==========================================
// 2. 统一通讯层（经 background 转发，Origin 为扩展源）
// ==========================================

/**
 * 经 Service Worker 转发到本地后端（配合收紧后的 CORS）
 * @param {string} endpoint - 路由端点 (e.g. 'mcp', 'predict')
 * @param {object} payload - 发送的数据
 */
async function sendBackendRequest(endpoint, payload) {
    try {
        const result = await chrome.runtime.sendMessage({
            type: "BACKEND_REQUEST",
            endpoint,
            payload
        });

        if (!result || !result.ok) {
            return;
        }

        if (endpoint === "mcp" && result.data && result.data.result) {
            if (result.data.result.status === "Ignored") {
                console.warn(`[NeuroFlow] 隐私熔断: ${result.data.result.reason}`);
            }
        }
    } catch (e) {
        // 静默失败
    }
}

// 封装 MCP 调用 (对应 Rust 的 mcp_route)
function callMcp(method, params = {}) {
    sendBackendRequest('mcp', {
        jsonrpc: "2.0",
        method: method,
        params: params,
        id: Date.now()
    });
}

// ==========================================
// 3. 核心循环守护 (Main Loop)
// ==========================================

setInterval(() => {
    // --- [模块 A] 视频哨兵 (高频 3s) ---
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) {
        videos.forEach(v => {
            // 检测解码错误或黑屏
            if (v.error) {
                console.warn(`[NeuroFlow] 修复视频错误: ${v.error.code}`);
                const src = v.currentSrc;
                const time = v.currentTime;
                
                if (src) {
                    v.src = ''; 
                    v.load();
                    setTimeout(() => {
                        v.src = src;
                        v.currentTime = time;
                        v.play().catch(() => {});
                    }, 100);
                    showToast("已修复视频解码错误");
                }
            }
        });
    }

    // --- [模块 B] 语义心跳 (低频 30s) ---
    const now = Date.now();
    if (now - state.lastHeartbeat > CONFIG.HEARTBEAT_INTERVAL) {
        state.lastHeartbeat = now;
        
        const analysis = analyzePageValue();

        // 1. 本地保存表单数据 (防丢)
        if (analysis.snapshot.inputs) {
            chrome.storage.local.set({ [`state_${window.location.href}`]: analysis.snapshot });
        }
        console.log("💓 [NeuroFlow] 准备发送心跳:", analysis);

        // 2. 发送心跳给 Rust (告诉后台“我不该死”)
        callMcp('update_tab_heartbeat', {
            url: analysis.url,
            title: analysis.title,
            score: analysis.score, // 关键：Rust 根据这个分数决定杀不杀
            active_reasons: analysis.reasons,
            timestamp: now
        });
    }

}, CONFIG.CHECK_INTERVAL);

// ==========================================
// 4. L2 意图侦测 (Mouseover Intent)
// ==========================================

document.addEventListener('mouseover', (e) => {
    const link = e.target.closest('a');
    if (link && link.href && link.href.startsWith('http')) {
        clearTimeout(state.hoverTimer);
        state.hoverTimer = setTimeout(() => {
            // 发送给 predict 路由
            sendBackendRequest('predict', {
                current_url: window.location.href,
                target_url: link.href,
                action_type: "hover"
            });
        }, CONFIG.HOVER_DELAY);
    }
});

document.addEventListener('mouseout', () => {
    clearTimeout(state.hoverTimer);
});

// ==========================================
// 5. 现场复苏 (Resurrection)
// ==========================================

window.addEventListener('load', async () => {
    // 页面加载时，检查有没有“临终遗言”
    const key = `state_${window.location.href}`;
    const saved = await chrome.storage.local.get(key);
    
    if (saved[key]) {
        console.log("[NeuroFlow] ♻️ 恢复现场...");
        const snapshot = saved[key];

        // 恢复滚动条
        if (snapshot.scrollY) window.scrollTo(snapshot.scrollX, snapshot.scrollY);

        // 恢复表单
        if (snapshot.inputs) {
            let recoveredCount = 0;
            Object.values(snapshot.inputs).forEach(item => {
                // 尝试用 CSS Path 找回元素
                const el = document.querySelector(item.path);
                if (el) {
                    el.value = item.val;
                    el.dispatchEvent(new Event('input', { bubbles: true })); // 触发 React/Vue 更新
                    el.style.boxShadow = "0 0 5px #00f2ff"; // 高亮提示
                    recoveredCount++;
                }
            });
            if (recoveredCount > 0) showToast(`已恢复 ${recoveredCount} 个未保存输入`);
        }
        // 恢复后清除，避免下次误恢复
        chrome.storage.local.remove(key);
    }
});

// ==========================================
// 6. 语义分析引擎 (Analysis Engine)
// ==========================================

function analyzePageValue() {
    let score = 0;
    let reasons = [];
    let stateSnapshot = {};

    // A. 媒体播放检测 (+1000分)
    const media = document.querySelectorAll('audio, video');
    let isPlaying = false;
    media.forEach(el => {
        if (!el.paused && !el.ended && el.currentTime > 0) isPlaying = true;
    });
    if (isPlaying) {
        score += 1000;
        reasons.push("Media Playing");
    }

    // B. 未提交表单检测 (+500分)
    const inputs = document.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]');
    let inputData = {};
    let hasInput = false;
    
    inputs.forEach((el, index) => {
        const val = el.value || el.innerText;
        // 忽略短于5个字的输入（搜索框等）
        if (val && val.length > 5) {
            hasInput = true;
            inputData[`input_${index}`] = { 
                val: val, 
                path: getCssPath(el) 
            };
        }
    });
    if (hasInput) {
        score += 500;
        reasons.push("Drafting");
        stateSnapshot.inputs = inputData;
    }

    // C. 专业工具检测 (+800分)
    const title = document.title.toLowerCase();
    if (title.includes("jupyter") || title.includes("colab") || title.includes("figma")) {
        // 进一步检测运行状态
        if (document.querySelector('.jp-mod-running') || document.querySelector('.colab-run-button-running')) {
            score += 800;
            reasons.push("Kernel Running");
        } else {
            score += 50;
        }
    }

    // D. 记录滚动位置
    stateSnapshot.scrollY = window.scrollY;
    stateSnapshot.scrollX = window.scrollX;

    return {
        score,
        reasons,
        snapshot: stateSnapshot,
        url: window.location.href,
        title: document.title
    };
}

// 辅助：生成唯一的 CSS 路径
function getCssPath(el) {
    if (!(el instanceof Element)) return;
    var path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
        var selector = el.nodeName.toLowerCase();
        if (el.id) {
            selector += '#' + el.id;
            path.unshift(selector);
            break;
        } else {
            var sib = el, nth = 1;
            while (sib = sib.previousElementSibling) {
                if (sib.nodeName.toLowerCase() == selector) nth++;
            }
            if (nth != 1) selector += ":nth-of-type("+nth+")";
        }
        path.unshift(selector);
        el = el.parentNode;
    }
    return path.join(" > ");
}

// ==========================================
// 7. 消息监听 (External Listeners)
// ==========================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 后台查询当前页面状态（用于决定是否杀掉）
    if (request.action === "QUERY_PAGE_STATUS") {
        const result = analyzePageValue();
        sendResponse({ 
            isHighValue: result.score > 100, // 简单阈值判断
            score: result.score 
        });
    }
});

// ==========================================
// 8. UI 辅助 (Toast)
// ==========================================

function showToast(text) {
    const div = document.createElement('div');
    div.innerHTML = `🛡️ <span style="margin-left:5px">${text}</span>`;
    div.style.cssText = `
        position: fixed; bottom: 30px; right: 30px;
        background: rgba(13, 17, 23, 0.9); border: 1px solid #00f2ff; color: #fff;
        padding: 10px 15px; border-radius: 6px; z-index: 2147483647;
        font-family: sans-serif; font-size: 13px; box-shadow: 0 0 15px rgba(0,242,255,0.2);
        animation: slideIn 0.3s ease-out; pointer-events: none;
    `;
    document.body.appendChild(div);
    
    // 注入动画关键帧
    if (!document.getElementById('neuro-style')) {
        const style = document.createElement('style');
        style.id = 'neuro-style';
        style.innerHTML = `@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
        document.head.appendChild(style);
    }

    setTimeout(() => {
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';
        setTimeout(() => div.remove(), 500);
    }, 3000);
}