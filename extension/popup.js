document.addEventListener('DOMContentLoaded', async () => {
    // 1. 获取页面元素
    const btn = document.getElementById('action-btn');
    const input = document.getElementById('token-input');
    const statusText = document.getElementById('status-text');
    const statusLight = document.getElementById('status-light');

    // 2. 初始化：从本地存储读取状态
    // 我们不仅读取 token，还读取 'connection_status' 来判断上次是否连接成功
    const storage = await chrome.storage.local.get(['neuro_token', 'connection_status']);
    
    if (storage.neuro_token) {
        input.value = storage.neuro_token;
    }

    // 如果上次保存的状态是 connected，先静默重新握手验证（令牌可能已被后端轮换）
    if (storage.connection_status === 'connected' && storage.neuro_token) {
        try {
            const check = await fetch('http://127.0.0.1:3030/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-neuro-token': storage.neuro_token
                },
                body: JSON.stringify({ method: "ping", id: 1, params: {} })
            });
            if (check.ok) {
                updateUI(true);
            } else {
                await chrome.storage.local.set({ connection_status: 'disconnected' });
                updateUI(false);
            }
        } catch (_) {
            // 后端未启动：不强行判定，维持展示未连接
            updateUI(false);
        }
    } else {
        updateUI(false);
    }

    // 3. 按钮点击事件
    btn.addEventListener('click', async () => {
        const isConnected = btn.classList.contains('connected');

        if (isConnected) {
            // === 【断开逻辑】 ===
            // 1. 清除连接状态
            await chrome.storage.local.set({ connection_status: 'disconnected' });
            // 2. 变回灰灯 UI
            updateUI(false);
            
        } else {
            // === 【连接逻辑】 ===
            const token = input.value.trim();
            if (!token) {
                // 简单的晃动动画提示
                input.style.border = "1px solid #f00";
                setTimeout(() => input.style.border = "1px solid #333", 500);
                return;
            }

            // 1. UI 变成“连接中...”
            const originalText = btn.innerText;
            btn.innerText = "正在握手...";
            btn.disabled = true;

            try {
                // 2. 发送 Ping 请求给 Rust 后端
                const response = await fetch('http://127.0.0.1:3030/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-neuro-token': token
                    },
                    body: JSON.stringify({ method: "ping", id: 1, params: {} })
                });

                if (response.ok) {
                    // === 🎉 连接成功！ ===
                    // 保存 Token 和 状态
                    await chrome.storage.local.set({ 
                        neuro_token: token,
                        connection_status: 'connected'
                    });
                    // 变绿灯 UI
                    updateUI(true);
                } else {
                    // 区分错误：401=令牌错，403=来源拒，503=服务暂停
                    if (response.status === 401) {
                        throw new Error("令牌无效(401)：请重新打开 NeuroFlow 设置页→复制最新令牌");
                    } else if (response.status === 403) {
                        throw new Error("来源被拒(403)：请从扩展弹窗内发起连接");
                    } else if (response.status === 503) {
                        throw new Error("本地服务已暂停(503)：请在 NeuroFlow 面板点启动服务");
                    } else {
                        throw new Error(`后端错误(${response.status})`);
                    }
                }
            } catch (err) {
                // === ❌ 连接失败 ===
                const hint = String(err && err.message ? err.message : err);
                const isNet = !/令牌|403|503|\d{3}/.test(hint);
                alert("连接失败：" + (isNet
                    ? "无法连接到 NeuroFlow 后端(127.0.0.1:3030)，请确认 NeuroFlow 桌面端已启动且服务在运行。"
                    : hint));
                updateUI(false); // 确保是断开状态
            } finally {
                btn.disabled = false;
                // 如果失败了，文字要还原；如果成功了，updateUI 会处理文字
                if (!document.getElementById('action-btn').classList.contains('connected')) {
                    btn.innerText = "建立神经连接";
                }
            }
        }
    });

    // --- 核心 UI 切换函数 ---
    function updateUI(isConnected) {
        if (isConnected) {
            // 🟢 变绿状态
            statusLight.classList.add('active');           // 绿灯亮起
            statusText.innerText = "已连接";               // 文字变更为“已连接”
            statusText.style.color = "#00ff00";            // 文字颜色变绿
            
            btn.classList.add('connected');                // 按钮变红（准备断开）
            btn.innerText = "断开神经连接";
            
            input.disabled = true;                         // 锁定输入框
        } else {
            // ⚫ 变灰状态
            statusLight.classList.remove('active');        // 绿灯熄灭
            statusText.innerText = "未连接";               // 文字变更为“未连接”
            statusText.style.color = "#aaa";               // 文字颜色变灰
            
            btn.classList.remove('connected');             // 按钮变蓝（准备连接）
            btn.innerText = "建立神经连接";
            
            input.disabled = false;                        // 解锁输入框
        }
    }
});