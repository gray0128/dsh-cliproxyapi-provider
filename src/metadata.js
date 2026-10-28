const CANONICAL_REASONING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]
const CANONICAL_REASONING_SET = new Set(CANONICAL_REASONING_LEVELS)
const SYNTHETIC_CODEX_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const DEFAULT_REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
}
const NON_CHAT_MODES = new Set([
  'embedding',
  'rerank',
  'moderation',
  'image_generation',
  'audio_transcription',
  'audio_speech',
  'tts',
])
const CHANNEL_PREFIX_RE = /^(?:cn|opencode-go|opencode|commandcode|workbuddy|antigravity|trae|cursor|copilot|github-copilot|openrouter|together_ai|together|fireworks_ai|fireworks|deepinfra|vertex_ai|google-vertex|bedrock|amazon-bedrock|azure_ai|azure|cloudflare-ai-gateway|workers-ai|aihubmix|coralbricks)\//i
const BEDROCK_PREFIX_RE = /^(?:(?:global|us|eu|ap|au)\.)?(?:anthropic|deepseek|meta|mistral|amazon|xai|qwen|zai)\./i
const VARIANT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh|max|ultra|intl|cn|free|fast|build-fast|preview|latest|beta|customtools|thinking|contributor)$/i
const DATE_SUFFIX_RE = /-(?:20\d{6}|\d{4}|v\d+(?::\d+)?)$/i
const COLON_SUFFIX_RE = /:\d+$|:free$|:thinking$|:extended$|:batch$/i
const SPECIALIZED_VARIANT_RE = /-(?:image|audio|tts|realtime|transcribe|embed|embedding|moderation|search)(?:-|$)/i

const MAX_METADATA_BYTES = 12 * 1024 * 1024

const PI_PROVIDER_PRIORITY = new Map([
  ['anthropic', 100],
  ['openai', 100],
  ['google', 100],
  ['deepseek', 100],
  ['xai', 100],
  ['minimax', 95],
  ['minimax-cn', 94],
  ['moonshotai', 95],
  ['moonshotai-cn', 94],
  ['zai', 95],
  ['zai-coding-cn', 94],
  ['qwen-token-plan', 92],
  ['qwen-token-plan-cn', 92],
  ['kimi-coding', 90],
  ['opencode-go', 88],
  ['opencode', 86],
  ['openai-codex', 84],
  ['openrouter', 80],
  ['github-copilot', 78],
  ['google-vertex', 75],
  ['azure', 72],
  ['amazon-bedrock', 70],
  ['cerebras', 68],
  ['groq', 66],
  ['together', 64],
  ['fireworks', 62],
])

export const METADATA_SOURCE_IDS = ['pi-ai', 'openrouter', 'litellm']
export const DEFAULT_METADATA_SOURCES = ['pi-ai', 'openrouter', 'litellm']
export const DEFAULT_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const DEFAULT_LITELLM_MODELS_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const DEFAULT_METADATA_TIMEOUT_MS = 8000
export const DEFAULT_METADATA_CACHE_TTL_MS = 3600000

function positiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
}

function validContextWindow(...values) {
  for (const value of values) {
    const parsed = positiveInt(value)
    if (parsed && parsed >= 1024) return parsed
  }
}

export function isSyntheticMaxTokens(contextWindow, maxTokens) {
  if (!contextWindow || contextWindow <= 65536 || !maxTokens) return false
  if (maxTokens >= contextWindow) return true
  // OpenRouter synthesizes `Math.floor(context_length * 0.9)` when a provider
  // does not report a real output token limit.
  if (
    maxTokens === Math.floor(contextWindow * 0.9)
    || maxTokens === Math.round(contextWindow * 0.9)
  ) {
    return true
  }
  return false
}

function validMaxTokens(contextWindow, ...values) {
  for (const value of values) {
    const parsed = positiveInt(value)
    if (!parsed) continue
    if (isSyntheticMaxTokens(contextWindow, parsed)) continue
    return parsed
  }
}

function normalizeInputModalities(raw) {
  if (!Array.isArray(raw) || !raw.length) return undefined
  const modalities = []
  const seen = new Set()
  for (const item of raw) {
    const value = typeof item === 'string' ? item.trim().toLowerCase() : ''
    if ((value === 'text' || value === 'image') && !seen.has(value)) {
      seen.add(value)
      modalities.push(value)
    }
  }
  if (!modalities.length) return undefined
  if (!seen.has('text')) modalities.unshift('text')
  return modalities
}

