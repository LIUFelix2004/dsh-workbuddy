/**
 * dsh-workbuddy —— 把 WorkBuddy 账号导入成 DSH 的模型提供商。
 *
 * 做法：把每个账号写成 `llm-pi-ai` 里的一条自定义 provider 路由
 * （OpenAI Chat Completions 协议，指向 copilot.tencent.com 网关），
 * 于是模型选择器里直接出现「WorkBuddy · 账号名」下的全部模型。
 *
 * 账号令牌走 DSH 凭据服务，不落在配置里。
 *
 * 另外装一层 fetch 守卫：WorkBuddy 网关会对 system/assistant 文本做渠道校验
 * （`You are an AI agent powered by DeepSeek Harness.`、`@` 引用说明、developer 角色
 * 都会触发 400/11128），守卫只改写发往它的 chat/completions 请求。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadCatalog, selectModels } from './catalog.js'
import { installFetchGuard } from './guard.js'

export const name = 'dsh-workbuddy'
export const inject = ['webServer']

const DEFAULT_BASE_URL = 'https://copilot.tencent.com/v2'
const DEFAULT_NAMESPACE = 'llm-pi-ai'
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** DSH 主目录（支持 DSH_HOME 覆盖）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'workbuddy', 'accounts.json')
}

function emptyStore() {
  return { version: 1, updatedAt: 0, accounts: [] }
}

function readStore() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) return emptyStore()
    return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, accounts: parsed.accounts.filter((a) => a && typeof a === 'object') }
  } catch {
    return emptyStore()
  }
}

function writeStore(store) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const payload = JSON.stringify({ ...store, version: 1, updatedAt: Date.now() }, null, 2)
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- 账号解析

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function looksEncrypted(value) {
  return value !== null && typeof value === 'object' && (value.wbEncrypted !== undefined || value.$wbEncrypted !== undefined || typeof value.envelope === 'string')
}

/** 从任意粘贴文本里切出顶层 JSON 值（对象或数组），容忍前后缀文字与多个对象拼接。 */
export function extractJsonBlocks(text) {
  const blocks = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return blocks
}

/** 把一段文本解析成「候选账号对象」列表。 */
export function collectAccountObjects(text) {
  const candidates = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const key of ['accounts', 'allAccounts', 'items', 'list', 'data']) {
      const nested = value[key]
      if (Array.isArray(nested) && nested.length > 0 && nested.every((item) => item !== null && typeof item === 'object')) {
        for (const item of nested) visit(item)
        return
      }
    }
    candidates.push(value)
  }
  for (const block of extractJsonBlocks(text)) {
    try {
      visit(JSON.parse(block))
    } catch {
      // 忽略无法解析的片段
    }
  }
  return candidates
}

function routeFromToken(token, uid) {
  const digest = createHash('sha256').update(`${token}|${uid ?? ''}`).digest('hex').slice(0, 8)
  return { route: `wb-${digest}`, claim: `WORKBUDDY_WB_${digest.toUpperCase()}_API_KEY`, id: digest }
}

/**
 * 把一个候选对象归一化成账号记录。
 * @returns {{ ok: true, account: object } | { ok: false, reason: string }}
 */
