//! 本地 Warp HTTP 服务（插件 / MCP 通信）
//!
//! - **全路由鉴权**：要求 `x-neuro-token`
//! - **CORS 白名单**：仅扩展协议 + Tauri / localhost，禁止任意网页跨域

use std::convert::Infallible;
use std::sync::Arc;

use sled::Db;
use sysinfo::System;
use tauri::Emitter;
use tokio::sync::RwLock;
use warp::http::StatusCode;
use warp::reject::Reject;
use warp::{Filter, Rejection, Reply};

use crate::config::tokens_equal;
use crate::diagnosis::start_diagnosis;
use crate::models::{
    ErrorReport, ManualRule, McpRequest, McpResponse, McpSettings, NavigationPayload, PageSnapshot,
    TabState,
};
use crate::preload::smart_preload_v2;
use crate::privacy::PrivacyGuard;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Unauthorized;

impl Reject for Unauthorized {}

#[derive(Debug)]
struct CorsForbidden;

impl Reject for CorsForbidden {}

// ---------------------------------------------------------------------------
// CORS 白名单
// ---------------------------------------------------------------------------

/// 是否允许该 Origin 跨域访问本地 API
///
/// 允许：
/// - 浏览器扩展（`chrome-extension://` / `moz-extension://` 等）
/// - Tauri WebView
/// - 本机 loopback（`localhost` / `127.0.0.1`，可选端口）
///
/// 不允许：任意公网站点（content script 必须经 background 转发）
pub fn is_allowed_origin(origin: &str) -> bool {
    let o = origin.trim();
    if o.is_empty() {
        return false;
    }

    // 扩展源
    if o.starts_with("chrome-extension://")
        || o.starts_with("moz-extension://")
        || o.starts_with("safari-web-extension://")
        || o.starts_with("ms-browser-extension://")
    {
        return true;
    }

    // Tauri 2 WebView
    if matches!(
        o,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }

    // 仅 loopback HTTP(S)
    is_loopback_http_origin(o)
}

/// `http://localhost[:port]` / `http://127.0.0.1[:port]`（防 `localhost.evil.com` 前缀绕过）
fn is_loopback_http_origin(origin: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "http://localhost",
        "https://localhost",
        "http://127.0.0.1",
        "https://127.0.0.1",
        "http://[::1]",
        "https://[::1]",
    ];

    for prefix in PREFIXES {
        if origin == *prefix {
            return true;
        }
        if let Some(rest) = origin.strip_prefix(prefix) {
            // 只允许 ":12345" 形式的端口
            if let Some(port) = rest.strip_prefix(':') {
                if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                    return true;
                }
            }
        }
    }
    false
}

/// Origin 闸门：有 Origin 且不在白名单 → 403（只做校验，提取 unit）
///
/// 无 Origin 头（curl / 本机工具）放行，仍依赖 token 鉴权。
fn origin_guard() -> impl Filter<Extract = ((),), Error = Rejection> + Clone {
    warp::header::optional::<String>("origin")
        .and_then(|origin: Option<String>| async move {
            if let Some(ref o) = origin {
                if !is_allowed_origin(o) {
                    return Err(warp::reject::custom(CorsForbidden));
                }
            }
            Ok(())
        })
}

