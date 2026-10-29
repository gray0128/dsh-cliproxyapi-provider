# CLIProxyAPI 模型参数查询与自动纠正方案

> 适用对象：CBC Web UI 的 CLIProxyAPI 模型目录模组  
> 目标：把“代理目录返回什么就显示什么”改为“可验证、可校准、可追溯、可覆盖”的参数处理链路。

## 1. 目标与边界

### 1.1 要解决的问题

- CLIProxyAPI 的 `/models` 会返回占位或合成参数，例如固定 `500000`/`872000` 上下文、Codex 风格的 5/6 档推理模板。
- 代理路由 ID 与公共模型库 ID 不一致，例如 `cn/deepseek-v4.1-flash` 对应 OpenRouter 的 `deepseek/deepseek-v4.1-flash-1017`。
- 同一个模型可能同时出现在 Codex 风格和标准 OpenAI 风格两个端点，字段完整度不同。
- 用户需要知道某个值是代理声明、公共元数据校准，还是本地默认值。

### 1.2 不做什么

- 不注册 LLM 供应商，不修改 CBC 原生模型选择器。
- 不把 CLIProxyAPI 的模型注入当前对话；原生选择由宿主 `models.json` 负责。
- 不把 API Key 返回给面板、工具或日志。
- 不修改代理服务端数据；所有校正是本地展示层的派生结果。

## 2. 问题复盘

| 现象 | 根因 | 处理 |
|---|---|---|
| `cn/deepseek-v4.1-flash` 上下文显示 `500000` | 代理返回固定模板；旧逻辑只在字段缺失时校准 | 识别 `500K/872K` 占位上下文，允许公共元数据覆盖 |
| 最大输出显示 `384000` | 模型 ID 未匹配到 OpenRouter；落到了本地默认值 | 建立别名/尾段索引，匹配到 `393216` |
| 推理档位 `low/medium/high/xhigh/max` | 代理下发了 Codex 模板 | 识别模板，改用 OpenRouter `supported_efforts`：`none/low/high/max` |
| “来源”下方显示 `Codex / OpenAI` | UI 标签写错，实际值是模型 ID | 标签改为“模型 ID”；来源仍正确显示“合并” |
| 查询参数时模型 ID 对不上 | 旧查找只做完整 ID 和精确尾段 | 增加 canonical slug、HF ID、去日期尾段、前后缀匹配 |

## 3. 设计原则

1. **区分“声明值”和“推断值”**：代理声明的非占位值优先；只有缺失或疑似占位时才允许校准。
2. **可追溯**：每个被校准的模型记录 `calibratedFrom`；未解决的模板值标记 `placeholder`。
3. **用户覆盖最高**：逐模型覆盖优先于任何自动结果。
4. **失败降级**：单个端点或元数据源失败不影响另一个；两个端点都失败时保留旧目录。
5. **确定性**：固定的源顺序、固定的档位顺序、稳定的排序。
6. **密钥不落地到展示层**：Key 只存在于宿主存储和请求头。

## 4. 总体数据流

```text
CLIProxyAPI /models?client_version=...  ─┐
CLIProxyAPI /models                     ─┼─> 归一化 ─> 按 ID 合并 ─> 占位检测
OpenRouter /api/v1/models               ─┤                              │
LiteLLM model_prices_and_context_window ─┘─> 元数据索引 ─> 查找/匹配 ─> 只补缺失或占位字段
                                                                       │
                                                          用户覆盖 ─> 隐藏规则 ─> 默认值
                                                                       │
                                                          面板 / 工具 / models.json 片段
```

## 5. 目录发现与归一化

### 5.1 双端点

- Codex 风格：`GET {base}/models?client_version=cbc-cliproxyapi-provider`
- 标准风格：`GET {base}/models`
- 两个端点并行请求，各自独立超时，互不阻塞。
- 有 Key 时发送 `Authorization: Bearer <key>`；无 Key 时不伪造鉴权头。
- 响应优先取 `models` 数组，其次 `data` 数组；数组本身也兼容。

### 5.2 归一化字段

| 内部字段 | 来源示例 | 说明 |
|---|---|---|
| `id` | `id`/`slug`/`model`/`name` | 代理路由 ID，保留原始大小写 |
| `name` | `display_name`/`displayName`/`name` | 展示名，缺省回退 `id` |
| `contextWindow` | `context_window`/`context_length`/`limit.context` | 上下文窗口 |
| `maxTokens` | `max_output_tokens`/`max_completion_tokens`/`top_provider.max_completion_tokens` | 最大输出 |
| `input` | `input_modalities`/`architecture.input_modalities`/`supports_vision` | 输入模态，统一为 `text/image/audio/video` |
| `reasoningEfforts` | `supported_reasoning_levels`/`reasoning_efforts`/`thinking.levels` | 推理档位 |
| `reasoning` | 档位存在或 `supports_reasoning` | 是否支持推理 |
| `source` | `codex`/`standard` | 两个端点都返回时合并为 `both` |

