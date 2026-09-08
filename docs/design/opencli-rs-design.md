# OpenCLI-RS 设计文档

> 用 Rust 完整复刻 OpenCLI（TypeScript）的所有功能，除 Chrome 扩展外全部用 Rust 实现。

> Browser session/lease lifecycle and debugger-recovery parity are documented separately in [`opencli-browser-lifecycle-parity.md`](./opencli-browser-lifecycle-parity.md). For this fork, current OpenCLI behavior is the reference; do not invent lifecycle behavior that OpenCLI does not implement.

---

## 1. 项目概述

**opencli-rs** 是 OpenCLI 的 Rust 重写版，保持功能完全对等：

- 将任意网站暴露为 CLI 命令（57+ 站点适配器）
- 通过 Chrome 扩展复用浏览器会话（扩展本身保留原版，Rust 实现 Daemon + 桥接）
- 外部 CLI 集成透传
- 声明式 YAML Pipeline + 编程式适配器
- AI 原生发现能力（explore、synthesize、cascade、generate）
- 多格式输出（table、JSON、YAML、CSV、Markdown）

---

## 2. Workspace 结构

```
opencli-rs/
├── Cargo.toml                        # Workspace 定义
├── crates/
│   ├── opencli-rs-core/              # 核心数据模型
│   ├── opencli-rs-pipeline/          # Pipeline 引擎
│   ├── opencli-rs-browser/           # 浏览器桥接
│   ├── opencli-rs-output/            # 输出格式化
│   ├── opencli-rs-discovery/         # 适配器发现与加载
│   ├── opencli-rs-external/          # 外部 CLI 管理
│   ├── opencli-rs-ai/               # AI 能力（explore/synthesize/cascade/generate）
│   └── opencli-rs-cli/              # CLI 入口二进制
├── adapters/                         # 适配器定义（YAML + 内嵌 JS）
│   ├── hackernews/
│   │   └── top.yaml
│   ├── bilibili/
│   │   ├── hot.yaml
│   │   ├── me.yaml
│   │   └── ...
│   ├── twitter/
│   │   └── ...
│   └── ...                           # 57+ 站点
├── resources/
│   └── external-clis.yaml            # 内置外部 CLI 注册表
└── docs/
    └── design/
        └── opencli-rs-design.md      # 本文档
```

---

## 3. Crate 职责与依赖关系

### 3.1 依赖图

```
opencli-rs-cli (bin)
  ├── opencli-rs-core
  ├── opencli-rs-pipeline
  ├── opencli-rs-browser
  ├── opencli-rs-output
  ├── opencli-rs-discovery
  ├── opencli-rs-external
  └── opencli-rs-ai

opencli-rs-pipeline  → opencli-rs-core, opencli-rs-browser
opencli-rs-browser   → opencli-rs-core
opencli-rs-output    → opencli-rs-core
opencli-rs-discovery → opencli-rs-core, opencli-rs-pipeline
opencli-rs-external  → opencli-rs-core
opencli-rs-ai        → opencli-rs-core, opencli-rs-browser, opencli-rs-pipeline
```

### 3.2 各 Crate 详细职责

#### `opencli-rs-core`

核心数据模型，零外部运行时依赖（仅 serde）。

