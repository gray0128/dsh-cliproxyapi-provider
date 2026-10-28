# 同类插件模型参数探测与自动调整机制调研

本文档梳理 DeepSeek Harness（DSH）、Pi（`pi-ai`）与 CLIProxyAPI 生态中 6 个核心模块如何探测模型目录、补全缺失元数据并在调用阶段自动调整请求参数。本文档面向维护 `@gray0128/dsh-cliproxyapi-provider` 的开发者，为后续插件改造提供事实依据与边界参考。

## 1. 调研范围与职责边界

本次调研覆盖以下 6 个真实运行模块与逆向样本：

| 模块名称 | 所属层级 | 核心职责 | 样本来源 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-llm` | DSH 宿主服务层 | 注册模型发现入口、校验调用控制项、执行多模态降级投影与上下文溢出判定 | `node_modules/@deepseek-ai/dsh-llm`（`0.2.1-rc.3`） |
| `@deepseek-ai/dsh-llm-pi-ai` | DSH 多供应商适配层 | 合并离线模型目录与自定义路由配置、解析端点模型列表、映射推理档位与协议兼容开关 | `node_modules/@deepseek-ai/dsh-llm-pi-ai`（`0.2.1-rc.3`） |
| `dsh-workbuddy-connect` / `pi-workbuddy-connect` | 第三方桌面端桥接插件 | 拉取动态配置目录、执行三阶段推理档位主动探测、清洗非标网关请求体 | 本地仓库 `dsh-workbuddy-connect`（`0.7.9`）、`pi-workbuddy-connect`（`0.1.0`） |
| `@mars-sea/dsh-commandcode-provider` | 第三方网关直连插件 | 结合离线 `models.dev` 上限表与运行时错误响应自学习单轮输出上限、支持按模型覆盖窗口 | 本地已安装包 `@mars-sea/dsh-commandcode-provider` |
| `dsh-opencode-go` | 第三方订阅网关插件 | 融合网关实时模型 ID 列表与 `models.dev` 在线能力元数据、区分三类推理控制模式 | 本地已安装包 `dsh-opencode-go` |
| `CLIProxyAPI` 与 `@gray0128/dsh-cliproxyapi-provider` | 代理服务端与当前插件 | 暴露标准 `/v1/models` 与 Codex 专有目录、将探测到的模型同步写入 `llm-pi-ai` 配置 | `CLIProxyAPI`（`7.2.132` 二进制内嵌数据）与当前仓库（`0.0.3`） |

## 2. 系统如何工作

### 2.1 宿主与适配层基座（`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-llm-pi-ai`）

宿主服务 `@deepseek-ai/dsh-llm` 通过 `registerModelDiscovery(settingsNs, discover)` 暴露按命名空间隔离的探测注册点，并通过 `prepareCall(config, signal, configure?)` 在每次请求发出前完成参数固定与校验（参见 [`node_modules/@deepseek-ai/dsh-llm/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm/lib/index.js#L1977-L2261)）。

1. **多源端点探测与流式限额**：`@deepseek-ai/dsh-llm-pi-ai` 的 `discoverModels` 优先返回本地已安装目录（`catalogModels(provider)`）中的模型及 `inputModalities`，不发起网络请求。对于未内置目录的路由，`openai-completions` 与 `openai-responses` 请求 `GET {baseURL}/models`，`anthropic-messages` 请求 `GET {root}/v1/models?limit=1000`。响应读取函数 `readBounded` 先检查 `Content-Length` 响应头，再在流式分片累加阶段执行 4 MiB（`4,194,304` 字节）上限检查（参见 [`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2255-L2436)）。
2. **多字段模糊提取与四级回退**：`readListing` 同时支持标准 `data` 数组与富信息 `models` 对象映射。在构造运行时模型实例时，`resolveEntry` 按「模型显式配置（`entry`）→ 已安装目录基础值（`base`）→ 路由级默认值（`defaultContextWindow` / `defaultMaxTokens`）→ 全局默认值（`262,144` / `32,768`）」四级顺序确定容量参数（参见 [`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L683-L712)）。

