const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// --- 全局变量 ---
let currentToken = "";

// ==========================================
// 1. 基础状态监听 (核心数据流)
// ==========================================

// 监听网速
// 监听数据
listen('net-speed', e => {
    // e.payload 是个数组或元组: [rx, tx]
    // rx = download, tx = upload
    // 注意：Rust 传过来的是字节(Bytes)，除以 1024 变成 KB
    const rx = (e.payload[0] / 1024).toFixed(1);
    const tx = (e.payload[1] / 1024).toFixed(1);

    // 更新数字
    document.getElementById('speed-down').innerText = rx;
    document.getElementById('speed-up').innerText = tx;

    // [新增] 更新底部装饰条的宽度 (简单的视觉效果)
    // 假设 10MB/s (10240 KB/s) 撑满进度条，做个简单的映射
    const maxSpeed = 10240; 
    document.getElementById('bar-down').style.width = Math.min((rx / maxSpeed) * 100, 100) + "%";
    document.getElementById('bar-up').style.width = Math.min((tx / maxSpeed) * 100, 100) + "%";
});

// 监听当前焦点 URL
listen('browser-url', (event) => {
    // [修复] ID 改为 url-display
    const el = document.getElementById('url-display');
    if (el) el.innerText = event.payload || "等待捕获...";
});

// 监听脉搏/健康度
listen('network-pulse', e => {
    const pulse = e.payload; 
    const scoreEl = document.getElementById('health-score');
    const barEl = document.getElementById('health-bar');
    const diagEl = document.getElementById('health-diag');
    
    if (scoreEl && barEl) {
        scoreEl.innerText = pulse.quality_score;
        barEl.style.width = `${pulse.quality_score}%`;
        
        // 动态变色
        let color = 'var(--neon-blue)';
        if (pulse.quality_score < 60) color = '#ffeb3b';
        if (pulse.quality_score < 40) color = '#ff4d4f';
        
        scoreEl.style.color = color;
        barEl.style.background = color;
    }
    if (diagEl) diagEl.innerText = pulse.diagnosis || "数据分析中...";
});

// 监听自动修复反馈
listen('auto-fix-triggered', (event) => {
    const { type } = event.payload;
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    
    if (dot && text) {
        dot.style.background = "var(--neon-blue)";
        dot.style.boxShadow = "0 0 15px var(--neon-blue)";
        text.innerText = `⚡ 已修复: ${type}`;
        text.style.color = "var(--neon-blue)";
        
        setTimeout(() => {
            dot.style.background = "#0f0";
            dot.style.boxShadow = "0 0 8px #0f0";
            text.innerText = "NeuroFlow 守护中";
            text.style.color = "#888";
        }, 3000);
    }
});

// 监听日志流
listen('preload-log', e => {
    const list = document.getElementById('log-list');
    if (list) {
        const li = document.createElement('li');
        li.innerHTML = `<span style="color:var(--neon-blue)">[${new Date().toLocaleTimeString().split(' ')[0]}]</span> ${e.payload}`;
        list.prepend(li);
        // 保持日志不超过 50 条
        if (list.children.length > 50) list.lastElementChild.remove();
    }
});

// --- [新增] 监听 AI 修复建议 ---
listen('ai-suggestions', (event) => {
    const suggestions = event.payload; // 这是一个数组
    const container = document.querySelector('.col-right'); // 我们把它插到右栏

    suggestions.forEach(item => {
        // 创建卡片 DOM
        const card = document.createElement('div');
        card.className = 'card suggestion-card emergency-glow'; // 用上我们刚写的 CSS 动画
        card.style.marginTop = "15px";
        
        card.innerHTML = `
            <div style="display:flex; align-items:center; margin-bottom:10px;">
                <div style="font-size:20px; margin-right:10px;">💡</div>
                <div>
                    <h3 style="margin:0; border:none; color:#fff;">${item.title}</h3>
                    <div style="font-size:11px; color:#ccc;">${item.desc}</div>
                </div>
            </div>
            ${item.button_text ? `
            <button class="glow-button" style="width:100%; font-size:12px; padding:8px;">
                ${item.button_text}
            </button>
            ` : ''}
        `;

        // 插入到 Token 卡片之前，或者直接 prepend 到容器最上面
        if (container) {
            container.insertBefore(card, container.firstChild);
        }

        // 绑定按钮点击事件 (如果有 action_type)
        if (item.action_type) {
            const btn = card.querySelector('button');
            if (btn) {
                btn.onclick = async () => {
                    btn.innerText = "正在执行...";
                    btn.disabled = true;
                    // 这里可以调用后端命令，目前先做视觉反馈
                    setTimeout(() => {
                        card.remove(); // 执行完移除卡片
                        alert(`已执行指令: ${item.action_type}`);
                    }, 1000);
                };
            }
        }
    });
});