```rust
// ---- Strategy 枚举 ----
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Strategy {
    Public,     // 公开 API，无需认证
    Cookie,     // 需要浏览器 Cookie
    Header,     // 需要特定请求头
    Intercept,  // 需要拦截网络请求
    Ui,         // 需要 UI 交互
}

// ---- 参数定义 ----
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgDef {
    pub name: String,
    pub arg_type: ArgType,          // Str, Int, Number, Bool
    pub required: bool,
    pub positional: bool,
    pub description: Option<String>,
    pub choices: Option<Vec<String>>,
    pub default: Option<Value>,
}

// ---- CLI 命令定义 ----
#[derive(Debug, Clone)]
pub struct CliCommand {
    pub site: String,
    pub name: String,
    pub description: String,
    pub domain: Option<String>,
    pub strategy: Strategy,
    pub browser: bool,
    pub args: Vec<ArgDef>,
    pub columns: Vec<String>,
    pub pipeline: Option<Vec<PipelineStep>>,  // YAML 管道
    pub func: Option<AdapterFunc>,            // 编程式适配器
    pub timeout_seconds: Option<u64>,
    pub navigate_before: NavigateBefore,
}

// ---- 全局注册表 ----
pub struct Registry {
    commands: HashMap<String, HashMap<String, CliCommand>>,  // site -> name -> cmd
}

impl Registry {
    pub fn register(&mut self, cmd: CliCommand);
    pub fn get(&self, site: &str, name: &str) -> Option<&CliCommand>;
    pub fn list_sites(&self) -> Vec<&str>;
    pub fn list_commands(&self, site: &str) -> Vec<&CliCommand>;
    pub fn all_commands(&self) -> Vec<&CliCommand>;
}

// ---- 错误体系 ----
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("Browser connection failed: {message}")]
    BrowserConnect { message: String, suggestions: Vec<String> },

    #[error("Adapter load failed: {message}")]
    AdapterLoad { message: String, suggestions: Vec<String> },

    #[error("Command execution failed: {message}")]
    CommandExecution { message: String, suggestions: Vec<String> },

    #[error("Configuration error: {message}")]
    Config { message: String, suggestions: Vec<String> },

    #[error("Authentication required: {message}")]
    AuthRequired { message: String, suggestions: Vec<String> },

    #[error("Timeout: {message}")]
    Timeout { message: String, suggestions: Vec<String> },

    #[error("Invalid argument: {message}")]
    Argument { message: String, suggestions: Vec<String> },

    #[error("Empty result: {message}")]
    EmptyResult { message: String, suggestions: Vec<String> },

    #[error("Selector not found: {message}")]
    Selector { message: String, suggestions: Vec<String> },
}

impl CliError {
    pub fn code(&self) -> &'static str;         // 机器可读错误码
    pub fn icon(&self) -> &'static str;         // 终端 emoji
    pub fn suggestions(&self) -> &[String];     // 诊断建议列表
}
```

**对应原版模块：** `registry.ts`, `errors.ts`, 以及 `types.ts` 中的核心类型定义。

---

#### `opencli-rs-pipeline`

声明式 YAML 管道执行引擎。

**子模块：**

```
pipeline/
├── mod.rs           # 公开 API
├── executor.rs      # 管道执行器（步骤编排 + 重试）
├── template.rs      # ${{ expr }} 表达式引擎（pest parser）
├── context.rs       # 执行上下文（data, args, item, index）
├── registry.rs      # 步骤处理器注册表
└── steps/
    ├── mod.rs
    ├── browser.rs   # navigate, click, type, wait, press, snapshot, evaluate
    ├── fetch.rs     # HTTP 请求（单次 + per-item 并发）
    ├── transform.rs # select, map, filter, sort, limit
    ├── intercept.rs # 网络请求拦截
    ├── download.rs  # 媒体/文章下载
    └── tap.rs       # 状态管理 action 桥接（Pinia/Vuex）
```

**核心接口：**

```rust
// ---- 管道执行 ----
pub async fn execute_pipeline(
    page: Option<&dyn IPage>,
    pipeline: &[PipelineStep],
    args: &HashMap<String, Value>,
) -> Result<Value, CliError>;

// ---- 步骤处理器 trait ----
#[async_trait]
pub trait StepHandler: Send + Sync {
    async fn execute(
        &self,
        page: Option<&dyn IPage>,
        params: &Value,
        data: &Value,
        args: &HashMap<String, Value>,
    ) -> Result<Value, CliError>;
}

// ---- 表达式引擎 ----
pub fn render_template(
    template: &str,
    ctx: &TemplateContext,  // { args, data, item, index }
) -> Result<Value, CliError>;

// ---- 支持的过滤器 ----
// default(val), join(sep), upper, lower, trim, truncate(n),
// replace(old, new), keys, length, first, last, json, slugify,
// sanitize, ext, basename
```

**对应原版模块：** `pipeline/executor.ts`, `pipeline/template.ts`, `pipeline/registry.ts`, `pipeline/steps/*`

---

#### `opencli-rs-browser`

浏览器桥接层，与 Chrome 扩展通信。

**子模块：**

