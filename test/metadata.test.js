import test from 'node:test'
import assert from 'node:assert/strict'
import { readCatalog } from '../src/catalog.js'
import {
  buildLiteLlmMetadataIndex,
  buildOpenRouterMetadataIndex,
  buildPiAiMetadataIndex,
  calibrateCatalogEntry,
  calibrateCatalogPayload,
  candidateKeysForModelId,
  createMetadataResolver,
  entryNeedsCalibration,
  isBareModelEntry,
  isCodexReasoningTemplate,
  isPlaceholderContext,
  isSyntheticCodexTemplate,
  isSyntheticMaxTokens,
  loadPiAiMetadataIndex,
  lookupModelMetadata,
} from '../src/metadata.js'

const defaults = {
  defaultContextWindow: 262144,
  defaultMaxTokens: 32768,
  defaultInput: ['text'],
}

test('normalizes channel prefixes, variant suffixes, and version separators into candidate keys', () => {
  const opusKeys = candidateKeysForModelId('claude-opus-5-5-high')
  assert.ok(opusKeys.includes('claude-opus-5-5-high'))
  assert.ok(opusKeys.includes('claude-opus-5-5'))
  assert.ok(opusKeys.includes('claude-opus-5.5'))

  const intlKeys = candidateKeysForModelId('cn/deepseek-v4.1-flash')
  assert.ok(intlKeys.includes('cn/deepseek-v4.1-flash'))
  assert.ok(intlKeys.includes('deepseek-v4.1-flash'))
  assert.ok(intlKeys.includes('deepseek-v4-1-flash'))

  const grokKeys = candidateKeysForModelId('grok-4.7-build-fast')
  assert.ok(grokKeys.includes('grok-4.7'))
  assert.ok(grokKeys.includes('grok-4-7'))
})

test('detects synthetic max tokens including 100% and OpenRouter 90% caps', () => {
  assert.equal(isSyntheticMaxTokens(1048576, 1048576), true)
  assert.equal(isSyntheticMaxTokens(500000, 500000), true)
  assert.equal(isSyntheticMaxTokens(500000, 450000), true)
  assert.equal(isSyntheticMaxTokens(1048576, 943718), true)
  assert.equal(isSyntheticMaxTokens(1000000, 128000), false)
  assert.equal(isSyntheticMaxTokens(200000, 64000), false)
})

test('pins placeholder context and synthetic-cap boundaries', () => {
  for (const value of [500000, 872000, '500000', ' 872000 ']) {
    assert.equal(isPlaceholderContext(value), true, String(value))
  }
  for (const value of [499999, 500001, 871999, 872001, 262144, 0, -1, 500000.5, null, undefined]) {
    assert.equal(isPlaceholderContext(value), false, String(value))
  }

  // A cap that consumes the whole window is synthesized at any size.
  assert.equal(isSyntheticMaxTokens(16384, 16384), true)
  assert.equal(isSyntheticMaxTokens(65536, 65536), true)
  assert.equal(isSyntheticMaxTokens(65536, 32768), false)

  assert.equal(isSyntheticMaxTokens(200000, 200000), true)
  assert.equal(isSyntheticMaxTokens(200000, 200001), true)
  assert.equal(isSyntheticMaxTokens(200000, 199999), false)

  // 90% estimate with one token of rounding slack on either side.
  for (const context of [1000000, 1048576, 1000005]) {
    const estimate = Math.round(context * 0.9)
    for (const delta of [-1, 0, 1]) {
      assert.equal(isSyntheticMaxTokens(context, estimate + delta), true, `${context}:${delta}`)
    }
    assert.equal(isSyntheticMaxTokens(context, estimate - 2), false, `${context}:-2`)
    assert.equal(isSyntheticMaxTokens(context, estimate + 2), false, `${context}:+2`)
  }

  assert.equal(isSyntheticMaxTokens(1048576, 128000), false)
  assert.equal(isSyntheticMaxTokens(200000, 64000), false)
  assert.equal(isSyntheticMaxTokens(undefined, 128000), false)
  assert.equal(isSyntheticMaxTokens(200000, undefined), false)
})

