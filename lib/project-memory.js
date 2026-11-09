/**
 * Project Memory Guard, Pre-Compaction Reminder & Read-Only Workspace Health Scanner (`0.4.0`).
 *
 * Adapts the 3 highest-value mechanisms of `dsh-engramory` directly onto DSH Route C (`PROJECT.md`):
 * 1) `ctx.tools.guard()` monotonic hard cap (`<= 15,360 B` & `<= 250 lines`) on `PROJECT.md` writes:
 *    refuses growth past the cap while ALWAYS allowing shrinking/compacting edits; never blocks `read`.
 * 2) Silent pre-compaction / pre-rollover `systemPrompt.context` reminder for interactive project chats
 *    (strictly excluding scheduled patrols, `ds-bot`, subagents, and archived sessions).
 * 3) Async, non-blocking, read-only health check across all registered workspaces in `workspace.json`:
 *    byte/line watermarks, 4-section structure check, `docs/HISTORY.md` status, in-project broken link check,
 *    and 1-click copyable slimming prompt — without requiring `.git` or single-writer locks.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ECOLOGY_CONFIG, resolveContextWindow } from './core.js'

export const DEFAULT_PROJECT_MEMORY_MAX_BYTES = 15_360
export const DEFAULT_PROJECT_MEMORY_MAX_LINES = 250
export const DEFAULT_REMINDER_PRESSURE_RATIO = 0.24
export const DEFAULT_REMINDER_SURFACE_RATIO = 0.80

const PROJECT_FILENAME_LOWER = 'project.md'
const MAX_GUARD_READ_BYTES = 2 * 1024 * 1024
const MAX_SCAN_WORKSPACES = 150
const SCAN_DEADLINE_MS = 8_000
const ROOT_CACHE_TTL_MS = 15_000

const WHOLE_FILE_TOOLS = new Set(['write', 'write_file'])
const PARTIAL_EDIT_TOOLS = new Set(['edit', 'edit_file', 'str_replace', 'insert'])
const BLOCKED_SECOND_LEDGER_TOOLS = new Set([
  'deja_remember',
  'mcp_deja_deja_remember',
  'mcp__deja__deja_remember',
])
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Prevent accidental `{{var}}` interpolation errors if DSH prompt templating inspects runtime context.
 */
export function verbatimPromptText(text) {
  return String(text ?? '').replace(/\{(?=\{)/g, '{\u200b')
}

function isRemoteOrUncPath(p) {
  return typeof p === 'string' && /^[\\/]{2}/.test(p)
}

function foldWinPath(p) {
  const norm = path.resolve(p)
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

function occurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  for (let idx = text.indexOf(needle); idx !== -1; idx = text.indexOf(needle, idx + needle.length)) {
    count += 1
  }
  return count
}

/**
 * Trailing-newline-insensitive line count (matches standard Markdown guard semantics).
 */
export function countMarkdownLines(text) {
  if (!text) return 0
  return occurrences(text, '\n') + 1 - (text.endsWith('\n') ? 1 : 0)
}

function normalizeLf(text) {
  return String(text ?? '').replaceAll('\r\n', '\n')
}

function crlfDominates(raw) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const bareLf = sample.split('\n').length - 1 - crlf
  return crlf > bareLf
}

/**
 * Resolve `targetPath` through the deepest existing ancestor's `realpathSync` so symlinks and
 * Windows junctions to a project directory resolve consistently even before `PROJECT.md` exists.
 */
export function resolveRealTargetSync(cwd, rawFilePath) {
  if (typeof rawFilePath !== 'string' || rawFilePath.trim() === '') return undefined
  if (isRemoteOrUncPath(rawFilePath)) return undefined

  let abs
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(rawFilePath)) {
      abs = path.resolve(rawFilePath)
    } else if (typeof cwd === 'string' && /^[A-Za-z]:[\\/]/.test(cwd)) {
      abs = path.resolve(cwd, rawFilePath)
    } else {
      return undefined
    }
  } else {
    abs = path.isAbsolute(rawFilePath)
      ? path.resolve(rawFilePath)
      : typeof cwd === 'string' && path.isAbsolute(cwd)
        ? path.resolve(cwd, rawFilePath)
        : undefined
    if (!abs) return undefined
  }

  const tail = []
  let head = abs
  for (let guard = 0; guard < 40; guard += 1) {
    try {
      const realHead = fs.realpathSync.native ? fs.realpathSync.native(head) : fs.realpathSync(head)
      return tail.length > 0 ? path.join(realHead, ...tail) : realHead
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return abs
      tail.unshift(path.basename(head))
      head = parent
    }
  }
  return abs
}