```
browser/
├── mod.rs             # 公开 API + IPage trait
├── bridge.rs          # BrowserBridge（Daemon 工厂）
├── daemon.rs          # Daemon 守护进程（HTTP + WebSocket 服务）
├── daemon_client.rs   # Daemon HTTP 客户端（命令发送 + 重试）
├── page.rs            # DaemonPage：IPage 在 HTTP 上的实现
├── cdp.rs             # CdpPage：IPage 在 WebSocket CDP 上的实现
├── dom_snapshot.rs    # DOM 快照引擎（多层裁剪 + LLM 友好格式）
├── dom_helpers.rs     # 浏览器端 JS 脚本模板（click, type, scroll 等）
├── stealth.rs         # 反检测 JS 注入
└── tabs.rs            # 标签页管理
```

**核心接口：**

```rust
// ---- IPage trait（浏览器操作抽象）----
#[async_trait]
pub trait IPage: Send + Sync {
    async fn goto(&self, url: &str, options: Option<GotoOptions>) -> Result<(), CliError>;
    async fn evaluate(&self, js: &str) -> Result<Value, CliError>;
    async fn get_cookies(&self, opts: Option<CookieOptions>) -> Result<Vec<Cookie>, CliError>;
    async fn snapshot(&self, opts: Option<SnapshotOptions>) -> Result<Value, CliError>;
    async fn click(&self, selector: &str) -> Result<(), CliError>;
    async fn type_text(&self, selector: &str, text: &str) -> Result<(), CliError>;
    async fn press_key(&self, key: &str) -> Result<(), CliError>;
    async fn wait(&self, options: WaitOptions) -> Result<(), CliError>;
    async fn scroll(&self, direction: Option<Direction>, amount: Option<i32>) -> Result<(), CliError>;
    async fn auto_scroll(&self, options: Option<AutoScrollOptions>) -> Result<(), CliError>;
    async fn tabs(&self) -> Result<Vec<TabInfo>, CliError>;
    async fn new_tab(&self) -> Result<(), CliError>;
    async fn select_tab(&self, index: usize) -> Result<(), CliError>;
    async fn close_tab(&self, index: Option<usize>) -> Result<(), CliError>;
    async fn network_requests(&self) -> Result<Vec<NetworkRequest>, CliError>;
    async fn screenshot(&self, options: Option<ScreenshotOptions>) -> Result<String, CliError>;
    async fn install_interceptor(&self, pattern: &str) -> Result<(), CliError>;
    async fn get_intercepted_requests(&self) -> Result<Vec<InterceptedRequest>, CliError>;
}

// ---- BrowserBridge（Daemon 工厂）----
pub struct BrowserBridge { ... }

impl BrowserBridge {
    pub async fn connect(&self, opts: Option<ConnectOptions>) -> Result<Box<dyn IPage>, CliError>;
    pub async fn close(&self) -> Result<(), CliError>;
}

// ---- Daemon 守护进程 ----
pub struct Daemon { ... }

impl Daemon {
    pub async fn start(port: u16) -> Result<Self, CliError>;
    pub async fn shutdown(&self) -> Result<(), CliError>;
    // HTTP 端点：POST /command, GET /status, GET /health
    // WebSocket 端点：/ext（Chrome 扩展连接）
    // 安全：Origin 校验, X-OpenCLI 请求头, 1MB body 限制
    // 空闲退出：5 分钟无命令
    // 心跳：每 15s ping 扩展
}

// ---- DaemonClient（HTTP 客户端）----
pub struct DaemonClient { ... }

impl DaemonClient {
    pub async fn send_command(&self, cmd: DaemonCommand) -> Result<Value, CliError>;
    pub async fn is_running(&self) -> bool;
    pub async fn is_extension_connected(&self) -> bool;
    // 重试策略：最多 4 次，500ms 网络错误 / 1500ms 瞬态扩展错误
    // 超时：30s per command
}
```

**对应原版模块：** `daemon.ts`, `browser/mcp.ts`, `browser/page.ts`, `browser/cdp.ts`, `browser/daemon-client.ts`, `browser/dom-snapshot.ts`, `browser/dom-helpers.ts`, `browser/stealth.ts`

---

#### `opencli-rs-output`

多格式输出渲染。

```rust
pub enum OutputFormat {
    Table,   // ASCII 表格（默认，人类友好）
    Json,    // 格式化 JSON
    Yaml,    // YAML
    Csv,     // RFC 4180 CSV
    Markdown,// Markdown 表格
}

pub struct RenderOptions {
    pub format: OutputFormat,
    pub columns: Option<Vec<String>>,  // 列选择/排序
    pub title: Option<String>,
    pub elapsed: Option<Duration>,
    pub source: Option<String>,
    pub footer_extra: Option<String>,
}

pub fn render(data: &Value, opts: &RenderOptions) -> Result<String, CliError>;
```