| 归一化目标字段 | `readListing` 探查的候选源字段（按优先级排序） | 路由级回退默认值 |
| --- | --- | --- |
| `id` | 映射表属性键 `key`、`entry.id` | 无（缺失时跳过该行） |
| `name` | `entry.name`、`entry.display_name`、`entry.displayName` | 回退为已采纳的 `id` |
| `contextWindow` | `entry.contextWindow`、`entry.context_window`、`entry.context_length`、`entry.max_input_tokens`、`entry.limit.context` | `262144` |
| `maxTokens` | `entry.maxOutputTokens`、`entry.max_output_tokens`、`entry.maxTokens`、`entry.max_tokens`、`entry.limit.output`、`entry.top_provider.max_completion_tokens` | `32768` |

3. **推理档位显式映射**：`resolveModelReasoning` 将模型声明的 `reasoningEfforts` 转换为 `pi-ai` 的 `thinkingLevelMap`。由于 `pi-ai` 底层对缺省键的处理不对称（基础 5 档缺省视为支持，`xhigh` 与 `max` 缺省视为不支持），适配器将 7 个规范等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）中所有未声明的等级显式设为 `null`；唯独声明了无值 `off` 时省略该键，使请求在关闭思考时不发送推理字段（参见 [`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L585-L608)）。
4. **调用前控制项自动填补与消息投影**：
   - **默认上限与默认推理强度补齐**：`resolveCallWithInfo` 在请求未指定 `maxTokens` 时自动填入模型的 `defaultMaxTokens`；在请求未指定 `reasoningEffort` 时自动填入模型的 `reasoning.defaultEffort`（参见 [`node_modules/@deepseek-ai/dsh-llm/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2182-L2207)）。
   - **多模态与文件自动降级投影**：`streamWithRegistration` 在分发请求前检查 `modelInfo.inputModalities`。若模型不支持 `image` 且消息中包含图片块，系统自动调用 `projectImagesForTextModel` 将图片替换为文本说明；若消息包含文件引用，自动调用 `projectFilesToText` 展开为文本（参见 [`node_modules/@deepseek-ai/dsh-llm/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2335-L2348)）。
   - **上下文溢出统一归因**：`toStreamChunks` 将流结束时的 Token 用量与模型的 `contextWindow` 比对，触发溢出或零输出 `length` 截断时统一映射为 `CONTEXT_WINDOW_EXCEEDED` 错误码，供上层会话循环触发自动压缩（参见 [`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1470-L1472)）。

### 2.2 动态配置拉取与三阶段推理探测（`dsh-workbuddy-connect` 与 `pi-workbuddy-connect`）

WorkBuddy 系列插件面对的是非标准私有网关，上游部分模型在目录中声明了 `supportedEfforts`，另一部分模型未声明可选档位但实际支持推理参数。

1. **三层目录回退与按客户端分流**：插件启动时请求网关 `/v3/config`，国内版使用 CLI User-Agent，国际版使用 `WorkBuddyAI/<version>` User-Agent，提取 `cli` 智能体可用模型列表并与完整模型表取交集。在线拉取失败时，按「当前账号本地缓存目录（`.workbuddy-catalog.json`）→ 内置静态快照（`FALLBACK_WORKBUDDY_MODELS`）」顺序回退（参见 `dsh-workbuddy-connect/src/catalog.ts`）。
2. **三阶段推理档位主动探测（`probeModel`）**：针对声明了 `reasoning.supports: true` 但未提供 `supportedEfforts` 的模型，插件在用户手动授权后通过串行队列发送 `max_tokens: 1` 的最小探测请求，严格按以下 3 个阶段执行（参见 `dsh-workbuddy-connect/src/probe.ts`）：
   - **阶段 1（Baseline）**：不携带 `reasoning_effort` 发送请求。若未返回 HTTP 200 流式响应，判定为 `unknown` 并中止，确保后续 400 错误可归因于推理参数而非凭据或网络故障。
   - **阶段 2（Sentinel）**：携带随机生成的不可碰撞哨兵值 `probe_sentinel_<24位hex>` 发送请求。若上游返回 HTTP 200，说明上游忽略或宽松强转未知参数，直接判定为 `non-validating` 并停止扫描，避免后续逐档测试产生全部假阳性结果。仅当上游返回 HTTP 400 且错误码命中区域拒绝集合（`invalid_reasoning_effort`、`model_param_invalid` 或 `invalid_parameter_value`）时，才确认上游具备参数校验能力并进入阶段 3。
   - **阶段 3（Levels）**：依次测试 `['low', 'medium', 'high', 'xhigh', 'max']`。为避免短窗口限流导致误判，不同探测请求之间固定间隔 `1,500 ms`；遇到 HTTP 429 时按 `[4000, 8000, 16000] ms` 退避重试，整轮扫描受 `180,000 ms` 总墙钟预算约束。探测结果绑定模型指纹（对 `id`、`reasoning`、`supportsImages` 计算 SHA-256 前 16 位）与账号标识，以原子文件替换方式保存在本地，有效期 14 天（参见 `dsh-workbuddy-connect/src/probe-store.ts`）。
