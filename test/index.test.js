import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  Config as PiAiConfig,
  apply as applyPiAi,
  inject as piAiInject,
  name as piAiName,
} from '@deepseek-ai/dsh-llm-pi-ai'
import {
  Config,
  PLACEHOLDER_AUTHORIZATION,
  PROFILE_SYNC_HEADER,
  apply,
} from '../src/index.js'

async function resolvedConfig(overrides = {}) {
  const result = await Config['~standard'].validate(overrides)
  assert.equal(result.issues, undefined)
  return result.value
}

function managedProfile(overrides = {}) {
  return {
    displayName: 'CLIProxyAPI',
    api: 'openai-responses',
    baseURL: 'http://127.0.0.1:8317/v1',
    models: [{ id: 'old', name: 'old', contextWindow: 1000, maxTokens: 100, input: ['text'] }],
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    headers: {},
    ...overrides,
  }
}

function createContext(initialSection, initialCredential) {
  let section = initialSection
  let revision = 1
  let credential = initialCredential
  const discoveries = new Map()
  const listeners = new Map()
  const mutations = []
  const warnings = []
  const effects = []
  const timeouts = []

  const ctx = {
    llm: {
      registerModelDiscovery(ns, handler) {
        discoveries.set(String(ns), handler)
        return () => discoveries.delete(String(ns))
      },
      registerConfigurableProviders() {
        throw new Error('the plugin must not own the configurable-provider directory')
      },
    },
    settings: {
      describe() {
        return section === undefined ? [] : [{ ns: 'llm-pi-ai', value: section, revision }]
      },
      async mutate(_ns, ops) {
        mutations.push(ops)
        const providers = { ...(section.providers || {}) }
        for (const op of ops) {
          assert.equal(op.path[0], 'providers')
          if (op.op === 'set') providers[op.path[1]] = op.value
          else delete providers[op.path[1]]
        }
        section = { ...section, providers }
        revision += 1
      },
    },
    credentials: {
      async resolve() {
        return credential === undefined ? undefined : { value: credential }
      },
    },
    on(event, listener) {
      const rows = listeners.get(event) || []
      rows.push(listener)
      listeners.set(event, rows)
      return () => listeners.set(event, rows.filter((row) => row !== listener))
    },
    effect(factory) {
      const cleanup = factory()
      const dispose = () => cleanup?.()
      effects.push(dispose)
      return dispose
    },
    timeout(callback, delay) {
      const row = { callback, delay, cancelled: false }
      timeouts.push(row)
      return () => { row.cancelled = true }
    },
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
  }

  return {
    ctx,
    discoveries,
    mutations,
    warnings,
    timeouts,
    get section() { return section },
    setSection(value) { section = value },
    setCredential(value) { credential = value },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args)
    },
    dispose() {
      for (const effect of effects.reverse()) effect()
    },
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('registers rich discovery without competing for the provider directory', async () => {
  const harness = createContext({ providers: {} })
  apply(harness.ctx, await resolvedConfig())
  assert.deepEqual([...harness.discoveries.keys()], ['llm-cliproxyapi'])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.mutations.length, 0)
  harness.dispose()
})

