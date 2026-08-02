//! 错误诊断与环境感知

use std::time::Duration;

use sysinfo::Networks;
use tauri::Emitter;

use crate::models::{ErrorReport, FixSuggestion};
use crate::network::execute_silent_ping;
use crate::utils::extract_hostname;

/// 根据错误报告生成建议，并在后台做短时网络环境扫描
pub fn start_diagnosis(app: &tauri::AppHandle, report: ErrorReport) {
    let app_clone = app.clone();
    let report_clone = report.clone();

    // 1. 生成修复建议
    let suggestions: Vec<FixSuggestion> = if report_clone.error.contains("ERR_NAME_NOT_RESOLVED") {
        vec![FixSuggestion {
            id: "dns_fix".into(),
            title: "域名解析异常".into(),
            desc: "无法找到目标服务器。建议检查网址或刷新 DNS。".into(),
            button_text: "一键重置 DNS".into(),
            action_type: "RESET_DNS".into(),
            script_type: None,
            code: None,
        }]
    } else if report_clone.error.contains("ERR_CONNECTION_TIMED_OUT") {
        vec![FixSuggestion {
            id: "proxy_fix".into(),
            title: "连接超时".into(),
            desc: "主站响应缓慢，建议尝试镜像访问。".into(),
            button_text: "尝试镜像站点".into(),
            action_type: "TRY_MIRROR".into(),
            script_type: None,
            code: None,
        }]
    } else {
        vec![]
    };

    if !suggestions.is_empty() {
        let _ = app_clone.emit("ai-suggestions", suggestions);
    }

    // 2. 阻塞操作放进 spawn_blocking
    tokio::task::spawn_blocking(move || {
        let _ = app_clone.emit(
            "preload-log",
            format!(
                "🚨 发现异常: {} ({})",
                report_clone.url, report_clone.error
            ),
        );

        let mut networks = Networks::new();
        let _ = networks.refresh_list();

        let mut last_is_cellular = false;

        for _ in 0..2 {
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
                    let _ = app_clone.emit(
                        "preload-log",
                        "📡 环境感知：检测到移动网络，已切换至\"省流模式\"。",
                    );
                } else {
                    let _ = app_clone.emit("network-mode", "HIGH_SPEED");
                    let _ = app_clone.emit(
                        "preload-log",
                        "🌐 环境感知：已连接至无线网络，恢复极速预加载。",
                    );
                }
            }
        }

        // Ping 连通性
        let ping_baidu = execute_silent_ping("baidu.com");

        if ping_baidu.status.success() {
            let ping_target = execute_silent_ping(&report_clone.url);
            let domain_display =
                extract_hostname(&report_clone.url).unwrap_or_else(|| "目标服务器".to_string());

            if ping_target.status.success() {
                let _ = app_clone.emit(
                    "preload-log",
                    format!("🤔 服务器 {domain_display} 可达，可能是应用层错误。"),
                );
            } else {
                let _ = app_clone.emit(
                    "preload-log",
                    format!("❌ 目标服务器 {domain_display} 确实无法连接 (Ping 失败)。"),
                );
            }
        } else {
            let _ = app_clone.emit("preload-log", "❌ 严重：检测到本机已断网！");
        }
    });
}
