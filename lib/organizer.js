/**
 * dsh-session-ecology — Session & Workspace Organizer Engine (0.3.0).
 *
 * Absorbs the genuine strengths of `dsh-session-manager` (annotations: favorite, review-later,
 * 1..5 priority, tags, notes; batch archive/unarchive/pin; zero-restart cross-workspace move;
 * zero-restart live row removal) while fixing its critical flaws:
 * 1) Never orphans active schedules on archive or delete (inspects `schedule` service first);
 * 2) Never runs irreversible `fs.rm` on user sessions — moves artifacts to Windows Recycle Bin
 *    silently (`windowsHide: true`, zero popup flash) with full fallback trash directory support;
 * 3) Zero boot-time full-disk `projectionCache` refold storm.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  applyAnnotationPatch,
  assertValidSessionId,
  candidateSessionDirs,
  encodeFsSessionSegment,
  encodeProjectSegment,
  evaluateSessionEcology,
  isDefaultAnnotation,
  normalizeAnnotationRecord,
  sliceUtf8ByBytes,
} from './core.js'

const ARTIFACT_FILENAMES = [
  'session.v4.jsonl',
  'session.v4.jsonl.zstd',
  'session.v3.jsonl',
  'session.v3.jsonl.zstd',
  'session.v2.jsonl',
  'session.v2.jsonl.zstd',
  'session.jsonl',
  'session.jsonl.zstd',
]

const sleep = ms => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  t.unref?.()
})

function serviceOf(ctx, key) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    return viaGet ?? ctx?.[key]
  } catch {
    return undefined
  }
}

function describeError(err) {
  if (!err) return 'unknown error'
  return typeof err === 'string' ? err : err.message || String(err)
}

function parseGenerationFromFilename(filename) {
  const m = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(String(filename ?? ''))
  if (!m) return undefined
  return m[1] !== undefined ? Number(m[1]) : 0
}

/**
 * Strictly verify `<sessionsRoot>/<projSegment>/<sessionSegment>` containment with zero symlink/junction hops.
 */
export async function assertContainedSessionDir(sessionsRoot, candidateDir, sessionId, { allowMissing = false } = {}) {
  assertValidSessionId(sessionId)
  const base = path.resolve(sessionsRoot)
  const target = path.resolve(candidateDir)
  const rel = path.relative(base, target)
  const parts = rel.split(path.sep)
  const validLeafs = candidateSessionDirs(sessionId)

  if (
    path.isAbsolute(rel)
    || parts.length !== 2
    || parts.some(p => !p || p === '.' || p === '..')
    || !validLeafs.includes(parts[1])
  ) {
    throw Object.assign(new Error(`会话目录超出安全边界：${target}`), { code: 'path_out_of_bounds' })
  }

  let canonicalBase
  try {
    canonicalBase = await fsp.realpath(base)
  } catch (err) {
    if (allowMissing && err.code === 'ENOENT') return target
    throw err
  }

  let cursor = base
  for (const seg of parts) {
    cursor = path.join(cursor, seg)
    let st
    try {
      st = await fsp.lstat(cursor)
    } catch (err) {
      if (allowMissing && err.code === 'ENOENT') return target
      throw err
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw Object.assign(new Error(`会话目录不得为符号链接、junction 或普通文件：${cursor}`), { code: 'symlink_rejected' })
    }
    const real = await fsp.realpath(cursor)
    const relReal = path.relative(canonicalBase, real)
    if (path.isAbsolute(relReal) || relReal === '' || relReal.split(path.sep).includes('..')) {
      throw Object.assign(new Error(`会话真实路径逃逸出 sessions 根目录：${real}`), { code: 'realpath_escaped' })
    }
  }
  return target
}

/**
 * Fast header-only reader (reads at most the first 64 KB for plaintext JSONL).
 */
async function readArtifactHeaderFast(filePath) {
  const st = await fsp.lstat(filePath)
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('会话文件不是普通文件')
  if (filePath.endsWith('.zstd')) {
    const raw = await fsp.readFile(filePath)
    const text = zlib.zstdDecompressSync(raw).toString('utf8')
    const nl = text.indexOf('\n')
    if (nl < 0) throw new Error('会话文件缺少完整头行')
    const header = JSON.parse(text.slice(0, nl))
    assertValidSessionId(header?.id)
    return { header, mtimeMs: st.mtimeMs, sizeBytes: st.size }
  }
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(Math.min(65536, Math.max(1024, st.size)))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const chunk = buf.subarray(0, bytesRead).toString('utf8')
    const nl = chunk.indexOf('\n')
    if (nl < 0) {
      const full = await fsp.readFile(filePath, 'utf8')
      const nl2 = full.indexOf('\n')
      if (nl2 < 0) throw new Error('会话文件缺少完整头行')
      const header = JSON.parse(full.slice(0, nl2))
      assertValidSessionId(header?.id)
      return { header, mtimeMs: st.mtimeMs, sizeBytes: st.size }
    }
    const header = JSON.parse(chunk.slice(0, nl))
    assertValidSessionId(header?.id)
    return { header, mtimeMs: st.mtimeMs, sizeBytes: st.size }
  } finally {
    await fh.close()
  }
}

async function readFullArtifact(filePath) {
  const st = await fsp.lstat(filePath)
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('会话文件不是普通文件')
  const rawBytes = await fsp.readFile(filePath)
  const content = filePath.endsWith('.zstd')
    ? zlib.zstdDecompressSync(rawBytes).toString('utf8')
    : rawBytes.toString('utf8')
  if (!content.endsWith('\n')) {
    throw new Error('会话日志尾行不完整，为保护数据拒绝重写')
  }
  const nl = content.indexOf('\n')
  if (nl < 0) throw new Error('会话日志缺少头行')
  const header = JSON.parse(content.slice(0, nl))
  assertValidSessionId(header?.id)
  return {
    header,
    bodyRest: content.slice(nl + 1),
    path: filePath,
    filename: path.basename(filePath),
    compressed: filePath.endsWith('.zstd'),
  }
}

function encodeFullArtifact(headerObj, bodyRest, compressed) {
  const text = `${JSON.stringify(headerObj)}\n${bodyRest}`
  const utf8 = Buffer.from(text, 'utf8')
  return compressed ? zlib.zstdCompressSync(utf8) : utf8
}

async function writeTempSibling(finalPath, bytes) {
  const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
  const fh = await fsp.open(tmp, 'wx', 0o600)
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } catch (err) {
    await fh.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  await fh.close()
  return tmp
}

/**
 * Move verified directories/files to Windows System Recycle Bin via one hidden PowerShell call
 * (`windowsHide: true` => `CREATE_NO_WINDOW`, 0ms popup flash). Falls back to `fallbackTrashDir`
 * on non-Windows platforms or custom `recycleHandler` in unit tests.
 */
