# 网页游戏解谜整理插件 · 接口规范与并行开发标准

本文档为「网页游戏解谜整理插件」Chrome Manifest V3 扩展的唯一权威接口规范。全体 5 位开发人员（Allen、Apple、Peter、Look、Tom）必须严格按照本文档定义的路径、函数签名、数据模型、消息格式与安全边界进行并行编码。

---

## 1. 概述与目标

「网页游戏解谜整理插件」是一款面向桌面 Chrome 的 Manifest V3 浏览器扩展。用户在插件中配置个人 AI API Key 后，插件在用户授权的游戏站点上持续读取文字变化（DOM 增量）及画布截图（Canvas 游戏），调用自选 AI 模型提取线索，并按游戏归档。用户在提问侧栏中输入疑问时，AI 结合当前游戏的历史线索输出逻辑总结与下一步推演建议。

### 核心设计目标
1. **最小权限与安全隔离**：零必选 Host 权限，按站点动态授权与注册 Script；API Key 仅存放于本地受控存储，严禁外溢。
2. **纯内核可移植性**：业务逻辑、AI 交互与线索归档层（`core/*`）与浏览器 API 完全解耦，所有底层能力通过适配器（Adapter）注入，以便无缝移植至 iPad/Userscripts 环境。
3. **低侵入与性能保护**：文本 DOM 监听实施 5 秒增量合并（Batching）；画布检测实施最密 30 秒截图限制，无变化或无提问时不调用 AI。

---

## 2. 硬性约束

以下条款为系统强制实施红线，代码评审时一票否决：

1. **密钥零泄漏约束**：
   - API Key 仅保存在 `chrome.storage.local`（经由 `StorageAdapter` 存取），唯一合法的流出路径是发送至用户明确配置的 AI 服务商 HTTPS 接口。
   - 严禁将 API Key 写入 `console.*`、`ai_logs/`、Content Script 消息通道、UI DOM 属性（除聚焦编辑状态）、导出文件（JSON/Markdown）或 `Error.message` 堆栈中。
2. **内核环境无关约束**：
   - `core/ai.js`、`core/clues.js`、`core/settings.js`（纯逻辑部分）严禁直接调用任何 `chrome.*` API。存储、网络和特权权限操作必须通过构造工厂注入的 Port / Adapter 接口完成。
3. **权限最小化与动态注入**：
   - 严禁在 `manifest.json` 的 `permissions` 中声明 `<all_urls>`。禁止声明静态 `host_permissions`。
   - 游戏域名必须使用 `optional_host_permissions`。用户在设置中添加站点时，由设置页在用户点击处理函数中同步调用 `chrome.permissions.request`，后台只用 `chrome.permissions.contains` 检查；授权成功后使用 `chrome.scripting.registerContentScripts` 动态注册 Content Script；移除站点时注销脚本并释放权限。
   - 各 AI 服务商域名（如 `api.openai.com`）必须在用户切换或保存供应商时，按需申请 Optional Host 权限。
4. **读取与截图节流策略**：
   - 页面文本使用 `MutationObserver` 采集，必须经过 5000ms 窗口合并，计算字符级增量（Delta），仅把新增文本发给 AI。
   - 截图仅针对检测为画布类（Canvas/WebGL）的游戏页面启用。自动截图与手动截图必须经过至少 30000ms 强制冷却。截图由 Content Script 发起请求，由 Background 调用 `chrome.tabs.captureVisibleTab` 执行。页面无新文本且无新截图、用户未提问时，严禁调用 AI。
5. **UI 与宿主解耦**：
   - 提问界面 `ui/panel.html` 作为独立页面开发，通过 `mountPanel(root, port)` 挂载。在 Chrome 下作为 Side Panel 呈现，但其内部业务逻辑不得直接依赖 `chrome.sidePanel`，侧栏生命周期由 Background 掌控。
6. **技术基线**：
   - 仅使用 ES Module，不引入 npm 运行时依赖。测试使用 Node.js 18+ 原生 `node:assert`，缩进为 2 空格，换行为 LF，源码编码为 UTF-8。代码内标识符全部英文，注释及用户文案使用中文。

---

## 3. 目录与文件布局

工程目录结构强制如下，文件名与路径完全固定：

