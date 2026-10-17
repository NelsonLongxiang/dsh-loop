// vlln/loop — 定时循环插件：/loop 命令 + loop 工具，按间隔向当前 agent
// 重复投递 prompt（每轮 = agent.followup 排队一次新 turn，与 goal-session
// 同机制）。对齐 Claude Code 的 /loop 语义：固定间隔 / 自调节（模型每轮
// 可用工具调整或停止）/ 内置维护 prompt。
//
// 持久化：循环定义存 `$DSH_HOME/plugins-data/dsh-loop/loops.json`（无
// DSH_HOME 时回落 `~/.dsh/`）。进程重启后会话恢复（agent 以同一 id 重建）
// 时自动重挂；宿主 agent 已销毁且超过淘汰窗口未归来的循环按 stale 淘汰，
// 防文件膨胀。用户显式 stop（命令/工具/状态条按钮）= 永久删除，不参与
// 重挂。client half 经 conversation.input.dock 槽显示活动 loop 状态条
// （与官方 goal / task-status 同一 dock 家族），数据由本文件注册的只读
// 路由提供，该路由同时承载浏览器侧语言回传（`?lang=`，供本文件的用户可见
// 文案选语言，见 COMMAND_COPY）。
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

const PLUGIN_ID = 'dsh-loop'

/** 持久化根：$DSH_HOME/plugins-data/dsh-loop/（DSH_HOME 缺省回落 ~/.dsh/）。 */
const STORE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins-data', PLUGIN_ID)
const STORE_FILE = join(STORE_DIR, 'loops.json')
/**
 * Event ledger (append-only audit): one JSONL row per event. Kinds:
 * created / stopped / swept / remounted / paused / resumed / edited.
 * Append failures never block the main flow (same tolerance discipline as
 * saveStoreLoops). No rotation yet.
 */
const HISTORY_FILE = join(STORE_DIR, 'loops.history.jsonl')
/**
 * 淘汰窗口：宿主 agent 已销毁且这一窗口内没有新投递（即未重挂）的循环
 * 定义按 stale 删除。取 max(窗口, 2×间隔)，长间隔循环不因窗口短于自身
 * 周期被误杀。
 */
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000
/** stale 清扫周期（与投递节奏无关的独立慢定时器）。 */
const SWEEP_INTERVAL_MS = 24 * 3600 * 1000

/**
 * 循环投递消息的来源标识（消息 source kind，生产者自有的合并式词表）。
 * 0.1 的 `{ kind: 'plugin', plugin }` 已退役：v4 会话格式拒绝 `kind: 'plugin'`
 * （消息落盘/重载时报「requires a producer-owned source kind」），旧日志由
 * 迁移器改写成 `plugin:${plugin}`——故沿用同一字面量保持新旧日志同源。
 */
const LOOP_SOURCE_KIND = `plugin:${PLUGIN_ID}`

/** client half 轮询的活动 loop 列表路由（与 client/index.tsx 的 LOOPS_PATH 一致）。 */
export const LOOPS_PATH = '/plugins/dsh-loop/loops'

/**
 * 设置命名空间 = 声明 `Config` schema 的条目 id（= cordis.patch.yml 的 insert
 * 条目 id）。用户可在设置页（client half 注册进官方 plugins.bundle.config 槽的
 * 「dsh-loop」包页卡片）选择是否把插件工具注入模型工具集。
 */
export const LOOP_SETTINGS_NAMESPACE = 'dsh-loop'

/** 设置默认值（消费端唯一权威；schema default 与 readConfig 补缺同源）。 */
export const LOOP_SETTINGS_DEFAULTS = Object.freeze({
  loop: true,
})

/**
 * 用户可写设置（保存即生效，无需重启：宿主把标了 `.volatile()` 的叶换成实时
 * 引用原地提交，**不重挂载**条目，随后发 `loader/volatile-update`；本插件重读
 * 快照并按工具表动态注册/注销各工具。工具 schemas 在每次会话组装与每轮 prompt
 * 组装时实时解析当前全局工具层，没有按 session 快照——因此新会话立即生效，
 * 存量会话的下一轮同样读到新工具集；开→关方向会让在飞会话的模型下一轮起看不到
 * 对应工具（工具调用记录无法对账的代价，已在 README 说明取舍）。`/loop` 命令
 * （用户侧）不受此开关影响。）
 * 字段名 = 注入模型工具集的插件工具名（与下方 toolDefinitions 的 key、client
 * half 的 LOOP_TOOL_FIELDS 三处同源）；`false` = 该工具从 agent 的
 * `tools.schemas` 中消失（模型看不到、调不动）。设置页每个工具一个官方
 * 质感的 Switch，工卡内附详细工具说明。
 */
export function buildSettingsSchema() {
  return z.object({
    loop: z.boolean().default(LOOP_SETTINGS_DEFAULTS.loop).volatile(),
  })
}

/** 条目 Config：宿主按它校验条目 config，并把 volatile 叶注入 apply 的 config。 */
export const Config = buildSettingsSchema()

/** 保持既有导出面（同一条 Config schema 实例）。 */
export const LOOP_SETTINGS_SCHEMA = Config

/** volatile 叶引用（宿主 createVolatile 注入：冻结对象、唯一自有键 get）。 */
function isConfigRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.get === 'function' && Object.keys(value).length === 1
}