export function normalizeAccount(source, index) {
  if (source === null || typeof source !== 'object') return { ok: false, reason: '不是一个 JSON 对象' }
  const auth = source.auth !== null && typeof source.auth === 'object' ? source.auth : {}
  const accountInfo = source.account !== null && typeof source.account === 'object' ? source.account : {}

  const rawToken = source.accessToken ?? source.access_token ?? source.token ?? source.apiKey ?? source.api_key ?? source.key ?? auth.accessToken ?? auth.access_token ?? auth.token
  if (looksEncrypted(rawToken)) {
    return { ok: false, reason: '这个文件里的 token 是加密的（$wbEncrypted），需要在 WorkBuddy 里生成 API Key（ck_ 开头）或从网页版复制明文 accessToken' }
  }
  const token = firstString(rawToken, typeof rawToken === 'string' ? rawToken : undefined)
  if (token === undefined) return { ok: false, reason: '没有找到 accessToken / token / apiKey 字段' }
  if (token.length < 16) return { ok: false, reason: 'token 太短，看起来不像有效凭据' }

  const uid = firstString(source.uid, source.userId, source.user_id, source.userUid, accountInfo.uid, accountInfo.userId)
  const enterpriseId = firstString(source.enterpriseId, source.tenantId, accountInfo.enterpriseId)
  const declaredProduct = firstString(source.product, source.accountType, source.type, accountInfo.type)
  const isApiKey = token.startsWith('ck_')
  const product = declaredProduct ?? (isApiKey ? 'SaaS' : 'personal')
  const label = firstString(
    source.name,
    source.nickname,
    source.displayName,
    source.remark,
    typeof accountInfo.nickname === 'string' ? accountInfo.nickname : undefined,
    accountInfo.email,
    source.email,
  )
  const name = label ?? `WorkBuddy ${index + 1}`
  const baseURL = firstString(source.baseURL, source.baseUrl, source.endpoint, source.apiBase) ?? DEFAULT_BASE_URL
  const modelFilter = Array.isArray(source.models)
    ? source.models.map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string' && id !== '')
    : undefined

  const { route, claim, id } = routeFromToken(token, uid)
  return {
    ok: true,
    account: {
      id,
      route,
      credentialRef: claim,
      name,
      token,
      uid: uid ?? null,
      enterpriseId: enterpriseId ?? null,
      product,
      baseURL,
      modelFilter: modelFilter ?? null,
      createdAt: Date.now(),
      lastTest: null,
    },
  }
}

// ---------------------------------------------------------------- 提供商配置

function buildProfile(account, models) {
  const headers = {}
  if (account.uid !== null && account.uid !== undefined) headers['X-User-Id'] = String(account.uid)
  if (account.product !== undefined && account.product !== '') headers['X-Product'] = String(account.product)
  if (account.enterpriseId !== null && account.enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = String(account.enterpriseId)
    headers['X-Tenant-Id'] = String(account.enterpriseId)
  }
  return {
    displayName: `WorkBuddy · ${account.name}`,
    api: 'openai-completions',
    baseURL: account.baseURL,
    apiKeyEnv: account.credentialRef,
    headers,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    },
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    timeoutMs: 600000,
    streamIdleTimeoutMs: 300000,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.ctx > 0 ? { contextWindow: model.ctx } : {}),
      ...(model.out > 0 ? { maxTokens: model.out } : {}),
      input: model.img === true ? ['text', 'image'] : ['text'],
    })),
  }
}

// ---------------------------------------------------------------- 余额（积分）

/** 余额缓存：面板先看缓存，点「刷新余额」才真正打接口。 */
const balanceCache = new Map()

/** 账号的 REST 网关 origin：额度接口在根域下，不在 chat 的 /v2 前缀里。 */
function accountOrigin(account) {
  try {
    return new URL(account.baseURL).origin
  } catch {
    return 'https://www.workbuddy.cn'
  }
}

function toCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function balanceHeaders(account) {
  const headers = {
    authorization: `Bearer ${account.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-language': 'zh',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-private-data': 'true',
    'user-agent': 'WorkBuddy/5.11.3',
  }
  if (account.uid) headers['x-user-id'] = String(account.uid)
  if (account.product) headers['x-product'] = String(account.product)
  return headers
}

function cachedBalance(route) {
  return balanceCache.get(route)?.data ?? null
}

/**
 * 查一个账号的积分余额。
 *
 * 个人账号：POST /billing/meter/get-user-resource-summary
 *   → TotalCredits + CreditGroups[CycleTotalCapacity / CycleRemainCapacity] + SubscriptionPackageName
 * 企业账号：POST /billing/meter/get-enterprise-user-usage（带 X-Enterprise-Id）
 *   → { limitNum, credit, cycleResetTime }
 */
async function fetchBalance(account) {
  const origin = accountOrigin(account)
  const fetchedAt = Date.now()
  const headers = balanceHeaders(account)
  try {
    if (account.enterpriseId) {
      headers['x-enterprise-id'] = String(account.enterpriseId)
      headers['x-tenant-id'] = String(account.enterpriseId)
      const response = await fetch(`${origin}/billing/meter/get-enterprise-user-usage`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(15000),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      const row = parsed?.data?.data ?? parsed?.data ?? parsed
      const limit = toCount(row?.limitNum)
      if (response.ok && row !== undefined && row !== null && limit > 0) {
        const used = toCount(row?.credit)
        return {
          ok: true,
          status: response.status,
          fetchedAt,
          source: 'enterprise',
          plan: '企业版',
          paid: true,
          total: limit,
          remain: Math.max(0, limit - used),
          used,
          groups: [],
          resetAt: row?.cycleResetTime ? Date.parse(row.cycleResetTime) || null : null,
        }
      }
      return { ok: false, status: response.status, fetchedAt, source: 'enterprise', message: upstreamHint(response.status, text.slice(0, 200)) }
    }

    const response = await fetch(`${origin}/billing/meter/get-user-resource-summary`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const data = parsed?.data
    if (!response.ok || parsed === null || parsed.code !== 0 || data === undefined || data === null) {
      return { ok: false, status: response.status, fetchedAt, source: 'personal', message: upstreamHint(response.status, text.slice(0, 200)) }
    }
    const groups = (Array.isArray(data.CreditGroups) ? data.CreditGroups : [])
      .map((group) => ({
        kind: String(group?.Kind ?? ''),
        name: String(group?.Name ?? group?.Kind ?? ''),
        total: toCount(group?.CycleTotalCapacity),
        remain: toCount(group?.CycleRemainCapacity),
        used: toCount(group?.CycleUsedCapacity),
      }))
      .filter((group) => group.total > 0 || group.remain > 0 || group.used > 0)
    const packages = Array.isArray(data.Packages) ? data.Packages : []
    const total = toCount(data.TotalCredits) || packages.reduce((sum, row) => sum + toCount(row?.CycleTotalCapacity), 0)
    const groupRemain = groups.reduce((sum, group) => sum + group.remain, 0)
    const remain = groups.length > 0 ? (total > 0 ? Math.min(total, groupRemain) : groupRemain) : packages.reduce((sum, row) => sum + toCount(row?.CycleRemainCapacity), 0)
    return {
      ok: true,
      status: response.status,
      fetchedAt,
      source: 'personal',
      plan: String(data.SubscriptionPackageName ?? ''),
      paid: data.IsPaidUser === true,
      total,
      remain,
      used: Math.max(0, total - remain),
      groups,
    }
  } catch (error) {
    return { ok: false, status: 0, fetchedAt, source: 'personal', message: `查询余额失败：${error?.message ?? error}` }
  }
}

function maskToken(token) {
  if (typeof token !== 'string') return ''
  if (token.length <= 12) return `${token.slice(0, 3)}***`
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

function publicAccount(account, catalog) {
  const models = selectModels(catalog.models, account.modelFilter)
  return {
    id: account.id,
    route: account.route,
    name: account.name,
    uid: account.uid,
    product: account.product,
    baseURL: account.baseURL,
    token: maskToken(account.token),
    credentialRef: account.credentialRef,
    modelCount: models.length,
    modelFilter: account.modelFilter,
    createdAt: account.createdAt,
    lastTest: account.lastTest ?? null,
    balance: cachedBalance(account.route) ?? account.lastBalance ?? null,
  }
}

// ---------------------------------------------------------------- HTTP 工具

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 只接受本机页面发起的调用：跨站请求一律拒绝。 */
function sameOrigin(request) {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin === 'string' && origin !== '' && typeof host === 'string' && host !== '') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return true
}

function joinUrl(baseURL, suffix) {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}${suffix}`
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const namespace = typeof config.settingsNamespace === 'string' && config.settingsNamespace !== '' ? config.settingsNamespace : DEFAULT_NAMESPACE

  // 渠道校验守卫：只改写发往 WorkBuddy 网关的 chat/completions 请求。
  const guard = installFetchGuard(logger)
  ctx.effect(() => () => guard.dispose(), 'workbuddy: fetch guard')

  const services = { settings: undefined, credentials: undefined }
  ctx.inject(['settings', 'credentials'], (child) => {
    services.settings = child.settings
    services.credentials = child.credentials
  })

  /** 找到真正承载 providers 字典的 settings 命名空间。 */
  function resolveNamespace() {
    const settings = services.settings
    if (settings === undefined) return undefined
    let rows = []
    try {
      rows = settings.describe?.({ redactSecrets: true }) ?? []
    } catch {
      rows = []
    }
    const hasProviders = (row) => {
      try {
        return JSON.stringify(row?.schema ?? {}).includes('"providers"')
      } catch {
        return false
      }
    }
    const preferred = rows.find((row) => row?.ns === namespace && hasProviders(row))
    if (preferred !== undefined) return preferred.ns
    const anyProviders = rows.find((row) => hasProviders(row))
    return anyProviders?.ns
  }

  function currentCatalog() {
    return loadCatalog()
  }

  async function applyAccount(account, catalog) {
    const settings = services.settings
    const credentials = services.credentials
    if (settings === undefined || credentials === undefined) throw new Error('DSH 的 settings / credentials 服务还没就绪，稍后再试')
    const ns = resolveNamespace()
    if (ns === undefined) throw new Error(`没有找到带 providers 的 settings 命名空间（期望 ${namespace}）`)
    const models = selectModels(catalog.models, account.modelFilter)
    if (models.length === 0) throw new Error('模型目录为空，无法建立提供商')
    await credentials.set(account.credentialRef, account.token)
    await settings.mutate(ns, [{ op: 'set', path: ['providers', account.route], value: buildProfile(account, models) }])
    return { namespace: ns, modelCount: models.length }
  }

  async function removeAccount(account) {
    const settings = services.settings
    const credentials = services.credentials
    if (settings !== undefined) {
      const ns = resolveNamespace()
      if (ns !== undefined) {
        try {
          await settings.mutate(ns, [{ op: 'unset', path: ['providers', account.route] }])
        } catch (error) {
          logger.warn?.(`workbuddy: 移除路由 ${account.route} 失败：${error?.message ?? error}`)
        }
      }
    }
    if (credentials !== undefined) {
      try {
        await credentials.unset(account.credentialRef)
      } catch {
        // 凭据可能本来就不存在
      }
    }
  }

  async function testAccount(account, catalog) {
    const models = selectModels(catalog.models, account.modelFilter)
    const modelId = models[0]?.id ?? 'glm-5.3-flash'
    const headers = {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-request-id': `dsh-wb-${Date.now().toString(16)}`,
    }
    if (account.uid) headers['x-user-id'] = String(account.uid)
    if (account.product) headers['x-product'] = String(account.product)
    if (account.enterpriseId) headers['x-enterprise-id'] = String(account.enterpriseId)
    const started = Date.now()
    try {
      const response = await fetch(joinUrl(account.baseURL, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(25000),
      })
      const text = await response.text().catch(() => '')
      const ms = Date.now() - started
      const snippet = text.replace(/\s+/g, ' ').slice(0, 400)
      return {
        ok: response.ok,
        status: response.status,
        ms,
        model: modelId,
        snippet,
        message: response.ok ? `连接正常（${modelId}，${ms}ms）` : upstreamHint(response.status, snippet),
      }
    } catch (error) {
      return { ok: false, status: 0, ms: Date.now() - started, model: modelId, snippet: '', message: `连接失败：${error?.message ?? error}` }
    }
  }

  function upstreamHint(status, snippet) {
    if (status === 401 || status === 403) return '鉴权失败：accessToken 过期或不是这个账号的（JWT 约 60 天有效期），请重新复制一次'
    if (status === 429) return '触发限流：这个账号请求太密，稍后再试或换账号'
    if (status === 404) return '端点不存在：确认 baseURL 是 https://copilot.tencent.com/v2'
    return `上游返回 HTTP ${status}：${snippet || '（无内容）'}`
  }

  async function statePayload() {
    const catalog = currentCatalog()
    const store = readStore()
    return {
      ok: true,
      namespace: resolveNamespace() ?? null,
      serviceReady: services.settings !== undefined && services.credentials !== undefined,
      storePath: stateFile(),
      defaultBaseURL: DEFAULT_BASE_URL,
      guard: guard.stats(),
      catalog: { source: catalog.source, path: catalog.path ?? null, count: catalog.models.length, models: catalog.models },
      accounts: store.accounts.map((account) => publicAccount(account, catalog)),
    }
  }

  const routes = []

  const register = (kind, routePath, handler) => {
    const spec = {
      kind,
      path: routePath,
      handler: async (request, response) => {
        if (!sameOrigin(request)) {
          json(response, 403, { ok: false, error: 'cross-site request refused' })
          return
        }
        try {
          await handler(request, response)
        } catch (error) {
          logger.warn?.(`workbuddy: ${routePath} failed: ${error?.stack ?? error}`)
          if (!response.headersSent) json(response, 500, { ok: false, error: String(error?.message ?? error) })
          else response.end()
        }
      },
    }
    routes.push(ctx.effect(() => ctx.webServer.register(spec)))
  }

  register('exact', '/workbuddy/state', async (request, response) => {
    json(response, 200, await statePayload())
  })

  register('exact', '/workbuddy/catalog', (request, response) => {
    const catalog = currentCatalog()
    json(response, 200, { ok: true, source: catalog.source, path: catalog.path ?? null, count: catalog.models.length, models: catalog.models })
  })

  register('exact', '/workbuddy/import', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = await readBody(request)
    let payload = {}
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      json(response, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.trim() === '') {
      json(response, 400, { ok: false, error: '没有收到账号 JSON' })
      return
    }
    const replace = payload.replace === true
    const alsoTest = payload.test === true
    const catalog = currentCatalog()
    const store = replace ? emptyStore() : readStore()
    const byRoute = new Map(store.accounts.map((account) => [account.route, account]))
    const results = []
    const candidates = collectAccountObjects(text)
    if (candidates.length === 0) {
      json(response, 400, { ok: false, error: '没解析出任何 JSON 对象，检查粘贴内容' })
      return
    }
    for (const [index, candidate] of candidates.entries()) {
      const normalized = normalizeAccount(candidate, index)
      if (!normalized.ok) {
        results.push({ ok: false, name: `#${index + 1}`, error: normalized.reason })
        continue
      }
      const account = { ...normalized.account, createdAt: byRoute.get(normalized.account.route)?.createdAt ?? Date.now() }
      try {
        const applied = await applyAccount(account, catalog)
        if (alsoTest) account.lastTest = { ...(await testAccount(account, catalog)), at: Date.now() }
        account.lastBalance = await fetchBalance(account)
        balanceCache.set(account.route, { at: Date.now(), data: account.lastBalance })
        byRoute.set(account.route, account)
        results.push({
          ok: true,
          name: account.name,
          route: account.route,
          models: applied.modelCount,
          namespace: applied.namespace,
          lastTest: account.lastTest,
          balance: account.lastBalance,
        })
      } catch (error) {
        results.push({ ok: false, name: account.name, route: account.route, error: String(error?.message ?? error) })
      }
    }
    store.accounts = [...byRoute.values()]
    writeStore(store)
    json(response, 200, { ok: results.some((item) => item.ok), results, state: await statePayload() })
  })

  register('exact', '/workbuddy/apply', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const catalog = currentCatalog()
    const store = readStore()
    const results = []
    for (const account of store.accounts) {
      try {
        const applied = await applyAccount(account, catalog)
        results.push({ ok: true, name: account.name, route: account.route, models: applied.modelCount, namespace: applied.namespace })
      } catch (error) {
        results.push({ ok: false, name: account.name, route: account.route, error: String(error?.message ?? error) })
      }
    }
    json(response, 200, { ok: results.every((item) => item.ok), results, state: await statePayload() })
  })

  register('exact', '/workbuddy/test', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    const store = readStore()
    const account = store.accounts.find((item) => item.route === body.route || item.id === body.id)
    if (account === undefined) {
      json(response, 404, { ok: false, error: '没有这个账号' })
      return
    }
    const result = await testAccount(account, currentCatalog())
    account.lastTest = { ...result, at: Date.now() }
    writeStore(store)
    json(response, 200, { ok: result.ok, result, state: await statePayload() })
  })

  register('exact', '/workbuddy/balance', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    const store = readStore()
    const targets = body.route === undefined || body.route === null
      ? store.accounts
      : store.accounts.filter((item) => item.route === body.route || item.id === body.id)
    if (targets.length === 0) {
      json(response, 404, { ok: false, error: '没有这个账号' })
      return
    }
    const results = []
    for (const account of targets) {
      const balance = await fetchBalance(account)
      account.lastBalance = balance
      balanceCache.set(account.route, { at: Date.now(), data: balance })
      results.push({ route: account.route, name: account.name, ok: balance.ok, balance })
    }
    writeStore(store)
    json(response, 200, { ok: results.every((item) => item.ok), results, state: await statePayload() })
  })

  register('exact', '/workbuddy/remove', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    const store = readStore()
    const account = store.accounts.find((item) => item.route === body.route || item.id === body.id)
    if (account === undefined) {
      json(response, 404, { ok: false, error: '没有这个账号' })
      return
    }
    await removeAccount(account)
    balanceCache.delete(account.route)
    store.accounts = store.accounts.filter((item) => item !== account)
    writeStore(store)
    json(response, 200, { ok: true, removed: account.route, state: await statePayload() })
  })

  register('exact', '/workbuddy/local', async (request, response) => {
    // 便利入口：本机 WorkBuddy 桌面端登录过的账号（凭据有时是加密的，那就给出说明）。
    const file = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    if (!fs.existsSync(file)) {
      json(response, 404, { ok: false, error: `没找到本机 WorkBuddy 登录信息：${file}` })
      return
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const normalized = normalizeAccount(parsed, 0)
      if (!normalized.ok) {
        json(response, 200, { ok: false, file, error: normalized.reason })
        return
      }
      const catalog = currentCatalog()
      const applied = await applyAccount(normalized.account, catalog)
      const store = readStore()
      store.accounts = [...store.accounts.filter((item) => item.route !== normalized.account.route), normalized.account]
      writeStore(store)
      json(response, 200, { ok: true, file, account: normalized.account.name, models: applied.modelCount, state: await statePayload() })
    } catch (error) {
      json(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 启动时把已存的账号重新挂上（DSH 重启后路由自动回来）。
  queueMicrotask(async () => {
    const store = readStore()
    if (store.accounts.length === 0) return
    const catalog = currentCatalog()
    let restored = 0
    for (const account of store.accounts) {
      try {
        await applyAccount(account, catalog)
        restored += 1
      } catch (error) {
        logger.warn?.(`workbuddy: 恢复账号 ${account.name} 失败：${error?.message ?? error}`)
      }
    }
    if (restored > 0) logger.info?.(`workbuddy: 已恢复 ${restored} 个账号的模型路由`)
  })

  ctx.effect(() => () => {
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch {
        // 卸载阶段的失败不影响其他插件
      }
    }
  }, 'workbuddy: routes')
}
