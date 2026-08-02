//! 配置与会话 Token 管理
//!
//! - 固定模式：token 落盘，重启复用
//! - 随机模式：仅内存，启动 / 切换时轮换
//! - 所有变更同步到 `McpSettings.auth_token`，Warp 鉴权即时生效

use std::fs;
use std::path::Path;
use std::sync::Arc;

use tauri::State;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::models::{AppConfig, McpSettings, TokenInfo, TokenMode};

pub const CONFIG_PATH: &str = "neuro_config.json";
pub const TOKEN_PATH: &str = "neuro_token.secret";

// ---------------------------------------------------------------------------
// 纯文件 / 工具
// ---------------------------------------------------------------------------

/// 读取应用配置；文件不存在或解析失败时返回默认值
pub fn load_app_config() -> AppConfig {
    if !Path::new(CONFIG_PATH).exists() {
        return AppConfig::default();
    }
    let content = fs::read_to_string(CONFIG_PATH).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_app_config(config: &AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(CONFIG_PATH, json).map_err(|e| format!("写入配置失败: {e}"))
}

/// 生成新会话 token（UUID v4）
pub fn generate_token() -> String {
    Uuid::new_v4().to_string()
}

fn read_persisted_token() -> Option<String> {
    if !Path::new(TOKEN_PATH).exists() {
        return None;
    }
    fs::read_to_string(TOKEN_PATH)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_persisted_token(token: &str) -> Result<(), String> {
    fs::write(TOKEN_PATH, token.trim()).map_err(|e| format!("写入 token 文件失败: {e}"))
}

fn clear_persisted_token() {
    if Path::new(TOKEN_PATH).exists() {
        let _ = fs::remove_file(TOKEN_PATH);
    }
}

/// 按配置模式解析启动时会话 Token
pub fn resolve_session_token(config: &AppConfig) -> String {
    match config.token_mode {
        TokenMode::Fixed => {
            if let Some(existing) = read_persisted_token() {
                existing
            } else {
                let new_token = generate_token();
                let _ = write_persisted_token(&new_token);
                new_token
            }
        }
        TokenMode::Random => {
            clear_persisted_token();
            generate_token()
        }
    }
}

/// 调试用摘要（不完整打印 token）
pub fn token_fingerprint(token: &str) -> String {
    let t = token.trim();
    if t.len() <= 8 {
        return "****".into();
    }
    format!("{}…{}", &t[..4], &t[t.len() - 4..])
}

/// 恒定时间比较，降低计时旁路风险
pub fn tokens_equal(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        // 仍做一轮虚假异或，避免纯长度早退的极端情况被探测
        let mut acc = a.len() as u8 ^ b.len() as u8;
        for &x in a.iter().chain(b.iter()).take(32) {
            acc |= x;
        }
        let _ = acc;
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// 内存同步
// ---------------------------------------------------------------------------

async fn set_memory_token(state: &Arc<RwLock<McpSettings>>, token: String) {
    let mut settings = state.write().await;
    settings.auth_token = token;
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 获取当前会话 Token 明文（仅桌面端本地 UI 使用）
#[tauri::command]
pub async fn get_session_token(
    state: State<'_, Arc<RwLock<McpSettings>>>,
) -> Result<String, String> {
    Ok(state.read().await.auth_token.clone())
}

/// 获取 Token + 模式 + 是否落盘（初始化 UI 用）
#[tauri::command]
pub async fn get_token_info(
    state: State<'_, Arc<RwLock<McpSettings>>>,
) -> Result<TokenInfo, String> {
    let token = state.read().await.auth_token.clone();
    let mode = load_app_config().token_mode;
    let persisted = matches!(mode, TokenMode::Fixed) && read_persisted_token().is_some();
    Ok(TokenInfo {
        token,
        mode,
        persisted,
    })
}

/// 切换 Token 模式并同步文件 + 内存
///
/// - `fixed`：使用 `current_token`（空则保留当前内存值）并落盘
/// - `random`：立即轮换新 token，删除落盘文件
///
/// 返回当前生效的 token
#[tauri::command]
pub async fn set_token_mode(
    mode: String,
    current_token: String,
    state: State<'_, Arc<RwLock<McpSettings>>>,
) -> Result<String, String> {
    let mode = TokenMode::parse(&mode)?;
    let config = AppConfig { token_mode: mode };
    save_app_config(&config)?;

    let active_token = match mode {
        TokenMode::Fixed => {
            let token = {
                let trimmed = current_token.trim().to_string();
                if trimmed.is_empty() {
                    state.read().await.auth_token.clone()
                } else {
                    trimmed
                }
            };
            if token.is_empty() {
                return Err("固定模式下 token 不能为空".into());
            }
            write_persisted_token(&token)?;
            token
        }
        TokenMode::Random => {
            clear_persisted_token();
            generate_token()
        }
    };

    set_memory_token(&state, active_token.clone()).await;
    Ok(active_token)
}

/// 强制轮换当前 token（固定模式会重写落盘文件）
#[tauri::command]
pub async fn rotate_token(
    state: State<'_, Arc<RwLock<McpSettings>>>,
) -> Result<String, String> {
    let mode = load_app_config().token_mode;
    let new_token = generate_token();

    match mode {
        TokenMode::Fixed => write_persisted_token(&new_token)?,
        TokenMode::Random => clear_persisted_token(),
    }

    set_memory_token(&state, new_token.clone()).await;
    Ok(new_token)
}
