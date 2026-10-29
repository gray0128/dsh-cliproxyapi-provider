import { isSyntheticMaxTokens } from './metadata.js'

const CANONICAL_REASONING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]
const CANONICAL_REASONING_SET = new Set(CANONICAL_REASONING_LEVELS)
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_INPUT = ['text']

function positiveInteger(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
}

function modelIdOf(entry) {
  return nonEmptyString(entry?.slug, entry?.id, entry?.model)
}

function usableReasoningEfforts(efforts) {
  const keys = Object.keys(efforts)
  if (!keys.length || keys.every((level) => level === 'off')) return undefined
  return efforts
}

function isPresent(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function normalizeReasoningLevel(value) {
  const wire = nonEmptyString(value)?.toLowerCase()
  if (!wire) return undefined
  if (wire === 'off') return { canonical: 'off', wire: 'none', standard: true }
  if (CANONICAL_REASONING_SET.has(wire)) return { canonical: wire, wire, standard: true }
  if (wire === 'none') return { canonical: 'off', wire: 'none', standard: false }
  if (wire === 'ultra') return { canonical: 'max', wire: 'ultra', standard: false }
  return undefined
}

function reasoningLevelValueOf(item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return undefined
  return item.effort ?? item.name ?? item.id ?? item.value ?? item.level
}

function reasoningLevelsOf(entry) {
  const declared = entry?.supported_reasoning_levels
  if (Array.isArray(declared) && declared.length) {
    return declared.map(reasoningLevelValueOf)
  }
  const levels = entry?.thinking?.levels
  if (!Array.isArray(levels) || !levels.length) return []
  const values = levels.map(reasoningLevelValueOf)
  if (entry.thinking.zero_allowed === true) {
    const lowered = values.map((raw) => nonEmptyString(raw)?.toLowerCase())
    if (!lowered.includes('off') && !lowered.includes('none')) values.push('none')
  }
  return values
}

export function reasoningEffortsOf(entry) {
  const levels = reasoningLevelsOf(entry)
    .map(normalizeReasoningLevel)
    .filter(Boolean)
  if (!levels.length) return undefined
  const efforts = {}
  // Canonical names win over aliases regardless of the upstream array order.
  for (const level of levels) {
    if (level.standard) efforts[level.canonical] = level.wire
  }
  for (const level of levels) {
    if (!level.standard && !(level.canonical in efforts)) efforts[level.canonical] = level.wire
  }
  // Emit a stable low-to-high order so selectors do not follow the upstream
  // array, which varies between the two CLIProxyAPI endpoints.
  const ordered = {}
  for (const level of CANONICAL_REASONING_LEVELS) {
    if (level in efforts) ordered[level] = efforts[level]
  }
  // llm-pi-ai rejects a capability map that offers only "off". Omitting the
  // field correctly describes a non-reasoning model for a hand-declared route.
  return usableReasoningEfforts(ordered)
}

function modalitiesOf(values) {
  if (!Array.isArray(values)) return []
  const modalities = []
  const seen = new Set()
  for (const raw of values) {
    const value = nonEmptyString(raw)?.toLowerCase()
    if ((value === 'text' || value === 'image') && !seen.has(value)) {
      seen.add(value)
      modalities.push(value)
    }
  }
  return modalities
}

function inputModalitiesOf(entry, fallback) {
  for (const field of ['input_modalities', 'supportedInputModalities']) {
    const modalities = modalitiesOf(entry?.[field])
    if (modalities.length) return modalities
  }
  return [...fallback]
}

function overrideInputModalities(value) {
  const modalities = modalitiesOf(value)
  return modalities.length ? modalities : undefined
}

function isExcludedModel(id, patterns) {
  if (!Array.isArray(patterns)) return false
  return patterns.some((raw) => {
    const pattern = nonEmptyString(raw)
    if (!pattern) return false
    if (!pattern.includes('*')) return pattern === id
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp('^' + expression + '$').test(id)
  })
}

function modelOverrideOf(options, id) {
  const overrides = options.modelOverrides
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return undefined
  if (!Object.hasOwn(overrides, id)) return undefined
  const override = overrides[id]
  return override && typeof override === 'object' && !Array.isArray(override) ? override : undefined
}

function overriddenReasoningEfforts(override, id) {
  if (!override || !Object.hasOwn(override, 'reasoningEfforts')) return { applied: false }
  const value = override.reasoningEfforts
  if (value === undefined) return { applied: false }
  if (value === false) return { applied: true }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `modelOverrides[${JSON.stringify(id)}].reasoningEfforts must be false or a reasoning level map`,
    )
  }
  const efforts = {}
  for (const [key, wire] of Object.entries(value)) {
    const normalized = normalizeReasoningLevel(wire)
    if (!normalized) {
      throw new TypeError(
        `modelOverrides[${JSON.stringify(id)}].reasoningEfforts.${key} is not a supported reasoning level`,
      )
    }
    if (normalized.canonical !== key) {
      throw new TypeError(
        `modelOverrides[${JSON.stringify(id)}].reasoningEfforts.${key} maps to `
        + `"${normalized.canonical}", not "${key}"`,
      )
    }
    efforts[normalized.canonical] = normalized.wire
  }
  // An empty or off-only map cannot be represented in llm-pi-ai; ignore the
  // override instead of writing a capability map the host would reject.
  const usable = usableReasoningEfforts(efforts)
  if (!usable) return { applied: false }
  return { applied: true, efforts: usable }
}