test('merges metadata across pi-ai, OpenRouter, and LiteLLM by priority while rejecting synthetic caps', () => {
  const piAiIndex = buildPiAiMetadataIndex([
    {
      provider: 'xai',
      models: [{
        id: 'grok-4.7',
        name: 'Grok 4.7',
        contextWindow: 500000,
        maxTokens: 500000, // synthetic 100% cap -> filtered out
        input: ['text', 'image'],
        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        reasoning: true,
      }],
    },
  ])
  const openRouterIndex = buildOpenRouterMetadataIndex({
    data: [
      {
        id: 'x-ai/grok-4.7',
        name: 'xAI: Grok 4.7',
        context_length: 500000,
        top_provider: {
          context_length: 500000,
          max_completion_tokens: 450000, // synthetic 90% cap -> filtered out
        },
        architecture: {
          modality: 'text+image->text',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
      },
      {
        id: 'novel-vendor/brand-new-model',
        name: 'Novel: Brand New Model',
        context_length: '256000',
        max_Output_tokens: '64000',
        top_provider: {
          max_completion_tokens: 64000,
        },
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        reasoning_options: [
          { type: 'effort', values: ['none', 'low', 'medium', 'high', 'ultra'] },
        ],
      },
    ],
  })
  const liteLlmIndex = buildLiteLlmMetadataIndex({
    'xai/grok-4.7': {
      litellm_provider: 'xai',
      mode: 'chat',
      max_input_tokens: 500000,
      max_output_tokens: 128000, // real output limit from lower-priority source
      supports_vision: true,
      supports_reasoning: true,
    },
    'text-embedding-3-large': {
      litellm_provider: 'openai',
      mode: 'embedding',
      max_input_tokens: 8191,
    },
  })

  const grok = lookupModelMetadata('grok-4.7-build-fast', [piAiIndex, openRouterIndex, liteLlmIndex])
  assert.deepEqual(grok, {
    name: 'Grok 4.7',
    contextWindow: 500000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    reasoning: true,
  })

  const novel = lookupModelMetadata('cn/brand-new-model-intl', [piAiIndex, openRouterIndex, liteLlmIndex])
  assert.deepEqual(novel, {
    name: 'Brand New Model',
    contextWindow: 256000,
    maxTokens: 64000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'ultra' },
    reasoning: true,
  })

  assert.equal(lookupModelMetadata('text-embedding-3-large', [liteLlmIndex]), undefined)
})

test('detects placeholder context sizes and CLIProxyAPI level templates', () => {
  assert.equal(isPlaceholderContext(500000), true)
  assert.equal(isPlaceholderContext(872000), true)
  assert.equal(isPlaceholderContext('500000'), true)
  assert.equal(isPlaceholderContext(500001), false)
  assert.equal(isPlaceholderContext(undefined), false)

  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  assert.equal(isCodexReasoningTemplate({ slug: 'claude-opus-5-5', supported_reasoning_levels: levels }), true)
  assert.equal(isCodexReasoningTemplate({ slug: 'claude-opus-5-5', supported_reasoning_levels: [...levels, 'ultra'] }), true)
  assert.equal(isCodexReasoningTemplate({
    slug: 'claude-opus-5-5',
    supported_reasoning_levels: ['minimal', ...levels],
  }), true)
  assert.equal(isCodexReasoningTemplate({ slug: 'claude-opus-5-5', thinking: { levels: ['low', 'medium', 'high', 'xhigh', 'ultra'] } }), true)
  assert.equal(isCodexReasoningTemplate({ slug: 'plain', supported_reasoning_levels: ['low', 'high'] }), false)

  // Real publishers of these lists keep their levels.
  for (const slug of ['gemini-3-flash', 'grok-4.6', 'grok-4.7-build-fast', 'gpt-5.6-sol', 'codex-mini', 'o3-mini']) {
    assert.equal(isCodexReasoningTemplate({ slug, supported_reasoning_levels: levels }), false, slug)
  }
  assert.equal(isCodexReasoningTemplate({ slug: 'gpt-oss-120b-medium', supported_reasoning_levels: levels }), true)
  assert.equal(isSyntheticCodexTemplate({ slug: 'plain', context_window: 500000 }), true)
  assert.equal(isSyntheticCodexTemplate({ slug: 'claude-opus-5-5', supported_reasoning_levels: levels }), true)
})

test('clears a placeholder level template and keeps a placeholder context when no metadata matches', () => {
  const entry = {
    slug: 'claude-sonnet-4-5-intl',
    context_window: 500000,
    input_modalities: ['text'],
    supported_reasoning_levels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
  }
  assert.equal(entryNeedsCalibration(entry), true)

  const [model] = readCatalog(calibrateCatalogPayload({ models: [entry] }, []), defaults)
  assert.deepEqual(model, {
    id: 'claude-sonnet-4-5-intl',
    name: 'claude-sonnet-4-5-intl',
    contextWindow: 500000,
    maxTokens: 32768,
    input: ['text'],
  })
})