test('initial discovery requests the fixed rich catalog and returns full capabilities', async () => {
  const previousFetch = globalThis.fetch
  const requestURLs = []
  globalThis.fetch = async (url) => {
    requestURLs.push(String(url))
    return new Response(JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol',
      display_name: 'GPT 5.6 Sol',
      max_context_window: 372000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    const models = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'secret-key',
      signal: new AbortController().signal,
    })
    assert.deepEqual(requestURLs.sort(), [
      'http://127.0.0.1:8317/v1/models',
      'http://127.0.0.1:8317/v1/models?client_version=dsh-cliproxyapi-provider',
    ])
    assert.deepEqual(models[0], {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('merges standard catalog capacities into Codex discovery', async () => {
  const previousFetch = globalThis.fetch
  const requestURLs = []
  globalThis.fetch = async (url) => {
    const requestURL = String(url)
    requestURLs.push(requestURL)
    if (requestURL.includes('client_version=')) {
      return new Response(JSON.stringify({ models: [{
        slug: 'gpt-5.6-sol',
        display_name: 'GPT 5.6 Sol',
        max_context_window: 372000,
        input_modalities: ['text', 'image'],
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ object: 'list', data: [{
      id: 'gpt-5.6-sol',
      context_length: 372000,
      max_completion_tokens: 128000,
    }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    const models = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      signal: new AbortController().signal,
    })
    assert.deepEqual(models[0], {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 128000,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    assert.deepEqual(requestURLs.sort(), [
      'http://127.0.0.1:8317/v1/models',
      'http://127.0.0.1:8317/v1/models?client_version=dsh-cliproxyapi-provider',
    ])
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('falls back to the standard catalog when the Codex catalog fails', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('client_version=')) {
      return new Response(JSON.stringify({ error: 'unsupported' }), { status: 404 })
    }
    return new Response(JSON.stringify({ object: 'list', data: [
      {
        id: 'gemini-3-pro',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedInputModalities: ['text', 'image'],
      },
      {
        id: 'claude-opus-4-6',
        context_length: 200000,
        max_completion_tokens: 64000,
        thinking: { levels: ['low', 'high'], zero_allowed: true },
      },
    ] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    const models = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      signal: new AbortController().signal,
    })
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
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('applies excludedModels and modelOverrides during discovery', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('client_version=')) {
      return new Response(JSON.stringify({ models: [
        {
          slug: 'gpt-5.6-sol',
          max_context_window: 372000,
          supported_reasoning_levels: [{ effort: 'high' }],
        },
        { slug: 'gpt-5.6-sol-preview', max_context_window: 372000 },
        { slug: 'claude-opus-4-6', context_length: 200000 },
      ] }), { status: 200 })
    }
    return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig({
      excludedModels: ['*-preview'],
      modelOverrides: {
        'gpt-5.6-sol': {
          contextWindow: 128000,
          maxTokens: 64000,
          reasoningEfforts: false,
        },
      },
    }))
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.deepEqual(profile.models.map((model) => model.id), ['gpt-5.6-sol', 'claude-opus-4-6'])
    assert.equal(profile.models[0].contextWindow, 128000)
    assert.equal(profile.models[0].maxTokens, 64000)
    assert.equal(profile.models[0].reasoningEfforts, undefined)
    assert.equal(profile.models[1].maxTokens, 32768)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('first profile synchronization restores capabilities stripped by the browser RPC', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT 5.6 Sol',
        max_context_window: 372000,
        input_modalities: ['text', 'image'],
        supported_reasoning_levels: [
          { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
          { effort: 'xhigh' }, { effort: 'max' },
        ],
      },
      {
        slug: 'gpt-5.6-spark',
        display_name: 'GPT 5.6 Spark',
        input_modalities: ['text'],
      },
    ] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const discovered = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      signal: new AbortController().signal,
    })
    const bootstrapModels = discovered.map(({ id, name, contextWindow, maxTokens }) => ({
      id, name, contextWindow, maxTokens,
    }))
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({
        models: bootstrapModels,
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } })
    harness.emit('settings/document-updated', 'llm-pi-ai')

    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(fetches, 2)
    assert.equal(profile.headers[PROFILE_SYNC_HEADER], undefined)
    assert.deepEqual(profile.models[0], {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      },
      compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
    })
    assert.deepEqual(profile.models[1].input, ['text'])
    await waitFor(() => harness.timeouts.some((row) => row.delay === 300000))
    const periodic = harness.timeouts.find((row) => row.delay === 300000)
    periodic.callback()
    await waitFor(() => fetches === 4)
    await waitFor(() => harness.timeouts.filter((row) => row.delay === 300000).length === 2)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('credential refresh cannot finalize a pending bootstrap profile early', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [{
    slug: 'vision-model',
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'high' }],
  }] }), { status: 200 })
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({
        models: [{
          id: 'vision-model', name: 'Vision Model', contextWindow: 262144, maxTokens: 32768,
          input: ['text', 'image'], reasoningEfforts: { high: 'high' },
        }],
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } })
    harness.setCredential('secret-key')
    harness.emit('credentials/reference-updated', 'DSH_CLIPROXY_API_KEY')

    await waitFor(() => harness.mutations.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const profile = harness.mutations[0][0].value
    assert.equal(harness.mutations.length, 1)
    assert.equal(profile.headers[PROFILE_SYNC_HEADER], undefined)
    assert.equal(profile.apiKeyEnv, 'DSH_CLIPROXY_API_KEY')
    assert.deepEqual(profile.models[0].input, ['text', 'image'])
    assert.deepEqual(profile.models[0].reasoningEfforts, { high: 'high' })
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('keyless profiles omit apiKeyEnv and receive a non-sensitive placeholder header', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ models: [{ slug: 'model-a' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig())
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.apiKeyEnv, undefined)
    assert.equal(profile.headers.authorization, PLACEHOLDER_AUTHORIZATION)
    assert.equal(profile.models[0].id, 'model-a')
    harness.emit('settings/document-updated', 'llm-pi-ai')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(harness.mutations.length, 1)
    assert.equal(fetches, 2)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('refreshIntervalMs zero disables healthy periodic refreshes', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ models: [{ slug: 'model-a' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig({ refreshIntervalMs: 0 }))
    await waitFor(() => fetches === 2)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(harness.timeouts.length, 0)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('credential removal regenerates the profile in keyless mode', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [{ slug: 'model-a' }] }), { status: 200 })
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile({
        apiKeyEnv: 'DSH_CLIPROXY_API_KEY',
        headers: {
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } }, 'secret-key')
    apply(harness.ctx, await resolvedConfig())
    await waitFor(() => harness.mutations.length === 1)
    assert.equal(harness.mutations[0][0].value.apiKeyEnv, 'DSH_CLIPROXY_API_KEY')
    assert.equal(harness.mutations[0][0].value.headers.authorization, undefined)

    harness.mutations.length = 0
    harness.setCredential(undefined)
    harness.emit('credentials/reference-updated', 'DSH_CLIPROXY_API_KEY')
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.apiKeyEnv, undefined)
    assert.equal(profile.headers.authorization, PLACEHOLDER_AUTHORIZATION)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a newer settings change aborts stale discovery and only installs the latest profile', async () => {
  const previousFetch = globalThis.fetch
  let markFirstStarted
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('8317')) {
      markFirstStarted()
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    return new Response(JSON.stringify({ models: [{ slug: 'model-b' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig())
    await firstStarted
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({ baseURL: 'http://127.0.0.1:9417/v1' }),
    } })
    harness.emit('settings/document-updated', 'llm-pi-ai')
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.baseURL, 'http://127.0.0.1:9417/v1')
    assert.deepEqual(profile.models.map((model) => model.id), ['model-b'])
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('catalog requests honor timeout and failed refreshes use exponential backoff', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig({ fetchTimeoutMs: 10, retryInitialMs: 20, retryMaxMs: 80 }))
    await waitFor(() => harness.timeouts.length === 1)
    assert.equal(harness.timeouts[0].delay, 20)
    assert.match(harness.warnings[0], /timed out after 10 ms/)

    harness.timeouts[0].callback()
    await waitFor(() => harness.timeouts.length === 2)
    assert.equal(harness.timeouts[1].delay, 40)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('real Cordis composition leaves llm-pi-ai as the sole directory owner', async () => {
  const previousFetch = globalThis.fetch
  let inferenceAuthorization
  let catalogFetches = 0
  const document = {
    'llm-pi-ai': {
      providers: {},
    },
  }
  const revisions = { 'llm-pi-ai': 1 }

  class MemorySettings extends Service {
    constructor(ctx) {
      super(ctx, 'settings')
    }
    describe() {
      return Object.entries(document).map(([ns, value]) => ({
        ns,
        value: structuredClone(value),
        revision: revisions[ns],
      }))
    }
    async mutate(ns, ops, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== revisions[ns]) {
        throw new Error(`settings namespace "${ns}" moved past the expected revision`)
      }
      const next = structuredClone(document[ns] ?? {})
      for (const op of ops) {
        assert.equal(op.path[0], 'providers')
        next.providers = { ...(next.providers || {}), [op.path[1]]: structuredClone(op.value) }
      }
      document[ns] = next
      revisions[ns] += 1
      this.ctx.emit('settings/document-updated', ns, revisions[ns])
      this.onPersist?.(ns, structuredClone(next))
      return { ns, value: structuredClone(next), revision: revisions[ns] }
    }
  }

  class MemoryCredentials extends CredentialProvider {
    async resolve() { return undefined }
    async describe() { return { configured: false, writable: true } }
    async set() {}
    async unset() {}
  }

  class TimerService extends Service {
    constructor(ctx) {
      super(ctx, 'timer')
      ctx.mixin('timer', ['timeout'])
    }
    timeout(callback, delay) {
      return this.ctx.effect(() => {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      })
    }
  }

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'GET' && url.includes('/models?')) {
      catalogFetches += 1
      return new Response(JSON.stringify({ models: [
        { slug: 'plain', supported_reasoning_levels: [{ effort: 'none' }] },
        { slug: 'think', supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }] },
      ] }), { status: 200 })
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
    inferenceAuthorization = headers.get('authorization')
    return new Response(JSON.stringify({ error: { message: 'intentional test response' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }

  const ctx = new Context()
  const fibers = []
  try {
    fibers.push(ctx.plugin(LlmRuntime))
    fibers.push(ctx.plugin(MemorySettings))
    fibers.push(ctx.plugin(MemoryCredentials))
    fibers.push(ctx.plugin(TimerService))
    await Promise.all(fibers.map((fiber) => fiber.await()))

    const piFiber = ctx.plugin({
      name: piAiName,
      inject: piAiInject,
      Config: PiAiConfig,
      apply: applyPiAi,
    }, { providers: {} })
    const cpaFiber = ctx.plugin({ name: 'llm-cliproxyapi', inject: ['settings', 'credentials', 'llm', 'timer'], Config, apply }, {
      retryInitialMs: 10,
      retryMaxMs: 20,
    })
    fibers.push(piFiber, cpaFiber)
    await Promise.all([piFiber.await(), cpaFiber.await()])

    // Stand in for the host config editor: a persisted settings section
    // reaches llm-pi-ai as a fresh plugin config.
    ctx.settings.onPersist = (ns, value) => {
      if (ns === 'llm-pi-ai') piFiber.update({ providers: value.providers })
    }

    const discovered = await ctx.llm.discoverModels('llm-cliproxyapi', {
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      signal: new AbortController().signal,
    })
    assert.equal(discovered[0].input, undefined)
    assert.equal(discovered[1].reasoningEfforts, undefined)
    await ctx.settings.mutate('llm-pi-ai', [{
      op: 'set',
      path: ['providers', 'CLIProxyAPI'],
      value: managedProfile({
        models: discovered,
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:integration-test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    }])

    await waitFor(() => document['llm-pi-ai']?.providers?.CLIProxyAPI?.models?.[0]?.id === 'plain')
    await waitFor(() => document['llm-pi-ai'].providers.CLIProxyAPI.headers[PROFILE_SYNC_HEADER] === undefined)
    assert.equal(catalogFetches, 1)
    const directories = ctx.llm.listConfigurableProviders().filter((entry) => entry.provider === 'CLIProxyAPI')
    assert.equal(directories.length, 1)
    assert.equal(directories[0].settingsNs, 'llm-pi-ai')
    assert.equal(ctx.llm.listProviders().some((provider) => provider.id === 'CLIProxyAPI'), true)
    const models = document['llm-pi-ai'].providers.CLIProxyAPI.models
    assert.equal(models[0].reasoningEfforts, undefined)
    assert.deepEqual(models[1].reasoningEfforts, { off: 'none', high: 'high' })

    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'CLIProxyAPI',
      model: 'plain',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'probe' }],
        source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    assert.equal(inferenceAuthorization, PLACEHOLDER_AUTHORIZATION)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.notEqual(chunks.at(-1)?.reason?.failure?.code, 'MISSING_CREDENTIAL')
  } finally {
    globalThis.fetch = previousFetch
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
  }
})
