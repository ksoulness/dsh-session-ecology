/**
 * Pure domain logic for `dsh-session-ecology`.
 * Kept free of Cordis / network side effects so every threshold, title, model-guard,
 * schedule-selector, and fallback-summary invariant can be unit-tested deterministically.
 */

export const DEFAULT_ECOLOGY_CONFIG = Object.freeze({
  enabled: true,
  autoHandover: true,
  postBootSweepEnabled: true,
  postBootSweepDelayMs: 60_000,
  sweepGapMs: 5_000,
  summaryTimeoutMs: 180_000,
  pressureRatio: 0.40,
  surfaceRatio: 1.00,
  standardFatigueMultiplier: 350,
  proFatigueMultiplier: 150,
  warnRatio: 0.75,
  defaultContextWindow: 1_000_000,
  fallbackContextWindow: 200_000,
  minContextWindow: 32_000,
  maxTitleBytes: 80,
  notifyFeishu: true,
  archiveOldSession: true,
  projectMemoryGuardEnabled: true,
  projectMemoryReminderEnabled: true,
  projectMemoryMaxBytes: 15_360,
  projectMemoryMaxLines: 250,
  summaryFallbackRoute: null,
  allowedProviders: null,
})

/**
 * Models where multi-generation compaction fatigue or unit cost justifies the tighter 150x window cap.
 */
export function isHighCostOrProModel(selection) {
  if (!selection || typeof selection !== 'object') return false
  const provider = String(selection.provider ?? '').trim()
  const model = String(selection.model ?? '').trim()
  if (!provider && !model) return false
  if (/(?:^|[-_])responses$/i.test(provider)) return true
  const ref = `${provider}/${model}`
  return /(?:^|[-_:/\s])pro(?:$|[-_:/\s])|opus|argon|gpt-5|gpt-6|o1|o3|codex\//i.test(ref)
}

/**
 * Optional model-quota guard during background self-summary:
 * - When `fallbackRoute` (`{ provider, model }`) is not configured (`null`), returns `null`
 *   so background summary uses the session's current model out-of-the-box.
 * - When `fallbackRoute` is configured, overrides high-cost or restricted models (`codex/*`,
 *   `claude-opus-*`, `gpt-5/6`, `o1/o3`, `*-responses` providers, or providers outside
 *   `allowedProviders`) to `fallbackRoute`.
 */
export function selectSummaryModelOverride(
  selection,
  fallbackRoute = DEFAULT_ECOLOGY_CONFIG.summaryFallbackRoute,
  allowedProviders = DEFAULT_ECOLOGY_CONFIG.allowedProviders
) {
  if (!selection || typeof selection !== 'object') return null
  if (!fallbackRoute || typeof fallbackRoute !== 'object') return null
  const fbProvider = String(fallbackRoute.provider ?? '').trim()
  const fbModel = String(fallbackRoute.model ?? '').trim()
  if (!fbProvider || !fbModel) return null

  const provider = String(selection.provider ?? '').trim()
  const model = String(selection.model ?? '').trim()
  if (!provider || !model) return null

  const cleanFallback = { provider: fbProvider, model: fbModel }

  if (Array.isArray(allowedProviders) && allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
    return cleanFallback
  }
  if (/(?:^|[-_])responses$/i.test(provider) || /^codex\//i.test(model)) {
    return cleanFallback
  }
  if (/claude-opus|gpt-5|gpt-6|(?:^|[-_:/])(?:o1|o3)(?:$|[-_:/])/i.test(model)) {
    return cleanFallback
  }
  if (provider === 'antigravity' && !/^(gemini-3\.8-flash|gemini-4-argon)$/i.test(model)) {
    return cleanFallback
  }
  return null
}

/**
 * Resolve effective model context window `W` from projection + model hint.
 */
export function resolveContextWindow(contextPressure, modelSelection, config = DEFAULT_ECOLOGY_CONFIG) {
  const declared = Number(contextPressure?.contextWindow)
  if (Number.isFinite(declared) && declared >= config.minContextWindow) {
    return Math.round(declared)
  }
  const ref = `${modelSelection?.provider ?? ''}/${modelSelection?.model ?? ''}`
  if (/deepseek-v4|gemini-|glm-5|minimax-m3/i.test(ref)) {
    return config.defaultContextWindow
  }
  return config.fallbackContextWindow
}

