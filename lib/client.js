/**
 * dsh-session-ecology — Web Client Companion, Session Organizer, Project Memory Panel & Settings UI (0.5.1, zero build step).
 *
 * Responsibilities:
 * 1) Listens to Host SSE `/dsh-session-ecology/events` (pausing when hidden, catching up on wake):
 *    - Actively viewing `oldSessionId` (`retainedBy.mainView > 0`): preserves unsent composer draft,
 *      waits for `newSessionId` in `sessions.list`, opens `newSessionId`, restores draft, shows toast.
 *    - Viewing another session: non-blocking compact toast with 1-tap jump, never hijacks focus.
 *    - Deduplicates `(oldSessionId -> newSessionId)` in `localStorage` so revisiting archived chats never bounces.
 * 2) Registers `settings.section` (`id: "session-ecology"`, `order: 92`, label `"会话生态 / 会话管理"`):
 *    - Lazy-rendered 4-tab control center (0 polling & 0 extra chat-header clutter when Settings is closed):
 *      - Tab 1 (`ecology`): Switches (incl. `PROJECT.md` guard & pre-compaction reminder), 3-gate adaptive thresholds, live session watermarks.
 *      - Tab 2 (`organize`): Full Session & Workspace Organizer (search, multi-filter, ⭐ favorite, 📌 review-later,
 *        P1..P5 priority, #tags, notes, rename, pin, orphan-schedule-safe archive/unarchive, zero-restart workspace move,
 *        zero-restart recoverable Windows System Recycle Bin single/batch delete, and one-shot archived/ghost/orphan purge).
 *      - Tab 3 (`history`): Durable rollover & archival history ledger + inline Markdown handoff viewer.
 *      - Tab 4 (`memory`): Read-only workspace `PROJECT.md` health panel (15KB / 250-line dual progress bars,
 *        4-section structure check, `docs/HISTORY.md` status, broken local link check, `dsh-deja` cold-recall badge,
 *        and 1-click copyable slimming instruction).
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-ecology',
  factory: (require) => {
    'use strict'

    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const NAME = 'dsh-session-ecology'
    const ROUTE_BASE = '/dsh-session-ecology'
    const OPENED_PREFIX = 'dsh-session-ecology:opened:'
    const WAIT_ATTEMPTS = 16
    const WAIT_STEP_MS = 400
    const CSS_ID = 'dsh-session-ecology/style-050'

    const DEFAULT_SETTINGS = {
      enabled: true,
      autoHandover: true,
      postBootSweepEnabled: true,
      archiveOldSession: true,
      notifyFeishu: true,
      projectMemoryGuardEnabled: true,
      projectMemoryReminderEnabled: true,
      pressureRatio: 0.40,
      surfaceRatio: 1.00,
      standardFatigueMultiplier: 350,
      proFatigueMultiplier: 150,
      warnRatio: 0.75,
      projectMemoryMaxBytes: 15360,
      projectMemoryMaxLines: 250,
    }

    const PRIORITY_META = {
      1: { label: 'P1 最高', short: 'P1', tone: 'danger' },
      2: { label: 'P2 高', short: 'P2', tone: 'warn' },
      3: { label: 'P3 普通', short: 'P3', tone: 'neutral' },
      4: { label: 'P4 低', short: 'P4', tone: 'muted' },
      5: { label: 'P5 最低', short: 'P5', tone: 'muted' },
    }

    const CSS_TEXT = [
      '.sec-page{display:flex;flex-direction:column;gap:14px;max-width:820px;padding:2px 0 24px;color:var(--dsw-alias-label-primary,#222);font-size:13px;line-height:1.5;}',
      '.sec-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.sec-head-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;}',
      '.sec-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999);flex:none;}',
      '.sec-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary,#12a150);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#12a150) 18%,transparent);}',
      '.sec-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);}',
      '.sec-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sec-tabs{display:flex;align-items:center;gap:6px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f2f4f7);border:1px solid var(--dsw-alias-border-l2,#e3e5e8);flex-wrap:wrap;}',
      '.sec-tab{height:30px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}',
      '.sec-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
      '.sec-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}',
      '.sec-kpi{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-line-divider,#e3e5e8));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:2px;}',
      '.sec-kpi-label{font-size:11px;color:var(--dsw-alias-label-secondary,#777);}',
      '.sec-kpi-val{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.25;}',
      '.sec-kpi-val[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#d9822b);}',
      '.sec-kpi-val[data-tone="danger"]{color:var(--dsw-alias-state-error-primary,#d64545);}',
      '.sec-kpi-val[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#12a150);}',
      '.sec-card{padding:14px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-line-divider,#e3e5e8));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:10px;}',
      '.sec-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      '.sec-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#222);}',
      '.sec-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#777);}',
      '.sec-divider{height:1px;background:var(--dsw-alias-border-l2,var(--dsw-alias-line-divider,#eceef1));margin:2px 0;}',
      '.sec-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;}',
      '.sec-toggle-copy{min-width:0;flex:1;}',
      '.sec-toggle-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#222);}',
      '.sec-toggle-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#777);margin-top:1px;}',
      '.sec-switch{flex:none;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#777);font:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:3px 2px;}',
      '.sec-switch:disabled{opacity:.5;cursor:default;}',
      '.sec-switch::before{content:"";width:28px;height:16px;border-radius:99px;background:var(--dsw-alias-border-l2,#c8ccd4);box-shadow:inset -12px 0 0 -2px var(--dsw-alias-bg-layer-1,#fff);transition:background .16s,box-shadow .16s;}',
      '.sec-switch[data-on="true"]{color:var(--dsw-alias-state-success-primary,#12a150);}',
      '.sec-switch[data-on="true"]::before{background:var(--dsw-alias-state-success-primary,#12a150);box-shadow:inset 12px 0 0 -2px var(--dsw-alias-bg-layer-1,#fff);}',
      '.sec-grid-row{display:grid;grid-template-columns:minmax(0,1.4fr) auto minmax(0,1fr);align-items:center;gap:10px;padding:5px 0;}',
      '.sec-num-wrap{display:inline-flex;align-items:center;gap:5px;}',
      '.sec-num{width:76px;height:30px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#d0d4dc);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;text-align:right;}',
      '.sec-input,.sec-select{height:30px;box-sizing:border-box;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#d0d4dc);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;}',
      '.sec-textarea{width:100%;min-height:58px;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#d0d4dc);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;resize:vertical;}',
      '.sec-unit{font-size:12px;color:var(--dsw-alias-label-secondary,#777);min-width:22px;}',
      '.sec-preview{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;text-align:right;}',
      '.sec-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px;}',
      '.sec-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#d0d4dc);border-radius:7px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}',
      '.sec-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f2f5);}',
      '.sec-btn:disabled{opacity:.5;cursor:default;}',
      '.sec-btn-sm{height:24px;padding:0 8px;font-size:11px;border-radius:6px;}',
      '.sec-btn-primary{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 12%,transparent);color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:600;}',
      '.sec-btn-warn{border-color:var(--dsw-alias-state-warn-primary,#d9822b);color:var(--dsw-alias-state-warn-primary,#d9822b);font-weight:600;}',
      '.sec-btn-danger{border-color:var(--dsw-alias-state-error-primary,#d64545);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent);color:var(--dsw-alias-state-error-primary,#d64545);font-weight:600;}',
      '.sec-icon-btn{border:0;background:transparent;padding:2px 4px;cursor:pointer;font-size:13px;line-height:1;opacity:.45;transition:opacity .15s,transform .15s;}',
      '.sec-icon-btn:hover{opacity:.85;}',
      '.sec-icon-btn[data-active="true"]{opacity:1;transform:scale(1.06);}',
      '.sec-pill{height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#d8dce3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}',
      '.sec-pill[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 13%,transparent);color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:600;}',
      '.sec-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:11px;line-height:17px;background:var(--dsw-alias-bg-layer-2,#f0f2f5);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap;}',
      '.sec-badge[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#12a150) 13%,transparent);color:var(--dsw-alias-state-success-primary,#12a150);}',
      '.sec-badge[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9822b) 15%,transparent);color:var(--dsw-alias-state-warn-primary,#d9822b);}',
      '.sec-badge[data-tone="danger"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 14%,transparent);color:var(--dsw-alias-state-error-primary,#d64545);}',
      '.sec-badge[data-tone="brand"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 13%,transparent);color:var(--dsw-alias-brand-primary,#3b82f6);}',
      '.sec-badge[data-tone="muted"]{opacity:.7;}',
      '.sec-filter-grid{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sec-batch-bar{padding:10px 12px;border-radius:9px;border:1px dashed var(--dsw-alias-brand-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 6%,var(--dsw-alias-bg-layer-1,#fff));display:flex;flex-direction:column;gap:8px;}',
      '.sec-danger-box{padding:10px 12px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary,#d64545);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 7%,var(--dsw-alias-bg-layer-1,#fff));display:flex;flex-direction:column;gap:8px;}',
      '.sec-list{display:flex;flex-direction:column;gap:7px;}',
      '.sec-item{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-line-divider,#e5e7eb));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04));display:flex;flex-direction:column;gap:6px;}',
      '.sec-item[data-selected="true"]{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 5%,transparent);}',
      '.sec-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      '.sec-item-left{display:flex;align-items:center;gap:5px;min-width:0;flex:1;}',
      '.sec-item-title{font-size:13px;font-weight:600;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;}',
      '.sec-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}',
      '.sec-drawer{margin-top:4px;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#dfe2e8);background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:8px;}',
      '.sec-drawer-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sec-drawer-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);min-width:52px;}',
      '.sec-meter{height:5px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));}',
      '.sec-meter>span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary,#12a150);transition:width .2s ease;}',
      '.sec-meter[data-tone="warn"]>span{background:var(--dsw-alias-state-warn-primary,#d9822b);}',
      '.sec-meter[data-tone="danger"]>span{background:var(--dsw-alias-state-error-primary,#d64545);}',
      '.sec-detail{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#666);word-break:break-word;}',
      '.sec-pre{margin:4px 0 0;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;line-height:1.55;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
      '.sec-banner{font-size:12px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f4f7);color:var(--dsw-alias-label-primary,#222);}',
      '.sec-banner[data-ok="true"]{color:var(--dsw-alias-state-success-primary,#12a150);}',
      '.sec-banner[data-ok="false"]{color:var(--dsw-alias-state-error-primary,#d64545);}',
      '.sec-mem-bars{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}',
      '.sec-mem-bar{display:flex;flex-direction:column;gap:3px;}',
      '.sec-mem-bar-label{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums;}',
      '@media (max-width:680px){.sec-kpis{grid-template-columns:repeat(2,minmax(0,1fr));}.sec-mem-bars{grid-template-columns:1fr;}.sec-grid-row{grid-template-columns:1fr auto;}.sec-preview{grid-column:1 / -1;text-align:left;margin-top:-4px;}.sec-item-title{white-space:normal;}}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NAME
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    function compactTok(n) {
      const v = Math.max(0, Number(n) || 0)
      if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
      if (v >= 1e3) return `${Math.round(v / 1e3)}K`
      return String(Math.round(v))
    }

    function formatRatioPreview(pct) {
      const r = (Number(pct) || 0) / 100
      return `1M窗=${compactTok(1_000_000 * r)} ｜ 200K窗=${compactTok(200_000 * r)}`
    }

    function formatMultPreview(mult) {
      const m = Number(mult) || 0
      return `1M窗=${compactTok(1_000_000 * m)} ｜ 200K窗=${compactTok(200_000 * m)}`
    }

    function formatRelativeTime(ms) {
      const t = Number(ms) || 0
      if (!t) return ''
      const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
      if (diffSec < 60) return '刚刚'
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分前`
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`
      return `${Math.floor(diffSec / 86400)}天前`
    }

    function settingsToForm(s) {
      const cfg = { ...DEFAULT_SETTINGS, ...(s || {}) }
      return {
        pressurePct: String(Math.round((Number(cfg.pressureRatio) || 0.4) * 100)),
        surfacePct: String(Math.round((Number(cfg.surfaceRatio) || 1.0) * 100)),
        standardMult: String(Math.round(Number(cfg.standardFatigueMultiplier) || 350)),
        proMult: String(Math.round(Number(cfg.proFatigueMultiplier) || 150)),
        warnPct: String(Math.round((Number(cfg.warnRatio) || 0.75) * 100)),
        projectMemoryMaxBytes: String(Math.round(Number(cfg.projectMemoryMaxBytes) || 15360)),
        projectMemoryMaxLines: String(Math.round(Number(cfg.projectMemoryMaxLines) || 250)),
      }
    }

    function sanitizeDraftSettings(form) {
      const clamp = (v, min, max, fallback) => {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return fallback
        return Math.min(max, Math.max(min, n))
      }
      const out = {
        pressureRatio: Number((clamp(form?.pressurePct, 10, 95, 40) / 100).toFixed(4)),
        surfaceRatio: Number((clamp(form?.surfacePct, 30, 500, 100) / 100).toFixed(4)),
        standardFatigueMultiplier: Math.round(clamp(form?.standardMult, 10, 5000, 350)),
        proFatigueMultiplier: Math.round(clamp(form?.proMult, 10, 5000, 150)),
        warnRatio: Number((clamp(form?.warnPct, 30, 98, 75) / 100).toFixed(4)),
      }
      if (form?.projectMemoryMaxBytes !== undefined && form.projectMemoryMaxBytes !== '') {
        out.projectMemoryMaxBytes = Math.round(clamp(form.projectMemoryMaxBytes, 4096, 65536, 15360))
      }
      if (form?.projectMemoryMaxLines !== undefined && form.projectMemoryMaxLines !== '') {
        out.projectMemoryMaxLines = Math.round(clamp(form.projectMemoryMaxLines, 50, 1000, 250))
      }
      return out
    }

    function filterProjectMemories(rows, { mode = 'with_project', search = '' } = {}) {
      const list = Array.isArray(rows) ? rows : []
      const q = String(search || '').trim().toLowerCase()
      return list.filter((item) => {
        if (mode === 'with_project' && !item.hasProjectMd) return false
        if (mode === 'issues' && (!item.hasProjectMd || item.status === 'healthy')) return false
        if (q) {
          const hay = [
            item.title,
            item.projectRoot,
            ...(item.workspaceTitles || []),
            ...(item.brokenLinks || []),
          ].join('\n').toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
    }

    async function copyTextToClipboard(text) {
      const str = String(text || '')
      if (!str) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(str)
          return true
        }
      } catch {}
      if (typeof document === 'undefined') return false
      try {
        const ta = document.createElement('textarea')
        ta.value = str
        ta.setAttribute('readonly', 'true')
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return Boolean(ok)
      } catch {
        return false
      }
    }

    function triggerLabel(trigger) {
      const t = String(trigger || '')
      if (t === 'post-boot-sweep') return '启动清扫'
      if (t === 'auto') return '忙完自触发'
      if (t === 'panel' || t === 'http') return '面板手动'
      if (t === 'panel-sweep' || t === 'http-sweep' || t === 'tool-sweep') return '批量清扫'
      if (t === 'tool') return '技能调用'
      return t || '自动'
    }

    /**
     * Pure client-side instant filter & sorter over `/catalog` rows.
     */
    function filterAndSortCatalog(rows, filters = {}) {
      const list = Array.isArray(rows) ? rows : []
      const archiveFilter = filters.archiveFilter || 'active'
      const workspaceId = filters.workspaceId || 'all'
      const priority = filters.priority && filters.priority !== 'all' ? Number(filters.priority) : null
      const tag = String(filters.tag || '').trim().toLowerCase()
      const search = String(filters.search || '').trim().toLowerCase()
      const favoriteOnly = Boolean(filters.favoriteOnly)
      const reviewOnly = Boolean(filters.reviewOnly)
      const scheduledOnly = Boolean(filters.scheduledOnly)
      const overOnly = Boolean(filters.overOnly)
      const sortBy = filters.sortBy || 'updated_desc'

      const out = list.filter((r) => {
        const ann = r.annotation || { favorite: false, reviewLater: false, priority: 3, tags: [], note: '' }
        if (archiveFilter === 'active' && r.archived) return false
        if (archiveFilter === 'archived' && !r.archived) return false
        if (workspaceId === 'ungrouped' && r.workspaceId !== null) return false
        if (workspaceId !== 'all' && workspaceId !== 'ungrouped' && r.workspaceId !== workspaceId) return false
        if (favoriteOnly && !ann.favorite) return false
        if (reviewOnly && !ann.reviewLater) return false
        if (scheduledOnly && !(r.activeSchedules > 0)) return false
        if (overOnly && r.status === 'healthy') return false
        if (priority !== null && ann.priority !== priority) return false
        if (tag && !(ann.tags || []).some(t => String(t).toLowerCase() === tag)) return false
        if (search) {
          const hay = [
            r.title,
            r.sessionId,
            r.workspaceTitle,
            ann.note || '',
            ...(ann.tags || []),
          ].join('\n').toLowerCase()
          if (!hay.includes(search)) return false
        }
        return true
      })

      out.sort((a, b) => {
        const pa = a.annotation?.priority ?? 3
        const pb = b.annotation?.priority ?? 3
        if (sortBy === 'priority_asc') {
          if (pa !== pb) return pa - pb
          return (b.updatedAt || 0) - (a.updatedAt || 0)
        }
        if (sortBy === 'ecology_desc') {
          if ((b.maxGateProgress || 0) !== (a.maxGateProgress || 0)) {
            return (b.maxGateProgress || 0) - (a.maxGateProgress || 0)
          }
          return (b.updatedAt || 0) - (a.updatedAt || 0)
        }
        if (sortBy === 'title_asc') {
          return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
        }
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      })
      return out
    }

    function formatBatchResultBanner(prefix, res) {
      const s = res?.summary || {}
      const skippedReasons = (res?.items || [])
        .filter(i => i.status === 'skipped' || i.status === 'failed')
        .slice(0, 3)
        .map(i => `${i.sessionId?.slice(8, 14) || ''}:${i.reason || i.error || i.status}`)
      const tail = skippedReasons.length > 0 ? `（${skippedReasons.join('；')}）` : ''
      return {
        ok: (s.failed || 0) === 0,
        text: `${prefix}：成功 ${s.success ?? 0} · 跳过 ${s.skipped ?? 0} · 失败 ${s.failed ?? 0}${tail}`,
      }
    }

    function formatMb(bytes) {
      return ((Number(bytes) || 0) / 1048576).toFixed(1)
    }

    function formatPurgeArchivedBanner(res) {
      const s = res?.summary || {}
      const rec = s.recycledSessions ?? 0
      const ghosts = s.prunedGhosts ?? res?.prunedGhostCount ?? 0
      const orphans = s.recycledOrphanCaches ?? res?.orphanCacheRecycledCount ?? 0
      const skipped = s.skippedSessions ?? 0
      const failed = s.failedSessions ?? 0
      const beforeMb = formatMb(res?.sessionsBytesBefore)
      const afterMb = formatMb(res?.sessionsBytesAfter)
      const freedMb = formatMb(res?.sessionsFreedBytes)
      const skipHint = skipped > 0 ? ` · 保护跳过 ${skipped}` : ''
      const failHint = failed > 0 ? ` · 失败 ${failed}` : ''
      return {
        ok: failed === 0 && res?.ok !== false,
        text: `已清理 ${rec} 个归档会话 · 摘除 ${ghosts} 个幽灵 ID · 回收 ${orphans} 个孤儿缓存${skipHint}${failHint} ｜ sessions/ ${beforeMb} MB → ${afterMb} MB（释放 ${freedMb} MB，零重启已进系统回收站）`,
      }
    }

    function hasAlreadyOpened(oldId, newId) {
      const key = `${OPENED_PREFIX}${oldId}->${newId}`
      try {
        if (window.localStorage.getItem(key) === '1') return true
        window.localStorage.setItem(key, '1')
        return false
      } catch {
        return false
      }
    }

    function isViewingSession(sessionsSvc, sessionId) {
      if (!sessionsSvc || !sessionId) return false
      try {
        const cell = typeof sessionsSvc.retainInfo === 'function'
          ? sessionsSvc.retainInfo(sessionId)
          : undefined
        const snap = typeof cell?.getSnapshot === 'function' ? cell.getSnapshot() : undefined
        return (Number(snap?.retainedBy?.mainView) || 0) > 0
      } catch {
        return false
      }
    }

    function readComposerDraft() {
      if (typeof document === 'undefined') return ''
      try {
        const areas = document.querySelectorAll('textarea')
        for (const el of areas) {
          if (!el.disabled && !el.readOnly && typeof el.value === 'string' && el.value.trim() !== '') {
            return el.value
          }
        }
      } catch {}
      return ''
    }

    function restoreComposerDraft(draft) {
      if (!draft || typeof document === 'undefined') return
      let tries = 0
      const attempt = () => {
        tries += 1
        try {
          const areas = document.querySelectorAll('textarea')
          for (const el of areas) {
            if (!el.disabled && !el.readOnly) {
              if (el.value && el.value.trim() !== '') return
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                'value'
              )?.set
              if (setter) setter.call(el, draft)
              else el.value = draft
              el.dispatchEvent(new Event('input', { bubbles: true }))
              return
            }
          }
        } catch {}
        if (tries < 10) setTimeout(attempt, 250)
      }
      setTimeout(attempt, 220)
    }

    function waitForCatalogEntry(sessionsSvc, targetId) {
      return new Promise((resolve) => {
        let count = 0
        const check = () => {
          count += 1
          try {
            const snap = sessionsSvc?.list?.getSnapshot?.()
            if (snap?.byId?.[targetId]) {
              resolve(true)
              return
            }
          } catch {}
          if (count >= WAIT_ATTEMPTS) {
            resolve(false)
            return
          }
          setTimeout(check, WAIT_STEP_MS)
        }
        check()
      })
    }

    function showEcologyToast({ title, detail, onOpen, durationMs = 5200 }) {
      if (typeof document === 'undefined') return
      try {
        const id = 'dsh-session-ecology-toast'
        let el = document.getElementById(id)
        if (!el) {
          el = document.createElement('div')
          el.id = id
          el.setAttribute('role', 'status')
          el.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:16px',
            'z-index:2147483001',
            'max-width:min(380px, calc(100vw - 24px))',
            'box-sizing:border-box',
            'padding:8px 12px',
            'border-radius:10px',
            'font-size:12px',
            'line-height:1.45',
            'background:var(--dsw-alias-bg-layer-1, rgba(19,22,29,.95))',
            'color:var(--dsw-alias-label-primary, #e6edf7)',
            'border:1px solid var(--dsw-alias-border-l2, #2d3548)',
            'box-shadow:0 6px 20px rgba(0,0,0,.32)',
            'opacity:0',
            'transform:translateY(6px)',
            'transition:opacity .18s ease, transform .18s ease',
            'cursor:pointer',
          ].join(';')
          document.body.appendChild(el)
        }

        el.title = detail || title
        el.innerHTML = ''

        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;'

        const main = document.createElement('span')
        main.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;'
        main.textContent = title
        row.appendChild(main)

        if (typeof onOpen === 'function') {
          const action = document.createElement('span')
          action.style.cssText = 'flex:none;font-weight:600;color:var(--dsw-alias-brand-primary, #4d8eff);'
          action.textContent = '查看'
          row.appendChild(action)
        }
        el.appendChild(row)

        if (detail) {
          const sub = document.createElement('div')
          sub.style.cssText = 'display:none;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary, #9aa6bf);word-break:break-word;'
          sub.textContent = detail
          el.appendChild(sub)
          el.__sub = sub
        }

        el.onclick = () => {
          if (typeof onOpen === 'function') {
            onOpen()
            el.style.opacity = '0'
            return
          }
          if (el.__sub) {
            el.__sub.style.display = el.__sub.style.display === 'none' ? 'block' : 'none'
          }
        }

        el.style.opacity = '1'
        el.style.transform = 'translateY(0)'
        clearTimeout(el.__hideTimer)
        el.__hideTimer = setTimeout(() => {
          el.style.opacity = '0'
          el.style.transform = 'translateY(6px)'
        }, durationMs)
      } catch {}
    }

    async function apiPost(body) {
      const res = await window.fetch(`${ROUTE_BASE}/api`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok && !json.error) json.error = `HTTP ${res.status}`
      return json
    }

    function createSettingsSection({ openSession, subscribeEvents }) {
      const h = React.createElement

      return function EcologySettingsSection(props) {
        ensureStyles()
        const [activeTab, setActiveTab] = React.useState('ecology') // 'ecology' | 'organize' | 'history' | 'memory'
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(true)
        const [includeHealthy, setIncludeHealthy] = React.useState(false)
        const [form, setForm] = React.useState(() => settingsToForm(DEFAULT_SETTINGS))
        const [dirty, setDirty] = React.useState(false)
        const [busyKey, setBusyKey] = React.useState('')
        const [banner, setBanner] = React.useState(null)
        const [confirmSid, setConfirmSid] = React.useState('')
        const [confirmReset, setConfirmReset] = React.useState(false)
        const [expandedSession, setExpandedSession] = React.useState('')
        const [expandedHandoff, setExpandedHandoff] = React.useState('')
        const [handoffDocs, setHandoffDocs] = React.useState({})

        // Tab 4 (`memory`) states
        const [memReport, setMemReport] = React.useState(null)
        const [memLoading, setMemLoading] = React.useState(false)
        const [memMode, setMemMode] = React.useState('with_project') // 'with_project' | 'issues' | 'all'
        const [memSearch, setMemSearch] = React.useState('')
        const [expandedMemKey, setExpandedMemKey] = React.useState('')

        // Tab 2 (`organize`) states
        const [catalog, setCatalog] = React.useState(null)
        const [catLoading, setCatLoading] = React.useState(false)
        const [archiveFilter, setArchiveFilter] = React.useState('active')
        const [workspaceId, setWorkspaceId] = React.useState('all')
        const [priorityFilter, setPriorityFilter] = React.useState('all')
        const [sortBy, setSortBy] = React.useState('updated_desc')
        const [search, setSearch] = React.useState('')
        const [tagFilter, setTagFilter] = React.useState('')
        const [favoriteOnly, setFavoriteOnly] = React.useState(false)
        const [reviewOnly, setReviewOnly] = React.useState(false)
        const [scheduledOnly, setScheduledOnly] = React.useState(false)
        const [overOnly, setOverOnly] = React.useState(false)

        // Batch & inline organize drawer states
        const [batchMode, setBatchMode] = React.useState(false)
        const [selectedMap, setSelectedMap] = React.useState({})
        const [batchPriority, setBatchPriority] = React.useState('2')
        const [batchTagInput, setBatchTagInput] = React.useState('')
        const [batchMoveWs, setBatchMoveWs] = React.useState('')
        const [recyclePreviewIds, setRecyclePreviewIds] = React.useState(null) // string[] | null
        const [recycleDeleteScheds, setRecycleDeleteScheds] = React.useState(false)

        // Zero-restart archived purge + ghost/orphan reconciliation states
        const [purgeOpen, setPurgeOpen] = React.useState(false)
        const [purgeSurvey, setPurgeSurvey] = React.useState(null)
        const [purgeGuardMin, setPurgeGuardMin] = React.useState('60')
        const [purgeProtectFav, setPurgeProtectFav] = React.useState(true)
        const [purgeCleanOrphans, setPurgeCleanOrphans] = React.useState(true)
        const [purgePruneGhosts, setPurgePruneGhosts] = React.useState(true)
        const [purgeDeleteScheds, setPurgeDeleteScheds] = React.useState(false)

        const [editingSid, setEditingSid] = React.useState('')
        const [editTitle, setEditTitle] = React.useState('')
        const [editTags, setEditTags] = React.useState('')
        const [editNote, setEditNote] = React.useState('')
        const [editMoveWs, setEditMoveWs] = React.useState('')

        const loadStatus = React.useCallback(async (opts = {}) => {
          const healthyFlag = opts.includeHealthy !== undefined ? opts.includeHealthy : includeHealthy
          if (!opts.silent) setLoading(true)
          try {
            const url = `${ROUTE_BASE}/status?limit=30&historyLimit=50${healthyFlag ? '&includeHealthy=1' : ''}`
            const res = await window.fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            const json = await res.json()
            if (json?.ok) {
              setData(json)
              if (!dirty || opts.syncForm) {
                setForm(settingsToForm(json.settings))
                if (opts.syncForm) setDirty(false)
              }
            } else {
              setBanner({ ok: false, text: `读取状态失败：${json?.error || res.status}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `无法连接宿主生态接口：${err?.message || err}` })
          } finally {
            setLoading(false)
          }
        }, [includeHealthy, dirty])

        const loadCatalog = React.useCallback(async (opts = {}) => {
          if (!opts.silent) setCatLoading(true)
          try {
            const res = await window.fetch(`${ROUTE_BASE}/catalog?archiveFilter=all&limit=400`, {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            const json = await res.json()
            if (json?.ok) {
              setCatalog(json)
            } else {
              setBanner({ ok: false, text: `加载会话目录失败：${json?.error || res.status}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `无法读取会话目录：${err?.message || err}` })
          } finally {
            setCatLoading(false)
          }
        }, [])

        const loadProjectMemory = React.useCallback(async (opts = {}) => {
          if (!opts.silent) setMemLoading(true)
          try {
            const res = await window.fetch(`${ROUTE_BASE}/project-memory`, {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            const json = await res.json()
            if (json?.ok) {
              setMemReport(json)
            } else {
              setBanner({ ok: false, text: `读取项目记忆体检失败：${json?.error || res.status}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `无法读取项目记忆体检接口：${err?.message || err}` })
          } finally {
            setMemLoading(false)
          }
        }, [])

        React.useEffect(() => {
          void loadStatus({ syncForm: true })
        }, [includeHealthy])

        React.useEffect(() => {
          if (activeTab === 'organize' && !catalog) {
            void loadCatalog()
          } else if (activeTab === 'memory' && !memReport) {
            void loadProjectMemory()
          }
        }, [activeTab])

        React.useEffect(() => {
          return subscribeEvents((ev) => {
            if (ev?.type === 'handover' || ev?.type === 'settings' || ev?.type === 'failed') {
              void loadStatus({ silent: true, syncForm: ev?.type === 'settings' })
              if (activeTab === 'organize') void loadCatalog({ silent: true })
              if (activeTab === 'memory' && ev?.type === 'settings') void loadProjectMemory({ silent: true })
            } else if (ev?.type === 'annotations' && Array.isArray(ev.items)) {
              setCatalog((prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev
                const byId = new Map(ev.items.map(i => [i.sessionId, i.annotation]))
                return {
                  ...prev,
                  sessions: prev.sessions.map(s => (byId.has(s.sessionId) ? { ...s, annotation: byId.get(s.sessionId) } : s)),
                }
              })
            }
          })
        }, [loadStatus, loadCatalog, activeTab])

        const settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) }
        const summary = data?.summary || {}
        const sessions = Array.isArray(data?.sessions) ? data.sessions : []
        const history = Array.isArray(data?.recentHistory) ? data.recentHistory : []

        const allCatalogRows = Array.isArray(catalog?.sessions) ? catalog.sessions : []
        const catalogWorkspaces = Array.isArray(catalog?.workspaces) ? catalog.workspaces : []
        const catalogCounts = catalog?.counts || {}
        const catalogTags = Array.isArray(catalog?.allTags) ? catalog.allTags : []

        const filteredRows = filterAndSortCatalog(allCatalogRows, {
          archiveFilter,
          workspaceId,
          priority: priorityFilter,
          tag: tagFilter,
          search,
          favoriteOnly,
          reviewOnly,
          scheduledOnly,
          overOnly,
          sortBy,
        })

        const selectedIds = Object.keys(selectedMap).filter(k => selectedMap[k])

        const openEditorFor = (row) => {
          if (editingSid === row.sessionId) {
            setEditingSid('')
            return
          }
          setEditingSid(row.sessionId)
          setEditTitle(row.title || '')
          setEditTags((row.annotation?.tags || []).join(', '))
          setEditNote(row.annotation?.note || '')
          setEditMoveWs(row.workspaceId || (catalogWorkspaces[0]?.id ?? ''))
        }

        const toggleSelectOne = (sid) => {
          setSelectedMap(prev => ({ ...prev, [sid]: !prev[sid] }))
        }

        const selectAllFiltered = () => {
          const next = { ...selectedMap }
          for (const r of filteredRows) {
            if (!r.isBot) next[r.sessionId] = true
          }
          setSelectedMap(next)
        }

        const clearSelection = () => {
          setSelectedMap({})
          setRecyclePreviewIds(null)
        }

        const onQuickAnnotate = async (sessionIds, patch, label) => {
          setBusyKey('annotate')
          try {
            const res = await apiPost({ action: 'annotate', sessionIds, patch })
            if (res?.summary) {
              if (label) setBanner(formatBatchResultBanner(label, res))
              await loadCatalog({ silent: true })
            } else {
              setBanner({ ok: false, text: `标注失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `标注异常：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onRenameRow = async (sid) => {
          setBusyKey(`rename:${sid}`)
          try {
            const res = await apiPost({ action: 'rename', sessionId: sid, title: editTitle })
            if (res?.ok) {
              setBanner({ ok: true, text: `已重命名为「${res.title}」` })
              await loadCatalog({ silent: true })
            } else {
              setBanner({ ok: false, text: `重命名失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `重命名失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onPinAction = async (sessionIds, pinned) => {
          setBusyKey('pin')
          try {
            const res = await apiPost({ action: 'pin', sessionIds, pinned })
            setBanner(formatBatchResultBanner(pinned ? '置顶会话' : '取消置顶', res))
            await loadCatalog({ silent: true })
          } catch (err) {
            setBanner({ ok: false, text: `置顶操作失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onArchiveAction = async (sessionIds, archived, allowScheduledArchive = false) => {
          setBusyKey('archive')
          try {
            const res = await apiPost({
              action: archived ? 'archive' : 'unarchive',
              sessionIds,
              archived,
              allowScheduledArchive,
            })
            setBanner(formatBatchResultBanner(archived ? '归档整理' : '恢复侧栏', res))
            await loadCatalog({ silent: true })
            void loadStatus({ silent: true })
          } catch (err) {
            setBanner({ ok: false, text: `归档操作失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onMoveAction = async (sessionIds, targetWorkspaceId) => {
          if (!targetWorkspaceId) {
            setBanner({ ok: false, text: '请先选择目标工作区。' })
            return
          }
          setBusyKey('move')
          try {
            const res = await apiPost({ action: 'move', sessionIds, targetWorkspaceId })
            setBanner(formatBatchResultBanner('跨工作区移动', res))
            await loadCatalog({ silent: true })
          } catch (err) {
            setBanner({ ok: false, text: `移动工作区失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const openRecycleConfirm = (ids) => {
          const clean = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
          if (clean.length === 0) return
          setRecycleDeleteScheds(false)
          setRecyclePreviewIds(clean)
        }

        const onConfirmRecycle = async () => {
          if (!Array.isArray(recyclePreviewIds) || recyclePreviewIds.length === 0) return
          const ids = recyclePreviewIds
          setBusyKey('recycle')
          try {
            const res = await apiPost({
              action: 'recycle',
              sessionIds: ids,
              deleteSchedules: recycleDeleteScheds,
            })
            setBanner(formatBatchResultBanner('移入系统回收站', res))
            setRecyclePreviewIds(null)
            setSelectedMap((prev) => {
              const next = { ...prev }
              for (const item of res?.items || []) {
                if (item.status === 'success') delete next[item.sessionId]
              }
              return next
            })
            if (editingSid && ids.includes(editingSid)) setEditingSid('')
            await loadCatalog({ silent: true })
            void loadStatus({ silent: true })
          } catch (err) {
            setBanner({ ok: false, text: `移入回收站失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const runPurgeSurvey = async (overrides = {}) => {
          const guardVal = overrides.activeGuardMinutes !== undefined
            ? Number(overrides.activeGuardMinutes)
            : Number(purgeGuardMin)
          const protFav = overrides.protectFavorites !== undefined ? overrides.protectFavorites : purgeProtectFav
          const cleanOrph = overrides.cleanOrphanCache !== undefined ? overrides.cleanOrphanCache : purgeCleanOrphans
          const pruneGh = overrides.pruneGhostIds !== undefined ? overrides.pruneGhostIds : purgePruneGhosts
          const delSch = overrides.deleteSchedules !== undefined ? overrides.deleteSchedules : purgeDeleteScheds
          setBusyKey('purgeSurvey')
          try {
            const res = await apiPost({
              action: 'purgeArchived',
              dryRun: true,
              activeGuardMinutes: Number.isFinite(guardVal) ? Math.max(0, guardVal) : 60,
              protectFavorites: protFav,
              cleanOrphanCache: cleanOrph,
              pruneGhostIds: pruneGh,
              deleteSchedules: delSch,
            })
            if (res?.ok) {
              setPurgeSurvey(res)
            } else {
              setBanner({ ok: false, text: `清理预盘点失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `清理预盘点异常：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onTogglePurgeDrawer = () => {
          if (purgeOpen) {
            setPurgeOpen(false)
            return
          }
          setPurgeOpen(true)
          void runPurgeSurvey()
        }

        const onConfirmPurgeArchived = async () => {
          const guardVal = Number(purgeGuardMin)
          setBusyKey('purgeExec')
          try {
            const res = await apiPost({
              action: 'purgeArchived',
              dryRun: false,
              activeGuardMinutes: Number.isFinite(guardVal) ? Math.max(0, guardVal) : 60,
              protectFavorites: purgeProtectFav,
              cleanOrphanCache: purgeCleanOrphans,
              pruneGhostIds: purgePruneGhosts,
              deleteSchedules: purgeDeleteScheds,
            })
            setBanner(formatPurgeArchivedBanner(res))
            setPurgeOpen(false)
            setPurgeSurvey(null)
            await loadCatalog({ silent: true })
            void loadStatus({ silent: true })
          } catch (err) {
            setBanner({ ok: false, text: `一键清理已归档失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onToggle = async (field) => {
          const nextVal = !settings[field]
          setBusyKey(`toggle:${field}`)
          setBanner(null)
          try {
            const res = await apiPost({ action: 'settings', [field]: nextVal })
            if (res?.ok && res.settings) {
              setData(prev => (prev ? { ...prev, settings: res.settings } : prev))
              setBanner({ ok: true, text: '开关已实时保存至宿主。' })
            } else {
              setBanner({ ok: false, text: `保存失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `保存失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onSaveThresholds = async () => {
          const patch = sanitizeDraftSettings(form)
          setBusyKey('saveThresholds')
          setBanner(null)
          try {
            const res = await apiPost({ action: 'settings', ...patch })
            if (res?.ok && res.settings) {
              setData(prev => (prev ? { ...prev, settings: res.settings } : prev))
              setForm(settingsToForm(res.settings))
              setDirty(false)
              setBanner({ ok: true, text: '阈值已持久化写入宿主并立即对所有工作区生效。' })
              void loadStatus({ silent: true })
            } else {
              setBanner({ ok: false, text: `保存阈值失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `保存阈值失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onResetDefaults = async () => {
          if (!confirmReset) {
            setConfirmReset(true)
            setTimeout(() => setConfirmReset(false), 3500)
            return
          }
          setConfirmReset(false)
          setBusyKey('reset')
          setBanner(null)
          try {
            const res = await apiPost({ action: 'resetSettings' })
            if (res?.ok && res.settings) {
              setData(prev => (prev ? { ...prev, settings: res.settings } : prev))
              setForm(settingsToForm(res.settings))
              setDirty(false)
              setBanner({ ok: true, text: '已恢复推荐默认阈值与开关。' })
              void loadStatus({ silent: true })
            }
          } catch (err) {
            setBanner({ ok: false, text: `恢复默认失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onSweep = async () => {
          setBusyKey('sweep')
          setBanner({ ok: true, text: '正在检查并串行清扫超标的活跃定时会话…' })
          try {
            const res = await apiPost({ action: 'sweep', scheduledOnly: true, dryRun: false, limit: 5 })
            if (res?.ok) {
              const n = res.sweptCount ?? res.matchedCount ?? 0
              setBanner({
                ok: true,
                text: n > 0 ? `已完成 ${n} 个超标定时会话换卷继承。` : '当前没有超标的空闲定时巡检会话。',
              })
              void loadStatus({ silent: true })
            } else {
              setBanner({ ok: false, text: `清扫未执行：${res?.message || res?.error || res?.code}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `清扫请求失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onManualHandover = async (row) => {
          if (confirmSid !== row.sessionId) {
            setConfirmSid(row.sessionId)
            setTimeout(() => {
              setConfirmSid(cur => (cur === row.sessionId ? '' : cur))
            }, 3500)
            return
          }
          setConfirmSid('')
          setBusyKey(`handover:${row.sessionId}`)
          setBanner({ ok: true, text: `已发起「${row.title}」自总结与换卷交接，请稍候…` })
          try {
            const res = await apiPost({ action: 'handover', sessionId: row.sessionId, force: true, wait: false })
            if (res?.ok) {
              setBanner({ ok: true, text: `「${row.title}」正在后台执行自总结换卷，完成后将自动更新台账。` })
              void loadStatus({ silent: true })
            } else {
              setBanner({ ok: false, text: `无法发起换卷：${res?.message || res?.code || res?.error}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `请求异常：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onJumpSession = (sid) => {
          if (!sid) return
          const ok = openSession(sid)
          if (ok && typeof props?.close === 'function') {
            props.close()
          }
        }

        const onUnarchiveOld = async (oldSid) => {
          setBusyKey(`unarchive:${oldSid}`)
          try {
            const res = await apiPost({ action: 'unarchive', sessionId: oldSid })
            if (res?.ok) {
              setBanner({ ok: true, text: '已将该旧对话恢复回工作区侧栏。' })
              void loadStatus({ silent: true })
              if (catalog) void loadCatalog({ silent: true })
            } else {
              setBanner({ ok: false, text: `恢复失败：${res?.error || '未知错误'}` })
            }
          } catch (err) {
            setBanner({ ok: false, text: `恢复失败：${err?.message || err}` })
          } finally {
            setBusyKey('')
          }
        }

        const onToggleHandoffDoc = async (oldSid) => {
          if (expandedHandoff === oldSid) {
            setExpandedHandoff('')
            return
          }
          setExpandedHandoff(oldSid)
          if (handoffDocs[oldSid]) return
          setHandoffDocs(prev => ({ ...prev, [oldSid]: '正在加载交接单…' }))
          try {
            const res = await window.fetch(
              `${ROUTE_BASE}/handoff?oldSessionId=${encodeURIComponent(oldSid)}`,
              { credentials: 'same-origin' }
            )
            const json = await res.json()
            setHandoffDocs(prev => ({
              ...prev,
              [oldSid]: json?.ok ? json.markdown : `交接单不可用：${json?.error || res.status}`,
            }))
          } catch (err) {
            setHandoffDocs(prev => ({ ...prev, [oldSid]: `读取失败：${err?.message || err}` }))
          }
        }

        const renderSwitchRow = (field, title, desc) => {
          const on = Boolean(settings[field])
          return h('div', { className: 'sec-toggle-row', key: field },
            h('div', { className: 'sec-toggle-copy' },
              h('div', { className: 'sec-toggle-name' }, title),
              h('div', { className: 'sec-toggle-desc' }, desc)
            ),
            h('button', {
              type: 'button',
              className: 'sec-switch',
              'data-on': String(on),
              'aria-pressed': String(on),
              disabled: busyKey === `toggle:${field}`,
              onClick: () => { void onToggle(field) },
            }, on ? '已开启' : '已关闭')
          )
        }

        const renderNumRow = (key, title, desc, unit, previewText, min, max, step = 1) => {
          return h('div', { className: 'sec-grid-row', key },
            h('div', { className: 'sec-toggle-copy' },
              h('div', { className: 'sec-toggle-name' }, title),
              h('div', { className: 'sec-toggle-desc' }, desc)
            ),
            h('div', { className: 'sec-num-wrap' },
              h('input', {
                className: 'sec-num',
                type: 'number',
                min,
                max,
                step,
                value: form[key] ?? '',
                onChange: (ev) => {
                  const v = ev.target.value
                  setForm(prev => ({ ...prev, [key]: v }))
                  setDirty(true)
                },
              }),
              h('span', { className: 'sec-unit' }, unit)
            ),
            h('div', { className: 'sec-preview' }, previewText)
          )
        }

        const renderPurgeArchivedBox = () => {
          if (!purgeOpen) return null
          const sv = purgeSurvey
          const candCount = sv?.candidateCount ?? 0
          const skipCount = sv?.skippedCount ?? 0
          const ghostCount = sv?.ghostSummary?.uniqueCount ?? 0
          const orphanCount = sv?.orphanProjCacheCount ?? 0
          const hasActionable = candCount > 0
            || (purgePruneGhosts && ghostCount > 0)
            || (purgeCleanOrphans && orphanCount > 0)
          const schedSkipped = Array.isArray(sv?.skippedItems)
            ? sv.skippedItems.filter(i => i.code === 'has_active_schedules').length
            : 0

          return h('div', { className: 'sec-danger-box' },
            h('div', { className: 'sec-drawer-row', style: { justifyContent: 'space-between' } },
              h('div', { style: { fontWeight: 600 } },
                '🧹 零重启清理已归档会话 / 幽灵 ID / 孤儿缓存（全部安全进 Windows 系统回收站）'
              ),
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-sm',
                disabled: busyKey === 'purgeSurvey' || busyKey === 'purgeExec',
                onClick: () => { void runPurgeSurvey() },
              }, busyKey === 'purgeSurvey' ? '盘点中…' : '🔄 重新盘点')
            ),
            h('div', { className: 'sec-detail' },
              '无需停止或重启 DSH 宿主进程：直接在内存中解绑已归档会话与空壳幽灵 ID，并将会话目录、子代理目录与孤儿缓存静默移入系统回收站。'
            ),
            sv
              ? h('div', { className: 'sec-tags' },
                h('span', { className: 'sec-badge', 'data-tone': candCount > 0 ? 'warn' : 'ok' },
                  `待回收归档：${candCount} 个（约 ${formatMb(sv.estimatedSessionFreedBytes)} MB）`
                ),
                h('span', { className: 'sec-badge', 'data-tone': skipCount > 0 ? 'brand' : 'muted' },
                  `保护跳过：${skipCount} 个`
                ),
                h('span', { className: 'sec-badge', 'data-tone': ghostCount > 0 ? 'warn' : 'ok' },
                  `内存幽灵 ID：${ghostCount} 个（工作区 ${sv.ghostSummary?.workspaceSessionIds ?? 0} / 归档表 ${sv.ghostSummary?.archivedSessionIds ?? 0} / 置顶表 ${sv.ghostSummary?.pinnedSessionIds ?? 0}）`
                ),
                h('span', { className: 'sec-badge', 'data-tone': orphanCount > 0 ? 'warn' : 'ok' },
                  `孤儿缓存 JSON：${orphanCount} 个（${formatMb(sv.orphanProjCacheBytes)} MB）`
                ),
                h('span', { className: 'sec-badge' },
                  `当前 sessions/ 总占用：${formatMb(sv.sessionsBytesBefore)} MB`
                )
              )
              : h('div', { className: 'sec-detail' }, '正在扫描磁盘目录、工作区账本与缓存对账…'),
            sv && Array.isArray(sv.candidates) && sv.candidates.length > 0
              ? h('div', { className: 'sec-detail' },
                '待回收样本：' + sv.candidates.slice(0, 6).map(c => `「${c.title}」(${formatMb(c.totalBytes)}MB)`).join('、')
                + (sv.candidates.length > 6 ? ` 等 ${sv.candidates.length} 个已归档会话` : '')
              )
              : null,
            sv && Array.isArray(sv.skippedItems) && sv.skippedItems.length > 0
              ? h('div', { className: 'sec-detail' },
                '保护跳过原因：' + sv.skippedItems.slice(0, 5).map(s => `${s.sessionId.slice(8, 16)}(${s.reason})`).join('；')
                + (sv.skippedItems.length > 5 ? ` 等 ${sv.skippedItems.length} 项` : '')
              )
              : null,
            h('div', { className: 'sec-drawer-row' },
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px' } },
                '活跃写入保护窗：',
                h('input', {
                  className: 'sec-num',
                  style: { width: '62px', height: '26px' },
                  type: 'number',
                  min: 0,
                  max: 10080,
                  value: purgeGuardMin,
                  onChange: ev => setPurgeGuardMin(ev.target.value),
                }),
                '分钟内刚写入跳过'
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: purgeProtectFav,
                  onChange: ev => {
                    const v = ev.target.checked
                    setPurgeProtectFav(v)
                    void runPurgeSurvey({ protectFavorites: v })
                  },
                }),
                '保护 ⭐收藏 / 📌待回看'
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: purgePruneGhosts,
                  onChange: ev => {
                    const v = ev.target.checked
                    setPurgePruneGhosts(v)
                  },
                }),
                '摘除内存幽灵 ID'
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: purgeCleanOrphans,
                  onChange: ev => {
                    const v = ev.target.checked
                    setPurgeCleanOrphans(v)
                    void runPurgeSurvey({ cleanOrphanCache: v })
                  },
                }),
                '回收孤儿 projcache JSON'
              ),
              schedSkipped > 0 || purgeDeleteScheds
                ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 } },
                  h('input', {
                    type: 'checkbox',
                    checked: purgeDeleteScheds,
                    onChange: ev => {
                      const v = ev.target.checked
                      setPurgeDeleteScheds(v)
                      void runPurgeSurvey({ deleteSchedules: v })
                    },
                  }),
                  `⚠️ 一并删除关联活跃定时任务（当前有 ${schedSkipped} 个因定时被保护）`
                )
                : null
            ),
            h('div', { className: 'sec-actions' },
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-danger',
                disabled: !sv || !hasActionable || busyKey === 'purgeExec' || busyKey === 'purgeSurvey',
                onClick: () => { void onConfirmPurgeArchived() },
              }, busyKey === 'purgeExec'
                ? '正在零重启清理并移入回收站…'
                : hasActionable
                  ? `确认清理并移入回收站（预计释放 ${formatMb(sv?.estimatedTotalFreedBytes)} MB）`
                  : '当前无待清理项（账本与缓存已完全干净）'),
              h('button', {
                type: 'button',
                className: 'sec-btn',
                disabled: busyKey === 'purgeExec',
                onClick: () => setPurgeOpen(false),
              }, '收起')
            )
          )
        }

        const renderRecycleConfirmBox = () => {
          if (!Array.isArray(recyclePreviewIds) || recyclePreviewIds.length === 0) return null
          const rowMap = new Map(allCatalogRows.map(r => [r.sessionId, r]))
          const targetRows = recyclePreviewIds.map(id => rowMap.get(id)).filter(Boolean)
          const scheduledRows = targetRows.filter(r => r.activeSchedules > 0)
          return h('div', { className: 'sec-danger-box' },
            h('div', { style: { fontWeight: 600 } },
              `🗑️ 确认将 ${recyclePreviewIds.length} 个会话安全移入 Windows 系统回收站？`
            ),
            h('div', { className: 'sec-detail' },
              '安全机制：严禁不可逆硬删！所选会话目录与缓存将静默移入 Windows 系统回收站（需要时可随时在回收站还原），并零重启从当前工作区侧栏与内存中立即移除。'
            ),
            targetRows.length > 0
              ? h('div', { className: 'sec-detail' },
                '待回收会话：' + targetRows.slice(0, 6).map(r => `「${r.title}」`).join('、') + (targetRows.length > 6 ? ` 等 ${targetRows.length} 项` : '')
              )
              : null,
            scheduledRows.length > 0
              ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: 500 } },
                h('input', {
                  type: 'checkbox',
                  checked: recycleDeleteScheds,
                  onChange: ev => setRecycleDeleteScheds(ev.target.checked),
                }),
                `⚠️ 其中 ${scheduledRows.length} 个会话挂载活跃定时任务，勾选后一并清理其定时任务（不勾选将自动跳过保护）`
              )
              : null,
            h('div', { className: 'sec-actions' },
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-danger',
                disabled: busyKey === 'recycle',
                onClick: () => { void onConfirmRecycle() },
              }, busyKey === 'recycle' ? '正在移入回收站…' : '确认移入系统回收站'),
              h('button', {
                type: 'button',
                className: 'sec-btn',
                disabled: busyKey === 'recycle',
                onClick: () => setRecyclePreviewIds(null),
              }, '取消')
            )
          )
        }

        const renderEcologyTab = () => h(React.Fragment, null,
          // 4 KPI Cards
          h('div', { className: 'sec-kpis' },
            h('div', { className: 'sec-kpi' },
              h('span', { className: 'sec-kpi-label' }, '监控活跃会话'),
              h('span', { className: 'sec-kpi-val' }, summary.inspectedCandidates ?? '-')
            ),
            h('div', { className: 'sec-kpi' },
              h('span', { className: 'sec-kpi-label' }, '预警区会话'),
              h('span', {
                className: 'sec-kpi-val',
                'data-tone': (summary.warnCount || 0) > 0 ? 'warn' : undefined,
              }, summary.warnCount ?? '-')
            ),
            h('div', { className: 'sec-kpi' },
              h('span', { className: 'sec-kpi-label' }, '当前超标待换卷'),
              h('span', {
                className: 'sec-kpi-val',
                'data-tone': (summary.overThresholdCount || 0) > 0 ? 'danger' : 'ok',
              }, summary.overThresholdCount ?? '-')
            ),
            h('div', { className: 'sec-kpi' },
              h('span', { className: 'sec-kpi-label' }, '累计继承归档'),
              h('span', { className: 'sec-kpi-val', 'data-tone': 'ok' }, summary.totalHistoricalHandovers ?? '-')
            )
          ),

          // Block 1: Switches
          h('div', { className: 'sec-card' },
            h('div', { className: 'sec-card-title' }, '功能开关（宿主级实时持久化）'),
            renderSwitchRow(
              'enabled',
              '启用会话生态守卫（总开关）',
              '关闭后暂停所有工作区的后台自动换卷与启动巡检清扫；技能手动工具与会话整理仍可随时使用。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'autoHandover',
              '回合忙完自动换卷继承',
              '任意工作区对话在回合正常结束、收件箱为空且命中任一道生态门时，自动总结并迁入 #2/#3 新卷（自动继承收藏/优先级/标签/备注）。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'postBootSweepEnabled',
              '启动 60 秒后自动清扫超标定时巡检',
              'DSH 启动稳定后自动串行清扫挂有活跃定时任务且超标的空闲对话，不惊扰无任务的历史旧对话。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'archiveOldSession',
              '换卷完成后自动归档旧对话',
              '新卷完成首屏交接激活、定时任务校验搬迁无误后，自动将旧对话归档隐藏。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'notifyFeishu',
              '换卷完成后推送飞书通知',
              '复用本机 notify-feishu 通道向飞书群发送工作区、新旧会话、触发原因与迁移任务报告。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'projectMemoryGuardEnabled',
              '启用 PROJECT.md 写入硬上限闸门',
              '拦截让 PROJECT.md 超出容量红线且体积/行数继续变大的写入，逼 AI 原地瘦身并归档冷历史至 docs/HISTORY.md；超标后变小放行。'
            ),
            h('div', { className: 'sec-divider' }),
            renderSwitchRow(
              'projectMemoryReminderEnabled',
              '逼近压缩/换卷前静默提醒沉淀记忆',
              '交互式项目会话压后负载达窗口 24% 或表面达门限 70% 时静默注入单段提醒，先把关键结论落盘至 PROJECT.md（定时巡检/子代理零注入）。'
            )
          ),

          // Block 2: Thresholds
          h('div', { className: 'sec-card' },
            h('div', { className: 'sec-card-head' },
              h('div', { className: 'sec-card-title' }, '三道门模型窗口自适应阈值'),
              dirty ? h('span', { className: 'sec-badge', 'data-tone': 'warn' }, '有未保存修改') : null
            ),
            h('div', { className: 'sec-hint' },
              '以下比例按每个对话当前所选模型的真实上下文窗口 W（contextWindow）自动折算，任意一道门达标即在忙完空闲时触发换卷。'
            ),
            renderNumRow(
              'pressurePct',
              '门 1 · 压后真实负载（pressureTokens）',
              '压缩后实际送入上游的单轮输入负荷占模型窗口 W 的百分比（推荐 40%）。',
              '% W',
              formatRatioPreview(form.pressurePct),
              10,
              95,
              5
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'surfacePct',
              '门 2 · 压前表面历史（surfaceTokens）',
              '未折叠前原始表面上下文占模型窗口 W 的百分比（推荐 100%）。',
              '% W',
              formatRatioPreview(form.surfacePct),
              30,
              500,
              10
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'standardMult',
              '门 3a · 常规模型累计折叠疲劳倍数',
              '会话全周期累计总 Token 达到 W 的多少倍后换新卷，防止反复压缩失忆（推荐 350×）。',
              '× W',
              formatMultPreview(form.standardMult),
              10,
              5000,
              10
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'proMult',
              '门 3b · 高阶模型累计折叠疲劳倍数',
              '适用于 pro / opus / argon / gpt-6 / codex 等高单价或重推理模型（推荐 150×）。',
              '× W',
              formatMultPreview(form.proMult),
              10,
              5000,
              10
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'warnPct',
              '水位预警线比例',
              '最高一道门进度达到该百分比时列入下方预警榜，便于提前观察（推荐 75%）。',
              '%',
              `达门限 ${form.warnPct || 75}% 时标黄预警`,
              30,
              98,
              5
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'projectMemoryMaxBytes',
              'PROJECT.md 字节硬上限',
              '跨 AI 单真源热记忆容量红线；超出且继续变大时写闸门直接拒写（推荐 15360 B = 15 KB）。',
              'B',
              `约 ${((Number(form.projectMemoryMaxBytes) || 15360) / 1024).toFixed(1)} KB`,
              4096,
              65536,
              1024
            ),
            h('div', { className: 'sec-divider' }),
            renderNumRow(
              'projectMemoryMaxLines',
              'PROJECT.md 行数硬上限',
              '防止短行密集堆砌拉高常驻阅读开销（推荐 250 行）。',
              '行',
              `四段式 ≤ ${form.projectMemoryMaxLines || 250} 行`,
              50,
              1000,
              10
            ),
            h('div', { className: 'sec-actions' },
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-primary',
                disabled: !dirty || busyKey === 'saveThresholds',
                onClick: () => { void onSaveThresholds() },
              }, busyKey === 'saveThresholds' ? '保存中…' : '保存阈值配置'),
              h('button', {
                type: 'button',
                className: confirmReset ? 'sec-btn sec-btn-warn' : 'sec-btn',
                disabled: busyKey === 'reset',
                onClick: () => { void onResetDefaults() },
              }, confirmReset ? '再点一次确认恢复默认' : '恢复推荐默认')
            )
          ),

          // Block 3: Live Session Watermarks
          h('div', { className: 'sec-card' },
            h('div', { className: 'sec-card-head' },
              h('div', { className: 'sec-card-title' }, `当前水位监控与手动换卷（${sessions.length}）`),
              h('label', {
                style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
              },
                h('input', {
                  type: 'checkbox',
                  checked: includeHealthy,
                  onChange: (ev) => setIncludeHealthy(ev.target.checked),
                }),
                '显示无定时任务的普通健康对话'
              )
            ),
            h('div', { className: 'sec-hint' },
              '默认展示挂有活跃定时任务的对话与处于预警/超标区的对话。点击对话标题可展开三道门明细；点「立即换卷」可随时手动刷新继承。'
            ),
            sessions.length === 0
              ? h('div', { className: 'sec-hint' }, loading ? '正在读取会话水位…' : '当前没有需要关注的预警或定时任务会话。')
              : h('div', { className: 'sec-list' },
                sessions.map((row) => {
                  const pct = Math.min(100, Math.round((Number(row.maxGateProgress) || 0) * 100))
                  const tone = row.triggered ? 'danger' : (row.status === 'warn' ? 'warn' : 'ok')
                  const expanded = expandedSession === row.sessionId
                  const m = row.metrics || {}
                  const th = row.thresholds || {}
                  const hoverSummary = `压后 ${compactTok(m.pressureTokens)}/${compactTok(th.pressureLimit)} ｜ 表面 ${compactTok(m.surfaceTokens)}/${compactTok(th.surfaceLimit)} ｜ 累计 ${compactTok(m.totalTokens)}/${compactTok(th.fatigueLimit)} ｜ 窗口 W=${compactTok(m.contextWindow)}`
                  return h('div', { className: 'sec-item', key: row.sessionId, title: hoverSummary },
                    h('div', { className: 'sec-item-top' },
                      h('div', {
                        className: 'sec-item-title',
                        onClick: () => setExpandedSession(expanded ? '' : row.sessionId),
                      }, `${expanded ? '▾ ' : '▸ '}${row.title}`),
                      h('div', { className: 'sec-tags' },
                        h('span', { className: 'sec-badge' }, row.workspace || '未分组'),
                        row.activeSchedules > 0
                          ? h('span', { className: 'sec-badge', 'data-tone': 'ok' }, `定时×${row.activeSchedules}`)
                          : null,
                        row.inFlightPhase
                          ? h('span', { className: 'sec-badge', 'data-tone': 'warn' }, `换卷中:${row.inFlightPhase}`)
                          : h('span', { className: 'sec-badge', 'data-tone': tone }, `水位 ${pct}%`),
                        h('button', {
                          type: 'button',
                          className: 'sec-btn sec-btn-sm',
                          onClick: () => onJumpSession(row.sessionId),
                        }, '打开'),
                        h('button', {
                          type: 'button',
                          className: confirmSid === row.sessionId ? 'sec-btn sec-btn-sm sec-btn-warn' : 'sec-btn sec-btn-sm',
                          disabled: Boolean(row.inFlightPhase) || busyKey === `handover:${row.sessionId}`,
                          onClick: () => { void onManualHandover(row) },
                        }, confirmSid === row.sessionId ? '确认换卷?' : '立即换卷')
                      )
                    ),
                    h('div', { className: 'sec-meter', 'data-tone': tone },
                      h('span', { style: { width: `${Math.max(2, pct)}%` } })
                    ),
                    expanded
                      ? h('div', { className: 'sec-detail' },
                        h('div', null, `模型：${row.model} ｜ 轮次/步数：${m.turns || 0} 轮 / ${m.steps || 0} 步 ｜ 会话 ID：${row.sessionId}`),
                        h('div', null, hoverSummary),
                        Array.isArray(row.scheduleTitles) && row.scheduleTitles.length > 0
                          ? h('div', null, `活跃定时任务：${row.scheduleTitles.join('、')}`)
                          : null,
                        Array.isArray(row.reasons) && row.reasons.length > 0
                          ? h('div', null, `达标项：${row.reasons.join('；')}`)
                          : null
                      )
                      : null
                  )
                })
              )
          )
        )

        const renderOrganizeTab = () => h('div', { className: 'sec-card' },
          h('div', { className: 'sec-card-head' },
            h('div', { className: 'sec-card-title' },
              `会话整理与批量工作台（当前筛选 ${filteredRows.length} / 总计 ${catalogCounts.total ?? allCatalogRows.length}）`
            ),
            h('div', { className: 'sec-tags' },
              h('button', {
                type: 'button',
                className: purgeOpen ? 'sec-btn sec-btn-sm sec-btn-warn' : 'sec-btn sec-btn-sm',
                onClick: onTogglePurgeDrawer,
              }, `🧹 清理已归档 / 孤儿对账${(catalogCounts.archived || 0) > 0 ? ` (${catalogCounts.archived})` : ''}`),
              h('button', {
                type: 'button',
                className: batchMode || selectedIds.length > 0 ? 'sec-btn sec-btn-sm sec-btn-primary' : 'sec-btn sec-btn-sm',
                onClick: () => {
                  if (batchMode && selectedIds.length === 0) setBatchMode(false)
                  else setBatchMode(!batchMode)
                },
              }, `☑️ 批量管理${selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}`),
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-sm',
                disabled: catLoading,
                onClick: () => { void loadCatalog() },
              }, catLoading ? '同步中…' : '刷新列表')
            )
          ),

          // Filter bar row 1: Search + Archive + Workspace + Priority + Sort
          h('div', { className: 'sec-filter-grid' },
            h('input', {
              className: 'sec-input',
              style: { flex: '1 1 200px', minWidth: '160px' },
              type: 'search',
              placeholder: '搜索标题 / 会话ID / #标签 / 备注 / 工作区…',
              value: search,
              onChange: ev => setSearch(ev.target.value),
            }),
            h('select', {
              className: 'sec-select',
              value: archiveFilter,
              onChange: ev => setArchiveFilter(ev.target.value),
            },
              h('option', { value: 'active' }, `未归档 (${catalogCounts.active ?? 0})`),
              h('option', { value: 'archived' }, `已归档 (${catalogCounts.archived ?? 0})`),
              h('option', { value: 'all' }, `全部状态 (${catalogCounts.total ?? 0})`)
            ),
            h('select', {
              className: 'sec-select',
              value: workspaceId,
              onChange: ev => setWorkspaceId(ev.target.value),
            },
              h('option', { value: 'all' }, '全部工作区'),
              h('option', { value: 'ungrouped' }, `未分组 (${catalogCounts.ungrouped ?? 0})`),
              catalogWorkspaces.map(ws =>
                h('option', { key: ws.id, value: ws.id }, `${ws.title} (${ws.activeCount}/${ws.totalCount})`)
              )
            ),
            h('select', {
              className: 'sec-select',
              value: priorityFilter,
              onChange: ev => setPriorityFilter(ev.target.value),
            },
              h('option', { value: 'all' }, '全部优先级'),
              h('option', { value: '1' }, 'P1 最高'),
              h('option', { value: '2' }, 'P2 高'),
              h('option', { value: '3' }, 'P3 普通'),
              h('option', { value: '4' }, 'P4 低'),
              h('option', { value: '5' }, 'P5 最低')
            ),
            h('select', {
              className: 'sec-select',
              value: sortBy,
              onChange: ev => setSortBy(ev.target.value),
            },
              h('option', { value: 'updated_desc' }, '排序：最近活跃'),
              h('option', { value: 'priority_asc' }, '排序：优先级 P1→P5'),
              h('option', { value: 'ecology_desc' }, '排序：生态水位 高→低'),
              h('option', { value: 'title_asc' }, '排序：标题 A→Z')
            )
          ),

          // Filter bar row 2: Quick chips + Tag pills
          h('div', { className: 'sec-filter-grid' },
            h('button', {
              type: 'button',
              className: 'sec-pill',
              'data-active': String(favoriteOnly),
              onClick: () => setFavoriteOnly(!favoriteOnly),
            }, `⭐ 收藏 (${catalogCounts.favorites ?? 0})`),
            h('button', {
              type: 'button',
              className: 'sec-pill',
              'data-active': String(reviewOnly),
              onClick: () => setReviewOnly(!reviewOnly),
            }, `📌 待回看 (${catalogCounts.reviewLater ?? 0})`),
            h('button', {
              type: 'button',
              className: 'sec-pill',
              'data-active': String(scheduledOnly),
              onClick: () => setScheduledOnly(!scheduledOnly),
            }, `⏰ 有定时 (${catalogCounts.scheduled ?? 0})`),
            h('button', {
              type: 'button',
              className: 'sec-pill',
              'data-active': String(overOnly),
              onClick: () => setOverOnly(!overOnly),
            }, '🚨 预警/超标'),
            catalogTags.slice(0, 12).map(tc =>
              h('button', {
                key: tc.tag,
                type: 'button',
                className: 'sec-pill',
                'data-active': String(tagFilter === tc.tag.toLowerCase()),
                onClick: () => setTagFilter(tagFilter === tc.tag.toLowerCase() ? '' : tc.tag.toLowerCase()),
              }, `#${tc.tag} (${tc.count})`)
            ),
            (favoriteOnly || reviewOnly || scheduledOnly || overOnly || tagFilter || search || priorityFilter !== 'all' || workspaceId !== 'all')
              ? h('button', {
                type: 'button',
                className: 'sec-pill',
                onClick: () => {
                  setFavoriteOnly(false)
                  setReviewOnly(false)
                  setScheduledOnly(false)
                  setOverOnly(false)
                  setTagFilter('')
                  setSearch('')
                  setPriorityFilter('all')
                  setWorkspaceId('all')
                },
              }, '✕ 重置筛选')
              : null
          ),

          // Batch Action Toolbar
          (batchMode || selectedIds.length > 0)
            ? h('div', { className: 'sec-batch-bar' },
              h('div', { className: 'sec-drawer-row', style: { justifyContent: 'space-between' } },
                h('div', { className: 'sec-tags' },
                  h('span', { style: { fontWeight: 600 } }, `已选 ${selectedIds.length} 个会话`),
                  h('button', { type: 'button', className: 'sec-btn sec-btn-sm', onClick: selectAllFiltered }, `全选当前筛选 (${filteredRows.length})`),
                  h('button', { type: 'button', className: 'sec-btn sec-btn-sm', onClick: clearSelection }, '清空选择')
                ),
                h('div', { className: 'sec-tags' },
                  h('button', {
                    type: 'button',
                    className: 'sec-btn sec-btn-sm',
                    disabled: selectedIds.length === 0 || Boolean(busyKey),
                    onClick: () => { void onQuickAnnotate(selectedIds, { favorite: true }, '批量收藏') },
                  }, '⭐ 收藏'),
                  h('button', {
                    type: 'button',
                    className: 'sec-btn sec-btn-sm',
                    disabled: selectedIds.length === 0 || Boolean(busyKey),
                    onClick: () => { void onQuickAnnotate(selectedIds, { reviewLater: true }, '批量标待回看') },
                  }, '📌 待回看'),
                  h('button', {
                    type: 'button',
                    className: 'sec-btn sec-btn-sm',
                    disabled: selectedIds.length === 0 || Boolean(busyKey),
                    onClick: () => { void onArchiveAction(selectedIds, true, false) },
                  }, '批量归档'),
                  h('button', {
                    type: 'button',
                    className: 'sec-btn sec-btn-sm',
                    disabled: selectedIds.length === 0 || Boolean(busyKey),
                    onClick: () => { void onArchiveAction(selectedIds, false, false) },
                  }, '批量取消归档'),
                  h('button', {
                    type: 'button',
                    className: 'sec-btn sec-btn-sm sec-btn-danger',
                    disabled: selectedIds.length === 0 || Boolean(busyKey),
                    onClick: () => openRecycleConfirm(selectedIds),
                  }, '🗑️ 批量移入回收站')
                )
              ),
              h('div', { className: 'sec-drawer-row' },
                h('select', {
                  className: 'sec-select',
                  value: batchPriority,
                  onChange: ev => setBatchPriority(ev.target.value),
                },
                  h('option', { value: '1' }, 'P1 最高'),
                  h('option', { value: '2' }, 'P2 高'),
                  h('option', { value: '3' }, 'P3 普通'),
                  h('option', { value: '4' }, 'P4 低'),
                  h('option', { value: '5' }, 'P5 最低')
                ),
                h('button', {
                  type: 'button',
                  className: 'sec-btn sec-btn-sm',
                  disabled: selectedIds.length === 0 || Boolean(busyKey),
                  onClick: () => { void onQuickAnnotate(selectedIds, { priority: Number(batchPriority) }, `批量设 P${batchPriority}`) },
                }, '设优先级'),
                h('input', {
                  className: 'sec-input',
                  style: { width: '150px' },
                  placeholder: '标签（逗号分隔）',
                  value: batchTagInput,
                  onChange: ev => setBatchTagInput(ev.target.value),
                }),
                h('button', {
                  type: 'button',
                  className: 'sec-btn sec-btn-sm',
                  disabled: selectedIds.length === 0 || !batchTagInput.trim() || Boolean(busyKey),
                  onClick: () => {
                    void onQuickAnnotate(selectedIds, { addTags: batchTagInput }, '批量加标签')
                    setBatchTagInput('')
                  },
                }, '+ 加标签'),
                h('select', {
                  className: 'sec-select',
                  value: batchMoveWs,
                  onChange: ev => setBatchMoveWs(ev.target.value),
                },
                  h('option', { value: '' }, '选择目标工作区…'),
                  catalogWorkspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.title))
                ),
                h('button', {
                  type: 'button',
                  className: 'sec-btn sec-btn-sm',
                  disabled: selectedIds.length === 0 || !batchMoveWs || Boolean(busyKey),
                  onClick: () => { void onMoveAction(selectedIds, batchMoveWs) },
                }, '批量移工作区')
              )
            )
            : null,

          renderPurgeArchivedBox(),
          renderRecycleConfirmBox(),

          // Session List
          catLoading && allCatalogRows.length === 0
            ? h('div', { className: 'sec-hint' }, '正在扫描会话与工作区目录…')
            : filteredRows.length === 0
              ? h('div', { className: 'sec-hint' }, '没有匹配当前筛选条件的会话。')
              : h('div', { className: 'sec-list' },
                filteredRows.slice(0, 120).map((row) => {
                  const ann = row.annotation || { favorite: false, reviewLater: false, priority: 3, tags: [], note: '' }
                  const pMeta = PRIORITY_META[ann.priority] || PRIORITY_META[3]
                  const selected = Boolean(selectedMap[row.sessionId])
                  const isEditing = editingSid === row.sessionId
                  const ecoPct = Math.min(100, Math.round((Number(row.maxGateProgress) || 0) * 100))

                  return h('div', {
                    className: 'sec-item',
                    key: row.sessionId,
                    'data-selected': String(selected),
                  },
                    h('div', { className: 'sec-item-top' },
                      h('div', { className: 'sec-item-left' },
                        (batchMode || selectedIds.length > 0)
                          ? h('input', {
                            type: 'checkbox',
                            checked: selected,
                            disabled: row.isBot,
                            onChange: () => toggleSelectOne(row.sessionId),
                          })
                          : null,
                        h('button', {
                          type: 'button',
                          className: 'sec-icon-btn',
                          title: ann.favorite ? '取消收藏' : '收藏会话',
                          'data-active': String(Boolean(ann.favorite)),
                          onClick: () => { void onQuickAnnotate([row.sessionId], { favorite: !ann.favorite }) },
                        }, ann.favorite ? '⭐' : '☆'),
                        h('button', {
                          type: 'button',
                          className: 'sec-icon-btn',
                          title: ann.reviewLater ? '取消待回看' : '标记待回看',
                          'data-active': String(Boolean(ann.reviewLater)),
                          onClick: () => { void onQuickAnnotate([row.sessionId], { reviewLater: !ann.reviewLater }) },
                        }, '📌'),
                        ann.priority !== 3
                          ? h('span', { className: 'sec-badge', 'data-tone': pMeta.tone }, pMeta.short)
                          : null,
                        h('div', {
                          className: 'sec-item-title',
                          title: ann.note ? `备注：${ann.note}` : `${row.title} (${row.sessionId})`,
                          onClick: () => openEditorFor(row),
                        }, row.title)
                      ),
                      h('div', { className: 'sec-tags' },
                        h('span', { className: 'sec-badge' }, row.workspaceTitle || '未分组'),
                        row.pinned ? h('span', { className: 'sec-badge', 'data-tone': 'brand' }, '置顶') : null,
                        row.archived ? h('span', { className: 'sec-badge', 'data-tone': 'muted' }, '已归档') : null,
                        row.isBot ? h('span', { className: 'sec-badge', 'data-tone': 'warn' }, '🤖Bot') : null,
                        row.activeSchedules > 0
                          ? h('span', { className: 'sec-badge', 'data-tone': 'ok', title: (row.scheduleTitles || []).join('、') }, `⏰×${row.activeSchedules}`)
                          : null,
                        row.status !== 'healthy'
                          ? h('span', {
                            className: 'sec-badge',
                            'data-tone': row.triggered ? 'danger' : 'warn',
                          }, `水位${ecoPct}%`)
                          : null,
                        (ann.tags || []).slice(0, 3).map(t =>
                          h('span', {
                            key: t,
                            className: 'sec-badge',
                            'data-tone': 'brand',
                            style: { cursor: 'pointer' },
                            onClick: () => setTagFilter(tagFilter === t.toLowerCase() ? '' : t.toLowerCase()),
                          }, `#${t}`)
                        ),
                        (ann.tags || []).length > 3
                          ? h('span', { className: 'sec-badge' }, `+${ann.tags.length - 3}`)
                          : null,
                        ann.note ? h('span', { className: 'sec-badge', title: ann.note }, '📝备注') : null,
                        row.updatedAt
                          ? h('span', { className: 'sec-hint', style: { fontSize: '11px' } }, formatRelativeTime(row.updatedAt))
                          : null,
                        h('button', {
                          type: 'button',
                          className: 'sec-btn sec-btn-sm',
                          onClick: () => onJumpSession(row.sessionId),
                        }, '打开'),
                        h('button', {
                          type: 'button',
                          className: isEditing ? 'sec-btn sec-btn-sm sec-btn-primary' : 'sec-btn sec-btn-sm',
                          onClick: () => openEditorFor(row),
                        }, isEditing ? '收起 ▴' : '整理 ▾')
                      )
                    ),

                    isEditing
                      ? h('div', { className: 'sec-drawer' },
                        // Row 1: Priority + Pin + Archive + Handover + Delete
                        h('div', { className: 'sec-drawer-row', style: { justifyContent: 'space-between' } },
                          h('div', { className: 'sec-tags' },
                            h('span', { className: 'sec-drawer-label' }, '优先级'),
                            [1, 2, 3, 4, 5].map(p =>
                              h('button', {
                                key: p,
                                type: 'button',
                                className: 'sec-pill',
                                'data-active': String(ann.priority === p),
                                onClick: () => { void onQuickAnnotate([row.sessionId], { priority: p }, `已设优先级 P${p}`) },
                              }, PRIORITY_META[p].label)
                            )
                          ),
                          h('div', { className: 'sec-tags' },
                            h('button', {
                              type: 'button',
                              className: 'sec-btn sec-btn-sm',
                              onClick: () => { void onPinAction([row.sessionId], !row.pinned) },
                            }, row.pinned ? '取消置顶' : '置顶侧栏'),
                            h('button', {
                              type: 'button',
                              className: 'sec-btn sec-btn-sm',
                              disabled: row.isBot,
                              onClick: () => { void onArchiveAction([row.sessionId], !row.archived, false) },
                            }, row.archived ? '恢复到侧栏' : '归档隐藏'),
                            !row.archived && !row.isBot
                              ? h('button', {
                                type: 'button',
                                className: confirmSid === row.sessionId ? 'sec-btn sec-btn-sm sec-btn-warn' : 'sec-btn sec-btn-sm',
                                onClick: () => { void onManualHandover(row) },
                              }, confirmSid === row.sessionId ? '确认换卷?' : '♻️ 换卷继承')
                              : null,
                            !row.isBot
                              ? h('button', {
                                type: 'button',
                                className: 'sec-btn sec-btn-sm sec-btn-danger',
                                onClick: () => openRecycleConfirm([row.sessionId]),
                              }, '🗑️ 移入回收站')
                              : null
                          )
                        ),

                        // Row 2: Rename + Move Workspace
                        h('div', { className: 'sec-drawer-row' },
                          h('span', { className: 'sec-drawer-label' }, '标题'),
                          h('input', {
                            className: 'sec-input',
                            style: { flex: '1 1 200px' },
                            value: editTitle,
                            onChange: ev => setEditTitle(ev.target.value),
                          }),
                          h('button', {
                            type: 'button',
                            className: 'sec-btn sec-btn-sm',
                            disabled: busyKey === `rename:${row.sessionId}`,
                            onClick: () => { void onRenameRow(row.sessionId) },
                          }, '保存标题'),
                          h('span', { className: 'sec-drawer-label', style: { marginLeft: '6px' } }, '工作区'),
                          h('select', {
                            className: 'sec-select',
                            value: editMoveWs,
                            onChange: ev => setEditMoveWs(ev.target.value),
                          },
                            h('option', { value: '' }, '选择工作区…'),
                            catalogWorkspaces.map(ws => h('option', { key: ws.id, value: ws.id }, ws.title))
                          ),
                          h('button', {
                            type: 'button',
                            className: 'sec-btn sec-btn-sm',
                            disabled: row.isBot || !editMoveWs || editMoveWs === row.workspaceId || busyKey === 'move',
                            onClick: () => { void onMoveAction([row.sessionId], editMoveWs) },
                          }, '移至此工作区')
                        ),

                        // Row 3: Tags + Note
                        h('div', { className: 'sec-drawer-row' },
                          h('span', { className: 'sec-drawer-label' }, '标签'),
                          h('input', {
                            className: 'sec-input',
                            style: { flex: '1 1 240px' },
                            placeholder: '多个标签用英文或中文逗号分隔，例如：量化, 巡检, 核心',
                            value: editTags,
                            onChange: ev => setEditTags(ev.target.value),
                          })
                        ),
                        h('div', { className: 'sec-drawer-row', style: { alignItems: 'flex-start' } },
                          h('span', { className: 'sec-drawer-label', style: { paddingTop: '6px' } }, '备注'),
                          h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' } },
                            h('textarea', {
                              className: 'sec-textarea',
                              placeholder: '记录该会话的背景、待办或保留原因（最多 2000 字，换卷时自动继承到 #2/#3）…',
                              value: editNote,
                              onChange: ev => setEditNote(ev.target.value),
                            }),
                            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
                              h('span', { className: 'sec-detail' }, `ID: ${row.sessionId} ｜ 目录: ${row.cwd || '-'}`),
                              h('button', {
                                type: 'button',
                                className: 'sec-btn sec-btn-sm sec-btn-primary',
                                disabled: busyKey === 'annotate',
                                onClick: () => {
                                  void onQuickAnnotate([row.sessionId], { tags: editTags, note: editNote }, '已保存标签与备注')
                                },
                              }, '保存标签与备注')
                            )
                          )
                        )
                      )
                      : null
                  )
                })
              )
        )

        const renderHistoryTab = () => h('div', { className: 'sec-card' },
          h('div', { className: 'sec-card-head' },
            h('div', { className: 'sec-card-title' }, `归档继承记录（最近 ${history.length} 条）`),
            h('span', { className: 'sec-hint' }, `台账共 ${summary.totalHistoricalHandovers ?? history.length} 条`)
          ),
          h('div', { className: 'sec-hint' },
            '每次自动或手动换卷均持久化留档（含收藏/优先级/标签/备注自动继承），支持一键跳往新对话、只读回看已归档旧对话、恢复旧对话到侧栏，或直接展开查看当时的《会话交接单》。'
          ),
          history.length === 0
            ? h('div', { className: 'sec-hint' }, '暂无换卷继承记录。')
            : h('div', { className: 'sec-list' },
              history.map((rec) => {
                const docOpen = expandedHandoff === rec.oldSessionId
                const schedCount = Array.isArray(rec.migratedSchedules) ? rec.migratedSchedules.length : 0
                const m = rec.metrics || {}
                return h('div', { className: 'sec-item', key: `${rec.oldSessionId}->${rec.newSessionId}-${rec.at}` },
                  h('div', { className: 'sec-item-top' },
                    h('div', {
                      className: 'sec-item-title',
                      onClick: () => { void onToggleHandoffDoc(rec.oldSessionId) },
                    }, `${rec.oldTitle || rec.oldSessionId.slice(0, 14)} → ${rec.newTitle || `#${rec.generation || 2}`}`),
                    h('div', { className: 'sec-tags' },
                      rec.workspaceTitle
                        ? h('span', { className: 'sec-badge' }, rec.workspaceTitle)
                        : null,
                      h('span', { className: 'sec-badge' }, triggerLabel(rec.trigger)),
                      schedCount > 0
                        ? h('span', { className: 'sec-badge', 'data-tone': 'ok' }, `迁任务×${schedCount}`)
                        : null,
                      h('span', {
                        className: 'sec-badge',
                        'data-tone': rec.archived ? 'ok' : 'warn',
                      }, rec.archived ? '旧卷已归档' : '旧卷在侧栏')
                    )
                  ),
                  h('div', { className: 'sec-detail' },
                    `${rec.timeText || rec.at || ''} ｜ 换卷前：压后 ${compactTok(m.pressureTokens)} · 表面 ${compactTok(m.surfaceTokens)} · 累计 ${compactTok(m.totalTokens)}` +
                    (Array.isArray(rec.reasons) && rec.reasons.length ? ` ｜ 原因：${rec.reasons.join('；')}` : '')
                  ),
                  h('div', { className: 'sec-actions' },
                    h('button', {
                      type: 'button',
                      className: 'sec-btn sec-btn-sm sec-btn-primary',
                      onClick: () => onJumpSession(rec.newSessionId),
                    }, '打开新对话'),
                    h('button', {
                      type: 'button',
                      className: 'sec-btn sec-btn-sm',
                      onClick: () => onJumpSession(rec.oldSessionId),
                    }, '回看旧卷'),
                    rec.archived
                      ? h('button', {
                        type: 'button',
                        className: 'sec-btn sec-btn-sm',
                        disabled: busyKey === `unarchive:${rec.oldSessionId}`,
                        onClick: () => { void onUnarchiveOld(rec.oldSessionId) },
                      }, busyKey === `unarchive:${rec.oldSessionId}` ? '恢复中…' : '恢复旧卷到侧栏')
                      : null,
                    h('button', {
                      type: 'button',
                      className: 'sec-btn sec-btn-sm',
                      onClick: () => { void onToggleHandoffDoc(rec.oldSessionId) },
                    }, docOpen ? '收起交接单 ▴' : '查看交接单 ▾')
                  ),
                  docOpen
                    ? h('pre', { className: 'sec-pre' }, handoffDocs[rec.oldSessionId] || '加载中…')
                    : null
                )
              })
            )
        )

        const renderMemoryTab = () => {
          const memSummary = memReport?.summary || {}
          const memCaps = memReport?.caps || {
            maxBytes: settings.projectMemoryMaxBytes || 15360,
            maxLines: settings.projectMemoryMaxLines || 250,
            guardEnabled: settings.enabled !== false && settings.projectMemoryGuardEnabled !== false,
            reminderEnabled: settings.enabled !== false && settings.projectMemoryReminderEnabled !== false,
          }
          const dejaInfo = memReport?.deja || { mode: 'not-installed' }
          const allProjects = Array.isArray(memReport?.projects) ? memReport.projects : []
          const visibleProjects = filterProjectMemories(allProjects, { mode: memMode, search: memSearch })
          const warnOrOverCount = (memSummary.warnCount || 0) + (memSummary.overCount || 0)

          const dejaBadgeText = dejaInfo.mode === 'on-demand'
            ? `dsh-deja@${dejaInfo.version || '已装'} · 按需冷回溯 (autoRecall=false)`
            : dejaInfo.mode === 'auto-recall'
              ? `dsh-deja@${dejaInfo.version || '已装'} · 自动召回开启（建议改 false）`
              : 'dsh-deja 未挂载'
          const dejaTone = dejaInfo.mode === 'on-demand' ? 'ok' : dejaInfo.mode === 'auto-recall' ? 'warn' : 'muted'

          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            // 4 KPIs
            h('div', { className: 'sec-kpis' },
              h('div', { className: 'sec-kpi' },
                h('span', { className: 'sec-kpi-label' }, '已建 PROJECT.md'),
                h('span', { className: 'sec-kpi-val' }, memSummary.withProjectMdCount ?? '-')
              ),
              h('div', { className: 'sec-kpi' },
                h('span', { className: 'sec-kpi-label' }, '四段式健康达标'),
                h('span', { className: 'sec-kpi-val', 'data-tone': 'ok' }, memSummary.healthyCount ?? '-')
              ),
              h('div', { className: 'sec-kpi' },
                h('span', { className: 'sec-kpi-label' }, '预警 / 超容量红线'),
                h('span', {
                  className: 'sec-kpi-val',
                  'data-tone': (memSummary.overCount || 0) > 0 ? 'danger' : warnOrOverCount > 0 ? 'warn' : 'ok',
                }, memReport ? `${memSummary.warnCount || 0} / ${memSummary.overCount || 0}` : '-')
              ),
              h('div', { className: 'sec-kpi' },
                h('span', { className: 'sec-kpi-label' }, '本地失效死链数'),
                h('span', {
                  className: 'sec-kpi-val',
                  'data-tone': (memSummary.totalBrokenLinks || 0) > 0 ? 'danger' : 'ok',
                }, memSummary.totalBrokenLinks ?? '-')
              )
            ),

            // Architecture & Dual-Layer Status Card
            h('div', { className: 'sec-card' },
              h('div', { className: 'sec-card-head' },
                h('div', { className: 'sec-card-title' }, '双层项目记忆护栏状态（Route C 跨 AI 单真源）'),
                h('button', {
                  type: 'button',
                  className: 'sec-btn sec-btn-sm',
                  disabled: memLoading,
                  onClick: () => { void loadProjectMemory() },
                }, memLoading ? '扫描中…' : '重新扫描全部工作区')
              ),
              h('div', { className: 'sec-tags' },
                h('span', {
                  className: 'sec-badge',
                  'data-tone': memCaps.guardEnabled ? 'ok' : 'muted',
                }, memCaps.guardEnabled
                  ? `🛡️ 写入硬闸门开启（≤ ${(memCaps.maxBytes / 1024).toFixed(1)} KB / ≤ ${memCaps.maxLines} 行，变小放行）`
                  : '⏸️ 写入硬闸门已停用'),
                h('span', {
                  className: 'sec-badge',
                  'data-tone': memCaps.reminderEnabled ? 'brand' : 'muted',
                }, memCaps.reminderEnabled
                  ? '🔔 压缩/换卷前静默落盘提醒开启（≥ 24% W）'
                  : '⏸️ 压缩前提醒已停用'),
                h('span', { className: 'sec-badge', 'data-tone': dejaTone }, `🔍 ${dejaBadgeText}`)
              ),
              h('div', { className: 'sec-hint' },
                '热层由各项目根 PROJECT.md 承载当前铁律与活跃待办，供 DSH / Codex / Antigravity / Claude Code 共读；冷层由 docs/HISTORY.md 归档完成项，搭配 dsh-deja 只读跨端检索历史排障会话（禁用 deja_remember 另立第二账本）。'
              )
            ),

            // Filter + Project List Card
            h('div', { className: 'sec-card' },
              h('div', { className: 'sec-card-head' },
                h('div', { className: 'sec-card-title' }, `工作区项目记忆体检明细（显示 ${visibleProjects.length} / 共 ${allProjects.length} 个根目录）`),
                memReport?.scannedAt
                  ? h('span', { className: 'sec-hint' }, `上次扫描：${new Date(memReport.scannedAt).toLocaleTimeString()}`)
                  : null
              ),
              h('div', { className: 'sec-filter-grid' },
                h('button', {
                  type: 'button',
                  className: 'sec-pill',
                  'data-active': String(memMode === 'with_project'),
                  onClick: () => setMemMode('with_project'),
                }, `📘 已建 PROJECT.md (${memSummary.withProjectMdCount ?? 0})`),
                h('button', {
                  type: 'button',
                  className: 'sec-pill',
                  'data-active': String(memMode === 'issues'),
                  onClick: () => setMemMode('issues'),
                }, `⚠️ 仅看超标 / 预警 / 死链 (${warnOrOverCount})`),
                h('button', {
                  type: 'button',
                  className: 'sec-pill',
                  'data-active': String(memMode === 'all'),
                  onClick: () => setMemMode('all'),
                }, `📂 全部工作区 (${memSummary.totalWorkspaces ?? 0})`),
                h('input', {
                  type: 'search',
                  className: 'sec-input',
                  style: { minWidth: '180px', flex: '1 1 180px' },
                  placeholder: '搜索工作区名称、路径或失效链接…',
                  value: memSearch,
                  onChange: (e) => setMemSearch(e.target.value),
                })
              ),

              memLoading && !memReport
                ? h('div', { className: 'sec-hint' }, '正在扫描本机注册工作区的 PROJECT.md 与本地链接…')
                : visibleProjects.length === 0
                  ? h('div', { className: 'sec-hint' }, '当前筛选条件下暂无匹配的工作区项目。')
                  : h('div', { className: 'sec-list' },
                    visibleProjects.map((proj) => {
                      const isOpen = expandedMemKey === proj.key
                      const statusBadge = !proj.hasProjectMd
                        ? { tone: 'muted', label: '未建 PROJECT.md' }
                        : proj.status === 'over'
                          ? { tone: 'danger', label: proj.overCap ? '超容量红线' : '存在死链' }
                          : proj.status === 'warn'
                            ? { tone: 'warn', label: '逼近红线 / 待规范' }
                            : { tone: 'ok', label: '健康达标' }

                      const bytePct = Math.min(100, Math.round((proj.byteRatio || 0) * 100))
                      const linePct = Math.min(100, Math.round((proj.lineRatio || 0) * 100))
                      const byteTone = (proj.byteRatio || 0) > 1 ? 'danger' : (proj.byteRatio || 0) >= 0.85 ? 'warn' : undefined
                      const lineTone = (proj.lineRatio || 0) > 1 ? 'danger' : (proj.lineRatio || 0) >= 0.85 ? 'warn' : undefined
                      const brokenCount = Array.isArray(proj.brokenLinks) ? proj.brokenLinks.length : 0

                      return h('div', { key: proj.key, className: 'sec-item' },
                        h('div', { className: 'sec-item-top' },
                          h('div', { className: 'sec-item-left' },
                            h('span', {
                              className: 'sec-item-title',
                              title: proj.projectRoot,
                              onClick: () => setExpandedMemKey(isOpen ? '' : proj.key),
                            }, proj.title || proj.projectRoot),
                            h('span', { className: 'sec-badge', 'data-tone': statusBadge.tone }, statusBadge.label)
                          ),
                          proj.hasProjectMd
                            ? h('span', { className: 'sec-hint' }, proj.updatedAt ? `更新于 ${formatRelativeTime(proj.updatedAt)}` : '')
                            : null
                        ),

                        h('div', { className: 'sec-detail' },
                          `根目录：${proj.projectRoot}`,
                          Array.isArray(proj.workspaceTitles) && proj.workspaceTitles.length > 1
                            ? ` ｜ 共用工作区：${proj.workspaceTitles.join('、')}`
                            : ''
                        ),

                        proj.hasProjectMd
                          ? h('div', { className: 'sec-mem-bars' },
                            h('div', { className: 'sec-mem-bar' },
                              h('div', { className: 'sec-mem-bar-label' },
                                h('span', null, '字节容量'),
                                h('span', null, `${(proj.bytes / 1024).toFixed(2)} / ${(proj.maxBytes / 1024).toFixed(1)} KB (${Math.round((proj.byteRatio || 0) * 100)}%)`)
                              ),
                              h('div', { className: 'sec-meter', 'data-tone': byteTone },
                                h('span', { style: { width: `${bytePct}%` } })
                              )
                            ),
                            h('div', { className: 'sec-mem-bar' },
                              h('div', { className: 'sec-mem-bar-label' },
                                h('span', null, '行数水位'),
                                h('span', null, `${proj.lines} / ${proj.maxLines} 行 (${Math.round((proj.lineRatio || 0) * 100)}%)`)
                              ),
                              h('div', { className: 'sec-meter', 'data-tone': lineTone },
                                h('span', { style: { width: `${linePct}%` } })
                              )
                            )
                          )
                          : null,

                        proj.hasProjectMd
                          ? h('div', { className: 'sec-tags' },
                            h('span', {
                              className: 'sec-badge',
                              'data-tone': proj.hasFourSections ? 'ok' : 'warn',
                            }, `四段式 ${proj.fourSectionScore || 0}/4`),
                            h('span', {
                              className: 'sec-badge',
                              'data-tone': (proj.completedItemCount || 0) > 10 ? 'warn' : 'muted',
                            }, `最近完成 ${proj.completedItemCount || 0}/10 条`),
                            h('span', {
                              className: 'sec-badge',
                              'data-tone': proj.hasHistoryMd ? 'brand' : 'muted',
                            }, proj.hasHistoryMd ? `docs/HISTORY.md (${(proj.historyBytes / 1024).toFixed(1)} KB)` : '未建 HISTORY.md'),
                            proj.dshRulesCount > 0
                              ? h('span', { className: 'sec-badge', 'data-tone': 'brand' }, `.dsh/rules (${proj.dshRulesCount})`)
                              : null,
                            h('span', {
                              className: 'sec-badge',
                              'data-tone': brokenCount > 0 ? 'danger' : 'ok',
                            }, brokenCount > 0 ? `⚠️ 死链 ${brokenCount} 处` : `本地链接 ${proj.totalLocalLinks || 0} 处全通`)
                          )
                          : null,

                        h('div', { className: 'sec-actions' },
                          proj.hasProjectMd
                            ? h('button', {
                              type: 'button',
                              className: proj.status !== 'healthy' ? 'sec-btn sec-btn-sm sec-btn-primary' : 'sec-btn sec-btn-sm',
                              onClick: async () => {
                                const ok = await copyTextToClipboard(proj.slimPrompt)
                                setBanner({
                                  ok,
                                  text: ok
                                    ? `已复制「${proj.title}」的 PROJECT.md 原地瘦身整理指令，可直接粘贴给任意 AI 执行。`
                                    : '复制整理指令失败，请展开详情手动复制。',
                                })
                              },
                            }, '📋 复制瘦身整理指令')
                            : null,
                          h('button', {
                            type: 'button',
                            className: 'sec-btn sec-btn-sm',
                            onClick: async () => {
                              const target = proj.hasProjectMd ? proj.projectMdPath : proj.projectRoot
                              const ok = await copyTextToClipboard(target)
                              setBanner({
                                ok,
                                text: ok ? `已复制路径：${target}` : '复制路径失败',
                              })
                            },
                          }, proj.hasProjectMd ? '复制 PROJECT.md 路径' : '复制根目录路径'),
                          proj.hasProjectMd && (brokenCount > 0 || proj.slimPrompt)
                            ? h('button', {
                              type: 'button',
                              className: 'sec-btn sec-btn-sm',
                              onClick: () => setExpandedMemKey(isOpen ? '' : proj.key),
                            }, isOpen ? '收起详情 ▴' : '死链与指令详情 ▾')
                            : null
                        ),

                        isOpen && proj.hasProjectMd
                          ? h('div', { className: 'sec-drawer' },
                            brokenCount > 0
                              ? h('div', { className: 'sec-detail' },
                                `⚠️ 检测到 ${brokenCount} 处失效本地链接：${proj.brokenLinks.join(' 、 ')}`
                              )
                              : h('div', { className: 'sec-detail' }, '✅ 项目内相对路径与 file:// 链接全部可访问。'),
                            h('pre', { className: 'sec-pre' }, proj.slimPrompt || '')
                          )
                          : null
                      )
                    })
                  )
            )
          )
        }

        return h('div', { className: 'sec-page' },
          // Header
          h('div', { className: 'sec-head' },
            h('div', null,
              h('div', { className: 'sec-head-title' },
                h('span', { className: 'sec-dot', 'data-on': String(settings.enabled !== false) }),
                '会话生态守卫与项目记忆中心'
              ),
              h('div', { className: 'sec-sub' },
                '集「自适应换卷继承」、「人工整理旧会话（收藏 / 标签 / 优先级 / 批量归档）」与「跨 AI 单真源 PROJECT.md 容量硬闸门 + 体检」于一体。'
              )
            ),
            h('div', { className: 'sec-toolbar' },
              h('button', {
                type: 'button',
                className: 'sec-btn',
                disabled: loading || memLoading || Boolean(busyKey),
                onClick: () => {
                  void loadStatus({ syncForm: !dirty })
                  if (activeTab === 'organize') void loadCatalog()
                  if (activeTab === 'memory') void loadProjectMemory()
                },
              }, (loading || memLoading) ? '刷新中…' : '刷新状态'),
              h('button', {
                type: 'button',
                className: 'sec-btn sec-btn-primary',
                disabled: busyKey === 'sweep',
                onClick: () => { void onSweep() },
              }, busyKey === 'sweep' ? '清扫中…' : '一键清扫超标巡检')
            )
          ),

          // 4-Tab Switcher
          h('div', { className: 'sec-tabs', role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'sec-tab',
              'data-active': String(activeTab === 'ecology'),
              onClick: () => setActiveTab('ecology'),
            }, '🛡️ 生态守卫 & 阈值'),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'sec-tab',
              'data-active': String(activeTab === 'organize'),
              onClick: () => setActiveTab('organize'),
            }, `🗂️ 会话整理 & 批量${catalogCounts.total ? ` (${catalogCounts.total})` : ''}`),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'sec-tab',
              'data-active': String(activeTab === 'history'),
              onClick: () => setActiveTab('history'),
            }, `📜 换卷继承台账 (${summary.totalHistoricalHandovers ?? history.length})`),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'sec-tab',
              'data-active': String(activeTab === 'memory'),
              onClick: () => setActiveTab('memory'),
            }, `📘 项目记忆体检${memSummaryCountBadge(memReport)}`)
          ),

          banner
            ? h('div', { className: 'sec-banner', 'data-ok': String(banner.ok) }, banner.text)
            : null,

          activeTab === 'ecology'
            ? renderEcologyTab()
            : activeTab === 'organize'
              ? renderOrganizeTab()
              : activeTab === 'memory'
                ? renderMemoryTab()
                : renderHistoryTab()
        )
      }
    }

    function apply(ctx) {
      let uiWorkspaceRef = null
      const eventListeners = new Set()

      const emitLocalEvent = (ev) => {
        for (const fn of eventListeners) {
          try { fn(ev) } catch {}
        }
      }

      const subscribeEvents = (fn) => {
        eventListeners.add(fn)
        return () => { eventListeners.delete(fn) }
      }

      try {
        ctx.inject?.(['uiWorkspace'], (scoped) => {
          uiWorkspaceRef = scoped.uiWorkspace
          scoped.effect?.(() => () => {
            if (uiWorkspaceRef === scoped.uiWorkspace) uiWorkspaceRef = null
          }, 'session-ecology: uiWorkspace ref')
        })
      } catch {}

      const getSessions = () => {
        try { return ctx.sessions ?? ctx.get?.('sessions') } catch { return undefined }
      }
      const getUiWorkspace = () => {
        if (uiWorkspaceRef) return uiWorkspaceRef
        try { return ctx.get?.('uiWorkspace') } catch { return undefined }
      }

      const openSession = (sessionId) => {
        const uiWs = getUiWorkspace()
        if (typeof uiWs?.openSession === 'function' && sessionId) {
          try {
            uiWs.openSession(sessionId)
            return true
          } catch {}
        }
        return false
      }

      // Register Settings section (`设置 -> 会话生态 / 会话管理`) lazily.
      const registerSection = (slotsSvc) => {
        if (!slotsSvc || typeof slotsSvc.inject !== 'function' || typeof slotsSvc.register !== 'function') return
        const Section = createSettingsSection({ openSession, subscribeEvents })
        slotsSvc.inject('settings.section', () => {
          return slotsSvc.register({
            name: 'settings.section',
            id: 'session-ecology',
            order: 92,
            label: () => '会话生态 / 会话管理',
          }, Section)
        })
      }

      if (ctx?.slots) {
        registerSection(ctx.slots)
      } else {
        try {
          ctx.inject?.(['slots'], (sctx) => {
            registerSection(sctx.slots)
          })
        } catch {}
      }

      const seenPhaseKeys = new Set()
      let lastSeenIso = new Date().toISOString()

      async function handleHandoverEvent(ev) {
        if (!ev || typeof ev !== 'object') return
        emitLocalEvent(ev)
        if (ev.at && ev.at > lastSeenIso) lastSeenIso = ev.at

        if (ev.type === 'phase' && ev.phase === 'summarizing' && ev.sessionId) {
          const sessionsSvc = getSessions()
          if (!isViewingSession(sessionsSvc, ev.sessionId)) return
          const key = `${ev.sessionId}:${ev.phase}`
          if (seenPhaseKeys.has(key)) return
          seenPhaseKeys.add(key)
          showEcologyToast({
            title: '♻️ 当前会话已达生态线，正在自总结交接新卷…',
            detail: Array.isArray(ev.reasons) ? ev.reasons.join('；') : '',
            durationMs: 4500,
          })
          return
        }

        if (ev.type !== 'handover' || !ev.oldSessionId || !ev.newSessionId) return
        const sessionsSvc = getSessions()
        const viewingOld = isViewingSession(sessionsSvc, ev.oldSessionId)
        const detail = `${ev.oldTitle || ''} → ${ev.newTitle || ''}${Array.isArray(ev.reasons) && ev.reasons.length ? `（${ev.reasons.join('；')}）` : ''}`

        if (!viewingOld) {
          showEcologyToast({
            title: `♻️ 后台已换卷：${ev.newTitle || ev.newSessionId.slice(0, 12)}`,
            detail,
            onOpen: () => { openSession(ev.newSessionId) },
          })
          return
        }

        if (hasAlreadyOpened(ev.oldSessionId, ev.newSessionId)) return

        const draft = readComposerDraft()
        await waitForCatalogEntry(sessionsSvc, ev.newSessionId)
        if (openSession(ev.newSessionId)) {
          if (draft) restoreComposerDraft(draft)
          showEcologyToast({
            title: `♻️ 已自动切至新卷：${ev.newTitle || ''}`,
            detail,
          })
        }
      }

      const start = () => {
        let es = null
        let disposed = false
        let reconnectTimer = null

        const closeStream = () => {
          clearTimeout(reconnectTimer)
          if (es) {
            try { es.close() } catch {}
            es = null
          }
        }

        const catchUpSinceLastSeen = () => {
          window.fetch(`${ROUTE_BASE}/status?since=${encodeURIComponent(lastSeenIso)}`, {
            credentials: 'same-origin',
          })
            .then(r => (r.ok ? r.json() : null))
            .then((data) => {
              if (!data || !Array.isArray(data.events)) return
              for (const item of data.events) {
                void handleHandoverEvent({ type: 'handover', ...item })
              }
            })
            .catch(() => {})
        }

        const openStream = () => {
          if (disposed || es || typeof window.EventSource !== 'function') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            es = new window.EventSource(`${ROUTE_BASE}/events`)
            es.onmessage = (msg) => {
              try {
                const payload = JSON.parse(msg.data)
                if (payload?.type === 'hello') return
                void handleHandoverEvent(payload)
              } catch {}
            }
            es.onerror = () => {
              closeStream()
              if (!disposed) {
                reconnectTimer = setTimeout(openStream, 6000)
              }
            }
          } catch {}
        }

        const onVisibility = () => {
          if (document.visibilityState === 'hidden') {
            closeStream()
            return
          }
          catchUpSinceLastSeen()
          openStream()
        }

        openStream()
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility)
        }

        return () => {
          disposed = true
          closeStream()
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(start, 'session-ecology: sse watch')
      } else {
        const stop = start()
        ctx.on?.('dispose', stop)
      }
    }

    function memSummaryCountBadge(report) {
      const s = report?.summary
      if (!s) return ''
      const issues = (s.overCount || 0) + (s.warnCount || 0)
      if (issues > 0) return ` (${s.withProjectMdCount || 0} · ⚠️${issues})`
      return ` (${s.withProjectMdCount || 0})`
    }

    exports.name = NAME
    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    exports.__internal = {
      DEFAULT_SETTINGS,
      PRIORITY_META,
      compactTok,
      formatRatioPreview,
      formatMultPreview,
      settingsToForm,
      sanitizeDraftSettings,
      filterProjectMemories,
      triggerLabel,
      filterAndSortCatalog,
      formatBatchResultBanner,
      formatPurgeArchivedBanner,
    }
    return module.exports
  },
})