export function modelProfileOf(entry, options = {}) {
  const id = modelIdOf(entry)
  if (!id || (!options.includeHiddenModels && entry?.visibility === 'hide')) return undefined
  if (isExcludedModel(id, options.excludedModels)) return undefined
  const override = modelOverrideOf(options, id)

  const declaredContextWindow = positiveInteger(
    entry?.max_context_window,
    entry?.context_window,
    entry?.context_length,
    entry?.inputTokenLimit,
    entry?.max_input_tokens,
  )
  const contextWindow = positiveInteger(
    override?.contextWindow,
    declaredContextWindow,
    options.defaultContextWindow,
    DEFAULT_CONTEXT_WINDOW,
  )
  const explicitMaxTokens = positiveInteger(override?.maxTokens)
  const declaredMaxTokens = positiveInteger(
    entry?.max_output_tokens,
    entry?.max_completion_tokens,
    entry?.outputTokenLimit,
    entry?.max_tokens,
  )
  let maxTokens = explicitMaxTokens ?? declaredMaxTokens
  // A budget equal to the context window (or 90% of it) is a synthesized cap,
  // not a declaration. Drop it so the configured default applies instead of
  // handing the route an output budget it cannot honor.
  if (
    maxTokens === undefined
    || (explicitMaxTokens === undefined && isSyntheticMaxTokens(declaredContextWindow, maxTokens))
  ) {
    maxTokens = positiveInteger(options.defaultMaxTokens, DEFAULT_MAX_TOKENS)
  }
  if (
    explicitMaxTokens === undefined
    && positiveInteger(contextWindow) !== undefined
    && positiveInteger(maxTokens) !== undefined
  ) {
    maxTokens = Math.min(contextWindow, maxTokens)
  }

  const reasoningOverride = overriddenReasoningEfforts(override, id)
  const reasoningEfforts = reasoningOverride.applied
    ? reasoningOverride.efforts
    : reasoningEffortsOf(entry)

  return {
    id,
    name: nonEmptyString(
      override?.name,
      entry?.display_name,
      entry?.displayName,
      entry?.name,
      entry?.description,
      id,
    ),
    contextWindow,
    maxTokens,
    input: overrideInputModalities(override?.input) ?? inputModalitiesOf(entry, options.defaultInput ?? DEFAULT_INPUT),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
  }
}

export function catalogEntriesOf(body) {
  if (Array.isArray(body?.models)) return body.models
  if (Array.isArray(body?.data)) return body.data
  return undefined
}

function mergedEntryOf(primary, supplement) {
  const merged = { ...supplement }
  for (const [key, value] of Object.entries(primary)) {
    if (isPresent(value) || !(key in merged)) merged[key] = value
  }
  return merged
}

export function mergeCatalogPayloads(primaryBody, supplementBody) {
  const primary = catalogEntriesOf(primaryBody)
  if (!primary) return supplementBody ?? primaryBody
  const supplement = catalogEntriesOf(supplementBody)
  if (!supplement) return primaryBody
  const supplements = new Map()
  for (const entry of supplement) {
    const id = modelIdOf(entry)
    if (id !== undefined && !supplements.has(id)) supplements.set(id, entry)
  }
  const models = primary.map((entry) => {
    const id = modelIdOf(entry)
    const extra = id === undefined ? undefined : supplements.get(id)
    return extra === undefined ? entry : mergedEntryOf(entry, extra)
  })
  return { ...primaryBody, models }
}

export function readCatalog(body, options = {}) {
  const entries = catalogEntriesOf(body)
  if (!entries) throw new TypeError('CLIProxyAPI model catalog has no "models" or "data" array')
  const models = []
  const seen = new Set()
  for (const entry of entries) {
    const model = modelProfileOf(entry, options)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (!models.length) throw new TypeError('CLIProxyAPI model catalog contains no usable models')
  return models
}

export const readCodexCatalog = readCatalog

export function trimBaseURL(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

function catalogBase(baseURL) {
  const base = trimBaseURL(baseURL)
  if (!base) throw new TypeError('CLIProxyAPI baseURL must not be empty')
  return base
}

export function catalogURL(baseURL) {
  const query = new URLSearchParams({ client_version: 'dsh-cliproxyapi-provider' })
  return catalogBase(baseURL) + '/models?' + query
}

export function standardCatalogURL(baseURL) {
  return catalogBase(baseURL) + '/models'
}
