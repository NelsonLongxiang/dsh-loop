/** 自测：fake ctx 驱动真实插件模块，验证持久化/重挂/淘汰/显式删除语义。 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dsh-loop-selftest-'))
process.env.DSH_HOME = home
const storeFile = join(home, 'plugins-data', 'dsh-loop', 'loops.json')

const { createUserMessage } = await import('@deepseek-ai/dsh-llm')

function makeCtx() {
  const intervals = []
    const timeouts = []
  const listeners = new Map()
  const routes = []
  const agents = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) },
    interval: (fn, _ms) => { intervals.push(fn); return () => { const i = intervals.indexOf(fn); if (i >= 0) intervals.splice(i, 1) } },
    timeout: (fn, _ms) => { const t = setTimeout(() => fn(), _ms); return () => clearTimeout(t) },
    agents: {
      map: agents,
      get: (id) => agents.get(id),
    },
    commands: { register: (def) => { ctx._command = def } },
    tools: { register: (def) => { ctx._tool = def } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    _intervals: intervals,
    _listeners: listeners,
    _routes: routes,
    _emit: (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  return ctx
}

function makeAgent(id) {
  const followups = []
  return {
    id,
    status: 'idle',
    followups,
    followup: (msg) => { followups.push(msg) },
  }
}

const mod = await import('../src/index.mjs')
const readStore = () => JSON.parse(readFileSync(storeFile, 'utf8'))

// ---- 场景 1：创建即持久化 ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  const agent = makeAgent('sess-A')
  ctx.agents.map.set('sess-A', agent)
  const r = ctx._command.handler({ agent, rawInput: '5m check the deploy' })
  assert.match(r.text, /loop-1 started/)
  const store = readStore()
  assert.equal(store.loops.length, 1)
  assert.equal(store.loops[0].agentId, 'sess-A')
  assert.equal(store.loops[0].sessionId, 'sess-A')
  assert.equal(store.loops[0].prompt, 'check the deploy')
  assert.equal(store.loops[0].intervalMs, 300000)
  assert.equal(typeof store.loops[0].lastDeliveredAt, 'number')
  assert.equal(agent.followups.length, 1, 'immediate first delivery')
  console.log('scenario 1 (persist on create + immediate delivery): OK')
}

// ---- 场景 2：重启后 agent 未恢复 → 定义在；恢复（agent/created）→ 重挂并投递 ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  // 载入存量但 agent 不在：GET 可见（休眠行），seq 不撞号
  const agent2 = makeAgent('sess-A')
  ctx.agents.map.set('sess-A', agent2)
  ctx._emit('agent/created', { agent: agent2 })
  const started = ctx._command.handler({ agent: agent2, rawInput: 'list' })
  assert.match(started.text, /loop-1: every 5m/)
  // 手动触发一次 interval 投递（重挂的投递器排在清扫器之后注册）
  ctx._intervals[ctx._intervals.length - 1]()
  assert.equal(agent2.followups.length, 1, 'remounted loop delivered on tick')
  assert.equal(readStore().loops.length, 1)
  // 显式 stop = 永久删除
  const stop = ctx._command.handler({ agent: agent2, rawInput: 'stop loop-1' })
  assert.match(stop.text, /stopped/i)
  assert.equal(readStore().loops.length, 0)
  console.log('scenario 2 (dormant restore, remount on agent/created, explicit stop deletes): OK')
}

// ---- 场景 3：agent 销毁 → 解绑但定义保留；淘汰窗口后清扫删除 ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  const agent = makeAgent('sess-B')
  ctx.agents.map.set('sess-B', agent)
  const first = ctx._command.handler({ agent, rawInput: '10m babysit PR' })
  const second = ctx._command.handler({ agent, rawInput: '20m second watcher' })
  assert.match(first.text, /loop-1 started/)
  assert.match(second.text, /loop-2 started/, 'seq increments within a process')
  assert.equal(readStore().loops.length, 2)
  // 销毁：定义保留
  ctx.agents.map.delete('sess-B')
  ctx._emit('agent/disposed', agent)
  assert.equal(readStore().loops.length, 2, 'definitions survive disposal')
  // 把 updatedAt 拨回 8 天前，触发清扫 interval（最后一个 interval 是 sweep）
  const store = readStore()
  for (const loop of store.loops) loop.updatedAt = Date.now() - 8 * 24 * 3600 * 1000
  const { writeFileSync } = await import('node:fs')
  writeFileSync(storeFile, JSON.stringify(store))
  // 重新 apply 模拟重启（load 时清扫）
  const ctx2 = makeCtx()
  mod.default.apply(ctx2)
  assert.equal(readStore().loops.length, 0, 'stale entry evicted on load')
  console.log('scenario 3 (disposal keeps definition, stale eviction on reload): OK')
}

// ---- 场景 4：POST stop 休眠定义（重启后未恢复时经状态条停） ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  assert.equal(readStore().loops.length, 0)
  const agent = makeAgent('sess-C')
  ctx.agents.map.set('sess-C', agent)
  const started = ctx._command.handler({ agent, rawInput: '1h nightly review' })
  const loopId = /^\S+ started/.exec(started.text)?.[0]?.split(' ')[0]
  assert.ok(loopId, 'loop started: ' + started.text)
  // 模拟重启（无 agent）→ 休眠；POST stop 应删定义返回 200
  const ctx2 = makeCtx()
  mod.default.apply(ctx2)
  const chunks = []
  const res = { writeHead(c) { this.code = c }, end(b) { chunks.push(b) } }
  await ctx2._routes[0].handler({ method: 'POST', url: '/plugins/dsh-loop/loops', [Symbol.asyncIterator]() { return (async function* () { yield JSON.stringify({ id: loopId }) })() } }, res)
  assert.equal(res.code, 200)
  assert.equal(readStore().loops.length, 0)
  console.log('scenario 4 (POST stop on dormant definition): OK')
}

// ---- 场景 5：事件台账（loops.history.jsonl append-only）----
{
  const { existsSync } = await import('node:fs')
  const historyFile = join(home, 'plugins-data', 'dsh-loop', 'loops.history.jsonl')
  assert.ok(existsSync(historyFile), 'history ledger created')
  const rows = readFileSync(historyFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  const events = new Set(rows.map((r) => r.event))
  for (const kind of ['created', 'stopped', 'swept', 'remounted']) {
    assert.ok(events.has(kind), 'ledger has ' + kind + ' event; got: ' + [...events])
  }
  for (const r of rows) {
    assert.equal(typeof r.ts, 'number')
    assert.equal(typeof r.loopId, 'string')
  }
  const stoppedRow = rows.find((r) => r.event === 'stopped')
  assert.equal(stoppedRow.reason, 'user')
  const sweptRow = rows.find((r) => r.event === 'swept')
  assert.equal(sweptRow.reason, 'stale')
  console.log('scenario 5 (append-only event ledger created/stopped/swept/remounted): OK')
}

// ---- 场景 6：暂停/恢复三态（paused 定义保留、不投递、豁免淘汰；resume 从 now 起算）----
{
  const { writeFileSync } = await import('node:fs')
  const ctx = makeCtx()
  mod.default.apply(ctx)
  const agent = makeAgent('sess-P')
  ctx.agents.map.set('sess-P', agent)
  const started = ctx._command.handler({ agent, rawInput: '30m watch the thing' })
  const loopId = /^\S+ started/.exec(started.text)?.[0]?.split(' ')[0]
  assert.ok(loopId, 'loop started: ' + started.text)

  // pause：定义保留、运行态卸下、不再投递
  const paused = ctx._command.handler({ agent, rawInput: 'pause ' + loopId })
  assert.match(paused.text, /paused/)
  assert.equal(readStore().loops.length, 1)
  assert.equal(agent.followups.length, 1, 'pause does not deliver')
  assert.equal(readStore().loops[0].paused, true)
  assert.equal(typeof readStore().loops[0].pausedAt, 'number')

  // sweep 豁免：把 updatedAt 拨回 8 天前再扫，paused 不被淘汰
  const store = readStore()
  for (const loop of store.loops) loop.updatedAt = Date.now() - 8 * 24 * 3600 * 1000
  writeFileSync(storeFile, JSON.stringify(store))
  const intervals = ctx._intervals
  intervals[intervals.length - 1]()
  assert.equal(readStore().loops.length, 1, 'paused survives stale sweep')

  // resume：重挂 + lastDeliveredAt=now（从 now 起算，不补投）
  const resumed = ctx._command.handler({ agent, rawInput: 'resume ' + loopId })
  assert.match(resumed.text, /resumed/)
  assert.equal(readStore().loops.length, 1)
  assert.ok(readStore().loops[0].paused === undefined || readStore().loops[0].paused === false)
  const idleGap = Date.now() - readStore().loops[0].lastDeliveredAt
  assert.ok(idleGap < 5_000, 'resume resets lastDeliveredAt to now, got gap=' + idleGap)
  // 重启：active 条目正常重挂（对照面）
  const ctx2 = makeCtx()
  mod.default.apply(ctx2)
  ctx2.agents.map.set('sess-P', agent)

  // paused 跨重启仍 paused：restart 后无重挂投递
  ctx._command.handler({ agent, rawInput: 'pause ' + loopId })
  const ctx3 = makeCtx()
  mod.default.apply(ctx3)
  ctx3.agents.map.set('sess-P', agent)
  assert.equal(readStore().loops[0].paused, true, 'paused survives restart')
  assert.equal(readStore().loops[0].lastDeliveredAt > 0, true)
  console.log('scenario 6 (pause keeps definition no-delivery sweep-exempt; resume re-mounts from now; paused survives restart): OK')
}

// ---- 场景 7：POST action 扩展（pause/resume）+ 旧 body 兼容 ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  const agent = makeAgent('sess-Q')
  ctx.agents.map.set('sess-Q', agent)
  const started = ctx._command.handler({ agent, rawInput: '15m post action probe' })
  const loopId = /^\S+ started/.exec(started.text)?.[0]?.split(' ')[0]

  const call = async (payload) => {
    const chunks = []
    const res = { writeHead(c) { this.code = c }, end(b) { chunks.push(b) } }
    await ctx._routes[0].handler({ method: 'POST', url: '/plugins/dsh-loop/loops', [Symbol.asyncIterator]() { return (async function* () { yield JSON.stringify(payload) })() } }, res)
    return { code: res.code, body: JSON.parse(chunks.join('')) }
  }

  const pausedRes = await call({ id: loopId, action: 'pause' })
  assert.equal(pausedRes.code, 200)
  assert.equal(pausedRes.body.action, 'pause')
  assert.equal(readStore().loops.find(l => l.id === loopId).paused, true)

  const resumedRes = await call({ id: loopId, action: 'resume' })
  assert.equal(resumedRes.code, 200)
  assert.equal(readStore().loops.find(l => l.id === loopId).paused !== true, true)

  // 旧 body（无 action 字段）= stop 旧语义
  const stopRes = await call({ id: loopId })
  assert.equal(stopRes.code, 200)
  assert.equal(stopRes.body.action ?? 'stop', 'stop')
  assert.equal(readStore().loops.some(l => l.id === loopId), false)
  console.log('scenario 7 (POST action pause/resume + legacy stop body compat): OK')
}

// ---- 场景 8：饿死修复——短周期补投定时器在「无 tick 落在 idle 窗口」时投递 ----
{
  const ctx = makeCtx()
  mod.default.apply(ctx)
  const agent = makeAgent('sess-H')
  ctx.agents.map.set('sess-H', agent)
  const r = ctx._command.handler({ agent, rawInput: '1s heartbeat' })
  assert.match(r.text, /loop-\d+ started/)
  assert.equal(agent.followups.length, 1, 'immediate first delivery')
  const myId = readStore().loops.find(l => l.prompt === 'heartbeat').id
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const tickAll = () => { for (const fn of ctx._intervals) fn() }

  // 宿主转 busy 跨过整个 interval（真实流逝 1.1s）→ tick 触发 overdue →
  // 武装短补投定时器；busy tick 本身不投（旧代码的行为终点）
  agent.status = 'busy'
  await sleep(1100)
  tickAll()
  assert.equal(agent.followups.length, 1, 'busy tick does not deliver into a busy turn')

  // 鉴别核心：agent 恢复 idle 但【无任何 tick 触发】——补投定时器必须自行投递
  // （旧代码此场景 followups 恒 1，永不恢复）
  agent.status = 'idle'
  await sleep(1300)
  assert.equal(agent.followups.length, 2, 'catch-up timer delivered without any tick')
  const myLoop = readStore().loops.find(l => l.id === myId)
  assert.ok(myLoop.lastDeliveredAt >= Date.now() - 1500, 'lastDeliveredAt refreshed by the timer delivery')
  console.log('scenario 8 (timer-driven catch-up delivers on idle without any tick): OK')
}

