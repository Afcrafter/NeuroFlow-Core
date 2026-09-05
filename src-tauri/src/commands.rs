//! Tauri 前端可调用的命令

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use sled::Db;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{CloseToTray, ServiceEnabled};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::models::ManualRule;

/// 当前系统内存占用摘要
#[tauri::command]
pub fn get_memory_usage() -> String {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mem = sys.total_memory() / 1024 / 1024;
    let used_mem = sys.used_memory() / 1024 / 1024;
    format!("总内存: {total_mem} MB | 已用: {used_mem} MB")
}

/// 统一修复动作执行器
#[tauri::command]
pub async fn execute_fix_action(
    app: tauri::AppHandle,
    action_type: String,
) -> Result<String, String> {
    match action_type.as_str() {
        "RESET_DNS" => {
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("ipconfig")
                    .args(["/flushdns"])
                    .creation_flags(0x08000000)
                    .output();
                Ok("DNS 缓存已刷新".into())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok("不支持当前系统".into())
            }
        }
        "TRY_MIRROR" => {
            let _ = app.emit("trigger-redirect", ());
            Ok("已尝试切换镜像".into())
        }
        "FREEZE_TABS" => {
            let _ = app.emit("action-freeze-tabs", ());
            Ok("后台资源回收中".into())
        }
        _ => Err("未知动作".into()),
    }
}

/// 按 ID 列表冷冻指定标签页
#[tauri::command]
pub async fn execute_specific_freeze(
    app: tauri::AppHandle,
    ids: Vec<i32>,
) -> Result<String, String> {
    let _ = app.emit("action-freeze-specific-tabs", ids);
    Ok("选中项已冷冻".into())
}

/// 向插件请求后台标签页列表
#[tauri::command]
pub async fn get_background_tabs_list(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("request-tabs-from-plugin", ());
    Ok(())
}

/// 估算可释放内存（粗略比例）
#[tauri::command]
pub async fn get_estimated_savings() -> Result<String, String> {
    let mut sys = System::new();
    sys.refresh_memory();

    let used_mem = sys.used_memory();
    let estimated_bytes = used_mem / 5;
    let estimated_mb = estimated_bytes / 1024 / 1024;

    if estimated_mb > 1024 {
        Ok(format!("{:.1} GB", estimated_mb as f64 / 1024.0))
    } else {
        Ok(format!("{estimated_mb} MB"))
    }
}

/// 保存手动预加载规则
#[tauri::command]
pub async fn save_manual_rule(
    db: State<'_, Arc<Db>>,
    source: String,
    target: String,
    allow_cookie: bool,
) -> Result<String, String> {
    let key = format!("manual:{}", source.trim());
    let rule = ManualRule {
        target_sub: target.trim().to_string(),
        allow_cookie,
    };
    let value = serde_json::to_vec(&rule).map_err(|e| e.to_string())?;
    db.insert(key, value).map_err(|e| e.to_string())?;
    Ok("规则已生效".into())
}

/// 获取全部手动规则
#[tauri::command]
pub async fn get_manual_rules(
    db: State<'_, Arc<Db>>,
) -> Result<Vec<(String, ManualRule)>, String> {
    let mut rules = Vec::new();
    for item in db.scan_prefix("manual:") {
        if let Ok((key, value)) = item {
            let key_str = String::from_utf8_lossy(&key).to_string();
            let source = key_str.replace("manual:", "");
            if let Ok(rule) = serde_json::from_slice::<ManualRule>(&value) {
                rules.push((source, rule));
            }
        }
    }
    Ok(rules)
}

/// 清理 Edge GPU Shader 缓存（Windows）
#[tauri::command]
pub async fn clean_gpu_cache() -> Result<String, String> {
    let cache_path = dirs::cache_dir()
        .map(|p| p.join("Microsoft/Edge/User Data/ShaderCache"))
        .ok_or_else(|| "无法定位路径".to_string())?;

    if cache_path.exists() {
        match std::fs::remove_dir_all(&cache_path) {
            Ok(_) => Ok("GPU 缓存已清除，请刷新页面".into()),
            Err(e) => Err(format!("清理失败: {e}")),
        }
    } else {
        Ok("无需清理".into())
    }
}

// Token 相关命令见 `config` 模块：get_session_token / get_token_info / set_token_mode / rotate_token

// ---------------------------------------------------------------------------
// 服务启停（本地 Warp 服务闸门）
// ---------------------------------------------------------------------------

/// 启用 / 暂停本地服务；返回新状态并广播 `service-state` 事件
#[tauri::command]
pub fn set_service_enabled(app: AppHandle, enabled: bool, state: State<'_, ServiceEnabled>) -> bool {
    state.0.store(enabled, Ordering::Relaxed);
    let _ = app.emit("service-state", enabled);
    enabled
}

/// 查询本地服务当前是否启用
#[tauri::command]
pub fn get_service_state(state: State<'_, ServiceEnabled>) -> bool {
    state.0.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// 系统信息
// ---------------------------------------------------------------------------

/// 当前内存占用百分比（0–100）
#[tauri::command]
pub fn get_memory_percent() -> f64 {
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory().max(1);
    (sys.used_memory() as f64 / total as f64) * 100.0
}

/// 应用版本号（来自 tauri.conf.json）
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// 开机自启（Windows 注册表 Run 键）
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_NAME: &str = "NeuroFlowCore";

/// 设置开机自启（指向当前可执行文件）
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = format!("\"{}\"", exe.display());
        let mut cmd = Command::new("reg");
        if enabled {
            cmd.args([
                "add",
                RUN_KEY,
                "/v",
                AUTOSTART_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &exe_str,
                "/f",
            ]);
        } else {
            cmd.args(["delete", RUN_KEY, "/v", AUTOSTART_NAME, "/f"]);
        }
        let status = cmd.status().map_err(|e| format!("reg 执行失败: {e}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("注册表写入失败（exit: {:?}）", status.code()))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("当前系统不支持开机自启".into())
    }
}

/// 查询开机自启是否已开启
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let out = Command::new("reg")
            .args(["query", RUN_KEY, "/v", AUTOSTART_NAME])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(out.status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// 窗口控制（自定义标题栏用）
// ---------------------------------------------------------------------------

/// 最小化主窗口
#[tauri::command]
pub fn ui_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// 关闭主窗口：驻留托盘模式则隐藏（服务继续运行），否则彻底退出
#[tauri::command]
pub fn ui_close(
    window: WebviewWindow,
    app: AppHandle,
    close_to_tray: State<'_, CloseToTray>,
) -> Result<(), String> {
    if close_to_tray.0.load(Ordering::Relaxed) && window.label() == "main" {
        window.hide().map_err(|e| e.to_string())?;
        let _ = app.emit("to-tray", ());
        Ok(())
    } else {
        window.close().map_err(|e| e.to_string())
    }
}

/// 打开独立设置窗口（已存在则唤起并聚焦）
#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("NeuroFlow Core - 设置")
    .inner_size(720.0, 680.0)
    .resizable(false)
    .decorations(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 调整主窗口尺寸（展开 / 收起详情面板）
#[tauri::command]
pub fn ui_resize(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}
