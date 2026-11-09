# dsh-session-ecology

**DeepSeek Harness (DSH) 会话生态管家、人工会话整理工作台、零重启归档/孤儿回收站清理与 `PROJECT.md` 项目记忆护栏插件（含 4-Tab Web 设置面板）。**

`dsh-session-ecology` 面向长期运行的 DSH Web 宿主与定时巡检舰队，解决长会话上下文膨胀、多代折叠失忆、定时任务换卷断档、旧归档与孤儿缓存堆积，以及工作区 `PROJECT.md` 无限膨胀等问题。所有破坏性文件清理均默认移入**操作系统回收站**（Windows `$Recycle.Bin` / macOS `~/.Trash` / Linux FreeDesktop Trash），不直接物理抹除。

---

## 核心能力一览

### 1. 模型自适应三闸门空闲换卷（Session Ecology Steward）
- **三闸门动态阈值**（随会话模型真实上下文窗口 $W$ 自动缩放）：
  1. **压后真实负载闸门（Gate 1）**：`pressureTokens >= 0.40 * W`（默认 40%）
  2. **表面对话体积闸门（Gate 2）**：`surfaceTokens >= 1.00 * W`（默认 100%）
  3. **多代折叠疲劳闸门（Gate 3）**：标准模型累计 `totalTokens >= 350 * W`；高阶/高成本模型（Pro / Opus / GPT-5/6 / o1/o3 / `*-responses`）累计 `totalTokens >= 150 * W`
- **绝不打断在途回合**：仅在 `turn/end`（`completed`）且会话收件箱完全空闲时触发，在热 KV 缓存上完成结构化自总结（超时或异常自动降级为确定性日志机械提取兜底）。
- **完整上下文与配置继承（含上卷对话回忆锚点，v0.8.0）**：同工作区创建续接会话（自动命名为 `原名 · #2`、`#3`，严格遵循 80 字节 UTF-8 上限并防止首轮自动改名覆盖），完整继承 `agentPreset`、`modelSelection`（不污染全局默认模型）、`permissionPreset`、置顶状态与人工整理批注（收藏/优先级/标签/备注）；自动从上卷日志提取**最后一轮真实问答实录**（自动过滤系统注入上下文、`reasoning` 思维链与自总结轮次），并在新卷首条回执中用 4 行精炼小总结交代 **「之前在干什么 / 最后你说 / 最后它回」**。
- **定时任务原子迁移**：采用 `新建 → 回读校验 → 删除旧任务` 三段式原子迁移，任一步失败自动回滚且保留旧会话不归档，杜绝漏跑或双跑。
- **通道会话隔离**：自动识别并跳过 `bot/state.json` 管理的外部机器人会话与子代理（`subagent`）会话。

### 2. 人工会话整理工作台（Session Organizer）
- **非侵入式元数据批注**：支持 `⭐ 收藏`、`🔖 待复盘`、`P1~P5 优先级`、中英文多标签与备注，独立存储于 `storages/session-ecology.json`，零污染 `session.v4.jsonl`。
- **批量治理与孤儿任务防呆**：支持多选批量归档/取消归档、置顶/取消置顶；默认拦截仍挂载活跃 `schedule` 的会话被误归档或误删。
- **零重启跨工作区搬家**：在线迁移会话至目标工作区，同步更新 `workspaceRegistry`、会话头 `cwd`、`working-directory/change` 事件与 `session_projcache`，无需重启 DSH 宿主。
- **系统回收站级联清理**：清理主会话时自动级联其派生 `subagent` 目录与缓存文件，全部移入系统回收站并记录审计台账。

### 3. 零重启「清理已归档 / 真孤儿目录 / 幽灵 ID / 孤儿缓存」（v0.5.0–v0.8.0）
- **无需停机或杀进程**：直接在宿主内存中解绑已归档旧会话，告别传统停机清理脚本。
- **多重安全护栏与未分组活跃会话保护**：
  - 正常活跃工作区会话与含真实聊天记录的 **「未分组」活跃对话** 100% 免疫（仅回收已归档会话及 0 消息空壳 / 失效目录 / 工作区脱挂真孤儿目录）；
  - **活跃定时任务保护**与**重要批注保护**（默认跳过挂有活跃 `schedule` 或标有 `⭐ 收藏` / `🔖 待复盘` 的会话）；
  - **最近活跃时间锁**（默认保护最近 `60` 分钟内仍有写入的会话，支持 `active_guard_minutes=0` 显式放行）。
- **诚实空间计量与全量孤儿缓存对账**：清晰区分「从 `sessions/` 移入系统回收站的字节数（可随时还原）」与「清空回收站后真实腾出的磁盘可用空间」，并同步对账 `storages` 下各会话缓存目录的无主 JSON。