export function isGuardedProjectMdPath(resolvedPath, rawPath = '') {
  if (!resolvedPath) return false
  const rawBase = path.basename(String(rawPath || '')).toLowerCase()
  const realBase = path.basename(resolvedPath).toLowerCase()
  if (rawBase !== PROJECT_FILENAME_LOWER && realBase !== PROJECT_FILENAME_LOWER) {
    return false
  }
  // Never block backup snapshots under `docs/project-backups/` or `_retired*`.
  if (/[\\/](?:project-backups|_retired[^\\/]*|_历史版本)[\\/]/i.test(resolvedPath)) {
    return false
  }
  return true
}

/**
 * Bounded synchronous regular-file reader for `ctx.tools.guard()`.
 * Returns raw `Buffer`, `{ oversizeBytes }` when exceeding `limit`, or `undefined` if absent/non-regular.
 */
function readBoundedFileSync(filePath, limit = MAX_GUARD_READ_BYTES) {
  let fd
  try {
    const preStat = fs.statSync(filePath)
    if (!preStat.isFile()) return undefined
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return undefined
    if (stat.size > limit) {
      return { oversizeBytes: stat.size }
    }
    let buf = Buffer.allocUnsafe(Math.min(65536, Math.max(1024, stat.size + 1)))
    let total = 0
    for (;;) {
      if (total === buf.length) {
        if (total > limit) return { oversizeBytes: Math.max(stat.size, total) }
        const next = Buffer.allocUnsafe(Math.min(limit + 1, buf.length * 2))
        buf.copy(next, 0, 0, total)
        buf = next
      }
      const got = fs.readSync(fd, buf, total, buf.length - total, null)
      if (got === 0) return buf.subarray(0, total)
      total += got
      if (total > limit) return { oversizeBytes: Math.max(stat.size, total) }
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function isGatedWriteCall(tool, args) {
  if (WHOLE_FILE_TOOLS.has(tool) || PARTIAL_EDIT_TOOLS.has(tool)) return true
  if (tool === 'str_replace_editor') {
    const cmd = args?.command
    return cmd === 'create' || cmd === 'str_replace' || cmd === 'insert'
  }
  return false
}

function simulateLfEdit(current, oldRaw, newRaw, replaceAll, limit) {
  const decoded = current.startsWith('\uFEFF') ? current.slice(1) : current
  if (oldRaw.length > 2 * decoded.length + 4) return current
  const text = normalizeLf(decoded)
  const oldStr = normalizeLf(oldRaw)
  if (!oldStr) return current
  const first = text.indexOf(oldStr)
  if (first === -1) return current
  if (!replaceAll && text.indexOf(oldStr, first + oldStr.length) !== -1) return current

  const matches = replaceAll ? occurrences(text, oldStr) : 1
  const crlfs = occurrences(newRaw, '\r\n')
  const estLen = text.length + matches * (newRaw.length - crlfs - oldStr.length)
  if (estLen > limit) {
    const wellFormed = !LONE_SURROGATE_RE.test(text)
      && !LONE_SURROGATE_RE.test(newRaw)
      && !LONE_SURROGATE_RE.test(oldStr)
    return {
      bytes: wellFormed
        ? Buffer.byteLength(text, 'utf8') + matches * (Buffer.byteLength(newRaw, 'utf8') - crlfs - Buffer.byteLength(oldStr, 'utf8'))
        : estLen,
      lines: occurrences(text, '\n') + matches * (occurrences(newRaw, '\n') - occurrences(oldStr, '\n')) + 1,
    }
  }

  const newStr = normalizeLf(newRaw)
  const edited = replaceAll
    ? text.replaceAll(oldStr, () => newStr)
    : text.slice(0, first) + newStr + text.slice(first + oldStr.length)
  return crlfDominates(decoded) ? normalizeLf(edited).replaceAll('\n', '\r\n') : edited
}

function simulateExactEdit(current, oldStr, newStr, replaceAll, limit) {
  const decoded = current.startsWith('\uFEFF') ? current.slice(1) : current
  if (!oldStr || oldStr.length > decoded.length) return current
  const first = decoded.indexOf(oldStr)
  if (first === -1) return current
  if (!replaceAll && decoded.indexOf(oldStr, first + oldStr.length) !== -1) return current

  const matches = replaceAll ? occurrences(decoded, oldStr) : 1
  const estLen = decoded.length + matches * (newStr.length - oldStr.length)
  if (estLen > limit) {
    return {
      bytes: Buffer.byteLength(decoded, 'utf8') + matches * (Buffer.byteLength(newStr, 'utf8') - Buffer.byteLength(oldStr, 'utf8')),
      lines: occurrences(decoded, '\n') + matches * (occurrences(newStr, '\n') - occurrences(oldStr, '\n')) + 1,
    }
  }
  return replaceAll
    ? decoded.replaceAll(oldStr, () => newStr)
    : decoded.slice(0, first) + newStr + decoded.slice(first + oldStr.length)
}

function simulateLineInsert(current, insertLine, newStr, limit) {
  const decoded = current.startsWith('\uFEFF') ? current.slice(1) : current
  const segments = occurrences(decoded, '\n') + 1
  if (insertLine < 0 || insertLine > segments) return current
  if (decoded.length + newStr.length + 1 > limit) {
    return {
      bytes: Buffer.byteLength(decoded, 'utf8') + Buffer.byteLength(newStr, 'utf8') + 1,
      lines: occurrences(decoded, '\n') + occurrences(newStr, '\n') + 2,
    }
  }
  const lines = decoded.split('\n')
  return [...lines.slice(0, insertLine), newStr, ...lines.slice(insertLine)].join('\n')
}

function formatRefusalMessage({ targetPath, breaches, curBytes, curLines, maxBytes, maxLines }) {
  const display = targetPath || 'PROJECT.md'
  return (
    `拒绝写入 ${display}：本次修改将使文件体积增长并超出路线 C 硬上限（${breaches.join('，')}；` +
    `当前磁盘为 ${curBytes} B / ${curLines} 行，上限 ≤ ${maxBytes} B / ≤ ${maxLines} 行）。` +
    `请先将「④ 最近完成索引」超出 10 条的旧记录或过程细节无损迁入同项目 docs/HISTORY.md，` +
    `或在「② 长期记忆与踩坑铁律」原地合并精简后再写入（凡使字节数与行数不增加的瘦身写入一律放行）。`
  )
}

function evaluateVerdict({ postBytes, postLines, currentRead, targetPath, maxBytes, maxLines }) {
  const isOversize = currentRead !== undefined && !Buffer.isBuffer(currentRead)
  const curBytes = currentRead === undefined
    ? 0
    : isOversize
      ? currentRead.oversizeBytes
      : currentRead.length
  const curLines = currentRead === undefined
    ? 0
    : isOversize
      ? Number.POSITIVE_INFINITY
      : countMarkdownLines(currentRead.toString('utf8'))

  const breaches = []
  if (postBytes > maxBytes && postBytes > curBytes) {
    breaches.push(`预计 ${postBytes} B > ${maxBytes} B`)
  }
  if (postLines > maxLines && postLines > curLines) {
    breaches.push(`预计 ${postLines} 行 > ${maxLines} 行`)
  }
  if (breaches.length === 0) return undefined

  return formatRefusalMessage({
    targetPath,
    breaches,
    curBytes,
    curLines: Number.isFinite(curLines) ? curLines : '超限',
    maxBytes,
    maxLines,
  })
}

/**
 * Pure synchronous guard decision for a single DSH tool invocation.
 * Returns `undefined` to allow, or a refusal reason `string` to block.
 */
export function judgeProjectMemoryWrite(exec, {
  maxBytes = DEFAULT_PROJECT_MEMORY_MAX_BYTES,
  maxLines = DEFAULT_PROJECT_MEMORY_MAX_LINES,
  resolveSessionCwd = () => undefined,
} = {}) {
  const tool = typeof exec?.name === 'string' ? exec.name : ''
  if (BLOCKED_SECOND_LEDGER_TOOLS.has(tool)) {
    return (
      `拒绝调用 ${tool}：DSH 路线 C 记忆规范严禁使用 deja_remember 另立第二份长期结论账本（deja 仅作跨端历史会话只读回溯）。` +
      `请将跨会话持续有效的架构定案或排障铁律原地沉淀至当前项目根 PROJECT.md「② 长期记忆与踩坑铁律」（≤ ${maxBytes} B / ≤ ${maxLines} 行）。`
    )
  }
  const args = exec?.arguments ?? exec?.args ?? exec?.input
  if (!args || typeof args !== 'object') return undefined
  if (!isGatedWriteCall(tool, args)) return undefined

  const candidateRawPaths = new Set(
    [args.file_path, args.path, args.filePath, args.Path, args.targetFile]
      .filter(v => typeof v === 'string' && v.trim() !== '')
  )
  if (candidateRawPaths.size === 0) return undefined

  const cwd = resolveSessionCwd(exec)
  for (const rawPath of candidateRawPaths) {
    const resolved = resolveRealTargetSync(cwd, rawPath)
    if (!isGuardedProjectMdPath(resolved, rawPath)) continue

    const currentRead = readBoundedFileSync(resolved, MAX_GUARD_READ_BYTES)

    // 1. Whole-file writes (`write`, `write_file`, `str_replace_editor:create`)
    if (tool === 'write' || (tool === 'write_file' && args.Append !== true)) {
      const content = typeof args.content === 'string'
        ? args.content
        : typeof args.Content === 'string' ? args.Content : undefined
      if (content === undefined) continue
      const reason = evaluateVerdict({
        postBytes: Buffer.byteLength(content, 'utf8'),
        postLines: countMarkdownLines(content),
        currentRead,
        targetPath: resolved,
        maxBytes,
        maxLines,
      })
      if (reason !== undefined) return reason
      continue
    }

    if (tool === 'str_replace_editor' && args.command === 'create') {
      if (typeof args.file_text !== 'string') continue
      const reason = evaluateVerdict({
        postBytes: Buffer.byteLength(args.file_text, 'utf8'),
        postLines: countMarkdownLines(args.file_text),
        currentRead,
        targetPath: resolved,
        maxBytes,
        maxLines,
      })
      if (reason !== undefined) return reason
      continue
    }

    // For partial edits/appends, if the current file cannot be read into memory, let it pass
    // rather than blindly deadlocking shrinking edits.
    if (!Buffer.isBuffer(currentRead)) continue
    const currentText = currentRead.toString('utf8')

    if (tool === 'write_file' && args.Append === true && typeof args.Content === 'string') {
      const combined = currentText + args.Content
      const reason = evaluateVerdict({
        postBytes: Buffer.byteLength(combined, 'utf8'),
        postLines: countMarkdownLines(combined),
        currentRead,
        targetPath: resolved,
        maxBytes,
        maxLines,
      })
      if (reason !== undefined) return reason
      continue
    }

    let simulated
    if (tool === 'insert' || (tool === 'str_replace_editor' && args.command === 'insert')) {
      if (Number.isSafeInteger(args.insert_line) && typeof args.new_str === 'string') {
        simulated = simulateLineInsert(currentText, args.insert_line, args.new_str, MAX_GUARD_READ_BYTES)
      }
    } else if (tool === 'edit') {
      if (typeof args.old_string === 'string' && args.old_string !== '') {
        simulated = simulateLfEdit(
          currentText,
          args.old_string,
          typeof args.new_string === 'string' ? args.new_string : '',
          args.replace_all === true,
          MAX_GUARD_READ_BYTES
        )
      }
    } else if (tool === 'edit_file') {
      if (typeof args.Target === 'string' && args.Target !== '') {
        simulated = simulateExactEdit(
          currentText,
          args.Target,
          typeof args.Replacement === 'string' ? args.Replacement : '',
          true,
          MAX_GUARD_READ_BYTES
        )
      }
    } else if (tool === 'str_replace_editor' || tool === 'str_replace') {
      const oldS = typeof args.old_str === 'string' ? args.old_str : args.old_string
      const newS = typeof args.new_str === 'string' ? args.new_str : (args.new_string ?? '')
      if (typeof oldS === 'string' && oldS !== '') {
        simulated = simulateExactEdit(
          currentText,
          oldS,
          typeof newS === 'string' ? newS : '',
          args.replace_all === true || args.replaceAll === true,
          MAX_GUARD_READ_BYTES
        )
      }
    }

    if (simulated !== undefined) {
      const postBytes = typeof simulated === 'string' ? Buffer.byteLength(simulated, 'utf8') : simulated.bytes
      const postLines = typeof simulated === 'string' ? countMarkdownLines(simulated) : simulated.lines
      const reason = evaluateVerdict({
        postBytes,
        postLines,
        currentRead,
        targetPath: resolved,
        maxBytes,
        maxLines,
      })
      if (reason !== undefined) return reason
    }
  }

  return undefined
}

export function createProjectMemoryGuard({ getConfig, resolveSessionCwd }) {
  return function projectMemoryGuard(exec) {
    try {
      const cfg = getConfig?.() || {}
      if (cfg.enabled === false || cfg.projectMemoryGuardEnabled === false) {
        return undefined
      }
      return judgeProjectMemoryWrite(exec, {
        maxBytes: Number(cfg.projectMemoryMaxBytes) || DEFAULT_PROJECT_MEMORY_MAX_BYTES,
        maxLines: Number(cfg.projectMemoryMaxLines) || DEFAULT_PROJECT_MEMORY_MAX_LINES,
        resolveSessionCwd,
      })
    } catch {
      return undefined // Strictly fail-open: never break DSH tool execution on unexpected error
    }
  }
}

/**
 * Cached upward `PROJECT.md` locator for runtime prompt assembly (zero repeated `statSync` per step).
 */
export function createProjectRootFinder({ ttlMs = ROOT_CACHE_TTL_MS, maxHops = 6 } = {}) {
  const cache = new Map() // foldedDir -> { projectMdPath, projectRoot, bytes, lines, expiresAt }

  return function findNearestProjectMd(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '' || isRemoteOrUncPath(cwd)) return null
    let startDir
    try {
      startDir = path.resolve(cwd)
    } catch {
      return null
    }
    const key = foldWinPath(startDir)
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now) return hit.value

    let dir = startDir
    let found = null
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const candidate = path.join(dir, 'PROJECT.md')
      try {
        const st = fs.statSync(candidate)
        if (st.isFile()) {
          let lines = 0
          if (st.size <= 262_144) {
            lines = countMarkdownLines(fs.readFileSync(candidate, 'utf8'))
          }
          found = {
            projectRoot: dir,
            projectMdPath: candidate,
            bytes: st.size,
            lines,
          }
          break
        }
      } catch {}
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    if (cache.size > 256) cache.clear()
    cache.set(key, { value: found, expiresAt: now + ttlMs })
    return found
  }
}

/**
 * Build the silent pre-compaction / pre-rollover reminder for human interactive project sessions.
 * Returns `''` (0 tokens) during normal low-pressure steps and for all patrols/bots/subagents.
 */
export function buildProjectMemoryReminder({
  snapshot,
  config = {},
  isEligible = true,
  hasActiveSchedule = false,
  inFlight = false,
  findProjectMd,
} = {}) {
  if (!isEligible || hasActiveSchedule || inFlight) return ''
  const cfg = { ...DEFAULT_ECOLOGY_CONFIG, ...(config || {}) }
  if (cfg.enabled === false || cfg.projectMemoryReminderEnabled === false) return ''
  if (!snapshot || typeof snapshot !== 'object') return ''

  const contextWindow = resolveContextWindow(snapshot.contextPressure, snapshot.modelSelection, cfg)
  const pressureTokens = Math.max(0, Number(snapshot.contextPressure?.pressureTokens) || 0)
  const surfaceTokens = Math.max(0, Number(snapshot.contextPressure?.surfaceTokens) || 0)

  const remPressureRatio = Number(cfg.projectMemoryReminderPressureRatio) || DEFAULT_REMINDER_PRESSURE_RATIO
  const remSurfaceRatio = Number(cfg.projectMemoryReminderSurfaceRatio) || DEFAULT_REMINDER_SURFACE_RATIO

  const nearCompactionOrRollover = pressureTokens >= contextWindow * remPressureRatio
    || surfaceTokens >= contextWindow * remSurfaceRatio
  if (!nearCompactionOrRollover) return ''

  const proj = typeof findProjectMd === 'function' ? findProjectMd(snapshot.cwd) : null
  if (!proj?.projectMdPath) return ''

  const maxBytes = Number(cfg.projectMemoryMaxBytes) || DEFAULT_PROJECT_MEMORY_MAX_BYTES
  const maxLines = Number(cfg.projectMemoryMaxLines) || DEFAULT_PROJECT_MEMORY_MAX_LINES

  return verbatimPromptText(
    `[项目记忆护栏提醒] 当前对话上下文已接近压缩/换卷水位（当前项目真源：${proj.projectMdPath}，` +
    `现 ${proj.bytes} B / ${proj.lines} 行，上限 ≤ ${maxBytes} B / ≤ ${maxLines} 行）。` +
    `若本轮已确认跨会话持续有效的新踩坑铁律或架构定案，请在本轮收尾时原地更新 PROJECT.md「② 长期记忆与踩坑铁律」` +
    `（旧口径变更时原地覆盖，完成项超 10 条归入 docs/HISTORY.md）；若无新增长期定论则无需写文件，也无需向用户提及本提醒。`
  )
}

/**
 * Inspect Markdown headings & section-4 item count of a `PROJECT.md` text without exposing body content.
 */
export function analyzeProjectMdStructure(markdownText) {
  const text = normalizeLf(markdownText)
  const lines = text.split('\n')

  let hasSection1 = false
  let hasSection2 = false
  let hasSection3 = false
  let hasSection4 = false
  let inSection4 = false
  let completedItemCount = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/^##\s+/.test(line)) {
      inSection4 = false
      if (/1|①|定位|入口/.test(line)) hasSection1 = true
      if (/2|②|长期记忆|铁律|踩坑/.test(line)) hasSection2 = true
      if (/3|③|进行中|待决/.test(line)) hasSection3 = true
      if (/4|④|最近完成/.test(line)) {
        hasSection4 = true
        inSection4 = true
      }
      continue
    }
    if (inSection4 && /^(?:\d+\.\s+|[-*]\s+)/.test(line)) {
      completedItemCount += 1
    }
  }

  const fourSectionScore = [hasSection1, hasSection2, hasSection3, hasSection4].filter(Boolean).length
  return {
    hasFourSections: fourSectionScore === 4,
    fourSectionScore,
    completedItemCount,
  }
}

