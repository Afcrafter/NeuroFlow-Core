document.addEventListener('DOMContentLoaded', async () => {
    const btn = document.getElementById('action-btn');
    const input = document.getElementById('token-input');
    const statusText = document.getElementById('status-text');
    const statusLight = document.getElementById('status-light');

    // 当前生效令牌：连接成功后锁定，LIVE 轮询统一用这个值，避免读取输入框过期内容
    let activeToken = '';

    // 单次 fetch 超时（毫秒）：防止握手挂起导致 isWorking 卡死 → “按钮点不动”
    const TIMEOUT_MS = 5000;

    function apiFetch(token, body) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const p = fetch('http://127.0.0.1:3030/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-neuro-token': token
            },
            body: JSON.stringify(body)
        }).finally(() => clearTimeout(timer));
        return { p, abort: () => ctrl.abort() };
    }

    // --- 核心 UI 切换（单一出口：isConnected 决定状态灯/文本/按钮/LIVE/输入框） ---
    function updateUI(isConnected) {
        console.log('[NeuroFlow] updateUI', isConnected);
        if (isConnected) {
            statusLight.classList.add('active');
            statusText.innerText = "已连接";
            statusText.style.color = "#00ff00";
            btn.classList.add('connected');
            btn.innerText = "断开神经连接";
            input.disabled = true;
            startLive(activeToken);
        } else {
            statusLight.classList.remove('active');
            statusText.innerText = "未连接";
            statusText.style.color = "#aaa";
            btn.classList.remove('connected');
            btn.innerText = "建立神经连接";
            input.disabled = false;
            stopLive();
        }
    }

    // --- LIVE 实时刷新 ---
    let liveTimer = null;
    async function fetchLive(token) {
        if (!token) return;
        try {
            const { p } = apiFetch(token, { method: "get_system_status", id: 2, params: {} });
            const res = await p;
            let memPct = '—';
            if (res && res.ok) {
                const d = await res.json().catch(() => null);
                memPct = (d && d.result && d.result.memory_usage_percent) || '—';
            }
            let tabCount = '—';
            try {
                const tabs = await chrome.tabs.query({ active: false, pinned: false, audible: false, discarded: false });
                tabCount = String(tabs.length);
            } catch (_) {}
            const elMem = document.getElementById('live-mem');
            const elTabs = document.getElementById('live-tabs');
            if (elMem) elMem.textContent = memPct;
            if (elTabs) elTabs.textContent = tabCount;
        } catch (_) {}
    }
    function startLive(token) {
        const box = document.getElementById('live-box');
        if (box) box.classList.add('visible');
        fetchLive(token);
        if (liveTimer) clearInterval(liveTimer);
        liveTimer = setInterval(() => fetchLive(token), 5000);
    }
    function stopLive() {
        if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
        const box = document.getElementById('live-box');
        if (box) box.classList.remove('visible');
        const elMem = document.getElementById('live-mem');
        const elTabs = document.getElementById('live-tabs');
        if (elMem) elMem.textContent = '—';
        if (elTabs) elTabs.textContent = '—';
    }

    // 握手一次，返回是否成功。成功时把令牌锁定到 activeToken。
    async function handshake(token) {
        const { p, abort } = apiFetch(token, { method: "ping", id: 1, params: {} });
        try {
            const response = await p;
            if (response && response.ok) {
                activeToken = token;
                return { ok: true };
            }
            const status = response ? response.status : 0;
            if (status === 401) return { ok: false, reason: "令牌无效(401)：请重新打开 NeuroFlow 设置页→复制最新令牌" };
            if (status === 403) return { ok: false, reason: "来源被拒(403)：请从扩展弹窗内发起连接" };
            if (status === 503) return { ok: false, reason: "本地服务已暂停(503)：请在 NeuroFlow 面板点启动服务" };
            return { ok: false, reason: `后端错误(${status})` };
        } catch (err) {
            abort(); // 确保超时已清理
            return { ok: false, reason: null }; // 网络不通 / 超时
        }
    }

    // --- 初始化：读取本地状态并静默重握手验证 ---
    const storage = await chrome.storage.local.get(['neuro_token', 'connection_status']);

    if (storage.neuro_token) {
        input.value = storage.neuro_token;
        activeToken = storage.neuro_token;
    }

    if (storage.connection_status === 'connected' && activeToken) {
        const r = await handshake(activeToken);
        if (r.ok) {
            updateUI(true);
        } else {
            // 验证失败：不强行判定“已连接”，避免假绿；仅本地标记，保留输入以便重连
            await chrome.storage.local.set({ connection_status: 'disconnected' }).catch(() => {});
            updateUI(false);
        }
    } else {
        updateUI(false);
    }

    // --- 按钮点击（连接 / 断开） ---
    let isWorking = false;
    btn.addEventListener('click', async () => {
        if (isWorking) return;

        // 唯一真源是本地存储的连接状态；失败时主动复位，保证按钮永远可点
        const isConnected = (await chrome.storage.local.get('connection_status')).connection_status === 'connected';

        if (isConnected) {
            await chrome.storage.local.set({ connection_status: 'disconnected' });
            activeToken = '';
            updateUI(false);
            return;
        }

        // === 连接逻辑 ===
        const token = input.value.trim();
        if (!token) {
            input.style.border = "1px solid #f00";
            setTimeout(() => input.style.border = "1px solid #333", 500);
            return;
        }

        isWorking = true;
        const prevText = btn.innerText;
        btn.innerText = "正在握手...";
        console.log('[NeuroFlow] 开始握手', token.slice(0, 4) + '…');

        try {
            const result = await handshake(token);
            if (result.ok) {
                await chrome.storage.local.set({
                    neuro_token: activeToken,
                    connection_status: 'connected'
                });
                input.value = activeToken;
                updateUI(true);
            } else {
                const hint = result.reason;
                // hint 为 null → 网络不通 / 超时
                alert("连接失败：" + (hint
                    ? hint
                    : "无法连接到 NeuroFlow 后端(127.0.0.1:3030)，请确认 NeuroFlow 桌面端已启动且服务在运行。"));
                await chrome.storage.local.set({ connection_status: 'disconnected' }).catch(() => {});
                updateUI(false);
            }
        } finally {
            isWorking = false;
            // 未连上恢复按钮文案（连接失败或超时都走到这），避免“正在握手”卡死
            if (!btn.classList.contains('connected')) {
                btn.innerText = prevText;
            }
        }
    });
});
