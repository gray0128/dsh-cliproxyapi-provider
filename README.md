# CLIProxyAPI Provider for DeepSeek Harness

[English](./README_EN.md) | 简体中文

> 本仓库派生自 [router-for-me/dsh-cliproxyapi-provider](https://github.com/router-for-me/dsh-cliproxyapi-provider)，并在其基础上迁移到 DeepSeek Harness 0.2.1-rc.3 的宿主 API。

为 DeepSeek Harness 添加一个基于 OpenAI Responses API 的 `CLIProxyAPI` 模型供应商。插件自动从 CLIProxyAPI 拉取模型目录，无需手动维护模型列表。

## 环境要求

- DeepSeek Harness `0.2.1-rc.3` 及以上、`0.2.2` 之前
- Node.js 22 及以上

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add @gray0128/dsh-cliproxyapi-provider
```

安装后启动或重启 DeepSeek Harness Web：

```bash
npx @deepseek-ai/dsh web
```

## 使用

打开 Harness 后：

1. 进入 **设置 → 插件 → CLIProxyAPI**。
2. 填写 **Base URL**，例如 `http://127.0.0.1:8317/v1`。
3. 填写 **API Key**；无鉴权服务可以留空。
4. 点击 **保存并启用**，模型列表会自动获取并定期刷新。

保存后，插件把模型写入内置 `llm-pi-ai` 供应商配置的 `CLIProxyAPI` 条目，模型会直接出现在选择器中。

## 工作方式

- **模型发现**：并行请求 `GET {baseURL}/models?client_version=dsh-cliproxyapi-provider`（Codex 风格 `models` 数组）与 `GET {baseURL}/models`（标准 OpenAI 风格 `data` 数组），按模型 ID 合并两边的容量、输入模态和思考档位（同时解析 `supported_reasoning_levels` 与 `thinking.levels` / `zero_allowed`，同名标准档位 `max` 优先于 `ultra`）；任一端点失败、超时或过滤后为空时自动降级到另一端点。缺少的字段回落到插件配置的默认值，且未显式覆盖 `maxTokens` 时自动约束 `maxTokens <= contextWindow`。
- **单一目录所有者**：插件不注册自己的供应商目录，只维护 `llm-pi-ai` 里的 `CLIProxyAPI` 配置，路由和请求由内置 `pi-ai` 适配器负责。
- **凭据**：API Key 保存为 DSH 凭据 `DSH_CLIPROXY_API_KEY`，不写入配置文件。无密钥时写入一个占位 `Authorization` 头，保证请求仍能发出。
- **刷新**：默认每 5 分钟刷新一次目录；失败时按 3 秒起步的指数退避重试，上限 60 秒，同一错误只记一条警告。

## 配置项

默认值适用于大多数部署。需要调整时，在 profile 的 `cordis.patch.yml` 中按 id `llm-cliproxyapi` 设置 `config`；补丁会整体替换该条目的配置，因此要写出全部需要的字段。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultContextWindow` | `262144` | 目录未提供上下文窗口时使用的值 |
| `defaultMaxTokens` | `32768` | 目录未提供最大输出时使用的值（未显式覆盖时不超过 `contextWindow`） |
| `defaultInput` | `["text"]` | 目录未提供输入模态时使用的值，可含 `image` |
| `excludedModels` | `[]` | 按模型 ID 隐藏模型，支持 `*` 通配符，例如 `["*-preview"]` |
| `modelOverrides` | `{}` | 按模型 ID 覆盖 `name`、`contextWindow`、`maxTokens`、`input` 与 `reasoningEfforts`；`reasoningEfforts: false` 表示非推理模型 |
| `headers` | `{}` | 请求目录和模型时附加的自定义请求头 |
| `fetchTimeoutMs` | `15000` | 单次目录请求超时（毫秒） |
| `retryInitialMs` | `3000` | 首次重试延迟（毫秒） |
| `retryMaxMs` | `60000` | 重试延迟上限（毫秒） |
| `refreshIntervalMs` | `300000` | 目录刷新间隔（毫秒），设为 `0` 关闭定期刷新 |

## 卸载

```bash
npx @deepseek-ai/dsh plugin --profile web remove @gray0128/dsh-cliproxyapi-provider
```

卸载后重启 DeepSeek Harness Web 即可。

## 故障排查

- **提示「与 DSH 不兼容」**：插件版本与当前 DSH 不匹配。请升级插件，不要用 `dsh plugin allow-version` 豁免——本插件依赖 0.2.1-rc.3 的宿主 API，绕过检查后仍会在加载时失败。
- **返回 401 或 403**：在设置中保存有效的 API 密钥。
- **保存后模型列表为空**：确认 CLIProxyAPI 的 `/models` 返回 Codex 风格的 `models` 数组或标准 OpenAI 风格的 `data` 数组，且至少包含一个未被 `excludedModels` 过滤的可用模型。

## 许可

MIT，详见 [package.json](./package.json)。