/**
 * Extract & verify Markdown links whose resolved target lies strictly inside `projectRoot`
 * (never probing sibling/external projects).
 */
async function checkInProjectBrokenLinks(markdownText, projectRoot, maxBroken = 12) {
  const cleanText = markdownText
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '')

  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g
  const realRootFolded = foldWinPath(projectRoot)
  const rootPrefix = realRootFolded.endsWith(path.sep) ? realRootFolded : `${realRootFolded}${path.sep}`

  const checked = new Set()
  const broken = []
  let totalLocalChecked = 0

  let match
  while ((match = linkRe.exec(cleanText)) !== null) {
    let rawHref = match[2].trim()
    if (!rawHref || /^(?:https?:|mailto:|conversation:|javascript:|#)/i.test(rawHref)) continue

    // Strip `#L10` or `#heading` anchor
    const hashIdx = rawHref.indexOf('#')
    if (hashIdx !== -1) rawHref = rawHref.slice(0, hashIdx)
    if (!rawHref) continue

    let resolvedTarget = null
    try {
      if (/^file:\/\//i.test(rawHref)) {
        resolvedTarget = fileURLToPath(rawHref)
      } else {
        const decoded = decodeURIComponent(rawHref)
        if (isRemoteOrUncPath(decoded)) continue
        resolvedTarget = path.resolve(projectRoot, decoded)
      }
    } catch {
      continue
    }
    if (!resolvedTarget) continue

    const foldedTarget = foldWinPath(resolvedTarget)
    // Strictly restrict link existence checks to targets inside this `projectRoot`!
    if (foldedTarget !== realRootFolded && !foldedTarget.startsWith(rootPrefix)) {
      continue
    }
    if (checked.has(foldedTarget)) continue
    checked.add(foldedTarget)
    totalLocalChecked += 1

    try {
      await fsp.stat(resolvedTarget)
    } catch {
      if (broken.length < maxBroken) {
        broken.push(path.relative(projectRoot, resolvedTarget).replaceAll('\\', '/'))
      }
    }
  }

  return { totalLocalChecked, brokenLinks: broken }
}

export function buildProjectSlimPrompt({ projectRoot, bytes, lines, maxBytes, maxLines, brokenLinks = [], completedItemCount = 0 }) {
  const rootSlash = String(projectRoot || '').replaceAll('\\', '/')
  const issues = []
  if (bytes > maxBytes) issues.push(`字节数 ${bytes} B 超出 ${maxBytes} B 上限`)
  if (lines > maxLines) issues.push(`行数 ${lines} 行超出 ${maxLines} 行上限`)
  if (completedItemCount > 10) issues.push(`「最近完成索引」现有 ${completedItemCount} 条（规范上限 10 条）`)
  if (brokenLinks.length > 0) issues.push(`存在 ${brokenLinks.length} 处失效本地链接（${brokenLinks.slice(0, 5).join(', ')}）`)
  const issueDesc = issues.length > 0 ? `当前问题：${issues.join('；')}。` : '请做一次常规四段式健康巡检与去重。'

  return (
    `请读取 ${rootSlash}/PROJECT.md，严格按 DSH project-workflow.md 跨 AI 单真源四段式红线（正文 ≤ ${maxBytes} B / ≤ ${maxLines} 行）原地整理瘦身。` +
    `${issueDesc}` +
    `要求：1) 保持「① 定位与权威入口 / ② 长期记忆与踩坑铁律 / ③ 进行中与待决事项 / ④ 最近完成索引（≤10 条单行摘要）」四节结构；` +
    `2) 将超出 10 条的历史完成项与长篇过程细节 100% 无损归档至 ${rootSlash}/docs/HISTORY.md（禁止丢信息）；` +
    `3) 修复或更新失效链接，核验改后字节数 ≤ ${maxBytes} B、行数 ≤ ${maxLines} 行且本地链接 0 坏链。`
  )
}

async function detectDejaStatus(dshHome) {
  const webPkgPath = path.join(dshHome, 'profiles', 'web', 'package.json')
  const patchPath = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  let installed = false
  let bundled = false
  let autoRecallDisabled = false
  let version = ''

  try {
    const pkg = JSON.parse(await fsp.readFile(webPkgPath, 'utf8'))
    if (pkg?.dependencies?.['dsh-deja']) installed = true
    if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-deja')) {
      bundled = true
    }
    const dejaPkgPath = path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-deja', 'package.json')
    const dejaPkg = JSON.parse(await fsp.readFile(dejaPkgPath, 'utf8'))
    version = dejaPkg?.version || ''
  } catch {}

  try {
    const patchText = await fsp.readFile(patchPath, 'utf8')
    if (/-\s*id:\s*deja\b[\s\S]{0,160}?autoRecall:\s*false\b/.test(patchText)) {
      autoRecallDisabled = true
    }
  } catch {}

  return {
    installed,
    bundled,
    version,
    autoRecallDisabled,
    mode: installed && bundled
      ? (autoRecallDisabled ? 'on-demand' : 'auto-recall')
      : 'not-installed',
  }
}

