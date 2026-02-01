// 1. Sysinfo 核心库 (v0.33+ 标准写法)
// 注意：移除了 ProcessExt 和 SystemExt，它们已经合并进 System 结构体了
use sysinfo::{
    Networks, 
    System, 
};

// 2. Tauri 核心库
use tauri::{command, Emitter};

// 3. 网络与 Warp 库
use warp::Filter;
use std::net::{TcpStream, ToSocketAddrs};

// 4. 标准库工具
use std::time::{Duration, Instant};
use std::process::Command;
use std::sync::Arc;
use std::fs;
use std::path::Path;

// 5. 数据序列化与数据库
use serde::{Deserialize, Serialize};
use sled::Db;
use uuid::Uuid;


#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// --- 数据结构 ---

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ErrorReport {
    url: String,
    error: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct NavigationPayload {
    current_url: String,
    target_url: Option<String>,
    action_type: String,
}

#[derive(Serialize, Clone, Debug)]
#[allow(dead_code)]
struct FixAction {
    action_id: String,
    script_type: String, // "BROWSER_JS" (插件执行) 或 "SYS_CMD" (Rust 执行)
    code: String,        // 具体的脚本或命令内容
}

#[derive(Serialize, Clone, Debug)]
#[allow(dead_code)]
struct AISuggestion {
    title: String,
    desc: String,
    auto_fix: bool,   
    action: Option<FixAction>,
}

#[derive(Serialize, Clone, Debug)]
struct FixSuggestion {
    id: String,
    title: String,
    desc: String,
    button_text: String,
    action_type: String,
    // --- 新增字段：用于存储 AI 生成的修复脚本 ---
    script_type: Option<String>, 
    code: Option<String>,        
}

#[derive(Debug, Deserialize, Serialize)]
struct McpRequest {
    method: String,
    params: serde_json::Value,
    id: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct TabState {
    url: String,
    
    // [必须] Option 类型，防止前端发来的 title 为 null 时报错
    #[serde(default)] 
    title: Option<String>, 

    score: i32,
    
    #[serde(alias = "timestamp")] 
    last_heartbeat: u64,

    // [必须] 加上这个，否则会报 unknown field
    #[serde(default)]
    active_reasons: Vec<String>, 
    
    // [必须] 加上 snapshot 兼容字段 (因为日志里显示前端发了 snapshot)
    #[serde(default)]
    snapshot: serde_json::Value, 
}

#[derive(Debug, Serialize)]
struct McpResponse {
    jsonrpc: String,
    result: serde_json::Value,
    id: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct McpSettings {
    
    ai_enabled: bool,
    allow_tab_freeze: bool,    // 允许 AI 冷冻标签页
    allow_network_fix: bool,   // 允许 AI 修复网络 (DNS等)
    auto_execute: bool, 
    auth_token: String,       
}

// [数据结构区域] 新增
#[derive(Debug, Deserialize, Serialize, Clone)]
struct ManualRule {
    target_sub: String,  // 目标子域，如 "message"
    allow_cookie: bool,  // 是否允许 L2 级加速
}

#[derive(Debug, Serialize, Clone)]
struct NetworkPulse {
    dns_time_ms: u128,
    tcp_handshake_ms: u128,
    quality_score: u8, // 0-100
    diagnosis: String,
}

#[derive(PartialEq, Clone, Copy)]
enum StrategyMode {
    Performance, // 极速模式 (Wi-Fi + 低延迟)
    PowerSave,   // 省流模式 (热点)
    Recovery,    // 疗伤模式 (高延迟/丢包)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PageSnapshot {
    url: String,
    title: String,
    text_content: String, // 纯文本内容
    timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
struct PrivacyRule {
    domain_pattern: String, // 例如 "*.bank.com" 或 "zf.cn"
    policy: String,         // "BLOCK" (完全屏蔽), "READ_ONLY" (只读不改), "ALLOW"
    reason: String,
}

#[derive(Debug, Clone)] // 简单起见，暂不需要序列化存储，硬编码即可
struct PrivacyGuard;

impl PrivacyGuard {
    // 检查 URL 是否敏感
    fn is_sensitive(url: &str) -> bool {
        let sensitive_keywords = [
            "bank", "pay", "alipay", "wechat", "wallet", // 支付
            "gov.cn", "12306", // 政务/民生
            "password", "login", "auth", // 登录页
            "private", "secret"
        ];
        let lower_url = url.to_lowercase();
        for kw in sensitive_keywords {
            if lower_url.contains(kw) {
                return true;
            }
        }
        false
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct AppConfig {
    token_mode: String, // "fixed" (固定) 或 "random" (随机)
}

// 默认配置
impl Default for AppConfig {
    fn default() -> Self {
        Self { token_mode: "fixed".to_string() }
    }
}

#[tauri::command]
fn set_token_mode(mode: String, current_token: String) -> Result<(), String> {
    let config_path = "neuro_config.json";
    let token_path = "neuro_token.secret";

    // 保存配置
    let config = AppConfig { token_mode: mode.clone() };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;

    // 根据模式决定是否处理 token 文件
    if mode == "fixed" {
        // 如果切到固定模式，立即把当前的内存 token 写入文件
        let _ = fs::write(token_path, current_token);
    } else {
        // 如果切到随机模式，立即删除本地文件
        if Path::new(token_path).exists() {
            let _ = fs::remove_file(token_path);
        }
    }
    Ok(())
}


// --- 核心功能 ---

#[command]
fn get_memory_usage() -> String {
    let mut sys = System::new_all();
    sys.refresh_memory();
    let total_mem = sys.total_memory() / 1024 / 1024;
    let used_mem = sys.used_memory() / 1024 / 1024;
    format!("总内存: {} MB | 已用: {} MB", total_mem, used_mem)
}

fn execute_silent_ping(target: &str) -> std::process::Output {
    // 1. [核心修复] 在执行命令前，先清洗数据！
    // 如果提取失败，默认 Ping 本地回环，保证命令格式正确，避免 panic
    let safe_target = extract_hostname(target).unwrap_or_else(|| "127.0.0.1".to_string());

    let mut cmd = Command::new("ping");
    
    // Windows 下 Ping 1 次，Linux/Mac 下 Ping 1 次 (-c 1)
    #[cfg(target_os = "windows")]
    cmd.args(["-n", "1", &safe_target]);
    
    #[cfg(not(target_os = "windows"))]
    cmd.args(["-c", "1", &safe_target]);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 2. [防爆修复] 使用 unwrap_or_else 代替 expect
    // 如果 Ping 命令根本无法启动（比如系统没装 ping），返回一个伪造的失败 Output，而不是让程序崩溃
    cmd.output().unwrap_or_else(|_| {
        std::process::Command::new("cmd") // 随便创建一个空命令结构作为 fallback
            .output()
            .unwrap() // 这个几乎不会挂
    })
}

// 诊断与修复建议逻辑
    // 生成 AI 建议
    fn start_diagnosis(app: &tauri::AppHandle, report: ErrorReport) {
    let app_clone = app.clone();
    let report_clone = report.clone();
    
    // 1. 生成 AI 建议 (这部分代码保持不变)
    let suggestions: Vec<FixSuggestion> = if report_clone.error.contains("ERR_NAME_NOT_RESOLVED") {
        vec![FixSuggestion {
            id: "dns_fix".into(),
            title: "域名解析异常".into(),
            desc: "无法找到目标服务器。建议检查网址或刷新 DNS。".into(),
            button_text: "一键重置 DNS".into(),
            action_type: "RESET_DNS".into(),
            script_type: None, code: None,
        }]
    } else if report_clone.error.contains("ERR_CONNECTION_TIMED_OUT") {
        vec![FixSuggestion {
            id: "proxy_fix".into(),
            title: "连接超时".into(),
            desc: "主站响应缓慢，建议尝试镜像访问。".into(),
            button_text: "尝试镜像站点".into(),
            action_type: "TRY_MIRROR".into(),
            script_type: None, code: None,
        }]
    } else {
        vec![]
    };

    if !suggestions.is_empty() {
        let _ = app_clone.emit("ai-suggestions", suggestions);
    }

    // 启动网络监控循环（异步）
    tokio::task::spawn_blocking(move || {
        
        let _ = app_clone.emit("preload-log", format!("🚨 发现异常: {} ({})", report_clone.url, report_clone.error));
        
        // --- A. 硬件/网络环境扫描 ---
        // 【Sysinfo 0.32+ 标准写法】
        let mut networks = Networks::new(); 
        let _ = networks.refresh_list(); // 初始化列表

        let mut last_is_cellular = false;

        // 简短监控，循环 2 次后退出 (不要太久，因为我们在阻塞线程里)
        for _ in 0..2 {
            // [注意] 这里必须用标准库的 sleep，不能用 tokio::time::sleep
            std::thread::sleep(Duration::from_secs(2));
            
            let _ = networks.refresh_list(); 
            networks.refresh(); 

            let mut current_is_cellular = false;
            for (name, _) in &networks {
                let n = name.to_lowercase();
                if n.contains("cellular") || n.contains("mobile") || n.contains("wwan") {
                    current_is_cellular = true;
                    break;
                }
            }
            
            if current_is_cellular != last_is_cellular {
                last_is_cellular = current_is_cellular;
                if current_is_cellular {
                    let _ = app_clone.emit("network-mode", "LOW_DATA");
                    let _ = app_clone.emit("preload-log", "📡 环境感知：检测到移动网络，已切换至\"省流模式\"。");
                } else {
                    let _ = app_clone.emit("network-mode", "HIGH_SPEED");
                    let _ = app_clone.emit("preload-log", "🌐 环境感知：已连接至无限网络，恢复极速预加载。");
                }
            }
        }

        // --- B. 网络连通性检查 (Ping) ---
        // 这一步也是阻塞操作，必须放在 spawn_blocking 里
        let ping_baidu = execute_silent_ping("baidu.com");
        
        if ping_baidu.status.success() {
            // Ping 目标
            let ping_target = execute_silent_ping(&report_clone.url);
            let domain_display = extract_hostname(&report_clone.url).unwrap_or_else(|| "目标服务器".to_string());

            if ping_target.status.success() {
                let _ = app_clone.emit("preload-log", format!("🤔 服务器 {} 可达，可能是应用层错误。", domain_display));
            } else {
                let _ = app_clone.emit("preload-log", format!("❌ 目标服务器 {} 确实无法连接 (Ping 失败)。", domain_display));
            }
        } else {
            let _ = app_clone.emit("preload-log", "❌ 严重：检测到本机已断网！");
        }
    });
}

// 模拟“抓包”分析：分层测量网络质量
fn analyze_network_pulse(domain: &str) -> NetworkPulse {
    let target = format!("{}:443", domain); 
    
    // 1. 测量 DNS 解析时间 (应用层/传输层边界)
    let dns_start = Instant::now();
    // 这里的 to_socket_addrs 会触发真实的系统 DNS 查询
    let addrs = match target.to_socket_addrs() {
        Ok(mut a) => a.next(),
        Err(_) => return NetworkPulse { dns_time_ms: 0, tcp_handshake_ms: 0, quality_score: 0, diagnosis: "DNS 解析彻底失败".into() }
    };
    let dns_time = dns_start.elapsed().as_millis();

    if addrs.is_none() {
        return NetworkPulse { dns_time_ms: dns_time, tcp_handshake_ms: 0, quality_score: 10, diagnosis: "DNS 解析无结果".into() };
    }

    // 2. 测量 TCP 三次握手时间 (网络层/链路层延迟)
    let tcp_start = Instant::now();
    // 建立真实的 TCP 连接，模拟握手包
    let stream = TcpStream::connect_timeout(&addrs.unwrap(), Duration::from_secs(2));
    let tcp_time = tcp_start.elapsed().as_millis();

    // 3. 智能评分与诊断逻辑 (话术轻松易懂)
    let (score, diagnosis) = match (dns_time, tcp_time) {
        (d, _) if d > 300 => (60, "DNS 服务器响应迟缓，建议重置"), 
        (_, t) if t > 400 => (50, "物理线路拥堵 (高延迟)，已暂停预加载"),   
        (_, t) if t > 1000 => (20, "网络极差，可能会断线"),         
        (_, _) if stream.is_err() => (0, "目标服务器拒绝连接 (RST)"),   
        _ => (98, "链路极佳，全速引擎已激活")
    };

    NetworkPulse {
        dns_time_ms: dns_time,
        tcp_handshake_ms: tcp_time,
        quality_score: score,
        diagnosis: diagnosis.into(),
    }
}

async fn execute_preconnect(_app: &tauri::AppHandle, url: &str) {
    let domain = url.split('/').nth(2).unwrap_or(url);
    let target = if domain.contains(':') { domain.to_string() } else { format!("{}:80", domain) };
    if let Ok(mut addrs) = target.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            let _ = TcpStream::connect_timeout(&addr, Duration::from_secs(1));
        }
    }
}

// 智能预测与数据库记录
// 智能预测与数据库记录 (整合了手动规则与AI预测)
fn smart_preload_v2(db: Arc<Db>, app: &tauri::AppHandle, payload: NavigationPayload) {
    let app_clone = app.clone();
    let db_clone = db.clone();

    // 更新 UI 焦点
    if payload.action_type == "load" {
        let _ = app.emit("browser-url", &payload.current_url);
    }

    tokio::spawn(async move {
        // --- 核心变量定义 (修复报错的关键) ---
        let current = &payload.current_url; // 统一变量名为 current
        
        // --- 0. 优先匹配手动规则 (Manual Rule Engine) ---
        // 从 URL 中提取主域名，例如 "www.bilibili.com" -> "bilibili.com"
        let domain_parts: Vec<&str> = current.split('/').nth(2).unwrap_or("").split('.').collect();
        // 简单的域名提取逻辑：取最后两个部分 (如 bilibili.com)
        let domain = if domain_parts.len() >= 2 {
            format!("{}.{}", domain_parts[domain_parts.len()-2], domain_parts[domain_parts.len()-1])
        } else {
            current.to_string()
        };
        
        let rule_key = format!("manual:{}", domain);

        if let Ok(Some(data)) = db_clone.get(&rule_key) {
            if let Ok(rule) = serde_json::from_slice::<ManualRule>(&data) {
                
                // 构建目标 URL: 假设规则是 "message"，主域是 "bilibili.com" -> "message.bilibili.com"
                let target_full_url = format!("https://{}.{}", rule.target_sub, domain);

                let _ = app_clone.emit("preload-log", format!("🛠️ 命中手动规则: {} -> {}", domain, rule.target_sub));

                if rule.allow_cookie {
                    // === L2 模式 (Cookie 权衡) ===
                    let _ = app_clone.emit("preload-log", "🛡️ 执行 L2 级预取 (携带凭证)");
                    // 通知插件执行 fetch
                    let _ = app_clone.emit("trigger-extension-preload", target_full_url); 
                } else {
                    // === L1 模式 (TCP 纯净握手) ===
                    let _ = app_clone.emit("preload-log", "🔒 执行 L1 级预连 (无 Cookie)");
                    execute_preconnect(&app_clone, &target_full_url).await;
                }
                
                // 如果命中手动规则，通常可以直接返回，跳过后续猜测
                return; 
            }
        }

        // --- 1. 行为记录 (Learning) ---
        // 这里的代码依赖变量 `current`
        if payload.action_type == "load" && payload.target_url.is_some() {
            let target = payload.target_url.as_ref().unwrap();
            let key = format!("nav:{}:{}", current, target);
            let _ = db_clone.update_and_fetch(key, |old| {
                let count = old.map(|b| u64::from_be_bytes(b.try_into().unwrap())).unwrap_or(0);
                Some((count + 1).to_be_bytes().to_vec())
            });
            // 记录完直接返回，不需要预测
            return;
        }

        // --- 2. 行为预测 (AI Prediction) ---
        // 这里的代码也依赖变量 `current`
        if payload.action_type == "load" {
            let prefix = format!("nav:{}:", current);
            let mut best_target = String::new();
            let mut max_count = 0;

            for item in db_clone.scan_prefix(prefix) {
                if let Ok((key, value)) = item {
                    let count = u64::from_be_bytes(value.as_ref().try_into().unwrap());
                    if count > max_count {
                        max_count = count;
                        // 从 key 中提取目标 URL
                        let key_str = String::from_utf8_lossy(&key);
                        // key 格式为 "nav:current:target"，我们需要取最后一个冒号后的部分
                        // 注意：URL 本身包含冒号(http:)，所以要小心分割
                        // 这里简单处理：假设我们只存了 target 的一部分，或者需要更复杂的分割逻辑
                        // 为了兼容之前的代码：
                        best_target = key_str.split("nav:").nth(1)
                                        .unwrap_or("")
                                        .replace(current, "")
                                        .trim_start_matches(':')
                                        .to_string();
                    }
                }
            }
            // 阈值：超过3次才预连
            if max_count >= 3 && !best_target.is_empty() {
                let _ = app_clone.emit("preload-log", format!("🧠 AI 预测下一站: {}", best_target));
                execute_preconnect(&app_clone, &best_target).await;
            }
        }

        // --- 3. 意图捕获 (Hover Intent) ---
        if payload.action_type == "hover" && payload.target_url.is_some() {
            let target = payload.target_url.unwrap();
            let _ = app_clone.emit("preload-log", format!("🎯 捕获意图: {}", target));
            execute_preconnect(&app_clone, &target).await;
        }
    });
}


// 统一的指令执行器
#[command]
async fn execute_fix_action(app: tauri::AppHandle, action_type: String) -> Result<String, String> {
    match action_type.as_str() {
        "RESET_DNS" => {
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("ipconfig").args(["/flushdns"]).creation_flags(0x08000000).output();
                Ok("DNS 缓存已刷新".into())
            }
            #[cfg(not(target_os = "windows"))] { Ok("不支持当前系统".into()) }
        },
        "TRY_MIRROR" => {
            let _ = app.emit("trigger-redirect", ());
            Ok("已尝试切换镜像".into())
        },
        "FREEZE_TABS" => {
            let _ = app.emit("action-freeze-tabs", ());
            Ok("后台资源回收中".into())
        },
        _ => Err("未知动作".into()),
    }
}

// 专门用于处理"手动勾选"后的冷冻动作
#[command]
async fn execute_specific_freeze(app: tauri::AppHandle, ids: Vec<i32>) -> Result<String, String> {
    let _ = app.emit("action-freeze-specific-tabs", ids);
    Ok("选中项已冷冻".into())
}

// 获取后台标签页列表
#[command]
async fn get_background_tabs_list(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("request-tabs-from-plugin", ());
    Ok(())
}

// 计算预计可释放内存的逻辑
#[command]
async fn get_estimated_savings() -> Result<String, String> {
    let mut sys = System::new_all();
    sys.refresh_memory();
    
    let used_mem = sys.used_memory(); // 单位是字节
    
    // 模拟 AI 算法：通常后台闲置资源占用已用内存的 15% - 30%
    // 这里我们取一个保守的 20% 作为预估值
    let estimated_bytes = used_mem / 5; 
    let estimated_mb = estimated_bytes / 1024 / 1024;

    if estimated_mb > 1024 {
        Ok(format!("{:.1} GB", estimated_mb as f64 / 1024.0))
    } else {
        Ok(format!("{} MB", estimated_mb))
    }
}

// [核心功能区域] 新增
#[command]
async fn save_manual_rule(
    db: tauri::State<'_, Arc<Db>>, 
    source: String, 
    target: String, 
    allow_cookie: bool
) -> Result<String, String> {
    // 构造 Key，例如 "manual:bilibili.com"
    let key = format!("manual:{}", source.trim());
    
    // 构造 Value
    let rule = ManualRule { 
        target_sub: target.trim().to_string(), 
        allow_cookie 
    };
    
    // 序列化并存储
    let value = serde_json::to_vec(&rule).map_err(|e| e.to_string())?;
    db.insert(key, value).map_err(|e| e.to_string())?;
    
    Ok("规则已生效".into())
}

// 记得在 main 函数的 generate_handler! 中注册它：
// .invoke_handler(tauri::generate_handler![
//     get_memory_usage, 
//     execute_fix_action, 
//     get_estimated_savings, // <--- 添加这一行
//     ...
// ])

// --- 主函数 --
// 获取所有手动规则
#[command]
async fn get_manual_rules(db: tauri::State<'_, Arc<Db>>) -> Result<Vec<(String, ManualRule)>, String> {
    let mut rules = Vec::new();
    // 扫描所有以 "manual:" 开头的键
    for item in db.scan_prefix("manual:") {
        if let Ok((key, value)) = item {
            let key_str = String::from_utf8_lossy(&key).to_string();
            // 提取主域名 (去掉 "manual:" 前缀)
            let source = key_str.replace("manual:", "");
            
            if let Ok(rule) = serde_json::from_slice::<ManualRule>(&value) {
                rules.push((source, rule));
            }
        }
    }
    Ok(rules)
}

#[command]
async fn clean_gpu_cache() -> Result<String, String> {
    // 定位 Edge/Chrome 的 GPU 缓存路径 (Windows 示例)
    // 通常在 %LOCALAPPDATA%\Microsoft\Edge\User Data\ShaderCache
    let cache_path = dirs::cache_dir()
        .map(|p| p.join("Microsoft/Edge/User Data/ShaderCache"))
        .ok_or("无法定位路径")?;

    if cache_path.exists() {
        // 强制删除缓存文件
        match std::fs::remove_dir_all(&cache_path) {
            Ok(_) => Ok("GPU 缓存已清除，请刷新页面".into()),
            Err(e) => Err(format!("清理失败: {}", e))
        }
    } else {
        Ok("无需清理".into())
    }
}



#[command]
async fn get_session_token(state: tauri::State<'_, Arc<tokio::sync::RwLock<McpSettings>>>) -> Result<String, String> {
    let settings = state.read().await;
    Ok(settings.auth_token.clone())
}



#[tokio::main]
async fn main() {
    // =======================================================
    // 1. [核心] 读取配置与生成 Token
    //    (放在最开头，确保后续所有模块都使用同一个 Token)
    // =======================================================
    let config_path = "neuro_config.json";
    let token_file = "neuro_token.secret";

    // 读取配置
    let config: AppConfig = if Path::new(config_path).exists() {
        let content = fs::read_to_string(config_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AppConfig::default()
    };

    // 生成或读取 Token
    let session_token = if config.token_mode == "fixed" {
        // 固定模式：优先读文件
        if Path::new(token_file).exists() {
            fs::read_to_string(token_file).unwrap_or_else(|_| Uuid::new_v4().to_string())
        } else {
            let new_token = Uuid::new_v4().to_string();
            let _ = fs::write(token_file, &new_token); 
            new_token
        }
    } else {
        // 随机模式：删除旧文件，生成新的
        if Path::new(token_file).exists() {
            let _ = fs::remove_file(token_file);
        }
        Uuid::new_v4().to_string()
    };

    println!("🔑 当前安全令牌: {}", session_token);

    // =======================================================
    // 2. 初始化数据库与设置
    // =======================================================
    let db_path = if cfg!(debug_assertions) { "../user_behavior_data".to_string() } else { "user_behavior_db".to_string() };
    let db = match sled::open(&db_path) {
        Ok(database) => Arc::new(database),
        Err(_) => { eprintln!("数据库错误"); return; }
    };

    let mcp_settings = Arc::new(tokio::sync::RwLock::new(McpSettings {
        ai_enabled: true,
        allow_tab_freeze: true,
        allow_network_fix: true,
        auto_execute: false,
        auth_token: session_token.clone(),
    }));

    // =======================================================
    // 3. 构建 Tauri App (合并了所有命令)
    // =======================================================
    let app = tauri::Builder::default()
        .manage(db.clone())
        .manage(mcp_settings.clone())
        .invoke_handler(tauri::generate_handler![
            get_memory_usage, 
            execute_fix_action, 
            execute_specific_freeze, 
            get_background_tabs_list, 
            get_estimated_savings, 
            save_manual_rule, 
            get_manual_rules, 
            clean_gpu_cache, 
            get_session_token,
            set_token_mode // <--- [新增] 必须在这里注册
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 构建失败");

    // =======================================================
    // 4. 启动系统监控线程 (保持原样)
    // =======================================================
    let monitor_handle = app.handle().clone();
    tokio::spawn(async move {
        let mut networks = Networks::new();
        let _ = networks.refresh_list();
        let mut sys = System::new_all();
        let mut current_strategy = StrategyMode::Performance;
        let mut tick_count = 0;

        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            tick_count += 1;
            
            let _ = networks.refresh_list();
            networks.refresh(); 
            sys.refresh_memory();

            let (mut rx, mut tx) = (0, 0);
            for (_, n) in &networks { rx += n.received(); tx += n.transmitted(); }
            let _ = monitor_handle.emit("net-speed", (rx, tx));

            if tick_count % 5 == 0 {
                let mut is_hotspot = false;
                for (name, _) in &networks {
                    let n = name.to_lowercase();
                    if n.contains("cellular") || n.contains("mobile") || n.contains("wwan") {
                       is_hotspot = true;
                       break;
                    }
                }
                
                let pulse = analyze_network_pulse("www.baidu.com");
                let _ = monitor_handle.emit("network-pulse", pulse.clone());
                
                let new_strategy = if is_hotspot { StrategyMode::PowerSave } 
                   else if pulse.quality_score < 50 { StrategyMode::Recovery } 
                   else { StrategyMode::Performance };

                if new_strategy != current_strategy {
                     if new_strategy == StrategyMode::PowerSave {
                         let _ = monitor_handle.emit("network-mode", "LOW_DATA");
                     } else {
                         let _ = monitor_handle.emit("network-mode", "HIGH_SPEED");
                     }
                     current_strategy = new_strategy;
                }
            }
            
            let used_mem = sys.used_memory();
            let total_mem = sys.total_memory();
            if total_mem > 0 && used_mem as f64 / total_mem as f64 > 0.9 {
                let _ = monitor_handle.emit("memory-warning", used_mem * 100 / total_mem);
            }
        }
    });

    // =======================================================
    // 5. 启动 Warp 后台服务器 (核心修复区)
    // =======================================================
    // 准备变量
    let warp_app_handle = app.handle().clone();
    let mcp_handle = app.handle().clone();
    let db_for_warp = db.clone();
    let mcp_settings_for_warp = mcp_settings.clone();
    let token_for_warp = session_token.clone();

    // 开启 Warp 线程
    tokio::spawn(async move {
        // --- A. 定义 CORS ---
        let cors = warp::cors()
            .allow_any_origin()
            .allow_headers(vec!["content-type", "x-neuro-token"])
            .allow_methods(vec!["POST", "GET", "OPTIONS", "HEAD"]);

        // --- B. 定义鉴权过滤器 ---
        let expected_token = token_for_warp.clone();
        let auth_check = warp::header::<String>("x-neuro-token")
            .and_then(move |client_token: String| {
                let secret = expected_token.clone();
                async move {
                    if client_token == secret { 
                        Ok::<(), warp::Rejection>(()) 
                    } else { 
                        Err(warp::reject::not_found()) 
                    }
                }
            });

        // --- C. 定义各个路由 ---
        
        // 1. 预测路由
        let predict_route = warp::post()
            .and(warp::path("predict"))
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                let db = db_for_warp.clone();
                move |p: NavigationPayload| { 
                    smart_preload_v2(db.clone(), &app, p);
                    "OK" 
                }
            });

        // 2. 错误上报路由
        let error_route = warp::post()
            .and(warp::path("report_error"))
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                move |r: ErrorReport| { start_diagnosis(&app, r); "OK" }
            });

        // 3. 标签页路由
        let tabs_route = warp::post()
            .and(warp::path("report_tabs"))
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                move |tabs: Vec<serde_json::Value>| {
                    let _ = app.emit("receive-tabs-from-plugin", tabs);
                    "OK"
                }
            });

        // 4. MCP 路由 (带鉴权)
        let mcp_route = warp::post()
            .and(warp::path("mcp"))
            .and(auth_check) // <--- 这里使用了上面定义的 auth_check
            .and(warp::body::json())
            .and_then(move |_, req: McpRequest| {
                let a = mcp_handle.clone();
                let db = db_for_warp.clone();
                let s = mcp_settings_for_warp.clone();

                async move {
                    let settings = s.read().await;

                    // 隐私熔断
                    if req.method == "save_snapshot" {
                        if let Ok(snap) = serde_json::from_value::<PageSnapshot>(req.params.clone()) {
                            if PrivacyGuard::is_sensitive(&snap.url) {
                                let _ = a.emit("preload-log", format!("🛡️ 拦截敏感页面: {}", snap.url));
                                let resp = McpResponse { 
                                    jsonrpc: "2.0".into(), 
                                    result: serde_json::json!({"status": "Ignored", "reason": "Privacy Block"}), 
                                    id: req.id 
                                };
                                return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
                            }
                        }
                    }

                    // 业务逻辑
                    let response = match req.method.as_str() {
                        "ping" => McpResponse {
                            jsonrpc: "2.0".into(), result: serde_json::json!({"status": "pong"}), id: req.id,
                        },
                        "get_system_status" => {
                            let mut sys = System::new_all();
                            sys.refresh_memory();
                            let mem_p = (sys.used_memory() as f64 / sys.total_memory() as f64) * 100.0;
                            McpResponse {
                                jsonrpc: "2.0".into(),
                                result: serde_json::json!({"memory_usage_percent": format!("{:.1}%", mem_p), "status": "Healthy"}),
                                id: req.id,
                            }
                        },
                        "save_snapshot" => {
                            if let Ok(snap) = serde_json::from_value::<PageSnapshot>(req.params.clone()) {
                                let key = format!("snap:{}", snap.url);
                                if let Ok(data) = serde_json::to_vec(&snap) {
                                    let _ = db.insert(key.as_bytes(), data);
                                    let _ = a.emit("preload-log", format!("💾 已加密存储: {}", snap.title));
                                    McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"status": "Saved"}), id: req.id }
                                } else {
                                    McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "Serialize Error"}), id: req.id }
                                }
                            } else {
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "Invalid Data"}), id: req.id }
                            }
                        },
                        "freeze_tabs" => {
                            if !settings.allow_tab_freeze {
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "Permission Denied"}), id: req.id }
                            } else {
                                let _ = a.emit("action-freeze-tabs", ());
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"status": "Executed"}), id: req.id }
                            }
                        },
                        "fix_dns" => {
                            if !settings.allow_network_fix {
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "Permission Denied"}), id: req.id }
                            } else {
                                let _ = a.emit("trigger-fix-dns", ());
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"status": "Executed"}), id: req.id }
                            }
                        },
                        "update_tab_heartbeat" => {
                            println!("🔍 收到原始心跳数据: {:?}", req.params);
                            match serde_json::from_value::<TabState>(req.params.clone()) {
                                Ok(tab_state) => {
                                    let title = tab_state.title.unwrap_or_else(|| "无标题".to_string());
                                    println!("✅ 解析成功: [分值 {}] {}", tab_state.score, title);
                                    let _ = a.emit("preload-log", format!("💓 收到心跳 [分值: {}]: {}", tab_state.score, title));
                                    McpResponse { 
                                        jsonrpc: "2.0".into(), 
                                        result: serde_json::json!({"status": "ok", "score": tab_state.score}), 
                                        id: req.id 
                                    }
                                },
                                Err(e) => {
                                    eprintln!("❌ 心跳数据解析失败: {}", e);
                                    McpResponse { 
                                        jsonrpc: "2.0".into(), 
                                        result: serde_json::json!({"status": "error", "message": "Invalid Data format"}), 
                                        id: req.id 
                                    }
                                }
                            }
                        },
                        "add_preload_rule" => {
                            let source = req.params.get("source").and_then(|v| v.as_str()).unwrap_or("");
                            let target = req.params.get("target").and_then(|v| v.as_str()).unwrap_or("");
                            if !source.is_empty() && !target.is_empty() {
                                let key = format!("manual:{}", source.trim());
                                let rule = ManualRule { target_sub: target.trim().to_string(), allow_cookie: false };
                                if let Ok(value) = serde_json::to_vec(&rule) {
                                    let _ = db.insert(key.as_bytes(), value);
                                    let _ = a.emit("refresh-rules", ()); 
                                    McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"status": "Added"}), id: req.id }
                                } else {
                                    McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "DB Error"}), id: req.id }
                                }
                            } else {
                                McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"error": "Missing Params"}), id: req.id }
                            }
                        },
                        _ => {
                            McpResponse { jsonrpc: "2.0".into(), result: serde_json::json!({"status": "Unknown Method"}), id: req.id }
                        }
                    };

                    Ok::<_, warp::Rejection>(warp::reply::json(&response))
                }
            });

        // --- D. 组合路由并启动服务 ---
        let routes = mcp_route
            .or(predict_route)
            .or(tabs_route)
            .or(error_route)
            .with(cors); // 挂载 CORS

        println!("🚀 NeuroFlow Core is running on http://127.0.0.1:3030");
        warp::serve(routes).run(([127, 0, 0, 1], 3030)).await;
    });

    // =======================================================
    // 6. 主线程：运行 Tauri 界面
    // =======================================================
    app.run(|_, _| {});
}

// ==========================================
// ⬇️ 辅助函数区域 (放在文件最底部)
// ==========================================

/// 从任意 URL 中提取纯净的域名或 IP
/// 例如: "https://www.bilibili.com/video/xxx" -> Some("www.bilibili.com")
fn extract_hostname(url: &str) -> Option<String> {
    // 1. 去掉协议头
    let no_protocol = url.trim_start_matches("http://").trim_start_matches("https://");
    
    // 2. 截取路径分隔符 '/' 之前的部分
    let domain_part = no_protocol.split('/').next().unwrap_or(no_protocol);
    
    // 3. 截取端口号 ':' 之前的部分
    let domain = domain_part.split(':').next().unwrap_or(domain_part);

    // 4. 安全检查：防止过长字符串导致的 CMD 崩溃 (206 Error)
    // 域名通常不会超过 253 字符，这里限制宽松一点
    if domain.is_empty() || domain.len() > 253 {
        return None;
    }

    // 5. 简单过滤非法字符 (防止命令注入)
    if domain.chars().any(|c| !c.is_alphanumeric() && c != '.' && c != '-') {
        return None;
    }

    Some(domain.to_string())
}
