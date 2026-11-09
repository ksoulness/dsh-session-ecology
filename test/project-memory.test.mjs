import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  judgeProjectMemoryWrite,
  createProjectMemoryGuard,
  createProjectRootFinder,
  buildProjectMemoryReminder,
  verbatimPromptText,
  analyzeProjectMdStructure,
  createProjectMemoryScanner,
} from '../lib/project-memory.js'

test('judgeProjectMemoryWrite enforces 15KB/250-line cap while allowing monotonic shrinking of oversized PROJECT.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-guard-'))
  try {
    const projPath = path.join(tmpDir, 'PROJECT.md')
    const backupDir = path.join(tmpDir, 'docs', 'project-backups')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(projPath, '# Project\nInitial healthy content\n', 'utf8')

    // 1. Read calls and non-PROJECT.md files are never gated
    assert.equal(
      judgeProjectMemoryWrite({ name: 'read', arguments: { file_path: projPath } }),
      undefined
    )
    assert.equal(
      judgeProjectMemoryWrite({
        name: 'write',
        arguments: { file_path: path.join(tmpDir, 'docs', 'HISTORY.md'), content: 'x'.repeat(40_000) },
      }),
      undefined
    )
    // Cold backup path under `docs/project-backups/PROJECT.md` is exempted
    assert.equal(
      judgeProjectMemoryWrite({
        name: 'write',
        arguments: { file_path: path.join(backupDir, 'PROJECT.md'), content: 'x'.repeat(30_000) },
      }),
      undefined
    )

    // 2. Healthy write & edit pass
    assert.equal(
      judgeProjectMemoryWrite({
        name: 'write',
        arguments: { file_path: 'PROJECT.md', content: '# Project\nUpdated short content\n' },
      }, { resolveSessionCwd: () => tmpDir }),
      undefined
    )

    // 3. Write exceeding 15,360 B is denied with actionable instructions
    const overBytesReason = judgeProjectMemoryWrite({
      name: 'write',
      arguments: { file_path: projPath, content: `# Huge\n${'a'.repeat(16_000)}` },
    })
    assert.match(String(overBytesReason), /超出路线 C 硬上限/)
    assert.match(String(overBytesReason), /docs\/HISTORY\.md/)

    // 4. Write exceeding 250 lines (even if < 15KB) is denied
    const manyShortLines = Array.from({ length: 260 }, (_, i) => `- item ${i}`).join('\n')
    const overLinesReason = judgeProjectMemoryWrite({
      name: 'str_replace_editor',
      arguments: { command: 'create', path: projPath, file_text: manyShortLines },
    })
    assert.match(String(overLinesReason), /预计 260 行 > 250 行/)

    // 5. Partial `edit` that pushes a healthy file over 250 lines is denied
    fs.writeFileSync(projPath, Array.from({ length: 245 }, (_, i) => `line-${i}`).join('\n'), 'utf8')
    const editOverReason = judgeProjectMemoryWrite({
      name: 'edit',
      arguments: {
        file_path: projPath,
        old_string: 'line-244',
        new_string: Array.from({ length: 12 }, (_, i) => `added-${i}`).join('\n'),
      },
    })
    assert.match(String(editOverReason), /预计 256 行 > 250 行/)

    // 6. Monotonic pass-through: if PROJECT.md is ALREADY oversized (e.g. 22 KB), shrinking it to 18 KB is ALLOWED!
    fs.writeFileSync(projPath, `# Legacy Oversized\n${'z'.repeat(22_000)}\nTAIL_MARKER\n`, 'utf8')
    const shrinkEditResult = judgeProjectMemoryWrite({
      name: 'edit',
      arguments: {
        file_path: projPath,
        old_string: 'z'.repeat(4_000),
        new_string: 'compressed summary',
      },
    })
    assert.equal(shrinkEditResult, undefined, 'Shrinking an oversized PROJECT.md must pass without deadlock')

    // Growing an already-oversized PROJECT.md is still DENIED
    const growOversizedResult = judgeProjectMemoryWrite({
      name: 'edit',
      arguments: {
        file_path: projPath,
        old_string: 'TAIL_MARKER',
        new_string: `TAIL_MARKER\n${'more'.repeat(200)}`,
      },
    })
    assert.match(String(growOversizedResult), /拒绝写入/)

    // 7. `createProjectMemoryGuard` respects `projectMemoryGuardEnabled: false` and fails open on errors
    const disabledGuard = createProjectMemoryGuard({
      getConfig: () => ({ enabled: true, projectMemoryGuardEnabled: false }),
      resolveSessionCwd: () => tmpDir,
    })
    assert.equal(
      disabledGuard({ name: 'write', arguments: { file_path: projPath, content: 'x'.repeat(30_000) } }),
      undefined
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('buildProjectMemoryReminder triggers only for interactive high-water project sessions and escapes {{', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-remind-'))
  try {
    const subDir = path.join(tmpDir, 'packages', 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), '# Root Project\n', 'utf8')

    const findRoot = createProjectRootFinder({ ttlMs: 5000 })
    const located = findRoot(subDir)
    assert.ok(located, 'Must find upward PROJECT.md without .git')
    assert.equal(located.projectRoot, tmpDir)

    const baseOpts = {
      projectInfo: located,
      windowTokens: 200_000,
      surfaceThreshold: 200_000,
      maxBytes: 15_360,
      maxLines: 250,
    }

    // Below watermark -> silent
    assert.equal(
      buildProjectMemoryReminder({
        snapshot: {
          cwd: subDir,
          contextPressure: { contextWindow: 200_000, pressureTokens: 20_000, surfaceTokens: 50_000 },
        },
        findProjectMd: findRoot,
      }),
      ''
    )

    // Above watermark -> active reminder
    const activeMsg = buildProjectMemoryReminder({
      snapshot: {
        cwd: subDir,
        contextPressure: { contextWindow: 200_000, pressureTokens: 56_000, surfaceTokens: 80_000 },
      },
      findProjectMd: findRoot,
    })
    assert.match(activeMsg, /PROJECT\.md/)
    assert.match(activeMsg, /docs\/HISTORY\.md/)

    // Scheduled / ineligible (subagent / bot) / inFlight sessions -> strictly silent even at 38% pressure!
    const highSnap = {
      cwd: subDir,
      contextPressure: { contextWindow: 200_000, pressureTokens: 76_000, surfaceTokens: 90_000 },
    }
    assert.equal(
      buildProjectMemoryReminder({ snapshot: highSnap, findProjectMd: findRoot, hasActiveSchedule: true }),
      ''
    )
    assert.equal(
      buildProjectMemoryReminder({ snapshot: highSnap, findProjectMd: findRoot, isEligible: false }),
      ''
    )
    assert.equal(
      buildProjectMemoryReminder({ snapshot: highSnap, findProjectMd: findRoot, inFlight: true }),
      ''
    )

    assert.equal(verbatimPromptText('path/{{template}}/PROJECT.md'), 'path/{\u200b{template}}/PROJECT.md')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createProjectMemoryScanner inspects non-git workspaces, merges duplicate roots, and catches broken local links', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-scan-home-'))
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-a-'))
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-b-'))

  try {
    // Project A: healthy 4-section PROJECT.md + HISTORY.md + .dsh/rules + valid local link
    fs.mkdirSync(path.join(projA, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(projA, '.dsh', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(projA, 'docs', 'HISTORY.md'), '# Cold History\n', 'utf8')
    fs.writeFileSync(path.join(projA, '.dsh', 'rules', '00-project-entry.md'), '# Rule\n', 'utf8')
    fs.writeFileSync(
      path.join(projA, 'PROJECT.md'),
      [
        '# Project A',
        '## 1. 定位与权威入口',
        '- 详见 [HISTORY.md](docs/HISTORY.md) 与 [External](https://example.com/doc)',
        '## 2. 长期记忆与踩坑铁律',
        '- 铁律 A',
        '## 3. 进行中与待决事项',
        '- 暂无',
        '## 4. 最近完成索引',
        '- `2026-11-09`：完成初始化',
      ].join('\n'),
      'utf8'
    )

    // Project B: broken relative link -> must be flagged `over`
    fs.writeFileSync(
      path.join(projB, 'PROJECT.md'),
      [
        '# Project B',
        '## 1. 定位与权威入口',
        '- 失效引用 [missing](docs/non-existent-plan.md)',
        '## 2. 长期记忆与踩坑铁律',
        '## 3. 进行中与待决事项',
        '## 4. 最近完成索引',
      ].join('\n'),
      'utf8'
    )

    const structA = analyzeProjectMdStructure(fs.readFileSync(path.join(projA, 'PROJECT.md'), 'utf8'))
    assert.equal(structA.hasFourSections, true)
    assert.equal(structA.completedItemCount, 1)

    const scan = createProjectMemoryScanner({
      dshHome: tmpHome,
      getConfig: () => ({
        enabled: true,
        projectMemoryGuardEnabled: true,
        projectMemoryReminderEnabled: true,
        projectMemoryMaxBytes: 15_360,
        projectMemoryMaxLines: 250,
      }),
      getWorkspaceRegistry: () => ({
        list: () => [
          { id: 'ws-a1', path: projA, title: '主工程 A' },
          { id: 'ws-a2', path: projA, title: '主工程 A 别名' }, // duplicate root -> merged!
          { id: 'ws-b', path: projB, title: '工程 B' },
        ],
      }),
    })

    const report = await scan()
    assert.equal(report.ok, true)
    assert.equal(report.summary.withProjectMdCount, 2)
    assert.equal(report.summary.healthyCount, 1)
    assert.equal(report.summary.overCount, 1)
    assert.equal(report.summary.totalBrokenLinks, 1)

    const rowB = report.projects.find(p => p.title === '工程 B')
    assert.equal(rowB.status, 'over')
    assert.deepEqual(rowB.brokenLinks, ['docs/non-existent-plan.md'])

    const rowA = report.projects.find(p => p.title === '主工程 A')
    assert.equal(rowA.status, 'healthy')
    assert.equal(rowA.hasHistoryMd, true)
    assert.equal(rowA.dshRulesCount, 1)
    assert.deepEqual(rowA.workspaceTitles, ['主工程 A', '主工程 A 别名'])
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projA, { recursive: true, force: true })
    fs.rmSync(projB, { recursive: true, force: true })
  }
})
