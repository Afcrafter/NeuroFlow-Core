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

    // 如果上次保存的状态是 connected，直接渲染绿灯
    if (storage.connection_status === 'connected') {
        updateUI(true);
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
                    throw new Error("Token 无效");
                }
            } catch (err) {
                // === ❌ 连接失败 ===
                alert("连接失败: " + "无法连接到 NeuroFlow 后端，请检查 Token 或确认软件已启动。");
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