3. **多档上下文窗口切换与请求体修正**：国际版模型（如 `gpt-6-astra`、`deepseek-v4.1-flash`）同时提供 `defaultContextWindow`（如 `400,000`）与 `supportedContextWindows`（如 `[400000, 1000000]`）。`WorkBuddyCatalog` 提供 `useMaximumContextWindow` 开关，开启时将 `contextWindow` 提升为数组最大值（参见 `dsh-workbuddy-connect/src/catalog.ts`）。在请求发出前，`normalizeChatBody` 强制写入 `stream: true`，将网关拒绝的 `role: "developer"` 改写为 `role: "system"`，并删除会导致 HTTP 400（错误码 `11133`）的 `reasoning_effort: "off"` 字段（参见 `pi-workbuddy-connect/src/payload.ts`）。

### 2.3 外部元数据同步与运行时错误自学习（`@mars-sea/dsh-commandcode-provider`）

Command Code 的 `/provider/v1/models` 端点仅公布 `context_length` 与 `supported_endpoints`，不公布单轮最大输出上限 `max_output_tokens`，但网关在请求 `max_tokens` 超过模型真实上限时会直接拒绝请求。

1. **构建期同步与多源最小值推导**：插件在构建期通过脚本从 `models.dev` 同步各模型的厂商输出上限表 `MODEL_OUTPUT_TOKEN_LIMITS`。运行时对每个模型按以下公式计算有效输出上限（参见 `@mars-sea/dsh-commandcode-provider/lib/index.js` 第 6292 至 6294 行）：
   ```text
   effectiveMaxTokens = Math.min(
     effectiveContextWindow,
     publishedMaxTokens ?? fallbackLimit(modelId),
     learnedOutputLimit(apiBase, modelId)
   )
   ```
2. **从网关拒绝错误中自学习输出上限（`outputCeilingRefusal`）**：当流式调用尚未产出任何内容分片且因 `max_tokens` 超限失败时，`parseOutputCeiling` 使用正则表达式 `/max_tokens:\s*\d+\s*>\s*(\d+)/i` 从上游错误详情（例如 `max_tokens: 131072 > 128000`）中提取服务端声明的真实上限 `128000`。若提取出的数值为正整数且小于本次实际发送的预算，插件将该数值记入进程内按 `apiBase` 与 `model` 索引的 `learned` 映射表，并在当前调用内立即收紧 `budget.max` 自动重试一次；后续所有调用与目录刷新均自动受该学习值约束（参见 `@mars-sea/dsh-commandcode-provider/lib/index.js` 第 4531 至 4536 行、第 6296 至 6305 行、第 8611 至 8624 行）。
3. **用户覆盖与省略 `max_tokens` 哨兵**：支持全局 `contextWindow` 与按模型 `contextWindowOverrides` 覆盖目录窗口。支持 `maxOutputTokens` 配置，当用户设为 `0` 时，`omitOutputTokens` 在 CLI 与 OpenAI 协议下不发送 `max_tokens` 字段以解除被动截断；但在以下两种场景强制保留该字段：一是 Anthropic Messages 协议（服务端强制要求 `max_tokens` 必填），二是宿主显式传入了单次调用上限（如会话标题生成固定请求 `64` tokens）。

### 2.4 双源目录融合与三态推理控制（`dsh-opencode-go`）

OpenCode Go 网关的 `/models` 列表仅提供可用模型 ID，缺少完整的协议、容量与思考参数定义。