### 4. `PROJECT.md` 长期记忆护栏与健康巡检（v0.4.0）
- **写入前硬护栏（`tools.guard`）**：默认限制工作区 `PROJECT.md` 不超过 **`15 KB`（15,360 B）且不超过 `250` 行**，引导将历史流水沉淀至 `docs/HISTORY.md`；内置**单调缩减放行**（对存量已超标文件允许净体积/行数缩减的瘦身编辑，绝不死锁）。
- **高水位交互提醒（`systemPrompt.context`）**：当交互式会话（非定时巡检、非子代理）临近压缩水位时，自动提醒模型在收尾前同步架构决策与踩坑铁律至 `PROJECT.md`。
- **多工作区只读巡检**：扫描全部注册工作区的 `PROJECT.md` 字节数、行数、四段式结构、`docs/HISTORY.md` 配套与本地失效相对链接。

### 5. 对话框底部换卷距离进度条与四标签页 Web 设置面板
- **底部状态栏换卷进度条（`conversation.composer.dock`，v0.7.0）**：在对话输入框下方（Token 用量与费用状态栏之间）实时展示当前会话距离自动换卷的三闸门最高水位条与卷号徽章（`#2`、`#3`）；悬停查看剩余百分比，点击弹出三闸门实时明细并支持二次确认 **「♻️ 立即换卷继承」**（零轮询定时器，基于客户端投影 + 回合结束 SSE 增量推送；桌面端同步自适应修复底部状态栏截断）。
- **四标签页设置中心**：在 DSH Web 端 **`设置 → 会话生态 / 会话管理`** 提供实时管理界面（基于 SSE 推送）：
  1. **🩺 生态水位**：实时查看三闸门进度、在途换卷阶段、手动换卷与历史交接单（Markdown 抽屉预览）。
  2. **🗂️ 会话整理**：多维筛选/排序、星标/标签/备注编辑、跨工作区搬家、批量归档/回收，以及 **「🧹 清理已归档」** 先盘点（Dry-Run）后执行抽屉。
  3. **📐 项目记忆**：跨工作区 `PROJECT.md` 容量进度条与断链告警面板。
  4. **⚙️ 阈值设置**：在线调整三闸门比例、疲劳倍数、`PROJECT.md` 护栏上限与底部进度条开关，立即持久化生效。

---

## 环境要求

- **Node.js**：`>= 22.19.0`
- **宿主环境**：`@deepseek-ai/dsh`（Web Profile，含 `@deepseek-ai/cordis ^4.0.1` 与 `@deepseek-ai/dsh-tools`）

---

## 安装与挂载

### 方式一：通过 Release `.tgz` 包安装（推荐）