/** 解引用：volatile 叶取当前值；数组/普通对象递归。 */
function unwrap(value) {
  if (isConfigRef(value)) return unwrap(value.get())
  if (Array.isArray(value)) return value.map(unwrap)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]))
}

/** 读配置快照：解引用 volatile 叶 + 与默认值合并补缺。 */
export function readSettings(config) {
  const next = unwrap(config ?? {})
  return { ...LOOP_SETTINGS_DEFAULTS, ...(next !== null && typeof next === 'object' ? next : {}) }
}

// 内置维护 prompt（bare `/loop` 用），对齐 Claude Code 文档描述的三件事。
const MAINTENANCE_PROMPT = [
  '这是 loop 维护轮次。按顺序处理：',
  '1. 继续会话中未完成的工作；',
  '2. 照看当前分支的 pull request（评审意见、失败 CI、合并冲突）；',
  '3. 无待办时做一次小的清理（修一个 flaky test、删一条过时注释）。',
  '不要发起范围外的新事项。完成后用 loop 工具停止，或按需要调整间隔。',
].join('\n')

/** 解析 `5m`/`30s`/`1h`/`2d` 或裸数字（分钟）；无法解析返回 null。 */
function parseIntervalMs(raw) {
  const match = /^(\d+)([smhd])?$/.exec(raw.trim())
  if (match === null) return null
  const value = Number(match[1])
  const unit = match[2] ?? 'm'
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit]
  return value * seconds * 1000
}

/** 人类可读间隔（用于命令回显）。 */
function formatInterval(ms) {
  const minutes = ms / 60000
  if (minutes >= 1440) return `${minutes / 1440}d`
  if (minutes >= 60) return `${minutes / 60}h`
  if (minutes >= 1) return `${minutes}m`
  return `${ms / 1000}s`
}

/**
 * 循环定义的持久化面。运行态（live agent、定时器句柄）永不序列化——
 * 重挂以 agent 生命周期事件为锚（agent/created），不是存对象引用。
 * @typedef {Object} PersistedLoop
 * @property {string} id - `loop-<N>`，跨重启稳定（seq 从存量恢复）。
 * @property {string} agentId - 宿主 agent id（重挂锚）。
 * @property {string} sessionId - 宿主会话 id（当前实现与 agentId 同值；
 *   分列存储是为 agent/session 身份将来分离时不迁移格式）。
 * @property {string} prompt - 每轮投递的 prompt。
 * @property {number} intervalMs - 投递间隔。
 * @property {number|undefined} lastDeliveredAt - 上次投递时间戳（恢复后
 *   状态条的 nextTick 计算与调度续接都用它）。
 * @property {number} createdAt
 * @property {number} updatedAt - 淘汰判定时钟：任何一次投递刷新。
 */