### 5.3 合并规则

- 以 `id` 为唯一键。
- 先到字段优先；后到只补 `null`。
- `source` 不同则标记 `both`。
- 名称相同时保留更可读的 display name。

## 6. 参数可信度分级

| 级别 | 含义 | 典型来源 |
|---|---|---|
| `declared` | 代理声明的非占位值 | `/models` 原始字段 |
| `placeholder` | 命中了已知模板/合成规则 | `500K/872K`、`max == context`、Codex 档位集合 |
| `calibrated` | 被公共元数据补全或覆盖 | OpenRouter / LiteLLM |
| `default` | 仍然缺失时使用本地默认值 | 设置页默认上下文/最大输出 |
| `override` | 用户在本地逐模型覆盖 | 面板“覆盖”编辑器 |

优先级：

```text
用户覆盖
  > 代理声明的非占位值
  > 元数据源（按配置顺序）
  > 本地默认值
```

例外：

- 占位上下文如果元数据也没有匹配，保留代理值并标记 `placeholder`，不盲目套默认值。
- 占位最大输出如果元数据没有匹配，丢弃代理值，改用默认最大输出。
- 未解决的 Codex 档位模板会被清空，显示“未提供”，而不是继续展示假档位。

## 7. 占位/合成值识别

### 7.1 上下文占位

```text
contextWindow == 500000 或 872000
```

这两个值在 CLIProxyAPI 中常作为固定兜底模板出现，不视为可靠声明。

### 7.2 最大输出占位

```text
maxTokens == contextWindow
或 abs(maxTokens - round(contextWindow * 0.9)) <= 1
```

典型合成值：最大输出等于上下文，或等于上下文的 90%。

### 7.3 推理档位模板

命中以下集合之一，且模型 ID 不像 GPT-5/Codex 系列：

```text
low, medium, high, xhigh, max
minimal, low, medium, high, xhigh, max
low, medium, high, xhigh, ultra
low, medium, high, xhigh, max, ultra
```

不标记的情况：

- `gemini-*` 的 `minimal/low/medium/high` 是真实档位。
- `grok-4.6/4.7` 的 `low/medium/high/xhigh` 是真实档位。
- ID 含 `codex`、`gpt-5`、`gpt-6`、`o3`、`o4`、`o5` 的模型保留模板。

> 注意：`gpt-oss` 不匹配上述 GPT-5/Codex 例外，因此它的 5 档模板会被识别并交给元数据修正。

## 8. 元数据索引与模型 ID 对齐

### 8.1 数据源

| 源 | 地址 | 关键字段 |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1/models` | `context_length`、`top_provider.max_completion_tokens`、`architecture.input_modalities`、`reasoning.supported_efforts`、`supported_parameters` |
| LiteLLM | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | `max_input_tokens`、`max_tokens`、`max_output_tokens`、`supports_vision`、`supports_reasoning`、`supported_reasoning_levels` |

源顺序由配置 `metadataSources` 决定；默认建议 `["openrouter", "litellm"]`。

### 8.2 索引键

每个元数据条目建立以下键：

- 完整 ID
- `canonical_slug`
- `hugging_face_id`
- 最后一段尾 ID
- 去掉日期后缀的尾 ID

统一规范化：小写、`.`/`_`/空白转为 `-`、折叠连续 `-`、去首尾 `-`。不替换 `/`，以保留供应商路径。

日期后缀规则：

```text
-YYYYMMDD（8 位，19/20 开头）
-####（3 或 4 位）
```

例如：

```text
deepseek/deepseek-v4.1-flash-1017
  -> tail: deepseek-v4-1-flash-1017
  -> date-stripped: deepseek-v4-1-flash
```

### 8.3 查找顺序

```text
1. 完整 ID
2. 尾 ID
3. 去日期尾 ID
4. 前缀/后缀模糊匹配：
   key startsWith tail + "-"
   或 tail startsWith key + "-"
   取长度差最小的候选
```

示例：

```text
模型：cn/deepseek-v4.1-flash
尾 ID：deepseek-v4-1-flash
命中：deepseek/deepseek-v4.1-flash-1017
结果：context=1048576, max=393216,
      efforts=none/low/high/max, source=openrouter
