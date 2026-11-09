/**
 * Real `@deepseek-ai/cordis` integration smoke test (modeled on `bili-compaction-guard/cordis.integration.mjs`).
 * Verifies: `ctx.plugin()` mount -> `ctx.inject(['tools','schedule','webServer'])` resolution ->
 * 3 `fleet_*` tools registered & callable -> `/health`, `/api` CSRF guard, `/events` SSE -> clean `fork.dispose()`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import plugin, { ROUTE_PATH } from '../lib/index.js'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ecology-cordis-'))
fs.writeFileSync(
  path.join(tmpHome, 'PROJECT.md'),
  [
    '# Demo Project',
    '## 1. 定位与权威入口',
    '- 入口说明',
    '## 2. 长期记忆与踩坑铁律',
    '- 铁律 1',
    '## 3. 进行中与待决事项',
    '- 暂无',
    '## 4. 最近完成索引',
    '- `2026-11-09`：初始化测试',
  ].join('\n'),
  'utf8'
)
const registeredTools = new Map()
const registeredGuards = []
const registeredPromptContexts = []
const routes = new Map()

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  for (const [prefix, route] of routes.entries()) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      await route.handler(req, res)
      return
    }
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const root = new Context()
root.provide('tools', {
  register(def) {
    registeredTools.set(def.name, def)
    return () => registeredTools.delete(def.name)
  },
  guard(fn) {
    registeredGuards.push(fn)
    return () => {
      const idx = registeredGuards.indexOf(fn)
      if (idx >= 0) registeredGuards.splice(idx, 1)
    }
  },
})
root.provide('systemPrompt', {
  context(def) {
    registeredPromptContexts.push(def)
    return () => {
      const idx = registeredPromptContexts.indexOf(def)
      if (idx >= 0) registeredPromptContexts.splice(idx, 1)
    }
  },
})
root.provide('schedule', {
  async catalog() { return [] },
  async list() { return [] },
})
root.provide('webServer', {
  origin: `http://127.0.0.1:${port}`,
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
})

let exitCode = 0
try {
  const fork = root.plugin(plugin, {
    dshHome: tmpHome,
    postBootSweepEnabled: false,
  })

  await new Promise(r => setTimeout(r, 80))

  // 1. All 4 `fleet_*` ecology & organizer tools registered cleanly
  assert.deepEqual(
    [...registeredTools.keys()].sort(),
    ['fleet_ecology_status', 'fleet_ecology_sweep', 'fleet_session_handover', 'fleet_session_organize']
  )
  console.log('PASS  1/8 4 fleet_* ecology & organizer tools registered')

  // 2. Execute `fleet_ecology_status` (with `include_project_memory`) & `fleet_session_organize` tools directly
  const statusOut = await registeredTools.get('fleet_ecology_status').execute({ include_project_memory: true }, {})
  assert.equal(statusOut.ok, true)
  assert.equal(typeof statusOut.summary.overThresholdCount, 'number')
  assert.equal(statusOut.projectMemory?.summary?.withProjectMdCount, 1)
  assert.equal(registeredGuards.length, 1, 'tools.guard must register PROJECT.md write guard')
  assert.equal(registeredPromptContexts.length, 1, 'systemPrompt.context must register pre-compaction reminder')
  // Verify the live guard blocks oversized PROJECT.md write and allows healthy write
  const blockMsg = registeredGuards[0]({
    name: 'write',
    arguments: {
      file_path: path.join(tmpHome, 'PROJECT.md'),
      content: `# Oversized\n${'x'.repeat(16000)}`,
    },
  })
  assert.match(String(blockMsg), /超出路线 C 硬上限/)
  const allowRes = registeredGuards[0]({
    name: 'write',
    arguments: {
      file_path: path.join(tmpHome, 'PROJECT.md'),
      content: '# Healthy\nshort text\n',
    },
  })
  assert.equal(allowRes, undefined)
  const orgOut = await registeredTools.get('fleet_session_organize').execute({ action: 'list' }, {})
  assert.equal(orgOut.ok, true)
  assert.ok(Array.isArray(orgOut.sessions))
  const purgeToolOut = await registeredTools.get('fleet_session_organize').execute({
    action: 'purge_archived',
    dry_run: true,
  }, {})
  assert.equal(purgeToolOut.ok, true)
  assert.equal(purgeToolOut.dryRun, true)
  assert.equal(purgeToolOut.zeroRestart, true)
  console.log('PASS  2/8 fleet_ecology_status, purge_archived tool, tools.guard & systemPrompt.context verified')

  // 3. HTTP `/health` (0.7.0), `/session`, `/catalog` & `/project-memory` work on loopback
  const healthRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/health`)
  assert.equal(healthRes.status, 200)
  const healthJson = await healthRes.json()
  assert.equal(healthJson.ok, true)
  assert.equal(healthJson.plugin, 'dsh-session-ecology')
  assert.equal(healthJson.version, '0.7.0')
  assert.equal(healthJson.showDockMeter, true)
  assert.equal(healthJson.projectMemoryGuardEnabled, true)
  const badSessRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/session?sessionId=bad`)
  assert.equal(badSessRes.status, 400)
  const sessRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/session?sessionId=session-test-0001`)
  assert.equal(sessRes.status, 200)
  const sessJson = await sessRes.json()
  assert.equal(sessJson.ok, true)
  assert.equal(sessJson.sessionId, 'session-test-0001')
  assert.equal(sessJson.settings.showDockMeter, true)
  assert.equal(typeof sessJson.evaluation?.maxGateProgress, 'number')
  const catRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/catalog`)
  assert.equal(catRes.status, 200)
  const catJson = await catRes.json()
  assert.equal(catJson.ok, true)
  const memRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/project-memory`)
  assert.equal(memRes.status, 200)
  const memJson = await memRes.json()
  assert.equal(memJson.ok, true)
  assert.equal(memJson.summary.withProjectMdCount, 1)
  assert.equal(memJson.projects[0].status, 'healthy')
  const purgeHttpRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ action: 'purgeArchived', dryRun: true }),
  })
  assert.equal(purgeHttpRes.status, 200)
  const purgeHttpJson = await purgeHttpRes.json()
  assert.equal(purgeHttpJson.ok, true)
  assert.equal(purgeHttpJson.dryRun, true)
  console.log('PASS  3/8 GET /dsh-session-ecology/health (0.5.0), /catalog, /project-memory & POST purgeArchived -> 200 ok:true')

  // 4. Cross-origin POST to `/api` is rejected with 403 CSRF guard
  const csrfRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ action: 'settings', enabled: false }),
  })
  assert.equal(csrfRes.status, 403)
  await csrfRes.text()
  console.log('PASS  4/7 Cross-origin POST /api blocked (403)')

  // 5. Same-origin POST to `/api` updates settings durably
  const setRes = await fetch(`http://127.0.0.1:${port}${ROUTE_PATH}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ action: 'settings', pressureRatio: 0.42 }),
  })
  assert.equal(setRes.status, 200)
  const setJson = await setRes.json()
  assert.equal(setJson.settings.pressureRatio, 0.42)
  console.log('PASS  5/7 Same-origin POST /api updates durable settings')

  // 6. SSE `/events` emits immediate hello frame
  const sseChunk = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${ROUTE_PATH}/events`, (res) => {
      res.setEncoding('utf8')
      res.once('data', (chunk) => {
        req.destroy()
        resolve(chunk)
      })
    })
    req.on('error', reject)
  })
  assert.match(sseChunk, /"type":"hello"/)
  console.log('PASS  6/7 GET /events SSE emits hello frame')

  // 7. Unloading plugin cleans up routes
  await fork.dispose?.()
  await new Promise(r => setTimeout(r, 60))
  assert.equal(routes.has(ROUTE_PATH), false)
  console.log('PASS  7/7 fork.dispose() unregisters routes cleanly')
} catch (error) {
  console.error('FAIL  cordis.integration:', error)
  exitCode = 1
} finally {
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(tmpHome, { recursive: true, force: true })
  process.exit(exitCode)
}
