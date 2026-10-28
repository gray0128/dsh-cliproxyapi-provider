import test from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogURL,
  mergeCatalogPayloads,
  modelProfileOf,
  readCatalog,
  readCodexCatalog,
  reasoningEffortsOf,
  standardCatalogURL,
} from '../src/catalog.js'

const defaults = { defaultContextWindow: 262144, defaultMaxTokens: 32768, defaultInput: ['text'] }

test('maps Codex reasoning levels to Harness canonical levels', () => {
  assert.deepEqual(reasoningEffortsOf({ supported_reasoning_levels: [
    { effort: 'none' }, { effort: 'minimal' }, { effort: 'high' }, { effort: 'ultra' },
  ] }), { off: 'none', minimal: 'minimal', high: 'high', max: 'ultra' })
})

test('omits an off-only reasoning capability rejected by llm-pi-ai', () => {
  assert.equal(reasoningEffortsOf({ supported_reasoning_levels: [
    { effort: 'none' }, { effort: 'off' },
  ] }), undefined)
})

test('prefers the canonical max level over ultra regardless of order', () => {
  assert.deepEqual(reasoningEffortsOf({ supported_reasoning_levels: [
    { effort: 'ultra' }, { effort: 'max' },
  ] }), { max: 'max' })
  assert.deepEqual(reasoningEffortsOf({ supported_reasoning_levels: [
    { effort: 'max' }, { effort: 'ultra' },
  ] }), { max: 'max' })
  assert.deepEqual(reasoningEffortsOf({ supported_reasoning_levels: [
    { effort: 'ultra' },
  ] }), { max: 'ultra' })
})

test('reads thinking levels and zero_allowed from the standard catalog', () => {
  assert.deepEqual(reasoningEffortsOf({ thinking: {
    levels: ['low', 'high'],
    zero_allowed: true,
  } }), { low: 'low', high: 'high', off: 'none' })
  assert.deepEqual(reasoningEffortsOf({ thinking: {
    levels: ['off', 'low'],
    zero_allowed: true,
  } }), { off: 'none', low: 'low' })
})

test('maps model metadata and applies safe fallbacks', () => {
  assert.deepEqual(modelProfileOf({
    slug: 'gpt-test', display_name: 'GPT Test', max_context_window: 372000,
    input_modalities: ['text', 'image', 'audio'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }],
  }, defaults), {
    id: 'gpt-test', name: 'GPT Test', contextWindow: 372000, maxTokens: 32768,
    input: ['text', 'image'], reasoningEfforts: { low: 'low', xhigh: 'xhigh' },
  })
})

test('extracts modalities and reasoning from the Codex catalog response', () => {
  const models = readCodexCatalog({ models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT 5.6 Sol',
      max_context_window: 372000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' },
      ],
    },
    {
      slug: 'gpt-5.6-spark',
      display_name: 'GPT 5.6 Spark',
      max_context_window: 128000,
      input_modalities: ['text'],
    },
  ] }, defaults)

  assert.deepEqual(models, [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      },
    },
    {
      id: 'gpt-5.6-spark',
      name: 'GPT 5.6 Spark',
      contextWindow: 128000,
      maxTokens: 32768,
      input: ['text'],
    },
  ])
})

