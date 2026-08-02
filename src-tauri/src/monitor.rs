//! 后台系统监控：网速、网络策略、内存告警

use std::time::Duration;

use sysinfo::{Networks, System};
use tauri::Emitter;

use crate::models::StrategyMode;
use crate::network::analyze_network_pulse;

/// 启动周期性系统监控任务
pub fn spawn_system_monitor(app: tauri::AppHandle) {
    tokio::spawn(async move {
        let mut networks = Networks::new();
        let _ = networks.refresh_list();
        let mut sys = System::new();
        let mut current_strategy = StrategyMode::Performance;
        let mut tick_count = 0u64;
        let mut last_rx = 0u64;
        let mut last_tx = 0u64;
        // 首帧只采样累计值，不计算速率，避免把「开机以来总流量」当成瞬时速度
        let mut speed_primed = false;
        const SPEED_INTERVAL_SECS: u64 = 2;

        loop {
            tokio::time::sleep(Duration::from_secs(SPEED_INTERVAL_SECS)).await;
            tick_count += 1;

            // 网卡列表不必每次全量刷新
            if tick_count % 15 == 1 {
                let _ = networks.refresh_list();
            }
            networks.refresh();
            sys.refresh_memory();

            // 网速：累计字节差 / 间隔秒数 → B/s
            let (mut rx, mut tx) = (0u64, 0u64);
            for (_, n) in &networks {
                rx += n.received();
                tx += n.transmitted();
            }

            if !speed_primed {
                last_rx = rx;
                last_tx = tx;
                speed_primed = true;
                let _ = app.emit("net-speed", (0u64, 0u64));
            } else {
                let delta_rx = rx.saturating_sub(last_rx);
                let delta_tx = tx.saturating_sub(last_tx);
                last_rx = rx;
                last_tx = tx;
                let speed_rx = delta_rx / SPEED_INTERVAL_SECS;
                let speed_tx = delta_tx / SPEED_INTERVAL_SECS;
                let _ = app.emit("net-speed", (speed_rx, speed_tx));
            }

            // 每 10 秒做一次网络脉冲与策略切换
            if tick_count % 5 == 0 {
                let mut is_hotspot = false;
                for (name, _) in &networks {
                    let n = name.to_lowercase();
                    if n.contains("cellular") || n.contains("mobile") || n.contains("wwan") {
                        is_hotspot = true;
                        break;
                    }
                }

                // 阻塞 DNS/TCP 探测放到 blocking 池
                let pulse = tokio::task::spawn_blocking(|| analyze_network_pulse("www.baidu.com"))
                    .await
                    .unwrap_or_else(|_| crate::models::NetworkPulse {
                        dns_time_ms: 0,
                        tcp_handshake_ms: 0,
                        quality_score: 0,
                        diagnosis: "探测失败".into(),
                    });

                let _ = app.emit("network-pulse", pulse.clone());

                let new_strategy = if is_hotspot {
                    StrategyMode::PowerSave
                } else if pulse.quality_score < 50 {
                    StrategyMode::Recovery
                } else {
                    StrategyMode::Performance
                };

                if new_strategy != current_strategy {
                    if new_strategy == StrategyMode::PowerSave {
                        let _ = app.emit("network-mode", "LOW_DATA");
                    } else {
                        let _ = app.emit("network-mode", "HIGH_SPEED");
                    }
                    current_strategy = new_strategy;
                }
            }

            let used_mem = sys.used_memory();
            let total_mem = sys.total_memory();
            if total_mem > 0 && used_mem as f64 / total_mem as f64 > 0.9 {
                let _ = app.emit("memory-warning", used_mem * 100 / total_mem);
            }
        }
    });
}