/**
 * Sum cumulative billed/processed tokens across all buckets in `tokenUsage.totals`.
 */
export function computeTotalTokens(tokenUsage) {
  const totals = tokenUsage?.totals ?? tokenUsage
  if (!totals || typeof totals !== 'object') return 0
  const uncached = Number(totals.uncachedInputTokens) || 0
  const output = Number(totals.outputTokens) || 0
  const cacheRead = Number(totals.cacheReadTokens) || 0
  const cacheWrite = Number(totals.cacheWriteTokens) || 0
  const total = uncached + output + cacheRead + cacheWrite
  return Number.isFinite(total) && total > 0 ? Math.round(total) : 0
}

/**
 * Evaluate the 3-Gate Model-Adaptive Threshold for one session.
 *
 * Gate 1 (pressure): post-compression real prompt tokens >= 0.40 * W
 * Gate 2 (surface):  pre-compression raw surface tokens  >= 1.00 * W
 * Gate 3 (fatigue):  cumulative total tokens             >= (150 or 350) * W
 */
export function evaluateSessionEcology(snapshot = {}, rawConfig = DEFAULT_ECOLOGY_CONFIG) {
  const config = { ...DEFAULT_ECOLOGY_CONFIG, ...(rawConfig || {}) }
  const contextPressure = snapshot.contextPressure ?? null
  const tokenUsage = snapshot.tokenUsage ?? null
  const modelSelection = snapshot.modelSelection ?? null

  const contextWindow = resolveContextWindow(contextPressure, modelSelection, config)
  const pressureTokens = Math.max(0, Math.round(Number(contextPressure?.pressureTokens) || 0))
  const surfaceTokens = Math.max(0, Math.round(Number(contextPressure?.surfaceTokens) || 0))
  const totalTokens = computeTotalTokens(tokenUsage)

  const highTier = isHighCostOrProModel(modelSelection)
  const fatigueMultiplier = highTier ? config.proFatigueMultiplier : config.standardFatigueMultiplier

  const pressureLimit = Math.max(1, Math.round(contextWindow * config.pressureRatio))
  const surfaceLimit = Math.max(1, Math.round(contextWindow * config.surfaceRatio))
  const fatigueLimit = Math.max(1, Math.round(contextWindow * fatigueMultiplier))

  const pressureRatio = pressureTokens / pressureLimit
  const surfaceRatio = surfaceTokens / surfaceLimit
  const fatigueRatio = totalTokens / fatigueLimit

  const reasons = []
  if (pressureTokens >= pressureLimit) {
    reasons.push(`压后真实负载 ${formatCompactTokens(pressureTokens)} ≥ ${formatCompactTokens(pressureLimit)} (${Math.round(config.pressureRatio * 100)}%W)`)
  }
  if (surfaceTokens >= surfaceLimit) {
    reasons.push(`压前表面历史 ${formatCompactTokens(surfaceTokens)} ≥ ${formatCompactTokens(surfaceLimit)} (${Math.round(config.surfaceRatio * 100)}%W)`)
  }
  if (totalTokens >= fatigueLimit) {
    reasons.push(`累计折叠疲劳 ${formatCompactTokens(totalTokens)} ≥ ${formatCompactTokens(fatigueLimit)} (${fatigueMultiplier}×W)`)
  }

  const maxGateProgress = Math.max(pressureRatio, surfaceRatio, fatigueRatio)
  const triggered = reasons.length > 0
  const status = triggered ? 'over' : maxGateProgress >= config.warnRatio ? 'warn' : 'healthy'

  return {
    triggered,
    status,
    highTier,
    reasons,
    maxGateProgress: Number(maxGateProgress.toFixed(4)),
    metrics: {
      contextWindow,
      pressureTokens,
      surfaceTokens,
      totalTokens,
      turns: Math.max(0, Math.round(Number(snapshot.turns) || 0)),
      steps: Math.max(0, Math.round(Number(snapshot.steps) || 0)),
    },
    thresholds: {
      pressureLimit,
      surfaceLimit,
      fatigueLimit,
      fatigueMultiplier,
    },
  }
}

