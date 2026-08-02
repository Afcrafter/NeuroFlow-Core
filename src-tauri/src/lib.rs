//! NeuroFlow / speed-browser-system 后端库入口
//!
//! 模块划分：
//! - `models`    — 共享数据结构
//! - `utils`     — 通用工具
//! - `config`    — 配置与 Token
//! - `privacy`   — 隐私熔断
//! - `network`   — 网络探测 / 预连接
//! - `diagnosis` — 错误诊断
//! - `preload`   — 智能预加载
//! - `commands`  — Tauri 命令
//! - `server`    — Warp HTTP / MCP（鉴权 + 收紧 CORS）
//! - `monitor`   — 后台系统监控

mod commands;
mod config;
mod diagnosis;
mod models;
mod monitor;
mod network;
mod preload;
mod privacy;
mod server;
mod utils;

use std::sync::Arc;

use sled::Db;
use tokio::sync::RwLock;

use commands::{
    clean_gpu_cache, execute_fix_action, execute_specific_freeze, get_background_tabs_list,
    get_estimated_savings, get_manual_rules, get_memory_usage, save_manual_rule,
};
use config::{
    get_session_token, get_token_info, load_app_config, resolve_session_token, rotate_token,
    set_token_mode, token_fingerprint,
};
use models::McpSettings;
use monitor::spawn_system_monitor;
use server::spawn_warp_server;

/// 应用主入口（由 `main.rs` 调用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");

    rt.block_on(async {
        run_async().await;
    });
}

async fn run_async() {
    // =======================================================
    // 1. 配置与 Token
    // =======================================================
    let config = load_app_config();
    let session_token = resolve_session_token(&config);
    println!(
        "🔑 Token 模式={:?} 指纹={}",
        config.token_mode,
        token_fingerprint(&session_token)
    );

    // =======================================================
    // 2. 数据库与运行时设置
    // =======================================================
    let db_path = if cfg!(debug_assertions) {
        "../user_behavior_data".to_string()
    } else {
        "user_behavior_db".to_string()
    };

    let db: Arc<Db> = match sled::open(&db_path) {
        Ok(database) => Arc::new(database),
        Err(e) => {
            eprintln!("数据库错误: {e}");
            return;
        }
    };

    let mcp_settings = Arc::new(RwLock::new(McpSettings {
        ai_enabled: true,
        allow_tab_freeze: true,
        allow_network_fix: true,
        auto_execute: false,
        auth_token: session_token,
    }));

    // =======================================================
    // 3. 构建 Tauri App
    // =======================================================
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            get_token_info,
            set_token_mode,
            rotate_token,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 构建失败");

    // =======================================================
    // 4. 后台任务：系统监控 + Warp 服务
    // =======================================================
    spawn_system_monitor(app.handle().clone());
    spawn_warp_server(app.handle().clone(), db.clone(), mcp_settings.clone());

    // =======================================================
    // 5. 主线程：运行 Tauri 界面
    // =======================================================
    app.run(|_, _| {});
}