1. **网关成员资格 + 在线 `models.dev` 元数据融合**：`OpencodeGoCatalog` 将模型发现拆为两个数据源：网关 `/models` 接口决定「当前有哪些模型 ID 可用」，`https://models.dev/api.json` 决定「每个模型如何调用及具备哪些能力」。拉取 `models.dev` 时携带 `If-None-Match`（ETag）请求头，HTTP 304 时直接复用内存与本地磁盘缓存（`~/.dsh/cache/dsh-opencode-go/models.dev.api.json`），冷启动时先加载磁盘缓存同时在后台发起共享刷新（参见 `dsh-opencode-go/lib/index.js` 第 6539 至 6631 行）。
2. **三类推理控制形态识别**：在 `readModelMetadata` 中，插件根据模型协议与元数据将 `reasoningControl` 归纳为 3 类（参见 `dsh-opencode-go/lib/index.js` 第 6153 至 6159 行）：
   - `effort`：模型提供离散档位（如 `low`、`medium`、`high`）。
   - `budget`：模型支持数值型 Token 预算（如 Claude Messages 或支持 `thinkingTokenBudgetField` 的协议），自动设置 `reasoningBudget: { min: Math.max(api === 'anthropic-messages' ? 1024 : 1, budget.min), max: budget.max }`。
   - `toggle`：模型无离散档位但支持原生思考开关，仅暴露 `On / Off`。

### 2.5 CLIProxyAPI 服务端双目录契约与当前插件现状

通过对本机安装的 `CLIProxyAPI 7.2.132` 二进制内嵌数据及 `@gray0128/dsh-cliproxyapi-provider`（`0.0.3`）源码进行比对，确认 CLIProxyAPI 服务端存在两套结构完全不同的模型目录返回契约：

#### 契约 A：Codex 专有目录（`GET {baseURL}/models?client_version=...`）

当请求携带 `client_version` 查询参数时，CLIProxyAPI 返回 Codex 风格对象 `{ "models": [...] }`。二进制内嵌的 Codex 目录共包含 8 个模板模型，核心字段如下：

```json
{
  "models": [
    {
      "slug": "gpt-5.6-sol",
      "display_name": "GPT-5.6-Sol",
      "description": "Latest frontier agentic coding model.",
      "context_window": 372000,
      "max_context_window": 372000,
      "input_modalities": ["text", "image"],
      "default_reasoning_level": "low",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
        { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" },
        { "effort": "ultra", "description": "Maximum reasoning with automatic task delegation" }
      ],
      "visibility": "list"
    }
  ]
}
```

#### 契约 B：标准 OpenAI 兼容目录（`GET {baseURL}/models`，不带 `client_version`）

当请求不携带 `client_version` 时，CLIProxyAPI 返回标准列表 `{ "object": "list", "data": [...] }`。二进制内嵌注册表覆盖 12 个渠道分类（`claude`、`gemini`、`vertex`、`gemini-cli`、`aistudio`、`codex-free`、`codex-team`、`codex-plus`、`codex-pro`、`kimi`、`antigravity`、`xai`，共 126 条模型定义），各渠道字段存在明显异构性：

| 渠道分类 | 上下文窗口字段 | 最大输出上限字段 | 输入模态字段 | 思考/推理能力字段 |
| --- | --- | --- | --- | --- |
| `claude` / `codex-*` / `kimi` / `antigravity` / `xai` | `context_length`（如 `200000`、`1000000`） | `max_completion_tokens`（如 `64000`、`128000`） | `supportedInputModalities`（如 `["text", "image"]`） | `thinking: { min, max, zero_allowed, dynamic_allowed, levels }` |
| `gemini` / `vertex` / `gemini-cli` / `aistudio` | `inputTokenLimit`（如 `1048576`） | `outputTokenLimit`（如 `65536`） | `supportedInputModalities`（如 `["text", "image", "audio", "video"]`） | `thinking: { min, max, zero_allowed, dynamic_allowed, levels }` |

#### 当前插件（`@gray0128/dsh-cliproxyapi-provider`）的已有实现与现存缺陷

