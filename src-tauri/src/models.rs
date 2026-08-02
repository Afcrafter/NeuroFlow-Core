//! 跨模块共享的数据结构

use serde::{Deserialize, Serialize};

/// 错误报告（插件上报）
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ErrorReport {
    pub url: String,
    pub error: String,
}

/// 导航 / 悬停意图载荷
#[derive(Debug, Deserialize, Serialize)]
pub struct NavigationPayload {
    pub current_url: String,
    pub target_url: Option<String>,
    pub action_type: String,
}

/// 修复动作（预留：插件 JS 或系统命令）
#[derive(Serialize, Clone, Debug)]
#[allow(dead_code)]
pub struct FixAction {
    pub action_id: String,
    /// `"BROWSER_JS"`（插件执行）或 `"SYS_CMD"`（Rust 执行）
    pub script_type: String,
    pub code: String,
}

/// AI 建议（预留）
#[derive(Serialize, Clone, Debug)]
#[allow(dead_code)]
pub struct AISuggestion {
    pub title: String,
    pub desc: String,
    pub auto_fix: bool,
    pub action: Option<FixAction>,
}

/// 发给前端的修复建议卡片
#[derive(Serialize, Clone, Debug)]
pub struct FixSuggestion {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub button_text: String,
    pub action_type: String,
    pub script_type: Option<String>,
    pub code: Option<String>,
}

/// MCP JSON-RPC 请求
#[derive(Debug, Deserialize, Serialize)]
pub struct McpRequest {
    pub method: String,
    pub params: serde_json::Value,
    pub id: i64,
}

/// 标签页状态 / 心跳
#[derive(Debug, Deserialize, Serialize)]
pub struct TabState {
    pub url: String,

    /// Option：防止前端 title 为 null 时报错
    #[serde(default)]
    pub title: Option<String>,

    pub score: i32,

    #[serde(alias = "timestamp")]
    pub last_heartbeat: u64,

    #[serde(default)]
    pub active_reasons: Vec<String>,

    #[serde(default)]
    pub snapshot: serde_json::Value,
}

/// MCP JSON-RPC 响应
#[derive(Debug, Serialize)]
pub struct McpResponse {
    pub jsonrpc: String,
    pub result: serde_json::Value,
    pub id: i64,
}

/// MCP / 全局运行时设置（可热读）
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct McpSettings {
    pub ai_enabled: bool,
    /// 允许 AI 冷冻标签页
    pub allow_tab_freeze: bool,
    /// 允许 AI 修复网络（DNS 等）
    pub allow_network_fix: bool,
    pub auto_execute: bool,
    pub auth_token: String,
}

/// 手动预加载规则
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ManualRule {
    /// 目标子域，如 `"message"`
    pub target_sub: String,
    /// 是否允许 L2 级加速（带 Cookie）
    pub allow_cookie: bool,
}

/// 网络质量脉冲
#[derive(Debug, Serialize, Clone)]
pub struct NetworkPulse {
    pub dns_time_ms: u128,
    pub tcp_handshake_ms: u128,
    /// 0–100
    pub quality_score: u8,
    pub diagnosis: String,
}

/// 网络策略模式
#[derive(PartialEq, Clone, Copy, Debug)]
pub enum StrategyMode {
    /// 极速模式（Wi-Fi + 低延迟）
    Performance,
    /// 省流模式（热点）
    PowerSave,
    /// 疗伤模式（高延迟 / 丢包）
    Recovery,
}

/// 页面快照
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageSnapshot {
    pub url: String,
    pub title: String,
    pub text_content: String,
    pub timestamp: u64,
}

/// 隐私规则（预留，当前硬编码关键词）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct PrivacyRule {
    /// 例如 `"*.bank.com"` 或 `"zf.cn"`
    pub domain_pattern: String,
    /// `"BLOCK"` | `"READ_ONLY"` | `"ALLOW"`
    pub policy: String,
    pub reason: String,
}

/// Token 模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TokenMode {
    /// 固定：落盘，重启保持不变
    #[default]
    Fixed,
    /// 随机：每次启动 / 切换时轮换，不落盘
    Random,
}

impl TokenMode {
    /// 解析前端 / 配置字符串（大小写不敏感）
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "fixed" => Ok(Self::Fixed),
            "random" => Ok(Self::Random),
            other => Err(format!("无效的 token 模式: {other}（仅支持 fixed / random）")),
        }
    }
}

/// 应用配置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub token_mode: TokenMode,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            token_mode: TokenMode::Fixed,
        }
    }
}

/// 前端展示用的 Token 会话信息
#[derive(Debug, Serialize, Clone)]
pub struct TokenInfo {
    pub token: String,
    pub mode: TokenMode,
    /// 是否已写入 `neuro_token.secret`
    pub persisted: bool,
}
