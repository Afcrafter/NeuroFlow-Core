//! 网络探测：Ping、DNS/TCP 脉冲、预连接

use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::{CommandExt, ExitStatusExt};
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use crate::models::NetworkPulse;
use crate::utils::extract_hostname;

/// 构造一个“失败”的 Output，避免 panic
fn failed_output(msg: &str) -> Output {
    Output {
        status: std::process::ExitStatus::from_raw(1),
        stdout: Vec::new(),
        stderr: msg.as_bytes().to_vec(),
    }
}

/// 静默 Ping 一次（失败时返回伪造失败 Output，避免 panic）
pub fn execute_silent_ping(target: &str) -> Output {
    let safe_target = extract_hostname(target).unwrap_or_else(|| "127.0.0.1".to_string());

    let mut cmd = Command::new("ping");

    #[cfg(target_os = "windows")]
    cmd.args(["-n", "1", &safe_target]);

    #[cfg(not(target_os = "windows"))]
    cmd.args(["-c", "1", &safe_target]);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.output()
        .unwrap_or_else(|e| failed_output(&format!("ping failed to start: {e}")))
}

/// 分层测量网络质量（DNS + TCP 握手）
pub fn analyze_network_pulse(domain: &str) -> NetworkPulse {
    let target = format!("{domain}:443");

    // 1. DNS
    let dns_start = Instant::now();
    let addrs = match target.to_socket_addrs() {
        Ok(mut a) => a.next(),
        Err(_) => {
            return NetworkPulse {
                dns_time_ms: 0,
                tcp_handshake_ms: 0,
                quality_score: 0,
                diagnosis: "DNS 解析彻底失败".into(),
            };
        }
    };
    let dns_time = dns_start.elapsed().as_millis();

    let Some(addr) = addrs else {
        return NetworkPulse {
            dns_time_ms: dns_time,
            tcp_handshake_ms: 0,
            quality_score: 10,
            diagnosis: "DNS 解析无结果".into(),
        };
    };

    // 2. TCP 握手
    let tcp_start = Instant::now();
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2));
    let tcp_time = tcp_start.elapsed().as_millis();

    // 3. 评分（先判更差条件）
    let (score, diagnosis) = match (dns_time, tcp_time) {
        (d, _) if d > 300 => (60, "DNS 服务器响应迟缓，建议重置"),
        (_, t) if t > 1000 => (20, "网络极差，可能会断线"),
        (_, t) if t > 400 => (50, "物理线路拥堵 (高延迟)，已暂停预加载"),
        (_, _) if stream.is_err() => (0, "目标服务器拒绝连接 (RST)"),
        _ => (98, "链路极佳，全速引擎已激活"),
    };

    NetworkPulse {
        dns_time_ms: dns_time,
        tcp_handshake_ms: tcp_time,
        quality_score: score,
        diagnosis: diagnosis.into(),
    }
}

/// TCP 预连接（降低首包延迟）
pub async fn execute_preconnect(_app: &tauri::AppHandle, url: &str) {
    let domain = url.split('/').nth(2).unwrap_or(url);
    let target = if domain.contains(':') {
        domain.to_string()
    } else {
        format!("{domain}:443")
    };

    if let Ok(mut addrs) = target.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            let _ = TcpStream::connect_timeout(&addr, Duration::from_secs(1));
        }
    }
}