function usableEfforts(efforts) {
  if (!efforts || typeof efforts !== 'object') return undefined
  const out = {}
  for (const level of CANONICAL_REASONING_LEVELS) {
    const wire = efforts[level]
    if (typeof wire === 'string' && wire.trim()) out[level] = wire.trim()
  }
  const keys = Object.keys(out)
  if (!keys.length || keys.every((key) => key === 'off')) return undefined
  return out
}

function mapEffortList(list) {
  if (!Array.isArray(list) || !list.length) return undefined
  const raw = {}
  for (const item of list) {
    const value = (typeof item === 'string' ? item : item?.effort ?? item?.level ?? '')
      .trim()
      .toLowerCase()
    if (!value) continue
    if (value === 'off' || value === 'none') {
      if (!('off' in raw)) raw.off = 'none'
    } else if (value === 'ultra') {
      if (!('max' in raw)) raw.max = 'ultra'
    } else if (CANONICAL_REASONING_SET.has(value)) {
      raw[value] = value
    }
  }
  return usableEfforts(raw)
}

function stripPrefixes(value) {
  const lastSlash = value.lastIndexOf('/')
  const afterSlash = lastSlash >= 0 ? value.slice(lastSlash + 1) : value
  return afterSlash.replace(/^~/, '').replace(BEDROCK_PREFIX_RE, '')
}

function stripVariantSuffixes(value) {
  let current = value.replace(COLON_SUFFIX_RE, '')
  for (let i = 0; i < 4; i += 1) {
    const next = current
      .replace(DATE_SUFFIX_RE, '')
      .replace(VARIANT_SUFFIX_RE, '')
    if (next === current) break
    current = next
  }
  return current
}

export function candidateKeysForModelId(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return []
  const raw = modelId.trim().toLowerCase()
  const noColon = raw.replace(COLON_SUFFIX_RE, '')
  const afterChannel = noColon.replace(CHANNEL_PREFIX_RE, '')
  const bare = stripPrefixes(noColon)
  const canonical = stripVariantSuffixes(bare)
  const dotToDash = canonical.replace(/\./g, '-')
  const dashToDot = canonical.replace(/(\d)-(\d)/g, '$1.$2')

  const keys = []
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key)
  }
  add(raw)
  add(noColon)
  add(afterChannel)
  add(bare)
  add(bare.replace(/\./g, '-'))
  add(bare.replace(/(\d)-(\d)/g, '$1.$2'))
  add(canonical)
  add(dotToDash)
  add(dashToDot)
  return keys
}