async function locateProjectRootForWorkspace(wsPath) {
  if (typeof wsPath !== 'string' || !wsPath.trim() || isRemoteOrUncPath(wsPath)) {
    return null
  }
  const resolvedWs = path.resolve(wsPath)
  try {
    const st = await fsp.stat(resolvedWs)
    if (!st.isDirectory()) return null
  } catch {
    return { missingDir: true, wsPath: resolvedWs }
  }

  // Check exact workspace directory first, then up to 2 ancestor levels (e.g. if a workspace points at `launcher/`).
  let dir = resolvedWs
  for (let hop = 0; hop <= 2; hop += 1) {
    const candidate = path.join(dir, 'PROJECT.md')
    try {
      const st = await fsp.lstat(candidate)
      if (st.isFile()) {
        const realDir = await fsp.realpath(dir).catch(() => dir)
        return {
          hasProjectMd: true,
          projectRoot: realDir,
          projectMdPath: path.join(realDir, 'PROJECT.md'),
        }
      }
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const realWs = await fsp.realpath(resolvedWs).catch(() => resolvedWs)
  return {
    hasProjectMd: false,
    projectRoot: realWs,
    projectMdPath: path.join(realWs, 'PROJECT.md'),
  }
}

async function inspectOneProjectRoot({
  projectRoot,
  projectMdPath,
  hasProjectMd,
  workspaceIds,
  workspaceTitles,
  maxBytes,
  maxLines,
}) {
  if (!hasProjectMd) {
    return {
      key: foldWinPath(projectRoot),
      projectRoot,
      projectMdPath,
      workspaceIds,
      workspaceTitles,
      title: workspaceTitles[0] || path.basename(projectRoot),
      hasProjectMd: false,
      status: 'absent',
      bytes: 0,
      lines: 0,
      maxBytes,
      maxLines,
      byteRatio: 0,
      lineRatio: 0,
      hasFourSections: false,
      fourSectionScore: 0,
      completedItemCount: 0,
      hasHistoryMd: false,
      historyBytes: 0,
      dshRulesCount: 0,
      totalLocalLinks: 0,
      brokenLinks: [],
      updatedAt: 0,
      slimPrompt: '',
    }
  }

  const stat = await fsp.stat(projectMdPath)
  const rawBuf = stat.size <= MAX_GUARD_READ_BYTES
    ? await fsp.readFile(projectMdPath)
    : null
  const bytes = rawBuf ? rawBuf.length : stat.size
  const text = rawBuf ? rawBuf.toString('utf8') : ''
  const lines = rawBuf ? countMarkdownLines(text) : maxLines + 1

  const structure = rawBuf
    ? analyzeProjectMdStructure(text)
    : { hasFourSections: false, fourSectionScore: 0, completedItemCount: 0 }

  const linkCheck = rawBuf
    ? await checkInProjectBrokenLinks(text, projectRoot)
    : { totalLocalChecked: 0, brokenLinks: [] }

  let hasHistoryMd = false
  let historyBytes = 0
  try {
    const hStat = await fsp.stat(path.join(projectRoot, 'docs', 'HISTORY.md'))
    if (hStat.isFile()) {
      hasHistoryMd = true
      historyBytes = hStat.size
    }
  } catch {}

  let dshRulesCount = 0
  try {
    const entries = await fsp.readdir(path.join(projectRoot, '.dsh', 'rules'))
    dshRulesCount = entries.filter(n => /\.md$/i.test(n)).length
  } catch {}

  const byteRatio = Number((bytes / maxBytes).toFixed(4))
  const lineRatio = Number((lines / maxLines).toFixed(4))
  const overCap = bytes > maxBytes || lines > maxLines
  const hasBroken = linkCheck.brokenLinks.length > 0
  const nearCap = byteRatio >= 0.85 || lineRatio >= 0.85 || structure.completedItemCount > 10

  const status = overCap || hasBroken
    ? 'over'
    : nearCap || !structure.hasFourSections
      ? 'warn'
      : 'healthy'

  return {
    key: foldWinPath(projectRoot),
    projectRoot,
    projectMdPath,
    workspaceIds,
    workspaceTitles,
    title: workspaceTitles[0] || path.basename(projectRoot),
    hasProjectMd: true,
    status,
    overCap,
    bytes,
    lines,
    maxBytes,
    maxLines,
    byteRatio,
    lineRatio,
    hasFourSections: structure.hasFourSections,
    fourSectionScore: structure.fourSectionScore,
    completedItemCount: structure.completedItemCount,
    hasHistoryMd,
    historyBytes,
    dshRulesCount,
    totalLocalLinks: linkCheck.totalLocalChecked,
    brokenLinks: linkCheck.brokenLinks,
    updatedAt: Math.round(stat.mtimeMs || 0),
    slimPrompt: buildProjectSlimPrompt({
      projectRoot,
      bytes,
      lines,
      maxBytes,
      maxLines,
      brokenLinks: linkCheck.brokenLinks,
      completedItemCount: structure.completedItemCount,
    }),
  }
}

/**
 * Single-flight async scanner across all registered workspaces in `workspaceRegistry` / `storages/workspace.json`
 * plus `dshHome`. Never blocks the main event loop and enforces an 8-second ceiling.
 */
export function createProjectMemoryScanner({ dshHome, getWorkspaceRegistry, getConfig }) {
  let inflightPromise = null

  async function runScan() {
    const cfg = getConfig?.() || {}
    const maxBytes = Number(cfg.projectMemoryMaxBytes) || DEFAULT_PROJECT_MEMORY_MAX_BYTES
    const maxLines = Number(cfg.projectMemoryMaxLines) || DEFAULT_PROJECT_MEMORY_MAX_LINES

    const rawCandidates = []
    const seenWsIds = new Set()

    const pushCandidate = (id, wsPath, title) => {
      if (typeof wsPath !== 'string' || !wsPath.trim() || isRemoteOrUncPath(wsPath)) return
      if (id && seenWsIds.has(id)) return
      if (id) seenWsIds.add(id)
      rawCandidates.push({
        id: id || `dir:${foldWinPath(wsPath)}`,
        path: wsPath.trim(),
        title: typeof title === 'string' && title.trim() ? title.trim() : path.basename(wsPath.trim()),
      })
    }

    // 1. Live `workspaceRegistry.list()`
    try {
      const reg = getWorkspaceRegistry?.()
      const list = reg?.list?.()
      if (Array.isArray(list)) {
        for (const ws of list.slice(0, MAX_SCAN_WORKSPACES)) {
          pushCandidate(ws?.id, ws?.path, ws?.title)
        }
      }
    } catch {}

    // 2. Fallback / supplement from persisted `storages/workspace.json`
    try {
      const wsJsonPath = path.join(dshHome, 'storages', 'workspace.json')
      const parsed = JSON.parse(await fsp.readFile(wsJsonPath, 'utf8'))
      const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : []
      for (const ws of list.slice(0, MAX_SCAN_WORKSPACES)) {
        pushCandidate(ws?.id, ws?.path, ws?.title)
      }
    } catch {}

    // 3. Always include `dshHome` (`DSH_HOME` host root) if it has `PROJECT.md`
    if (dshHome) {
      pushCandidate('dsh-home', dshHome, 'DSH_HOME (内容与运行权威)')
    }

    // Deduplicate by resolved `projectRoot` so two workspaces pointing into the same project merge titles cleanly.
    const groupedByRoot = new Map()
    let missingWorkspaceDirs = 0

    for (const cand of rawCandidates) {
      const located = await locateProjectRootForWorkspace(cand.path)
      if (!located) continue
      if (located.missingDir) {
        missingWorkspaceDirs += 1
        continue
      }
      const rootKey = foldWinPath(located.projectRoot)
      const existing = groupedByRoot.get(rootKey)
      if (existing) {
        if (!existing.workspaceIds.includes(cand.id)) existing.workspaceIds.push(cand.id)
        if (cand.title && !existing.workspaceTitles.includes(cand.title)) {
          existing.workspaceTitles.push(cand.title)
        }
        if (located.hasProjectMd) {
          existing.hasProjectMd = true
          existing.projectMdPath = located.projectMdPath
        }
      } else {
        groupedByRoot.set(rootKey, {
          projectRoot: located.projectRoot,
          projectMdPath: located.projectMdPath,
          hasProjectMd: located.hasProjectMd,
          workspaceIds: [cand.id],
          workspaceTitles: cand.title ? [cand.title] : [],
        })
      }
    }

    const projects = []
    for (const group of groupedByRoot.values()) {
      try {
        const item = await inspectOneProjectRoot({
          ...group,
          maxBytes,
          maxLines,
        })
        projects.push(item)
      } catch {}
    }

    // Sort: `over` first, then `warn`, then `healthy` (by byteRatio desc), then `absent` last
    const statusOrder = { over: 0, warn: 1, healthy: 2, absent: 3 }
    projects.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 9
      const ob = statusOrder[b.status] ?? 9
      if (oa !== ob) return oa - ob
      if ((b.byteRatio || 0) !== (a.byteRatio || 0)) return (b.byteRatio || 0) - (a.byteRatio || 0)
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
    })

    const withProjectMd = projects.filter(p => p.hasProjectMd)
    const overCount = withProjectMd.filter(p => p.status === 'over').length
    const warnCount = withProjectMd.filter(p => p.status === 'warn').length
    const healthyCount = withProjectMd.filter(p => p.status === 'healthy').length
    const absentCount = projects.filter(p => !p.hasProjectMd).length
    const totalBrokenLinks = withProjectMd.reduce((sum, p) => sum + (p.brokenLinks?.length || 0), 0)

    const deja = await detectDejaStatus(dshHome)

    return {
      ok: true,
      scannedAt: new Date().toISOString(),
      caps: {
        maxBytes,
        maxLines,
        guardEnabled: cfg.enabled !== false && cfg.projectMemoryGuardEnabled !== false,
        reminderEnabled: cfg.enabled !== false && cfg.projectMemoryReminderEnabled !== false,
      },
      deja,
      summary: {
        totalWorkspaces: projects.length,
        withProjectMdCount: withProjectMd.length,
        healthyCount,
        warnCount,
        overCount,
        absentCount,
        totalBrokenLinks,
        missingWorkspaceDirs,
      },
      projects,
    }
  }

  return async function scanProjectMemories() {
    if (!inflightPromise) {
      inflightPromise = runScan().finally(() => {
        inflightPromise = null
      })
    }
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: 'project_memory_scan_timeout' }),
        SCAN_DEADLINE_MS
      )
      timer.unref?.()
    })
    return Promise.race([inflightPromise, timeout]).finally(() => clearTimeout(timer))
  }
}
