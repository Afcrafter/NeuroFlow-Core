# NeuroFlow / speed-browser-system

智能浏览器网络监控与优化系统：桌面端（Tauri + Rust）负责鉴权、监控、MCP 与预加载策略；浏览器扩展负责页面感知、心跳上报与资源调度。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| 桌面端 NeuroFlow Core | 网速 / 内存监测、网络脉搏、Token 鉴权、Warp 本地 API (`127.0.0.1:3030`) |
| 浏览器扩展 NeuroFlow Link | 导航预测、错误上报、标签语义心跳、与 Core 安全握手 |
| 全路由 Token 鉴权 | 请求头 `x-neuro-token` |
| 收紧 CORS | 仅扩展源 / Tauri / localhost，content 脚本经 background 转发 |

---

## 环境要求

- **Node.js** 18+（建议 LTS）
- **Rust** stable（[rustup](https://rustup.rs/)）
- **Tauri 2 系统依赖**（Windows 需 WebView2，一般已预装）
- 浏览器：Chrome / Edge / Chromium（扩展为 Manifest V3）

---

## 快速开始（桌面端）

在项目根目录：

```bash
# 安装前端 / CLI 依赖
npm install

# 开发模式：启动 Tauri + 后端（推荐）
npm run tauri dev
```

等价写法：

```bash
npm run dev
# 或
npx tauri dev
```

首次运行会编译 Rust 后端，耗时可能较长。成功后会打开 NeuroFlow 窗口，并在本机监听：

```text
http://127.0.0.1:3030
```

### 生产构建

```bash
npm run tauri build
# 或
npm run build
```

产物位于 `src-tauri/target/release/`（及安装包目录，视平台而定）。

---

## 浏览器扩展

### 安装包位置

根目录已提供可分发的压缩包：

```text
neuroflow-link-extension.zip
```

内含（与 `extension/` 一致）：

- `manifest.json`
- `background.js` / `content.js`
- `popup.html` / `popup.js`
- `error.html`

### 重新打包扩展

修改 `extension/` 后，可重新生成 zip：

```bash
npm run pack:extension
```

### 在 Chrome / Edge 中安装

**方式 A：加载已解压目录（开发推荐）**

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」
4. 选择本仓库的 **`extension`** 文件夹

**方式 B：使用安装包 zip**

1. 将根目录 **`neuroflow-link-extension.zip`** 解压到任意目录（例如 `neuroflow-link/`）
2. 同上，在扩展管理页「加载已解压的扩展程序」，指向**解压后的文件夹**  
   （Chrome 不能直接把 zip 当 CRX 商店安装包安装，需解压后以开发者模式加载。）

### 与桌面端配对

1. 先运行 `npm run tauri dev`（或已安装的 Core）
2. 在桌面端复制 **安全握手令牌**
3. 点击浏览器工具栏 NeuroFlow 图标，粘贴 Token 并连接  
4. 扩展会请求 `http://127.0.0.1:3030/*`（需 Core 在线）

---

## 项目结构

```text
speed-browser-system/
├── extension/                      # 浏览器扩展源码
├── neuroflow-link-extension.zip    # 扩展安装包（根目录）
├── src/                            # 桌面端前端 (HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css
│   └── main.js
├── src-tauri/                      # Tauri + Rust 后端
│   └── src/
│       ├── main.rs / lib.rs
│       ├── config.rs               # Token / 配置
│       ├── server.rs               # Warp HTTP + 鉴权 + CORS
│       ├── monitor.rs              # 网速 / 脉搏
│       └── ...
├── scripts/pack-extension.mjs      # 扩展打包脚本
├── package.json
└── README.md
```

---

## 常用 npm 脚本

| 命令 | 说明 |
|------|------|
| `npm run tauri dev` | **开发运行桌面端 + 后端**（主入口） |
| `npm run dev` | 同上（简写） |
| `npm run tauri build` / `npm run build` | 生产构建 |
| `npm run pack:extension` | 重新生成 `neuroflow-link-extension.zip` |

---

## 本地 API 摘要

Core 在 `127.0.0.1:3030` 提供（**均需** 请求头 `x-neuro-token`）：

| 路径 | 用途 |
|------|------|
| `POST /predict` | 导航 / 悬停预加载意图 |
| `POST /report_error` | 页面加载错误上报 |
| `POST /report_tabs` | 标签列表上报 |
| `POST /mcp` | MCP JSON-RPC（心跳、快照、冷冻等） |

CORS 仅允许扩展协议、Tauri WebView 与 localhost；网页 content script 经扩展 background 转发，避免被 403。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| 扩展连不上 | 确认 Core 已启动；Token 与桌面端一致；扩展已重载 |
| 鉴权 401 | 桌面端「轮换」后需重新粘贴 Token 到扩展 |
| 403 origin | 勿从网页脚本直接打 3030；应走扩展 background |
| `tauri dev` 编译失败 | 检查 Rust / WebView2；在 `src-tauri` 下执行 `cargo check` 看具体错误 |
| 网速一直为 0 | 等待约 2 秒采样间隔；首帧故意为 0 以避免累计流量虚高 |

---

## 许可证与说明

个人 / 学习项目模板演进版。图标与品牌名 NeuroFlow 可按需要自行替换。

```bash
# 完整开发流程速查
npm install
npm run tauri dev          # 终端 1：桌面端
# 浏览器加载 extension/ 或解压 neuroflow-link-extension.zip 后加载
# 复制 Token → 扩展 Popup 连接
```
