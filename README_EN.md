# CLIProxyAPI Provider for DeepSeek Harness

English | [简体中文](./README.md)

> This repository is derived from [router-for-me/dsh-cliproxyapi-provider](https://github.com/router-for-me/dsh-cliproxyapi-provider) and migrates it to the DeepSeek Harness 0.2.1-rc.3 host APIs.

Adds a `CLIProxyAPI` model provider based on the OpenAI Responses API to DeepSeek Harness. The plugin retrieves the model catalog from CLIProxyAPI automatically, so models never need to be maintained by hand.

## Requirements

- DeepSeek Harness `0.2.1-rc.3` or later, before `0.2.2`
- Node.js 22 or later

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add @gray0128/dsh-cliproxyapi-provider
```

Start or restart DeepSeek Harness Web afterwards:

```bash
npx @deepseek-ai/dsh web
```

## Usage

After opening Harness:

1. Go to **Settings → Plugins → CLIProxyAPI**.
2. Enter the **Base URL**, for example `http://127.0.0.1:8317/v1`.
3. Enter the **API key**. Leave it empty if the service does not require authentication.
4. Click **Save & Enable**. The model list is retrieved automatically and refreshed periodically.

On save, the plugin writes the models into the `CLIProxyAPI` entry of the built-in `llm-pi-ai` provider configuration, so they appear in the model picker immediately.

## How it works

- **Model discovery**: requests `GET {baseURL}/models?client_version=dsh-cliproxyapi-provider` (Codex-style `models` array) and `GET {baseURL}/models` (standard OpenAI-style `data` array) in parallel, merging capacity, input modalities, and reasoning levels by model ID (reading both `supported_reasoning_levels` and `thinking.levels` / `zero_allowed`, with canonical `max` prioritized over `ultra`). If either endpoint fails, times out, or filters to an empty list, discovery degrades to the responding catalog. Missing fields fall back to the plugin defaults, and `maxTokens` is clamped to `contextWindow` unless explicitly overridden.
- **Multi-source metadata calibration**: when CLIProxyAPI returns a synthetic Codex fallback template (`500K`/`872K` context window with the 6-level Codex reasoning list), a bare `/v1/models` entry, an empty `supported_reasoning_levels: []`, or a synthetic `maxTokens` cap (equal to `contextWindow` or a 90% estimate), the plugin calibrates `contextWindow`, `maxTokens`, `input`, and `reasoningEfforts` across the prioritized `metadataSources` (`@earendil-works/pi-ai` built-in registry, OpenRouter Models API, and LiteLLM model database). Remote sources use bounded timeouts, in-memory TTL caching, and stale-if-error fallback so upstream outages or schema drift never block discovery.
- **Single directory owner**: the plugin registers no provider directory of its own. It only maintains the `CLIProxyAPI` entry inside `llm-pi-ai`, and the built-in `pi-ai` adapter owns routing and requests.
- **Credentials**: the API key is stored as the DSH credential `DSH_CLIPROXY_API_KEY` and never written to the configuration file. Without a key the plugin sends a placeholder `Authorization` header so requests still go out.
- **Refresh**: the catalog refreshes every 5 minutes by default. Failures retry with exponential backoff from 3 seconds up to 60 seconds, and an unchanged error is logged once.

## Configuration

The defaults suit most deployments. To change them, set `config` on the `llm-cliproxyapi` entry in the profile's `cordis.patch.yml`; a patch replaces that entry's whole config, so list every field you need.

| Option | Default | Meaning |
| --- | --- | --- |
| `defaultContextWindow` | `262144` | Context window used when the catalog omits one |
| `defaultMaxTokens` | `32768` | Max output used when the catalog omits one (clamped to `contextWindow` unless overridden) |
| `defaultInput` | `["text"]` | Input modalities used when the catalog omits them; may include `image` |
| `excludedModels` | `[]` | Hides models by ID; supports the `*` wildcard, for example `["*-preview"]` |
| `modelOverrides` | `{}` | Per-model overrides for `name`, `contextWindow`, `maxTokens`, `input`, and `reasoningEfforts`; `reasoningEfforts: false` declares a non-reasoning model |
| `metadataSources` | `["pi-ai", "openrouter", "litellm"]` | Prioritized metadata sources for automatic calibration; `[]` disables calibration |
| `openRouterModelsURL` | `"https://openrouter.ai/api/v1/models"` | OpenRouter Models API endpoint |
| `liteLlmModelsURL` | `"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"` | LiteLLM model metadata JSON URL |
| `metadataTimeoutMs` | `8000` | Timeout for one remote metadata request (ms) |
| `metadataCacheTtlMs` | `3600000` | In-memory cache TTL for remote metadata (ms); `0` refetches each time |
| `headers` | `{}` | Extra request headers for catalog and model requests |
| `fetchTimeoutMs` | `15000` | Timeout for one catalog request (ms) |
| `retryInitialMs` | `3000` | First retry delay (ms) |
| `retryMaxMs` | `60000` | Retry delay ceiling (ms) |
| `refreshIntervalMs` | `300000` | Catalog refresh interval (ms); `0` disables periodic refreshes |

## Uninstall

```bash
npx @deepseek-ai/dsh plugin --profile web remove @gray0128/dsh-cliproxyapi-provider
```

Restart DeepSeek Harness Web after uninstalling.

## Troubleshooting

- **“incompatible with DSH” warning**: the plugin version does not match the running DSH. Upgrade the plugin rather than granting `dsh plugin allow-version` — it relies on the 0.2.1-rc.3 host APIs and would still fail to load once the check is bypassed.
- **401 or 403**: save a valid API key in Settings.
- **Empty model list after saving**: make sure CLIProxyAPI answers `/models` with a Codex-style `models` array or a standard OpenAI-style `data` array holding at least one model not hidden by `excludedModels`.

## License

MIT, see [package.json](./package.json).