```
.gitignore                  # 必须包含 ai_logs/、node_modules/、.DS_Store 等；严禁忽略源码
README.md                   # 中文：安装配置、权限机制与调试说明
package.json                # private: true, type: "module", scripts: { "test": "node tests/run.mjs" }
manifest.json               # MV3 规范配置清单
docs/
  INTERFACE.md              # 本规范文档
background/
  service-worker.js         # 后台路由总线、权限管理、脚本注入、截图调度
content/
  reader.js                 # 动态注入的页面文本读取器、Canvas变化侦测器
core/
  messages.js               # 跨端消息类型常量与消息体校验器
  models.js                 # 核心数据模型接口与纯函数工具
  settings.js               # 设置业务逻辑（Allen）
  ai.js                     # AI Prompt 构建与模型调用封装（Apple）
  clues.js                  # 线索去重、归档、导出核心逻辑（Peter）
  providers/
    openai.js               # OpenAI 兼容协议适配器
    deepseek.js             # DeepSeek API 适配器
    gemini.js               # Google Gemini 原生 API 适配器
adapters/
  storage.js                # Chrome 存储与内存存储抽象实现
  http.js                   # Fetch HTTP 抽象与测试 Mock 适配器
ui/
  options.html              # 独立设置页面
  options.js                # 设置页交互逻辑（Allen）
  options.css               # 设置页样式
  panel.html                # 提问与线索查看侧边栏
  panel.js                  # 侧边栏交互逻辑（Tom）
  panel.css                 # 侧边栏样式
tests/
  run.mjs                   # 零依赖测试运行器
  smoke.test.js             # 端到端核心模块冒烟测试
```

---

## 4. 模块与负责人对照表

| 模块名称 | 负责人 | 核心物理路径 | 必须导出的公共函数/常量签名 | 核心职责说明 |
| :--- | :--- | :--- | :--- | :--- |
| **Settings** | Allen | `core/settings.js`<br>`ui/options.*` | `DEFAULT_SETTINGS: Settings`<br>`redactSecret(value: string): string`<br>`normalizeOrigin(urlOrOrigin: string): string`<br>`createSettingsService({ storage, permissions }): SettingsService` | 管理供应商配置、模型选择、站点授权列表；驱动 Options 页面安全交互；隔离 Key 的明文展示。 |
| **Reader** | Look | `content/reader.js` | `collectVisibleText(doc?: Document): string`<br>`computeDelta(prev: string, next: string): string`<br>`shouldCaptureCanvas(doc?: Document): boolean`<br>`startReader(config: ReaderConfig): void`<br>`stopReader(): void`<br>`flushBatch(): void`<br>`requestScreenshot(reason: 'user' \| 'visual_change'): void` | 动态运行在已授权网页中；提取可见文本，5秒合并增量；侦测 Canvas 并计算低分辨率像素散列；受控触发截图请求；绝不碰触 API Key。 |
| **AI** | Apple | `core/ai.js`<br>`core/providers/*` | `assertNoSecretInText(text: string, apiKey: string): void`<br>`buildExtractPrompt(delta: string, hasImage: boolean): { system: string, user: string }`<br>`buildAnswerPrompt(question: string, clues: Clue[]): { system: string, user: string }`<br>`selectProvider(settings: Settings): ProviderAdapter`<br>`createAiClient({ http, getSettings, now? }): AiClient` | 构造提取与回答提示词；分发多供应商请求；适配视觉能力；提供发送前密钥阻断断言；统一错误为友好中文。 |
| **Clues** | Peter | `core/clues.js` | `makeGameKey(origin: string, gameId?: string): string`<br>`parseGameKey(gameKey: string): { origin: string, gameId?: string }`<br>`dedupeKey(clue: { text: string }): string`<br>`createClueStore({ storage, now?, id? }): ClueStore` | 线索与问答持久化（addQa/listQa）、归一化去重（文本小写/空格压缩）；维护游戏元信息索引；提供含问答、无 Key 泄漏的 JSON/Markdown 导出。 |
| **Panel** | Tom | `ui/panel.html`<br>`ui/panel.js`<br>`ui/panel.css` | `mountPanel(root: HTMLElement, port: PanelPort): void`<br>`unmountPanel(root: HTMLElement): void` | 独立侧栏 UI，展示当前活跃游戏线索时间线；支持问答交互、状态提示、手动刷新与导出；完全解耦 SidePanel 原生 API。 |
| **Hub** | 全体/架构 | `background/service-worker.js` | 内部事件监听与服务总线 | 响应消息总线；调用 `chrome.permissions` 与 `chrome.scripting`；调度标签页截图；双重节流保护；协同各模块执行。 |

---

## 5. 数据模型

数据模型定义于 `core/models.js`。代码中使用 TypeScript JSDoc 标注。

