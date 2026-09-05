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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sled::Db;
use tokio::sync::RwLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use commands::{
    clean_gpu_cache, execute_fix_action, execute_specific_freeze, get_app_version,
    get_autostart, get_background_tabs_list, get_estimated_savings, get_manual_rules,
    get_memory_percent, get_memory_usage, get_service_state, open_settings_window, save_manual_rule,
    set_autostart, set_service_enabled, ui_close, ui_minimize, ui_resize,
};
use config::{
    close_to_tray_enabled, get_close_to_tray, get_session_token, get_token_info,
    load_app_config, resolve_session_token, rotate_token, set_close_to_tray_cmd, set_token_mode,
    token_fingerprint,
};
use models::McpSettings;
use monitor::spawn_system_monitor;
use server::spawn_warp_server;

/// 托管状态包装：本地服务启停开关（避免与其它 `Arc<AtomicBool>` 状态撞类型）
pub struct ServiceEnabled(pub Arc<AtomicBool>);

/// 托管状态包装：关闭窗口时是否驻留托盘
pub struct CloseToTray(pub Arc<AtomicBool>);

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

    // 服务启停开关（面板「启动 / 停止服务」）
    let service_enabled = Arc::new(AtomicBool::new(true));
    // 关闭窗口 → 驻留托盘（默认开）
    let close_to_tray = Arc::new(AtomicBool::new(close_to_tray_enabled()));

    // =======================================================
    // 3. 构建 Tauri App
    // =======================================================
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db.clone())
        .manage(mcp_settings.clone())
        .manage(ServiceEnabled(service_enabled.clone()))
        .manage(CloseToTray(close_to_tray.clone()))
        .invoke_handler(tauri::generate_handler![
            get_memory_usage,
            get_memory_percent,
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
            set_service_enabled,
            get_service_state,
            get_app_version,
            set_autostart,
            get_autostart,
            ui_minimize,
            ui_close,
            ui_resize,
            open_settings_window,
            get_close_to_tray,
            set_close_to_tray_cmd,
        ])
        .on_window_event(move |window, event| {
            // 点 ✕ / Alt+F4：驻留托盘模式 → 隐藏窗口，本地服务继续后台运行
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit("to-tray", ());
                }
            }
        })
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 构建失败");

    // =======================================================
    // 4. 后台任务：系统监控 + Warp 服务
    // =======================================================
    spawn_system_monitor(app.handle().clone());
    spawn_warp_server(
        app.handle().clone(),
        db.clone(),
        mcp_settings.clone(),
        service_enabled.clone(),
    );

    // =======================================================
    // 5. 主线程：运行 Tauri 界面
    // =======================================================
    app.run(|_, _| {});
}

// ---------------------------------------------------------------------------
// 系统托盘：显示主界面 / 完全退出；左键单击唤出
// ---------------------------------------------------------------------------

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "完全退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_i, &PredefinedMenuItem::separator(app)?, &quit_i],
    )?;

    let mut builder = TrayIconBuilder::with_id("neuroflow-tray")
        .tooltip("NeuroFlow Core — 浏览器加速服务运行中")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
