//! 通用工具函数

/// 从任意 URL 中提取纯净的域名或 IP
///
/// 例如: `"https://www.bilibili.com/video/xxx"` -> `Some("www.bilibili.com")`
pub fn extract_hostname(url: &str) -> Option<String> {
    // 1. 去掉协议头
    let no_protocol = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");

    // 2. 截取路径分隔符 '/' 之前的部分
    let domain_part = no_protocol.split('/').next().unwrap_or(no_protocol);

    // 3. 截取端口号 ':' 之前的部分
    let domain = domain_part.split(':').next().unwrap_or(domain_part);

    // 4. 安全检查：防止过长字符串（域名通常不超过 253 字符）
    if domain.is_empty() || domain.len() > 253 {
        return None;
    }

    // 5. 简单过滤非法字符（防止命令注入）
    if domain
        .chars()
        .any(|c| !c.is_alphanumeric() && c != '.' && c != '-')
    {
        return None;
    }

    Some(domain.to_string())
}