```typescript
// AI 供应商标识
export type ProviderId = 'openai_compatible' | 'deepseek' | 'gemini';

// 游戏站点授权记录
export interface GameSite {
  origin: string;          // 规范化的协议与域名，例如 "https://game.example.com"，无尾随斜杠
  gameId?: string;         // 可选的二级游戏标识符（用于同源多游戏）
  title?: string;          // 游戏或页面标题
  enabled: boolean;        // 是否开启线索捕获
  granted: boolean;        // 当前是否已获得 Host 权限
  addedAt: number;         // 站点添加时间戳（毫秒）
}

// 全局配置结构体
export interface Settings {
  provider: ProviderId;    // 当前选定的服务商
  apiKey: string;          // API 密钥（内存存储为完整值，持久化及传输需严控）
  model: string;           // 使用的模型标识
  baseUrl?: string;        // 仅在 provider 为 openai_compatible 时生效
  gameSites: GameSite[];   // 已注册的游戏站点列表
  batchIntervalMs: number; // 文本增量合并窗口，默认 5000
  screenshotMaxIntervalMs: number; // 截图最小冷却间隔，默认 30000
  currentGameKey?: string; // 当前正在查看或活跃的游戏标识符
}

// 安全脱敏设置视图（供前端 UI 呈现与日志安全输出）
export interface RedactedSettings extends Omit<Settings, 'apiKey'> {
  apiKeyMasked: string;    // 脱敏字符串，如 "sk-****abcd" 或 "****"
  hasApiKey: boolean;      // 指示是否存在已配置的有效 Key
}

// 提取的单条线索实体
export interface Clue {
  id: string;              // 唯一 ID（例如 "clue_1710000000000_a1b2c3"）
  gameKey: string;         // 归属的游戏键（通过 makeGameKey 生成）
  text: string;            // 线索核心事实描述
  source: 'text' | 'screenshot' | 'user'; // 线索采集源
  createdAt: number;       // 捕获时间戳（毫秒）
  tags?: string[];         // 语义标签，例如 ["密码", "门禁", "道具"]
  imageRef?: string;       // 截图元数据引用（不存大图 Base64，仅存快照哈希或预留标识）
}

// 问答记录实体
export interface QaEntry {
  id: string;              // 问答主键
  gameKey: string;         // 归属游戏复合主键
  question: string;        // 提问文本（脱敏）
  answer: string;          // 回答正文（脱敏）
  summary?: string;        // 线索总结（可选）
  suggestions?: string[];  // 下一步建议（可选）
  model?: string;          // 模型标识（可选）
  createdAt: number;       // 问答时间戳
}

// 游戏完整归档实体
export interface GameRecord {
  gameKey: string;         // 游戏唯一复合主键
  origin: string;          // 站点 Origin
  gameId?: string;         // 子游戏标识符
  title?: string;          // 游戏呈现名称
  clues: Clue[];           // 线索集合（按时间升序）
  qa?: QaEntry[];          // 问答记录集合（按时间升序）
  createdAt: number;       // 初次建档时间戳
  updatedAt: number;       // 最近更新时间戳
}

// AI 提取线索的输出结构
export interface ExtractCluesResult {
  clues: Array<{
    text: string;
    tags?: string[];
    source: 'text' | 'screenshot';
  }>;
  rawSummary?: string;     // AI 内部提取小结
  model: string;           // 实际执行模型
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

// AI 提问回答的输出结构
export interface AnswerQuestionResult {
  summary: string;         // 当前线索整体综合摘要
  suggestions: string[];   // 推荐用户接下来尝试的操作列表
  answer: string;          // 对用户所提问题的针对性回复
  model: string;           // 实际执行模型
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}
```

---

## 6. 存储适配器与 HTTP 适配器接口

适配器实现必须保证在 Node.js 与浏览器双环境均可正常运行。

### 6.1 StorageAdapter
定义于 `adapters/storage.js`。

```typescript
export interface StorageAdapter {
  get<T = any>(key: string): Promise<T | undefined>;
  set(key: string, value: any): Promise<void>;
  remove(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

// Chrome 扩展生产实现
export function createChromeStorageAdapter(): StorageAdapter;

// 纯内存实现（用于测试与 Userscripts 内存模式）
export function createMemoryStorageAdapter(initial?: Record<string, any>): StorageAdapter;
```
- **错误约定**：底层存储如果发生配额超限（`QUOTA_BYTES_PER_ITEM` 等），必须抛出统一中文错误 `new Error('存储空间超出限额，写入失败')`。
- **存储键划分**：
  - 设置持久化键命名固定为：`settings:v1`
  - 游戏数据键前缀固定为：`clues:v1:{gameKey}`

### 6.2 HttpAdapter
定义于 `adapters/http.js`。

```typescript
export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number; // 默认必须设置 30000ms 超时
}

export interface HttpResponse {
  status: number;
  text: string;
  json?: any;
}

export interface HttpAdapter {
  request(url: string, init?: HttpRequestOptions): Promise<HttpResponse>;
}

// 原生 Fetch 实现（兼容浏览器与 Node 18+）
export function createFetchHttpAdapter(): HttpAdapter;

// 模拟测试实现
export interface MockHandler {
  (url: string, init?: HttpRequestOptions): Promise<HttpResponse> | HttpResponse;
}
export function createMockHttpAdapter(handler: MockHandler): HttpAdapter;
```
- **错误约定**：
  - 请求发生网络中断、DNS 解析失败或超时，统一抛出 `new Error('网络请求异常，请检查网络连接')`。
  - HTTP 非 2xx 响应时，`request` 方法**不得**直接抛出异常，而必须返回完整的 `{ status, text }`，由业务层 `ProviderAdapter` 解析错误内容。严禁在抛出的错误栈或文本中附加完整的 Headers 对象，防止 Authorization 请求头外泄。

