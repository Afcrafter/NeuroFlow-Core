//! 智能预加载：手动规则 + 行为学习预测 + 悬停意图

use std::sync::Arc;

use sled::Db;
use tauri::Emitter;

use crate::models::{ManualRule, NavigationPayload};
use crate::network::execute_preconnect;

/// 智能预测与数据库记录（整合手动规则与行为预测）
pub fn smart_preload_v2(db: Arc<Db>, app: &tauri::AppHandle, payload: NavigationPayload) {
    let app_clone = app.clone();
    let db_clone = db.clone();

    if payload.action_type == "load" {
        let _ = app.emit("browser-url", &payload.current_url);
    }

    tokio::spawn(async move {
        let current = &payload.current_url;

        // --- 0. 手动规则优先 ---
        let domain_parts: Vec<&str> = current
            .split('/')
            .nth(2)
            .unwrap_or("")
            .split('.')
            .collect();
        let domain = if domain_parts.len() >= 2 {
            format!(
                "{}.{}",
                domain_parts[domain_parts.len() - 2],
                domain_parts[domain_parts.len() - 1]
            )
        } else {
            current.to_string()
        };

        let rule_key = format!("manual:{domain}");

        if let Ok(Some(data)) = db_clone.get(&rule_key) {
            if let Ok(rule) = serde_json::from_slice::<ManualRule>(&data) {
                let target_full_url = format!("https://{}.{}", rule.target_sub, domain);

                let _ = app_clone.emit(
                    "preload-log",
                    format!("🛠️ 命中手动规则: {} -> {}", domain, rule.target_sub),
                );

                if rule.allow_cookie {
                    let _ = app_clone.emit("preload-log", "🛡️ 执行 L2 级预取 (携带凭证)");
                    let _ = app_clone.emit("trigger-extension-preload", target_full_url);
                } else {
                    let _ = app_clone.emit("preload-log", "🔒 执行 L1 级预连 (无 Cookie)");
                    execute_preconnect(&app_clone, &target_full_url).await;
                }

                return;
            }
        }

        // --- 1. 行为记录 ---
        if payload.action_type == "load" && payload.target_url.is_some() {
            let target = payload.target_url.as_ref().unwrap();
            let key = format!("nav:{current}:{target}");
            let _ = db_clone.update_and_fetch(key, |old| {
                let count = old
                    .and_then(|b| b.try_into().ok())
                    .map(u64::from_be_bytes)
                    .unwrap_or(0);
                Some((count + 1).to_be_bytes().to_vec())
            });
            return;
        }

        // --- 2. 行为预测 ---
        if payload.action_type == "load" {
            let prefix = format!("nav:{current}:");
            let mut best_target = String::new();
            let mut max_count = 0u64;

            for item in db_clone.scan_prefix(prefix) {
                if let Ok((key, value)) = item {
                    let count = value
                        .as_ref()
                        .try_into()
                        .ok()
                        .map(u64::from_be_bytes)
                        .unwrap_or(0);
                    if count > max_count {
                        max_count = count;
                        let key_str = String::from_utf8_lossy(&key);
                        best_target = key_str
                            .split("nav:")
                            .nth(1)
                            .unwrap_or("")
                            .replace(current, "")
                            .trim_start_matches(':')
                            .to_string();
                    }
                }
            }

            if max_count >= 3 && !best_target.is_empty() {
                let _ = app_clone.emit(
                    "preload-log",
                    format!("🧠 AI 预测下一站: {best_target}"),
                );
                execute_preconnect(&app_clone, &best_target).await;
            }
        }

        // --- 3. 悬停意图 ---
        if payload.action_type == "hover" {
            if let Some(target) = payload.target_url {
                let _ = app_clone.emit("preload-log", format!("🎯 捕获意图: {target}"));
                execute_preconnect(&app_clone, &target).await;
            }
        }
    });
}
