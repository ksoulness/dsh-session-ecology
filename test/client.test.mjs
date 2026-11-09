import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('client.js registers settings.section slot and sanitizes threshold form values cleanly', () => {
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loadedDef = null

  const fakeReact = {
    Fragment: 'react.fragment',
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(init) {
      const val = typeof init === 'function' ? init() : init
      return [val, () => {}]
    },
    useRef(init) {
      return { current: init }
    },
    useMemo(fn) { return fn() },
    useEffect() {},
    useCallback(fn) { return fn },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) { loadedDef = def },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, settings: {}, summary: {}, sessions: [], recentHistory: [] }) }),
    },
    document: undefined,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    URL,
  }

  vm.runInNewContext(code, sandbox)
  assert.ok(loadedDef, 'window.__ModuleLoader__.load must be called')
  assert.equal(loadedDef.id, 'dsh-session-ecology')

  const mod = loadedDef.factory((spec) => {
    if (spec === 'react') return fakeReact
    throw new Error(`Unexpected require: ${spec}`)
  })

  assert.equal(mod.name, 'dsh-session-ecology')
  assert.deepEqual(Array.from(mod.inject), ['slots', 'sessions'])

  // Test internal pure helpers
  const {
    sanitizeDraftSettings,
    settingsToForm,
    formatRatioPreview,
    formatMultPreview,
    triggerLabel,
    filterAndSortCatalog,
    filterProjectMemories,
    formatBatchResultBanner,
    formatPurgeArchivedBanner,
    computeClientEcologyMeter,
    parseClientTitleGeneration,
  } = mod.__internal
  const sanitized = sanitizeDraftSettings({
    pressurePct: '45',
    surfacePct: '120',
    standardMult: '400',
    proMult: '180',
    warnPct: '80',
  })
  assert.deepEqual({ ...sanitized }, {
    pressureRatio: 0.45,
    surfaceRatio: 1.2,
    standardFatigueMultiplier: 400,
    proFatigueMultiplier: 180,
    warnRatio: 0.8,
  })

  const clamped = sanitizeDraftSettings({
    pressurePct: '999',
    surfacePct: '5',
    standardMult: '99999',
    proMult: '2',
    warnPct: '10',
    projectMemoryMaxBytes: '999999',
    projectMemoryMaxLines: '12',
  })
  assert.equal(clamped.pressureRatio, 0.95)
  assert.equal(clamped.surfaceRatio, 0.3)
  assert.equal(clamped.standardFatigueMultiplier, 5000)
  assert.equal(clamped.proFatigueMultiplier, 10)
  assert.equal(clamped.warnRatio, 0.3)
  assert.equal(clamped.projectMemoryMaxBytes, 65536)
  assert.equal(clamped.projectMemoryMaxLines, 50)

  const sampleMemories = [
    { key: 'a', title: 'CoreApp', projectRoot: '/workspace/core-app', hasProjectMd: true, status: 'healthy', brokenLinks: [] },
    { key: 'b', title: 'Analytics', projectRoot: '/workspace/analytics', hasProjectMd: true, status: 'over', brokenLinks: ['docs/missing.md'] },
    { key: 'c', title: 'Scratch', projectRoot: '/workspace/scratch', hasProjectMd: false, status: 'absent', brokenLinks: [] },
  ]
  assert.equal(filterProjectMemories(sampleMemories, { mode: 'with_project' }).length, 2)
  assert.equal(filterProjectMemories(sampleMemories, { mode: 'issues' }).length, 1)
  assert.equal(filterProjectMemories(sampleMemories, { mode: 'all' }).length, 3)
  assert.equal(filterProjectMemories(sampleMemories, { mode: 'with_project', search: 'missing.md' })[0].key, 'b')

  const roundTrip = settingsToForm(sanitized)
  assert.equal(roundTrip.pressurePct, '45')
  assert.equal(roundTrip.proMult, '180')
  assert.match(formatRatioPreview(40), /1M窗=400K/)
  assert.match(formatRatioPreview(40), /200K窗=80K/)
  assert.match(formatMultPreview(150), /1M窗=150\.0M/)
  assert.equal(triggerLabel('post-boot-sweep'), '启动清扫')
  assert.equal(triggerLabel('auto'), '忙完自触发')

  // Test `apply(ctx)` registers both `settings.section` and `conversation.composer.dock` slots cleanly!
  const injectedSlotNames = []
  const registeredSlots = []
  let openedSessionId = null
  let closedModal = false

  mod.apply({
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    slots: {
      inject(slotName, fn) {
        injectedSlotNames.push(slotName)
        fn()
      },
      register(opts, Component) {
        registeredSlots.push({ opts, Component })
        return () => {}
      },
    },
    inject(keys, cb) {
      if (keys[0] === 'uiWorkspace') {
        cb({
          uiWorkspace: {
            openSession(id) { openedSessionId = id },
          },
          effect() {},
        })
      }
    },
    effect(fn) { fn() },
  })

  assert.deepEqual(injectedSlotNames, ['settings.section', 'conversation.composer.dock'])
  assert.equal(registeredSlots.length, 2)
  assert.equal(registeredSlots[0].opts.id, 'session-ecology')
  assert.equal(registeredSlots[0].opts.order, 92)
  assert.equal(registeredSlots[0].opts.label(), '会话生态 / 会话管理')
  assert.equal(registeredSlots[1].opts.name, 'conversation.composer.dock')
  assert.equal(registeredSlots[1].opts.id, 'session-ecology-meter')
  assert.equal(registeredSlots[1].opts.order, 50)

  // Test 0.3.0 client catalog filter & batch summary helpers
  const sampleRows = [
    {
      sessionId: 'session-1',
      title: '服务监控策略 A',
      workspaceId: 'ws-1',
      workspaceTitle: 'ops',
      archived: false,
      pinned: false,
      activeSchedules: 1,
      status: 'warn',
      maxGateProgress: 0.82,
      updatedAt: 1000,
      annotation: { favorite: true, reviewLater: false, priority: 2, tags: ['运维'], note: '重点关注' },
    },
    {
      sessionId: 'session-2',
      title: '旧测试对话',
      workspaceId: null,
      workspaceTitle: '未分组',
      archived: true,
      pinned: false,
      activeSchedules: 0,
      status: 'healthy',
      maxGateProgress: 0.1,
      updatedAt: 2000,
      annotation: { favorite: false, reviewLater: true, priority: 1, tags: ['测试'], note: '' },
    },
  ]
  assert.equal(filterAndSortCatalog(sampleRows, { archiveFilter: 'active' }).length, 1)
  assert.equal(filterAndSortCatalog(sampleRows, { archiveFilter: 'all', tag: '运维' })[0].sessionId, 'session-1')
  assert.equal(filterAndSortCatalog(sampleRows, { archiveFilter: 'all', sortBy: 'priority_asc' })[0].sessionId, 'session-2')

  const banner = formatBatchResultBanner('批量归档', {
    summary: { total: 2, success: 1, skipped: 1, failed: 0 },
    items: [{ sessionId: 'session-11111111-2222', status: 'skipped', reason: '有定时任务' }],
  })
  assert.equal(banner.ok, true)
  assert.match(banner.text, /成功 1 · 跳过 1 · 失败 0/)

  const purgeBanner = formatPurgeArchivedBanner({
    ok: true,
    recycleBinEmptied: false,
    sessionsBytesBefore: 12 * 1048576,
    sessionsBytesAfter: 2 * 1048576,
    sessionsMovedBytes: 10 * 1048576,
    sessionsFreedBytes: 10 * 1048576,
    reclaimedBytes: 0,
    summary: {
      recycledSessions: 3,
      recycledOrphanDirs: 1,
      prunedGhosts: 2,
      recycledOrphanCaches: 5,
      skippedSessions: 1,
      failedSessions: 0,
    },
  })
  assert.equal(purgeBanner.ok, true)
  assert.match(purgeBanner.text, /已清理 3 个会话目录（含孤儿\/空壳目录 1 个） · 摘除 2 个幽灵 ID · 回收 5 个孤儿缓存 · 保护跳过 1/)
  assert.match(purgeBanner.text, /sessions\/ 12\.0 MB → 2\.0 MB（目录移出 10\.0 MB 已进系统回收站可还原；清空回收站后才腾出磁盘空间）/)

  const purgeEmptiedBanner = formatPurgeArchivedBanner({
    ok: true,
    recycleBinEmptied: true,
    sessionsBytesBefore: 12 * 1048576,
    sessionsBytesAfter: 2 * 1048576,
    sessionsMovedBytes: 10 * 1048576,
    reclaimedBytes: 10.5 * 1048576,
    summary: {
      recycledSessions: 3,
      prunedGhosts: 0,
      recycledOrphanCaches: 2,
      skippedSessions: 0,
      failedSessions: 0,
    },
  })
  assert.equal(purgeEmptiedBanner.ok, true)
  assert.match(purgeEmptiedBanner.text, /已清空回收站真腾出 10\.5 MB/)

  const tree = registeredSlots[0].Component({ close: () => { closedModal = true } })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'sec-page')
  assert.equal(openedSessionId, null)
  assert.equal(closedModal, false)

  // Test 0.7.0 `computeClientEcologyMeter` & `EcologyDockMeter`
  assert.equal(parseClientTitleGeneration('普通对话'), 1)
  assert.equal(parseClientTitleGeneration('等重启自动继承插件 · #2'), 2)
  assert.equal(parseClientTitleGeneration('巡检会话 #5'), 5)

  const emptyMeter = computeClientEcologyMeter({})
  assert.equal(emptyMeter.hasActivity, false)
  assert.equal(emptyMeter.percent, 0)

  // Gate 2 (`surfaceTokens`) preserved from hostWaterline + intra-turn live delta
  const surfaceMeter = computeClientEcologyMeter({
    contextPressure: { pressureTokens: 150_000, projectedTokens: 170_000, contextWindow: 1_000_000 },
    tokenUsage: { totals: { uncachedInputTokens: 500_000, outputTokens: 20_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 } },
    modelSelection: { lastUsed: { provider: 'demo', model: 'deepseek-v4.1' } },
    hostWaterline: {
      evaluation: {
        metrics: {
          pressureTokens: 140_000,
          surfaceTokens: 800_000,
          totalTokens: 2_400_000,
          contextWindow: 1_000_000,
        },
      },
    },
  })
  assert.equal(surfaceMeter.hasActivity, true)
  // hostSurface (800K) + intraTurnDelta (170K - 140K = 30K) = 830K -> 83% of 1M surface gate!
  assert.equal(surfaceMeter.dominantGate.key, 'surface')
  assert.equal(surfaceMeter.percent, 83)
  assert.equal(surfaceMeter.remainingPct, 17)
  assert.equal(surfaceMeter.tone, 'warn')
  assert.equal(surfaceMeter.highTier, false)

  // Gate 3 (`fatigue`) switches to `150xW` on high-tier Pro / Opus models
  const proFatigueMeter = computeClientEcologyMeter({
    contextPressure: { pressureTokens: 40_000, contextWindow: 200_000 },
    tokenUsage: { totals: { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 29_000_000, cacheWriteTokens: 0 } },
    modelSelection: { next: { provider: 'demo', model: 'claude-opus-4-6' } },
  })
  assert.equal(proFatigueMeter.highTier, true)
  assert.equal(proFatigueMeter.dominantGate.key, 'fatigue')
  assert.equal(proFatigueMeter.triggered, true)
  assert.equal(proFatigueMeter.tone, 'danger')
  assert.ok(proFatigueMeter.percent >= 101)

  const DockMeter = registeredSlots[1].Component
  // Hidden when session has 0 tokens
  assert.equal(DockMeter({
    sessionId: 'session-empty-1',
    useSession: () => null,
    useProjection: () => null,
  }), null)
  // Hidden on subagent sessions
  assert.equal(DockMeter({
    sessionId: 'session-sub-1',
    useSession: (sel) => sel({ subagent: { parentId: 'session-root' }, running: false }),
    useProjection: (name) => (name === 'contextPressure' ? { pressureTokens: 90_000, contextWindow: 200_000 } : null),
  }), null)
  // Renders compact bar + generation `#2` badge when active
  const dockTree = DockMeter({
    sessionId: 'session-active-2',
    useSession: (sel) => sel({ subagent: null, running: false }),
    useProjection: (name) => {
      if (name === 'contextPressure') return { pressureTokens: 320_000, contextWindow: 1_000_000 }
      if (name === 'tokenUsage') return { totals: { uncachedInputTokens: 120_000, outputTokens: 10_000, cacheReadTokens: 600_000, cacheWriteTokens: 0 } }
      if (name === 'title') return '等重启自动继承插件 · #2'
      return null
    },
  })
  assert.ok(dockTree, 'Active main session with token usage must render EcologyDockMeter')
  assert.equal(dockTree.props.className, 'sec-dock-wrap')
  const triggerBtn = dockTree.children.find(Boolean)
  assert.equal(triggerBtn.type, 'button')
  assert.equal(triggerBtn.props['data-tone'], 'warn')
  assert.match(triggerBtn.props.title, /换卷水位 80%/)
})
