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
  const listeners = new Map()
  const routes = []
  const agents = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) },
    interval: (fn, _ms) => { intervals.push(fn); return () => { const i = intervals.indexOf(fn); if (i >= 0) intervals.splice(i, 1) } },
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