```

### 8.4 合并策略

- OpenRouter 行按 `created` 倒序处理，新快照优先。
- 同一索引键的多个条目合并缺失字段，不覆盖已有非空值。
- 找到元数据但没有任何字段需要补全时，仍计入 `matched`，但不写 `calibratedFrom`。

## 9. 自动纠正决策表

| 字段 | 原始状态 | 元数据可用 | 处理 | 标记 |
|---|---|---|---|---|
| `contextWindow` | 缺失 | 有 | 用元数据 | `calibratedFrom` |
| `contextWindow` | 占位 | 有 | 用元数据覆盖 | `calibratedFrom` |
| `contextWindow` | 占位 | 无 | 保留代理值 | `contextPlaceholder=true` |
| `contextWindow` | 非占位 | 任意 | 保留代理值 | 无 |
| `maxTokens` | 缺失 | 有 | 用元数据 | `calibratedFrom` |
| `maxTokens` | 占位 | 有 | 用元数据覆盖 | `calibratedFrom` |
| `maxTokens` | 占位 | 无 | 丢弃，改用默认最大输出 | 清除 `maxPlaceholder` |
| `maxTokens` | 非占位 | 任意 | 保留；未显式覆盖时约束 `<= context` | 无 |
| `input` | 缺失 | 有 | 用元数据 | `calibratedFrom` |
| `input` | 已声明 | 任意 | 保留 | 无 |
| `reasoningEfforts` | 缺失 | 有档位 | 用元数据档位 | `calibratedFrom` |
| `reasoningEfforts` | Codex 模板 | 有档位 | 用元数据档位 | `calibratedFrom` |
| `reasoningEfforts` | Codex 模板 | 仅知支持推理 | 清空档位，显示“未提供” | `reasoningUnknown=true` |
| `reasoningEfforts` | Codex 模板 | 明确不支持推理 | 标记非推理 | `nonReasoning=true` |
| `reasoningEfforts` | 非模板 | 任意 | 保留 | 无 |

## 10. 推理档位处理

### 10.1 解析

接受：

- 字符串数组
- 对象数组：`{ effort }` / `{ name }` / `{ id }` / `{ value }` / `{ level }`
- OpenRouter：`reasoning.supported_efforts`

去重、最多 12 个、统一小写。

### 10.2 排序

```text
none < minimal < low < medium < high < xhigh < max < ultra
```

未知档位排在已知档位之后。

### 10.3 冲突规则

- 同时出现 `max` 和 `ultra` 时，保留 `max`，移除 `ultra`。
- 档位模板未解决时，不展示假档位；显示“未提供”。
- 元数据明确 `reasoning: false` 时，显示“非推理”。

## 11. 用户覆盖与隐藏

### 11.1 覆盖

可覆盖：

- 显示名称
- 上下文窗口
- 最大输出
- 输入模态（文本/图片）
- 推理档位，或“非推理”

规则：

- 覆盖优先于任何自动校准。
- 覆盖某字段后，清除该字段对应的 `placeholder` 标记。
- 显式覆盖 `maxTokens` 时不再自动约束 `max <= context`；建议后续增加“超过上下文”的警告或软约束。

### 11.2 隐藏

- 每行一个模型 ID，支持 `*` 通配符，大小写不敏感，最多 64 条。
- 隐藏只影响面板列表，不删除目录数据。
- 隐藏模型仍可供工具查询（`includeHidden`）。

## 12. 默认值与边界

| 项目 | 当前值 |
|---|---|
| 默认上下文 | `262144`（可在设置页改） |
| 默认最大输出 | `32768`（可在设置页改） |
| 默认输入 | `["text"]` |
| 目录模型上限 | `1500` |
| 覆盖条目上限 | `200` |
| 档位上限 | `12` |
| 单次请求超时 | `15000ms` |
| 元数据请求超时 | `min(8000, fetchTimeoutMs)` |

> 以上是代码默认值；当前部署在设置页使用 `1,000,000 / 384,000`，实际取值以面板配置为准。

## 13. 状态与透明性

每个模型可暴露：

| 字段 | 含义 |
|---|---|
| `source` | `codex` / `standard` / `both` |
| `calibratedFrom` | 实际补全字段的元数据源 |
| `placeholder` | 仍有未解决的代理模板值 |
| `contextPlaceholder` | 上下文仍是占位 |
| `levelsPlaceholder` | 档位仍是模板 |
| `reasoningUnknown` | 代理说支持推理，但没有可靠档位 |
| `nonReasoning` | 明确非推理 |
| `hidden` / `hiddenBy` | 是否被规则隐藏，以及命中的规则 |
| `overridden` | 是否存在用户覆盖 |

面板展示：

- `校准：OpenRouter` 或 `未匹配`
- `代理模板` 徽标
- 推理档位 `未提供`，而不是伪造的 `xhigh/max`
- 端点状态：Codex/OpenAI 各自的 HTTP 状态、模型数、耗时

## 14. 错误处理与降级

| 场景 | 处理 |
|---|---|
| 单个端点 401/403 | 另一个端点继续；记录该端点错误；提示检查 Key |
| 单个端点超时 | 另一个端点继续；警告中记录超时 |
| 两个端点都失败 | 保留旧目录；更新 `lastError`/`lastAttemptAt`；状态 `error` |
| 元数据源超时/HTTP 错误/JSON 错误 | 记录 warning；继续下一个源；目录仍可用 |
| 元数据全部 0 匹配 | 目录仍可用；未解决项标记 `placeholder` |
| Base URL 变更 | 旧目录标记 `stale`；不立即删除 |
| 响应不是 JSON | 该端点失败；错误信息截断到 180 字符 |
| Key 缺失 | 401 时提示 Missing API key；不把 Key 写进错误 |

密钥处理：

- Key 只保存在宿主 Mod 存储，面板和工具只返回 `hasKey` 与末四位。
- 请求头使用 `Authorization: Bearer <key>`。
- 错误正文最多保留 180 字符；不记录请求头。

## 15. 缓存与刷新

目录缓存包含：

```json
{
  "baseUrl": "...",
  "fetchedAt": 0,
  "endpoints": [],
  "models": [],
  "total": 0,
  "truncated": false,
  "warnings": [],
  "calibration": []
}
```

规则：

- `baseUrl` 不一致 → `stale`。
- 刷新成功 → 覆盖目录、清空 `lastError`、更新 `fetchedAt`。
- 刷新失败 → 保留旧目录，只更新错误和时间。
- 面板打开时按配置间隔自动刷新；间隔为 0 或小于 60 秒不启用。
- 元数据目前每次刷新重新拉取，未做跨刷新 TTL 缓存。

## 16. 安全与隐私

- CLIProxyAPI Key：不返回、不写日志、不写入目录缓存。
- 公共元数据源只接收模型 ID，不接收提示词、对话内容或 Key。
- Base URL 只允许 `http/https`，拒绝用户名/密码，去掉 query/hash，规范化 `/models` 后缀。
- 代理可能返回任意模型 ID；所有字符串都截断，避免超长内容进入 UI。
- `models.json` 属于宿主配置，和 Mod 存储分离；建议使用环境变量并在服务层注入。

## 17. 与原生模型选择的关系

CBC 的 Mods 契约没有注册 provider 或修改原生模型选择器的能力。原生对话要选择这些模型，应使用宿主 `models.json`：

```json
{
  "models": [
    {
      "id": "cn/deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash (CLIProxyAPI)",
      "vendor": "DeepSeek",
      "url": "https://<proxy-host>/v1/chat/completions",
      "apiKey": "${CLIPROXY_API_KEY}",
      "maxInputTokens": 1048576,
      "maxOutputTokens": 393216,
      "supportsToolCall": true,
      "supportsImages": true,
      "supportsReasoning": true
    }
  ]
}
```

- `url` 必须是完整的 `/chat/completions` 路径。
- `id` 必须是代理 `/models` 返回的 ID。
- Key 建议通过 systemd `EnvironmentFile` 注入，避免写进文件。
- 插件系统提供的是 skills/agents/hooks/MCP/LSP，不提供模型 provider 贡献点；`dsh-cliproxyapi-provider` 是 DeepSeek Harness 插件，不能直接用于 CBC。

## 18. 验收用例

| 用例 | 期望 |
|---|---|
| `cn/deepseek-v4.1-flash` | 上下文 `1048576`，最大输出 `393216`，档位 `none/low/high/max`，校准 `openrouter` |
| `commandcode/deepseek/deepseek-v4.1-flash` | 上下文 `1000000`，最大输出 `393216`，档位 `none/low/high/max` |
| `gemini-3-flash` | 档位 `minimal/low/medium/high` 保持不变（不在原生选择器中则仅目录可见） |
| `grok-4.6` | 上下文 `500000`，档位 `low/medium/high/xhigh` 保持不变 |
| `grok-imagine-image-2.0` | 上下文占位标记；档位清空；非推理；`placeholder=true` |
| `gpt-oss-120b-medium` | 5 档模板被修正为 `low/medium/high` |
| 单端点 401 | 另一端点仍返回模型；警告记录 401 |
| 双端点 401 | 旧目录保留；状态 `error`；`lastError` 包含 Missing API key |
| 元数据源超时 | 目录仍返回；警告记录源名称；未解决项带 `placeholder` |
| 用户覆盖档位 | 覆盖值优先；`levelsPlaceholder` 清除 |
| 隐藏规则 `*-preview` | 匹配模型不在默认列表；`hiddenBy` 记录规则 |

## 19. 已知限制与后续改进

1. **ID 模糊匹配可能误配**：当前取最短长度差，未做置信度。建议增加 `matchScore`，低于阈值时只标记候选，不自动采用。
2. **日期后缀规则可能误删**：`-####` 可能误伤真实 4 位版本号。建议维护白名单或要求完整 ID 优先。
3. **占位检测是启发式**：确实存在真实 500K 上下文的模型。建议支持“信任此模型声明”或“强制校准”开关。
4. **缺少 pi-ai 本地模型库**：CBC Mods 只能访问 OpenRouter/LiteLLM，覆盖不到所有私有模型。
5. **元数据无 TTL 缓存**：LiteLLM JSON 较大；建议按源缓存 1 小时，并支持 ETag/Last-Modified。
6. **面板关闭后不刷新**：当前只在面板打开时自动刷新；如需后台更新，应使用宿主定时器并控制频率。
7. **非 chat 模型混入目录**：image/video/TTS 条目会被识别为模型；建议增加 `modelType` 过滤，默认不进入原生选择器。
8. **显式覆盖不约束上限**：显式 `maxTokens` 可大于上下文；建议增加警告或软约束。
9. **超时未中断底层请求**：当前使用 `Promise.race`，底层 fetch 可能继续；宿主 API 无 signal 时应记录为已知限制。
10. **不能注册 provider**：原生选择仍依赖 `models.json`；Mod 只负责目录、校准、覆盖和诊断。