**对应原版模块：** `output.ts`

---

#### `opencli-rs-discovery`

适配器发现与注册系统。

```rust
/// 编译时：内置适配器通过 build.rs + include_str! 嵌入二进制
/// 运行时：扫描用户目录加载自定义适配器
pub fn discover_builtin_adapters(registry: &mut Registry) -> Result<(), CliError>;
pub fn discover_user_adapters(registry: &mut Registry) -> Result<(), CliError>;
pub fn discover_plugins(registry: &mut Registry) -> Result<(), CliError>;

/// YAML 适配器解析
pub fn parse_yaml_adapter(content: &str) -> Result<CliCommand, CliError>;

/// 注册优先级：
/// 1. 内置 YAML（adapters/）— 编译时嵌入
/// 2. 用户自定义（~/.opencli-rs/adapters/）— 运行时扫描
/// 3. 插件（~/.opencli-rs/plugins/）— 运行时扫描
/// 4. 外部 CLI（透传）
```

**对应原版模块：** `discovery.ts`, `build-manifest.ts`

---

#### `opencli-rs-external`

外部 CLI 集成管理。

```rust
pub struct ExternalCli {
    pub name: String,
    pub binary: String,
    pub description: String,
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    pub install: HashMap<String, String>,  // platform -> command
}

pub fn load_external_clis() -> Result<Vec<ExternalCli>, CliError>;
pub fn is_binary_installed(binary: &str) -> bool;
pub async fn execute_external_cli(
    name: &str, args: &[String]
) -> Result<ExitStatus, CliError>;
pub async fn install_external_cli(cli: &ExternalCli) -> Result<(), CliError>;

/// 安全：拒绝 shell 操作符（&&, |, ;, $() 等）
pub fn validate_args(args: &[String]) -> Result<(), CliError>;
```

**对应原版模块：** `external.ts`, `external-clis.yaml`

---

#### `opencli-rs-ai`

AI 原生发现能力。

```rust
// ---- Explore：API 发现 ----
pub async fn explore(
    page: &dyn IPage,
    url: &str,
    options: ExploreOptions,
) -> Result<ExploreManifest, CliError>;
// - 自动滚动触发懒加载
// - 网络流量捕获与分析
// - 框架检测（React, Vue, Angular 等）
// - 状态管理发现（Pinia, Vuex）
// - API 端点推断 + 置信度评分
// - 认证策略推断
// - 字段角色识别
// 输出：manifest.json, endpoints.json, capabilities.json, auth.json

// ---- Synthesize：适配器生成 ----
pub fn synthesize(
    manifest: &ExploreManifest,
    options: SynthesizeOptions,
) -> Result<Vec<AdapterCandidate>, CliError>;
// - 基于 explore 结果生成 YAML pipeline 候选
// - 生成参数定义
// - 返回 top 3 候选（按置信度排序）

// ---- Cascade：认证策略探测 ----
pub async fn cascade(
    page: &dyn IPage,
    api_url: &str,
) -> Result<Strategy, CliError>;
// - 逐级探测：PUBLIC → COOKIE → HEADER → INTERCEPT → UI
// - 返回最低权限的可用策略

// ---- Generate：一键生成 ----
pub async fn generate(
    page: &dyn IPage,
    url: &str,
    goal: &str,
) -> Result<CliCommand, CliError>;
// - 串联：explore → synthesize → register
```

**对应原版模块：** `explore.ts`, `synthesize.ts`, `cascade.ts`

---

#### `opencli-rs-cli`

最终二进制入口，编排所有 crate。