---

## 7. 消息类型

所有消息常量集中定义在 `core/messages.js`，通信采用统一封装：

```typescript
// 标准请求包裹体
export interface ExtensionMessage<T = any> {
  type: string;
  requestId: string; // 唯一请求序号（如 UUID 或时间戳随机字符串）
  payload: T;
}

// 标准响应包裹体
export interface ExtensionResponse<T = any> {
  type: string;
  requestId: string;
  ok: boolean;
  payload?: T;
  error?: {
    message: string; // 必须是中文，严禁包含 API Key 明文
  };
}
```

### 消息常量与流向表

| 常量名称 (`type`) | 消息流向 | Payload 规范 | 响应内容与处理职责 |
| :--- | :--- | :--- | :--- |
| `PING` | Any → Background | `{ timestamp: number }` | 响应 `{ ok: true, pong: number }`。用于心跳与通道可用性检测。 |
| `PANEL_READY` | Panel → Background | `{}` | 侧栏初始化完成，触发 Background 对所有已打开且已授权标签页补注入 Reader Loader，并返回当前活跃标签页状态与当前站点线索。 |
| `OPTIONS_READY` | Options → Background | `{}` | 设置页初始化完成，触发权限同步与设置加载。 |
| `ACTIVE_TAB_INFO` | Panel → Background | `{}` | 响应 `{ origin: string, gameId?: string, isGranted: boolean, isCanvas: boolean, title: string }`。由 Background 查询当前高亮 Tab 状态。 |
| `SETTINGS_GET` | UI → Background | `{}` | 响应脱敏设置：`RedactedSettings`。绝不把明文 API Key 传给 UI。 |
| `SETTINGS_SAVE` | Options → Background | `Partial<Settings>` | 保存全局设置。若包含明文 `apiKey`，Background 写入 storage 但严禁将该 payload 打印到日志。成功返回 `RedactedSettings`。 |
| `SITES_ADD` | Options → Background | `{ origin: string, gameId?: string }` | 设置页在用户点击处理函数中同步申请 Host 权限，后台只用 `chrome.permissions.contains` 检查并注册 Reader 脚本，并自动向该 Origin 下已打开标签页注入 Reader Loader。响应 `{ site: GameSite, granted: boolean }`。 |
| `SITES_REMOVE` | Options → Background | `{ origin: string, gameId?: string }` | 注销 Reader 脚本，若该 Origin 下无其他游戏，调用 Permissions API 回收权限。响应 `{ ok: true }`。 |
| `PROVIDER_PERMISSION_REQUEST` | Options → Background | `{ provider: ProviderId, baseUrl?: string }` | 申请对应 AI 服务商域名的可选网络权限。响应 `{ granted: boolean }`。 |
| `CLUES_LIST` | Panel → Background | `{ gameKey: string }` | 读取指定游戏的全部线索。响应 `Clue[]`。 |
| `CLUES_LIST_GAMES` | Panel/Options → Background | `{}` | 获取游戏归档列表。响应 `GameRecord[]`（可剥离大字段）。 |
| `CLUES_EXPORT` | Panel → Background | `{ gameKey: string \| null, format: 'json' \| 'markdown' }` | 导出指定或全部游戏的排版线索与问答历史（含 JSON / Markdown）。绝不包含 API Key / BaseUrl 等敏感字段。响应 `{ content: string, filename: string }`。 |
| `CLUES_UPDATED` | Background → Panel (广播) | `{ gameKey: string, addedCount: number }` | 当 AI 提取新线索成功并写入存储后广播，Panel 据此自动重新拉取线索流。 |
| `READER_CONFIG` | Background → Content | `{ batchIntervalMs: number, screenshotMaxIntervalMs: number, gameKey: string, enabled: boolean }` | 下发给 Content Script 的工作参数。 |
| `READER_DELTA` | Content → Background | `{ origin: string, gameKey?: string, text: string, title?: string }` | 页面文本合并增量上报。Background 接收后交由 `aiClient.extractClues` 处理，产生新线索自动存入 Store。 |
| `READER_FLUSH` | Panel/Background → Content | `{}` | 强制 Content Script 立即清空当前文本合并缓冲区并向后台发射 `READER_DELTA`。 |
| `READER_SCREENSHOT_REQUEST` | Content/Panel → Background | `{ origin: string, gameKey?: string, reason: 'user' \| 'visual_change', tabId?: number }` | 请求 Background 对当前标签页执行截屏。Background 校验节流，执行 `captureVisibleTab`，转送 AI。 |
| `READER_SCREENSHOT_RESULT` | Background → Content/Panel | `{ ok: boolean, reason: string, skipped?: 'throttled' \| 'no_tab' \| 'permission', error?: string }` | 截屏调度反馈结果。 |
| `AI_EXTRACT` | Background (内部) / Panel | `{ gameKey: string, delta?: string, image?: { mimeType: string, dataBase64: string } }` | 触发单次线索抽取。响应 `ExtractCluesResult`。 |
| `AI_ASK` | Panel → Background | `{ gameKey: string, question: string }` | 用户提交提问。Background 调取该游戏全部线索，送入 `aiClient.answerQuestion`，成功后持久化问答至该游戏归档（进行明文 Key 过滤），响应 `AnswerQuestionResult`。 |