// ==========================================
// 2. 交互逻辑 (按钮与开关)
// ==========================================

// 智能扫描逻辑
const scanBtn = document.getElementById('execute-scan-btn');
const overlay = document.getElementById('scan-overlay');
const cancelScanBtn = document.getElementById('cancel-scan');

if (scanBtn && overlay) {
    scanBtn.onclick = async () => {
        overlay.classList.remove('hidden');
        // 模拟扫描过程 + 真实调用
        setTimeout(async () => {
           try {
               // 这里可以调用 get_background_tabs_list 如果你需要处理返回数据
               // 目前仅做视觉演示
               overlay.classList.add('hidden');
               addLog("智能扫描完成，资源已优化");
           } catch(e) {
               overlay.classList.add('hidden');
           }
        }, 2000);
    };
}

if (cancelScanBtn) {
    cancelScanBtn.onclick = () => overlay.classList.add('hidden');
}

// AI 权限开关逻辑
document.querySelectorAll('.ai-perm, #mcp-toggle').forEach(el => {
    el.onchange = async () => {
        const settings = {
            // [注意] 这里的字段名必须和 Rust 里的 McpSettings 结构体完全一致
            ai_enabled: document.getElementById('mcp-toggle')?.checked ?? true,
            allow_tab_freeze: document.getElementById('perm-freeze')?.checked ?? true,
            allow_network_fix: document.getElementById('perm-net')?.checked ?? false,
            auto_execute: document.getElementById('perm-auto')?.checked ?? false,
            auth_token: currentToken // 把当前 Token 带回去，防止覆盖
        };
        
        try {
            await invoke('update_mcp_settings', { settings });
            const logMsg = settings.ai_enabled ? "AI 核心策略已更新" : "AI 核心已暂停";
            addLog(logMsg);
        } catch (e) {
            console.error("更新设置失败:", e);
        }
    };
});

// 紧急修复按钮 (GPU 清理)
const fixBtn = document.getElementById('btn-emergency-fix');
if (fixBtn) {
    fixBtn.addEventListener('click', async () => {
        const feedbackBox = document.getElementById('fix-feedback');
        const msgEl = document.getElementById('fix-msg');
        const statusText = document.getElementById('gpu-status-text');

        fixBtn.disabled = true;
        fixBtn.style.opacity = '0.6';
        if(feedbackBox) feedbackBox.style.display = 'block';
        if(msgEl) {
            msgEl.innerHTML = "正在挂起渲染进程...<br>>_ 扫描 ShaderCache...";
            msgEl.style.color = '#ccc';
        }

        try {
            const response = await invoke('clean_gpu_cache');
            if(msgEl) msgEl.innerHTML += `<br>>_ <span style="color:#00f2ff">${response}</span>`;
            if(statusText) {
                statusText.innerText = "系统已净化";
                statusText.style.color = "#00f2ff";
            }
        } catch (error) {
            if(msgEl) msgEl.innerHTML += `<br>>_ <span style="color:#ff4d4f">失败: ${error}</span>`;
        } finally {
            setTimeout(() => {
                fixBtn.disabled = false;
                fixBtn.style.opacity = '1';
            }, 3000);
        }
    });
}

// 内存轮询 (可选)
setInterval(async () => {
    try {
        const memEl = document.getElementById('mem-display');
        if (memEl) {
            // 假设 Rust 端有一个 get_memory_usage 命令返回百分比或字符串
            // 如果没有，可以先忽略
            // const mem = await invoke('get_memory_usage');
            // memEl.innerText = mem;
        }
    } catch(e) {}
}, 5000);

// ==========================================
// 3. 辅助函数
// ==========================================

function addLog(msg) {
    const list = document.getElementById('log-list');
    if (list) {
        const li = document.createElement('li');
        li.innerText = `[AI] ${msg}`;
        list.prepend(li);
    }
}

// Token 复制
window.copyToken = function() { // 挂载到 window 供 HTML onclick 调用
    if (currentToken) {
        navigator.clipboard.writeText(currentToken).then(() => {
            alert("令牌已复制！");
        });
    }
};

// ==========================================
// 4. 初始化执行
// ==========================================

async function init() {
    // 1. 获取 Token (统一逻辑)
    try {
        currentToken = await invoke('get_session_token');
        const el = document.getElementById('token-display');
        if (el) {
            el.innerText = currentToken;
            // 存入 LocalStorage 方便调试
            localStorage.setItem('neuro_token', currentToken);
        }
    } catch (e) {
        console.error("无法获取令牌:", e);
        const el = document.getElementById('token-display');
        if (el) el.innerText = "连接服务失败";
    }

    // 2. 加载用户规则 (如果 Rust 端实现了 get_manual_rules)
    // loadSavedRules(); 

    addLog("NeuroFlow 内核已连接");
}

// 页面加载完毕后启动
window.addEventListener('DOMContentLoaded', init);