```rust
// main.rs
#[tokio::main]
async fn main() {
    // 1. 初始化注册表
    // 2. discover_builtin_adapters() — 编译时嵌入的 YAML
    // 3. discover_user_adapters()    — ~/.opencli-rs/adapters/
    // 4. discover_plugins()          — ~/.opencli-rs/plugins/
    // 5. load_external_clis()        — 外部 CLI
    // 6. 构建 clap App（动态子命令）
    // 7. 解析参数 → 路由到对应命令
    // 8. execute_command() → render()
}

/// 命令执行编排
pub async fn execute_command(
    cmd: &CliCommand,
    kwargs: HashMap<String, Value>,
) -> Result<Value, CliError> {
    // 1. 参数类型转换 & 校验
    // 2. 能力路由判断（需要浏览器？）
    // 3. 如需浏览器 → BrowserBridge::connect() → 预导航
    // 4. 执行 cmd.func() 或 execute_pipeline()
    // 5. 超时控制（tokio::time::timeout）
}

/// 内置命令
// - explore <url>
// - synthesize
// - cascade <api-url>
// - generate <url> --goal "..."
// - doctor（诊断）
// - completion（Shell 补全）
```

**对应原版模块：** `main.ts`, `cli.ts`, `execution.ts`, `commanderAdapter.ts`

---

## 4. 技术选型

| 功能 | TypeScript 原版 | Rust 选型 | 选型理由 |
|------|----------------|-----------|---------|
| CLI 框架 | Commander.js | `clap` (derive) | Rust 生态最成熟的 CLI 框架，derive 宏减少样板 |
| 异步运行时 | Node.js event loop | `tokio` | Rust 异步标准，多线程调度 |
| HTTP 客户端 | node fetch | `reqwest` | 连接池复用、async、TLS |
| WebSocket | `ws` | `tokio-tungstenite` | 与 tokio 深度集成 |
| HTTP 服务 (Daemon) | 手写 http server | `axum` | 轻量、tokio 原生、WebSocket 支持好 |
| YAML 解析 | `js-yaml` | `serde_yaml` | serde 生态统一序列化 |
| JSON 处理 | 内置 JSON | `serde_json` | Rust 标准 |
| 表达式解析 | 自定义 + JS eval | `pest` | PEG parser generator，类型安全 |
| 终端着色 | `chalk` | `colored` | 简洁 API |
| 表格渲染 | `cli-table3` | `comfy-table` | 功能丰富，Unicode 友好 |
| CSV 输出 | 手写 | `csv` | RFC 4180 合规 |
| HTML→Markdown | `turndown` | `htmd` | 轻量级 |
| 进程管理 | child_process | `tokio::process` | 异步子进程 |
| 序列化 | 手写 | `serde` + derive | 统一序列化框架 |
| 错误处理 | 自定义 class | `thiserror` | 编译时错误推导 |
| Shell 补全 | 手写 | `clap_complete` | clap 内置支持 |

---

## 5. 适配器体系

### 5.1 YAML 适配器

与原版格式完全兼容，存放在 `adapters/` 目录：

```yaml
# adapters/hackernews/top.yaml
site: hackernews
name: top
description: Hacker News 热门文章
strategy: public
browser: false

args:
  limit:
    type: int
    default: 20
    description: 返回数量

columns: [rank, title, score, author]

pipeline:
  - fetch: https://hacker-news.firebaseio.com/v0/topstories.json
  - limit: "${{ Math.min(args.limit + 10, 50) }}"
  - map:
      id: "${{ item }}"
  - fetch: "https://hacker-news.firebaseio.com/v0/item/${{ item.id }}.json"
  - filter: "item.title && !item.deleted"
  - map:
      rank: "${{ index + 1 }}"
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      author: "${{ item.by }}"
```

### 5.2 编程式适配器（Rust 原生）

原版 TS 适配器中，`func` 函数大量使用 `page.evaluate(js)` 在浏览器中执行 JS。
Rust 版保持相同模式 — 将 JS 字符串通过 IPage 发送到浏览器执行：

```rust
// 在 adapters/ 中以 YAML 定义，func 字段用 evaluate 步骤替代
// 复杂逻辑的适配器转为 YAML pipeline + evaluate 步骤

// 对于特别复杂的适配器（如需要 Rust 原生逻辑），
// 可在 crate 内部注册：
pub fn register_builtin_adapters(registry: &mut Registry) {
    registry.register(CliCommand {
        site: "bilibili".into(),
        name: "me".into(),
        // ...
        func: Some(Box::new(|page, kwargs| Box::pin(bilibili_me(page, kwargs)))),
        ..Default::default()
    });
}
```

### 5.3 适配器迁移策略

原版 57+ 适配器分为三类，采用不同迁移方式：

