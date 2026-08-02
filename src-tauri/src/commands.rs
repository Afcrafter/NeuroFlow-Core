//! Tauri 前端可调用的命令

use std::process::Command;
use std::sync::Arc;

use sled::Db;
use sysinfo::System;
use tauri::Emitter;
use tauri::State;

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