---

## 8. 权限模型与站点授权流程

### 8.1 Manifest 权限声明准则
`manifest.json` 必须严格遵循最小权限法则：
- **必选权限 (`permissions`)**：
  - `storage`：本地持久化线索与配置。
  - `sidePanel`：右侧挂载线索交互面板。
  - `scripting`：动态向已授权游戏站点注入 `content/reader.js`。
  - `tabs`：**必要性权衡与采纳**。为了在 Background 中根据当前活跃标签页的 URL 准确识别游戏状态并完成 `captureVisibleTab` 截屏绑定，且在侧栏中提示未授权站点的 Origin，必须在 `permissions` 声明 `tabs`。但严禁在 `permissions` 中声明任何 Host！
- **可选权限 (`optional_host_permissions`)**：
  - 声明 `["http://*/*", "https://*/*"]`。仅在用户明确交互触发时按需动态申请单一 Origin。

### 8.2 游戏站点授权全生命周期流程

```
[用户在 Options 页面输入站点 URL 并点击添加]
         │
         ▼
[调用 normalizeOrigin(url)，提取规范 Origin]
         │
         ▼
[Options 页在点击处理函数中同步调用 chrome.permissions.request]
         │
         ▼
[向 Background 发送 SITES_ADD 消息]
         │
         ▼
[Background 用 permissions.contains 检查] ──(未获得授权)──► 返回 granted: false
         │ (已获得授权)                                                 保持站点在列表，标注未授权
         ▼
[Background 调用 scripting.registerReader(origin)]
 注册动态 Content Script (仅针对此 origin)
         │
         ▼
[将站点信息 { origin, granted: true, enabled: true } 存入 Settings]
         │
         ▼
[向已打开且符合权限的标签页 executeScript 注入 content/reader-loader.js]
         │
         ▼
[后续用户在 Options 点击移除站点]
         │
         ▼
[Background 调用 scripting.unregisterReader(origin)] 注销脚本
         │
         ▼
[检查若该 Origin 下无其余关联游戏] ──► 调用 permissions.removeOrigin(origin) 回收权限
```

### 8.3 AI 域名可选权限流程
当用户选定某一 AI 供应商时，Settings 模块计算其所需请求的匹配模式并申请可选权限：
- `openai_compatible`：基于用户输入的 `baseUrl` 计算。若为默认地址，则为 `https://api.openai.com/*`。
- `deepseek`：固定申请 `https://api.deepseek.com/*`。
- `gemini`：固定申请 `https://generativelanguage.googleapis.com/*`。

切换供应商或更新 Base URL 时，由设置页在用户点击处理函数中同步调用 `chrome.permissions.request({ origins: [...] })`，后台只用 `chrome.permissions.contains` 检查，确认后再行持久化。

---

## 9. 各模块详细行为

### 9.1 Settings 模块 (`core/settings.js` & `ui/options.*`)
- **纯函数工具**：
  - `normalizeOrigin(urlOrOrigin: string): string`：提取 `https://domain.com:port`。剔除 Hash、Search 与尾随斜杠。解析失败必须抛出中文异常 `new Error('无效的 URL 格式，请输入正确的网址')`。
  - `redactSecret(value: string): string`：脱敏处理。长度小于 8 的全部转为 `"****"`；长度 $\ge 8$ 的输出 `value.slice(0, 3) + '****' + value.slice(-4)`。
- **默认配置**：
  ```javascript
  export const DEFAULT_SETTINGS = {
    provider: 'openai_compatible',
    apiKey: '',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    gameSites: [],
    batchIntervalMs: 5000,
    screenshotMaxIntervalMs: 30000
  };
  ```
- **UI 行为约束**：
  - 打开 `ui/options.html` 时，API Key 输入框仅呈现脱敏掩码，占位符为 `已配置 (输入新密钥以覆盖)`。只有用户聚焦且重新输入时才接收明文。
  - 供应商为 `openai_compatible` 时，展开 `Base URL` 输入框；其余供应商时自动隐藏。
  - 选择 DeepSeek 时，UI 必须显式展示中文提示语：“当前 DeepSeek 通用模型不支持截图解谜分析，仅支持纯文本分析；若需识图请改选 OpenAI (如 gpt-4o) 或 Gemini 系列。”