| 类型 | 数量 | 迁移方式 |
|------|------|---------|
| 纯 YAML pipeline | ~30 | 直接复制 YAML 到 `adapters/`，确保 pipeline 引擎兼容 |
| TS + page.evaluate | ~20 | 转为 YAML pipeline + evaluate 步骤，JS 代码保持原样 |
| 复杂 TS 逻辑 | ~7 | 在 Rust 中实现 func，或拆解为 YAML pipeline |

---

## 6. 关键流程

### 6.1 启动流程

```
main()
  │
  ├─ 1. 初始化全局 Registry
  │
  ├─ 2. discover_builtin_adapters()
  │     └─ 从编译时嵌入的 YAML 字符串解析 → 注册
  │
  ├─ 3. discover_user_adapters()
  │     └─ 扫描 ~/.opencli-rs/adapters/**/*.yaml → 解析 → 注册
  │
  ├─ 4. discover_plugins()
  │     └─ 扫描 ~/.opencli-rs/plugins/ → 加载 → 注册
  │
  ├─ 5. load_external_clis()
  │     └─ 读取 resources/external-clis.yaml + ~/.opencli-rs/external-clis.yaml
  │
  ├─ 6. 构建 clap App
  │     ├─ 注册内置命令（explore, synthesize, cascade, generate, doctor, completion）
  │     ├─ 为每个 site 创建 subcommand group
  │     ├─ 为每个 command 创建 subcommand + args
  │     └─ 为每个 external cli 创建透传 subcommand
  │
  ├─ 7. 解析命令行参数
  │
  └─ 8. 路由执行
        ├─ 内置命令 → 直接调用对应函数
        ├─ 站点命令 → execute_command()
        └─ 外部 CLI → execute_external_cli()
```

### 6.2 命令执行流程

```
execute_command(cmd, kwargs)
  │
  ├─ 1. coerce_and_validate_args()
  │     ├─ 类型转换（str→int, str→bool 等）
  │     ├─ 必填参数检查
  │     ├─ choices 校验
  │     └─ 填充默认值
  │
  ├─ 2. should_use_browser()?
  │     ├─ strategy != Public → true
  │     ├─ browser == true → true
  │     └─ pipeline 包含 navigate/click/type 等 → true
  │
  ├─ 3a. 需要浏览器：
  │     ├─ BrowserBridge::connect()
  │     │   ├─ 检查 Daemon 是否运行
  │     │   ├─ 未运行 → 启动 Daemon 子进程
  │     │   ├─ 等待扩展连接（10s 超时）
  │     │   └─ 返回 DaemonPage
  │     ├─ 预导航至 cmd.domain（获取 Cookie/Header 上下文）
  │     └─ run_command() with page（带超时）
  │
  ├─ 3b. 不需要浏览器：
  │     └─ run_command() without page
  │
  ├─ 4. run_command()
  │     ├─ cmd.func → 调用 Rust 函数
  │     └─ cmd.pipeline → execute_pipeline()
  │
  └─ 5. render(data, format, columns)
```

### 6.3 Pipeline 执行流程

```
execute_pipeline(page, steps, args)
  │
  ├─ data = Value::Null  // 初始数据
  │
  ├─ for step in steps:
  │     │
  │     ├─ 解析步骤类型（navigate / fetch / map / ...）
  │     │
  │     ├─ render_template() 渲染参数中的 ${{ expr }}
  │     │
  │     ├─ 查找 StepHandler
  │     │
  │     ├─ handler.execute(page, params, data, args)
  │     │   ├─ 成功 → data = result
  │     │   └─ 失败 → 浏览器步骤重试（最多 2 次），其他直接报错
  │     │
  │     └─ data = result
  │
  └─ return data
```

### 6.4 Daemon 通信流程

```
CLI 进程                    Daemon (localhost:19825)           Chrome 扩展
  │                              │                                │
  │  POST /command               │                                │
  │  { action, code, ... }       │                                │
  │ ─────────────────────────▶   │                                │
  │                              │   WebSocket message            │
  │                              │   { id, action, code, ... }    │
  │                              │ ─────────────────────────────▶  │
  │                              │                                │
  │                              │                   chrome.debugger
  │                              │                   .sendCommand()
  │                              │                                │
  │                              │   WebSocket result             │
  │                              │   { id, ok, data }             │
  │                              │ ◀─────────────────────────────  │
  │  HTTP response               │                                │
  │  { ok, data }                │                                │
  │ ◀─────────────────────────   │                                │
```

