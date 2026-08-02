//! 二进制入口：逻辑均在 `speed_browser_system_lib` 中

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    speed_browser_system_lib::run();
}