### 9.2 Reader 模块 (`content/reader.js`)
- **环境安全**：此模块严禁接收、持有或查询 API Key。
- **文本抓取**：
  - `collectVisibleText(doc = document): string`：深度遍历 DOM 树，忽略 `<script>`、`<style>`、`<noscript>`、`<iframe>`、`svg`、以及样式为 `display: none`、`visibility: hidden` 的节点。跳过插件自身注入的 UI（带有 `data-sai-ext` 属性的整棵子树）以防倒计时文本污染。过滤大段固定的菜单与页脚，返回规范化（多空格折叠为单空格）的文本。
  - `computeDelta(prev: string, next: string): string`：计算纯新增字符增量。对比前先对数字与时间标记（如倒计时、时分秒）归一化，若仅时间或数字变化则判定无实质变动并返回空字符串 `""`；若 `next` 包含 `prev`，直接截取尾部差异；若页面整体翻新，通过分行差异匹配返回新增段落。无新增或仅计时器变动返回空字符串 `""`。
- **定时合并调度**：
  - `startReader(config)` 挂载 `MutationObserver` 监听 `document.body` 的 `childList` 与 `characterData` 变动。
  - 启动周期为 `batchIntervalMs`（默认 5000ms）的 `setInterval` 冲刷器。每次冲刷调用 `computeDelta`，仅当存在有意义非空增量时才发送 `READER_DELTA` 消息至后台，避免重复触发后台 AI 提取。
- **Canvas 视觉侦测**：
  - `shouldCaptureCanvas(doc = document): boolean`：遍历页面 `<canvas>`，若存在尺寸大于 `300x200` 或覆盖视口面积 30% 以上的活跃 Canvas，判定为画布游戏。
  - 仅在判定为画布游戏时，在页面右下角插入微型浮动按钮「发送截图解谜」（打上 `data-sai-ext="1"` 属性并带有倒计时冷却禁用态）；同时对主 Canvas 进行每 5 秒一次的微型采样（在离屏画布上绘制为 `16x16` 灰度并生成 Hash 校验和）。若连续两次采样哈希不一致且已度过 30 秒冷却，自动触发 `requestScreenshot('visual_change')`。

### 9.3 AI 模块 (`core/ai.js` & `core/providers/*`)
- **密钥断言防御**：
  - `assertNoSecretInText(text: string, apiKey: string): void`：若 `apiKey` 长度大于 5 且被发现包含在 `text`（包括 Prompt、消息体、生成的摘要中）的任何位置，立刻阻断并抛出 `new Error('严重安全违规：文本中侦测到 API Key 泄漏风险')`。
- **模型视觉能力规范**：
  - 供应商抽象中 `supportsVision(model: string): boolean`：
    - OpenAI：`gpt-4o`、`gpt-4o-mini`、`gpt-4-turbo` 返回 `true`；其他返回 `false`。
    - DeepSeek：当前所有默认模型一律返回 `false`。
    - Gemini：`gemini-1.5-pro`、`gemini-1.5-flash`、`gemini-2.0-flash` 返回 `true`。
  - 若调用包含 `image` 参数但 `supportsVision` 为 `false`，AI 模块必须主动中断并抛出中文异常：`new Error('当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）')`。
- **Prompt 组装规范**：
  - `buildExtractPrompt(delta: string, hasImage: boolean)`：
    - System: `"你是一位专业的解谜游戏助手。请从用户提供的网页游戏最新文本增量或画面中，提炼出具有解谜价值的关键线索、密码、物品、位置信息。必须以 JSON 数组格式输出，字段格式：[{\"text\":\"线索简述\",\"tags\":[\"标签\"]}]。若无新线索，返回空数组 []。不要输出任何 Markdown 代码围栏之外的多余解释。"`
  - `buildAnswerPrompt(question: string, clues: Clue[])`：
    - System: `"你是一位解谜智囊。以下是当前游戏已记录的所有已知线索。请根据这些客观事实回答玩家当前的疑问，并给出后续探索建议。输出必须包含三部分：1. 现状线索总结；2. 建议的下一步；3. 针对问题的具体解答。"`
- **供应商接口调用细节**：
  - 密钥必须置于 HTTP 请求头中（`Authorization: Bearer YOUR_API_KEY`，Gemini 原生协议置于 `x-goog-api-key: YOUR_API_KEY` 请求头）。严禁拼接入 Query URL。

### 9.4 Clues 模块 (`core/clues.js`)
- **键结构**：
  - `makeGameKey(origin: string, gameId?: string): string`：若无 `gameId`，直接返回 `origin`；若有，返回 `${origin}::${gameId}`。
  - `parseGameKey(gameKey: string)`：反向解析出 `origin` 与可选的 `gameId`。