---

## 7. 相比原版的优化

### 7.1 模板引擎：安全表达式引擎替代 JS eval

**原版问题：** `template.ts` 对复杂表达式 fallback 到 `new Function(...)` eval，存在安全风险，且错误信息不友好（只报 JS 运行时错误）。

**Rust 优化：** 用 `pest` PEG parser 实现类型安全的表达式引擎：

```
支持语法：
  变量访问：   args.limit, item.title, index, data
  算术运算：   +, -, *, /, %
  比较运算：   >, <, >=, <=, ==, !=
  逻辑运算：   &&, ||, !
  三元表达式： condition ? a : b
  管道过滤器： expr | filter(arg) | filter2
  字符串：     "hello", 'world'
  数组索引：   items[0], data.list[index]
  方法调用：   .length, .keys, .first, .last
  Fallback：   expr || 'default'

内置过滤器（与原版对等）：
  default(val), join(sep), upper, lower, trim, truncate(n),
  replace(old, new), keys, length, first, last, json,
  slugify, sanitize, ext, basename
```

**优势：**
- 编译时语法检查，解析阶段即报错（而非运行时 eval 失败）
- 无代码注入风险
- 精确的错误位置指示（行列号 + 上下文）
- 性能更优（解析一次，多次执行）

### 7.2 Pipeline 执行：并发 + 零拷贝

**原版问题：**
- per-item fetch 在非浏览器模式 pool=5 并发，但整体 pipeline 严格串行
- JS 数据变换每步都要序列化/反序列化

**Rust 优化：**
- **fetch 步骤并发：** 使用 `FuturesUnordered` + 可配置并发度（默认 10），比原版 pool=5 更快
- **数据变换零拷贝：** `map`/`filter`/`sort`/`limit` 在 `serde_json::Value` 上直接操作，无 JS 引擎序列化开销
- **大数据流式：** 当数据量超过阈值时，使用 iterator chain 逐条处理，避免内存峰值

### 7.3 发现系统：编译时内嵌

**原版问题：** 需要 `npm run build-manifest` 构建步骤生成 `cli-manifest.json`，启动时读取文件 → JSON 解析 → 注册。

**Rust 优化：**
- **`build.rs` 编译时处理：** 扫描 `adapters/` 目录，通过 `include_str!` 将所有 YAML 嵌入二进制
- **启动零 I/O：** 内置适配器直接从静态字符串解析注册，无文件读取
- **用户适配器运行时加载：** `~/.opencli-rs/adapters/` 仍运行时扫描，支持热加载

```rust
// build.rs 生成的代码
pub const BUILTIN_ADAPTERS: &[(&str, &str)] = &[
    ("hackernews/top.yaml", include_str!("../adapters/hackernews/top.yaml")),
    ("bilibili/hot.yaml", include_str!("../adapters/bilibili/hot.yaml")),
    // ... 所有内置适配器
];
```

### 7.4 错误系统：结构化诊断链

**原版问题：** 每个错误只有一个 `hint` 字符串，错误链丢失（只看到最外层错误）。

**Rust 优化：**
- **错误链（cause chain）：** 每层错误保留 source，可追溯到根因
  ```
  CommandExecutionError: bilibili hot 执行失败
    caused by: BrowserConnectError: 无法连接到 Daemon
      caused by: IoError: Connection refused (port 19825)
  ```
- **多条建议：** `suggestions: Vec<String>` 提供多个排查方向
- **编译时保证：** 所有 `Result<T, CliError>` 必须被处理，无遗漏的错误路径

### 7.5 Daemon 通信：连接池 + 智能重试

**原版问题：** 每次命令 new fetch，无连接复用；重试策略固定。

**Rust 优化：**
- **reqwest 连接池：** HTTP keep-alive，复用 TCP 连接
- **指数退避重试：** 而非固定间隔，对不同错误类型使用不同策略
- **WebSocket 长连接：** CDP 模式下复用 WebSocket，避免重复握手

### 7.6 二进制分发：零依赖

**原版问题：** 需要 Node.js 20+ 运行时 + `npm install` 安装 ~50 个依赖包。

**Rust 优化：**
- 编译为单一静态链接二进制
- 零运行时依赖
- 交叉编译支持（Linux/macOS/Windows）
- 二进制体积小（预计 10-15MB，原版 node_modules ~100MB+）