function mergeSpecs(primary, secondary) {
  if (!primary) return secondary
  if (!secondary) return primary
  const contextWindow = primary.contextWindow ?? secondary.contextWindow
  const maxTokens = validMaxTokens(contextWindow, primary.maxTokens, secondary.maxTokens)
  return {
    ...(primary.name ?? secondary.name ? { name: primary.name ?? secondary.name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(primary.input ?? secondary.input ? { input: primary.input ?? secondary.input } : {}),
    ...(primary.reasoningEfforts ?? secondary.reasoningEfforts
      ? { reasoningEfforts: primary.reasoningEfforts ?? secondary.reasoningEfforts }
      : {}),
    ...(primary.reasoning !== undefined || secondary.reasoning !== undefined
      ? { reasoning: primary.reasoning ?? secondary.reasoning }
      : {}),
  }
}

function indexEntry(map, key, spec, priority = 0) {
  if (!key) return
  const normalized = key.trim().toLowerCase()
  if (!normalized) return
  const existing = map.get(normalized)
  if (!existing) {
    map.set(normalized, { spec, priority })
  } else if (priority > existing.priority) {
    map.set(normalized, {
      priority,
      spec: mergeSpecs(spec, existing.spec),
    })
  } else {
    map.set(normalized, {
      priority: existing.priority,
      spec: mergeSpecs(existing.spec, spec),
    })
  }
}

function registerModelKeys(map, rawId, spec, basePriority = 50) {
  if (typeof rawId !== 'string' || !rawId.trim()) return
  const full = rawId.trim().toLowerCase()
  indexEntry(map, full, spec, basePriority + 20)

  const noColon = full.replace(COLON_SUFFIX_RE, '')
  indexEntry(map, noColon, spec, basePriority + 18)

  const afterChannel = noColon.replace(CHANNEL_PREFIX_RE, '')
  indexEntry(map, afterChannel, spec, basePriority + 15)

  const bare = stripPrefixes(noColon)
  indexEntry(map, bare, spec, basePriority + 12)
  indexEntry(map, bare.replace(/\./g, '-'), spec, basePriority + 11)
  indexEntry(map, bare.replace(/(\d)-(\d)/g, '$1.$2'), spec, basePriority + 11)

  if (!SPECIALIZED_VARIANT_RE.test(bare)) {
    const canonical = stripVariantSuffixes(bare)
    if (canonical && canonical !== bare) {
      indexEntry(map, canonical, spec, basePriority + 4)
      indexEntry(map, canonical.replace(/\./g, '-'), spec, basePriority + 3)
      indexEntry(map, canonical.replace(/(\d)-(\d)/g, '$1.$2'), spec, basePriority + 3)
    }
  }
}

export function buildPiAiMetadataIndex(modelsByProvider) {
  const map = new Map()
  if (!Array.isArray(modelsByProvider)) return map
  for (const entry of modelsByProvider) {
    const provider = String(entry?.provider ?? '').trim().toLowerCase()
    const models = Array.isArray(entry?.models) ? entry.models : []
    const basePriority = PI_PROVIDER_PRIORITY.get(provider) ?? 60
    for (const model of models) {
      const id = typeof model?.id === 'string' ? model.id.trim() : ''
      if (!id) continue
      const contextWindow = validContextWindow(
        model.contextWindow,
        model.context_length,
        model.max_input_tokens,
      )
      const maxTokens = validMaxTokens(
        contextWindow,
        model.maxTokens,
        model.max_output_tokens,
        model.max_completion_tokens,
      )
      const input = normalizeInputModalities(model.input ?? model.inputModalities)
      let reasoningEfforts
      if (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object') {
        const mapped = {}
        for (const level of CANONICAL_REASONING_LEVELS) {
          const wire = model.thinkingLevelMap[level]
          if (typeof wire === 'string' && wire.trim()) mapped[level] = wire.trim()
        }
        reasoningEfforts = usableEfforts(mapped)
      }
      const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : undefined
      const spec = {
        ...(typeof model.name === 'string' && model.name.trim() ? { name: model.name.trim() } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(input ? { input } : {}),
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }
      if (provider) {
        registerModelKeys(map, `${provider}/${id}`, spec, basePriority + 5)
      }
      registerModelKeys(map, id, spec, basePriority)
    }
  }
  return map
}

function openRouterInputOf(entry) {
  const fromArray = normalizeInputModalities(
    entry?.architecture?.input_modalities
    ?? entry?.modalities?.input
    ?? entry?.input_modalities,
  )
  if (fromArray) return fromArray
  const modality = typeof entry?.architecture?.modality === 'string'
    ? entry.architecture.modality.toLowerCase()
    : ''
  if (!modality) return undefined
  const inputPart = modality.split('->')[0] ?? modality
  const modalities = ['text']
  if (inputPart.includes('image') || inputPart.includes('multimodal')) modalities.push('image')
  return modalities
}

function openRouterReasoningOf(entry) {
  if (entry?.reasoning && typeof entry.reasoning === 'object') {
    const efforts = mapEffortList(entry.reasoning.supported_efforts ?? entry.reasoning.levels)
    if (efforts) return { reasoningEfforts: efforts, reasoning: true }
  }
  if (Array.isArray(entry?.reasoning_options)) {
    const effortOpt = entry.reasoning_options.find((opt) => opt?.type === 'effort' && Array.isArray(opt?.values))
    const efforts = mapEffortList(effortOpt?.values)
    if (efforts) return { reasoningEfforts: efforts, reasoning: true }
  }
  const params = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : []
  if (params.includes('reasoning') || params.includes('reasoning_effort')) {
    return { reasoning: true }
  }
  return {}
}

export function buildOpenRouterMetadataIndex(payload) {
  const map = new Map()
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    const outputModalities = entry?.architecture?.output_modalities ?? entry?.modalities?.output
    if (Array.isArray(outputModalities) && outputModalities.length && !outputModalities.includes('text')) {
      continue
    }
    const contextWindow = validContextWindow(
      entry?.top_provider?.context_length,
      entry?.context_length,
      entry?.contextWindow,
      entry?.limit?.context,
      entry?.max_input_tokens,
    )
    const maxTokens = validMaxTokens(
      contextWindow,
      entry?.top_provider?.max_completion_tokens,
      entry?.max_completion_tokens,
      entry?.max_output_tokens,
      entry?.limit?.output,
      entry?.max_tokens,
    )
    const input = openRouterInputOf(entry)
    const { reasoningEfforts, reasoning } = openRouterReasoningOf(entry)
    const rawName = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const cleanName = rawName.includes(': ') ? rawName.split(': ').slice(1).join(': ').trim() : rawName
    const spec = {
      ...(cleanName ? { name: cleanName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(input ? { input } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
    registerModelKeys(map, id, spec, 70)
    if (typeof entry?.canonical_slug === 'string' && entry.canonical_slug.trim()) {
      registerModelKeys(map, entry.canonical_slug.trim(), spec, 68)
    }
  }
  return map
}

export function buildLiteLlmMetadataIndex(payload) {
  const map = new Map()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return map
  for (const [rawKey, entry] of Object.entries(payload)) {
    if (rawKey === 'sample_spec' || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const mode = typeof entry.mode === 'string' ? entry.mode.trim().toLowerCase() : ''
    if (mode && NON_CHAT_MODES.has(mode)) continue
    const contextWindow = validContextWindow(
      entry.max_input_tokens,
      entry.context_window,
      entry.max_context_window,
      entry.context_length,
    )
    const maxTokens = validMaxTokens(
      contextWindow,
      entry.max_output_tokens,
      entry.max_completion_tokens,
      entry.max_tokens,
    )
    const input = entry.supports_vision === true
      ? ['text', 'image']
      : entry.supports_vision === false
        ? ['text']
        : normalizeInputModalities(entry.input_modalities ?? entry.modalities?.input)
    const reasoningEfforts = mapEffortList(entry.supported_reasoning_levels ?? entry.reasoning_efforts)
    const reasoning = typeof entry.supports_reasoning === 'boolean'
      ? entry.supports_reasoning
      : reasoningEfforts
        ? true
        : undefined
    if (!contextWindow && !maxTokens && !input && !reasoningEfforts && reasoning === undefined) continue
    const provider = String(entry.litellm_provider ?? '').toLowerCase()
    const basePriority = provider === 'anthropic' || provider === 'openai' || provider === 'gemini' || provider === 'deepseek' || provider === 'xai'
      ? 65
      : 50
    const spec = {
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(input ? { input } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
    registerModelKeys(map, rawKey, spec, basePriority)
  }
  return map
}

export function lookupModelMetadata(modelId, indexes) {
  if (!Array.isArray(indexes) || !indexes.length) return undefined
  const candidates = candidateKeysForModelId(modelId)
  if (!candidates.length) return undefined
  let combined
  for (const index of indexes) {
    if (!(index instanceof Map) || !index.size) continue
    let best
    for (const key of candidates) {
      const hit = index.get(key)
      if (!hit) continue
      if (!best) {
        best = { priority: hit.priority, spec: hit.spec }
      } else if (hit.priority > best.priority) {
        best = { priority: hit.priority, spec: mergeSpecs(hit.spec, best.spec) }
      } else {
        best = { priority: best.priority, spec: mergeSpecs(best.spec, hit.spec) }
      }
    }
    if (best) {
      combined = mergeSpecs(combined, best.spec)
    }
  }
  return combined
}

function rawContextOf(entry) {
  return (
    positiveInt(entry?.max_context_window)
    ?? positiveInt(entry?.context_window)
    ?? positiveInt(entry?.context_length)
    ?? positiveInt(entry?.inputTokenLimit)
  )
}

function rawMaxOutputOf(entry) {
  return (
    positiveInt(entry?.max_output_tokens)
    ?? positiveInt(entry?.max_completion_tokens)
    ?? positiveInt(entry?.max_tokens)
    ?? positiveInt(entry?.outputTokenLimit)
  )
}

export function isSyntheticCodexTemplate(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (rawMaxOutputOf(entry) !== undefined) return false
  if (entry.context_window === 500000 && entry.max_context_window === 872000) {
    return true
  }
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels.map((item) => {
      return String(typeof item === 'string' ? item : item?.effort ?? '').trim().toLowerCase()
    })
    : []
  return (
    levels.length === SYNTHETIC_CODEX_LEVELS.length
    && SYNTHETIC_CODEX_LEVELS.every((level, index) => levels[index] === level)
  )
}

export function isBareModelEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.slug === 'string' && entry.slug.trim()) return false
  return rawContextOf(entry) === undefined && rawMaxOutputOf(entry) === undefined
}

export function entryNeedsCalibration(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (isSyntheticCodexTemplate(entry) || isBareModelEntry(entry)) return true
  const rawContext = rawContextOf(entry)
  const rawMaxOutput = rawMaxOutputOf(entry)
  if (rawContext && isSyntheticMaxTokens(rawContext, rawMaxOutput)) return true
  if (Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length === 0) {
    return true
  }
  return false
}

export function calibrateCatalogEntry(entry, metadata) {
  if (!entry || typeof entry !== 'object' || !metadata) return entry
  const synthetic = isSyntheticCodexTemplate(entry)
  const bare = isBareModelEntry(entry)
  const rawContext = rawContextOf(entry)
  const rawMaxOutput = rawMaxOutputOf(entry)

  const next = { ...entry }

  // 1. Context window: calibrate when CLIProxyAPI used its synthetic Codex
  // template or omitted context capacity entirely.
  if (metadata.contextWindow && (synthetic || !rawContext)) {
    next.max_context_window = metadata.contextWindow
    next.context_window = metadata.contextWindow
  }

  const effectiveContext = rawContextOf(next) ?? metadata.contextWindow

  // 2. Max output tokens: calibrate when synthetic template, bare `/v1/models`
  // entry, or erroneously set to a synthetic cap (>= contextWindow or 90%).
  if (
    metadata.maxTokens
    && (synthetic || bare || (rawMaxOutput !== undefined && isSyntheticMaxTokens(effectiveContext, rawMaxOutput)))
  ) {
    next.max_output_tokens = metadata.maxTokens
  }

  // 3. Input modalities: calibrate when synthetic template or bare entry.
  if (metadata.input && (synthetic || bare)) {
    next.input_modalities = [...metadata.input]
  }

  // 4. Reasoning efforts: if CLIProxyAPI did not explicitly disable thinking,
  // calibrate when CLIProxyAPI left supported_reasoning_levels empty ([]),
  // used its synthetic template, or returned a bare `/v1/models` entry.
  const explicitlyDisabled = entry.thinking === false
    || entry.reasoning === false
    || (typeof entry.thinking?.type === 'string' && entry.thinking.type.trim().toLowerCase() === 'disabled')
  if (!explicitlyDisabled) {
    const emptyCodexLevels = Array.isArray(entry.supported_reasoning_levels)
      && entry.supported_reasoning_levels.length === 0
    if (metadata.reasoningEfforts && (synthetic || bare || emptyCodexLevels)) {
      next.supported_reasoning_levels = Object.entries(metadata.reasoningEfforts).map(([, wire]) => ({
        effort: wire,
      }))
    } else if ((bare || emptyCodexLevels) && metadata.reasoning === true && !entry.thinking?.levels) {
      next.supported_reasoning_levels = Object.entries(DEFAULT_REASONING_EFFORTS).map(([, wire]) => ({
        effort: wire,
      }))
    }
  }

  return next
}

function entryIdOf(item) {
  if (!item || typeof item !== 'object') return ''
  for (const candidate of [item.slug, item.id, item.model]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

export function calibrateCatalogPayload(body, indexes) {
  if (!body || typeof body !== 'object' || !Array.isArray(indexes) || !indexes.length) {
    return body
  }
  const hasAnyEntries = indexes.some((index) => index instanceof Map && index.size > 0)
  if (!hasAnyEntries) return body
  const calibrateItem = (item) => {
    if (!entryNeedsCalibration(item)) return item
    const id = entryIdOf(item)
    if (!id) return item
    const metadata = lookupModelMetadata(id, indexes)
    return metadata ? calibrateCatalogEntry(item, metadata) : item
  }
  if (Array.isArray(body)) return body.map(calibrateItem)
  if (Array.isArray(body.models)) {
    return { ...body, models: body.models.map(calibrateItem) }
  }
  if (Array.isArray(body.data)) {
    return { ...body, data: body.data.map(calibrateItem) }
  }
  return body
}

let cachedPiAiIndexPromise

export async function loadPiAiMetadataIndex() {
  if (!cachedPiAiIndexPromise) {
    cachedPiAiIndexPromise = import('@earendil-works/pi-ai/providers/all')
      .then((mod) => {
        const providers = typeof mod.builtinProviders === 'function' ? mod.builtinProviders() : []
        const rows = providers.map((provider) => ({
          provider: provider.id,
          models: typeof mod.getBuiltinModels === 'function' ? mod.getBuiltinModels(provider.id) : [],
        }))
        return buildPiAiMetadataIndex(rows)
      })
      .catch(() => new Map())
  }
  return cachedPiAiIndexPromise
}

async function readBoundedMetadataJson(response) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    await response.body?.cancel?.()
    throw new Error('Metadata catalog exceeds size limit')
  }
  if (!response.body) return JSON.parse(await response.text())
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_METADATA_BYTES) throw new Error('Metadata catalog exceeds size limit')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function fetchMetadataJson(url, timeoutMs, parentSignal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal?.aborted) forwardAbort()
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Metadata request timed out')), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Metadata endpoint answered ${response.status}`)
    return await readBoundedMetadataJson(response)
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', forwardAbort)
  }
}

function extractEntries(body) {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.models)) return body.models
  if (Array.isArray(body?.data)) return body.data
  return []
}

function isEntrySatisfied(entry, indexes) {
  if (!entryNeedsCalibration(entry)) return true
  const id = entryIdOf(entry)
  if (!id) return true
  const meta = lookupModelMetadata(id, indexes)
  return Boolean(meta?.contextWindow && meta?.maxTokens)
}

export function createMetadataResolver(options = {}) {
  const sources = Array.isArray(options.metadataSources)
    ? options.metadataSources
    : DEFAULT_METADATA_SOURCES
  const openRouterURL = options.openRouterModelsURL ?? DEFAULT_OPENROUTER_MODELS_URL
  const liteLlmURL = options.liteLlmModelsURL ?? DEFAULT_LITELLM_MODELS_URL
  const timeoutMs = positiveInt(options.metadataTimeoutMs) ?? DEFAULT_METADATA_TIMEOUT_MS
  const cacheTtlMs = typeof options.metadataCacheTtlMs === 'number' && options.metadataCacheTtlMs >= 0
    ? options.metadataCacheTtlMs
    : DEFAULT_METADATA_CACHE_TTL_MS
  const loadPiAi = options.loadPiAiIndex ?? loadPiAiMetadataIndex

  const remoteCache = new Map()

  const resolveRemoteSource = async (key, url, builder, signal) => {
    if (!url) return new Map()
    const now = Date.now()
    const cached = remoteCache.get(key)
    if (cached?.index && cacheTtlMs > 0 && now - cached.fetchedAt < cacheTtlMs) {
      return cached.index
    }
    if (cached?.inFlight) return cached.inFlight
    const inFlight = (async () => {
      try {
        const body = await fetchMetadataJson(url, timeoutMs, signal)
        const index = builder(body)
        if (index.size > 0) {
          remoteCache.set(key, { index, fetchedAt: Date.now() })
          return index
        }
        return cached?.index ?? new Map()
      } catch {
        return cached?.index ?? new Map()
      } finally {
        const current = remoteCache.get(key)
        if (current?.inFlight === inFlight) {
          delete current.inFlight
        }
      }
    })()
    remoteCache.set(key, { ...cached, inFlight })
    return inFlight
  }

  return {
    async resolveIndexesForPayloads(payloads, signal) {
      if (!sources.length) return []
      const entries = payloads.flatMap(extractEntries)
      if (!entries.some(entryNeedsCalibration)) return []

      const indexes = []
      for (const source of sources) {
        if (source === 'pi-ai') {
          const index = await Promise.resolve(loadPiAi()).catch(() => new Map())
          if (index.size > 0) indexes.push(index)
        } else if (source === 'openrouter') {
          if (indexes.length > 0 && entries.every((entry) => isEntrySatisfied(entry, indexes))) {
            continue
          }
          const index = await resolveRemoteSource('openrouter', openRouterURL, buildOpenRouterMetadataIndex, signal)
          if (index.size > 0) indexes.push(index)
        } else if (source === 'litellm') {
          if (indexes.length > 0 && entries.every((entry) => isEntrySatisfied(entry, indexes))) {
            continue
          }
          const index = await resolveRemoteSource('litellm', liteLlmURL, buildLiteLlmMetadataIndex, signal)
          if (index.size > 0) indexes.push(index)
        }
      }
      return indexes
    },
  }
}
