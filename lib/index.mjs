import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/index.mjs
const PLUGIN_ID = "dsh-loop";
/** 持久化根：$DSH_HOME/plugins-data/dsh-loop/（DSH_HOME 缺省回落 ~/.dsh/）。 */
const STORE_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "plugins-data", PLUGIN_ID);
const STORE_FILE = join(STORE_DIR, "loops.json");
/**
* 淘汰窗口：宿主 agent 已销毁且这一窗口内没有新投递（即未重挂）的循环
* 定义按 stale 删除。取 max(窗口, 2×间隔)，长间隔循环不因窗口短于自身
* 周期被误杀。
*/
const STALE_AFTER_MS = 6048e5;
/** stale 清扫周期（与投递节奏无关的独立慢定时器）。 */
const SWEEP_INTERVAL_MS = 864e5;
/** client half 轮询的活动 loop 列表路由（与 client/index.tsx 的 LOOPS_PATH 一致）。 */
const LOOPS_PATH = "/plugins/dsh-loop/loops";
[
	"这是 loop 维护轮次。按顺序处理：",
	"1. 继续会话中未完成的工作；",
	"2. 照看当前分支的 pull request（评审意见、失败 CI、合并冲突）；",
	"3. 无待办时做一次小的清理（修一个 flaky test、删一条过时注释）。",
	"不要发起范围外的新事项。完成后用 loop 工具停止，或按需要调整间隔。"
].join("\n");
/** 解析 `5m`/`30s`/`1h`/`2d` 或裸数字（分钟）；无法解析返回 null。 */
function parseIntervalMs(raw) {
	const match = /^(\d+)([smhd])?$/.exec(raw.trim());
	if (match === null) return null;
	return Number(match[1]) * {
		s: 1,
		m: 60,
		h: 3600,
		d: 86400
	}[match[2] ?? "m"] * 1e3;
}
/** 人类可读间隔（用于命令回显）。 */
function formatInterval(ms) {
	const minutes = ms / 6e4;
	if (minutes >= 1440) return `${minutes / 1440}d`;
	if (minutes >= 60) return `${minutes / 60}h`;
	if (minutes >= 1) return `${minutes}m`;
	return `${ms / 1e3}s`;
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
	let raw;
	try {
		raw = readFileSync(STORE_FILE, "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const loops = parsed.loops;
		if (!Array.isArray(loops)) return [];
		return loops.filter((entry) => typeof entry?.id === "string" && typeof entry?.agentId === "string" && typeof entry?.prompt === "string" && typeof entry?.intervalMs === "number");
	} catch {
		return [];
	}
}
/** 原子写入（同目录 tmp + rename）：部分写绝不留下半截 JSON。 */
function saveStoreLoops(entries) {
	try {
		mkdirSync(STORE_DIR, { recursive: true });
		const tmp = `${STORE_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify({
			version: 1,
			loops: entries
		}, null, 2), "utf8");
		renameSync(tmp, STORE_FILE);
	} catch {}
}
var src_default = {
	name: "loop",
	inject: [
		"agents",
		"commands",
		"tools",
		"timer",
		"webServer"
	],
	apply(ctx) {
		const loops = /* @__PURE__ */ new Map();
		/** 持久化定义面：loopId -> PersistedLoop。运行态是它的 live 投影。 */
		const persisted = /* @__PURE__ */ new Map();
		let loopSeq = 0;
		const persistAll = () => {
			saveStoreLoops([...persisted.values()]);
		};
		/** 淘汰：宿主未重挂且窗口内无投递的定义删除。返回是否删了东西。 */
		const sweepStale = () => {
			const now = Date.now();
			let dropped = false;
			for (const [id, entry] of [...persisted]) {
				if (loops.has(id)) continue;
				if (now - (entry.updatedAt ?? entry.createdAt) > Math.max(STALE_AFTER_MS, entry.intervalMs * 2)) {
					persisted.delete(id);
					dropped = true;
				}
			}
			if (dropped) persistAll();
			return dropped;
		};
		/**
		* 把一条定义挂到 live agent 上：建定时器与运行态。仅当定义存在且
		* 尚未挂载时生效（agent/created 可能对同一 agent 多次触发，幂等）。
		* 重挂不立即投递——按既有 lastDeliveredAt 续接调度，恢复的会话不被
		* 突袭注入；新建循环仍走 startLoop 的立即首投。
		*/
		const remount = (entry, agent) => {
			if (entry === void 0 || loops.has(entry.id)) return false;
			if (agent === void 0) return false;
			const state = {
				id: entry.id,
				agent,
				entry,
				dispose: void 0
			};
			const deliver = () => {
				if (ctx.agents.get(agent.id) !== agent) {
					detach(state);
					return;
				}
				if (agent.status !== "idle") return;
				entry.lastDeliveredAt = Date.now();
				entry.updatedAt = entry.lastDeliveredAt;
				persistAll();
				agent.followup(createUserMessage({
					content: [{
						type: "text",
						text: entry.prompt
					}],
					source: {
						kind: "plugin",
						plugin: PLUGIN_ID
					}
				}));
			};
			state.dispose = ctx.interval(deliver, entry.intervalMs);
			loops.set(entry.id, state);
			return true;
		};
		/** 解绑运行态（销毁定时器、移出运行 Map），定义保留在持久化面。 */
		const detach = (state) => {
			state.dispose?.();
			loops.delete(state.id);
		};
		/** 停一个指定 loop；用户显式停 = 定义永久删除。返回是否停到。 */
		function stopLoop(loopId) {
			const state = loops.get(loopId);
			if (state === void 0) {
				const removed = persisted.delete(loopId);
				if (removed) persistAll();
				return removed;
			}
			detach(state);
			persisted.delete(loopId);
			persistAll();
			return true;
		}
		/** 停一个 agent 的全部 loop（显式意图 = 全部永久删除）；返回停掉数量。 */
		function stopAgentLoops(agent) {
			let stopped = 0;
			for (const [loopId, state] of [...loops]) {
				if (state.agent !== agent) continue;
				detach(state);
				persisted.delete(loopId);
				stopped += 1;
			}
			if (stopped > 0) persistAll();
			return stopped;
		}
		/** 该 agent 的全部活动 loop（运行态优先；含未重挂的存量定义）。 */
		function agentLoops(agent) {
			const live = [...loops.values()].filter((state) => state.agent === agent);
			const liveIds = new Set(live.map((state) => state.id));
			const dormant = [...persisted.values()].filter((entry) => entry.agentId === agent.id && !liveIds.has(entry.id)).map((entry) => ({
				id: entry.id,
				agent,
				prompt: entry.prompt,
				intervalMs: entry.intervalMs
			}));
			return [...live.map((state) => ({
				id: state.id,
				agent,
				prompt: state.entry.prompt,
				intervalMs: state.entry.intervalMs
			})), ...dormant];
		}
		function startLoop(agent, prompt, intervalMs) {
			const id = `loop-${++loopSeq}`;
			const entry = {
				id,
				agentId: agent.id,
				sessionId: agent.id,
				prompt,
				intervalMs,
				lastDeliveredAt: void 0,
				createdAt: Date.now(),
				updatedAt: Date.now()
			};
			persisted.set(id, entry);
			persistAll();
			remount(entry, agent);
			const state = loops.get(id);
			if (state !== void 0) deliverNow(state, entry);
			return {
				id,
				agent,
				prompt,
				intervalMs,
				entry
			};
		}
		/** 新循环的立即首投（与 remount 的调度续投分开，语义各自明确）。 */
		function deliverNow(state, entry) {
			if (ctx.agents.get(state.agent.id) !== state.agent) return;
			if (state.agent.status !== "idle") return;
			entry.lastDeliveredAt = Date.now();
			entry.updatedAt = entry.lastDeliveredAt;
			persistAll();
			state.agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: entry.prompt
				}],
				source: {
					kind: "plugin",
					plugin: PLUGIN_ID
				}
			}));
		}
		for (const entry of loadStoreLoops()) persisted.set(entry.id, entry);
		sweepStale();
		for (const id of persisted.keys()) {
			const seq = Number(/^(?:loop-)?(\d+)$/.exec(id)?.[1] ?? "0");
			if (Number.isFinite(seq) && seq > loopSeq) loopSeq = seq;
		}
		for (const entry of persisted.values()) remount(entry, ctx.agents.get(entry.agentId));
		ctx.on("agent/created", ({ agent }) => {
			for (const entry of persisted.values()) {
				if (entry.agentId !== agent.id) continue;
				remount(entry, ctx.agents.get(agent.id) ?? agent);
			}
		});
		ctx.on("agent/disposed", (agent) => {
			for (const [loopId, state] of [...loops]) {
				if (state.agent !== agent) continue;
				detach(state);
			}
		});
		ctx.interval(() => {
			sweepStale();
		}, SWEEP_INTERVAL_MS);
		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: LOOPS_PATH,
			handler: async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://dsh.internal");
					if ((req.method ?? "GET").toUpperCase() === "POST") {
						let body = "";
						for await (const chunk of req) body += String(chunk);
						let id = "";
						try {
							id = String((JSON.parse(body) ?? {}).id ?? "").trim();
						} catch {}
						if (id === "") {
							res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ error: "stop needs a loop id" }));
							return;
						}
						const stopped = stopLoop(id);
						res.writeHead(stopped ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: stopped,
							id
						}));
						return;
					}
					const sessionId = url.searchParams.get("sessionId") ?? "";
					const now = Date.now();
					const rows = [];
					const rowOf = (id, agentId, prompt, intervalMs, lastDeliveredAt) => {
						const nextTick = lastDeliveredAt === void 0 ? now : lastDeliveredAt + intervalMs;
						rows.push({
							id,
							agentId,
							prompt,
							intervalMs,
							intervalText: formatInterval(intervalMs),
							nextTickAt: nextTick
						});
					};
					for (const [loopId, state] of loops) {
						if (sessionId !== "" && state.agent.id !== sessionId) continue;
						rowOf(loopId, state.agent.id, state.entry.prompt, state.entry.intervalMs, state.entry.lastDeliveredAt);
					}
					const liveIds = new Set(loops.keys());
					for (const entry of persisted.values()) {
						if (liveIds.has(entry.id)) continue;
						if (sessionId !== "" && entry.agentId !== sessionId) continue;
						rowOf(entry.id, entry.agentId, entry.prompt, entry.intervalMs, entry.lastDeliveredAt);
					}
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ loops: rows }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: message }));
				}
			}
		}), "loop: status + stop route");
		/** 命令：/loop [interval] <prompt> | /loop stop [id] | /loop list */
		ctx.commands.register({
			name: "loop",
			description: "Run prompts on a schedule (multiple loops per session): /loop [interval] <prompt> | /loop stop [id] | /loop list",
			input: { hint: "[interval] <prompt>" },
			handler: (invocation) => {
				const raw = invocation.rawInput.trim();
				if (raw === "" || raw === "list") {
					const active = agentLoops(invocation.agent);
					if (active.length === 0) return {
						kind: "success",
						text: "No active loop.\nUsage: /loop [interval] <prompt> — e.g. /loop 5m check the deploy\nBare /loop runs the built-in maintenance prompt.\nMultiple loops may run in parallel; stop one with /loop stop <id>.\nLoops persist across restarts and re-attach when their session resumes."
					};
					return {
						kind: "success",
						text: active.map((s) => `${s.id}: every ${formatInterval(s.intervalMs)} — ${s.prompt}`).join("\n")
					};
				}
				const stopMatch = /^stop(?:\s+(\S+))?$/.exec(raw);
				if (stopMatch !== null) {
					const target = stopMatch[1]?.trim();
					if (target !== void 0) {
						const hit = agentLoops(invocation.agent).find((s) => s.id === target);
						return hit !== void 0 && stopLoop(hit.id) ? {
							kind: "success",
							text: `Loop ${target} stopped.`
						} : {
							kind: "error",
							text: `No active loop with id ${target}.`
						};
					}
					const stopped = stopAgentLoops(invocation.agent);
					return stopped > 0 ? {
						kind: "success",
						text: `Stopped ${stopped} loop${stopped > 1 ? "s" : ""}.`
					} : {
						kind: "error",
						text: "No active loop to stop."
					};
				}
				if (raw === "clear") {
					const stopped = stopAgentLoops(invocation.agent);
					return stopped > 0 ? {
						kind: "success",
						text: `Stopped ${stopped} loop${stopped > 1 ? "s" : ""}.`
					} : {
						kind: "error",
						text: "No active loop to clear."
					};
				}
				const tokens = raw.split(/\s+/);
				const intervalMs = parseIntervalMs(tokens[0]);
				const prompt = intervalMs === null ? raw : tokens.slice(1).join(" ");
				return {
					kind: "success",
					text: `${startLoop(invocation.agent, prompt, intervalMs ?? 6e4).id} started: every ${formatInterval(intervalMs ?? 6e4)} — ${prompt}`
				};
			}
		});
		/** 工具：模型自调节入口（start/stop/status/list）。 */
		ctx.tools.register(defineTool({
			name: "loop",
			description: "Start, stop, or inspect scheduled loops on the current agent. Multiple loops may run in parallel; start creates a new one each time. A loop re-delivers a prompt every interval; use it for polling, PR babysitting, or build-fix-test cycles. The model may adjust the interval or stop the loop each round, which is the self-paced mode. Loop definitions persist across restarts and re-attach when their session resumes.",
			parameters: {
				action: {
					type: "string",
					required: true
				},
				prompt: { type: "string" },
				interval: { type: "string" },
				loop_id: { type: "string" }
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			execute: async (args) => {
				const agent = ctx.agents.currentInitiator();
				if (agent === void 0) throw new Error("loop tool requires an active agent turn");
				switch (args.action) {
					case "start": {
						if (typeof args.prompt !== "string" || args.prompt.length === 0) throw new Error("loop start needs a prompt");
						const intervalMs = typeof args.interval === "string" ? parseIntervalMs(args.interval) ?? 6e4 : 6e4;
						return `${startLoop(agent, args.prompt, intervalMs).id} started: every ${formatInterval(intervalMs)} — ${args.prompt}`;
					}
					case "stop": {
						const target = typeof args.loop_id === "string" ? args.loop_id : void 0;
						if (target !== void 0) {
							const hit = agentLoops(agent).find((s) => s.id === target);
							return hit !== void 0 && stopLoop(hit.id) ? `loop ${target} stopped` : `no active loop with id ${target}`;
						}
						const stopped = stopAgentLoops(agent);
						return stopped > 0 ? `stopped ${stopped} loop${stopped > 1 ? "s" : ""}` : "no active loop";
					}
					case "status":
					case "list": {
						const active = agentLoops(agent);
						return active.length === 0 ? "no active loop" : active.map((s) => `${s.id}: every ${formatInterval(s.intervalMs)} — ${s.prompt}`).join("\n");
					}
					default: throw new Error(`unknown loop action: ${String(args.action)}`);
				}
			}
		}));
	}
};
//#endregion
export { LOOPS_PATH, src_default as default };