- **去重算法**：
  - `dedupeKey(clue: { text: string }): string`：执行规范化——去除首尾空白字符、内部连续空白合并为单空格、英文字符全部转为小写。对规范化结果计算轻量哈希或直接作为键。
  - 在向存储写入 `addClues` 时，拉取当前游戏已有线索池，命中相同 `dedupeKey` 的线索直接剔除，仅入库并返回新增线索。
- **问答存储与归档**：
  - `addQa(gameKey, entry)` 与 `listQa(gameKey)`：记录并拉取 AI 问答历史（至少包含 question/answer/createdAt，可选 summary/suggestions/model/id）。空 question 或空 answer 不入库。
- **导出规格**：
  - `exportJSON(gameKey)`：导出标准 JSON 字符串，顶层包含元信息（导出时间戳、插件版本、游戏列表、线索详情与 qa 问答数组）。输出前必须进行深度遍历，若发现任何键名为 `apiKey`、`baseUrl` 的字段，强制抛出异常阻断导出。
  - `exportMarkdown(gameKey)`：生成包含 `# 游戏线索归档`、按时间线倒序排版、带标签徽章的清爽 Markdown 文档；若存在问答记录，在线索之后追加 `### 问答记录` 区域展示问答对。

### 9.5 Panel 模块 (`ui/panel.js`)
- **挂载抽象**：
  - 导出 `mountPanel(rootEl: HTMLElement, port: PanelPort)`：
    ```typescript
    export interface PanelPort {
      send: (message: ExtensionMessage) => Promise<ExtensionResponse>;
      onMessage: (listener: (msg: ExtensionMessage) => void) => () => void;
    }
    ```
  - 当作为 Chrome 扩展侧栏运行时，`panel.js` 在 `document.addEventListener('DOMContentLoaded')` 中自动创建包裹 `chrome.runtime.sendMessage` 与 `chrome.runtime.onMessage` 的 `port` 实例，完成自挂载。
- **界面行为**：
  - 初始化时发送 `ACTIVE_TAB_INFO` 与 `CLUES_LIST`，渲染线索时间线列表。
  - 监听 `CLUES_UPDATED` 广播，触发局部平滑刷新。
  - 用户提交问题时，输入框置为加载禁用态，展现 Loading 骨架屏；收到 `AI_RESULT` 响应后将「线索总结」、「建议下一步」、「解答」以卡片形式追加至问答历史。
  - 针对 Canvas 页面，面板顶部常驻快捷操作栏「即时抓取当前画面给 AI」。

### 9.6 Background 路由调度 (`background/service-worker.js`)
- **唯一中心枢纽职责**：
  - 作为唯一监听 `chrome.runtime.onMessage` 的后端服务。
  - 持有单例 `SettingsService`、`AiClient`、`ClueStore` 实例。
  - 在安装/启动（`reregisterGrantedReaders`）、新站点授权（`permissions.registerReader`）、侧栏初始化（`PANEL_READY`）三个时机，自动使用 `chrome.scripting.executeScript` 向已打开且已授权的标签页补注入 `content/reader-loader.js`。
- **双重截取节流器**：
  - 维护内存映射表 `screenshotThrottleMap: Map<string, number>`，键为 `${tabId}::${origin}`。
  - 无论 Content Script 何时触发，Background 校验当前时间戳与上次成功截图时间戳差值。若小于 30000ms，直接拦截并回复 `{ ok: false, skipped: 'throttled' }`。
  - 截屏动作调用 `chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 })`。执行前必须检查目标 Tab 的 Origin 是否在已授权列表中，未授权时静默丢弃。
- **自动流水线编排**：
  - 收到 `READER_DELTA` 消息后：
    1. 校验 Origin 授权；
    2. 提取当前配置调用 `aiClient.extractClues(delta)`；
    3. 提炼出新线索后，调用 `clueStore.addClues(gameKey, result.clues)`；
    4. 若有实际新增，广播 `CLUES_UPDATED` 通知 UI。

---

## 10. 编码约定

1. **模块与文件**：
   - 必须使用纯原生 ES Module（`import` / `export`），所有本地模块引用必须包含完整的 `.js` 扩展名。
   - 文件开头提供两行中文说明，简述本模块职责及作者。
2. **命名法则**：
   - 接口名、类名：大驼峰（`PascalCase`），如 `StorageAdapter`。
   - 变量、属性、函数名：小驼峰（`camelCase`），如 `computeDelta`。
   - 全局常量、消息 Type：全大写下划线（`UPPER_SNAKE_CASE`），如 `READER_DELTA`。
   - 存储键与 ID：带版本冒号分隔，如 `clues:v1:https://game.com`。
3. **格式与约束**：
   - 缩进严格采用 2 空格，句末使用分号，换行符统一为 LF。
   - 严禁引入任何第三方运行时包，依赖仅限浏览器原生 API 与 Node.js 内置核心模块。
