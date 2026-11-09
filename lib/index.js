/**
 * dsh-session-ecology — Host Steward, Agent Tools & SSE/HTTP Bridge.
 *
 * Maintains DSH conversation ecology across interactive chats and scheduled patrols:
 * 1) Model-adaptive 3-gate threshold (`pressure >= 0.40W` || `surface >= 1.00W` || `total >= 350W/150W`);
 * 2) Never interrupts active turns — triggers strictly after `turn/end` (`completed`) & idle inbox;
 * 3) Self-summarized rollover on warm KV cache (with GPT/Opus zero-unprompted-call override + mechanical fallback);
 * 4) Same-workspace continuation inheriting `agentPreset`, `modelSelection`, `permissionPreset`, and `pin`,
 *    with 80-byte UTF-8 chain title (`· #2`, `#3`) protected against Turn-1 auto-title overwrite;
 * 5) Atomic create-verify-delete schedule migration + post-turn archival of old session;
 * 6) Real-time SSE broadcast to Web companion + loopback Feishu report push via `dsh-plugin-notify-feishu`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ECOLOGY_CONFIG,
  buildContinuationTitle,
  buildMechanicalFallbackSummary,
  buildSelfSummaryPrompt,
  collectBotSessionIds,
  evaluateSessionEcology,
  formatCompactTokens,
  inheritAnnotationForContinuation,
  parseTitleGeneration,
  renderContinuationOpeningPrompt,
  renderFeishuEcologyReport,
  renderHandoffArchiveMarkdown,
  scheduleCreateRequestOf,
  selectSummaryModelOverride,
} from './core.js'
import { createSessionOrganizer } from './organizer.js'
import {
  buildProjectMemoryReminder,
  createProjectMemoryGuard,
  createProjectMemoryScanner,
  createProjectRootFinder,
  verbatimPromptText,
} from './project-memory.js'

export const name = 'dsh-session-ecology'
export const inject = []

export const ROUTE_PATH = '/dsh-session-ecology'
const MAX_BODY_BYTES = 64 * 1024
const LEDGER_MAX_HISTORY = 300

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])

function isLoopbackAddress(address) {
  if (!address) return false
  if (LOOPBACK_ADDRESSES.has(address)) return true
  return /^127\./.test(address)
}

function isSameOriginOrLoopbackPost(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const secFetchSite = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false
  const origin = String(req.headers?.origin ?? '').trim()
  const host = String(req.headers?.host ?? '').trim()
  if (origin) {
    try {
      const originHost = new URL(origin).host
      if (host && originHost.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

function resolveDshHome(explicitHome) {
  if (typeof explicitHome === 'string' && explicitHome.trim() !== '') return explicitHome.trim()
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return process.env.DSH_HOME.trim()
  }
  return path.join(os.homedir(), '.dsh')
}

function serviceOf(ctx, key) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
    return viaGet ?? ctx?.[key]
  } catch {
    return undefined
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatShanghaiTime(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date) + ' +08:00'
  } catch {
    return date.toISOString()
  }
}

function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(payload)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(new Error('BODY_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function sameSelection(a, b) {
  if (!a || !b) return false
  return a.provider === b.provider
    && a.model === b.model
    && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
}

export function createEcologySteward(ctx, rawConfig = {}) {
  let disposed = false
  const { recycleHandler, ...configOverrides } = rawConfig || {}
  const dshHome = resolveDshHome(configOverrides?.dshHome)
  const ledgerPath = path.join(dshHome, 'storages', 'session-ecology.json')
  const handoffDir = path.join(dshHome, 'storages', 'session-ecology', 'handoffs')
  const botStatePath = path.join(dshHome, 'bot', 'state.json')
  const scheduleStatePath = path.join(dshHome, 'storages', 'schedule.json')

  const logger = (msg) => {
    try {
      const log = ctx.logger?.('session-ecology') ?? ctx.logger
      if (typeof log?.info === 'function') log.info(msg)
      else console.log(`[session-ecology] ${msg}`)
    } catch {}
  }
  const warn = (msg) => {
    try {
      const log = ctx.logger?.('session-ecology') ?? ctx.logger
      if (typeof log?.warn === 'function') log.warn(msg)
      else console.warn(`[session-ecology] ${msg}`)
    } catch {}
  }

  // Load durable ledger (`settings` + `transferred` + `lineage` + `annotations` + `history` + `recycleHistory`).
  const initialLedger = readJsonSafe(ledgerPath, null)
  const ledger = {
    version: 1,
    settings: {
      ...DEFAULT_ECOLOGY_CONFIG,
      ...configOverrides,
      ...(initialLedger?.settings || {}),
    },
    transferred: initialLedger?.transferred && typeof initialLedger.transferred === 'object'
      ? { ...initialLedger.transferred }
      : {},
    lineage: initialLedger?.lineage && typeof initialLedger.lineage === 'object'
      ? { ...initialLedger.lineage }
      : {},
    annotations: initialLedger?.annotations && typeof initialLedger.annotations === 'object'
      ? { ...initialLedger.annotations }
      : {},
    history: Array.isArray(initialLedger?.history) ? [...initialLedger.history] : [],
    recycleHistory: Array.isArray(initialLedger?.recycleHistory) ? [...initialLedger.recycleHistory] : [],
  }

  function saveLedger() {
    try {
      if (ledger.history.length > LEDGER_MAX_HISTORY) {
        ledger.history = ledger.history.slice(-LEDGER_MAX_HISTORY)
      }
      if (Array.isArray(ledger.recycleHistory) && ledger.recycleHistory.length > 200) {
        ledger.recycleHistory = ledger.recycleHistory.slice(-200)
      }
      atomicWriteJson(ledgerPath, ledger)
    } catch (error) {
      warn(`保存生态账本失败：${describeError(error)}`)
    }
  }

  // Live runtime maps
  const inFlight = new Map() // sessionId -> { phase, startedAt, reason, trigger, evaluation, originalModel, modelOverridden, summaryAfterTurn, timer, callerSummary }
  const deferredSelfRequests = new Map() // sessionId -> { reason, callerSummary }
  const activatingNewSessionIds = new Set()
  const pendingTitles = new Map() // newSessionId -> desiredTitle
  const sseClients = new Set()
  let scheduleService = null
  let workingDirectoryService = null
  let webServerOrigin = null
  let selectingChain = Promise.resolve()
  let sweepRunning = false
  let postBootTimer = null

  function getConfig() {
    return ledger.settings
  }

  function clampNum(val, min, max) {
    return Math.min(max, Math.max(min, val))
  }

  function updateSettings(patch = {}) {
    const next = { ...ledger.settings }
    for (const key of [
      'enabled',
      'autoHandover',
      'postBootSweepEnabled',
      'notifyFeishu',
      'archiveOldSession',
      'projectMemoryGuardEnabled',
      'projectMemoryReminderEnabled',
    ]) {
      if (typeof patch[key] === 'boolean') next[key] = patch[key]
    }
    const ranges = {
      pressureRatio: [0.10, 0.95],
      surfaceRatio: [0.30, 5.00],
      standardFatigueMultiplier: [10, 5000],
      proFatigueMultiplier: [10, 5000],
      warnRatio: [0.30, 0.98],
      projectMemoryMaxBytes: [4096, 65536],
      projectMemoryMaxLines: [50, 1000],
    }
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (patch[key] !== undefined && Number.isFinite(Number(patch[key])) && Number(patch[key]) > 0) {
        const clamped = clampNum(Number(patch[key]), min, max)
        next[key] = key.startsWith('projectMemoryMax') ? Math.round(clamped) : clamped
      }
    }
    if (patch.summaryFallbackRoute === null) {
      next.summaryFallbackRoute = null
    } else if (patch.summaryFallbackRoute && typeof patch.summaryFallbackRoute === 'object') {
      const fbProvider = String(patch.summaryFallbackRoute.provider ?? '').trim()
      const fbModel = String(patch.summaryFallbackRoute.model ?? '').trim()
      if (fbProvider && fbModel) {
        next.summaryFallbackRoute = { provider: fbProvider, model: fbModel }
      }
    }
    if (patch.allowedProviders === null) {
      next.allowedProviders = null
    } else if (Array.isArray(patch.allowedProviders)) {
      const cleaned = patch.allowedProviders.map(v => String(v ?? '').trim()).filter(Boolean)
      next.allowedProviders = cleaned.length > 0 ? cleaned : null
    }
    ledger.settings = next
    saveLedger()
    broadcastSse({ type: 'settings', settings: next })
    return next
  }

  function resetSettings() {
    const preservedFallbackRoute = configOverrides?.summaryFallbackRoute
      ?? ledger.settings?.summaryFallbackRoute
      ?? DEFAULT_ECOLOGY_CONFIG.summaryFallbackRoute
    const preservedAllowedProviders = configOverrides?.allowedProviders
      ?? ledger.settings?.allowedProviders
      ?? DEFAULT_ECOLOGY_CONFIG.allowedProviders
    const next = {
      ...DEFAULT_ECOLOGY_CONFIG,
      ...configOverrides,
      summaryFallbackRoute: preservedFallbackRoute,
      allowedProviders: preservedAllowedProviders,
    }
    ledger.settings = next
    saveLedger()
    broadcastSse({ type: 'settings', settings: next })
    return next
  }

  function readHandoffMarkdown(oldSessionId) {
    const sid = String(oldSessionId ?? '').trim()
    if (!sid) return { ok: false, error: 'missing_session_id' }
    const fromMap = ledger.transferred?.[sid]?.handoffFilePath
    const fromHist = [...ledger.history].reverse().find(h => h.oldSessionId === sid)?.handoffFilePath
    const filePath = fromMap || fromHist
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'handoff_not_found' }
    }
    const resolvedDir = path.resolve(handoffDir)
    const resolvedFile = path.resolve(filePath)
    if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
      return { ok: false, error: 'forbidden_path' }
    }
    if (!fs.existsSync(resolvedFile)) {
      return { ok: false, error: 'file_missing' }
    }
    const stat = fs.statSync(resolvedFile)
    const raw = fs.readFileSync(resolvedFile, 'utf8')
    return {
      ok: true,
      oldSessionId: sid,
      handoffFilePath: resolvedFile,
      size: stat.size,
      markdown: raw.length > 131072 ? `${raw.slice(0, 131072)}\n\n…（已截断）` : raw,
    }
  }

  function setScheduleService(svc) {
    scheduleService = svc
  }

  function setWorkingDirectoryService(svc) {
    workingDirectoryService = svc
  }

  function setWebServerOrigin(originGetter) {
    webServerOrigin = originGetter
  }

  function resolveSessionCwd(exec) {
    try {
      const session = exec?.agent?.session
      const wdSvc = workingDirectoryService ?? serviceOf(ctx, 'workingDirectory')
      const moved = typeof wdSvc?.get === 'function' ? wdSvc.get(session) : undefined
      if (typeof moved === 'string' && path.isAbsolute(moved)) return moved
      const proj = serviceOf(ctx, 'sessionProjections')
      const projected = proj?.stateOf?.(session, 'workingDirectory')
      if (typeof projected === 'string' && path.isAbsolute(projected)) return projected
      const headerCwd = session?.header?.cwd
      return typeof headerCwd === 'string' && path.isAbsolute(headerCwd) ? headerCwd : undefined
    } catch {
      return undefined
    }
  }

  // Mtime-cached active scheduled session IDs so synchronous `systemPrompt.context` never hits async I/O or patrols.
  let schedCache = { mtimeMs: -1, ids: new Set() }
  function loadScheduledSessionIdsSync() {
    try {
      const stat = fs.statSync(scheduleStatePath)
      if (stat.mtimeMs === schedCache.mtimeMs) return schedCache.ids
      const parsed = JSON.parse(fs.readFileSync(scheduleStatePath, 'utf8'))
      const tasks = parsed?.tables?.tasks
      const ids = new Set()
      if (tasks && typeof tasks === 'object') {
        for (const item of Object.values(tasks)) {
          if (item && item.status === 'active' && typeof item.sessionId === 'string') {
            ids.add(item.sessionId)
          }
        }
      }
      schedCache = { mtimeMs: stat.mtimeMs, ids }
      return ids
    } catch {
      return new Set()
    }
  }

  const findNearestProjectMd = createProjectRootFinder()
  const projectMemoryGuard = createProjectMemoryGuard({
    getConfig,
    resolveSessionCwd,
  })
  const scanProjectMemories = createProjectMemoryScanner({
    dshHome,
    getWorkspaceRegistry: () => serviceOf(ctx, 'workspaceRegistry'),
    getConfig,
  })

  function buildMemoryReminderForContext(promptCtx) {
    try {
      const session = promptCtx?.agent?.session
      if (!session?.id) return ''
      const elig = isEligibleSession(session.id, session.header)
      if (!elig.ok) return ''
      if (inFlight.has(session.id)) return ''
      if (loadScheduledSessionIdsSync().has(session.id)) return ''
      const snapshot = readLiveSessionSnapshot(session)
      const movedCwd = resolveSessionCwd(promptCtx)
      if (movedCwd) snapshot.cwd = movedCwd
      return buildProjectMemoryReminder({
        snapshot,
        config: getConfig(),
        isEligible: true,
        hasActiveSchedule: false,
        inFlight: false,
        findProjectMd: findNearestProjectMd,
      })
    } catch {
      return ''
    }
  }

  function broadcastSse(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(line)
        res.flush?.()
      } catch {
        sseClients.delete(res)
      }
    }
  }

  // Cache bot session IDs briefly by mtime so turn/end checks are near-zero I/O.
  let botCache = { mtimeMs: -1, ids: new Set() }
  function loadBotSessionIds() {
    try {
      const stat = fs.statSync(botStatePath)
      if (stat.mtimeMs === botCache.mtimeMs) return botCache.ids
      const parsed = JSON.parse(fs.readFileSync(botStatePath, 'utf8'))
      const ids = collectBotSessionIds(parsed, new Set())
      botCache = { mtimeMs: stat.mtimeMs, ids }
      return ids
    } catch {
      return new Set()
    }
  }

  function isArchived(sessionId) {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const archived = registry?.archivedSessionIds
    return Array.isArray(archived) && archived.includes(sessionId)
  }

  function isPinned(sessionId) {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const pinned = registry?.pinnedSessionIds
    return Array.isArray(pinned) && pinned.includes(sessionId)
  }

  function isSubagentHeader(header) {
    if (!header || typeof header !== 'object') return false
    return header.origin === 'subagent' || (Number(header.delegationDepth) || 0) > 0
  }

  function isEligibleSession(sessionId, header) {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('session-')) {
      return { ok: false, reason: 'invalid_session_id' }
    }
    if (activatingNewSessionIds.has(sessionId)) {
      return { ok: false, reason: 'internal_activation_turn' }
    }
    if (isSubagentHeader(header)) {
      return { ok: false, reason: 'subagent_session' }
    }
    if (isArchived(sessionId)) {
      return { ok: false, reason: 'archived_session' }
    }
    if (loadBotSessionIds().has(sessionId)) {
      return { ok: false, reason: 'ds_bot_managed_session' }
    }
    return { ok: true }
  }

  function readLiveSessionSnapshot(session) {
    const proj = serviceOf(ctx, 'sessionProjections')
    const contextPressure = proj?.stateOf?.(session, 'contextPressure') ?? null
    const tokenUsage = proj?.stateOf?.(session, 'tokenUsage') ?? null
    const sessionStats = proj?.stateOf?.(session, 'sessionStats') ?? null
    const title = proj?.stateOf?.(session, 'title') ?? ''
    const workingDirectory = proj?.stateOf?.(session, 'workingDirectory') ?? session?.header?.cwd ?? ''
    const agentPreset = proj?.stateOf?.(session, 'agentPreset') ?? session?.header?.agentPreset ?? undefined
    const modelState = proj?.stateOf?.(session, 'modelSelection') ?? null
    const modelSelection = modelState?.pending ?? modelState?.lastUsed ?? null
    const permissions = proj?.stateOf?.(session, 'permissions') ?? null
    const inbox = proj?.stateOf?.(session, 'inbox') ?? null
    const turnOutline = proj?.stateOf?.(session, 'turnOutline') ?? null

    return {
      sessionId: session.id,
      header: session.header,
      title: typeof title === 'string' ? title : '',
      cwd: typeof workingDirectory === 'string' ? workingDirectory : '',
      agentPreset: typeof agentPreset === 'string' && agentPreset !== '' ? agentPreset : undefined,
      contextPressure,
      tokenUsage,
      modelSelection,
      permissionPreset: permissions?.preset ?? null,
      sandboxMode: permissions?.sandbox ?? null,
      turns: sessionStats?.turns ?? 0,
      steps: sessionStats?.steps ?? 0,
      inboxEmpty: (!Array.isArray(inbox?.['next-turn']) || inbox['next-turn'].length === 0)
        && (!Array.isArray(inbox?.['next-step']) || inbox['next-step'].length === 0),
      recentTurns: Array.isArray(turnOutline?.turns) ? turnOutline.turns : [],
    }
  }

  /**
   * Read snapshot for a cold OR live session via `sessionController.projections` + `session_projcache`.
   */
  async function readAnySessionSnapshot(sessionId, headerHint = null) {
    const liveSession = serviceOf(ctx, 'sessions')?.get?.(sessionId)
      ?? serviceOf(ctx, 'agents')?.get?.(sessionId)?.session
    if (liveSession) {
      return readLiveSessionSnapshot(liveSession)
    }

    const controller = serviceOf(ctx, 'sessionController')
    let header = headerHint && typeof headerHint === 'object' && headerHint.cwd ? headerHint : null
    if (!header) {
      try {
        const inspected = await controller?.inspect?.(sessionId)
        header = inspected?.header ?? null
      } catch {}
    }

    // Read persisted projection cache directly for zero-activation cold inspection.
    const projFile = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const cached = readJsonSafe(projFile, null)
    const rows = cached?.record?.rows ?? {}
    const identity = cached?.record?.identity ?? {}
    const valOf = key => rows?.[key]?.val ?? null

    const modelState = valOf('modelSelection')
    const sessionStats = valOf('sessionStats')
    const permissions = valOf('permissions')
    const inbox = valOf('inbox')
    const turnOutline = valOf('turnOutline')

    // Fallback to controller.projections if projcache is absent.
    let wireValues = null
    if (!cached && controller?.projections) {
      try {
        const abort = new AbortController()
        const res = await controller.projections({ sessionId }, abort.signal)
        wireValues = res?.values ?? null
      } catch {}
    }

    const contextPressure = valOf('contextPressure') ?? wireValues?.contextPressure ?? null
    const tokenUsage = valOf('tokenUsage') ?? wireValues?.tokenUsage ?? null
    const modelSelection = modelState?.pending ?? modelState?.lastUsed
      ?? wireValues?.modelSelection?.next ?? wireValues?.modelSelection?.lastUsed ?? null
    const title = valOf('title') ?? wireValues?.title ?? ''
    const cwd = valOf('workingDirectory') ?? header?.cwd ?? identity?.cwd ?? ''
    const agentPreset = valOf('agentPreset') ?? header?.agentPreset ?? undefined

    return {
      sessionId,
      header: header ?? { id: sessionId, cwd },
      title: typeof title === 'string' ? title : '',
      cwd: typeof cwd === 'string' ? cwd : '',
      agentPreset: typeof agentPreset === 'string' && agentPreset !== '' ? agentPreset : undefined,
      contextPressure,
      tokenUsage,
      modelSelection,
      permissionPreset: permissions?.preset ?? wireValues?.permissions?.currentValue ?? null,
      sandboxMode: permissions?.sandbox ?? valOf('sandboxMode') ?? null,
      turns: sessionStats?.turns ?? 0,
      steps: sessionStats?.steps ?? 0,
      inboxEmpty: (!Array.isArray(inbox?.['next-turn']) || inbox['next-turn'].length === 0)
        && (!Array.isArray(inbox?.['next-step']) || inbox['next-step'].length === 0),
      recentTurns: Array.isArray(turnOutline?.turns) ? turnOutline.turns : [],
    }
  }

  /**
   * Select a model on `sessionId` while preserving DSH's global `agentDefaultModel`
   * (DSH's `sessionController.selectModel` writes the profile default in the background).
   */
  function selectSessionModelSafely(sessionId, selection) {
    if (!selection?.provider || !selection?.model) return Promise.resolve(null)
    const controller = serviceOf(ctx, 'sessionController')
    if (typeof controller?.selectModel !== 'function') return Promise.resolve(null)

    const run = selectingChain.then(async () => {
      const defaults = serviceOf(ctx, 'agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const req = {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
      const result = await controller.selectModel(req)
      const applied = result?.selected ?? req
      if (before?.provider && before?.model && !sameSelection(before, applied) && typeof defaults?.saveSelection === 'function') {
        await defaults.saveSelection(before).catch((err) => {
          warn(`恢复全局默认模型失败：${describeError(err)}`)
        })
      }
      return result
    })
    selectingChain = run.catch(() => {})
    return run
  }

  async function waitAgentIdle(sessionId, timeoutMs = 30_000) {
    const agent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    if (!agent) return true
    if (typeof agent.whenIdle === 'function') {
      let timer
      const timed = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      })
      const outcome = await Promise.race([
        Promise.resolve(agent.whenIdle()).then(() => 'idle').catch(() => 'idle'),
        timed,
      ]).finally(() => clearTimeout(timer))
      if (outcome === 'timeout') return false
    }
    const inboxSize = typeof agent.inbox?.size === 'number'
      ? agent.inbox.size
      : Array.isArray(agent.inbox) ? agent.inbox.length : 0
    return inboxSize === 0
  }

  function extractLatestAssistantSummaryAndFiles(session, afterTurn = 0) {
    let summaryText = ''
    const touchedFiles = []
    const seenFiles = new Set()

    try {
      const events = typeof session?.events === 'function' ? session.events() : []
      let currentTurn = 0
      const latestTurnChunks = []
      for (const ev of events) {
        if (ev.type === 'turn/start') {
          currentTurn = Number(ev.data?.turn) || (currentTurn + 1)
          if (currentTurn > afterTurn) latestTurnChunks.length = 0
        } else if (ev.type === 'tool/call') {
          const args = ev.data?.arguments ?? ev.data?.input ?? {}
          for (const key of ['path', 'file_path', 'filePath', 'Path', 'targetFile']) {
            const p = args?.[key]
            if (typeof p === 'string' && p.trim() && !seenFiles.has(p)) {
              seenFiles.add(p)
              touchedFiles.push(p.trim())
            }
          }
        } else if (ev.type === 'assistant/message' && currentTurn > afterTurn) {
          const blocks = Array.isArray(ev.data?.message?.content)
            ? ev.data.message.content
            : Array.isArray(ev.data?.content) ? ev.data.content : []
          const text = blocks
            .filter(b => b?.type === 'text' && typeof b.text === 'string')
            .map(b => b.text.trim())
            .filter(Boolean)
            .join('\n\n')
          if (text) latestTurnChunks.push(text)
        }
      }
      summaryText = latestTurnChunks.join('\n\n').trim()
    } catch {}

    return { summaryText, touchedFiles }
  }

  function findOldJsonlPath(sessionId, cwd) {
    try {
      const sessionsRoot = path.join(dshHome, 'sessions')
      if (!fs.existsSync(sessionsRoot)) return ''
      for (const dirName of fs.readdirSync(sessionsRoot)) {
        const candidate = path.join(sessionsRoot, dirName, sessionId, 'session.v4.jsonl')
        if (fs.existsSync(candidate)) return candidate
      }
    } catch {}
    return cwd ? `${dshHome}\\sessions\\*\\${sessionId}\\session.v4.jsonl` : ''
  }

  async function resolveWorkspaceForSession(sessionId, cwd) {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (!registry) return { workspaceId: undefined, workspaceTitle: '' }
    try {
      if (typeof registry.list === 'function') {
        const member = registry.list().find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId))
        if (member) return { workspaceId: member.id, workspaceTitle: member.title || '' }
      }
      if (cwd && typeof registry.resolveByPath === 'function') {
        const byPath = await registry.resolveByPath(cwd)
        if (byPath) return { workspaceId: byPath.id, workspaceTitle: byPath.title || '' }
      }
    } catch {}
    return { workspaceId: undefined, workspaceTitle: '' }
  }

  async function listActiveSchedulesOf(sessionId) {
    const svc = scheduleService ?? serviceOf(ctx, 'schedule')
    if (!svc) return []
    try {
      if (typeof svc.edit === 'function' && typeof svc.catalog === 'function') {
        const all = await svc.catalog()
        return all.filter(entry => entry.status === 'active' && (entry.target?.sessionId ?? entry.sessionId) === sessionId)
      }
      if (typeof svc.list === 'function') {
        return await svc.list({ sessionId })
      }
    } catch (error) {
      warn(`读取会话 ${sessionId} 定时任务失败：${describeError(error)}`)
    }
    return []
  }

  const organizer = createSessionOrganizer({
    ctx,
    dshHome,
    ledger,
    saveLedger,
    getConfig,
    getScheduleService: () => scheduleService,
    readAnySessionSnapshot,
    listActiveSchedulesOf,
    readBotIds: loadBotSessionIds,
    inFlight,
    broadcastSse,
    logger,
    warn,
    recycleHandler,
  })

  /**
   * Atomic schedule migration:
   * 1) Create all valid active schedules on `toSessionId`;
   * 2) Verify via `schedule.list({ sessionId: toSessionId })` that every created ID exists;
   * 3) Only then delete from `fromSessionId`.
   * On any failure before step 3, rolls back created schedules on `toSessionId` and throws!
   */
  async function migrateSchedulesAtomically(fromSessionId, toSessionId) {
    const svc = scheduleService ?? serviceOf(ctx, 'schedule')
    if (!svc) return []

    // Forward compatibility with Host-wide DSH 0.2.2+ schedule service:
    if (typeof svc.edit === 'function' && typeof svc.catalog === 'function') {
      const moved = []
      for (const entry of await svc.catalog()) {
        const owner = entry.target?.kind === 'session' ? entry.target.sessionId : entry.sessionId
        if (entry.status === 'ended' || owner !== fromSessionId) continue
        await svc.edit({
          id: entry.id,
          action: 'update',
          patch: { target: { kind: 'session', sessionId: toSessionId } },
        })
        moved.push({ oldId: entry.id, newId: entry.id, title: entry.title, kind: entry.kind ?? 'task' })
      }
      return moved
    }

    if (typeof svc.list !== 'function' || typeof svc.create !== 'function' || typeof svc.delete !== 'function') {
      return []
    }

    const sourceRecords = await svc.list({ sessionId: fromSessionId })
    if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) return []

    const createdPairs = []
    try {
      const nowMs = Date.now()
      for (const record of sourceRecords) {
        const built = scheduleCreateRequestOf(record, nowMs)
        if (built.skip) continue
        const abort = new AbortController()
        const created = await svc.create(toSessionId, built.request, abort.signal)
        const newId = created?.id ?? created?.record?.id
        if (!newId) throw new Error(`schedule.create 未返回新任务 ID（原任务 ${record.title}）`)
        createdPairs.push({
          oldId: record.id,
          newId,
          title: record.title,
          kind: record.kind,
        })
      }

      if (createdPairs.length > 0) {
        const verifyList = await svc.list({ sessionId: toSessionId })
        const verifyIds = new Set(verifyList.map(r => r.id))
        for (const pair of createdPairs) {
          if (!verifyIds.has(pair.newId)) {
            throw new Error(`新会话回读校验未找到已建任务 ${pair.newId}（${pair.title}）`)
          }
        }
      }
    } catch (error) {
      // Roll back partial creations on `toSessionId` so tasks never duplicate or vanish.
      for (const pair of createdPairs) {
        try {
          const abort = new AbortController()
          await svc.delete({ sessionId: toSessionId, id: pair.newId }, abort.signal)
        } catch {}
      }
      throw error
    }

    // Now safe to delete originals on `fromSessionId`.
    for (const pair of createdPairs) {
      try {
        const abort = new AbortController()
        await svc.delete({ sessionId: fromSessionId, id: pair.oldId }, abort.signal)
      } catch (error) {
        warn(`删除旧会话 ${fromSessionId} 原定时任务 ${pair.oldId} 失败：${describeError(error)}`)
      }
    }

    return createdPairs
  }

  async function pushFeishuReport(text) {
    if (!getConfig().notifyFeishu) return { ok: false, skipped: true }
    let origin = ''
    try {
      origin = typeof webServerOrigin === 'function' ? webServerOrigin() : ''
    } catch {}
    if (!origin) {
      const port = String(process.env.DSH_PORT || '3079').trim()
      origin = `http://127.0.0.1:${port}`
    }
    try {
      const url = `${origin.replace(/\/$/, '')}/dsh-plugin-notify-feishu/push`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completed', text }),
      })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok && data?.ok === true, status: res.status, ...data }
    } catch (error) {
      warn(`推送飞书换卷报告失败：${describeError(error)}`)
      return { ok: false, error: describeError(error) }
    }
  }

  /**
   * Begin Stage 1 (`summarizing`) or jump straight to Stage 2 (`transferring`) if `callerSummary` is given.
   */
  async function startHandover(sessionId, options = {}) {
    if (disposed) return { ok: false, code: 'disposed', message: 'Plugin disposed.' }
    const trigger = options.trigger || 'auto'
    const force = options.force === true

    if (inFlight.has(sessionId)) {
      return { ok: false, code: 'already_in_flight', phase: inFlight.get(sessionId).phase }
    }
    if (!force && ledger.transferred[sessionId]?.newSessionId) {
      return {
        ok: false,
        code: 'already_transferred',
        newSessionId: ledger.transferred[sessionId].newSessionId,
      }
    }

    const snap = await readAnySessionSnapshot(sessionId)
    const eligible = isEligibleSession(sessionId, snap.header)
    if (!eligible.ok) {
      return { ok: false, code: eligible.reason, message: `Session ineligible: ${eligible.reason}` }
    }

    const idle = await waitAgentIdle(sessionId, 15_000)
    if (!idle || !snap.inboxEmpty) {
      return { ok: false, code: 'session_busy', message: 'Target session is currently busy or has queued messages.' }
    }

    const evaluation = options.evaluation ?? evaluateSessionEcology(snap, getConfig())
    if (!force && trigger === 'auto' && !evaluation.triggered) {
      return { ok: false, code: 'below_threshold', evaluation }
    }

    const schedules = await listActiveSchedulesOf(sessionId)
    const callerSummary = typeof options.summary === 'string' && options.summary.trim() !== ''
      ? options.summary.trim()
      : ''

    const controller = serviceOf(ctx, 'sessionController')
    if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      return { ok: false, code: 'missing_controller', message: 'sessionController unavailable.' }
    }

    const entry = {
      sessionId,
      phase: callerSummary ? 'transferring' : 'summarizing',
      startedAt: Date.now(),
      trigger,
      evaluation,
      snapshot: snap,
      schedules,
      originalModel: snap.modelSelection,
      modelOverridden: false,
      summaryAfterTurn: snap.turns,
      callerSummary,
      capturedSummaryChunks: [],
      capturedTouchedFiles: [],
      timer: null,
      resolveDone: null,
      donePromise: null,
    }
    entry.donePromise = new Promise((resolve) => {
      entry.resolveDone = resolve
    })
    inFlight.set(sessionId, entry)

    broadcastSse({
      type: 'phase',
      sessionId,
      phase: entry.phase,
      title: snap.title,
      reasons: evaluation.reasons,
    })

    if (callerSummary) {
      return finalizeTransfer(sessionId, callerSummary, 'caller', [])
    }

    // Enforce optional model-quota fallback during automatic summary turn.
    const cfgForSummary = getConfig()
    const overrideRoute = selectSummaryModelOverride(
      snap.modelSelection,
      cfgForSummary.summaryFallbackRoute,
      cfgForSummary.allowedProviders
    )
    if (overrideRoute) {
      try {
        await selectSessionModelSafely(sessionId, overrideRoute)
        entry.modelOverridden = true
      } catch (error) {
        warn(`切换自总结临时模型失败（将走机械兜底）：${describeError(error)}`)
        return finalizeTransfer(sessionId, '', 'mechanical-fallback', [])
      }
    }

    // Safety timeout: if summary turn stalls/aborts, fall back deterministically without hanging.
    const timeoutMs = Math.max(15_000, Number(getConfig().summaryTimeoutMs) || 180_000)
    entry.timer = setTimeout(() => {
      const cur = inFlight.get(sessionId)
      if (!cur || cur.phase !== 'summarizing') return
      warn(`会话 ${sessionId} 自总结超时（${timeoutMs}ms），改用日志机械提取完成换卷`)
      void finalizeTransfer(sessionId, '', 'mechanical-timeout', [])
    }, timeoutMs)
    entry.timer.unref?.()

    try {
      const promptText = buildSelfSummaryPrompt({
        title: snap.title,
        evaluation,
        schedules,
      })
      const abort = new AbortController()
      await controller.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
      }, abort.signal)
    } catch (error) {
      clearTimeout(entry.timer)
      warn(`发送自总结提示失败（${sessionId}），启用机械提取兜底：${describeError(error)}`)
      return finalizeTransfer(sessionId, '', 'mechanical-prompt-error', [])
    }

    if (options.wait === true) {
      return entry.donePromise
    }
    return {
      ok: true,
      phase: 'summarizing',
      sessionId,
      evaluation,
    }
  }

  /**
   * Stage 2 (`transferring`): create continuation session, migrate schedules, inject opening card,
   * archive old session, push Feishu notification, and broadcast SSE switch event.
   */
  async function finalizeTransfer(oldSessionId, rawSummaryText, summarySource, touchedFiles = []) {
    const entry = inFlight.get(oldSessionId)
    if (!entry || entry.phase === 'done') {
      return { ok: false, code: 'not_in_flight' }
    }
    if (entry.finalizing) return entry.donePromise
    entry.finalizing = true
    entry.phase = 'transferring'
    clearTimeout(entry.timer)

    const settle = (result) => {
      inFlight.delete(oldSessionId)
      entry.resolveDone?.(result)
      return result
    }

    try {
      // Restore original model on old session if we temporarily switched away from GPT/Opus.
      if (entry.modelOverridden && entry.originalModel?.provider && entry.originalModel?.model) {
        await selectSessionModelSafely(oldSessionId, entry.originalModel).catch(() => {})
      }

      const freshSnap = await readAnySessionSnapshot(oldSessionId)
      const schedulesNow = await listActiveSchedulesOf(oldSessionId)
      const oldTitle = freshSnap.title || entry.snapshot.title || `会话 ${oldSessionId.slice(8, 16)}`
      const cwd = freshSnap.cwd || entry.snapshot.cwd || dshHome
      const agentPreset = freshSnap.agentPreset || entry.snapshot.agentPreset
      const desiredModel = entry.originalModel ?? freshSnap.modelSelection
      const permissionPreset = freshSnap.permissionPreset || entry.snapshot.permissionPreset
      const wasPinned = isPinned(oldSessionId)

      let effectiveSource = summarySource
      let summaryText = String(rawSummaryText ?? '').trim()
      if (!summaryText) {
        effectiveSource = 'mechanical'
        summaryText = buildMechanicalFallbackSummary({
          title: oldTitle,
          cwd,
          recentTurns: freshSnap.recentTurns,
          touchedFiles,
          schedules: schedulesNow,
        })
      }

      const controller = serviceOf(ctx, 'sessionController')
      const { workspaceId, workspaceTitle } = await resolveWorkspaceForSession(oldSessionId, cwd)

      // Compute lineage generation (`#2`, `#3`, ...) from ledger + title suffix.
      const priorGen = Number(ledger.lineage[oldSessionId]?.generation) || parseTitleGeneration(oldTitle).generation
      const { title: newTitle, generation } = buildContinuationTitle(
        oldTitle,
        priorGen + 1,
        getConfig().maxTitleBytes
      )

      // Create new session inside the exact same workspace (`workspaceId` and `cwd` are mutually exclusive).
      let created
      const presetOpt = agentPreset ? { agentPreset } : {}
      try {
        created = await controller.create(
          workspaceId ? { workspaceId, ...presetOpt } : { cwd, ...presetOpt }
        )
      } catch (error) {
        if (!workspaceId) throw error
        created = await controller.create({ cwd, ...presetOpt })
      }
      const newSessionId = created.sessionId
      activatingNewSessionIds.add(newSessionId)

      // Set title immediately + register post-Turn-1 guard against DSH auto-title clobbering.
      pendingTitles.set(newSessionId, newTitle)
      try {
        await controller.rename({ sessionId: newSessionId, title: newTitle })
      } catch (error) {
        warn(`新会话 ${newSessionId} 初次命名失败：${describeError(error)}`)
      }

      // Inherit model selection without polluting global `agentDefaultModel`.
      if (desiredModel?.provider && desiredModel?.model) {
        await selectSessionModelSafely(newSessionId, desiredModel).catch((error) => {
          warn(`新会话 ${newSessionId} 继承模型失败：${describeError(error)}`)
        })
      }

      // Inherit permission preset (`read-only` / `workspace-write` / `danger-full-access`).
      const permService = serviceOf(ctx, 'permissionPresets')
      if (permService && permissionPreset && permissionPreset !== 'custom' && permissionPreset !== 'auto') {
        try {
          const resolved = await controller.resolveAgent?.(newSessionId)
          const targetSession = resolved?.agent?.session ?? resolved?.session
            ?? serviceOf(ctx, 'agents')?.get?.(newSessionId)?.session
          if (targetSession) {
            permService.set(targetSession, permissionPreset)
          }
        } catch (error) {
          warn(`新会话 ${newSessionId} 继承权限预设 ${permissionPreset} 失败：${describeError(error)}`)
        }
      }

      // Inherit pin state before archiving old session (archiving old session automatically drops old pin).
      const workspaceRegistry = serviceOf(ctx, 'workspaceRegistry')
      if (wasPinned && typeof workspaceRegistry?.pinSession === 'function') {
        await workspaceRegistry.pinSession(newSessionId).catch(() => {})
      }

      // Migrate active schedules atomically (create -> verify -> delete).
      const migratedSchedules = await migrateSchedulesAtomically(oldSessionId, newSessionId)

      // Persist reviewable Markdown handoff document on disk.
      const now = new Date()
      const timeText = formatShanghaiTime(now)
      const shortOld = oldSessionId.replace(/^session-/, '').slice(0, 8)
      const handoffFilePath = path.join(handoffDir, `${fileStamp(now)}-${shortOld}.md`)
      const oldJsonlPath = findOldJsonlPath(oldSessionId, cwd)

      fs.mkdirSync(handoffDir, { recursive: true })
      fs.writeFileSync(
        handoffFilePath,
        renderHandoffArchiveMarkdown({
          timestampIso: timeText,
          oldSessionId,
          newSessionId,
          oldTitle,
          newTitle,
          workspaceTitle,
          cwd,
          modelSelection: desiredModel,
          permissionPreset,
          evaluation: entry.evaluation,
          summaryText,
          summarySource: effectiveSource,
          migratedSchedules,
          oldJsonlPath,
        }),
        'utf8'
      )

      // Inject opening handoff card into `newSessionId` so Web UI renders it immediately (1-line receipt only).
      const openingPrompt = renderContinuationOpeningPrompt({
        oldSessionId,
        oldTitle,
        newTitle,
        generation,
        cwd,
        evaluation: entry.evaluation,
        summaryText,
        handoffFilePath,
        migratedSchedules,
        oldJsonlPath,
      })
      const abort = new AbortController()
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: newSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: openingPrompt }],
      }, abort.signal)

      // Wait briefly for `oldSessionId` to settle idle, then archive it cleanly unless new user input arrived.
      let archived = false
      if (getConfig().archiveOldSession !== false && workspaceRegistry?.archiveSession) {
        const oldIdle = await waitAgentIdle(oldSessionId, 10_000)
        const postSnap = await readAnySessionSnapshot(oldSessionId)
        if (oldIdle && postSnap.inboxEmpty) {
          try {
            await workspaceRegistry.archiveSession(oldSessionId, { stopActivity: false })
            archived = true
          } catch {
            try {
              await workspaceRegistry.archiveSession(oldSessionId, { stopActivity: true })
              archived = true
            } catch (err2) {
              warn(`归档旧会话 ${oldSessionId} 失败：${describeError(err2)}`)
            }
          }
        }
      }

      // Record durable handover lineage & ledger.
      const record = {
        at: now.toISOString(),
        timeText,
        trigger: entry.trigger,
        oldSessionId,
        newSessionId,
        oldTitle,
        newTitle,
        generation,
        workspaceId: workspaceId ?? null,
        workspaceTitle: workspaceTitle || '',
        cwd,
        summarySource: effectiveSource,
        handoffFilePath,
        migratedSchedules,
        archived,
        reasons: entry.evaluation.reasons,
        metrics: entry.evaluation.metrics,
      }
      ledger.transferred[oldSessionId] = {
        newSessionId,
        newTitle,
        at: record.at,
        handoffFilePath,
      }
      ledger.lineage[newSessionId] = {
        previousSessionId: oldSessionId,
        generation,
        rootTitle: parseTitleGeneration(oldTitle).baseTitle,
      }
      if (!ledger.annotations || typeof ledger.annotations !== 'object') {
        ledger.annotations = {}
      }
      const inheritedAnn = inheritAnnotationForContinuation(ledger.annotations[oldSessionId])
      if (inheritedAnn && !ledger.annotations[newSessionId]) {
        ledger.annotations[newSessionId] = inheritedAnn
      }
      ledger.history.push(record)
      saveLedger()

      // Notify connected Web clients (active tab auto-jump) & push Feishu report.
      broadcastSse({
        type: 'handover',
        ...record,
      })

      const feishuText = renderFeishuEcologyReport({
        workspaceTitle,
        cwd,
        oldSessionId,
        newSessionId,
        oldTitle,
        newTitle,
        evaluation: entry.evaluation,
        migratedSchedules,
        archived,
        summarySource: effectiveSource,
        timeText,
      })
      const feishuResult = await pushFeishuReport(feishuText)

      logger(`已完成换卷：${oldTitle} (${shortOld}) -> ${newTitle} (${newSessionId.slice(8, 16)}), 迁移任务=${migratedSchedules.length}, 归档=${archived}`)

      return settle({
        ok: true,
        ...record,
        feishuNotified: feishuResult.ok === true,
      })
    } catch (error) {
      const msg = describeError(error)
      warn(`会话 ${oldSessionId} 换卷交接失败：${msg}`)
      broadcastSse({
        type: 'failed',
        sessionId: oldSessionId,
        error: msg,
      })
      return settle({
        ok: false,
        code: 'transfer_failed',
        sessionId: oldSessionId,
        message: msg,
      })
    }
  }

  /**
   * Live stream capture for `summarizing` sessions so cold-awakened sessions
   * (where in-memory `session.events()` turn index starts at 1) still capture 100% of their LLM summary.
   */
  function handleSessionEvent(session, event) {
    if (disposed || !session?.id || !event?.type) return
    const flight = inFlight.get(session.id)
    if (!flight || flight.phase !== 'summarizing') return

    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
        : Array.isArray(event.data?.content) ? event.data.content : []
      const text = blocks
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text.trim())
        .filter(Boolean)
        .join('\n\n')
      if (text) flight.capturedSummaryChunks.push(text)
    } else if (event.type === 'tool/call') {
      const args = event.data?.arguments ?? event.data?.input ?? {}
      for (const key of ['path', 'file_path', 'filePath', 'Path', 'targetFile']) {
        const p = args?.[key]
        if (typeof p === 'string' && p.trim() && !flight.capturedTouchedFiles.includes(p.trim())) {
          flight.capturedTouchedFiles.push(p.trim())
        }
      }
    }
  }

  /**
   * Deferred `turn/end` handler (invoked inside `queueMicrotask` so session log append is closed).
   */
  async function handleTurnEnd(session, event) {
    if (disposed) return
    const sessionId = session?.id
    if (!sessionId) return
    const reasonKind = event?.data?.reason?.kind ?? 'completed'
    const endedTurn = Number(event?.data?.turn) || 0

    // 1. Re-apply continuation title after Turn 1 completes so DSH's auto-title doesn't overwrite `#2`.
    if (pendingTitles.has(sessionId)) {
      const wantedTitle = pendingTitles.get(sessionId)
      pendingTitles.delete(sessionId)
      activatingNewSessionIds.delete(sessionId)
      const controller = serviceOf(ctx, 'sessionController')
      if (wantedTitle && typeof controller?.rename === 'function') {
        await controller.rename({ sessionId, title: wantedTitle }).catch(() => {})
      }
      return
    }
    if (activatingNewSessionIds.has(sessionId)) {
      activatingNewSessionIds.delete(sessionId)
      return
    }

    // 2. If this session was running its self-summary turn, extract summary & finalize transfer!
    const flight = inFlight.get(sessionId)
    if (flight && flight.phase === 'summarizing') {
      if (endedTurn > 0 && endedTurn <= flight.summaryAfterTurn && reasonKind === 'completed' && flight.capturedSummaryChunks.length === 0) {
        return
      }
      const fallbackExtracted = extractLatestAssistantSummaryAndFiles(session, flight.summaryAfterTurn)
      const liveText = flight.capturedSummaryChunks.join('\n\n').trim()
      const summaryText = liveText || fallbackExtracted.summaryText
      const touchedFiles = Array.from(new Set([...flight.capturedTouchedFiles, ...fallbackExtracted.touchedFiles]))
      const src = reasonKind === 'completed' && summaryText ? 'self-llm' : 'mechanical'
      await finalizeTransfer(sessionId, summaryText, src, touchedFiles)
      return
    }

    // 3. Deferred manual self-handover requested via `fleet_session_handover` during the turn that just ended:
    if (deferredSelfRequests.has(sessionId)) {
      const req = deferredSelfRequests.get(sessionId)
      deferredSelfRequests.delete(sessionId)
      if (reasonKind !== 'completed') return
      await startHandover(sessionId, {
        trigger: 'tool',
        force: true,
        summary: req.callerSummary,
      })
      return
    }

    // 4. Automatic post-turn 3-gate check (only on normal `completed` turns when autoHandover is on):
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.autoHandover) return
    if (reasonKind !== 'completed') return
    if (ledger.transferred[sessionId]) return

    const eligible = isEligibleSession(sessionId, session.header)
    if (!eligible.ok) return

    const snap = readLiveSessionSnapshot(session)
    if (!snap.inboxEmpty) return

    const evaluation = evaluateSessionEcology(snap, cfg)
    if (!evaluation.triggered) return

    await startHandover(sessionId, {
      trigger: 'auto',
      evaluation,
    })
  }

  /**
   * Inspect ecological health across unarchived workspace sessions & active scheduled patrols.
   */
  async function getEcologyStatus({ limit = 25, historyLimit = 30, includeHealthy = false } = {}) {
    const workspaceRegistry = serviceOf(ctx, 'workspaceRegistry')
    const archivedSet = new Set(workspaceRegistry?.archivedSessionIds ?? [])
    const botIds = loadBotSessionIds()
    const svc = scheduleService ?? serviceOf(ctx, 'schedule')

    // Map sessionId -> active schedule summaries
    const scheduleBySession = new Map()
    try {
      if (typeof svc?.catalog === 'function') {
        for (const entry of await svc.catalog()) {
          if (entry.status !== 'active') continue
          const sid = entry.target?.kind === 'session' ? entry.target.sessionId : entry.sessionId
          if (!sid) continue
          if (!scheduleBySession.has(sid)) scheduleBySession.set(sid, [])
          scheduleBySession.get(sid).push({ id: entry.id, title: entry.title, scheduledAt: entry.scheduledAt })
        }
      }
    } catch {}

    // Collect candidate unarchived sessions from workspaces + scheduled sessions
    const candidateIds = new Set(scheduleBySession.keys())
    const wsBySession = new Map()
    try {
      for (const ws of workspaceRegistry?.list?.() ?? []) {
        for (const sid of ws.sessionIds ?? []) {
          wsBySession.set(sid, ws.title || ws.path || ws.id)
          if (!archivedSet.has(sid)) candidateIds.add(sid)
        }
      }
    } catch {}

    const rows = []
    for (const sid of candidateIds) {
      if (archivedSet.has(sid) || botIds.has(sid)) continue
      const snap = await readAnySessionSnapshot(sid)
      if (isSubagentHeader(snap.header)) continue
      const evaluation = evaluateSessionEcology(snap, getConfig())
      const activeSchedules = scheduleBySession.get(sid) ?? []
      if (!includeHealthy && evaluation.status === 'healthy' && activeSchedules.length === 0) continue
      rows.push({
        sessionId: sid,
        title: snap.title || '(未命名)',
        workspace: wsBySession.get(sid) || snap.cwd || '未分组',
        model: snap.modelSelection ? `${snap.modelSelection.provider}/${snap.modelSelection.model}` : 'default',
        status: evaluation.status,
        triggered: evaluation.triggered,
        maxGateProgress: evaluation.maxGateProgress,
        reasons: evaluation.reasons,
        metrics: evaluation.metrics,
        thresholds: evaluation.thresholds,
        activeSchedules: activeSchedules.length,
        scheduleTitles: activeSchedules.map(s => s.title),
        inFlightPhase: inFlight.get(sid)?.phase ?? null,
        transferredTo: ledger.transferred[sid]?.newSessionId ?? null,
      })
    }

    rows.sort((a, b) => {
      if (a.triggered !== b.triggered) return a.triggered ? -1 : 1
      if ((a.activeSchedules > 0) !== (b.activeSchedules > 0)) return a.activeSchedules > 0 ? -1 : 1
      return b.maxGateProgress - a.maxGateProgress
    })

    return {
      ok: true,
      settings: getConfig(),
      summary: {
        inspectedCandidates: candidateIds.size,
        overThresholdCount: rows.filter(r => r.triggered && !r.transferredTo).length,
        overThresholdScheduledCount: rows.filter(r => r.triggered && r.activeSchedules > 0 && !r.transferredTo).length,
        warnCount: rows.filter(r => r.status === 'warn').length,
        inFlightCount: inFlight.size,
        totalHistoricalHandovers: ledger.history.length,
      },
      sessions: rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 25))),
      recentHistory: ledger.history
        .slice(-Math.max(1, Math.min(100, Number(historyLimit) || 30)))
        .reverse(),
    }
  }

  /**
   * Sequential sweep of over-threshold idle sessions (defaults to `scheduledOnly: true` so
   * historical idle chats are never bulk-awakened unless explicitly requested).
   */
  async function sweepOverThreshold({ scheduledOnly = true, dryRun = false, limit = 5, trigger = 'sweep' } = {}) {
    if (sweepRunning && !dryRun) {
      return { ok: false, code: 'sweep_already_running', message: 'Another ecology sweep is already in progress.' }
    }

    const status = await getEcologyStatus({ limit: 100, includeHealthy: false })
    const targets = status.sessions.filter((row) => {
      if (!row.triggered) return false
      if (row.transferredTo || row.inFlightPhase) return false
      if (scheduledOnly && row.activeSchedules === 0) return false
      return true
    }).slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))

    if (dryRun || targets.length === 0) {
      return {
        ok: true,
        dryRun: true,
        scheduledOnly,
        matchedCount: targets.length,
        targets,
      }
    }

    sweepRunning = true
    const results = []
    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (disposed) break
        const target = targets[i]
        const res = await startHandover(target.sessionId, {
          trigger,
          wait: true,
        })
        results.push({
          sessionId: target.sessionId,
          title: target.title,
          ...res,
        })
        if (i + 1 < targets.length && getConfig().sweepGapMs > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, getConfig().sweepGapMs)
            t.unref?.()
          })
        }
      }
    } finally {
      sweepRunning = false
    }

    return {
      ok: true,
      dryRun: false,
      scheduledOnly,
      sweptCount: results.filter(r => r.ok).length,
      results,
    }
  }

  function schedulePostBootSweep() {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.postBootSweepEnabled) return
    const delayMs = Math.max(5_000, Number(cfg.postBootSweepDelayMs) || 60_000)
    postBootTimer = setTimeout(async () => {
      if (disposed) return
      // Wait up to 30s for LLM providers (e.g. platform-hub or custom gateways) to finish registering.
      const deadline = Date.now() + 30_000
      while (!disposed && Date.now() < deadline) {
        const providers = serviceOf(ctx, 'llm')?.listProviders?.() ?? []
        if (providers.length > 0) break
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 2_000)
          t.unref?.()
        })
      }
      if (disposed) return
      try {
        const preview = await sweepOverThreshold({ scheduledOnly: true, dryRun: true, limit: 10 })
        if (preview.matchedCount > 0) {
          logger(`启动后生态巡检发现 ${preview.matchedCount} 个超标活跃定时会话，开始逐个空闲换卷…`)
          await sweepOverThreshold({ scheduledOnly: true, dryRun: false, limit: 10, trigger: 'post-boot-sweep' })
        }
      } catch (error) {
        warn(`启动后自动生态清扫异常：${describeError(error)}`)
      }
    }, delayMs)
    postBootTimer.unref?.()
  }

  function createHttpHandler() {
    return async function handler(req, res) {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }

      let url
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad_url' })
        return
      }
      const pathname = url.pathname.replace(/\/+$/, '') || '/'

      if (pathname === `${ROUTE_PATH}/health`) {
        const cfg = getConfig()
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: '0.5.1',
          enabled: cfg.enabled,
          autoHandover: cfg.autoHandover,
          projectMemoryGuardEnabled: cfg.projectMemoryGuardEnabled !== false,
          projectMemoryReminderEnabled: cfg.projectMemoryReminderEnabled !== false,
          projectMemoryMaxBytes: cfg.projectMemoryMaxBytes,
          projectMemoryMaxLines: cfg.projectMemoryMaxLines,
          inFlightCount: inFlight.size,
          historyCount: ledger.history.length,
          annotationCount: Object.keys(ledger.annotations || {}).length,
          recycleCount: Array.isArray(ledger.recycleHistory) ? ledger.recycleHistory.length : 0,
        })
        return
      }

      if (pathname === `${ROUTE_PATH}/project-memory`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        try {
          const report = await scanProjectMemories()
          sendJson(res, report.ok ? 200 : 503, report)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: describeError(error) })
        }
        return
      }

      if (pathname === `${ROUTE_PATH}/catalog`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        try {
          const catalog = await organizer.listCatalog({
            archiveFilter: url.searchParams.get('archiveFilter') || 'active',
            workspaceId: url.searchParams.get('workspaceId') || 'all',
            search: url.searchParams.get('search') || '',
            tag: url.searchParams.get('tag') || '',
            priority: url.searchParams.get('priority') || 'all',
            favoriteOnly: url.searchParams.get('favoriteOnly') === '1',
            reviewOnly: url.searchParams.get('reviewOnly') === '1',
            scheduledOnly: url.searchParams.get('scheduledOnly') === '1',
            overOnly: url.searchParams.get('overOnly') === '1',
            sortBy: url.searchParams.get('sortBy') || 'updated_desc',
            limit: Number(url.searchParams.get('limit')) || 300,
          })
          sendJson(res, 200, catalog)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: describeError(error) })
        }
        return
      }

      if (pathname === `${ROUTE_PATH}/handoff`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const oldSessionId = url.searchParams.get('oldSessionId') || url.searchParams.get('sessionId') || ''
        const doc = readHandoffMarkdown(oldSessionId)
        sendJson(res, doc.ok ? 200 : 404, doc)
        return
      }

      if (pathname === `${ROUTE_PATH}/status`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        const since = url.searchParams.get('since')
        if (since) {
          const sinceMs = Date.parse(since) || Number(since) || 0
          const recent = ledger.history.filter(item => Date.parse(item.at) > sinceMs)
          sendJson(res, 200, { ok: true, events: recent, inFlightCount: inFlight.size })
          return
        }
        const status = await getEcologyStatus({
          limit: Number(url.searchParams.get('limit')) || 25,
          historyLimit: Number(url.searchParams.get('historyLimit')) || 30,
          includeHealthy: url.searchParams.get('includeHealthy') === '1',
        })
        sendJson(res, 200, status)
        return
      }

      if (pathname === `${ROUTE_PATH}/events`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders?.()
        const hello = JSON.stringify({
          type: 'hello',
          recent: ledger.history.slice(-5),
        })
        res.write(`data: ${hello}\n\n`)
        res.flush?.()
        sseClients.add(res)

        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
            res.flush?.()
          } catch {
            clearInterval(heartbeat)
            sseClients.delete(res)
          }
        }, 25_000)
        heartbeat.unref?.()

        req.on('close', () => {
          clearInterval(heartbeat)
          sseClients.delete(res)
        })
        return
      }

      if (pathname === `${ROUTE_PATH}/api`) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          return
        }
        if (!isSameOriginOrLoopbackPost(req)) {
          sendJson(res, 403, { ok: false, error: 'csrf_blocked' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' })
          return
        }

        const action = String(body?.action ?? '')
        if (action === 'settings') {
          sendJson(res, 200, { ok: true, settings: updateSettings(body) })
          return
        }
        if (action === 'resetSettings') {
          sendJson(res, 200, { ok: true, settings: resetSettings() })
          return
        }
        if (action === 'annotate') {
          try {
            const out = organizer.annotateSessions({
              sessionIds: body?.sessionIds ?? body?.sessionId,
              patch: body?.patch && typeof body.patch === 'object' ? body.patch : body,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'rename') {
          try {
            const out = await organizer.renameSession({
              sessionId: body?.sessionId,
              title: body?.title,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'pin' || action === 'unpin') {
          try {
            const out = await organizer.setPinSessions({
              sessionIds: body?.sessionIds ?? body?.sessionId,
              pinned: action === 'unpin' ? false : body?.pinned !== false,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'archive') {
          try {
            const out = await organizer.setArchiveSessions({
              sessionIds: body?.sessionIds ?? body?.sessionId,
              archived: body?.archived !== false,
              allowScheduledArchive: body?.allowScheduledArchive === true,
              stopActivity: body?.stopActivity === true,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'unarchive') {
          try {
            const targets = body?.sessionIds ?? body?.sessionId
            const out = await organizer.setArchiveSessions({
              sessionIds: targets,
              archived: false,
            })
            sendJson(res, 200, {
              ...out,
              ...(typeof body?.sessionId === 'string' ? { sessionId: body.sessionId.trim(), archived: false } : {}),
            })
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'move') {
          try {
            const out = await organizer.moveSessions({
              sessionIds: body?.sessionIds ?? body?.sessionId,
              targetWorkspaceId: body?.targetWorkspaceId,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'recycle') {
          try {
            const out = await organizer.recycleSessions({
              sessionIds: body?.sessionIds ?? body?.sessionId,
              callerSessionId: body?.callerSessionId || '',
              deleteSchedules: body?.deleteSchedules === true,
              stopActivity: body?.stopActivity === true,
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'purgeArchived') {
          try {
            const out = await organizer.purgeArchived({
              dryRun: body?.dryRun === true,
              activeGuardMinutes: body?.activeGuardMinutes ?? 60,
              protectFavorites: body?.protectFavorites !== false,
              cleanOrphanCache: body?.cleanOrphanCache !== false,
              pruneGhostIds: body?.pruneGhostIds !== false,
              deleteSchedules: body?.deleteSchedules === true,
              callerSessionId: body?.callerSessionId || '',
            })
            sendJson(res, 200, out)
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'bad_request', error: describeError(error) })
          }
          return
        }
        if (action === 'handover') {
          const sid = String(body?.sessionId ?? '').trim()
          if (!sid) {
            sendJson(res, 400, { ok: false, error: 'missing_session_id' })
            return
          }
          const result = await startHandover(sid, {
            trigger: 'http',
            force: body?.force !== false,
            summary: body?.summary,
            wait: body?.wait === true,
          })
          sendJson(res, 200, result)
          return
        }
        if (action === 'sweep') {
          const result = await sweepOverThreshold({
            scheduledOnly: body?.scheduledOnly !== false,
            dryRun: body?.dryRun === true,
            limit: body?.limit ?? 5,
            trigger: 'http-sweep',
          })
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 400, { ok: false, error: 'unknown_action' })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not_found' })
    }
  }

  function registerTools(toolsCtx) {
    const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

    if (typeof toolsCtx?.tools?.guard === 'function') {
      if (typeof toolsCtx.effect === 'function') {
        toolsCtx.effect(() => {
          const disposeGuard = toolsCtx.tools.guard(projectMemoryGuard)
          return typeof disposeGuard === 'function' ? disposeGuard : () => {}
        }, 'session-ecology: project-memory write guard')
      } else {
        toolsCtx.tools.guard(projectMemoryGuard)
      }
    }

    toolsCtx.tools.register(
      defineTool({
        name: 'fleet_ecology_status',
        description:
          'Inspect DSH conversation ecology health across active scheduled patrols and workspace sessions (3-gate token pressure/surface/fatigue ratios, over-threshold sessions, recent handovers) and optionally workspace PROJECT.md health (`include_project_memory=true`).',
        parameters: {
          limit: { type: 'number', description: 'Max sessions to return (default 25, max 100).' },
          include_healthy: { type: 'boolean', description: 'Include unscheduled healthy sessions (default false).' },
          include_project_memory: {
            type: 'boolean',
            description: 'Also scan workspace PROJECT.md byte/line watermarks and broken links (default false).',
          },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
        async execute(args) {
          const status = await getEcologyStatus({
            limit: args?.limit ?? 25,
            includeHealthy: args?.include_healthy === true,
          })
          if (args?.include_project_memory === true) {
            status.projectMemory = await scanProjectMemories()
          }
          return status
        },
      })
    )

    toolsCtx.tools.register(
      defineTool({
        name: 'fleet_session_handover',
        description:
          'Roll a bloated or long-running Session over into a fresh grouped continuation Session (`#2`, `#3`...), inheriting model/preset/permissions/pin, atomically migrating active schedules, archiving the old Session after idle completion, and reporting to Feishu. Omit session_id to schedule rollover of the calling Session right after the current turn finishes.',
        parameters: {
          session_id: {
            type: 'string',
            description: 'Target full Session id (`session-<uuid>`). Omit to roll over the calling Session after this turn completes.',
          },
          summary: {
            type: 'string',
            description: 'Optional structured handoff summary markdown. When provided, skips the extra self-summary LLM step.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Preview 3-gate evaluation and active schedules without mutating anything.',
          },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
        async execute(args, exec) {
          const callerId = exec?.agent?.session?.id
          const targetId = typeof args?.session_id === 'string' && args.session_id.trim() !== ''
            ? args.session_id.trim()
            : callerId
          if (!targetId) {
            return { ok: false, code: 'missing_session_id', message: 'No target session_id or calling session.' }
          }

          const snap = await readAnySessionSnapshot(targetId)
          const evaluation = evaluateSessionEcology(snap, getConfig())
          const schedules = await listActiveSchedulesOf(targetId)

          if (args?.dry_run === true) {
            return {
              ok: true,
              dryRun: true,
              sessionId: targetId,
              title: snap.title,
              cwd: snap.cwd,
              evaluation,
              activeSchedules: schedules.map(s => ({ id: s.id, title: s.title, kind: s.kind })),
            }
          }

          // Calling session is inside its own active turn right now -> defer cleanly until `turn/end`!
          if (targetId === callerId) {
            deferredSelfRequests.set(targetId, {
              callerSummary: typeof args?.summary === 'string' ? args.summary.trim() : '',
            })
            return {
              ok: true,
              deferredUntilTurnEnd: true,
              sessionId: targetId,
              message: 'Handover queued: will execute automatically as soon as this turn completes.',
              activeSchedulesToMigrate: schedules.length,
            }
          }

          return startHandover(targetId, {
            trigger: 'tool',
            force: true,
            summary: args?.summary,
            wait: true,
          })
        },
      })
    )

    toolsCtx.tools.register(
      defineTool({
        name: 'fleet_ecology_sweep',
        description:
          'Scan and sequentially roll over idle Sessions that exceed the 3-gate ecology threshold. Defaults to scheduled_only=true so only bloated active scheduled patrols are swept while historical unscheduled chats stay untouched.',
        parameters: {
          scheduled_only: {
            type: 'boolean',
            description: 'Only sweep Sessions that own at least one active schedule (default true).',
          },
          dry_run: {
            type: 'boolean',
            description: 'Only list matching over-threshold Sessions without triggering handover (default false).',
          },
          limit: {
            type: 'number',
            description: 'Max Sessions to sweep in one call (default 5, max 20).',
          },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
        async execute(args) {
          return sweepOverThreshold({
            scheduledOnly: args?.scheduled_only !== false,
            dryRun: args?.dry_run === true,
            limit: args?.limit ?? 5,
            trigger: 'tool-sweep',
          })
        },
      })
    )

    toolsCtx.tools.register(
      defineTool({
        name: 'fleet_session_organize',
        description:
          'Organize and batch-manage DSH Sessions across workspaces: list/filter catalog (`list`), set favorite/review-later/1..5 priority/tags/notes (`annotate`), rename (`rename`), pin/unpin (`pin`/`unpin`), archive/unarchive with orphan-schedule protection (`archive`/`unarchive`), zero-restart cross-workspace move (`move`), safely move specific Sessions to the Windows System Recycle Bin (`recycle`), or one-shot zero-restart purge of all archived Sessions + ghost workspace IDs + orphan caches into the Recycle Bin (`purge_archived`).',
        parameters: {
          action: {
            type: 'string',
            enum: ['list', 'annotate', 'rename', 'pin', 'unpin', 'archive', 'unarchive', 'move', 'recycle', 'purge_archived'],
            description: 'Operation to perform.',
          },
          session_id: {
            type: 'string',
            description: 'Single target full Session id (`session-<uuid>`).',
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Batch target Session ids (`session-<uuid>[]`, up to 200).',
          },
          title: {
            type: 'string',
            description: 'New title when action="rename" (capped at 80 UTF-8 bytes).',
          },
          favorite: {
            type: 'boolean',
            description: 'Set favorite star when action="annotate", or filter when action="list".',
          },
          review_later: {
            type: 'boolean',
            description: 'Set review-later flag when action="annotate", or filter when action="list".',
          },
          priority: {
            type: 'number',
            description: 'Priority 1..5 (`1`=highest .. `5`=lowest, `3`=normal) for action="annotate" or "list".',
          },
          tags: {
            type: 'string',
            description: 'Comma-separated tags to replace the tag list when action="annotate" (or single tag filter when action="list").',
          },
          add_tags: {
            type: 'string',
            description: 'Comma-separated tags to append when action="annotate".',
          },
          remove_tags: {
            type: 'string',
            description: 'Comma-separated tags to remove when action="annotate".',
          },
          clear_tags: {
            type: 'boolean',
            description: 'Clear all tags when action="annotate".',
          },
          note: {
            type: 'string',
            description: 'Session note/remark (<= 2000 chars) when action="annotate".',
          },
          target_workspace_id: {
            type: 'string',
            description: 'Target workspace ID (`ws-...`), exact workspace title, or workspace path when action="move".',
          },
          allow_scheduled_archive: {
            type: 'boolean',
            description: 'Allow archiving Sessions that still own active schedules (default false; rollover is recommended instead).',
          },
          delete_schedules: {
            type: 'boolean',
            description: 'When action="recycle" or "purge_archived", also delete active schedules owned by target Sessions (default false).',
          },
          dry_run: {
            type: 'boolean',
            description: 'When action="purge_archived", run read-only survey preview (candidates, estimated freed MB, ghost IDs, orphan caches) without mutating anything.',
          },
          active_guard_minutes: {
            type: 'number',
            description: 'When action="purge_archived", skip archived Sessions written within N minutes (default 60; set 0 to disable).',
          },
          protect_favorites: {
            type: 'boolean',
            description: 'When action="purge_archived", skip archived Sessions marked ⭐ favorite or 📌 review_later (default true).',
          },
          clean_orphan_cache: {
            type: 'boolean',
            description: 'When action="purge_archived", also move orphan storages/session_projcache/sessions/*.json files into Recycle Bin (default true).',
          },
          prune_ghost_ids: {
            type: 'boolean',
            description: 'When action="purge_archived", also prune dangling ghost Session IDs from workspaceRegistry in memory with zero restart (default true).',
          },
          archive_filter: {
            type: 'string',
            enum: ['active', 'archived', 'all'],
            description: 'Archive filter when action="list" (default "active").',
          },
          workspace_id: {
            type: 'string',
            description: 'Workspace ID or "ungrouped" or "all" when action="list".',
          },
          search: {
            type: 'string',
            description: 'Keyword filter across title, sessionId, tags, note, and workspace when action="list".',
          },
          scheduled_only: {
            type: 'boolean',
            description: 'Only list Sessions with active schedules when action="list".',
          },
          over_only: {
            type: 'boolean',
            description: 'Only list warn/over-threshold Sessions when action="list".',
          },
          sort_by: {
            type: 'string',
            enum: ['updated_desc', 'ecology_desc', 'priority_asc', 'title_asc', 'updated_asc'],
            description: 'Sort order when action="list" (default "updated_desc").',
          },
          limit: {
            type: 'number',
            description: 'Max rows when action="list" (default 50, max 300).',
          },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
        async execute(args, exec) {
          const act = String(args?.action || 'list').trim()
          const targets = Array.isArray(args?.session_ids) && args.session_ids.length > 0
            ? args.session_ids
            : args?.session_id

          if (act === 'list') {
            return organizer.listCatalog({
              archiveFilter: args?.archive_filter || 'active',
              workspaceId: args?.workspace_id || 'all',
              search: args?.search || '',
              tag: args?.tags || '',
              priority: args?.priority ?? 'all',
              favoriteOnly: args?.favorite === true,
              reviewOnly: args?.review_later === true,
              scheduledOnly: args?.scheduled_only === true,
              overOnly: args?.over_only === true,
              sortBy: args?.sort_by || 'updated_desc',
              limit: Math.min(300, Math.max(1, Number(args?.limit) || 50)),
            })
          }

          if (act === 'annotate') {
            const patch = {}
            if (typeof args?.favorite === 'boolean') patch.favorite = args.favorite
            if (typeof args?.review_later === 'boolean') patch.reviewLater = args.review_later
            if (args?.priority !== undefined) patch.priority = args.priority
            if (args?.tags !== undefined) patch.tags = args.tags
            if (args?.add_tags !== undefined) patch.addTags = args.add_tags
            if (args?.remove_tags !== undefined) patch.removeTags = args.remove_tags
            if (args?.clear_tags === true) patch.clearTags = true
            if (args?.note !== undefined) patch.note = args.note
            return organizer.annotateSessions({ sessionIds: targets, patch })
          }

          if (act === 'rename') {
            const sid = Array.isArray(targets) ? targets[0] : targets
            return organizer.renameSession({ sessionId: sid, title: args?.title })
          }

          if (act === 'pin' || act === 'unpin') {
            return organizer.setPinSessions({ sessionIds: targets, pinned: act === 'pin' })
          }

          if (act === 'archive' || act === 'unarchive') {
            return organizer.setArchiveSessions({
              sessionIds: targets,
              archived: act === 'archive',
              allowScheduledArchive: args?.allow_scheduled_archive === true,
            })
          }

          if (act === 'move') {
            let wsSelector = String(args?.target_workspace_id || '').trim()
            const registry = serviceOf(ctx, 'workspaceRegistry')
            const wsList = registry?.list?.() ?? []
            const matchedWs = wsList.find(w =>
              w.id === wsSelector
              || (w.title && w.title.toLowerCase() === wsSelector.toLowerCase())
              || (w.path && w.path.toLowerCase() === wsSelector.toLowerCase())
            )
            if (matchedWs) wsSelector = matchedWs.id
            return organizer.moveSessions({ sessionIds: targets, targetWorkspaceId: wsSelector })
          }

          if (act === 'recycle') {
            const callerId = exec?.agent?.session?.id || ''
            return organizer.recycleSessions({
              sessionIds: targets,
              callerSessionId: callerId,
              deleteSchedules: args?.delete_schedules === true,
            })
          }

          if (act === 'purge_archived') {
            const callerId = exec?.agent?.session?.id || ''
            return organizer.purgeArchived({
              dryRun: args?.dry_run === true,
              activeGuardMinutes: args?.active_guard_minutes ?? 60,
              protectFavorites: args?.protect_favorites !== false,
              cleanOrphanCache: args?.clean_orphan_cache !== false,
              pruneGhostIds: args?.prune_ghost_ids !== false,
              deleteSchedules: args?.delete_schedules === true,
              callerSessionId: callerId,
            })
          }

          return { ok: false, error: `Unsupported action: ${act}` }
        },
      })
    )
  }

  function dispose() {
    disposed = true
    clearTimeout(postBootTimer)
    for (const entry of inFlight.values()) {
      clearTimeout(entry.timer)
    }
    inFlight.clear()
    for (const res of sseClients) {
      try { res.end() } catch {}
    }
    sseClients.clear()
  }

  return {
    getConfig,
    updateSettings,
    resetSettings,
    readHandoffMarkdown,
    setScheduleService,
    setWorkingDirectoryService,
    setWebServerOrigin,
    handleSessionEvent,
    handleTurnEnd,
    startHandover,
    getEcologyStatus,
    sweepOverThreshold,
    schedulePostBootSweep,
    createHttpHandler,
    registerTools,
    projectMemoryGuard,
    scanProjectMemories,
    buildMemoryReminderForContext,
    organizer,
    dispose,
    _internals: {
      inFlight,
      ledger,
      pendingTitles,
      activatingNewSessionIds,
      formatCompactTokens,
    },
  }
}

export function apply(ctx, rawConfig) {
  const steward = createEcologySteward(ctx, rawConfig)
  const REMINDER_CONTEXT_NAME = 'session-ecology:project-memory-reminder'

  // Capture live assistant/tool chunks during `summarizing`, and defer `turn/end` by one microtask.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message' || event?.type === 'tool/call') {
      steward.handleSessionEvent(session, event)
      return
    }
    if (event?.type !== 'turn/end') return
    queueMicrotask(() => {
      void steward.handleTurnEnd(session, event)
    })
  })

  // Guard against any older host layer stripping `interpolate: false` on runtime contexts containing `{{`.
  ctx.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    try {
      const listed = Array.isArray(result?.contexts) ? result.contexts : []
      const needsEscape = c => c?.name === REMINDER_CONTEXT_NAME
        && c.interpolate !== false
        && typeof c.text === 'string'
        && c.text.includes('{{')
      if (listed.some(needsEscape)) {
        return {
          ...result,
          contexts: listed.map(c => (needsEscape(c) ? { ...c, text: verbatimPromptText(c.text) } : c)),
        }
      }
    } catch {}
    return result
  }, { prepend: true })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['schedule'], (sctx) => {
      steward.setScheduleService(sctx.schedule)
      sctx.effect?.(() => () => steward.setScheduleService(null), 'session-ecology: schedule ref')
    })

    ctx.inject(['workingDirectory'], (wdctx) => {
      steward.setWorkingDirectoryService(wdctx.workingDirectory)
      wdctx.effect?.(() => () => steward.setWorkingDirectoryService(null), 'session-ecology: workingDirectory ref')
    })

    ctx.inject(['tools'], (tctx) => {
      steward.registerTools(tctx)
    })

    ctx.inject(['systemPrompt'], (pctx) => {
      const prompt = pctx.systemPrompt
      if (typeof prompt?.context !== 'function') return
      const registerCtx = () => prompt.context({
        name: REMINDER_CONTEXT_NAME,
        order: 310,
        interpolate: false,
        text: context => steward.buildMemoryReminderForContext(context),
      })
      if (typeof pctx.effect === 'function') {
        pctx.effect(registerCtx, 'session-ecology: project-memory reminder')
      } else {
        registerCtx()
      }
    })

    ctx.inject(['webServer'], (wctx) => {
      steward.setWebServerOrigin(() => {
        try { return wctx.webServer.origin } catch { return '' }
      })
      const handler = steward.createHttpHandler()
      if (typeof wctx.effect === 'function') {
        wctx.effect(() => wctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler,
        }), 'session-ecology: http routes')
      } else {
        wctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler })
      }
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      steward.schedulePostBootSweep()
      return () => steward.dispose()
    }, 'session-ecology: lifecycle')
  } else {
    steward.schedulePostBootSweep()
    ctx.on?.('dispose', () => steward.dispose())
  }

  return steward
}

export default { name, inject, apply }