test('replaces a level template only when metadata corroborates it', () => {
  const index = buildOpenRouterMetadataIndex({ data: [{
    id: 'vendor/claude-sonnet-4-5-intl',
    context_length: 200000,
    top_provider: { max_completion_tokens: 64000 },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    reasoning: { supported_efforts: ['low', 'medium', 'high'] },
  }] })
  const [model] = readCatalog(calibrateCatalogPayload({ models: [{
    slug: 'claude-sonnet-4-5-intl',
    context_window: 500000,
    max_context_window: 872000,
    supported_reasoning_levels: [
      { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' },
    ],
  }] }, [index]), defaults)

  assert.deepEqual(model, {
    id: 'claude-sonnet-4-5-intl',
    name: 'claude-sonnet-4-5-intl',
    contextWindow: 200000,
    maxTokens: 64000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
  })
})

test('falls back to boundary-aware fuzzy matching for unknown vendor suffixes', () => {
  const suffixIndex = buildOpenRouterMetadataIndex({ data: [{
    id: 'minimax/minimax-m3-instruct',
    context_length: 512000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  }] })
  assert.equal(lookupModelMetadata('cn/minimax-m3', [suffixIndex])?.contextWindow, 512000)

  const shortIndex = buildOpenRouterMetadataIndex({ data: [{
    id: 'minimax/minimax-m3',
    context_length: 256000,
    top_provider: { max_completion_tokens: 64000 },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  }] })
  assert.equal(lookupModelMetadata('cn/minimax-m3-instruct', [shortIndex])?.contextWindow, 256000)
  assert.equal(lookupModelMetadata('cn/unrelated', [suffixIndex]), undefined)
})

test('prefers the newest OpenRouter snapshot and indexes its Hugging Face id', () => {
  const index = buildOpenRouterMetadataIndex({ data: [
    {
      id: 'vendor/model',
      created: 1,
      context_length: 100000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
    {
      id: 'vendor/model',
      created: 2,
      context_length: 200000,
      hugging_face_id: 'org/model',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ] })
  assert.equal(lookupModelMetadata('vendor/model', [index])?.contextWindow, 200000)
  assert.equal(lookupModelMetadata('org/model', [index])?.contextWindow, 200000)
})

test('calibrates CLIProxyAPI synthetic Codex templates, empty reasoning arrays, synthetic maxTokens, and bare entries', async () => {
  const piAiIndex = await loadPiAiMetadataIndex()
  assert.ok(piAiIndex.size > 0)

  const syntheticEntry = {
    slug: 'claude-sonnet-4-5-intl',
    display_name: 'claude-sonnet-4-5-intl',
    context_window: 500000,
    max_context_window: 872000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
  }
  assert.equal(isSyntheticCodexTemplate(syntheticEntry), true)
  assert.equal(entryNeedsCalibration(syntheticEntry), true)

  const opusHighEntry = {
    slug: 'claude-opus-5-5-high',
    display_name: 'Claude Opus 5.5 (High)',
    context_window: 1000000,
    max_context_window: 1000000,
    max_tokens: 128000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [],
  }
  assert.equal(entryNeedsCalibration(opusHighEntry), true)

  const argonEntry = {
    slug: 'gemini-4-argon-high',
    display_name: 'Gemini 4 Argon High',
    context_window: 1048576,
    max_context_window: 1048576,
    max_tokens: 1048576,
    input_modalities: ['text', 'image'],
    thinking: { levels: ['low', 'high'] },
  }
  assert.equal(entryNeedsCalibration(argonEntry), true)

  const bareEntry = {
    id: 'claude-opus-5-5-high',
    object: 'model',
    owned_by: 'anthropic',
  }
  assert.equal(isBareModelEntry(bareEntry), true)
  assert.equal(entryNeedsCalibration(bareEntry), true)

  const payload = calibrateCatalogPayload(
    { models: [syntheticEntry, opusHighEntry, argonEntry] },
    [piAiIndex],
  )
  const models = readCatalog(payload, defaults)

  // pi-ai knows the model supports reasoning but publishes no level map, so the
  // synthetic Codex levels are dropped instead of being forwarded as real ones.
  assert.deepEqual(models[0], {
    id: 'claude-sonnet-4-5-intl',
    name: 'claude-sonnet-4-5-intl',
    contextWindow: 200000,
    maxTokens: 64000,
    input: ['text', 'image'],
  })

  assert.deepEqual(models[1], {
    id: 'claude-opus-5-5-high',
    name: 'Claude Opus 5.5 (High)',
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  })

  assert.equal(models[2].contextWindow, 1048576)
  assert.equal(models[2].maxTokens, 32768)
  assert.deepEqual(models[2].reasoningEfforts, { low: 'low', high: 'high' })

  const barePayload = calibrateCatalogPayload({ object: 'list', data: [bareEntry] }, [piAiIndex])
  const bareModels = readCatalog(barePayload, defaults)
  assert.deepEqual(bareModels[0], {
    id: 'claude-opus-5-5-high',
    name: 'claude-opus-5-5-high',
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  })
})

test('preserves explicitly disabled thinking when calibrating', () => {
  const entry = {
    id: 'non-thinking-model',
    object: 'model',
    thinking: false,
  }
  const calibrated = calibrateCatalogEntry(entry, {
    contextWindow: 128000,
    maxTokens: 16384,
    input: ['text'],
    reasoningEfforts: { low: 'low', high: 'high' },
    reasoning: true,
  })
  assert.equal(calibrated.supported_reasoning_levels, undefined)
  assert.equal(calibrated.max_context_window, 128000)
  assert.equal(calibrated.max_output_tokens, 16384)
})

test('metadata resolver lazily cascades across sources, caches remote responses, and survives source failures', async () => {
  const previousFetch = globalThis.fetch
  const requestedURLs = []
  let failOpenRouter = false

  globalThis.fetch = async (url) => {
    const target = String(url)
    requestedURLs.push(target)
    if (target.includes('openrouter')) {
      if (failOpenRouter) {
        return new Response('upstream error', { status: 502 })
      }
      return new Response(JSON.stringify({
        data: [{
          id: 'openrouter-only/model-x',
          context_length: 200000,
          top_provider: { max_completion_tokens: 32000 },
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      'litellm-only/model-y': {
        litellm_provider: 'openai',
        mode: 'chat',
        max_input_tokens: 400000,
        max_output_tokens: 64000,
        supports_vision: true,
        supports_reasoning: true,
      },
    }), { status: 200 })
  }

  try {
    const emptyPiAi = async () => buildPiAiMetadataIndex([{
      provider: 'anthropic',
      models: [{
        id: 'claude-opus-5-5',
        contextWindow: 1000000,
        maxTokens: 128000,
        input: ['text', 'image'],
      }],
    }])

    const resolver = createMetadataResolver({
      metadataSources: ['pi-ai', 'openrouter', 'litellm'],
      openRouterModelsURL: 'https://openrouter.test/models',
      liteLlmModelsURL: 'https://litellm.test/models.json',
      metadataCacheTtlMs: 60000,
      loadPiAiIndex: emptyPiAi,
    })

    // 1. Satisfied by pi-ai -> does not fetch OpenRouter or LiteLLM
    const indexes1 = await resolver.resolveIndexesForPayloads([
      { data: [{ id: 'claude-opus-5-5-high', object: 'model' }] },
    ])
    assert.equal(indexes1.length, 1)
    assert.deepEqual(requestedURLs, [])

    // 2. Satisfied by OpenRouter -> fetches OpenRouter, skips LiteLLM
    const indexes2 = await resolver.resolveIndexesForPayloads([
      { data: [{ id: 'model-x', object: 'model' }] },
    ])
    assert.equal(indexes2.length, 2)
    assert.deepEqual(requestedURLs, ['https://openrouter.test/models'])

    // 3. Satisfied by LiteLLM -> uses cached OpenRouter, then fetches LiteLLM
    const indexes3 = await resolver.resolveIndexesForPayloads([
      { data: [{ id: 'model-y', object: 'model' }] },
    ])
    assert.equal(indexes3.length, 3)
    assert.deepEqual(requestedURLs, [
      'https://openrouter.test/models',
      'https://litellm.test/models.json',
    ])

    // 4. Stale-if-error fallback when cache expires and OpenRouter returns 502
    const uncachedResolver = createMetadataResolver({
      metadataSources: ['openrouter', 'litellm'],
      openRouterModelsURL: 'https://openrouter.test/models',
      liteLlmModelsURL: 'https://litellm.test/models.json',
      metadataCacheTtlMs: 0,
    })
    await uncachedResolver.resolveIndexesForPayloads([
      { data: [{ id: 'model-x', object: 'model' }] },
    ])
    failOpenRouter = true
    const fallbackIndexes = await uncachedResolver.resolveIndexesForPayloads([
      { data: [{ id: 'model-y', object: 'model' }] },
    ])
    assert.equal(fallbackIndexes.length, 2)
    assert.equal(lookupModelMetadata('model-x', fallbackIndexes)?.contextWindow, 200000)
    assert.equal(lookupModelMetadata('model-y', fallbackIndexes)?.maxTokens, 64000)
  } finally {
    globalThis.fetch = previousFetch
  }
})