当前插件通过单一目录所有者模式将探测到的模型写入 `llm-pi-ai` 的 `providers.CLIProxyAPI` 条目，并通过内存暂存池 `rememberDiscovery` 与临时请求头 `x-dsh-provider-cpa-sync: rich:<token>` 恢复被浏览器端通用 RPC 剥离的 `input` 和 `reasoningEfforts` 字段（参见 [`src/index.js`](../src/index.js#L268-L337)、[`client.js`](../client.js#L203-L293)）。但对照 CLIProxyAPI 真实服务端契约与同类插件实践，当前实现存在以下 5 项缺陷：

1. **单轮最大输出上限（`maxTokens`）在 Codex 端点下全部丢失**：Codex 目录（契约 A）不包含 `max_output_tokens`、`max_completion_tokens` 或 `outputTokenLimit`。当前插件仅请求 `?client_version=dsh-cliproxyapi-provider`，导致 [`src/catalog.js`](../src/catalog.js#L61) 中的 `positiveInteger(entry?.max_output_tokens, entry?.max_completion_tokens, entry?.max_tokens, options.defaultMaxTokens)` 永远命中回退值 `32768`。真实支持 `128,000` 输出的 `gpt-5.6-sol`、`claude-opus-4-6` 与支持 `64,000`、`65,536` 输出的 Claude、Gemini 模型全部被截断为 `32,768`。
2. **不支持标准 `/v1/models` 契约 B 的响应结构与字段名**：[`readCodexCatalog`](../src/catalog.js#L67-L79) 强制要求顶层包含 `body.models` 数组，不接受顶层 `{ data: [...] }`，且未识别契约 B 中的 `context_length`、`inputTokenLimit`、`outputTokenLimit`、`supportedInputModalities` 与 `thinking` 对象。
3. **`max` 与 `ultra` 档位映射冲突及 `thinking` 对象漏读**：在 [`src/catalog.js`](../src/catalog.js#L17-L37) 中，`normalizeReasoningLevel('ultra')` 将 `'ultra'` 映射为 `canonical: 'max'`，而 `reasoningEffortsOf` 使用 `!(normalized.canonical in efforts)` 跳过已存在的键。当模型（如 `gpt-5.6-sol`）同时声明 `max` 与 `ultra` 时，排在后面的 `ultra` 被丢弃；同时未读取契约 B 中的 `thinking.levels` 与 `thinking.zero_allowed`。
4. **同步覆盖抹除用户按模型自定义的参数**：[`profileOf`](../src/index.js#L216-L245) 在每次同步时解构丢弃 `_previousModelOverrides` 并整体替换 `models` 数组，既不支持在插件配置中按模型覆盖 `contextWindow`、`maxTokens`、显隐状态，也不保留用户在 `llm-pi-ai` 条目上已有的单模型修正。
5. **前端引导阶段丢失已探测的 `input` 与 `reasoningEfforts`**：[`client.js`](../client.js#L203-L223) 的 `bootstrapProfileOf` 在构造初始 Profile 时仅写入 `id`、`name`、`contextWindow`、`maxTokens`，强行丢弃了 `api.llm.discoverModels` 已经返回的 `input` 和 `reasoningEfforts`；若后端首次同步时尚未命中 60 秒内存缓存（例如多实例或超时后触发），则需要额外重发一次网络请求。

## 3. 治理规则与不变量

综合上述同类插件的设计约束与宿主校验逻辑，模型参数探测与自动调整必须遵守以下可验证不变量：

1. **单一目录所有权不变量**：通过 `llm-pi-ai` 路由模型的供应商插件 `禁止` 调用 `ctx.llm.registerConfigurableProviders()` 注册同名供应商目录。违反该规则会导致宿主抛出重复供应商冲突或争夺 Models 设置页所有权（验证基准：[`test/index.test.js`](../test/index.test.js#L56-L58) 与 [`test/index.test.js`](../test/index.test.js#L427-L490)）。
2. **推理映射非空且有效不变量**：写入 `llm-pi-ai` 的模型条目中，`reasoningEfforts` 对象 `不得` 为空字典，且 `不得` 仅包含 `off` 单个键。违反该规则会导致 `@deepseek-ai/dsh-llm-pi-ai` 的 Schema 校验或 `resolveModelReasoning` 直接拒绝整个供应商配置并抛出 `llm-pi-ai rejected the generated provider profile`（参见 [`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L589-L598)）。
3. **响应字节上限不变量**：任何向用户配置端点发起的模型列表读取操作 `MUST` 在 `Content-Length` 预检与流式分片读取两处强制执行 `4,194,304` 字节（4 MiB）上限。超过上限时必须立即取消读取流并抛出错误，防止异常网关耗尽宿主进程内存（参见 [`src/index.js`](../src/index.js#L121-L149)）。
4. **无密钥占位鉴权不变量**：当 `DSH_CLIPROXY_API_KEY` 未配置时，写入 `llm-pi-ai` 的 Profile `MUST` 省略 `apiKeyEnv` 字段，并在 `headers.authorization` 中写入非敏感占位值 `Bearer dsh-cliproxyapi-no-key`；而在向 CLIProxyAPI 发起 `/models` 目录探测时 `MUST` 剥离该占位头。违反该规则会导致无鉴权网关下的对话请求因缺少凭据在 `pi-ai` 层以 `MISSING_CREDENTIAL` 失败，或导致开启了可选鉴权校验的目录端点返回 401（参见 [`src/index.js`](../src/index.js#L73-L94)）。
5. **配置变更幂等写入不变量**：后台定时刷新与事件触发同步在生成的 `next` Profile 与当前已存储 `profile` 深度相等（`deepEqualJson(next, profile) === true`）时 `禁止` 调用 `ctx.settings.mutate`。违反该规则会触发 `settings/document-updated` 事件循环并导致宿主反复重建 `pi-ai` 模型快照（参见 [`src/index.js`](../src/index.js#L328-L335)）。

## 4. 横向机制对比汇总

| 能力维度 | `dsh-llm` / `dsh-llm-pi-ai` | `dsh-workbuddy-connect` | `dsh-commandcode-provider` | `dsh-opencode-go` | `dsh-cliproxyapi-provider`（现状） |
| --- | --- | --- | --- | --- | --- |
| **模型列表来源** | 内置静态目录或单次 `GET /models` | 网关 `/v3/config` + 本地缓存 + 内置静态表 | 网关 `/provider/v1/models` + 本地磁盘缓存 | 网关 `/models`（ID）+ 在线 `models.dev`（能力） | 仅 `GET /models?client_version=...` |
| **上下文窗口探测** | 识别 5 种常见字段名，四级回退 | 读取上游窗口，支持在默认窗口与最大窗口间切换 | 读取 `context_length`，支持全局与按模型覆盖 | 读取 `models.dev` 容量，支持 `modelLimits` 覆盖 | 仅识别 `max_context_window`、`context_window` |
| **最大输出上限推导** | 识别 6 种常见字段名，回退 `32768` | 直接使用上游配置值 | `min(窗口, 公布值 ?? models.dev 表, 运行时报错学习值)` | 读取 `models.dev` 容量，支持 `modelLimits` 覆盖 | Codex 目录无此字段，全部退化为 `32768` |
| **推理能力探测与调整** | 7 档规范等级显式映射至 `thinkingLevelMap` | 已声明档位直出；未声明模型经用户授权执行三阶段探测 | 内置已知模型档位表，会话标题生成强制切 `off` | 自动区分 `effort`、`budget`、`toggle` 三种模式 | 解析 `supported_reasoning_levels`，`max`/`ultra` 存在冲突 |
| **输入模态适配** | 探测 `text`/`image`，纯文本模型自动将图片投影为文字 | 按 `supportsImages` 声明，动态修正旧版附件像素预算 | 内置视觉模型集合，支持历史已读图片自动卸载以保缓存 | 按 `models.dev` 归一 5 类模态，超限卸载最旧图片 | 解析 `input_modalities` 中的 `text`/`image` |
| **刷新与容错机制** | 仅在用户在设置页点击发现时单次请求 | 启动同步 + 手动刷新，失败回退磁盘缓存与内置表 | 5 分钟缓存 TTL + 10 秒失败重试 + 3 次瞬态错误吸收 | 默认 60 分钟 TTL + ETag 304 协商 + 磁盘持久化缓存 | 5 分钟定时轮询 + 指数退避（3s 至 60s） |