4. **日志安全禁令**：
   - 绝对禁止使用 `console.log(settings)` 或直接输出任何含有密钥、请求头的对象。
   - 调试日志只能输出经 `redactSecret` 处理过的字段，如：`console.log('[Settings] Loaded, key:', redactSecret(settings.apiKey))`。
5. **异常与国际化**：
   - 所有面向用户的业务错误必须实例化为原生 `Error` 对象，错误信息使用中文，表意清晰，严禁抛出裸字符串。

---

## 11. 测试方案

整个系统基于 Node.js 原生能力构建轻量自动化测试套件，执行命令统一为 `npm test`，对应执行 `node tests/run.mjs`。

### 11.1 测试运行器规范 (`tests/run.mjs`)
- 零外部依赖，使用 Node.js 18+ 原生 `node:test` 或通过自定义异步加载执行 `tests/smoke.test.js`。
- 控制台以清晰的 `✔` 与 `✖` 格式展示用例运行状态，非零退出码阻断 CI 流程。

### 11.2 冒烟测试覆盖清单 (`tests/smoke.test.js`)
测试在无任何 `chrome.*` 全局对象的纯 Node 环境下运行，覆盖以下 5 个核心领域：

1. **Models 工具测试**：
   - `makeGameKey` 与 `parseGameKey` 对包含与不包含 `gameId` 的两种情形执行双向往返验证。
   - `normalizeOrigin` 正确解析带有路径、端口、Hash 的复合 URL 为纯 Origin，对非法格式抛出断言异常。
2. **Settings 逻辑测试**：
   - 注入 `createMemoryStorageAdapter`，调用 `saveSettings` 与 `getSettings` 校验完整存储流。
   - 校验 `getRedactedSettings` 输出，断言其包含 `apiKeyMasked` 且不包含未脱敏的 Key 明文。
   - 运行 `redactSecret` 验证短字符与长字符的脱敏表现。
3. **Clues 存储与去重测试**：
   - 注入内存存储，对同一 `gameKey` 连续添加 3 条线索，其中两条文本完全一致（仅空格与大小写差异）。
   - 断言返回的新增列表长度为 1，存储内实际保留总数为 1。
   - 验证 `listClues` 严格遵循 `createdAt` 时间升序排列。
   - 验证 `exportJSON` 与 `exportMarkdown` 的字符串输出结果，使用正则全局匹配断言绝对不含 `apiKey` 字样。
4. **Messages 格式测试**：
   - 校验 `core/messages.js` 中定义的常量完备性。
   - 断言响应构建器若收到带有明文密钥的错误文本，必须被自动拦截或替换。
5. **AI 逻辑与提供商测试**：
   - 验证 `assertNoSecretInText`：当传入包含真实 API Key 的文本时，必须准确抛出异常；安全文本正常通过。
   - 注入 `createMockHttpAdapter`，模拟 OpenAI 与 Gemini 标准 JSON 响应体，验证 `extractClues` 和 `answerQuestion` 数据解包与格式解析无误。
   - 验证当增量 `delta` 为空且 `image` 为 null 时，`extractClues` 直接返回空数组，**不得**调用 `http.request`。

---

## 12. 后续 Userscripts / iPad 复用说明

本架构设计已为后续移植至 iOS / iPad 平台（基于 Safari 扩展、Userscripts 脚本管理器或无扩展沙盒环境）做好底层隔离。后续移植遵循以下约束：

1. **核心逻辑层完全零修改**：
   - `core/models.js`、`core/settings.js`、`core/ai.js`、`core/clues.js` 及所有 `core/providers/*` 在移植时不得做任何代码变更，直接原样拷贝或以 Git Submodule 形式引入。
2. **适配层切换注入**：
   - **存储适配**：在 Userscripts 环境中，编写基于 `GM_getValue` / `GM_setValue` 的 `createGmStorageAdapter()`，无缝替换 `createChromeStorageAdapter()`。
   - **网络适配**：跨域请求受限时，使用 `GM_xmlhttpRequest` 封装为符合 `HttpAdapter` 规范的适配器注入 `createAiClient`。
3. **UI 浮层自适应挂载**：
   - `ui/panel.js` 的核心装配入口 `mountPanel(rootEl, port)` 保持不变。
   - 在 iPad Userscripts 中，创建 Shadow DOM 容器将其挂载为页面右下角的悬浮可折叠窗；通过自制的 `InMemoryEventPort` 实现页面脚本与浮动侧栏之间的事件分发，彻底替代 `chrome.runtime` 消息总线。
4. **功能降级策略**：
   - iPad 环境下若无法取得系统级 Tab 截图权限，系统通过关闭 `shouldCaptureCanvas` 的自动截图链路，降级为纯文本 DOM 增量提取，确保解谜整理核心链路依然可用。