### 7.7 内存安全 + 并发安全

**原版问题：** JS 单线程，大量数据处理时阻塞事件循环。

**Rust 优化：**
- 所有权系统保证内存安全，无 GC 暂停
- `tokio` 多线程运行时，I/O 密集任务不阻塞
- `Send + Sync` 约束保证并发安全

---

## 8. 配置与环境变量

与原版保持兼容：

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `OPENCLI_VERBOSE` | false | 详细输出 |
| `OPENCLI_BROWSER_CONNECT_TIMEOUT` | 30s | 浏览器连接超时 |
| `OPENCLI_BROWSER_COMMAND_TIMEOUT` | 60s | 浏览器命令超时 |
| `OPENCLI_BROWSER_EXPLORE_TIMEOUT` | 120s | Explore 超时 |
| `OPENCLI_CDP_ENDPOINT` | 无 | CDP 直连端点 |
| `OPENCLI_DAEMON_PORT` | 19825 | Daemon 端口 |

文件路径（`~/.opencli` → `~/.opencli-rs`）：

| 路径 | 说明 |
|------|------|
| `~/.opencli-rs/adapters/` | 用户自定义适配器 |
| `~/.opencli-rs/plugins/` | 用户插件 |
| `~/.opencli-rs/external-clis.yaml` | 用户外部 CLI 注册表 |

---

## 9. 测试策略

```
tests/
├── unit/                  # 单元测试（各 crate 内 #[cfg(test)] mod tests）
│   ├── template_test      # 表达式引擎
│   ├── pipeline_test      # 管道执行
│   ├── output_test        # 输出格式化
│   └── discovery_test     # 适配器发现
├── integration/           # 集成测试（tests/ 目录）
│   ├── e2e_public.rs      # 公开命令端到端
│   ├── e2e_browser.rs     # 浏览器命令端到端
│   ├── e2e_output.rs      # 输出格式验证
│   └── e2e_external.rs    # 外部 CLI 透传
└── smoke/                 # 冒烟测试
    └── adapter_smoke.rs   # 适配器加载 + 命令注册完整性
```

---

## 10. 实现阶段规划

### Phase 1：基础框架

1. Workspace 搭建 + 各 crate 骨架
2. `opencli-rs-core`：数据模型（Strategy, ArgDef, CliCommand, Registry, CliError）
3. `opencli-rs-output`：5 种输出格式
4. `opencli-rs-cli`：clap 入口 + 基本命令路由

### Phase 2：Pipeline 引擎

5. `opencli-rs-pipeline` 表达式引擎（pest parser + 过滤器）
6. `opencli-rs-pipeline` 步骤注册表 + 执行器
7. `opencli-rs-pipeline` 内置步骤：transform（select, map, filter, sort, limit）
8. `opencli-rs-pipeline` 内置步骤：fetch（单次 + per-item 并发）

### Phase 3：适配器系统

9. `opencli-rs-discovery`：YAML 适配器解析 + build.rs 编译时嵌入
10. `opencli-rs-discovery`：运行时用户适配器扫描
11. 迁移所有纯 YAML 适配器（~30 个）
12. 迁移 TS→YAML 适配器（~20 个）

### Phase 4：浏览器桥接

13. `opencli-rs-browser`：IPage trait + DaemonClient
14. `opencli-rs-browser`：Daemon 守护进程（axum HTTP + WebSocket）
15. `opencli-rs-browser`：BrowserBridge（Daemon 工厂 + 连接管理）
16. `opencli-rs-browser`：CdpPage（WebSocket CDP 直连）
17. `opencli-rs-pipeline` 浏览器步骤：navigate, click, type, wait, evaluate 等
18. `opencli-rs-browser`：DOM 快照、stealth、标签管理

### Phase 5：外部 CLI + AI 能力

19. `opencli-rs-external`：外部 CLI 加载 + 透传 + 安装
20. `opencli-rs-ai`：explore（API 发现）
21. `opencli-rs-ai`：synthesize（适配器生成）
22. `opencli-rs-ai`：cascade（认证探测）+ generate（一键生成）

### Phase 6：完善与打磨

23. 迁移剩余复杂适配器（~7 个）
24. Shell 补全（clap_complete）
25. doctor 诊断命令
26. 全面测试 + 修复
27. 交叉编译 + 发布配置
