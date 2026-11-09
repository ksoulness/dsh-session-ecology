import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import {
  applyAnnotationPatch,
  buildContinuationTitle,
  buildMechanicalFallbackSummary,
  collectBotSessionIds,
  encodeFsSessionSegment,
  encodeProjectSegment,
  evaluateSessionEcology,
  extractLastExchangeFromEvents,
  extractLastExchangeFromTurns,
  inheritAnnotationForContinuation,
  isSyntheticEcologyPrompt,
  parseTagInput,
  parseTitleGeneration,
  scheduleCreateRequestOf,
  selectSummaryModelOverride,
} from '../lib/core.js'
import { createEcologySteward } from '../lib/index.js'

test('3-gate model-adaptive thresholds scale dynamically with contextWindow and model tier', () => {
  // Healthy 1M standard session
  const healthy = evaluateSessionEcology({
    contextPressure: { contextWindow: 1_000_000, pressureTokens: 180_000, surfaceTokens: 420_000 },
    tokenUsage: { totals: { uncachedInputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 80_000_000, cacheWriteTokens: 0 } },
    modelSelection: { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(healthy.triggered, false)
  assert.equal(healthy.status, 'healthy')
  assert.equal(healthy.thresholds.pressureLimit, 400_000)
  assert.equal(healthy.thresholds.surfaceLimit, 1_000_000)
  assert.equal(healthy.thresholds.fatigueLimit, 350_000_000)

  // Gate 1 trigger on 400K window (40% = 160K)
  const gate1 = evaluateSessionEcology({
    contextPressure: { contextWindow: 400_000, pressureTokens: 162_000, surfaceTokens: 210_000 },
    tokenUsage: { totals: { uncachedInputTokens: 500_000, outputTokens: 50_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 0 } },
    modelSelection: { provider: 'openai-responses', model: 'codex/gpt-6.1-sol' },
  })
  assert.equal(gate1.triggered, true)
  assert.equal(gate1.highTier, true)
  assert.equal(gate1.thresholds.pressureLimit, 160_000)
  assert.equal(gate1.thresholds.fatigueLimit, 60_000_000) // 150 * 400K
  assert.match(gate1.reasons[0], /压后真实负载/)

  // Gate 3 pro-tier trigger (161.7M on `deepseek-v4-pro` >= 150M)
  const proPatrol = evaluateSessionEcology({
    contextPressure: { contextWindow: 1_000_000, pressureTokens: 284_000, surfaceTokens: 613_000 },
    tokenUsage: { totals: { uncachedInputTokens: 2_000_000, outputTokens: 200_000, cacheReadTokens: 159_500_000, cacheWriteTokens: 0 } },
    modelSelection: { provider: 'deepseek-gateway', model: 'deepseek-v4-pro' },
  })
  assert.equal(proPatrol.triggered, true)
  assert.equal(proPatrol.highTier, true)
  assert.match(proPatrol.reasons[0], /累计折叠疲劳/)

  // Missing state gracefully falls back without NaN or throwing
  const empty = evaluateSessionEcology({})
  assert.equal(empty.triggered, false)
  assert.equal(empty.metrics.totalTokens, 0)
})

test('selectSummaryModelOverride defaults to null out-of-the-box and overrides high-cost models when fallbackRoute is set', () => {
  // Out-of-the-box default: no fallbackRoute configured -> always keep current session model
  assert.equal(selectSummaryModelOverride({ provider: 'openai-responses', model: 'codex/gpt-6.1-sol' }), null)
  assert.equal(selectSummaryModelOverride({ provider: 'anthropic', model: 'claude-opus-4-6-thinking' }), null)

  // Configured fallbackRoute + allowedProviders
  const fb = { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' }
  const allowed = ['deepseek-gateway', 'antigravity']

  assert.equal(selectSummaryModelOverride({ provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' }, fb, allowed), null)
  assert.equal(selectSummaryModelOverride({ provider: 'deepseek-gateway', model: 'deepseek-v4-pro' }, fb, allowed), null)
  assert.equal(selectSummaryModelOverride({ provider: 'antigravity', model: 'gemini-3.8-flash' }, fb, allowed), null)
  assert.equal(selectSummaryModelOverride({ provider: 'antigravity', model: 'gemini-4-argon' }, fb, allowed), null)

  assert.deepEqual(
    selectSummaryModelOverride({ provider: 'openai-responses', model: 'codex/gpt-6.1-sol' }, fb, allowed),
    fb
  )
  assert.deepEqual(
    selectSummaryModelOverride({ provider: 'antigravity', model: 'claude-opus-4-6-thinking' }, fb, allowed),
    fb
  )
  assert.deepEqual(
    selectSummaryModelOverride({ provider: 'legacy-provider', model: 'custom-model' }, fb, allowed),
    fb
  )
})

test('continuation title strips legacy suffixes, increments generation, and respects 80-byte UTF-8 cap', () => {
  const step2 = buildContinuationTitle('1.📡行情监控巡检 · 每 4h 报告')
  assert.equal(step2.title, '1.📡行情监控巡检 · 每 4h 报告 · #2')
  assert.equal(step2.generation, 2)
  assert.ok(Buffer.byteLength(step2.title, 'utf8') <= 80)

  const step3 = buildContinuationTitle(step2.title)
  assert.equal(step3.title, '1.📡行情监控巡检 · 每 4h 报告 · #3')
  assert.equal(step3.generation, 3)

  const fromLegacy = parseTitleGeneration('✨系统健康巡检 · 每小时 :25（继承）')
  assert.equal(fromLegacy.baseTitle, '✨系统健康巡检 · 每小时 :25')
  assert.equal(fromLegacy.generation, 2)
  const step3Legacy = buildContinuationTitle('✨系统健康巡检 · 每小时 :25（继承）')
  assert.equal(step3Legacy.title, '✨系统健康巡检 · 每小时 :25 · #3')

  // Long emoji + CJK title stays strictly <= 80 UTF-8 bytes without broken surrogate characters
  const hugeTitle = '🚀🛰️📊超长中文工作区自动化巡检与多策略实盘风控对账总控台标题测试再加一串字符验证截断'
  const capped = buildContinuationTitle(hugeTitle, 12, 80)
  assert.ok(Buffer.byteLength(capped.title, 'utf8') <= 80)
  assert.ok(capped.title.endsWith(' · #12'))
  assert.equal(capped.title.includes('\uFFFD'), false)
})

test('collectBotSessionIds extracts all nested ds-bot session IDs and scheduleCreateRequestOf handles all kinds', () => {
  const botIds = collectBotSessionIds({
    bots: {
      b1: { sessionId: 'session-11111111-2222-3333-4444-555555555555', parts: ['session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] },
    },
    rooms: { 'session-99999999-8888-7777-6666-555555555555': { name: 'room' } },
  })
  assert.equal(botIds.size, 3)
  assert.ok(botIds.has('session-11111111-2222-3333-4444-555555555555'))
  assert.ok(botIds.has('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))
  assert.ok(botIds.has('session-99999999-8888-7777-6666-555555555555'))

  const cronReq = scheduleCreateRequestOf({
    id: 'schedule-1',
    kind: 'cron',
    title: '每 4h 巡检',
    prompt: '执行巡检',
    expression: '2 */4 * * *',
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(cronReq.skip, false)
  assert.deepEqual(cronReq.request.cron, { expression: '2 */4 * * *', time_zone: 'Asia/Shanghai' })

  const expiredAt = scheduleCreateRequestOf({
    id: 'schedule-2',
    kind: 'after',
    title: '激活poke',
    prompt: '好',
    scheduledAt: '2020-01-01T00:00:00.000Z',
  }, Date.parse('2026-11-09T00:00:00.000Z'))
  assert.equal(expiredAt.skip, true)
  assert.equal(expiredAt.reason, 'expired_one_shot')
})

test('end-to-end 2-stage self-summarized rollover, GPT model override + default preservation, schedule rollback, and Turn-1 title guard', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-test-'))
  fs.mkdirSync(path.join(tmpHome, 'bot'), { recursive: true })
  fs.writeFileSync(path.join(tmpHome, 'bot', 'state.json'), JSON.stringify({
    bots: { main: { sessionId: 'session-bbbbbbbb-0000-0000-0000-000000000001' } },
  }))

  // Local fake Feishu notify endpoint
  const feishuPayloads = []
  const notifyServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      feishuPayloads.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'om_test_1' }))
    })
  })
  await new Promise(resolve => notifyServer.listen(0, '127.0.0.1', resolve))
  const notifyPort = notifyServer.address().port

  try {
    const oldId = 'session-fa067da4-ba0f-4326-841f-07a97e0f32b3'
    const botId = 'session-bbbbbbbb-0000-0000-0000-000000000001'
    let createdCounter = 0

    const sessionsMap = new Map()
    const projectionsBySession = new Map()
    const schedulesBySession = new Map()
    const archivedIds = []
    const pinnedIds = [oldId]
    const appliedPermissions = new Map()
    let globalDefaultModel = { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' }
    const promptsReceived = []

    const oldEvents = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { arguments: { path: '/workspace/monitor-app/marshal.mjs' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第 1 轮巡检正常' }] } } },
    ]
    const oldSessionObj = {
      id: oldId,
      header: { id: oldId, cwd: '/workspace/monitor-app', agentPreset: 'minimal-grayscale' },
      events: () => oldEvents,
    }
    sessionsMap.set(oldId, oldSessionObj)

    projectionsBySession.set(oldId, {
      contextPressure: { contextWindow: 400_000, pressureTokens: 200_000, surfaceTokens: 450_000 },
      tokenUsage: { totals: { uncachedInputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 80_000_000, cacheWriteTokens: 0 } },
      sessionStats: { turns: 10, steps: 120 },
      title: '1.📡行情监控巡检 · 每 4h 报告',
      workingDirectory: '/workspace/monitor-app',
      agentPreset: 'minimal-grayscale',
      modelSelection: { lastUsed: { provider: 'openai-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'high' }, pending: null },
      permissions: { preset: 'read-only', sandbox: 'read-only', approval: 'never' },
      inbox: { 'next-turn': [], 'next-step': [] },
      turnOutline: { turns: [{ turn: 10, prompt: '巡检', response: '全部正常' }] },
    })

    schedulesBySession.set(oldId, [
      {
        id: 'schedule-old-1',
        kind: 'cron',
        title: '每 4h 行情巡检',
        prompt: '先 read 规则文件再跑行情巡检',
        expression: '2 */4 * * *',
        timeZone: 'Asia/Shanghai',
      },
    ])

    let failNextScheduleCreate = false

    const fakeCtx = {
      sessions: { get: id => sessionsMap.get(id) },
      agents: {
        get: id => (sessionsMap.has(id) ? { session: sessionsMap.get(id), inbox: [], whenIdle: async () => {} } : undefined),
      },
      sessionProjections: {
        stateOf: (session, key) => projectionsBySession.get(session.id)?.[key],
      },
      agentDefaultModel: {
        currentSelection: () => ({ ...globalDefaultModel }),
        saveSelection: async (sel) => { globalDefaultModel = { ...sel } },
      },
      permissionPresets: {
        set: (session, preset) => { appliedPermissions.set(session.id, preset) },
      },
      workspaceRegistry: {
        archivedSessionIds: archivedIds,
        pinnedSessionIds: pinnedIds,
        list: () => [{ id: 'ws-mon', title: 'monitor-app', path: '/workspace/monitor-app', sessionIds: [oldId] }],
        resolveByPath: async () => ({ id: 'ws-mon', title: 'monitor-app', path: '/workspace/monitor-app' }),
        archiveSession: async (id) => { if (!archivedIds.includes(id)) archivedIds.push(id) },
        pinSession: async (id) => { if (!pinnedIds.includes(id)) pinnedIds.unshift(id) },
      },
      schedule: {
        catalog: async () => {
          const out = []
          for (const [sid, list] of schedulesBySession.entries()) {
            for (const r of list) out.push({ ...r, sessionId: sid, status: 'active' })
          }
          return out
        },
        list: async ({ sessionId }) => [...(schedulesBySession.get(sessionId) ?? [])],
        create: async (sessionId, req) => {
          if (failNextScheduleCreate) throw new Error('simulated_schedule_write_error')
          const rec = {
            id: `schedule-new-${++createdCounter}`,
            kind: req.cron ? 'cron' : 'at',
            title: req.title,
            prompt: req.prompt,
            ...(req.cron ? { expression: req.cron.expression, timeZone: req.cron.time_zone } : {}),
          }
          if (!schedulesBySession.has(sessionId)) schedulesBySession.set(sessionId, [])
          schedulesBySession.get(sessionId).push(rec)
          return rec
        },
        delete: async ({ sessionId, id }) => {
          const list = schedulesBySession.get(sessionId) ?? []
          schedulesBySession.set(sessionId, list.filter(x => x.id !== id))
          return { id, deleted: true }
        },
      },
      sessionController: {
        create: async (req) => {
          assert.equal(req.workspaceId, 'ws-mon', 'must create via workspaceId so session is grouped immediately')
          assert.equal(req.agentPreset, 'minimal-grayscale')
          const newId = `session-new0000${++createdCounter}-1111-2222-3333-444444444444`
          const newSess = { id: newId, header: { id: newId, cwd: '/workspace/monitor-app', agentPreset: req.agentPreset }, events: () => [] }
          sessionsMap.set(newId, newSess)
          projectionsBySession.set(newId, { inbox: { 'next-turn': [], 'next-step': [] } })
          return { sessionId: newId, agentPreset: req.agentPreset }
        },
        rename: async ({ sessionId, title }) => {
          const p = projectionsBySession.get(sessionId) ?? {}
          p.title = title
          projectionsBySession.set(sessionId, p)
          return { title, seq: 1 }
        },
        selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
          // Simulate DSH's background mutation of global default model!
          globalDefaultModel = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
          const p = projectionsBySession.get(sessionId) ?? {}
          p.modelSelection = { lastUsed: null, pending: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }
          projectionsBySession.set(sessionId, p)
          return { selected: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }
        },
        resolveAgent: async sessionId => ({ agent: { session: sessionsMap.get(sessionId) } }),
        prompt: async (req) => {
          promptsReceived.push(req)
          return { accepted: true }
        },
      },
    }

    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      summaryFallbackRoute: { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' },
      allowedProviders: ['deepseek-gateway', 'antigravity'],
    })
    steward.setScheduleService(fakeCtx.schedule)
    steward.setWebServerOrigin(() => `http://127.0.0.1:${notifyPort}`)

    // 1. ds-bot session must be ignored completely
    const botRes = await steward.startHandover(botId, { trigger: 'auto', force: true })
    assert.equal(botRes.ok, false)
    assert.equal(botRes.code, 'ds_bot_managed_session')

    // 2. Test schedule failure rollback first (using explicit caller summary):
    failNextScheduleCreate = true
    const failedRes = await steward.startHandover(oldId, {
      trigger: 'manual',
      force: true,
      summary: '测试回滚摘要',
    })
    assert.equal(failedRes.ok, false)
    assert.equal(schedulesBySession.get(oldId).length, 1, 'old schedule must remain intact on failure')
    assert.equal(archivedIds.includes(oldId), false, 'old session must NOT be archived when schedule migration fails')
    failNextScheduleCreate = false

    // Pre-annotate `oldId` to verify `0.3.0` automatic annotation inheritance onto `#2`
    steward.organizer.annotateSessions({
      sessionIds: [oldId],
      patch: { favorite: true, reviewLater: true, priority: 1, tags: '运维，监控, 运维', note: '核心监控巡检线' },
    })

    // 3. Trigger normal automatic turn/end on over-threshold `oldId`
    await steward.handleTurnEnd(oldSessionObj, {
      type: 'turn/end',
      data: { turn: 10, reason: { kind: 'completed' } },
    })

    // Stage 1: should now be `summarizing`, having temporarily switched `oldId` from `codex/gpt-6.1-sol` -> `deepseek-v4.1-flash`
    assert.equal(steward._internals.inFlight.get(oldId)?.phase, 'summarizing')
    assert.deepEqual(
      projectionsBySession.get(oldId).modelSelection.pending,
      { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' },
      'must not burn GPT quota during self-summary'
    )
    assert.deepEqual(
      globalDefaultModel,
      { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' },
      'global default model must remain untouched'
    )
    assert.equal(promptsReceived.length, 1)
    assert.match(promptsReceived[0].content[0].text, /自动换卷自总结/)

    // Simulate the self-summary turn completing with structured handoff output
    oldEvents.push(
      { type: 'turn/start', data: { turn: 11 } },
      {
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: '### 会话交接单\n- 核心职责：每 4h 行情监控对账\n- 最新状态：延迟 12ms，无异常' }],
          },
        },
      }
    )

    await steward.handleTurnEnd(oldSessionObj, {
      type: 'turn/end',
      data: { turn: 11, reason: { kind: 'completed' } },
    })

    // Verify Stage 2 completed atomically!
    const history = steward._internals.ledger.history
    assert.equal(history.length, 1)
    const rec = history[0]
    assert.equal(rec.oldSessionId, oldId)
    assert.equal(rec.newTitle, '1.📡行情监控巡检 · 每 4h 报告 · #2')
    assert.equal(rec.summarySource, 'self-llm')
    assert.equal(rec.archived, true)
    assert.ok(fs.existsSync(rec.handoffFilePath))

    // Schedules moved: old has 0, new has 1
    assert.equal(schedulesBySession.get(oldId).length, 0)
    assert.equal(schedulesBySession.get(rec.newSessionId).length, 1)
    assert.equal(schedulesBySession.get(rec.newSessionId)[0].title, '每 4h 行情巡检')

    // Inherited user's original GPT model, `read-only` permission, and `pin` onto newSessionId without polluting global default!
    assert.deepEqual(
      projectionsBySession.get(rec.newSessionId).modelSelection.pending,
      { provider: 'openai-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'high' }
    )
    assert.deepEqual(globalDefaultModel, { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' })
    assert.equal(appliedPermissions.get(rec.newSessionId), 'read-only')
    assert.ok(pinnedIds.includes(rec.newSessionId))
    assert.ok(archivedIds.includes(oldId))

    // Verify `0.3.0` annotation inheritance (`favorite`, `priority`, `tags`, `note` inherited; `reviewLater` cleared)
    const newAnn = steward.organizer.getAnnotation(rec.newSessionId)
    assert.equal(newAnn.favorite, true)
    assert.equal(newAnn.reviewLater, false)
    assert.equal(newAnn.priority, 1)
    assert.deepEqual(newAnn.tags, ['运维', '监控'])
    assert.equal(newAnn.note, '核心监控巡检线')

    // Feishu report was pushed
    assert.equal(feishuPayloads.length, 1)
    assert.match(feishuPayloads[0].text, /会话生态自动换卷/)
    assert.match(feishuPayloads[0].text, /#2/)

    // Simulate DSH auto-title clobbering `newSessionId` during Turn 1, then Turn 1 ending:
    projectionsBySession.get(rec.newSessionId).title = '已接手第 2 卷确认'
    await steward.handleTurnEnd(sessionsMap.get(rec.newSessionId), {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(
      projectionsBySession.get(rec.newSessionId).title,
      '1.📡行情监控巡检 · 每 4h 报告 · #2',
      'pendingTitles guard must restore continuation title after Turn 1 auto-title'
    )

    // 4. Verify handoff markdown reader + path confinement + settings clamp/reset (v0.2.0)
    const handoffDoc = steward.readHandoffMarkdown(oldId)
    assert.equal(handoffDoc.ok, true)
    assert.match(handoffDoc.markdown, /会话交接单/)

    // Attempt path traversal outside handoffDir -> must be rejected!
    steward._internals.ledger.transferred['session-evil'] = {
      newSessionId: 'session-evil-2',
      handoffFilePath: path.join(tmpHome, 'bot', 'state.json'),
    }
    const blockedDoc = steward.readHandoffMarkdown('session-evil')
    assert.equal(blockedDoc.ok, false)
    assert.equal(blockedDoc.error, 'forbidden_path')

    const clamped = steward.updateSettings({ pressureRatio: 9.9, warnRatio: 0.1, enabled: false })
    assert.equal(clamped.pressureRatio, 0.95)
    assert.equal(clamped.warnRatio, 0.30)
    assert.equal(clamped.enabled, false)

    const restored = steward.resetSettings()
    assert.equal(restored.pressureRatio, 0.40)
    assert.equal(restored.warnRatio, 0.75)
    assert.equal(restored.enabled, true)
    assert.deepEqual(restored.summaryFallbackRoute, { provider: 'deepseek-gateway', model: 'deepseek-v4.1-flash' })

    steward.dispose()
  } finally {
    notifyServer.close()
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('buildMechanicalFallbackSummary produces structured digest when LLM summary is empty', () => {
  const md = buildMechanicalFallbackSummary({
    title: '1.🗄️日志归档巡检 · 每日 03:00',
    cwd: '/workspace/archive-service',
    schedules: [{ title: '每日归档巡检', kind: 'daily', prompt: '只读核对归档目录与索引' }],
    touchedFiles: ['/workspace/archive-service/scripts/check.mjs'],
    recentTurns: [{ turn: 18, prompt: '开始巡检', response: '核对 181 条会话无漂移' }],
  })
  assert.match(md, /日志归档巡检/)
  assert.match(md, /每日归档巡检/)
  assert.match(md, /check\.mjs/)
  assert.match(md, /Turn 18/)
})

test('0.3.0 annotation helpers normalize EN/ZH tags, clamp 1..5 priority, and inherit cleanly', () => {
  assert.deepEqual(parseTagInput('#运维, 监控，Infra, #infra , 巡检'), ['运维', '监控', 'Infra', '巡检'])

  const p1 = applyAnnotationPatch(null, {
    favorite: true,
    reviewLater: true,
    priority: 1,
    addTags: '核心，监控',
    note: '需要长期保留',
  }, 1000)
  assert.equal(p1.changed, true)
  assert.equal(p1.next.priority, 1)
  assert.deepEqual(p1.next.tags, ['核心', '监控'])

  const p2 = applyAnnotationPatch(p1.next, { removeTags: '核心', addTags: '归档备查' }, 2000)
  assert.deepEqual(p2.next.tags, ['监控', '归档备查'])

  const inherited = inheritAnnotationForContinuation(p2.next, 3000)
  assert.equal(inherited.favorite, true)
  assert.equal(inherited.reviewLater, false)
  assert.equal(inherited.priority, 1)
  assert.deepEqual(inherited.tags, ['监控', '归档备查'])
  assert.equal(inherited.note, '需要长期保留')
})

test('0.3.0 organizer: orphan-schedule archive guard, zero-restart cross-workspace move, and Recycle Bin cascade', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-organizer-test-'))
  const tmpHome = path.join(tmpRoot, 'dsh-home')
  const wsDirA = path.join(tmpRoot, 'ws-alpha')
  const wsDirB = path.join(tmpRoot, 'ws-beta')
  fs.mkdirSync(wsDirA, { recursive: true })
  fs.mkdirSync(wsDirB, { recursive: true })
  const realWsA = fs.realpathSync(wsDirA)
  const realWsB = fs.realpathSync(wsDirB)

  const sid1 = 'session-11111111-aaaa-4444-8888-000000000001'
  const sid2 = 'session-22222222-bbbb-4444-8888-000000000002'
  const subSid2 = 'session-22222222-cccc-4444-8888-000000000099'

  function writeSessionJsonl(cwd, id, extraHeader = {}, events = []) {
    const dir = path.join(tmpHome, 'sessions', encodeProjectSegment(cwd), encodeFsSessionSegment(id))
    fs.mkdirSync(dir, { recursive: true })
    const header = { id, version: 4, cwd, createdAt: 1700000000000, ...extraHeader }
    const lines = [JSON.stringify(header), ...events.map(e => JSON.stringify(e))]
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), `${lines.join('\n')}\n`, 'utf8')
    return dir
  }

  try {
    writeSessionJsonl(realWsA, sid1)
    const sid2OldDir = writeSessionJsonl(realWsA, sid2, {}, [
      { type: 'working-directory/change', seq: 0, time: 1700000000100, data: { cwd: realWsA } },
    ])
    const subSid2Dir = writeSessionJsonl(realWsA, subSid2, { origin: 'subagent', parentSession: sid2, delegationDepth: 1 })

    // Write projcache for sid1 & sid2
    const projCacheDir = path.join(tmpHome, 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(projCacheDir, { recursive: true })
    fs.writeFileSync(path.join(projCacheDir, `${sid1}.json`), JSON.stringify({
      record: { identity: { cwd: realWsA }, rows: { title: { val: 'Alpha 定时巡检' }, workingDirectory: { val: realWsA } } },
    }))
    fs.writeFileSync(path.join(projCacheDir, `${sid2}.json`), JSON.stringify({
      record: { identity: { cwd: realWsA }, rows: { title: { val: '待迁移旧对话' }, workingDirectory: { val: realWsA } } },
    }))

    const archivedIds = []
    const pinnedIds = []
    const wsA = {
      id: 'ws-a',
      title: 'Alpha',
      path: realWsA,
      sessionIds: [sid1, sid2],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) },
    }
    const wsB = {
      id: 'ws-b',
      title: 'Beta',
      path: realWsB,
      sessionIds: [],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) },
    }

    const schedules = new Map([
      [sid1, [{ id: 'sched-a1', kind: 'cron', title: '每小时对账', prompt: 'run', expression: '0 * * * *', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-09T15:00:00.000Z' }]],
    ])
    const recycledBatches = []

    const fakeCtx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      sessionPersistence: {
        coldLogMemo: new Map(),
        locate: h => ({
          path: path.join(tmpHome, 'sessions', encodeProjectSegment(h.cwd), encodeFsSessionSegment(h.id), 'session.v4.jsonl'),
        }),
      },
      workspaceRegistry: {
        archivedSessionIds: archivedIds,
        pinnedSessionIds: pinnedIds,
        headers: new Map(),
        sessionPaths: new Map(),
        invalidSessionPaths: new Set(),
        list: () => [wsA, wsB],
        archiveSession: async (id) => { if (!archivedIds.includes(id)) archivedIds.push(id) },
        unarchiveSession: async (id) => {
          const idx = archivedIds.indexOf(id)
          if (idx >= 0) archivedIds.splice(idx, 1)
        },
        pinSession: async (id) => { if (!pinnedIds.includes(id)) pinnedIds.push(id) },
        unpinSession: async (id) => {
          const idx = pinnedIds.indexOf(id)
          if (idx >= 0) pinnedIds.splice(idx, 1)
        },
      },
      schedule: {
        catalog: async () => {
          const out = []
          for (const [s, arr] of schedules.entries()) {
            for (const r of arr) out.push({ ...r, sessionId: s, status: 'active' })
          }
          return out
        },
        list: async ({ sessionId }) => [...(schedules.get(sessionId) ?? [])],
        delete: async ({ sessionId, id }) => {
          schedules.set(sessionId, (schedules.get(sessionId) ?? []).filter(x => x.id !== id))
          return { id, deleted: true }
        },
      },
    }

    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      recycleHandler: async (paths) => {
        recycledBatches.push(paths)
        // Simulate Recycle Bin moving paths away without permanent deletion
        const trash = path.join(tmpRoot, 'fake-recycle-bin')
        fs.mkdirSync(trash, { recursive: true })
        for (const p of paths) {
          if (fs.existsSync(p)) {
            fs.renameSync(p, path.join(trash, `${Date.now()}-${Math.random().toString(16).slice(2)}-${path.basename(p)}`))
          }
        }
        return { method: 'mock-recycle-bin', moved: paths }
      },
    })
    steward.setScheduleService(fakeCtx.schedule)

    // 1. Catalog excludes subagent `subSid2` and surfaces `sid1` + `sid2`
    const cat1 = await steward.organizer.listCatalog({ archiveFilter: 'all' })
    assert.equal(cat1.counts.total, 2)
    assert.equal(cat1.counts.scheduled, 1)

    // 2. Orphan-schedule guard blocks archiving `sid1` by default, while archiving `sid2` succeeds
    const archRes = await steward.organizer.setArchiveSessions({
      sessionIds: [sid1, sid2],
      archived: true,
      allowScheduledArchive: false,
    })
    assert.equal(archRes.summary.success, 1)
    assert.equal(archRes.summary.skipped, 1)
    assert.equal(archRes.items.find(i => i.sessionId === sid1).code, 'has_active_schedules')
    assert.equal(archivedIds.includes(sid1), false)
    assert.equal(archivedIds.includes(sid2), true)

    await steward.organizer.setArchiveSessions({ sessionIds: [sid2], archived: false })
    assert.equal(archivedIds.includes(sid2), false)

    // 3. Cross-workspace move relocates `sid2` from `ws-a` -> `ws-b`, rewrites header.cwd + cold working-directory/change + projcache
    const moveRes = await steward.organizer.moveSessions({
      sessionIds: [sid2],
      targetWorkspaceId: 'ws-b',
    })
    assert.equal(moveRes.ok, true)
    assert.equal(moveRes.summary.success, 1)
    assert.equal(fs.existsSync(path.join(sid2OldDir, 'session.v4.jsonl')), false)

    const sid2NewFile = path.join(tmpHome, 'sessions', encodeProjectSegment(realWsB), encodeFsSessionSegment(sid2), 'session.v4.jsonl')
    assert.equal(fs.existsSync(sid2NewFile), true)
    const movedLines = fs.readFileSync(sid2NewFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(movedLines[0].cwd, realWsB)
    assert.equal(movedLines.at(-1).type, 'working-directory/change')
    assert.equal(movedLines.at(-1).data.cwd, realWsB)
    assert.equal(wsA.sessionIds.includes(sid2), false)
    assert.equal(wsB.sessionIds.includes(sid2), true)

    // 4. Recycle Bin guard blocks `sid1` unless `deleteSchedules: true`, and cascades `subSid2` when recycling `sid2`
    const recBlocked = await steward.organizer.recycleSessions({
      sessionIds: [sid1, sid2],
      deleteSchedules: false,
    })
    assert.equal(recBlocked.summary.success, 1) // sid2 recycled
    assert.equal(recBlocked.summary.skipped, 1) // sid1 protected
    assert.equal(fs.existsSync(path.dirname(sid2NewFile)), false, 'sid2 main dir moved to recycle bin')
    assert.equal(fs.existsSync(subSid2Dir), false, 'descendant subagent dir also moved to recycle bin')
    assert.equal(wsB.sessionIds.includes(sid2), false)

    // Now authorize `deleteSchedules: true` on `sid1`
    const recWithSched = await steward.organizer.recycleSessions({
      sessionIds: [sid1],
      deleteSchedules: true,
    })
    assert.equal(recWithSched.summary.success, 1)
    assert.equal((schedules.get(sid1) ?? []).length, 0, 'schedule cleanly deleted before recycling sid1')
    assert.equal(steward._internals.ledger.recycleHistory.length, 2)

    steward.dispose()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('0.5.0 organizer.purgeArchived: dryRun survey, 60m active guard, favorite & schedule guards, ghost ID pruning, and orphan projcache recycling', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-purge050-'))
  const tmpHome = path.join(tmpRoot, 'dsh-home')
  const wsDir = path.join(tmpRoot, 'ws-main')
  fs.mkdirSync(wsDir, { recursive: true })
  const realWs = fs.realpathSync(wsDir)

  const activeSid = 'session-aaaaaaaa-0000-4444-8888-000000000001'
  const archOldSid = 'session-bbbbbbbb-0000-4444-8888-000000000002'
  const archOldSub = 'session-bbbbbbbb-0000-4444-8888-000000000099'
  const archHotSid = 'session-cccccccc-0000-4444-8888-000000000003'
  const archFavSid = 'session-dddddddd-0000-4444-8888-000000000004'
  const archSchedSid = 'session-eeeeeeee-0000-4444-8888-000000000005'
  const ghostSid = 'session-ffffffff-0000-4444-8888-000000000006'
  const orphanCacheSid = 'session-99999999-0000-4444-8888-000000000007'

  const nowMs = 1_760_000_000_000

  function writeSessionAt(id, mtimeMs, extraHeader = {}) {
    const dir = path.join(tmpHome, 'sessions', encodeProjectSegment(realWs), encodeFsSessionSegment(id))
    fs.mkdirSync(dir, { recursive: true })
    const fpath = path.join(dir, 'session.v4.jsonl')
    const payload = `${JSON.stringify({ id, version: 4, cwd: realWs, createdAt: mtimeMs - 10_000, ...extraHeader })}\n${'x'.repeat(4096)}\n`
    fs.writeFileSync(fpath, payload, 'utf8')
    const ts = new Date(mtimeMs)
    fs.utimesSync(fpath, ts, ts)
    fs.utimesSync(dir, ts, ts)
    return dir
  }

  try {
    const activeDir = writeSessionAt(activeSid, nowMs - 5 * 3600_000)
    const archOldDir = writeSessionAt(archOldSid, nowMs - 4 * 3600_000) // 4h old -> eligible
    const archOldSubDir = writeSessionAt(archOldSub, nowMs - 4 * 3600_000, {
      origin: 'subagent',
      parentSession: archOldSid,
      delegationDepth: 1,
    })
    const archHotDir = writeSessionAt(archHotSid, nowMs - 15 * 60_000) // 15m old -> protected by 60m guard
    const archFavDir = writeSessionAt(archFavSid, nowMs - 6 * 3600_000) // 6h old -> protected by ⭐ favorite
    const archSchedDir = writeSessionAt(archSchedSid, nowMs - 6 * 3600_000) // 6h old -> protected by active schedule

    const projCacheDir = path.join(tmpHome, 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(projCacheDir, { recursive: true })
    for (const [id, title] of [
      [activeSid, '活跃主对话'],
      [archOldSid, '4小时前已归档对话'],
      [archHotSid, '15分钟前刚活跃的Ops'],
      [archFavSid, '星标收藏归档对话'],
      [archSchedSid, '带定时任务的归档对话'],
      [orphanCacheSid, '早已删掉目录的孤儿缓存'],
    ]) {
      fs.writeFileSync(
        path.join(projCacheDir, `${id}.json`),
        JSON.stringify({ record: { identity: { cwd: realWs }, rows: { title: { val: title }, workingDirectory: { val: realWs } } } }),
        'utf8'
      )
    }

    const archivedIds = [archOldSid, archHotSid, archFavSid, archSchedSid, ghostSid]
    const pinnedIds = [ghostSid]
    const wsMain = {
      id: 'ws-main',
      title: 'Main',
      path: realWs,
      sessionIds: [activeSid, archOldSid, archHotSid, archFavSid, archSchedSid, ghostSid],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) },
    }
    const schedules = new Map([
      [archSchedSid, [{ id: 'sched-s1', kind: 'cron', title: '巡检S1', prompt: 'run', expression: '0 * * * *', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-09T15:00:00.000Z' }]],
    ])

    const fakeCtx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      sessionPersistence: {
        coldLogMemo: new Map(),
        locate: h => ({
          path: path.join(tmpHome, 'sessions', encodeProjectSegment(h.cwd), encodeFsSessionSegment(h.id), 'session.v4.jsonl'),
        }),
      },
      workspaceRegistry: {
        archivedSessionIds: archivedIds,
        pinnedSessionIds: pinnedIds,
        headers: new Map([[ghostSid, { id: ghostSid }]]),
        sessionPaths: new Map([[ghostSid, realWs]]),
        invalidSessionPaths: new Set([ghostSid]),
        list: () => [wsMain],
        archiveSession: async (id) => { if (!archivedIds.includes(id)) archivedIds.push(id) },
        unarchiveSession: async (id) => {
          const idx = archivedIds.indexOf(id)
          if (idx >= 0) archivedIds.splice(idx, 1)
        },
        pinSession: async (id) => { if (!pinnedIds.includes(id)) pinnedIds.push(id) },
        unpinSession: async (id) => {
          const idx = pinnedIds.indexOf(id)
          if (idx >= 0) pinnedIds.splice(idx, 1)
        },
      },
      schedule: {
        catalog: async () => {
          const out = []
          for (const [s, arr] of schedules.entries()) {
            for (const r of arr) out.push({ ...r, sessionId: s, status: 'active' })
          }
          return out
        },
        list: async ({ sessionId }) => [...(schedules.get(sessionId) ?? [])],
        delete: async ({ sessionId, id }) => {
          schedules.set(sessionId, (schedules.get(sessionId) ?? []).filter(x => x.id !== id))
          return { id, deleted: true }
        },
      },
    }

    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      recycleHandler: async (paths) => {
        const trash = path.join(tmpRoot, 'fake-recycle-bin')
        fs.mkdirSync(trash, { recursive: true })
        for (const p of paths) {
          if (fs.existsSync(p)) {
            fs.renameSync(p, path.join(trash, `${Date.now()}-${Math.random().toString(16).slice(2)}-${path.basename(p)}`))
          }
        }
        return { method: 'mock-recycle-bin', moved: paths }
      },
    })
    steward.setScheduleService(fakeCtx.schedule)

    // Star `archFavSid` and also leave a stale annotation on `ghostSid`
    steward.organizer.annotateSessions({ sessionIds: [archFavSid], patch: { favorite: true } })
    steward.organizer.annotateSessions({ sessionIds: [ghostSid], patch: { note: 'stale' } })

    // 1) Dry-run survey verifies every guard without mutating disk or registry
    const survey = await steward.organizer.purgeArchived({
      dryRun: true,
      activeGuardMinutes: 60,
      protectFavorites: true,
      cleanOrphanCache: true,
      pruneGhostIds: true,
      nowMs,
    })
    assert.equal(survey.ok, true)
    assert.equal(survey.dryRun, true)
    assert.equal(survey.candidateCount, 1)
    assert.equal(survey.candidates[0].sessionId, archOldSid)
    assert.equal(survey.candidates[0].subagentCount, 1)
    assert.equal(survey.skippedCount, 3)
    assert.deepEqual(
      survey.skippedItems.map(i => i.code).sort(),
      ['active_guard', 'has_active_schedules', 'protected_annotation']
    )
    assert.equal(survey.ghostSummary.uniqueCount, 1)
    assert.equal(survey.ghostSummary.workspaceSessionIds, 1)
    assert.equal(survey.ghostSummary.archivedSessionIds, 1)
    assert.equal(survey.ghostSummary.pinnedSessionIds, 1)
    assert.equal(survey.orphanProjCacheCount, 1)
    assert.equal(fs.existsSync(archOldDir), true, 'dryRun must not touch disk')

    // 2) Live zero-restart execution
    const execRes = await steward.organizer.purgeArchived({
      dryRun: false,
      activeGuardMinutes: 60,
      protectFavorites: true,
      cleanOrphanCache: true,
      pruneGhostIds: true,
      nowMs,
    })
    assert.equal(execRes.ok, true)
    assert.equal(execRes.zeroRestart, true)
    assert.equal(execRes.summary.recycledSessions, 1)
    assert.equal(execRes.summary.skippedSessions, 3)
    assert.equal(execRes.summary.prunedGhosts, 1)
    assert.equal(execRes.summary.recycledOrphanCaches, 1)
    assert.ok(execRes.sessionsFreedBytes > 8000, 'freed bytes must reflect archOldDir + archOldSubDir')
    assert.ok(execRes.sessionsBytesAfter < execRes.sessionsBytesBefore)

    // Eligible archived session + subagent + its projcache moved to Recycle Bin
    assert.equal(fs.existsSync(archOldDir), false)
    assert.equal(fs.existsSync(archOldSubDir), false)
    assert.equal(fs.existsSync(path.join(projCacheDir, `${archOldSid}.json`)), false)
    // Orphan projcache moved to Recycle Bin
    assert.equal(fs.existsSync(path.join(projCacheDir, `${orphanCacheSid}.json`)), false)
    // Active & protected archived sessions untouched!
    assert.equal(fs.existsSync(activeDir), true)
    assert.equal(fs.existsSync(path.join(projCacheDir, `${activeSid}.json`)), true)
    assert.equal(fs.existsSync(archHotDir), true)
    assert.equal(fs.existsSync(archFavDir), true)
    assert.equal(fs.existsSync(archSchedDir), true)

    // Ghost ID completely detached from workspace, archivedSessionIds, pinnedSessionIds, and annotations
    assert.equal(wsMain.sessionIds.includes(ghostSid), false)
    assert.equal(archivedIds.includes(ghostSid), false)
    assert.equal(pinnedIds.includes(ghostSid), false)
    assert.equal(steward._internals.ledger.annotations[ghostSid], undefined)

    steward.dispose()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('0.6.0 organizer.purgeArchived: disk-only orphan dirs, extra cache sources, guard order & honest reclaim reporting', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-purge060-'))
  const tmpHome = path.join(tmpRoot, 'dsh-home')
  const wsDir = path.join(tmpRoot, 'ws-main')
  fs.mkdirSync(wsDir, { recursive: true })
  const realWs = fs.realpathSync(wsDir)

  const archivedSid = 'session-11111111-0000-4444-8888-000000000001'
  const hotSchedSid = 'session-22222222-0000-4444-8888-000000000002'
  const ghostDirSid = 'session-33333333-0000-4444-8888-000000000003'
  const orphanExtraCacheSid = 'session-44444444-0000-4444-8888-000000000004'
  const nowMs = 1_760_000_000_000

  function writeSessionAt(id, mtimeMs, extraHeader = {}) {
    const dir = path.join(tmpHome, 'sessions', encodeProjectSegment(realWs), encodeFsSessionSegment(id))
    fs.mkdirSync(dir, { recursive: true })
    const fpath = path.join(dir, 'session.v4.jsonl')
    fs.writeFileSync(fpath, `${JSON.stringify({ id, version: 4, cwd: realWs, createdAt: mtimeMs - 10_000, ...extraHeader })}\n${'y'.repeat(4096)}\n`, 'utf8')
    const ts = new Date(mtimeMs)
    fs.utimesSync(fpath, ts, ts)
    fs.utimesSync(dir, ts, ts)
    return dir
  }

  try {
    const archivedDir = writeSessionAt(archivedSid, nowMs - 5 * 3600_000)
    // 挂载定时任务 + 刚写过（15 分钟）：守卫顺序应为 has_active_schedules，而不是被 mtime 窗静默吞掉
    const hotSchedDir = writeSessionAt(hotSchedSid, nowMs - 15 * 60_000)
    // 任何注册表都没登记的纯磁盘孤儿目录
    const ghostDir = writeSessionAt(ghostDirSid, nowMs - 8 * 3600_000)
    // 只存在于"另一个 storage 缓存目录"的孤儿缓存
    const extraCacheDir = path.join(tmpHome, 'storages', 'session-ecology-index', 'sessions')
    fs.mkdirSync(extraCacheDir, { recursive: true })
    fs.writeFileSync(path.join(extraCacheDir, `${orphanExtraCacheSid}.json`), JSON.stringify({ x: 1 }), 'utf8')

    const archivedIds = [archivedSid, hotSchedSid]
    const wsMain = {
      id: 'ws-main',
      title: 'Main',
      path: realWs,
      sessionIds: [archivedSid, hotSchedSid],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) },
    }
    const fakeCtx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      sessionPersistence: {
        coldLogMemo: new Map(),
        locate: h => ({
          path: path.join(tmpHome, 'sessions', encodeProjectSegment(h.cwd), encodeFsSessionSegment(h.id), 'session.v4.jsonl'),
        }),
      },
      workspaceRegistry: {
        archivedSessionIds: archivedIds,
        pinnedSessionIds: [],
        headers: new Map(),
        sessionPaths: new Map(),
        invalidSessionPaths: new Set(),
        list: () => [wsMain],
        archiveSession: async () => {},
        unarchiveSession: async id => {
          const i = archivedIds.indexOf(id)
          if (i >= 0) archivedIds.splice(i, 1)
        },
        pinSession: async () => {},
        unpinSession: async () => {},
      },
      schedule: {
        catalog: async () => [{ id: 'sched-hot', sessionId: hotSchedSid, status: 'active', title: '高频巡检', kind: 'cron', expression: '*/5 * * * *', timeZone: 'Asia/Shanghai' }],
        list: async ({ sessionId }) => (sessionId === hotSchedSid ? [{ id: 'sched-hot', title: '高频巡检' }] : []),
        delete: async ({ id }) => ({ id, deleted: true }),
      },
    }

    const recycled = []
    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      recycleHandler: async paths => {
        const trash = path.join(tmpRoot, 'fake-recycle-bin')
        fs.mkdirSync(trash, { recursive: true })
        for (const p of paths) {
          if (fs.existsSync(p)) {
            fs.renameSync(p, path.join(trash, `${Date.now()}-${Math.random().toString(16).slice(2)}-${path.basename(p)}`))
            recycled.push(p)
          }
        }
        return { method: 'mock-recycle-bin', moved: paths }
      },
    })
    steward.setScheduleService(fakeCtx.schedule)

    const survey = await steward.organizer.purgeArchived({ dryRun: true, activeGuardMinutes: 60, nowMs })
    assert.equal(survey.ok, true)
    assert.equal(survey.archivedCandidateCount, 1, '只应有一个可清归档会话（hotSched 被定时任务保护）')
    assert.equal(survey.orphanDirCount, 1, '磁盘孤儿目录应被纳入候选')
    assert.equal(survey.candidates.find(c => c.sessionId === ghostDirSid)?.kind, 'orphan_dir')
    assert.equal(survey.candidates.find(c => c.sessionId === archivedSid)?.kind, 'archived')
    const hotSkip = survey.skippedItems.find(i => i.sessionId === hotSchedSid)
    assert.equal(hotSkip.code, 'has_active_schedules', '守卫顺序：定时任务先于 mtime 活跃窗')
    assert.match(survey.note, /回收站/)
    assert.equal(fs.existsSync(ghostDir), true, 'dryRun 不得动磁盘')

    const execRes = await steward.organizer.purgeArchived({ dryRun: false, activeGuardMinutes: 60, nowMs })
    assert.equal(execRes.ok, true)
    assert.equal(execRes.recycleBinEmptied, false)
    assert.equal(execRes.orphanDirCount, 1)
    assert.equal(execRes.summary.recycledOrphanDirs, 1)
    assert.ok(execRes.orphanDirsScanned >= 1)
    assert.equal(typeof execRes.reclaimedBytes, 'number')
    assert.equal(typeof execRes.sessionsMovedBytes, 'number')
    assert.equal(execRes.sessionsMovedBytes, execRes.sessionsFreedBytes)
    assert.match(execRes.note, /未清空|清空/)
    assert.equal(fs.existsSync(archivedDir), false)
    assert.equal(fs.existsSync(ghostDir), false)
    assert.equal(fs.existsSync(hotSchedDir), true, '带活跃定时任务的会话不得被清')
    // 额外缓存源的孤儿缓存也被回收
    assert.equal(fs.existsSync(path.join(extraCacheDir, `${orphanExtraCacheSid}.json`)), false)
    assert.ok(recycled.some(p => p.includes(ghostDirSid)))

    steward.dispose()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('0.8.0 organizer.purgeArchived protects active ungrouped chats while recycling empty shells & invalid-cwd orphans', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-purge080-'))
  const tmpHome = path.join(tmpRoot, 'dsh-home')
  const wsDir = path.join(tmpRoot, 'ws-registered')
  const ungroupedDir = path.join(tmpRoot, 'scratch-ungrouped')
  const deletedProjectPath = path.join(tmpRoot, 'deleted-project-dir')
  fs.mkdirSync(wsDir, { recursive: true })
  fs.mkdirSync(ungroupedDir, { recursive: true })
  const realWs = fs.realpathSync(wsDir)
  const realUngrouped = fs.realpathSync(ungroupedDir)

  const ungroupedChatSid = 'session-77777777-0000-4444-8888-000000000001'
  const emptyShellSid = 'session-77777777-0000-4444-8888-000000000002'
  const deletedPathSid = 'session-77777777-0000-4444-8888-000000000003'
  const nowMs = 1_760_000_000_000

  function writeRawSession(id, cwdPath, lines, mtimeMs) {
    const dir = path.join(tmpHome, 'sessions', encodeProjectSegment(cwdPath), encodeFsSessionSegment(id))
    fs.mkdirSync(dir, { recursive: true })
    const fpath = path.join(dir, 'session.v4.jsonl')
    fs.writeFileSync(fpath, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`, 'utf8')
    const ts = new Date(mtimeMs)
    fs.utimesSync(fpath, ts, ts)
    fs.utimesSync(dir, ts, ts)
    return dir
  }

  try {
    // 1) Real active ungrouped chat: NOT in any workspace/archive/pin, valid non-workspace cwd, has real messages -> MUST BE PROTECTED!
    const ungroupedChatDir = writeRawSession(ungroupedChatSid, realUngrouped, [
      { type: 'session', version: 4, id: ungroupedChatSid, cwd: realUngrouped, createdAt: nowMs - 8 * 3600_000 },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '帮我分析这个临时脚本的参数' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: '这个脚本有 3 个关键参数…' }] } } },
    ], nowMs - 8 * 3600_000)

    // 2) Unseeded 0-message empty shell in ungrouped dir -> MUST BE RECYCLED as `empty_shell`!
    const emptyShellDir = writeRawSession(emptyShellSid, realUngrouped, [
      { type: 'session', version: 4, id: emptyShellSid, cwd: realUngrouped, isSeeded: false, createdAt: nowMs - 8 * 3600_000 },
      { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
    ], nowMs - 8 * 3600_000)

    // 3) Unregistered session whose cwd was deleted from disk -> MUST BE RECYCLED as `invalid_cwd`!
    const deletedPathSessionDir = writeRawSession(deletedPathSid, deletedProjectPath, [
      { type: 'session', version: 4, id: deletedPathSid, cwd: deletedProjectPath, createdAt: nowMs - 8 * 3600_000 },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '旧目录对话' }], source: { kind: 'user' } } },
    ], nowMs - 8 * 3600_000)

    const wsMain = {
      id: 'ws-main',
      title: 'Main',
      path: realWs,
      sessionIds: [],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter(x => x !== id) },
    }
    const fakeCtx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      sessionPersistence: {
        coldLogMemo: new Map(),
        locate: h => ({
          path: path.join(tmpHome, 'sessions', encodeProjectSegment(h.cwd), encodeFsSessionSegment(h.id), 'session.v4.jsonl'),
        }),
      },
      workspaceRegistry: {
        archivedSessionIds: [],
        pinnedSessionIds: [],
        headers: new Map(),
        sessionPaths: new Map(),
        invalidSessionPaths: new Set(),
        list: () => [wsMain],
        archiveSession: async () => {},
        unarchiveSession: async () => {},
        pinSession: async () => {},
        unpinSession: async () => {},
      },
      schedule: {
        catalog: async () => [],
        list: async () => [],
        delete: async ({ id }) => ({ id, deleted: true }),
      },
    }

    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      recycleHandler: async (paths) => {
        const trash = path.join(tmpRoot, 'fake-recycle-bin')
        fs.mkdirSync(trash, { recursive: true })
        for (const p of paths) {
          if (fs.existsSync(p)) {
            fs.renameSync(p, path.join(trash, `${Date.now()}-${Math.random().toString(16).slice(2)}-${path.basename(p)}`))
          }
        }
        return { method: 'mock-recycle-bin', moved: paths }
      },
    })

    const survey = await steward.organizer.purgeArchived({ dryRun: true, activeGuardMinutes: 60, nowMs })
    assert.equal(survey.ok, true)
    assert.equal(survey.orphanDirCount, 2)
    assert.equal(survey.candidates.find(c => c.sessionId === emptyShellSid)?.orphanReason, 'empty_shell')
    assert.equal(survey.candidates.find(c => c.sessionId === deletedPathSid)?.orphanReason, 'invalid_cwd')
    assert.equal(survey.candidates.find(c => c.sessionId === ungroupedChatSid), undefined, 'Active ungrouped chat must NEVER be a purge candidate')
    const ungroupedSkip = survey.skippedItems.find(i => i.sessionId === ungroupedChatSid)
    assert.equal(ungroupedSkip?.code, 'active_ungrouped')

    const execRes = await steward.organizer.purgeArchived({ dryRun: false, activeGuardMinutes: 60, nowMs })
    assert.equal(execRes.ok, true)
    assert.equal(execRes.summary.recycledOrphanDirs, 2)
    assert.equal(fs.existsSync(ungroupedChatDir), true, 'Active ungrouped chat directory MUST remain intact!')
    assert.equal(fs.existsSync(emptyShellDir), false, 'Empty shell directory must be recycled')
    assert.equal(fs.existsSync(deletedPathSessionDir), false, 'Invalid-cwd orphan directory must be recycled')

    steward.dispose()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('0.8.0 rollover memory-anchor recap extracts last real exchange (ignoring runtime snapshots, reasoning & self-summary) into #2 opening prompt and archive', async () => {
  assert.equal(isSyntheticEcologyPrompt('【DSH 会话生态守卫 · 自动换卷自总结】\n请总结'), true)
  assert.equal(isSyntheticEcologyPrompt('【DSH 会话生态自动继承 · 第 #2 卷交接单】'), true)
  assert.equal(isSyntheticEcologyPrompt('把回测放宽阈值调到 0.65 再跑一次'), false)

  const sampleEvents = [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '把失败回测放宽方式的过滤阈值改成 0.65，对比样本外夏普' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\nSkill catalog...' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
    {
      type: 'assistant/message',
      data: {
        turn: 4,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: '内部思考：先读取回测脚本参数，不能作为最终回复暴露' },
            { type: 'tool-call', name: 'run_backtest' },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      data: {
        turn: 4,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', text: '内部思考：对比结果出来了' },
            { type: 'text', text: '已按 0.65 阈值完成样本外回测：夏普从 1.41 提升至 1.78，最大回撤降至 4.3%，待你确认是否写入配置。' },
          ],
        },
      },
    },
    // Turn 5 is the internal self-summary turn sent by dsh-session-ecology!
    { type: 'turn/start', data: { turn: 5 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '【DSH 会话生态守卫 · 自动换卷自总结】\n请输出会话交接单' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: '### 会话交接单\n1. 核心职责：回测参数调优' }] } } },
  ]

  // Even without maxTurn cap, synthetic self-summary Turn 5 is automatically skipped!
  const ex = extractLastExchangeFromEvents(sampleEvents)
  assert.equal(ex.turn, 4)
  assert.equal(ex.isScheduledTurn, false)
  assert.equal(ex.userPrompt, '把失败回测放宽方式的过滤阈值改成 0.65，对比样本外夏普')
  assert.match(ex.assistantReply, /夏普从 1\.41 提升至 1\.78/)
  assert.doesNotMatch(ex.assistantReply, /内部思考/)

  // Scheduled turn fallback from turnOutline
  const schedEx = extractLastExchangeFromTurns([
    { turn: 8, prompt: '', response: '【16:00 巡检】全部指标正常' },
    { turn: 9, prompt: '【DSH 会话生态守卫 · 自动换卷自总结】', response: '交接单' },
  ])
  assert.equal(schedEx.turn, 8)
  assert.equal(schedEx.isScheduledTurn, true)
  assert.match(schedEx.userPrompt, /定时任务自动触发/)
  assert.equal(schedEx.assistantReply, '【16:00 巡检】全部指标正常')

  // Full rollover check verifying disk `.jsonl` tail extraction + 4-line memory-anchor opening prompt
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-recap080-'))
  try {
    const oldId = 'session-88888888-1111-2222-3333-444444444444'
    const cwd = path.join(tmpHome, 'strategy-lab')
    fs.mkdirSync(cwd, { recursive: true })
    const sDir = path.join(tmpHome, 'sessions', encodeProjectSegment(cwd), oldId)
    fs.mkdirSync(sDir, { recursive: true })
    fs.writeFileSync(
      path.join(sDir, 'session.v4.jsonl'),
      [
        JSON.stringify({ type: 'session', version: 4, id: oldId, cwd }),
        ...sampleEvents.slice(0, 6).map(e => JSON.stringify(e)),
      ].join('\n') + '\n',
      'utf8'
    )

    const promptsSent = []
    const fakeCtx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: { get: () => undefined },
      workspaceRegistry: {
        archivedSessionIds: [],
        pinnedSessionIds: [],
        list: () => [],
        archiveSession: async () => {},
      },
      sessionController: {
        inspect: async id => ({ header: { id, cwd } }),
        projections: async () => ({
          values: {
            title: '回测放宽方式实验',
            workingDirectory: cwd,
            contextPressure: { contextWindow: 200_000, pressureTokens: 95_000, surfaceTokens: 210_000 },
            sessionStats: { turns: 4, steps: 12 },
          },
        }),
        create: async () => ({ sessionId: 'session-88888888-aaaa-bbbb-cccc-dddddddddddd' }),
        rename: async () => {},
        prompt: async (req) => { promptsSent.push(req) },
      },
    }

    const steward = createEcologySteward(fakeCtx, {
      dshHome: tmpHome,
      postBootSweepEnabled: false,
      notifyFeishu: false,
    })

    const res = await steward.startHandover(oldId, {
      trigger: 'manual',
      force: true,
      summary: '1. **核心职责与此前主线**：围绕策略失败样本测试放宽过滤条件。\n2. **已完成进展**：0.65 阈值夏普达 1.78。',
    })
    assert.equal(res.ok, true)
    assert.equal(promptsSent.length, 1)
    const openingText = promptsSent[0].content[0].text
    assert.match(openingText, /上卷最后一轮对话实录（回忆锚点）/)
    assert.match(openingText, /把失败回测放宽方式的过滤阈值改成 0\.65/)
    assert.match(openingText, /夏普从 1\.41 提升至 1\.78/)
    assert.match(openingText, /- \*\*之前在干什么\*\*：/)
    assert.match(openingText, /- \*\*最后你说\*\*：/)
    assert.match(openingText, /- \*\*最后它回\*\*：/)
    assert.match(openingText, /严禁在本轮读取文件、严禁调用任何工具/)

    const doc = steward.readHandoffMarkdown(oldId)
    assert.equal(doc.ok, true)
    assert.match(doc.markdown, /## 上卷最后一轮对话实录（回忆锚点）/)
    assert.equal(steward._internals.ledger.history[0].lastExchange.userPrompt, '把失败回测放宽方式的过滤阈值改成 0.65，对比样本外夏普')

    steward.dispose()
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})