/** 读取存量定义；损坏/缺失返回空集（永不因坏文件拒绝启动）。 */
function loadStoreLoops() {
  let raw
  try {
    raw = readFileSync(STORE_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return []
    const loops = parsed.loops
    if (!Array.isArray(loops)) return []
    return loops.filter(entry =>
      typeof entry?.id === 'string'
      && typeof entry?.agentId === 'string'
      && typeof entry?.prompt === 'string'
      && typeof entry?.intervalMs === 'number')
  } catch {
    return []
  }
}

/** 原子写入（同目录 tmp + rename）：部分写绝不留下半截 JSON。 */
function saveStoreLoops(entries) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = `${STORE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, loops: entries }, null, 2), 'utf8')
    renameSync(tmp, STORE_FILE)
  } catch {
    // 持久化失败不阻断循环本身——内存态仍正确，下次变更再试。
  }
}

/**
 * Append one ledger event (append-only JSONL; audit-grade, rotation later).
 * Silent on failure: a missing ledger row must never break loop lifecycle.
 */
function appendHistory(event, loopId, fields) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const line = JSON.stringify({ ts: Date.now(), event, loopId, ...fields })
    appendFileSync(HISTORY_FILE, line + '\n', 'utf8')
  } catch {
    // Ledger unwritable: tolerate, main flow continues.
  }
}

/**
 * Node half 的界面语言：宿主没有 locale 服务（官方命令面板的中文来自客户端写死的
 * 官方命令表），语言偏好只存在于浏览器侧。所以语言由 client half 在既有的
 * /loops 轮询上回传（`?lang=`），这里只采纳白名单值；缺失、未知或非法类型一律
 * 忽略（该路由保持只读语义，不引入写面）。从未收到过回传时为 'en'——与官方命令
 * 一致，headless/CLI 场景输出稳定。
 */
const SUPPORTED_UI_LANGUAGES = ['zh', 'en']
const DEFAULT_UI_LANGUAGE = 'en'

/**
 * 用户可见文案（命令面板 description + 命令回执）。模型面文案不在此表：工具
 * description、注入会话的维护 prompt 等保持英文。
 */
const COMMAND_COPY = {
  en: {
    description: 'Run prompts on a schedule (multiple loops per session): /loop [interval] <prompt> | /loop stop [id] | /loop edit <id> <prompt> | /loop list',
    emptyUsage: [
      'No active loop.',
      'Usage: /loop [interval] <prompt> — e.g. /loop 5m check the deploy',
      'Bare /loop runs the built-in maintenance prompt.',
      'Multiple loops may run in parallel; stop one with /loop stop <id>.',
      'Loops persist across restarts and re-attach when their session resumes.',
      'Edit a running loop in place: /loop edit <id> [interval] <new prompt>.',
    ].join('\n'),
    listRow: (loop) => `${loop.id}: every ${formatInterval(loop.intervalMs)} — ${loop.prompt}`,
    loopStopped: (id) => `Loop ${id} stopped.`,
    unknownLoop: (id) => `No active loop with id ${id}.`,
    stoppedMany: (count) => `Stopped ${count} loop${count > 1 ? 's' : ''}.`,
    nothingToStop: 'No active loop to stop.',
    nothingToClear: 'No active loop to clear.',
    started: (loop, intervalMs) => `${loop.id} started: every ${formatInterval(intervalMs)} — ${loop.prompt}`,
    loopPaused: (id) => `Loop ${id} paused.`,
    loopResumed: (id) => `Loop ${id} resumed.`,
    noPausedLoop: (id) => `No paused loop with id ${id}.`,
    loopEdited: (loop) => `${loop.id} edited: every ${formatInterval(loop.intervalMs)} — ${loop.prompt}`,
    editNoChange: (id) => `Nothing to change for ${id}. Usage: /loop edit <id> [interval] <new prompt>`,
  },
  zh: {
    description: '按计划重复投递 prompt（同一会话可并行多个循环）：/loop [interval] <prompt> | /loop stop [id] | /loop edit <id> <新指令> | /loop list',
    emptyUsage: [
      '没有活动循环。',
      '用法：/loop [interval] <prompt> — 例如 /loop 5m 检查部署',
      '裸 /loop 使用内置维护 prompt。',
      '多个循环可并行；用 /loop stop <id> 停止其中一个。',
      '循环定义跨重启持久化，会话恢复时自动重挂。',
      '原地修改运行中的循环：/loop edit <id> [interval] <新指令>。',
    ].join('\n'),
    listRow: (loop) => `${loop.id}：每 ${formatInterval(loop.intervalMs)} — ${loop.prompt}`,
    loopStopped: (id) => `循环 ${id} 已停止。`,
    unknownLoop: (id) => `没有 id 为 ${id} 的活动循环。`,
    stoppedMany: (count) => `已停止 ${count} 个循环。`,
    nothingToStop: '没有可停止的活动循环。',
    nothingToClear: '没有可清除的活动循环。',
    started: (loop, intervalMs) => `${loop.id} 已启动：每 ${formatInterval(intervalMs)} — ${loop.prompt}`,
    loopPaused: (id) => `循环 ${id} 已暂停。`,
    loopResumed: (id) => `循环 ${id} 已恢复。`,
    noPausedLoop: (id) => `没有 id 为 ${id} 的暂停循环。`,
    loopEdited: (loop) => `${loop.id} 已编辑：每 ${formatInterval(loop.intervalMs)} — ${loop.prompt}`,
    editNoChange: (id) => `${id} 没有可变更的内容。用法：/loop edit <id> [interval] <新指令>`,
  },
}

// 命名导出（cordis 插件模块形态；宿主 describe 经 loader.unwrapExports 取
// 模块面读 `Config`——有 default 时只看 default，故不设 default 导出）。
export const name = 'loop'
// agents 定位/校验当前 agent；commands 注册 /loop；tools 注册 loop 工具；
// timer 提供 ctx.interval（生命周期管理的定时器）；webServer 提供只读
// 状态路由（client half 轮询）。
export const inject = ['agents', 'commands', 'tools', 'timer', 'webServer']

export function apply(ctx, config) {
    const loops = new Map()
    /** 持久化定义面：loopId -> PersistedLoop。运行态是它的 live 投影。 */
    const persisted = new Map()
    let loopSeq = 0
    // 设置快照（apply 的第二个参数 = 宿主校验后的条目 config；volatile 叶是实时
    // 引用，每次重读解引用取最新值，别缓存引用本身）。
    let settings = readSettings(config)

    const persistAll = () => { saveStoreLoops([...persisted.values()]) }

    /** 淘汰：宿主未重挂且窗口内无投递的定义删除。返回是否删了东西。 */
    const sweepStale = () => {
      const now = Date.now()
      let dropped = false
      for (const [id, entry] of [...persisted]) {
        // 活着的（有运行态绑定）永不淘汰；paused 是用户显式意图，暂停即续命。
        if (loops.has(id)) continue
        if (entry.paused === true) continue
        const idleMs = now - (entry.updatedAt ?? entry.createdAt)
        if (idleMs > Math.max(STALE_AFTER_MS, entry.intervalMs * 2)) {
          persisted.delete(id)
          appendHistory('swept', id, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs, reason: 'stale' })
          dropped = true
        }
      }
      if (dropped) persistAll()
      return dropped
    }

    /**
     * 把一条定义挂到 live agent 上：建定时器与运行态。仅当定义存在且
     * 尚未挂载时生效（agent/created 可能对同一 agent 多次触发，幂等）。
     * 重挂不立即投递——按既有 lastDeliveredAt 续接调度，恢复的会话不被
     * 突袭注入；新建循环仍走 startLoop 的立即首投。
     */
    const remount = (entry, agent) => {
      if (entry === undefined || loops.has(entry.id)) return false
      if (agent === undefined) return false
      // paused 定义恢复进持久化面但不装定时器——恢复会话不复活用户的暂停。
      if (entry.paused === true) return false
      const state = {
        id: entry.id,
        agent,
        entry,
        pendingCatchUp: false,
        catchUpTimer: undefined,
        dispose: undefined,
      }
      // 每 tick：agent 已销毁则解绑（定义保留待重挂）；忙且已吞掉一整个
      // interval（overdue）时安排短周期一次性补投定时器（min(60s,
      // intervalMs/4)）——触发时若 idle 立即补投一次并清标志；若仍忙则续期
      // 重试；空闲则 followup 投递 prompt 并刷新淘汰时钟。修复长忙跨 tick
      // 导致的循环饿死（生产 12/16 OVERDUE 实证）。
      const deliver = () => {
        if (ctx.agents.get(agent.id) !== agent) {
          detach(state)
          return
        }
        if (agent.status !== 'idle') {
          const last = entry.lastDeliveredAt ?? entry.createdAt
          if (Date.now() - last >= entry.intervalMs) armCatchUp(entry)
          return
        }
        state.pendingCatchUp = false
        cancelCatchUp(state)
        entry.lastDeliveredAt = Date.now()
        entry.updatedAt = entry.lastDeliveredAt
        persistAll()
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: entry.prompt }],
          source: { kind: LOOP_SOURCE_KIND },
        }))
      }
      state.dispose = ctx.interval(deliver, entry.intervalMs)
      loops.set(entry.id, state)
      appendHistory('remounted', entry.id, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs, reason: 'restart' })
      return true
    }

    /** 取消补投定时器（兼容 cordis 句柄函数与 Node Timeout 两种形态）。 */
    const cancelCatchUp = (state) => {
      const t = state.catchUpTimer
      if (t === undefined) return
      if (typeof t === 'function') t()
      else clearTimeout(t)
      state.catchUpTimer = undefined
    }
    const armCatchUp = (entry) => {
      const state = loops.get(entry.id)
      if (state === undefined || state.catchUpTimer !== undefined) return
      const delay = Math.max(1000, Math.min(60000, Math.floor(entry.intervalMs / 4)))
      state.catchUpTimer = ctx.timeout(() => {
        state.catchUpTimer = undefined
        const live = ctx.agents.get(state.agent.id)
        if (live !== state.agent) return
        if (state.agent.status === 'idle') {
          entry.pendingCatchUp = false
          entry.lastDeliveredAt = Date.now()
          entry.updatedAt = entry.lastDeliveredAt
          persistAll()
          state.agent.followup(createUserMessage({
            content: [{ type: 'text', text: entry.prompt }],
            source: { kind: LOOP_SOURCE_KIND },
          }))
        } else {
          armCatchUp(entry)
        }
      }, delay)
    }

    /** 解绑运行态（销毁定时器与补投定时器、移出运行 Map），定义保留在持久化面。 */
    const detach = (state) => {
      state.dispose?.()
      cancelCatchUp(state)
      loops.delete(state.id)
    }

    /** 停一个指定 loop；用户显式停 = 定义永久删除。返回是否停到。 */
    function stopLoop(loopId) {
      const state = loops.get(loopId)
      if (state === undefined) {
        // 可能是重启后未重挂的存量定义（用户对看不见的循环补刀）。
        const entry = persisted.get(loopId)
        const removed = persisted.delete(loopId)
        if (removed && entry !== undefined) {
          persistAll()
          appendHistory('stopped', loopId, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs, reason: 'user' })
        }
        return removed
      }
      detach(state)
      persisted.delete(loopId)
      persistAll()
      appendHistory('stopped', loopId, { agentId: state.entry.agentId, prompt: state.entry.prompt, intervalMs: state.entry.intervalMs, reason: 'user' })
      return true
    }

    /** 暂停一条 loop：卸定时器、标 paused；定义保留、参与淘汰豁免。 */
    function pauseLoop(loopId, agentIdForLog) {
      const state = loops.get(loopId)
      const entry = state?.entry ?? persisted.get(loopId)
      if (entry === undefined) return false
      if (state !== undefined) detach(state)
      entry.paused = true
      entry.pausedAt = Date.now()
      entry.updatedAt = entry.pausedAt
      persistAll()
      appendHistory('paused', loopId, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs })
      void agentIdForLog
      return true
    }

    /** 恢复一条 loop：重挂定时器、清 paused、lastDeliveredAt 重置为 now（不补投）。 */
    function resumeLoop(loopId, agent) {
      const entry = persisted.get(loopId)
      if (entry === undefined || entry.paused !== true) return false
      const host = agent ?? ctx.agents.get(entry.agentId)
      if (host === undefined) return false
      entry.paused = false
      delete entry.pausedAt
      entry.lastDeliveredAt = Date.now()
      entry.updatedAt = entry.lastDeliveredAt
      persistAll()
      remount(entry, host)
      appendHistory('resumed', loopId, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs })
      return true
    }

    /**
     * 原地编辑一条 loop 的定义（prompt 与/或 intervalMs）。运行/暂停/休眠三态
     * 皆可编辑：entry 是运行态与持久化面共享的同一对象，改 prompt 下一轮投递
     * 即生效；改 interval 的运行态先卸后重挂（remount 按新 intervalMs 装定时器，
     * 调度从既有 lastDeliveredAt 续接，不立即补投）。编辑刷新淘汰时钟——用户
     * 显式意图 = 续命。返回更新后的 entry；未命中或无可变更字段返回 undefined。
     */
    function editLoop(loopId, patch) {
      const state = loops.get(loopId)
      const entry = state?.entry ?? persisted.get(loopId)
      if (entry === undefined) return undefined
      const changed = []
      if (typeof patch.prompt === 'string' && patch.prompt.length > 0 && patch.prompt !== entry.prompt) {
        entry.prompt = patch.prompt
        changed.push('prompt')
      }
      if (typeof patch.intervalMs === 'number' && Number.isFinite(patch.intervalMs)
        && patch.intervalMs > 0 && patch.intervalMs !== entry.intervalMs) {
        entry.intervalMs = patch.intervalMs
        changed.push('interval')
      }
      if (changed.length === 0) return undefined
      entry.updatedAt = Date.now()
      persistAll()
      appendHistory('edited', loopId, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs, changed: changed.join('+') })
      // 运行态且 interval 变更：重挂定时器到新节奏（paused 定义无定时器可重挂，
      // resume 时自然按新 intervalMs 装配；prompt-only 变更无需动定时器）。
      if (state !== undefined && changed.includes('interval')) {
        detach(state)
        remount(entry, ctx.agents.get(entry.agentId) ?? state.agent)
      }
      return entry
    }

    /** 停一个 agent 的全部 loop（显式意图 = 全部永久删除）；返回停掉数量。 */
    function stopAgentLoops(agent) {
      let stopped = 0
      for (const [loopId, state] of [...loops]) {
        if (state.agent !== agent) continue
        detach(state)
        persisted.delete(loopId)
        appendHistory('stopped', loopId, { agentId: state.entry.agentId, prompt: state.entry.prompt, intervalMs: state.entry.intervalMs, reason: 'user' })
        stopped += 1
      }
      if (stopped > 0) persistAll()
      return stopped
    }

    /** 该 agent 的全部活动 loop（运行态优先；含未重挂的存量定义）。 */
    function agentLoops(agent) {
      const live = [...loops.values()].filter(state => state.agent === agent)
      const liveIds = new Set(live.map(state => state.id))
      const dormant = [...persisted.values()]
        .filter(entry => entry.agentId === agent.id && !liveIds.has(entry.id))
        .map(entry => ({ id: entry.id, agent, prompt: entry.prompt, intervalMs: entry.intervalMs, paused: entry.paused === true }))
      return [...live.map(state => ({ id: state.id, agent, prompt: state.entry.prompt, intervalMs: state.entry.intervalMs, paused: false })), ...dormant]
    }

    function startLoop(agent, prompt, intervalMs) {
      const id = `loop-${++loopSeq}`
      const entry = {
        id,
        agentId: agent.id,
        sessionId: agent.id,
        prompt,
        intervalMs,
        lastDeliveredAt: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      persisted.set(id, entry)
      persistAll()
      appendHistory('created', id, { agentId: entry.agentId, prompt: entry.prompt, intervalMs: entry.intervalMs })
      // 命令路径（用户敲 /loop）：agent 此刻空闲，立即投递第一轮；
      // 工具路径（模型 turn 内 loop start）：agent 忙，deliver 会跳过，
      // 本轮结束后由 interval 接管——两种场景都正确。
      remount(entry, agent)
      const state = loops.get(id)
      if (state !== undefined) {
        // 复刻原语义：新循环立即补投第一轮（remount 只装定时器）。
        deliverNow(state, entry)
      }
      return { id, agent, prompt, intervalMs, entry }
    }

    /** 新循环的立即首投（与 remount 的调度续投分开，语义各自明确）。 */
    function deliverNow(state, entry) {
      if (ctx.agents.get(state.agent.id) !== state.agent) return
      if (state.agent.status !== 'idle') return
      entry.lastDeliveredAt = Date.now()
      entry.updatedAt = entry.lastDeliveredAt
      persistAll()
      state.agent.followup(createUserMessage({
        content: [{ type: 'text', text: entry.prompt }],
        source: { kind: LOOP_SOURCE_KIND },
      }))
    }

    // 启动恢复：读存量 → 淘汰过期 → 恢复 seq → 已 live 的 agent 立即重挂。
    for (const entry of loadStoreLoops()) persisted.set(entry.id, entry)
    sweepStale()
    for (const id of persisted.keys()) {
      const seq = Number(/^(?:loop-)?(\d+)$/.exec(id)?.[1] ?? '0')
      if (Number.isFinite(seq) && seq > loopSeq) loopSeq = seq
    }
    for (const entry of persisted.values()) {
      remount(entry, ctx.agents.get(entry.agentId))
    }

    // 会话恢复锚：agent 以同一 id 重建时重挂其全部定义（幂等）。
    ctx.on('agent/created', ({ agent }) => {
      for (const entry of persisted.values()) {
        if (entry.agentId !== agent.id) continue
        remount(entry, ctx.agents.get(agent.id) ?? agent)
      }
    })

    // agent 销毁：解绑运行态，定义保留待重挂（重启后由 agent/created 重挂，
    // 淘汰由 sweepStale 负责）。payload 形如 { agent }（0.1 曾直接传 agent 对象）。
    ctx.on('agent/disposed', (payload) => {
      const disposed = payload.agent
      for (const [loopId, state] of [...loops]) {
        if (state.agent !== disposed) continue
        detach(state)
      }
    })

    // 慢速清扫：淘汰宿主未归来的定义，防文件膨胀。
    ctx.interval(() => { sweepStale() }, SWEEP_INTERVAL_MS)

    // 界面语言（见模块头的语言契约）：只有白名单回传才改变它。命令面板的
    // description 是静态字符串，语言翻转只能整条重注册——这是本插件语言回传
    // 触发的唯一注册面动作（dock/设置卡/工具注册都不受影响）。
    let uiLanguage = DEFAULT_UI_LANGUAGE
    const copy = () => COMMAND_COPY[uiLanguage] ?? COMMAND_COPY[DEFAULT_UI_LANGUAGE]
    let disposeLoopCommand = null
    const registerLoopCommand = () => {
      disposeLoopCommand = ctx.commands.register({
        name: 'loop',
        description: copy().description,
        // 语言中性：保持原样（不随语言变化）。
        input: { hint: '[interval] <prompt>' },
        handler: (invocation) => {
          const raw = invocation.rawInput.trim()
          if (raw === '' || raw === 'list') {
            const active = agentLoops(invocation.agent)
            if (active.length === 0) {
              return { kind: 'success', text: copy().emptyUsage }
            }
            return {
              kind: 'success',
              text: active.map(loop => copy().listRow(loop)).join('\n'),
            }
          }
          // stop [id]：停指定 loop（限本 agent），无 id 停全部。
          const stopMatch = /^stop(?:\s+(\S+))?$/.exec(raw)
          if (stopMatch !== null) {
            const target = stopMatch[1]?.trim()
            if (target !== undefined) {
              const hit = agentLoops(invocation.agent).find(loop => loop.id === target)
              return hit !== undefined && stopLoop(hit.id)
                ? { kind: 'success', text: copy().loopStopped(target) }
                : { kind: 'error', text: copy().unknownLoop(target) }
            }
            const stopped = stopAgentLoops(invocation.agent)
            return stopped > 0
              ? { kind: 'success', text: copy().stoppedMany(stopped) }
              : { kind: 'error', text: copy().nothingToStop }
          }
          // pause/resume [id]：暂停 = 卸定时器保留定义；恢复 = 重挂定时器。
          const pauseMatch = /^pause\s+(\S+)$/.exec(raw)
          if (pauseMatch !== null) {
            const target = pauseMatch[1]
            const hit = agentLoops(invocation.agent).find(loop => loop.id === target)
            return hit !== undefined && pauseLoop(hit.id)
              ? { kind: 'success', text: copy().loopPaused(target) }
              : { kind: 'error', text: copy().unknownLoop(target) }
          }
          const resumeMatch = /^resume\s+(\S+)$/.exec(raw)
          if (resumeMatch !== null) {
            const target = resumeMatch[1]
            const hit = agentLoops(invocation.agent).find(loop => loop.id === target)
            return hit !== undefined && resumeLoop(hit.id, invocation.agent)
              ? { kind: 'success', text: copy().loopResumed(target) }
              : { kind: 'error', text: copy().noPausedLoop(target) }
          }
          // edit <id> [interval] <new prompt>：原地改指令（可选改间隔）；与
          // start 同规——前导 token 是间隔则剥掉。运行/暂停/休眠三态皆可编辑。
          const editMatch = /^edit\s+(\S+)(?:\s+(.*))?$/.exec(raw)
          if (editMatch !== null) {
            const target = editMatch[1]
            const rest = (editMatch[2] ?? '').trim()
            const hit = agentLoops(invocation.agent).find(loop => loop.id === target)
            if (hit === undefined) {
              return { kind: 'error', text: copy().unknownLoop(target) }
            }
            const first = rest.split(/\s+/)[0] ?? ''
            const intervalMs = rest === '' ? undefined : parseIntervalMs(first) ?? undefined
            const prompt = intervalMs === undefined ? rest : rest.slice(first.length).trim()
            if (prompt === '' && intervalMs === undefined) {
              return { kind: 'error', text: copy().editNoChange(target) }
            }
            const edited = editLoop(target, { prompt: prompt === '' ? undefined : prompt, intervalMs })
            return edited !== undefined
              ? { kind: 'success', text: copy().loopEdited(edited) }
              : { kind: 'error', text: copy().editNoChange(target) }
          }
          if (raw === 'clear') {
            const stopped = stopAgentLoops(invocation.agent)
            return stopped > 0
              ? { kind: 'success', text: copy().stoppedMany(stopped) }
              : { kind: 'error', text: copy().nothingToClear }
          }
          // 前导 token 是间隔则剥掉，否则用默认 1 分钟（模型每轮可用工具调整）。
          const tokens = raw.split(/\s+/)
          const intervalMs = parseIntervalMs(tokens[0])
          const prompt = intervalMs === null ? raw : tokens.slice(1).join(' ')
          const state = startLoop(invocation.agent, prompt, intervalMs ?? 60_000)
          return {
            kind: 'success',
            text: copy().started(state, intervalMs ?? 60_000),
          }
        },
      })
    }
    registerLoopCommand()

    /**
     * 采纳一次语言回传；返回语言是否变化。非白名单值（含非字符串/缺失）不改变
     * 状态——该路由是只读语义，任何输入都不得引起抛错或状态污染。
     */
    const adoptUiLanguage = (raw) => {
      if (typeof raw !== 'string' || !SUPPORTED_UI_LANGUAGES.includes(raw)) return false
      if (raw === uiLanguage) return false
      uiLanguage = raw
      return true
    }

    // client half 轮询的活动 loop 列表：按 sessionId 过滤（state.agent.id === sessionId），
    // 并顺带回传浏览器侧语言（`?lang=`，非白名单忽略）。GET 读列表回显当前语言
    // （向后兼容的加法字段）；POST 对指定 loop 施动作（body {id, action}，action ∈
    // stop/pause/resume/edit；edit 附带 prompt/interval）——状态条按钮走此端点。
    // 动作安全分两档：缺 action 字段回落历史 'stop'（0.1 客户端兼容）；显式未知
    // action 一律 400 拒绝、绝不回落——版本劈叉（新 client + 旧 node 半）不得变
    // 异状态（2026-10-17 事故：旧 node 把 action:'edit' 回落成 stop，删掉 loop-201）。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: LOOPS_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const method = (req.method ?? 'GET').toUpperCase()
          if (method === 'POST') {
            let body = ''
            for await (const chunk of req) body += String(chunk)
            let id = ''
            let action = 'stop'
            let unknownAction = ''
            let prompt = ''
            let interval = ''
            try {
              const parsed = JSON.parse(body) ?? {}
              id = String(parsed.id ?? '').trim()
              // 缺 action 字段 = 0.1 旧客户端的 {id} 停止语义；显式白名单动作照收；
              // 显式未知动作 → 置空，下面 400（fail-closed：劈叉版本不得变异状态）。
              if (parsed.action !== undefined) {
                if (typeof parsed.action === 'string' && ['stop', 'pause', 'resume', 'edit'].includes(parsed.action)) {
                  action = parsed.action
                } else {
                  action = ''
                  unknownAction = typeof parsed.action === 'string' ? parsed.action : JSON.stringify(parsed.action)
                }
              }
              if (typeof parsed.prompt === 'string') prompt = parsed.prompt.trim()
              if (typeof parsed.interval === 'string') interval = parsed.interval.trim()
            } catch {
              // 非 JSON body → 视为空 id（下面 400）。
            }
            if (id === '') {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: `${action} needs a loop id` }))
              return
            }
            if (action === '') {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: `unknown action: ${unknownAction}` }))
              return
            }
            if (action === 'edit') {
              // interval 不可解析且无 prompt → 400；有 prompt 时坏 interval 静默忽略
              //（与既有「未知 action 回落 stop」的宽松风格一致）。
              const intervalMs = interval === '' ? undefined : parseIntervalMs(interval) ?? undefined
              if (prompt === '' && intervalMs === undefined) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'edit needs a new prompt or interval' }))
                return
              }
              const edited = editLoop(id, { prompt: prompt === '' ? undefined : prompt, intervalMs })
              res.writeHead(edited !== undefined ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({
                ok: edited !== undefined,
                id,
                action,
                ...(edited !== undefined ? { prompt: edited.prompt, intervalMs: edited.intervalMs } : {}),
              }))
              return
            }
            const applied = action === 'pause'
              ? pauseLoop(id)
              : action === 'resume'
                ? resumeLoop(id)
                : stopLoop(id)
            res.writeHead(applied ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: applied, id, action }))
            return
          }
          const sessionId = url.searchParams.get('sessionId') ?? ''
          // 语言回传：采纳白名单值；翻转时重注册命令（description 以当前语言为准）。
          if (adoptUiLanguage(url.searchParams.get('lang'))) {
            disposeLoopCommand?.()
            registerLoopCommand()
          }
          const now = Date.now()
          const rows = []
          const rowOf = (id, agentId, prompt, intervalMs, lastDeliveredAt, entry) => {
            const paused = entry?.paused === true
            const nextTick = paused || lastDeliveredAt === undefined
              ? now
              : lastDeliveredAt + intervalMs
            rows.push({
              id,
              agentId,
              prompt,
              intervalMs,
              intervalText: paused ? '已暂停' : formatInterval(intervalMs),
              nextTickAt: nextTick,
              ...(paused ? { paused: true, pausedAt: entry.pausedAt } : {}),
            })
          }
          for (const [loopId, state] of loops) {
            if (sessionId !== '' && state.agent.id !== sessionId) continue
            rowOf(loopId, state.agent.id, state.entry.prompt, state.entry.intervalMs, state.entry.lastDeliveredAt, state.entry)
          }
          // 未重挂的存量定义也上报（用户看得到、POST 可停）——恢复中的
          // 循环不是幽灵。
          const liveIds = new Set(loops.keys())
          for (const entry of persisted.values()) {
            if (liveIds.has(entry.id)) continue
            if (sessionId !== '' && entry.agentId !== sessionId) continue
            rowOf(entry.id, entry.agentId, entry.prompt, entry.intervalMs, entry.lastDeliveredAt, entry)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          // uiLanguage 是加法字段：现有消费者只读 loops，多一个字段无影响。
          res.end(JSON.stringify({ loops: rows, uiLanguage }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: message }))
        }
      },
    }), 'loop: status + stop route')

    /** 工具：模型自调节入口（start/stop/pause/resume/status/list）。设置页可按
     * 工具开关——见 LOOP_SETTINGS_SCHEMA：宿主原地提交 volatile 叶后发
     * `loader/volatile-update`，此处重读快照并按 toolDefinitions 表动态注册/注销
     * 对应工具，保存即对新会话生效（无需重启进程）。关闭后 agent 的
     * tools.schemas 中没有该工具（模型看不到、调不动），/loop 命令与状态路由
     * 照常（用户侧能力）。 */
    // 工具定义表：key = LOOP_SETTINGS_SCHEMA 的字段名 = 工具注册名。新增
    // 工具 = 在此加一条，并在 client half 的 LOOP_TOOL_FIELDS 同步加一行
    // 设置卡片字段（设置页每个工具独立开关）。
    const toolDefinitions = {
      loop: defineTool({
        name: 'loop',
        description: 'Start, stop, pause, resume, edit, or inspect scheduled loops on the current agent. '
          + 'Multiple loops may run in parallel; start creates a new one each time. '
          + 'A loop re-delivers a prompt every interval; use it for polling, PR babysitting, '
          + 'or build-fix-test cycles. The model may adjust the interval or stop the loop '
          + 'each round, which is the self-paced mode. edit rewrites a running loop\'s '
          + 'prompt (and optionally its interval) in place, without stopping it. '
          + 'Loop definitions persist across restarts and re-attach when their session resumes.',
        parameters: {
          action: { type: 'string', required: true },
          prompt: { type: 'string' },
          interval: { type: 'string' },
          loop_id: { type: 'string' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
          // 工具在 agent turn 内执行：当前发起者即循环的宿主。
          const agent = ctx.agents.currentInitiator()
          if (agent === undefined) throw new Error('loop tool requires an active agent turn')
          switch (args.action) {
            case 'start': {
              if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
                throw new Error('loop start needs a prompt')
              }
              const intervalMs = typeof args.interval === 'string'
                ? (parseIntervalMs(args.interval) ?? 60_000)
                : 60_000
              const state = startLoop(agent, args.prompt, intervalMs)
              return `${state.id} started: every ${formatInterval(intervalMs)} — ${args.prompt}`
            }
            case 'stop': {
              const target = typeof args.loop_id === 'string' ? args.loop_id : undefined
              if (target !== undefined) {
                const hit = agentLoops(agent).find(s => s.id === target)
                return hit !== undefined && stopLoop(hit.id)
                  ? `loop ${target} stopped`
                  : `no active loop with id ${target}`
              }
              const stopped = stopAgentLoops(agent)
              return stopped > 0 ? `stopped ${stopped} loop${stopped > 1 ? 's' : ''}` : 'no active loop'
            }
            case 'pause': {
              const target = typeof args.loop_id === 'string' ? args.loop_id : undefined
              if (target === undefined) throw new Error('loop pause needs loop_id')
              const hit = agentLoops(agent).find(s => s.id === target)
              return hit !== undefined && pauseLoop(hit.id)
                ? `loop ${target} paused`
                : `no active loop with id ${target}`
            }
            case 'resume': {
              const target = typeof args.loop_id === 'string' ? args.loop_id : undefined
              if (target === undefined) throw new Error('loop resume needs loop_id')
              const hit = agentLoops(agent).find(s => s.id === target)
              return hit !== undefined && resumeLoop(hit.id, agent)
                ? `loop ${target} resumed`
                : `no paused loop with id ${target}`
            }
            case 'edit': {
              const target = typeof args.loop_id === 'string' ? args.loop_id : undefined
              if (target === undefined) throw new Error('loop edit needs loop_id')
              const prompt = typeof args.prompt === 'string' && args.prompt.length > 0 ? args.prompt : undefined
              const intervalMs = typeof args.interval === 'string' ? parseIntervalMs(args.interval) ?? undefined : undefined
              if (prompt === undefined && intervalMs === undefined) {
                throw new Error('loop edit needs a new prompt or interval')
              }
              const hit = agentLoops(agent).find(s => s.id === target)
              const edited = hit === undefined ? undefined : editLoop(target, { prompt, intervalMs })
              return edited !== undefined
                ? `loop ${target} edited: every ${formatInterval(edited.intervalMs)} — ${edited.prompt}`
                : hit === undefined
                  ? `no active loop with id ${target}`
                  : `loop ${target} unchanged (values already current)`
            }
            case 'status':
            case 'list': {
              const active = agentLoops(agent)
              return active.length === 0
                ? 'no active loop'
                : active.map(s => `${s.id}: every ${formatInterval(s.intervalMs)} — ${s.prompt}`).join('\n')
            }
            default:
              throw new Error(`unknown loop action: ${String(args.action)}`)
          }
        },
      }),
    }
    const loopToolDisposers = new Map()
    const applyLoopTools = () => {
      for (const [toolName, definition] of Object.entries(toolDefinitions)) {
        const enabled = settings[toolName] !== false
        if (enabled && !loopToolDisposers.has(toolName)) {
          loopToolDisposers.set(toolName, ctx.tools.register(definition))
        } else if (!enabled && loopToolDisposers.has(toolName)) {
          loopToolDisposers.get(toolName)()
          loopToolDisposers.delete(toolName)
        }
      }
    }
    applyLoopTools()
    // 配置热更新：宿主原地提交 volatile 叶（不重挂载）后重读快照，按最新值重算
    // 注册/注销（幂等 no-op：值未变的工具不动）。
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      settings = readSettings(config)
      applyLoopTools()
    }), 'loop: tool exposure settings')
}