export function formatCompactTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`
  return String(Math.round(v))
}

/**
 * Parse an existing title into `{ baseTitle, generation }`, stripping prior continuation tags
 * such as ` · #2`, ` (#3)`, `（继承）`, `(继承)`, ` · 继承#2`.
 */
export function parseTitleGeneration(rawTitle) {
  let text = String(rawTitle ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { baseTitle: '未命名会话', generation: 1 }

  let generation = 1
  for (;;) {
    const hashMatch = /^(.*?)(?:\s*[·\-—]\s*|\s+)#(\d+)\s*$/u.exec(text)
    if (hashMatch && hashMatch[1].trim()) {
      const parsed = Number(hashMatch[2])
      if (Number.isInteger(parsed) && parsed >= 1 && generation === 1) generation = parsed
      text = hashMatch[1].trim()
      continue
    }
    const parenHash = /^(.*?)\s*[（(\[]#?(\d+)卷?[）)\]]\s*$/u.exec(text)
    if (parenHash && parenHash[1].trim()) {
      const parsed = Number(parenHash[2])
      if (Number.isInteger(parsed) && parsed >= 1 && generation === 1) generation = parsed
      text = parenHash[1].trim()
      continue
    }
    const inheritSuffix = /^(.*?)\s*(?:[（(]继承(?:\s*#?(\d+))?[）)]|[·\-—]\s*继承(?:\s*#?(\d+))?)\s*$/u.exec(text)
    if (inheritSuffix && inheritSuffix[1].trim()) {
      const parsed = Number(inheritSuffix[2] || inheritSuffix[3] || 2)
      if (Number.isInteger(parsed) && parsed >= 2 && generation === 1) generation = parsed
      text = inheritSuffix[1].trim()
      continue
    }
    break
  }

  return { baseTitle: text || '未命名会话', generation }
}

/**
 * Truncate UTF-8 text on codepoint boundaries so `Buffer.byteLength(out, 'utf8') <= maxBytes`.
 */
export function sliceUtf8ByBytes(text, maxBytes) {
  const input = String(text ?? '')
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let out = ''
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out.trimEnd()
}

/**
 * Build a standardized continuation title (`<base> · #<N>`) guaranteed to fit within
 * DSH's 80-byte UTF-8 `session-title` limit.
 */
export function buildContinuationTitle(oldTitle, minNextGeneration = 2, maxBytes = DEFAULT_ECOLOGY_CONFIG.maxTitleBytes) {
  const { baseTitle, generation } = parseTitleGeneration(oldTitle)
  const nextGen = Math.max(Number(minNextGeneration) || 2, generation + 1)
  const suffix = ` · #${nextGen}`
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  const budget = Math.max(8, maxBytes - suffixBytes)
  let base = baseTitle
  if (Buffer.byteLength(base, 'utf8') > budget) {
    const ellipsis = '…'
    const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8')
    base = sliceUtf8ByBytes(base, Math.max(4, budget - ellipsisBytes)) + ellipsis
  }
  return {
    title: `${base}${suffix}`,
    baseTitle: base,
    generation: nextGen,
  }
}

/**
 * Recursively collect every `session-<uuid>` owned by `ds-bot` from parsed `bot/state.json`.
 */
export function collectBotSessionIds(botState, out = new Set()) {
  if (typeof botState === 'string') {
    if (/^session-[0-9a-f-]{8,}$/i.test(botState)) out.add(botState)
    return out
  }
  if (!botState || typeof botState !== 'object') return out
  if (Array.isArray(botState)) {
    for (const item of botState) collectBotSessionIds(item, out)
    return out
  }
  for (const [k, v] of Object.entries(botState)) {
    if (/^session-[0-9a-f-]{8,}$/i.test(k)) out.add(k)
    collectBotSessionIds(v, out)
  }
  return out
}

/**
 * Convert a stored DSH `0.2.1` schedule record into a `ctx.schedule.create(sessionId, req)` payload.
 * Returns `{ skip: true, reason }` for already-expired one-shot reminders so migration never throws.
 */
export function scheduleCreateRequestOf(record, nowMs = Date.now()) {
  if (!record || typeof record !== 'object') return { skip: true, reason: 'invalid_record' }
  const title = String(record.title ?? '').trim()
  const prompt = String(record.prompt ?? '').trim()
  if (!title || !prompt) return { skip: true, reason: 'empty_title_or_prompt' }

  const base = { title, prompt }
  switch (record.kind) {
    case 'cron': {
      const expression = String(record.expression ?? record.cron?.expression ?? '').trim()
      const time_zone = String(record.timeZone ?? record.cron?.time_zone ?? 'Asia/Shanghai').trim()
      if (!expression || !time_zone) return { skip: true, reason: 'invalid_cron' }
      return { skip: false, request: { ...base, cron: { expression, time_zone } } }
    }
    case 'every': {
      const every_seconds = Number(record.everySeconds ?? record.every_seconds)
      if (!Number.isSafeInteger(every_seconds) || every_seconds < 60) {
        return { skip: true, reason: 'invalid_every_seconds' }
      }
      return { skip: false, request: { ...base, every_seconds } }
    }
    case 'daily': {
      const time = String(record.time ?? record.daily?.time ?? '').trim()
      const time_zone = String(record.timeZone ?? record.daily?.time_zone ?? 'Asia/Shanghai').trim()
      if (!time || !time_zone) return { skip: true, reason: 'invalid_daily' }
      return { skip: false, request: { ...base, daily: { time, time_zone } } }
    }
    case 'weekly': {
      const time = String(record.time ?? record.weekly?.time ?? '').trim()
      const time_zone = String(record.timeZone ?? record.weekly?.time_zone ?? 'Asia/Shanghai').trim()
      const weekdays = Array.isArray(record.weekdays ?? record.weekly?.weekdays)
        ? [...(record.weekdays ?? record.weekly.weekdays)]
        : []
      if (!time || !time_zone || weekdays.length === 0) return { skip: true, reason: 'invalid_weekly' }
      return { skip: false, request: { ...base, weekly: { time, time_zone, weekdays } } }
    }
    case 'at':
    case 'after': {
      const scheduledAt = String(record.scheduledAt ?? record.at ?? '').trim()
      const dueMs = Date.parse(scheduledAt)
      if (!Number.isFinite(dueMs)) return { skip: true, reason: 'invalid_scheduled_at' }
      if (dueMs <= nowMs + 5_000) return { skip: true, reason: 'expired_one_shot' }
      return { skip: false, request: { ...base, at: scheduledAt } }
    }
    default:
      return { skip: true, reason: `unsupported_kind:${String(record.kind)}` }
  }
}

/**
 * Build the self-summary prompt sent to an idle over-threshold session.
 * Deliberately forbids tool calls / file writes / business patrol execution so:
 * 1) `read-only` sandbox sessions succeed 100%;
 * 2) scheduled patrols never double-run their business job during summary;
 * 3) the warm KV cache answers in one fast LLM step.
 */
export function buildSelfSummaryPrompt({ title, evaluation, schedules = [] }) {
  const schedDesc = schedules.length > 0
    ? `当前挂载有 ${schedules.length} 条活跃定时任务（${schedules.map(s => `「${s.title}」`).join('、')}），宿主将在本轮总结完成后自动无损迁移至新卷并归档本旧卷。`
    : '宿主将在本轮总结完成后自动在同一工作区开启接续新卷并归档本旧卷。'

  return [
    '【DSH 会话生态守卫 · 自动换卷自总结】',
    `会话「${title || '当前会话'}」已达到生态换卷线（${evaluation.reasons.join('；')}）。${schedDesc}`,
    '',
    '请直接在本条回复正文中输出一份精炼、结构化的 **《会话交接单》**，供接续新卷直接继承。',
    '硬性要求：**不要调用任何工具、不要读写文件、不要执行任何巡检/部署/脚本命令**，仅凭当前已有上下文直接输出纯文本：',
    '1. **核心职责与长期目标**：本会话负责什么项目/工作区、核心任务是什么；',
    '2. **已完成进展与最新结论**：最近几轮关键结果、最新指标/状态、已确认事实；',
    '3. **未完成待办与下一步**：接续新卷接下来要继续跟进或下一轮触发时需关注的重点；',
    '4. **关键路径与红线约束**：核心代码/配置/日志绝对路径、禁止事项与特殊约定。',
  ].join('\n')
}

/**
 * Deterministic mechanical fallback summary when the LLM self-summary turn fails, aborts, or returns empty.
 */
export function buildMechanicalFallbackSummary({
  title,
  cwd,
  recentTurns = [],
  touchedFiles = [],
  schedules = [],
  fallbackReason = '模型自总结未返回，已由宿主从会话日志机械提取关键上下文',
}) {
  const lines = [
    `> 说明：${fallbackReason}。`,
    '',
    '### 1. 会话基础信息',
    `- 原标题：${title || '未命名会话'}`,
    `- 工作目录：${cwd || '未知'}`,
  ]

  if (schedules.length > 0) {
    lines.push('', '### 2. 挂载定时任务')
    for (const s of schedules) {
      lines.push(`- **${s.title}**（\`${s.kind}\`）：${truncateInline(s.prompt, 220)}`)
    }
  }

  if (touchedFiles.length > 0) {
    lines.push('', '### 3. 近期涉及文件')
    for (const file of touchedFiles.slice(0, 15)) {
      lines.push(`- \`${file}\``)
    }
  }

  if (recentTurns.length > 0) {
    lines.push('', '### 4. 最近回合摘录')
    for (const turn of recentTurns.slice(-5)) {
      const p = truncateInline(turn.prompt, 180)
      const r = truncateInline(turn.response, 320)
      lines.push(`- **Turn ${turn.turn ?? '?'}**${p ? `｜输入：${p}` : ''}${r ? ` → 输出：${r}` : ''}`)
    }
  }

  return lines.join('\n')
}

function truncateInline(text, maxChars = 200) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`
}

/**
 * Render the durable Markdown archive written to `storages/session-ecology/handoffs/<stamp>-<shortId>.md`.
 */
export function renderHandoffArchiveMarkdown({
  timestampIso,
  oldSessionId,
  newSessionId,
  oldTitle,
  newTitle,
  workspaceTitle,
  cwd,
  modelSelection,
  permissionPreset,
  evaluation,
  summaryText,
  summarySource,
  migratedSchedules = [],
  oldJsonlPath = '',
}) {
  const modelLabel = modelSelection?.provider && modelSelection?.model
    ? `${modelSelection.provider}/${modelSelection.model}${modelSelection.reasoningEffort ? ` (${modelSelection.reasoningEffort})` : ''}`
    : '默认模型'
  return [
    `# 会话生态交接单：${newTitle}`,
    '',
    `- **交接时间**：${timestampIso}`,
    `- **所属工作区**：${workspaceTitle || cwd || '未分组'}${cwd ? ` (\`${cwd}\`)` : ''}`,
    `- **前序旧卷**：${oldTitle} (\`${oldSessionId}\`)`,
    `- **接续新卷**：${newTitle} (\`${newSessionId}\`)`,
    `- **继承模型与权限**：\`${modelLabel}\` ｜ 权限预设 \`${permissionPreset || '默认'}\``,
    `- **触发原因**：${evaluation.reasons.join('；') || '手动触发换卷'}`,
    `- **换卷前指标**：压后 \`${formatCompactTokens(evaluation.metrics.pressureTokens)}\` / 表面 \`${formatCompactTokens(evaluation.metrics.surfaceTokens)}\` / 累计 \`${formatCompactTokens(evaluation.metrics.totalTokens)}\` / 窗口 \`${formatCompactTokens(evaluation.metrics.contextWindow)}\` / 步数 \`${evaluation.metrics.steps}\``,
    `- **总结来源**：${summarySource === 'self-llm' ? '原会话热缓存自总结' : summarySource === 'caller' ? '调用方显式传入摘要' : '宿主机械提取兜底'}`,
    ...(oldJsonlPath ? [`- **前序原始日志**：\`${oldJsonlPath}\``] : []),
    '',
    '## 迁移的定时任务',
    ...(migratedSchedules.length === 0
      ? ['- 无活跃定时任务']
      : migratedSchedules.map(s => `- \`${s.oldId}\` → \`${s.newId}\`：**${s.title}**（\`${s.kind}\`）`)),
    '',
    '## 交接正文',
    '',
    String(summaryText || '').trim(),
    '',
  ].join('\n')
}

/**
 * Render the opening Turn-1 prompt injected into `newSessionId`.
 * Explicitly instructs the model to reply with a single short receipt line ONLY,
 * activating sidebar visibility without prematurely running patrol commands.
 */
export function renderContinuationOpeningPrompt({
  oldSessionId,
  oldTitle,
  newTitle,
  generation,
  cwd,
  evaluation,
  summaryText,
  handoffFilePath,
  migratedSchedules = [],
  oldJsonlPath = '',
}) {
  const scheduleLines = migratedSchedules.length > 0
    ? migratedSchedules.map(s => `  - 「${s.title}」（新任务 ID：\`${s.newId}\`）`).join('\n')
    : '  - （无挂载定时任务）'

  return [
    `【DSH 会话生态自动继承 · 第 #${generation} 卷交接单】`,
    `- 前序会话：${oldTitle}（\`${oldSessionId}\`，将在交接完成后自动归档）`,
    `- 当前新卷：${newTitle}${cwd ? `（工作目录：\`${cwd}\`）` : ''}`,
    `- 换卷原因：${evaluation.reasons.join('；') || '手动换卷继承'}`,
    `- 存档路径：\`${handoffFilePath}\`${oldJsonlPath ? `（前序原始日志：\`${oldJsonlPath}\`）` : ''}`,
    `- 已接管定时任务（${migratedSchedules.length} 条）：`,
    scheduleLines,
    '',
    '---',
    String(summaryText || '').trim(),
    '---',
    '',
    `【首轮激活指令（严禁越界）】以上前序上下文与定时任务已完整继承。本条仅作新卷建档与侧栏激活：**请只回复一行简短确认（例如：「已接手 ${newTitle}，上下文与 ${migratedSchedules.length} 条定时任务已就绪，等待后续指令/定时触发。」），严禁在本轮读取文件、调用工具或提前执行巡检任务！**`,
  ].join('\n')
}

/**
 * Render the concise Feishu completion report pushed via `/dsh-plugin-notify-feishu/push`.
 */
export function renderFeishuEcologyReport({
  workspaceTitle,
  cwd,
  oldSessionId,
  newSessionId,
  oldTitle,
  newTitle,
  evaluation,
  migratedSchedules = [],
  archived = true,
  summarySource = 'self-llm',
  timeText = '',
}) {
  const shortOld = String(oldSessionId).replace(/^session-/, '').slice(0, 8)
  const shortNew = String(newSessionId).replace(/^session-/, '').slice(0, 8)
  const wsLabel = workspaceTitle || cwd || '未分组'
  const schedLabel = migratedSchedules.length > 0
    ? `${migratedSchedules.length} 条已无损迁移（${migratedSchedules.map(s => s.title).join('、')}）`
    : '无定时任务'
  const archiveLabel = archived ? '已归档隐藏' : '未归档（有新消息或保留）'
  const modeLabel = summarySource === 'self-llm' ? '原会话自总结' : summarySource === 'caller' ? '指定摘要' : '日志机械兜底'

  return [
    `♻️ 会话生态自动换卷：${newTitle}`,
    `工作区：${wsLabel}`,
    `链路：${shortOld} → ${shortNew}（旧卷${archiveLabel} · ${modeLabel}）`,
    `触发：${evaluation.reasons.join('；') || '主动触发换卷'}`,
    `定时任务：${schedLabel}`,
    ...(timeText ? [`时间：${timeText}`] : []),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Session Annotations & Path Segment Helpers (0.3.0 Session Organizer)
// ---------------------------------------------------------------------------

export const DEFAULT_ANNOTATION = Object.freeze({
  favorite: false,
  reviewLater: false,
  priority: 3,
  tags: Object.freeze([]),
  note: '',
  revision: 0,
  updatedAt: 0,
})

export const ANNOTATION_LIMITS = Object.freeze({
  maxTags: 20,
  maxTagLength: 32,
  maxNoteLength: 2000,
})

export function assertValidSessionId(id) {
  if (
    typeof id !== 'string'
    || id.trim() === ''
    || id !== id.trim()
    || id === '.'
    || id === '..'
    || /[\\/\x00-\x1f<>"|?*]/.test(id)
    || /[. ]$/.test(id)
  ) {
    const err = new Error('非法的 sessionId 格式')
    err.code = 'invalid_session_id'
    throw err
  }
  return id
}

/**
 * Parse a comma/newline-delimited string or string[] into normalized deduplicated tags.
 */
export function parseTagInput(raw) {
  const pieces = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，\r\n]+/)
      : null
  if (pieces === null) {
    const err = new Error('标签必须是字符串或字符串数组')
    err.code = 'invalid_tags'
    throw err
  }
  const tags = []
  const seen = new Set()
  for (const item of pieces) {
    if (typeof item !== 'string') {
      const err = new Error('每个标签必须是字符串')
      err.code = 'invalid_tags'
      throw err
    }
    const clean = item.trim().replace(/^#+/, '').trim()
    if (!clean) continue
    if (clean.length > ANNOTATION_LIMITS.maxTagLength || /[,，\x00-\x1f]/.test(clean)) {
      const err = new Error(`每个标签最多 ${ANNOTATION_LIMITS.maxTagLength} 个字符且不能含控制字符`)
      err.code = 'invalid_tags'
      throw err
    }
    const key = clean.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(clean)
    }
  }
  if (tags.length > ANNOTATION_LIMITS.maxTags) {
    const err = new Error(`每个会话最多添加 ${ANNOTATION_LIMITS.maxTags} 个标签`)
    err.code = 'invalid_tags'
    throw err
  }
  return tags
}

export function normalizeAnnotationRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_ANNOTATION, tags: [] }
  }
  const prioNum = raw.priority === null || raw.priority === undefined ? 3 : Number(raw.priority)
  const priority = Number.isInteger(prioNum) && prioNum >= 1 && prioNum <= 5 ? prioNum : 3
  let tags = []
  try {
    tags = Array.isArray(raw.tags) ? parseTagInput(raw.tags) : []
  } catch {
    tags = []
  }
  const note = typeof raw.note === 'string'
    ? raw.note.replace(/\0/g, '').slice(0, ANNOTATION_LIMITS.maxNoteLength)
    : ''
  return {
    favorite: raw.favorite === true,
    reviewLater: raw.reviewLater === true,
    priority,
    tags,
    note,
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0,
  }
}

export function isDefaultAnnotation(ann) {
  if (!ann || typeof ann !== 'object') return true
  return (
    ann.favorite !== true
    && ann.reviewLater !== true
    && (ann.priority === 3 || ann.priority == null)
    && (!Array.isArray(ann.tags) || ann.tags.length === 0)
    && (!ann.note || String(ann.note).trim() === '')
  )
}

/**
 * Validate and normalize an annotation update patch (supports exact `tags` replacement,
 * additive `addTags`, subtractive `removeTags`, and `clearTags: true`).
 */
export function normalizeAnnotationPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const err = new Error('标注更新内容不能为空')
    err.code = 'invalid_annotation_patch'
    throw err
  }
  const out = {}
  let touched = false

  if (patch.favorite !== undefined) {
    if (typeof patch.favorite !== 'boolean') throw Object.assign(new Error('favorite 必须是布尔值'), { code: 'invalid_annotation_patch' })
    out.favorite = patch.favorite
    touched = true
  }
  if (patch.reviewLater !== undefined) {
    if (typeof patch.reviewLater !== 'boolean') throw Object.assign(new Error('reviewLater 必须是布尔值'), { code: 'invalid_annotation_patch' })
    out.reviewLater = patch.reviewLater
    touched = true
  }
  if (patch.priority !== undefined) {
    const p = patch.priority === null ? 3 : Number(patch.priority)
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      throw Object.assign(new Error('优先级必须是 1（最高）~ 5（最低）之间的整数'), { code: 'invalid_annotation_patch' })
    }
    out.priority = p
    touched = true
  }
  if (patch.note !== undefined) {
    if (typeof patch.note !== 'string' || patch.note.includes('\0') || patch.note.length > ANNOTATION_LIMITS.maxNoteLength) {
      throw Object.assign(new Error(`备注最多 ${ANNOTATION_LIMITS.maxNoteLength} 个字符`), { code: 'invalid_annotation_patch' })
    }
    out.note = patch.note.trim()
    touched = true
  }
  if (patch.clearTags === true) {
    out.clearTags = true
    touched = true
  }
  if (patch.tags !== undefined) {
    out.tags = parseTagInput(patch.tags)
    touched = true
  }
  if (patch.addTags !== undefined) {
    out.addTags = parseTagInput(patch.addTags)
    touched = true
  }
  if (patch.removeTags !== undefined) {
    out.removeTags = parseTagInput(patch.removeTags)
    touched = true
  }

  if (!touched) {
    throw Object.assign(new Error('未提供有效的标注字段'), { code: 'invalid_annotation_patch' })
  }
  return out
}

export function applyAnnotationPatch(previousRaw, rawPatch, nowMs = Date.now()) {
  const prev = normalizeAnnotationRecord(previousRaw)
  const patch = normalizeAnnotationPatch(rawPatch)

  let nextTags = [...prev.tags]
  if (patch.clearTags) nextTags = []
  if (patch.tags !== undefined) nextTags = [...patch.tags]
  if (patch.addTags !== undefined && patch.addTags.length > 0) {
    nextTags = parseTagInput([...nextTags, ...patch.addTags])
  }
  if (patch.removeTags !== undefined && patch.removeTags.length > 0) {
    const removeSet = new Set(patch.removeTags.map(t => t.toLowerCase()))
    nextTags = nextTags.filter(t => !removeSet.has(t.toLowerCase()))
  }

  const candidate = {
    favorite: patch.favorite !== undefined ? patch.favorite : prev.favorite,
    reviewLater: patch.reviewLater !== undefined ? patch.reviewLater : prev.reviewLater,
    priority: patch.priority !== undefined ? patch.priority : prev.priority,
    tags: nextTags,
    note: patch.note !== undefined ? patch.note : prev.note,
  }

  const unchanged = (
    candidate.favorite === prev.favorite
    && candidate.reviewLater === prev.reviewLater
    && candidate.priority === prev.priority
    && candidate.note === prev.note
    && candidate.tags.length === prev.tags.length
    && candidate.tags.every((t, i) => t === prev.tags[i])
  )

  if (unchanged) {
    return { changed: false, next: prev }
  }

  return {
    changed: true,
    next: {
      ...candidate,
      revision: prev.revision + 1,
      updatedAt: nowMs,
    },
  }
}

/**
 * Inherit meaningful annotations (`favorite`, `priority`, `tags`, `note`) onto a newly rolled-over
 * continuation session (`#2`, `#3`...) so organized patrols & chats never lose their tags/stars!
 */
export function inheritAnnotationForContinuation(oldRaw, nowMs = Date.now()) {
  const prev = normalizeAnnotationRecord(oldRaw)
  const carried = {
    favorite: prev.favorite,
    reviewLater: false,
    priority: prev.priority,
    tags: [...prev.tags],
    note: prev.note,
    revision: 1,
    updatedAt: nowMs,
  }
  if (isDefaultAnnotation(carried)) return null
  return carried
}

/**
 * Encode a session ID into DSH's on-disk session directory segment (`encodeSegment` contract).
 */
export function encodeFsSessionSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty session segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/**
 * Encode a project `cwd` into DSH's on-disk `<sessions>/--...--/` folder segment (`projectKey` contract).
 */
export function encodeProjectSegment(cwdPath) {
  if (typeof cwdPath !== 'string') return '--root--'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwdPath.length; i += 1) {
    const ch = cwdPath[i]
    const code = cwdPath.charCodeAt(i)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

export function candidateSessionDirs(sessionId) {
  assertValidSessionId(sessionId)
  const primary = encodeFsSessionSegment(sessionId)
  const list = [primary]
  if (sessionId !== primary) list.push(sessionId)
  return list
}