test('merges standard catalog fields into matching Codex entries by id', () => {
  const merged = mergeCatalogPayloads(
    { models: [{
      slug: 'gpt-5.6-sol',
      display_name: 'GPT 5.6 Sol',
      max_context_window: 372000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    }] },
    { object: 'list', data: [
      {
        id: 'gpt-5.6-sol',
        context_length: 200000,
        max_completion_tokens: 128000,
        supportedInputModalities: ['text'],
        thinking: { levels: ['low', 'high'], zero_allowed: true },
      },
      { id: 'gemini-3-pro', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    ] },
  )

  assert.deepEqual(readCodexCatalog(merged, defaults), [{
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    contextWindow: 372000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high' },
  }])
})

test('reads standard OpenAI catalogs with heterogeneous channel fields', () => {
  const models = readCodexCatalog({ object: 'list', data: [
    {
      id: 'gemini-3-pro',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedInputModalities: ['text', 'image', 'audio'],
    },
    {
      id: 'claude-opus-4-6',
      context_length: 200000,
      max_completion_tokens: 64000,
      thinking: { levels: ['low', 'high'], zero_allowed: true },
    },
  ] }, defaults)

  assert.deepEqual(models, [
    {
      id: 'gemini-3-pro',
      name: 'gemini-3-pro',
      contextWindow: 1048576,
      maxTokens: 65536,
      input: ['text', 'image'],
    },
    {
      id: 'claude-opus-4-6',
      name: 'claude-opus-4-6',
      contextWindow: 200000,
      maxTokens: 64000,
      input: ['text'],
      reasoningEfforts: { low: 'low', high: 'high', off: 'none' },
    },
  ])
})

test('uses configured and built-in fallbacks when catalog capability fields are absent', () => {
  assert.equal(readCatalog, readCodexCatalog)
  assert.deepEqual(modelProfileOf({ slug: 'fallback-model' }, defaults), {
    id: 'fallback-model',
    name: 'fallback-model',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text'],
  })
  assert.deepEqual(modelProfileOf({ slug: 'default-options-model' }), {
    id: 'default-options-model',
    name: 'default-options-model',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text'],
  })
})

test('clamps the output budget to a smaller context window', () => {
  const model = modelProfileOf({ slug: 'tiny', context_window: 16384 }, defaults)
  assert.equal(model.contextWindow, 16384)
  assert.equal(model.maxTokens, 16384)
})

test('filters hidden and excluded models, then applies per-model overrides', () => {
  const models = readCodexCatalog({ models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT 5.6 Sol',
      max_context_window: 372000,
      supported_reasoning_levels: [{ effort: 'high' }],
    },
    { slug: 'gpt-5.6-sol-preview', max_context_window: 372000 },
    { slug: 'hidden', visibility: 'hide', context_window: 3000 },
    { slug: 'gpt-5.6-sol', context_window: 1000 },
    { slug: 'claude-opus-4-6', context_length: 200000, max_completion_tokens: 64000 },
  ] }, {
    ...defaults,
    excludedModels: ['*-preview'],
    modelOverrides: {
      'gpt-5.6-sol': {
        name: 'Sol Custom',
        contextWindow: 128000,
        maxTokens: 64000,
        input: ['text', 'image'],
        reasoningEfforts: false,
      },
    },
  })

  assert.deepEqual(models[0], {
    id: 'gpt-5.6-sol',
    name: 'Sol Custom',
    contextWindow: 128000,
    maxTokens: 64000,
    input: ['text', 'image'],
  })
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.6-sol', 'claude-opus-4-6'])
})

test('ignores empty or off-only reasoning overrides and rejects mismatched ones', () => {
  const base = {
    slug: 'thinker',
    max_context_window: 128000,
    supported_reasoning_levels: [{ effort: 'high' }],
  }
  for (const reasoningEfforts of [{}, { off: 'none' }]) {
    const model = modelProfileOf(base, {
      ...defaults,
      modelOverrides: { thinker: { reasoningEfforts } },
    })
    assert.deepEqual(model.reasoningEfforts, { high: 'high' })
  }
  assert.throws(() => modelProfileOf(base, {
    ...defaults,
    modelOverrides: { thinker: { reasoningEfforts: { high: 'ultra' } } },
  }), /maps to "max", not "high"/)
})

test('builds the Codex-compatible and standard catalog URLs', () => {
  assert.equal(
    catalogURL('http://127.0.0.1:8317/v1/'),
    'http://127.0.0.1:8317/v1/models?client_version=dsh-cliproxyapi-provider',
  )
  assert.equal(
    standardCatalogURL('http://127.0.0.1:8317/v1/'),
    'http://127.0.0.1:8317/v1/models',
  )
})

test('rejects malformed and empty catalogs', () => {
  assert.throws(() => readCodexCatalog({ object: 'list' }), /no "models" or "data" array/)
  assert.throws(() => readCodexCatalog({ data: [] }), /no usable models/)
  assert.throws(() => readCodexCatalog({ models: [] }), /no usable models/)
})
