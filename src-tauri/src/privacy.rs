//! 隐私熔断：敏感页面拦截

/// 简单隐私守卫（关键词硬编码，后续可改为规则表）
#[derive(Debug, Clone)]
pub struct PrivacyGuard;

impl PrivacyGuard {
    /// 检查 URL 是否敏感
    pub fn is_sensitive(url: &str) -> bool {
        let sensitive_keywords = [
            "bank", "pay", "alipay", "wechat", "wallet", // 支付
            "gov.cn", "12306", // 政务 / 民生
            "password", "login", "auth", // 登录页
            "private", "secret",
        ];
        let lower_url = url.to_lowercase();
        sensitive_keywords
            .iter()
            .any(|kw| lower_url.contains(kw))
    }
}