## 20. 实施清单

- [x] 双端点发现与按 ID 合并
- [x] 占位上下文/最大输出/档位模板识别
- [x] OpenRouter/LiteLLM 元数据索引
- [x] canonical slug、HF ID、尾段、去日期别名匹配
- [x] OpenRouter `supported_efforts` 档位校准
- [x] `calibratedFrom`、`placeholder`、`reasoningUnknown` 标记
- [x] 用户覆盖、隐藏规则、默认值
- [x] 单端点/元数据源失败降级
- [x] 面板展示“校准/代理模板/未提供”
- [ ] 匹配置信度与候选确认
- [ ] 元数据 TTL 缓存
- [ ] 非 chat 模型过滤
- [ ] `models.json` 片段复制/写入
- [ ] 覆盖值超过上下文的警告

## 21. 附录：关键实现映射

| 函数 | 职责 |
|---|---|
| `normalizeBase` | 校验并规范化 Base URL |
| `normalizeModel` | 把代理原始条目归一化为内部模型 |
| `mergeModels` | 按 ID 合并双端点结果 |
| `isPlaceholderContext` | 识别 500K/872K 上下文 |
| `isPlaceholderMax` | 识别 max==context / 90% 合成值 |
| `isCodexTemplate` | 识别 Codex 5/6 档模板 |
| `fetchMetadata` | 拉取 OpenRouter/LiteLLM 并建立索引 |
| `lookupMeta` | 完整 ID → 尾段 → 去日期 → 模糊匹配 |
| `applyMetadata` | 只补缺失或占位字段，写 `calibratedFrom` |
| `deriveModel` | 应用覆盖、默认值、上限约束、占位清理 |
| `buildState` | 应用隐藏规则，生成 UI/工具状态 |
| `refreshCatalog` | 双端点刷新、校准、缓存、错误降级 |

### 关键伪代码

```text
lookupMeta(index, id):
  full = normalize(id)
  tail = normalize(lastSegment(id))
  for key in [full, tail, stripDate(tail)]:
    if index.has(key): return index.get(key)
  candidates = index keys where
    key.startsWith(tail + "-") or tail.startsWith(key + "-")
  return candidate with smallest length distance

applyMetadata(model, meta):
  if model.context missing or placeholder:
    model.context = meta.context; clear contextPlaceholder
  if model.max missing or placeholder:
    model.max = meta.max; clear maxPlaceholder
  if model.input missing:
    model.input = meta.input
  if model.levels missing or template:
    if meta.levels: model.levels = sort(meta.levels); clear template
    else if meta.reasoning == false: model.nonReasoning = true
    else if meta.reasoning == true: model.levels = []; model.reasoningUnknown = true
  if any field used: model.calibratedFrom += source
```