export async function movePathsToRecycleBin(pathsToRecycle, { fallbackTrashDir, recycleHandler } = {}) {
  const unique = Array.from(new Set((pathsToRecycle || []).filter(Boolean).map(p => path.resolve(p))))
  if (unique.length === 0) return { method: 'noop', moved: [] }

  if (typeof recycleHandler === 'function') {
    return recycleHandler(unique)
  }

  if (process.platform === 'win32') {
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(psExe)) {
      const psScript = [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$items = [Console]::In.ReadToEnd() | ConvertFrom-Json',
        '$moved = @()',
        'foreach ($p in $items) {',
        '  if (Test-Path -LiteralPath $p -PathType Container) {',
        '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin")',
        '    $moved += $p',
        '  } elseif (Test-Path -LiteralPath $p -PathType Leaf) {',
        '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin")',
        '    $moved += $p',
        '  }',
        '}',
        '@{ ok = $true; moved = @($moved) } | ConvertTo-Json -Compress',
      ].join('\n')
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = await new Promise((resolve, reject) => {
        const child = spawn(psExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', d => { stdout += d })
        child.stderr.on('data', d => { stderr += d })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`系统回收站调用失败 (exit=${code}): ${stderr.trim() || stdout.trim()}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout.trim())
            resolve({ method: 'windows-recycle-bin', moved: parsed.moved || [] })
          } catch {
            resolve({ method: 'windows-recycle-bin', moved: unique })
          }
        })
        child.stdin.end(JSON.stringify(unique))
      })
      return result
    }
  }

  // Non-Windows or missing powershell.exe fallback: move into recoverable local trash folder (never permanent rm!).
  if (!fallbackTrashDir) throw new Error('无法定位可恢复回收目录')
  const batchDir = path.join(fallbackTrashDir, `${Date.now()}-${randomBytes(4).toString('hex')}`)
  await fsp.mkdir(batchDir, { recursive: true })
  const moved = []
  for (let i = 0; i < unique.length; i += 1) {
    const src = unique[i]
    if (!fs.existsSync(src)) continue
    const dest = path.join(batchDir, `${i}-${path.basename(src)}`)
    await fsp.rename(src, dest)
    moved.push(dest)
  }
  return { method: 'local-trash-dir', trashDir: batchDir, moved }
}

export function createSessionOrganizer({
  ctx,
  dshHome,
  ledger,
  saveLedger,
  getConfig,
  getScheduleService,
  readAnySessionSnapshot,
  listActiveSchedulesOf,
  readBotIds,
  inFlight,
  broadcastSse,
  logger,
  warn,
  recycleHandler,
}) {
  const sessionsRoot = path.join(dshHome, 'sessions')
  const projCacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const fallbackTrashDir = path.join(dshHome, 'storages', 'session-ecology', 'recycle-bin')

  // Per-session mutation lock so concurrent moves/deletes on the same session serialize cleanly.
  const sessionLocks = new Map()
  function withSessionLock(sessionId, fn) {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tracked = next.finally(() => {
      if (sessionLocks.get(sessionId) === tracked) sessionLocks.delete(sessionId)
    })
    sessionLocks.set(sessionId, tracked)
    return next
  }

  function ensureAnnotationsMap() {
    if (!ledger.annotations || typeof ledger.annotations !== 'object') {
      ledger.annotations = {}
    }
    return ledger.annotations
  }

  function getAnnotation(sessionId) {
    const map = ensureAnnotationsMap()
    return normalizeAnnotationRecord(map[sessionId])
  }

  function workspaceMemberIdsOf(ws) {
    if (Array.isArray(ws?.record?.sessionIds)) return ws.record.sessionIds
    if (Array.isArray(ws?.sessionIds)) return ws.sessionIds
    return []
  }

  function isSessionRunning(sessionId) {
    const liveSession = serviceOf(ctx, 'sessions')?.get?.(sessionId)
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    return Boolean(
      liveSession?.activeTurn
      || liveAgent?.status === 'running'
      || liveAgent?.busy === true
      || inFlight.has(sessionId)
    )
  }

  /**
   * Locate the on-disk artifact of `sessionId` and verify containment inside `<dshHome>/sessions`.
   */
  async function locateSessionArtifact(sessionId, headerHint) {
    assertValidSessionId(sessionId)
    const persistence = serviceOf(ctx, 'sessionPersistence')
    if (headerHint?.cwd && typeof persistence?.locate === 'function') {
      const located = persistence.locate({ ...headerHint, id: sessionId })?.path
      if (typeof located === 'string' && fs.existsSync(located)) {
        await assertContainedSessionDir(sessionsRoot, path.dirname(located), sessionId)
        return located
      }
    }
    if (!fs.existsSync(sessionsRoot)) return undefined
    const projects = await fsp.readdir(sessionsRoot, { withFileTypes: true })
    const candidates = candidateSessionDirs(sessionId)
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue
      for (const leaf of candidates) {
        const dir = path.join(sessionsRoot, proj.name, leaf)
        if (!fs.existsSync(dir)) continue
        try {
          await assertContainedSessionDir(sessionsRoot, dir, sessionId)
        } catch {
          continue
        }
        for (const fname of ARTIFACT_FILENAMES) {
          const full = path.join(dir, fname)
          if (fs.existsSync(full)) {
            const { header } = await readArtifactHeaderFast(full)
            if (header.id === sessionId) return full
          }
        }
      }
    }
    return undefined
  }

  /**
   * Lightweight scan of `<dshHome>/sessions` headers (reads first line only for unindexed dirs).
   */
  async function collectDiskHeadersMap(knownHeadersMap) {
    const out = new Map(knownHeadersMap)
    if (!fs.existsSync(sessionsRoot)) return out
    let projects = []
    try {
      projects = await fsp.readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return out
    }
    for (const proj of projects) {
      if (!proj.isDirectory() || proj.isSymbolicLink()) continue
      const projDir = path.join(sessionsRoot, proj.name)
      let children = []
      try {
        children = await fsp.readdir(projDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue
        // Fast skip if raw dir name is already in `out`
        if (out.has(child.name)) continue
        const sDir = path.join(projDir, child.name)
        for (const fname of ARTIFACT_FILENAMES) {
          const fpath = path.join(sDir, fname)
          if (!fs.existsSync(fpath)) continue
          try {
            const { header, mtimeMs } = await readArtifactHeaderFast(fpath)
            if (header?.id && !out.has(header.id)) {
              out.set(header.id, { ...header, _mtimeMs: mtimeMs })
            }
          } catch {}
          break
        }
      }
    }
    return out
  }

  /**
   * Build full session & workspace catalog with rich filtering and sorting.
   */
  async function listCatalog(query = {}) {
    const workspaceRegistry = serviceOf(ctx, 'workspaceRegistry')
    const scheduleSvc = (typeof getScheduleService === 'function' ? getScheduleService() : null) ?? serviceOf(ctx, 'schedule')
    const botIds = readBotIds()

    const archivedSet = new Set(workspaceRegistry?.archivedSessionIds ?? [])
    const pinnedSet = new Set(workspaceRegistry?.pinnedSessionIds ?? [])

    const scheduleBySession = new Map()
    try {
      if (typeof scheduleSvc?.catalog === 'function') {
        const allScheds = await scheduleSvc.catalog()
        for (const rec of allScheds || []) {
          if (rec.status && rec.status !== 'active') continue
          const ownerSid = rec.target?.kind === 'session' ? rec.target.sessionId : rec.sessionId
          if (!ownerSid) continue
          const arr = scheduleBySession.get(ownerSid) ?? []
          arr.push(rec)
          scheduleBySession.set(ownerSid, arr)
        }
      }
    } catch {}

    const workspaces = []
    const wsBySession = new Map()
    for (const ws of workspaceRegistry?.list?.() ?? []) {
      const memberIds = workspaceMemberIdsOf(ws)
      let activeCount = 0
      let archivedCount = 0
      for (const sid of memberIds) {
        wsBySession.set(sid, { id: ws.id, title: ws.title || path.basename(ws.path || '') || ws.id, path: ws.path || '' })
        if (archivedSet.has(sid)) archivedCount += 1
        else activeCount += 1
      }
      workspaces.push({
        id: ws.id,
        title: ws.title || path.basename(ws.path || '') || ws.id,
        path: ws.path || '',
        activeCount,
        archivedCount,
        totalCount: memberIds.length,
      })
    }

    // Seed headers from in-memory registry & live sessions, then supplement any unindexed disk sessions.
    const seedHeaders = new Map()
    try {
      if (typeof workspaceRegistry?.headers?.entries === 'function') {
        for (const [id, h] of workspaceRegistry.headers.entries()) {
          if (h && typeof id === 'string') seedHeaders.set(id, h)
        }
      }
    } catch {}
    try {
      for (const s of serviceOf(ctx, 'sessions')?.list?.() ?? []) {
        if (s?.header?.id) seedHeaders.set(s.header.id, s.header)
      }
    } catch {}
    for (const sid of wsBySession.keys()) {
      if (!seedHeaders.has(sid)) seedHeaders.set(sid, { id: sid })
    }
    for (const sid of archivedSet) {
      if (!seedHeaders.has(sid)) seedHeaders.set(sid, { id: sid })
    }

    const allHeaders = await collectDiskHeadersMap(seedHeaders)

    const counts = {
      total: 0,
      active: 0,
      archived: 0,
      ungrouped: 0,
      favorites: 0,
      reviewLater: 0,
      scheduled: 0,
      overThreshold: 0,
    }
    const tagCountMap = new Map()
    const rows = []

    for (const [sid, rawHeader] of allHeaders.entries()) {
      if (rawHeader?.origin === 'subagent' || Number(rawHeader?.delegationDepth) > 0 || rawHeader?.subagent) continue
      const snap = await readAnySessionSnapshot(sid, rawHeader)
      const header = { ...(rawHeader || {}), ...(snap.header || {}), id: sid }
      if (header?.origin === 'subagent' || Number(header?.delegationDepth) > 0 || header?.subagent) continue

      const archived = archivedSet.has(sid)
      const pinned = pinnedSet.has(sid)
      const wsInfo = wsBySession.get(sid) ?? null
      const evaluation = evaluateSessionEcology(snap, getConfig())
      const activeSchedules = scheduleBySession.get(sid) ?? []
      const annotation = getAnnotation(sid)
      const isBot = botIds.has(sid)
      const running = isSessionRunning(sid)

      // Derive updatedAt from projcache file mtime / header createdAt / annotation updatedAt
      let updatedAt = Number(rawHeader?._mtimeMs) || Number(header?.createdAt) || 0
      const projFile = path.join(projCacheDir, `${sid}.json`)
      try {
        const st = fs.statSync(projFile)
        if (st.mtimeMs > updatedAt) updatedAt = st.mtimeMs
      } catch {}

      counts.total += 1
      if (archived) counts.archived += 1
      else counts.active += 1
      if (!wsInfo) counts.ungrouped += 1
      if (annotation.favorite) counts.favorites += 1
      if (annotation.reviewLater) counts.reviewLater += 1
      if (activeSchedules.length > 0) counts.scheduled += 1
      if (!archived && evaluation.triggered) counts.overThreshold += 1
      for (const t of annotation.tags) {
        const key = t.toLowerCase()
        const cur = tagCountMap.get(key)
        if (cur) cur.count += 1
        else tagCountMap.set(key, { tag: t, count: 1 })
      }

      rows.push({
        sessionId: sid,
        title: snap.title || '(未命名)',
        workspaceId: wsInfo?.id ?? null,
        workspaceTitle: wsInfo?.title ?? '未分组',
        cwd: snap.cwd || header?.cwd || wsInfo?.path || '',
        agentPreset: snap.agentPreset || header?.agentPreset || 'default',
        model: snap.modelSelection ? `${snap.modelSelection.provider}/${snap.modelSelection.model}` : 'default',
        createdAt: Number(header?.createdAt) || 0,
        updatedAt: Math.round(updatedAt),
        archived,
        pinned,
        running,
        isBot,
        activeSchedules: activeSchedules.length,
        scheduleTitles: activeSchedules.map(s => s.title),
        status: evaluation.status,
        triggered: evaluation.triggered,
        maxGateProgress: evaluation.maxGateProgress,
        reasons: evaluation.reasons,
        metrics: evaluation.metrics,
        annotation,
        transferredTo: ledger.transferred?.[sid]?.newSessionId ?? null,
        lineageFrom: ledger.lineage?.[sid]?.previousSessionId ?? null,
      })
    }

    // Apply optional filters
    const archiveFilter = String(query.archiveFilter || 'active') // 'active' | 'archived' | 'all'
    const workspaceFilter = String(query.workspaceId || 'all') // 'all' | 'ungrouped' | <wsId>
    const search = String(query.search || '').trim().toLowerCase()
    const tagFilter = String(query.tag || '').trim().toLowerCase()
    const priorityFilter = query.priority !== undefined && query.priority !== '' && query.priority !== 'all'
      ? Number(query.priority)
      : null
    const favoriteOnly = query.favoriteOnly === true || query.favoriteOnly === '1'
    const reviewOnly = query.reviewOnly === true || query.reviewOnly === '1'
    const scheduledOnly = query.scheduledOnly === true || query.scheduledOnly === '1'
    const overOnly = query.overOnly === true || query.overOnly === '1'
    const sortBy = String(query.sortBy || 'updated_desc')

    const filtered = rows.filter((row) => {
      if (archiveFilter === 'active' && row.archived) return false
      if (archiveFilter === 'archived' && !row.archived) return false
      if (workspaceFilter === 'ungrouped' && row.workspaceId !== null) return false
      if (workspaceFilter !== 'all' && workspaceFilter !== 'ungrouped' && row.workspaceId !== workspaceFilter) return false
      if (favoriteOnly && !row.annotation.favorite) return false
      if (reviewOnly && !row.annotation.reviewLater) return false
      if (scheduledOnly && row.activeSchedules === 0) return false
      if (overOnly && row.status === 'healthy') return false
      if (priorityFilter !== null && Number.isInteger(priorityFilter) && row.annotation.priority !== priorityFilter) return false
      if (tagFilter && !row.annotation.tags.some(t => t.toLowerCase() === tagFilter)) return false
      if (search) {
        const hay = [
          row.title,
          row.sessionId,
          row.workspaceTitle,
          row.annotation.note,
          ...row.annotation.tags,
        ].join('\n').toLowerCase()
        if (!hay.includes(search)) return false
      }
      return true
    })

    filtered.sort((a, b) => {
      if (sortBy === 'priority_asc') {
        if (a.annotation.priority !== b.annotation.priority) return a.annotation.priority - b.annotation.priority
        return b.updatedAt - a.updatedAt
      }
      if (sortBy === 'ecology_desc') {
        if (b.maxGateProgress !== a.maxGateProgress) return b.maxGateProgress - a.maxGateProgress
        return b.updatedAt - a.updatedAt
      }
      if (sortBy === 'title_asc') {
        return a.title.localeCompare(b.title, 'zh-CN')
      }
      if (sortBy === 'updated_asc') {
        return a.updatedAt - b.updatedAt
      }
      // Default `updated_desc`: pinned first, then most recently updated
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })

    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 300))
    const allTags = [...tagCountMap.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'))

    return {
      ok: true,
      counts,
      matchedCount: filtered.length,
      workspaces,
      allTags,
      sessions: filtered.slice(0, limit),
    }
  }

  /**
   * Normalize and deduplicate a batch of session IDs (`1..200`).
   */
  function normalizeSessionIdList(rawIds) {
    const arr = Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? [rawIds] : []
    const unique = Array.from(new Set(arr.map(s => String(s ?? '').trim()).filter(Boolean)))
    if (unique.length === 0) throw Object.assign(new Error('至少需要指定 1 个 sessionId'), { code: 'empty_session_ids' })
    if (unique.length > 200) throw Object.assign(new Error('单次批量操作最多支持 200 个会话'), { code: 'too_many_sessions' })
    for (const id of unique) assertValidSessionId(id)
    return unique
  }

  /**
   * Single or batch annotation update (`favorite`, `reviewLater`, `priority`, `tags`/`addTags`/`removeTags`/`clearTags`, `note`).
   */
  function annotateSessions({ sessionIds, patch }) {
    const ids = normalizeSessionIdList(sessionIds)
    const map = ensureAnnotationsMap()
    const nowMs = Date.now()
    const items = []
    let success = 0
    let failed = 0
    let anyChanged = false

    for (const id of ids) {
      try {
        const { changed, next } = applyAnnotationPatch(map[id], patch, nowMs)
        if (changed) {
          anyChanged = true
          if (isDefaultAnnotation(next)) {
            delete map[id]
          } else {
            map[id] = next
          }
        }
        items.push({ sessionId: id, status: 'success', changed, annotation: next })
        success += 1
      } catch (err) {
        items.push({ sessionId: id, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }

    if (anyChanged) {
      saveLedger()
      broadcastSse({
        type: 'annotations',
        items: items.filter(i => i.status === 'success').map(i => ({ sessionId: i.sessionId, annotation: i.annotation })),
      })
    }

    return {
      ok: failed === 0,
      summary: { total: ids.length, success, skipped: 0, failed },
      items,
    }
  }

  async function renameSession({ sessionId, title }) {
    assertValidSessionId(sessionId)
    const cleanTitle = sliceUtf8ByBytes(String(title ?? '').replace(/\s+/g, ' ').trim(), 80)
    if (!cleanTitle) throw Object.assign(new Error('会话标题不能为空'), { code: 'empty_title' })
    const controller = serviceOf(ctx, 'sessionController')
    if (typeof controller?.rename !== 'function') {
      throw new Error('sessionController.rename 服务不可用')
    }
    await controller.rename({ sessionId, title: cleanTitle })
    return { ok: true, sessionId, title: cleanTitle }
  }

  async function setPinSessions({ sessionIds, pinned }) {
    const ids = normalizeSessionIdList(sessionIds)
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const fn = pinned ? registry?.pinSession : registry?.unpinSession
    if (typeof fn !== 'function') throw new Error('workspaceRegistry 置顶服务不可用')

    const items = []
    let success = 0
    let failed = 0
    for (const id of ids) {
      try {
        await fn.call(registry, id)
        items.push({ sessionId: id, status: 'success', pinned: Boolean(pinned) })
        success += 1
      } catch (err) {
        items.push({ sessionId: id, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }
    return { ok: failed === 0, summary: { total: ids.length, success, skipped: 0, failed }, items }
  }

  /**
   * Single or batch archive / unarchive with Orphan-Schedule Protection!
   */
  async function setArchiveSessions({
    sessionIds,
    archived,
    allowScheduledArchive = false,
    stopActivity = false,
  }) {
    const ids = normalizeSessionIdList(sessionIds)
    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (!registry) throw new Error('workspaceRegistry 服务不可用')
    const botIds = readBotIds()

    const items = []
    let success = 0
    let skipped = 0
    let failed = 0

    for (const id of ids) {
      try {
        if (archived) {
          if (botIds.has(id)) {
            items.push({ sessionId: id, status: 'skipped', reason: 'ds-bot 托管会话受保护，跳过归档' })
            skipped += 1
            continue
          }
          const scheds = await listActiveSchedulesOf(id)
          if (scheds.length > 0 && !allowScheduledArchive) {
            items.push({
              sessionId: id,
              status: 'skipped',
              code: 'has_active_schedules',
              reason: `挂载有 ${scheds.length} 条活跃定时任务（${scheds.map(s => s.title).join('、')}），请改用「换卷继承」或勾选允许带任务归档`,
            })
            skipped += 1
            continue
          }
          await registry.archiveSession(id, { stopActivity: stopActivity === true })
          items.push({ sessionId: id, status: 'success', archived: true })
          success += 1
        } else {
          await registry.unarchiveSession(id)
          let ledgerTouched = false
          for (const rec of ledger.history || []) {
            if (rec.oldSessionId === id && rec.archived) {
              rec.archived = false
              ledgerTouched = true
            }
          }
          if (ledgerTouched) saveLedger()
          items.push({ sessionId: id, status: 'success', archived: false })
          success += 1
        }
      } catch (err) {
        items.push({ sessionId: id, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }

    return { ok: failed === 0, summary: { total: ids.length, success, skipped, failed }, items }
  }

  /**
   * Move one session across workspaces with atomic artifact re-homing, rollback, and live writer rebind.
   */
  async function moveOneSession(sessionId, targetEntity, targetPath) {
    assertValidSessionId(sessionId)
    const botIds = readBotIds()
    if (botIds.has(sessionId)) {
      return { sessionId, status: 'skipped', reason: 'ds-bot 托管会话不支持移动工作区' }
    }
    if (isSessionRunning(sessionId)) {
      return { sessionId, status: 'skipped', reason: '会话当前正在运行回合，请等待空闲后再移动' }
    }

    const registry = serviceOf(ctx, 'workspaceRegistry')
    const persistence = serviceOf(ctx, 'sessionPersistence')
    const sessionsSvc = serviceOf(ctx, 'sessions')
    const liveSession = sessionsSvc?.get?.(sessionId)
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)

    const snap = await readAnySessionSnapshot(sessionId)
    if (snap.header?.origin === 'subagent' || Number(snap.header?.delegationDepth) > 0) {
      return { sessionId, status: 'skipped', reason: '子代理（subagent）会话不支持移动工作区' }
    }

    if (liveSession) {
      const writer = persistence?.tracker?.writers?.get?.(sessionId)
      if (!writer || typeof writer.header !== 'object') {
        return { sessionId, status: 'failed', error: '运行态会话未暴露可重绑定的持久化句柄，请刷新或空闲后重试' }
      }
      await sessionsSvc?.flush?.(liveSession).catch(() => {})
    }

    const oldFilePath = await locateSessionArtifact(sessionId, snap.header)
    if (!oldFilePath) {
      return { sessionId, status: 'skipped', reason: '该会话尚无落盘日志（空白占位会话），无法跨工作区移动' }
    }

    const raw = await readFullArtifact(oldFilePath)
    let currentCanonical = ''
    if (typeof raw.header.cwd === 'string' && raw.header.cwd.trim() !== '') {
      try {
        currentCanonical = await fsp.realpath(raw.header.cwd)
      } catch {}
    }

    const runRegistryOp = fn => (typeof registry?.enqueueOperation === 'function' ? registry.enqueueOperation(fn) : fn())

    // Case 1: Artifact `cwd` already resolves to `targetPath` -> repair membership only (zero file rewrite!).
    if (currentCanonical === targetPath) {
      const alreadyInTarget = workspaceMemberIdsOf(targetEntity).includes(sessionId)
      const otherOwners = (registry?.list?.() ?? []).filter(w => w.id !== targetEntity.id && workspaceMemberIdsOf(w).includes(sessionId))
      await runRegistryOp(async () => {
        for (const other of otherOwners) {
          await other.detachSession(sessionId)
        }
        if (!alreadyInTarget) {
          await targetEntity.attachSession(sessionId)
        }
      })
      return {
        sessionId,
        status: 'success',
        moved: false,
        repairedMembership: !alreadyInTarget || otherOwners.length > 0,
        toWorkspaceId: targetEntity.id,
        toWorkspaceTitle: targetEntity.title,
      }
    }

    // Case 2: True cross-workspace move -> rewrite header.cwd, append cold working-directory/change if needed, relocate file, swap membership.
    const newHeader = { ...raw.header, cwd: targetPath }
    const locatedNew = persistence?.locate?.(newHeader)?.path
    const targetFilename = liveSession && locatedNew ? path.basename(locatedNew) : raw.filename
    const targetDir = locatedNew
      ? path.dirname(locatedNew)
      : path.join(sessionsRoot, encodeProjectSegment(targetPath), encodeFsSessionSegment(sessionId))
    const newFilePath = path.join(targetDir, targetFilename)
    const gen = parseGenerationFromFilename(targetFilename)
    if (typeof gen === 'number') newHeader.version = gen

    await assertContainedSessionDir(sessionsRoot, path.dirname(oldFilePath), sessionId)
    await assertContainedSessionDir(sessionsRoot, targetDir, sessionId, { allowMissing: true })

    if (fs.existsSync(newFilePath)) {
      throw new Error('目标工作区目录下已存在同名会话文件，拒绝覆盖')
    }

    // Update cold working-directory event if log previously recorded `working-directory/change`
    let nextBodyRest = raw.bodyRest
    if (!liveSession && nextBodyRest.length > 0) {
      const trimmedBody = nextBodyRest.endsWith('\n') ? nextBodyRest.slice(0, -1) : nextBodyRest
      const lines = trimmedBody ? trimmedBody.split('\n') : []
      let lastWdChange
      let sequential = true
      for (let i = 0; i < lines.length; i += 1) {
        try {
          const ev = JSON.parse(lines[i])
          if (ev?.seq !== i) sequential = false
          if (ev?.type === 'working-directory/change') lastWdChange = ev.data?.cwd
        } catch {
          sequential = false
        }
      }
      if (lastWdChange !== undefined && lastWdChange !== targetPath) {
        if (!sequential) {
          throw new Error('会话包含非顺序压缩事件且有工作目录切换记录，为防状态不一致已拒绝移动')
        }
        const appended = JSON.stringify({
          type: 'working-directory/change',
          seq: lines.length,
          time: Date.now(),
          data: { cwd: targetPath },
        })
        nextBodyRest = `${trimmedBody}\n${appended}\n`
      }
    }

    const encodedBytes = encodeFullArtifact(newHeader, nextBodyRest, newFilePath.endsWith('.zstd'))
    await fsp.mkdir(targetDir, { recursive: true })
    const tempNew = await writeTempSibling(newFilePath, encodedBytes)
    const hiddenOld = `${oldFilePath}.${randomBytes(6).toString('hex')}.moving`

    try {
      await fsp.rename(oldFilePath, hiddenOld)
    } catch (err) {
      await fsp.rm(tempNew, { force: true }).catch(() => {})
      throw new Error(`无法锁定原会话文件，移动已取消：${describeError(err)}`)
    }

    try {
      await fsp.rename(tempNew, newFilePath)
    } catch (err) {
      await fsp.rename(hiddenOld, oldFilePath).catch(() => {})
      await fsp.rm(tempNew, { force: true }).catch(() => {})
      throw new Error(`写入目标工作区失败，原会话已恢复：${describeError(err)}`)
    }

    const liveWriter = liveSession ? persistence?.tracker?.writers?.get?.(sessionId) : undefined
    const oldLiveHeader = liveSession?.header
    const oldWriterHeader = liveWriter?.header
    const oldIndexedHeader = registry?.headers?.get?.(sessionId)
    const oldIndexedPath = registry?.sessionPaths?.get?.(sessionId)
    const fromWorkspaces = (registry?.list?.() ?? []).filter(
      w => w.id !== targetEntity.id && workspaceMemberIdsOf(w).includes(sessionId)
    )
    const detachedFrom = []
    let attachedTarget = false

    try {
      persistence?.coldLogMemo?.delete?.(sessionId)
      if (liveSession) {
        liveSession.header = Object.freeze({ ...newHeader })
        if (liveWriter) liveWriter.header = Object.freeze({ ...newHeader })
      }
      registry?.headers?.set?.(sessionId, { ...newHeader })
      registry?.sessionPaths?.set?.(sessionId, targetPath)
      registry?.invalidSessionPaths?.delete?.(sessionId)

      await runRegistryOp(async () => {
        for (const ws of fromWorkspaces) {
          await ws.detachSession(sessionId)
          detachedFrom.push(ws)
        }
        await targetEntity.attachSession(sessionId)
        attachedTarget = true
      })
    } catch (err) {
      // Full rollback of memory + workspace accounting + disk files
      if (liveSession && oldLiveHeader) liveSession.header = oldLiveHeader
      if (liveWriter && oldWriterHeader) liveWriter.header = oldWriterHeader
      if (oldIndexedHeader === undefined) registry?.headers?.delete?.(sessionId)
      else registry?.headers?.set?.(sessionId, oldIndexedHeader)
      if (oldIndexedPath === undefined) registry?.sessionPaths?.delete?.(sessionId)
      else registry?.sessionPaths?.set?.(sessionId, oldIndexedPath)

      if (attachedTarget) await targetEntity.detachSession(sessionId).catch(() => {})
      for (const ws of detachedFrom) {
        await ws.attachSession(sessionId).catch(() => {})
      }
      await fsp.rm(newFilePath, { force: true }).catch(() => {})
      await fsp.rename(hiddenOld, oldFilePath).catch(() => {})
      throw new Error(`更新工作区账本失败，已完整回滚：${describeError(err)}`)
    }

    // Cleanup old hidden file & old empty session directory
    await fsp.rm(hiddenOld, { force: true }).catch(() => {})
    const oldDir = path.dirname(oldFilePath)
    try {
      const rem = await fsp.readdir(oldDir)
      if (rem.length === 0) await fsp.rmdir(oldDir)
    } catch {}

    // Sync live workingDirectory projection if session is live
    if (liveSession) {
      const wdService = serviceOf(ctx, 'workingDirectory')
      let synced = false
      if (typeof wdService?.set === 'function' && liveAgent) {
        try {
          await wdService.set(liveAgent, targetPath)
          synced = true
        } catch {}
      }
      if (!synced && typeof liveSession.append === 'function') {
        try {
          liveSession.append('working-directory/change', { cwd: targetPath })
        } catch {}
      }
    }

    // Refresh persisted session_projcache cwd so cold reads immediately reflect the new workspace
    const projFile = path.join(projCacheDir, `${sessionId}.json`)
    if (fs.existsSync(projFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(projFile, 'utf8'))
        if (cached?.record) {
          if (cached.record.identity) cached.record.identity.cwd = targetPath
          if (cached.record.rows?.workingDirectory) cached.record.rows.workingDirectory.val = targetPath
          const tmpProj = `${projFile}.${randomBytes(4).toString('hex')}.tmp`
          fs.writeFileSync(tmpProj, JSON.stringify(cached), 'utf8')
          fs.renameSync(tmpProj, projFile)
        }
      } catch {}
    }

    logger(`已将会话 ${sessionId} 移动至工作区「${targetEntity.title}」(${targetPath})`)
    return {
      sessionId,
      status: 'success',
      moved: true,
      toWorkspaceId: targetEntity.id,
      toWorkspaceTitle: targetEntity.title,
    }
  }

  async function moveSessions({ sessionIds, targetWorkspaceId }) {
    const ids = normalizeSessionIdList(sessionIds)
    const wsId = String(targetWorkspaceId ?? '').trim()
    if (!wsId) throw Object.assign(new Error('必须指定目标工作区 targetWorkspaceId'), { code: 'missing_workspace_id' })

    const registry = serviceOf(ctx, 'workspaceRegistry')
    const targetEntity = (registry?.list?.() ?? []).find(w => w.id === wsId)
    if (!targetEntity) {
      throw Object.assign(new Error(`目标工作区不存在：${wsId}`), { code: 'workspace_not_found' })
    }
    const targetPath = await fsp.realpath(targetEntity.path)
    const st = await fsp.stat(targetPath)
    if (!st.isDirectory()) throw new Error(`目标工作区路径不是有效目录：${targetPath}`)

    const items = []
    let success = 0
    let skipped = 0
    let failed = 0

    for (const id of ids) {
      try {
        const res = await withSessionLock(id, () => moveOneSession(id, targetEntity, targetPath))
        items.push(res)
        if (res.status === 'success') success += 1
        else if (res.status === 'skipped') skipped += 1
        else failed += 1
      } catch (err) {
        items.push({ sessionId: id, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }

    return {
      ok: failed === 0,
      summary: { total: ids.length, success, skipped, failed },
      items,
    }
  }

  /**
   * Discover descendant `subagent` sessions (`origin === 'subagent' && parentSession === ...`).
   */
  async function findDescendantSubagentIds(rootIds) {
    const allHeaders = await collectDiskHeadersMap(new Map())
    const visited = new Set(rootIds)
    let frontier = new Set(rootIds)
    const descendants = []
    while (frontier.size > 0) {
      const next = new Set()
      for (const [id, h] of allHeaders.entries()) {
        if (visited.has(id)) continue
        if (h?.origin === 'subagent' && h.parentSession && frontier.has(h.parentSession)) {
          visited.add(id)
          next.add(id)
          descendants.push({ id, header: h })
        }
      }
      frontier = next
    }
    return descendants
  }

  async function teardownLiveSessionAndRegistry(sid) {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const sessionsSvc = serviceOf(ctx, 'sessions')
    const agentsSvc = serviceOf(ctx, 'agents')
    const persistence = serviceOf(ctx, 'sessionPersistence')

    const liveAgent = agentsSvc?.get?.(sid)
    if (liveAgent) {
      try { liveAgent.cancel?.({ kind: 'disposed' }) } catch {}
      if (typeof liveAgent.scope?.dispose === 'function') {
        await Promise.race([liveAgent.scope.dispose(), sleep(2500)]).catch(() => {})
      }
      try { agentsSvc?.store?.delete?.(sid) } catch {}
    }

    if (typeof registry?.stopSessionActivity === 'function') {
      await registry.stopSessionActivity(sid).catch(() => {})
    }

    const liveSession = sessionsSvc?.get?.(sid)
    let detached = false
    if (liveSession) {
      await sessionsSvc?.flush?.(liveSession).catch(() => {})
      const entry = sessionsSvc?.store?.get?.(sid)
      if (typeof entry?.detach === 'function') {
        try {
          entry.detach()
          detached = true
          await sleep(120)
        } catch {}
      }
    }
    if (!detached) {
      try { ctx.emit?.('session/disposed', { id: sid }) } catch {}
    }

    const runRegistryOp = fn => (typeof registry?.enqueueOperation === 'function' ? registry.enqueueOperation(fn) : fn())
    await runRegistryOp(async () => {
      for (const ws of registry?.list?.() ?? []) {
        if (workspaceMemberIdsOf(ws).includes(sid)) {
          await ws.detachSession(sid).catch(() => {})
        }
      }
    })
    await registry?.unarchiveSession?.(sid).catch(() => {})
    await registry?.unpinSession?.(sid).catch(() => {})
    persistence?.coldLogMemo?.delete?.(sid)
    registry?.headers?.delete?.(sid)
    registry?.sessionPaths?.delete?.(sid)
    registry?.invalidSessionPaths?.delete?.(sid)
  }

  /**
   * Recoverable deletion: detaches live/workspace state with zero restart and moves disk directories
   * into the Windows System Recycle Bin (`SendToRecycleBin`, `windowsHide: true`).
   */
  async function recycleSessions({
    sessionIds,
    callerSessionId = '',
    deleteSchedules = false,
    stopActivity = false,
  }) {
    const ids = normalizeSessionIdList(sessionIds)
    const botIds = readBotIds()
    const scheduleService = (typeof getScheduleService === 'function' ? getScheduleService() : null) ?? serviceOf(ctx, 'schedule')

    const items = []
    const approvedPlans = []
    let skipped = 0
    let failed = 0

    for (const id of ids) {
      try {
        if (callerSessionId && id === callerSessionId) {
          items.push({ sessionId: id, status: 'skipped', reason: '不能删除当前正在执行命令的会话本身' })
          skipped += 1
          continue
        }
        if (botIds.has(id)) {
          items.push({ sessionId: id, status: 'skipped', reason: 'ds-bot 托管会话受保护，禁止删除' })
          skipped += 1
          continue
        }
        if (isSessionRunning(id) && !stopActivity) {
          items.push({ sessionId: id, status: 'skipped', code: 'session_running', reason: '会话正在运行中，请等空闲或勾选停止活动后再移入回收站' })
          skipped += 1
          continue
        }
        const scheds = await listActiveSchedulesOf(id)
        if (scheds.length > 0 && !deleteSchedules) {
          items.push({
            sessionId: id,
            status: 'skipped',
            code: 'has_active_schedules',
            reason: `挂载有 ${scheds.length} 条活跃定时任务（${scheds.map(s => s.title).join('、')}），请先换卷继承迁走或勾选「同时删除其定时任务」`,
          })
          skipped += 1
          continue
        }

        const snap = await readAnySessionSnapshot(id)
        const mainArtifact = await locateSessionArtifact(id, snap.header)
        const mainDir = mainArtifact ? path.dirname(mainArtifact) : undefined
        if (mainDir) await assertContainedSessionDir(sessionsRoot, mainDir, id)

        const descendants = await findDescendantSubagentIds([id])
        const subDirs = []
        for (const sub of descendants) {
          const subArtifact = await locateSessionArtifact(sub.id, sub.header)
          if (subArtifact) {
            const sDir = path.dirname(subArtifact)
            await assertContainedSessionDir(sessionsRoot, sDir, sub.id)
            subDirs.push({ id: sub.id, dir: sDir })
          } else {
            subDirs.push({ id: sub.id, dir: undefined })
          }
        }

        approvedPlans.push({
          sessionId: id,
          title: snap.title || id,
          mainDir,
          subDirs,
          schedules: scheds,
        })
      } catch (err) {
        items.push({ sessionId: id, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }

    const pathsToRecycle = []
    const succeededPlans = []

    for (const plan of approvedPlans) {
      try {
        await withSessionLock(plan.sessionId, async () => {
          // 1) Cleanly delete active schedules first if explicitly authorized
          let deletedScheduleCount = 0
          if (plan.schedules.length > 0 && deleteSchedules) {
            if (typeof scheduleService?.delete === 'function') {
              const abort = new AbortController()
              for (const s of plan.schedules) {
                await scheduleService.delete({ sessionId: plan.sessionId, id: s.id }, abort.signal)
                deletedScheduleCount += 1
              }
            } else if (typeof scheduleService?.stopSessionTasks === 'function') {
              await scheduleService.stopSessionTasks(plan.sessionId)
              deletedScheduleCount = plan.schedules.length
            } else if (typeof scheduleService?.edit === 'function') {
              for (const s of plan.schedules) {
                await scheduleService.edit({ id: s.id, action: 'delete' })
                deletedScheduleCount += 1
              }
            } else {
              throw new Error('schedule.delete 服务不可用，无法清理关联定时任务')
            }
          }

          // 2) Teardown descendant subagents (reverse order) then main session in host memory & workspace registry
          for (const sub of [...plan.subDirs].reverse()) {
            await teardownLiveSessionAndRegistry(sub.id)
            if (sub.dir && fs.existsSync(sub.dir)) pathsToRecycle.push(sub.dir)
            const subProj = path.join(projCacheDir, `${sub.id}.json`)
            if (fs.existsSync(subProj)) pathsToRecycle.push(subProj)
          }

          await teardownLiveSessionAndRegistry(plan.sessionId)
          // Re-check artifact directory in case flush materialized a file
          const finalArtifact = plan.mainDir
            ? path.join(plan.mainDir, 'probe')
            : await locateSessionArtifact(plan.sessionId, null)
          const finalDir = plan.mainDir || (finalArtifact ? path.dirname(finalArtifact) : undefined)
          if (finalDir && fs.existsSync(finalDir)) {
            await assertContainedSessionDir(sessionsRoot, finalDir, plan.sessionId)
            pathsToRecycle.push(finalDir)
          }
          const mainProj = path.join(projCacheDir, `${plan.sessionId}.json`)
          if (fs.existsSync(mainProj)) pathsToRecycle.push(mainProj)

          succeededPlans.push({ ...plan, deletedScheduleCount })
        })
      } catch (err) {
        items.push({ sessionId: plan.sessionId, status: 'failed', error: describeError(err) })
        failed += 1
      }
    }

    let recycleOutcome = { method: 'noop', moved: [] }
    if (pathsToRecycle.length > 0) {
      recycleOutcome = await movePathsToRecycleBin(pathsToRecycle, {
        fallbackTrashDir,
        recycleHandler,
      })
    }

    const map = ensureAnnotationsMap()
    if (!Array.isArray(ledger.recycleHistory)) ledger.recycleHistory = []
    let ledgerChanged = false

    for (const p of succeededPlans) {
      if (map[p.sessionId]) {
        delete map[p.sessionId]
        ledgerChanged = true
      }
      ledger.recycleHistory.push({
        at: new Date().toISOString(),
        sessionId: p.sessionId,
        title: p.title,
        method: recycleOutcome.method,
        deletedSchedules: p.deletedScheduleCount,
        subagentCount: p.subDirs.length,
      })
      if (ledger.recycleHistory.length > 200) {
        ledger.recycleHistory = ledger.recycleHistory.slice(-200)
      }
      ledgerChanged = true
      items.push({
        sessionId: p.sessionId,
        status: 'success',
        recycled: true,
        method: recycleOutcome.method,
        deletedSchedules: p.deletedScheduleCount,
        subagentCount: p.subDirs.length,
      })
    }

    if (ledgerChanged) saveLedger()
    if (succeededPlans.length > 0) {
      logger(`已将 ${succeededPlans.length} 个会话安全移入回收站 (${recycleOutcome.method})`)
    }

    return {
      ok: failed === 0,
      recycleMethod: recycleOutcome.method,
      movedPathsCount: (recycleOutcome.moved || []).length,
      summary: {
        total: ids.length,
        success: succeededPlans.length,
        skipped,
        failed,
      },
      items,
    }
  }

  function fileSizeSafeSync(filePath) {
    try {
      const st = fs.statSync(filePath)
      return st.isFile() ? st.size : 0
    } catch {
      return 0
    }
  }

  function computeDirBytesSync(dirPath) {
    let total = 0
    let entries = []
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = path.join(dirPath, ent.name)
      if (ent.isDirectory()) {
        total += computeDirBytesSync(full)
      } else if (ent.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {}
      }
    }
    return total
  }

  async function scanDiskSessionsInventory() {
    const byId = new Map()
    const subagentsByParent = new Map()
    let sessionsBytes = 0
    if (!fs.existsSync(sessionsRoot)) {
      return { sessionsBytes: 0, byId, subagentsByParent }
    }
    let projects = []
    try {
      projects = await fsp.readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return { sessionsBytes: 0, byId, subagentsByParent }
    }
    for (const proj of projects) {
      if (proj.isSymbolicLink()) continue
      const projPath = path.join(sessionsRoot, proj.name)
      if (!proj.isDirectory()) {
        sessionsBytes += fileSizeSafeSync(projPath)
        continue
      }
      let children = []
      try {
        children = await fsp.readdir(projPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (child.isSymbolicLink()) continue
        const sDir = path.join(projPath, child.name)
        if (!child.isDirectory()) {
          sessionsBytes += fileSizeSafeSync(sDir)
          continue
        }
        const dirBytes = computeDirBytesSync(sDir)
        sessionsBytes += dirBytes
        let matchedArtifact = null
        let parsedHeader = null
        let mtimeMs = 0
        for (const fname of ARTIFACT_FILENAMES) {
          const fpath = path.join(sDir, fname)
          if (!fs.existsSync(fpath)) continue
          try {
            const info = await readArtifactHeaderFast(fpath)
            if (info?.header?.id && typeof info.header.id === 'string' && info.header.id.startsWith('session-')) {
              matchedArtifact = fpath
              parsedHeader = info.header
              mtimeMs = info.mtimeMs || 0
            }
          } catch {}
          break
        }
        try {
          const dirStat = fs.statSync(sDir)
          if (dirStat.mtimeMs > mtimeMs) mtimeMs = dirStat.mtimeMs
        } catch {}
        const sid = parsedHeader?.id || (child.name.startsWith('session-') ? child.name : null)
        if (!sid) continue
        try {
          await assertContainedSessionDir(sessionsRoot, sDir, sid)
        } catch {
          continue
        }
        const rec = {
          sessionId: sid,
          dir: sDir,
          artifactPath: matchedArtifact,
          header: parsedHeader || { id: sid },
          mtimeMs,
          bytes: dirBytes,
        }
        byId.set(sid, rec)
        if (parsedHeader?.origin === 'subagent' && typeof parsedHeader.parentSession === 'string') {
          const arr = subagentsByParent.get(parsedHeader.parentSession) ?? []
          arr.push(rec)
          subagentsByParent.set(parsedHeader.parentSession, arr)
        }
      }
    }
    return { sessionsBytes, byId, subagentsByParent }
  }

  function collectDescendantsFromMap(rootId, subagentsByParent) {
    const visited = new Set([rootId])
    let frontier = [rootId]
    const out = []
    while (frontier.length > 0) {
      const next = []
      for (const pid of frontier) {
        for (const sub of subagentsByParent.get(pid) ?? []) {
          if (visited.has(sub.sessionId)) continue
          visited.add(sub.sessionId)
          out.push(sub)
          next.push(sub.sessionId)
        }
      }
      frontier = next
    }
    return out
  }

  /**
   * Zero-restart bulk cleanup of archived sessions + ghost workspace IDs + orphan `session_projcache` files.
   * Replaces offline stop-and-purge scripts with in-memory detachment and OS Recycle Bin safety.
   */
  async function purgeArchived({
    dryRun = false,
    activeGuardMinutes = 60,
    protectFavorites = true,
    cleanOrphanCache = true,
    pruneGhostIds = true,
    deleteSchedules = false,
    callerSessionId = '',
    nowMs = Date.now(),
  } = {}) {
    const guardMin = Math.max(
      0,
      Math.min(10080, Number.isFinite(Number(activeGuardMinutes)) ? Number(activeGuardMinutes) : 60)
    )
    const guardMs = guardMin * 60_000
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const sessionsSvc = serviceOf(ctx, 'sessions')
    const scheduleService = (typeof getScheduleService === 'function' ? getScheduleService() : null) ?? serviceOf(ctx, 'schedule')
    const botIds = readBotIds()

    const { sessionsBytes: sessionsBytesBefore, byId, subagentsByParent } = await scanDiskSessionsInventory()

    const liveIds = new Set()
    try {
      for (const s of sessionsSvc?.list?.() ?? []) {
        const lid = s?.id || s?.header?.id
        if (typeof lid === 'string' && lid.startsWith('session-')) liveIds.add(lid)
      }
    } catch {}
    const existsAnywhere = id => byId.has(id) || liveIds.has(id) || Boolean(sessionsSvc?.get?.(id))

    // 1) Preload active schedules map once
    const scheduleBySession = new Map()
    try {
      if (typeof scheduleService?.catalog === 'function') {
        const allScheds = await scheduleService.catalog()
        for (const rec of allScheds || []) {
          if (rec.status && rec.status !== 'active') continue
          const ownerSid = rec.target?.kind === 'session' ? rec.target.sessionId : rec.sessionId
          if (!ownerSid) continue
          const arr = scheduleBySession.get(ownerSid) ?? []
          arr.push(rec)
          scheduleBySession.set(ownerSid, arr)
        }
      }
    } catch {}

    // 2) Ghost IDs audit across workspaces, archivedSessionIds, pinnedSessionIds
    const ghostWsIds = []
    for (const ws of registry?.list?.() ?? []) {
      for (const sid of workspaceMemberIdsOf(ws)) {
        if (typeof sid === 'string' && sid.startsWith('session-') && !existsAnywhere(sid)) {
          ghostWsIds.push(sid)
        }
      }
    }
    const rawArchived = Array.isArray(registry?.archivedSessionIds) ? [...registry.archivedSessionIds] : []
    const rawPinned = Array.isArray(registry?.pinnedSessionIds) ? [...registry.pinnedSessionIds] : []
    const ghostArchIds = rawArchived.filter(sid => typeof sid === 'string' && sid.startsWith('session-') && !existsAnywhere(sid))
    const ghostPinIds = rawPinned.filter(sid => typeof sid === 'string' && sid.startsWith('session-') && !existsAnywhere(sid))
    const uniqueGhostIds = [...new Set([...ghostWsIds, ...ghostArchIds, ...ghostPinIds])]
      .filter(sid => sid !== callerSessionId && !botIds.has(sid))

    const ghostSummary = {
      workspaceSessionIds: ghostWsIds.length,
      archivedSessionIds: ghostArchIds.length,
      pinnedSessionIds: ghostPinIds.length,
      uniqueCount: uniqueGhostIds.length,
    }

    // 3) Evaluate existing archived sessions against safety guards
    const archivedExistingIds = [...new Set(rawArchived)]
      .filter(sid => typeof sid === 'string' && sid.startsWith('session-') && existsAnywhere(sid))
    const candidates = []
    const skippedItems = []
    const candidateAndSubSet = new Set()

    for (const id of archivedExistingIds) {
      const diskRec = byId.get(id)
      const subs = collectDescendantsFromMap(id, subagentsByParent)
      const subBytes = subs.reduce((acc, s) => acc + (s.bytes || 0), 0)
      const mainProjBytes = fileSizeSafeSync(path.join(projCacheDir, `${id}.json`))
      const subProjBytes = subs.reduce((acc, s) => acc + fileSizeSafeSync(path.join(projCacheDir, `${s.sessionId}.json`)), 0)
      const totalBytes = (diskRec?.bytes || 0) + subBytes + mainProjBytes + subProjBytes

      if (callerSessionId && id === callerSessionId) {
        skippedItems.push({ sessionId: id, code: 'self_session', reason: '当前执行命令的会话本身，自动跳过', bytes: totalBytes })
        continue
      }
      if (botIds.has(id)) {
        skippedItems.push({ sessionId: id, code: 'ds_bot', reason: 'ds-bot 托管会话受保护，自动跳过', bytes: totalBytes })
        continue
      }
      if (isSessionRunning(id)) {
        skippedItems.push({ sessionId: id, code: 'session_running', reason: '会话正在运行中，自动跳过', bytes: totalBytes })
        continue
      }
      if (guardMs > 0 && diskRec?.mtimeMs && (nowMs - diskRec.mtimeMs) < guardMs) {
        const ageMin = Math.max(0, Math.round((nowMs - diskRec.mtimeMs) / 60_000))
        skippedItems.push({
          sessionId: id,
          code: 'active_guard',
          reason: `${ageMin} 分钟前刚有写入（处于 ${guardMin} 分钟活跃保护窗内）`,
          bytes: totalBytes,
        })
        continue
      }
      const ann = getAnnotation(id)
      if (protectFavorites && (ann.favorite || ann.reviewLater)) {
        skippedItems.push({
          sessionId: id,
          code: 'protected_annotation',
          reason: ann.favorite ? '已标记 ⭐ 收藏保护跳过' : '已标记 📌 待回看保护跳过',
          bytes: totalBytes,
        })
        continue
      }
      const scheds = scheduleBySession.get(id) ?? (await listActiveSchedulesOf(id))
      if (scheds.length > 0 && !deleteSchedules) {
        skippedItems.push({
          sessionId: id,
          code: 'has_active_schedules',
          reason: `挂载 ${scheds.length} 条活跃定时任务（${scheds.map(s => s.title).join('、')}）`,
          bytes: totalBytes,
        })
        continue
      }

      const snap = await readAnySessionSnapshot(id, diskRec?.header)
      candidates.push({
        sessionId: id,
        title: snap.title || id,
        sessionBytes: (diskRec?.bytes || 0) + subBytes,
        totalBytes,
        subagentCount: subs.length,
        activeSchedules: scheds.length,
        mtimeMs: diskRec?.mtimeMs || 0,
      })
      candidateAndSubSet.add(id)
      for (const s of subs) candidateAndSubSet.add(s.sessionId)
    }

    // 4) Scan orphan `storages/session_projcache/sessions/<sid>.json`
    const orphanCacheEntries = []
    let orphanProjCacheBytes = 0
    if (fs.existsSync(projCacheDir)) {
      let realProjRoot = ''
      try { realProjRoot = fs.realpathSync(projCacheDir) } catch {}
      let files = []
      try { files = await fsp.readdir(projCacheDir, { withFileTypes: true }) } catch {}
      for (const f of files) {
        if (!f.isFile() || f.isSymbolicLink() || !f.name.endsWith('.json')) continue
        const sid = f.name.slice(0, -5)
        if (!sid.startsWith('session-')) continue
        if (existsAnywhere(sid) || candidateAndSubSet.has(sid) || sid === callerSessionId || botIds.has(sid)) continue
        const fullPath = path.join(projCacheDir, f.name)
        try {
          const rp = fs.realpathSync(fullPath)
          if (realProjRoot && !rp.startsWith(realProjRoot + path.sep)) continue
          const sz = fileSizeSafeSync(rp)
          orphanCacheEntries.push({ sessionId: sid, path: rp, bytes: sz })
          orphanProjCacheBytes += sz
        } catch {}
      }
    }

    const estimatedSessionFreedBytes = candidates.reduce((acc, c) => acc + (c.sessionBytes || 0), 0)
    const estimatedTotalFreedBytes = candidates.reduce((acc, c) => acc + (c.totalBytes || 0), 0)
      + (cleanOrphanCache ? orphanProjCacheBytes : 0)

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        zeroRestart: true,
        activeGuardMinutes: guardMin,
        protectFavorites: Boolean(protectFavorites),
        cleanOrphanCache: Boolean(cleanOrphanCache),
        pruneGhostIds: Boolean(pruneGhostIds),
        sessionsBytesBefore,
        estimatedSessionFreedBytes,
        estimatedTotalFreedBytes,
        archivedRegisteredCount: rawArchived.length,
        archivedExistingCount: archivedExistingIds.length,
        candidateCount: candidates.length,
        skippedCount: skippedItems.length,
        ghostSummary,
        orphanProjCacheCount: orphanCacheEntries.length,
        orphanProjCacheBytes,
        candidates: candidates.slice(0, 100),
        skippedItems: skippedItems.slice(0, 100),
      }
    }

    // 5) Live zero-restart execution
    let recycleResult = {
      ok: true,
      recycleMethod: 'noop',
      movedPathsCount: 0,
      summary: { total: 0, success: 0, skipped: 0, failed: 0 },
      items: [],
    }
    if (candidates.length > 0) {
      recycleResult = await recycleSessions({
        sessionIds: candidates.map(c => c.sessionId),
        callerSessionId,
        deleteSchedules,
        stopActivity: false,
      })
    }

    let prunedGhostCount = 0
    if (pruneGhostIds && uniqueGhostIds.length > 0) {
      const annMap = ensureAnnotationsMap()
      let annDirty = false
      for (const gid of uniqueGhostIds) {
        await teardownLiveSessionAndRegistry(gid)
        if (annMap[gid]) {
          delete annMap[gid]
          annDirty = true
        }
        prunedGhostCount += 1
      }
      if (annDirty) saveLedger()
    }

    let orphanCacheRecycledCount = 0
    let orphanRecycleMethod = 'noop'
    if (cleanOrphanCache && orphanCacheEntries.length > 0) {
      const orphanRes = await movePathsToRecycleBin(
        orphanCacheEntries.map(e => e.path),
        { fallbackTrashDir, recycleHandler }
      )
      orphanRecycleMethod = orphanRes.method
      orphanCacheRecycledCount = (orphanRes.moved || []).length
    }

    const sessionsBytesAfter = fs.existsSync(sessionsRoot) ? computeDirBytesSync(sessionsRoot) : 0
    const sessionsFreedBytes = Math.max(0, sessionsBytesBefore - sessionsBytesAfter)
    const effectiveMethod = recycleResult.recycleMethod !== 'noop'
      ? recycleResult.recycleMethod
      : orphanRecycleMethod

    if (recycleResult.summary.success > 0 || prunedGhostCount > 0 || orphanCacheRecycledCount > 0) {
      logger(
        `一键清理已归档完成（零重启）：归档会话 ${recycleResult.summary.success} 个、摘除幽灵 ID ${prunedGhostCount} 个、` +
        `孤儿缓存 ${orphanCacheRecycledCount} 个，sessions 释放 ${(sessionsFreedBytes / 1048576).toFixed(1)} MB (${effectiveMethod})`
      )
    }

    return {
      ok: recycleResult.ok,
      dryRun: false,
      zeroRestart: true,
      recycleMethod: effectiveMethod,
      activeGuardMinutes: guardMin,
      sessionsBytesBefore,
      sessionsBytesAfter,
      sessionsFreedBytes,
      orphanCacheRecycledCount,
      orphanCacheFreedBytes: cleanOrphanCache ? orphanProjCacheBytes : 0,
      prunedGhostCount,
      ghostSummary,
      summary: {
        archivedTotal: archivedExistingIds.length,
        recycledSessions: recycleResult.summary.success,
        skippedSessions: skippedItems.length + recycleResult.summary.skipped,
        failedSessions: recycleResult.summary.failed,
        prunedGhosts: prunedGhostCount,
        recycledOrphanCaches: orphanCacheRecycledCount,
      },
      items: recycleResult.items,
      skippedItems,
    }
  }

  return {
    getAnnotation,
    listCatalog,
    annotateSessions,
    renameSession,
    setPinSessions,
    setArchiveSessions,
    moveSessions,
    recycleSessions,
    purgeArchived,
  }
}