1. 从 [Releases](https://github.com/ksoulness/dsh-session-ecology/releases) 下载最新 `dsh-session-ecology-0.8.0.tgz`（或克隆仓库后执行 `npm pack`），放置于 `$DSH_HOME/plugins/` 目录。
2. 在 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 中添加引用并安装：

```json
{
  "dependencies": {
    "dsh-session-ecology": "file:../../plugins/dsh-session-ecology-0.8.0.tgz"
  }
}
```

```bash
cd "$DSH_HOME/profiles/web"
pnpm install --prefer-offline
```

3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中启用插件（若使用 `dsh plugin` 管理则会自动合并插件内置的 `cordis.patch.yml`）：

```yaml
- id: session-ecology
  name: dsh-session-ecology
```

### 方式二：从源码构建安装

```bash
git clone https://github.com/ksoulness/dsh-session-ecology.git
cd dsh-session-ecology
npm test
npm pack
```

验证插件配置健康度与运行状态：

```bash
dsh --profile web --dump-config
curl http://127.0.0.1:3079/dsh-session-ecology/health
```

---

## Agent 工具集（`fleet_*`）

插件向 DSH Agent 注册以下 4 个原生工具，支持用自然语言直接指挥会话治理：

| 工具名 | 用途 |
| :--- | :--- |
| `fleet_ecology_status` | 查询所有活跃会话的三闸门水位、最近换卷历史；传入 `include_project_memory: true` 同步返回全工作区 `PROJECT.md` 巡检报告 |
| `fleet_session_handover` | 对指定会话立即发起安全换卷、标题链递增、定时任务原子迁移与归档（若对当前自身会话调用，自动排入本轮结束空闲时执行） |
| `fleet_ecology_sweep` | 批量扫描超阈值会话（支持 `dry_run: true` 演练与 `scheduled_only` 仅扫定时巡检会话） |
| `fleet_session_organize` | 会话整理全能工具：`list`、`annotate`、`archive`、`unarchive`、`pin`、`unpin`、`move_workspace`、`recycle`、`purge_archived`（支持 `dry_run: true` 先盘点已归档/幽灵 ID/孤儿缓存） |

---

## Loopback HTTP 与 SSE 接口

所有接口均挂载于 `/dsh-session-ecology` 下，严格限制本机回环地址（`127.0.0.1` / `::1`）访问，且 `POST /api` 强制校验 `Origin` / `Sec-Fetch-Site` 防御跨站请求伪造（CSRF）：

- `GET /dsh-session-ecology/health` — 插件版本、配置与健康摘要
- `GET /dsh-session-ecology/session?sessionId=<id>` — 单会话轻量三闸门生态水位、卷代际与在途状态快照
- `GET /dsh-session-ecology/status` — 活跃会话生态水位与历史记录
- `GET /dsh-session-ecology/catalog` — 会话整理全量目录（含批注、工作区、定时任务计数）
- `GET /dsh-session-ecology/project-memory` — 多工作区 `PROJECT.md` 健康快照
- `GET /dsh-session-ecology/handoff?sessionId=<oldId>` — 读取指定旧会话交接单 Markdown（严格限制在 `handoffs/` 目录内防路径穿越）
- `GET /dsh-session-ecology/events` — 实时 SSE 事件流
- `POST /dsh-session-ecology/api` — 执行 `handover`、`sweep`、`settings`、`resetSettings`、`annotate`、`archive`、`pin`、`moveWorkspace`、`recycle`、`purgeArchived` 等动作

---

## 高级配置项参考

持久化运行配置与账本保存在 `$DSH_HOME/storages/session-ecology.json`（也可在 `cordis.patch.yml` 的 `config` 字段提供初始覆盖）：

| 配置键 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | 插件总开关 |
| `autoHandover` | `true` | 超阈值会话在回合空闲后是否自动换卷 |
| `showDockMeter` | `true` | 在对话输入框下方底部状态栏（Token 与费用之间）显示三闸门换卷距离进度条 |
| `postBootSweepEnabled` | `true` | 宿主启动 60 秒后是否自动巡检并清扫超标定时会话 |
| `pressureRatio` | `0.40` | Gate 1：压后真实上下文负载占窗口 $W$ 比例上限 |
| `surfaceRatio` | `1.00` | Gate 2：表面对话体积占窗口 $W$ 比例上限 |
| `standardFatigueMultiplier` | `350` | Gate 3（标准模型）：累计总消耗相对窗口 $W$ 的倍数上限 |
| `proFatigueMultiplier` | `150` | Gate 3（高阶/高成本模型）：累计总消耗相对窗口 $W$ 的倍数上限 |
| `warnRatio` | `0.75` | 达到任一闸门该比例时标记为预警（`warn`） |
| `archiveOldSession` | `true` | 换卷成功后自动归档旧会话 |
| `notifyFeishu` | `true` | 若宿主同时安装了 `dsh-plugin-notify-feishu`，换卷完成后自动推送飞书卡片通知（未安装则静默跳过） |
| `projectMemoryGuardEnabled` | `true` | 启用 `PROJECT.md` 写入前字节/行数硬护栏 |
| `projectMemoryReminderEnabled` | `true` | 启用交互式长会话压缩前 `PROJECT.md` 同步提醒 |
| `projectMemoryMaxBytes` | `15360` | `PROJECT.md` 最大字节数上限（默认 15 KB） |
| `projectMemoryMaxLines` | `250` | `PROJECT.md` 最大行数上限 |
| `summaryFallbackRoute` | `null` | 可选 `{ "provider": "...", "model": "..." }`：配置后，当高成本模型（如 Opus / GPT-5/6 / `codex/*`）触发后台自总结时，临时借用该轻量模型生成交接单，不消耗高价配额 |
| `allowedProviders` | `null` | 可选字符串数组：配合 `summaryFallbackRoute` 限定允许直接自总结的 Provider 白名单 |

---

## 开发与测试

本仓库包含纯逻辑单元测试、客户端沙箱测试、`PROJECT.md` 护栏测试与真实 `@deepseek-ai/cordis` 容器集成测试：

```bash
npm test
```

## 开源协议

[MIT License](./LICENSE)

## 更新记录

- `0.8.0`：换卷继承新增 **「回忆锚点小总结」**——自动提取上卷最后一轮真实问答（过滤系统注入上下文、思维链与自总结轮次），写入交接单存档并在新卷首条回执中按 4 行精炼模板展示「之前在干什么 / 最后你说 / 最后它回」；收紧 `purge_archived` 的 `include_orphan_dirs` 判定边界，100% 保护含真实聊天记录的「未分组」活跃对话，仅回收空壳/失效路径/工作区脱挂真孤儿目录；同步更新 Web 清理面板空间口径与孤儿目录独立徽章；`PROJECT.md` 写入守卫同步拦截 `deja_remember` 另立第二本结论账本。
- `0.7.0`：新增对话框底部状态栏「换卷距离进度条」（`conversation.composer.dock` `order: 50`，零轮询实时追踪三闸门进度、点击弹出三闸门明细与手动换卷按钮、支持 `showDockMeter` 开关与桌面端底部栏防截断自适应）；新增 `GET /dsh-session-ecology/session` 单会话水位接口与回合结束 `session-waterline` SSE 推送；修复 `/health` 版本号动态读取。
- `0.6.0`：`purge_archived` 四项修复——回收站「移出量 vs 真释放」拆分 + `empty_recycle_bin`；新增磁盘孤儿会话目录清理（`include_orphan_dirs`）；守卫顺序改为定时任务先于 mtime 活跃窗；孤儿缓存扫描覆盖 `storages` 下所有缓存源。