/// 收紧的 CORS 层：仅本机 / Tauri 源拿到 ACAO 头。
/// 浏览器扩展依赖 `host_permissions` 访问 localhost，通常不依赖 CORS；
/// 扩展 Origin 由 `origin_guard` 放行。
fn restricted_cors() -> warp::cors::Builder {
    warp::cors()
        .allow_origins([
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost",
            "https://localhost",
            "http://127.0.0.1",
            "https://127.0.0.1",
            // 常见前端 dev 端口
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ])
        .allow_headers(vec!["content-type", "x-neuro-token"])
        .allow_methods(vec!["POST", "GET", "OPTIONS", "HEAD"])
        .max_age(600)
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

/// 可 Clone 的鉴权过滤器：恒定时间比较 + 热读 `McpSettings`
fn with_auth(
    settings: Arc<RwLock<McpSettings>>,
) -> impl Filter<Extract = ((),), Error = Rejection> + Clone {
    warp::header::optional::<String>("x-neuro-token").and_then(move |maybe: Option<String>| {
        let settings = settings.clone();
        async move {
            let expected = settings.read().await.auth_token.clone();
            match maybe {
                Some(token) if !token.is_empty() && tokens_equal(token.trim(), expected.trim()) => {
                    Ok(())
                }
                _ => Err(warp::reject::custom(Unauthorized)),
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Rejection 处理
// ---------------------------------------------------------------------------

async fn handle_rejection(err: Rejection) -> Result<impl Reply, Infallible> {
    let (code, message) = if err.find::<Unauthorized>().is_some() {
        (StatusCode::UNAUTHORIZED, "invalid or missing x-neuro-token")
    } else if err.find::<CorsForbidden>().is_some() {
        (StatusCode::FORBIDDEN, "origin not allowed")
    } else if err.is_not_found() {
        (StatusCode::NOT_FOUND, "not found")
    } else if err.find::<warp::reject::MethodNotAllowed>().is_some() {
        (StatusCode::METHOD_NOT_ALLOWED, "method not allowed")
    } else if err.find::<warp::reject::PayloadTooLarge>().is_some() {
        (StatusCode::PAYLOAD_TOO_LARGE, "payload too large")
    } else if err
        .find::<warp::filters::body::BodyDeserializeError>()
        .is_some()
    {
        (StatusCode::BAD_REQUEST, "invalid json body")
    } else {
        eprintln!("unhandled rejection: {err:?}");
        (StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    };

    let body = serde_json::json!({
        "error": code.canonical_reason().unwrap_or("error"),
        "message": message,
    });

    Ok(warp::reply::with_status(warp::reply::json(&body), code))
}

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------

/// 在后台启动 `127.0.0.1:3030`（全路由鉴权 + 收紧 CORS）
pub fn spawn_warp_server(
    app: tauri::AppHandle,
    db: Arc<Db>,
    mcp_settings: Arc<RwLock<McpSettings>>,
) {
    tokio::spawn(async move {
        let warp_app_handle = app.clone();
        let mcp_handle = app.clone();
        let db_for_warp = db.clone();
        let mcp_settings_for_warp = mcp_settings.clone();

        let auth = with_auth(mcp_settings.clone());
        let guard = origin_guard();

        // --- 1. 预测 / 预加载 ---
        let predict_route = warp::post()
            .and(warp::path("predict"))
            .and(warp::path::end())
            .and(guard.clone())
            .and(auth.clone())
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                let db = db_for_warp.clone();
                move |_g: (), _auth: (), p: NavigationPayload| {
                    smart_preload_v2(db.clone(), &app, p);
                    "OK"
                }
            });

        // --- 2. 错误上报 ---
        let error_route = warp::post()
            .and(warp::path("report_error"))
            .and(warp::path::end())
            .and(guard.clone())
            .and(auth.clone())
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                move |_g: (), _auth: (), r: ErrorReport| {
                    start_diagnosis(&app, r);
                    "OK"
                }
            });

        // --- 3. 标签页列表 ---
        let tabs_route = warp::post()
            .and(warp::path("report_tabs"))
            .and(warp::path::end())
            .and(guard.clone())
            .and(auth.clone())
            .and(warp::body::json())
            .map({
                let app = warp_app_handle.clone();
                move |_g: (), _auth: (), tabs: Vec<serde_json::Value>| {
                    let _ = app.emit("receive-tabs-from-plugin", tabs);
                    "OK"
                }
            });

        // --- 4. MCP ---
        let mcp_route = warp::post()
            .and(warp::path("mcp"))
            .and(warp::path::end())
            .and(guard.clone())
            .and(auth.clone())
            .and(warp::body::json())
            .and_then(move |_g: (), _auth: (), req: McpRequest| {
                let a = mcp_handle.clone();
                let db = db_for_warp.clone();
                let s = mcp_settings_for_warp.clone();

                async move {
                    let settings = s.read().await;

                    if req.method == "save_snapshot" {
                        if let Ok(snap) =
                            serde_json::from_value::<PageSnapshot>(req.params.clone())
                        {
                            if PrivacyGuard::is_sensitive(&snap.url) {
                                let _ = a.emit(
                                    "preload-log",
                                    format!("🛡️ 拦截敏感页面: {}", snap.url),
                                );
                                let resp = McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({
                                        "status": "Ignored",
                                        "reason": "Privacy Block"
                                    }),
                                    id: req.id,
                                };
                                return Ok::<_, Rejection>(warp::reply::json(&resp));
                            }
                        }
                    }

                    let response = match req.method.as_str() {
                        "ping" => McpResponse {
                            jsonrpc: "2.0".into(),
                            result: serde_json::json!({"status": "pong"}),
                            id: req.id,
                        },
                        "get_system_status" => {
                            let mut sys = System::new();
                            sys.refresh_memory();
                            let total = sys.total_memory().max(1);
                            let mem_p = (sys.used_memory() as f64 / total as f64) * 100.0;
                            McpResponse {
                                jsonrpc: "2.0".into(),
                                result: serde_json::json!({
                                    "memory_usage_percent": format!("{mem_p:.1}%"),
                                    "status": "Healthy"
                                }),
                                id: req.id,
                            }
                        }
                        "save_snapshot" => {
                            if let Ok(snap) =
                                serde_json::from_value::<PageSnapshot>(req.params.clone())
                            {
                                let key = format!("snap:{}", snap.url);
                                if let Ok(data) = serde_json::to_vec(&snap) {
                                    let _ = db.insert(key.as_bytes(), data);
                                    let _ = a.emit(
                                        "preload-log",
                                        format!("💾 已加密存储: {}", snap.title),
                                    );
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({"status": "Saved"}),
                                        id: req.id,
                                    }
                                } else {
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({"error": "Serialize Error"}),
                                        id: req.id,
                                    }
                                }
                            } else {
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"error": "Invalid Data"}),
                                    id: req.id,
                                }
                            }
                        }
                        "freeze_tabs" => {
                            if !settings.allow_tab_freeze {
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"error": "Permission Denied"}),
                                    id: req.id,
                                }
                            } else {
                                let _ = a.emit("action-freeze-tabs", ());
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"status": "Executed"}),
                                    id: req.id,
                                }
                            }
                        }
                        "fix_dns" => {
                            if !settings.allow_network_fix {
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"error": "Permission Denied"}),
                                    id: req.id,
                                }
                            } else {
                                let _ = a.emit("trigger-fix-dns", ());
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"status": "Executed"}),
                                    id: req.id,
                                }
                            }
                        }
                        "update_tab_heartbeat" => {
                            match serde_json::from_value::<TabState>(req.params.clone()) {
                                Ok(tab_state) => {
                                    let title =
                                        tab_state.title.unwrap_or_else(|| "无标题".to_string());
                                    let _ = a.emit(
                                        "preload-log",
                                        format!(
                                            "💓 收到心跳 [分值: {}]: {}",
                                            tab_state.score, title
                                        ),
                                    );
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({
                                            "status": "ok",
                                            "score": tab_state.score
                                        }),
                                        id: req.id,
                                    }
                                }
                                Err(e) => {
                                    eprintln!("❌ 心跳数据解析失败: {e}");
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({
                                            "status": "error",
                                            "message": "Invalid Data format"
                                        }),
                                        id: req.id,
                                    }
                                }
                            }
                        }
                        "add_preload_rule" => {
                            let source = req
                                .params
                                .get("source")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let target = req
                                .params
                                .get("target")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !source.is_empty() && !target.is_empty() {
                                let key = format!("manual:{}", source.trim());
                                let rule = ManualRule {
                                    target_sub: target.trim().to_string(),
                                    allow_cookie: false,
                                };
                                if let Ok(value) = serde_json::to_vec(&rule) {
                                    let _ = db.insert(key.as_bytes(), value);
                                    let _ = a.emit("refresh-rules", ());
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({"status": "Added"}),
                                        id: req.id,
                                    }
                                } else {
                                    McpResponse {
                                        jsonrpc: "2.0".into(),
                                        result: serde_json::json!({"error": "DB Error"}),
                                        id: req.id,
                                    }
                                }
                            } else {
                                McpResponse {
                                    jsonrpc: "2.0".into(),
                                    result: serde_json::json!({"error": "Missing Params"}),
                                    id: req.id,
                                }
                            }
                        }
                        _ => McpResponse {
                            jsonrpc: "2.0".into(),
                            result: serde_json::json!({"status": "Unknown Method"}),
                            id: req.id,
                        },
                    };

                    Ok::<_, Rejection>(warp::reply::json(&response))
                }
            });

        let routes = predict_route
            .or(error_route)
            .or(tabs_route)
            .or(mcp_route)
            .recover(handle_rejection)
            .with(restricted_cors());

        println!("🚀 NeuroFlow Core on http://127.0.0.1:3030 (auth + restricted CORS)");
        warp::serve(routes).run(([127, 0, 0, 1], 3030)).await;
    });
}
