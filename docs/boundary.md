# Boundary: bundle plugin vs. library / 边界：bundle 插件还是库

> When to ship something as a DSH bundle plugin and when as a plain library,
> and why @vlln/dsh-loop could only ever be the former.
>
> 何时做成 DSH bundle 插件、何时做成普通库，以及为什么 @vlln/dsh-loop 只能是前者。

## The test / 判据

Per the DSH plugin-development rule, the question has exactly one axis:
**does the code need to mount into a running harness at runtime?**

按 DSH 插件开发规范的判据，问题只有一条主轴：**这段代码是否需要在运行时挂载进 harness？**

**Make it a plugin — any hit / 做成插件——命中任一条：**

- Registers runtime contributions: Service, event listener, model-facing tool,
  HTTP route, command, client slot, systemPrompt section.
  注册运行时贡献：Service、事件监听、模型工具、HTTP 路由、命令、client 槽、systemPrompt 段。
- Needs per-profile composition: a cordis.patch.yml row, loadable/disableable, static Config.
  需要 per-profile 组合：cordis.patch.yml 行、可装载/禁用、static Config。
- Has lifecycle and side effects: apply/dispose, timers, child processes, persistence owners.
  有生命周期与副作用：apply/dispose、定时器、子进程、持久化属主。

**Make it a library — ALL must hold / 做成库——须全部满足：**

- Pure logic: parsers, algorithms, codecs, pure project/fold functions; no ctx,
  no registration, no side effects.
  纯逻辑：解析器、算法、编解码、投影/折叠纯函数；无 ctx、无注册、无副作用。
- Consumed by import, testable with vitest standalone; users do not selectively
  install/uninstall it.
  复用方式是 import，可独立 vitest 单测；用户不需要选择性安装/卸载。

The red line: two plugins sharing pure logic extract a **library package**;
plugins never value-import each other — host-side collaboration goes through
**services**. Libraries live in the plugin's dependencies and ship with it.

红线：两个插件共享纯逻辑时提取**库包**；插件之间禁止值 import——host 侧协作必须走
**service**。库进插件的 dependencies 随插件分发。

## Why dsh-loop must be a bundle / 为什么 dsh-loop 必须是 bundle

Score @vlln/dsh-loop against the plugin column — it hits every row:
对照插件列逐条打分——它全中：

| Mount point / 挂载点 | Where / 位置 |
|---|---|
| HTTP route / HTTP 路由 | GET/POST /plugins/dsh-loop/loops — the dock status bar polls it / 状态条轮询的数据源 |
| Command / 命令 | /loop [interval] &lt;prompt&gt; \| stop \| list via ctx.commands |
| Model tool / 模型工具 | loop (start/stop/status) via ctx.tools + defineTool |
| Lifecycle / 生命周期 | ctx.interval timer per loop + daily stale sweep; ctx.effect route disposal / 每循环一个定时器 + 每日清扫；路由随 fiber 释放 |
| Events / 事件 | agent/created（重启重挂锚）、agent/disposed（解绑不删定义） |
| Client slot / client 槽 | dshClient web half in conversation.input.dock（src/client/index.tsx） |
| Persistence / 持久化 | $DSH_HOME/plugins-data/dsh-loop/loops.json — the plugin owns this file's schema and lifecycle / 该文件的 schema 与生命周期归插件所有 |

There is no pure core worth extracting: interval parsing and formatting are the
only candidates, and shipping a dependency for two ten-line functions fails the
dependencies-over-hand-rolling test. The delivery mechanism — followup into a
live agent's inbox — is meaningless outside a mounted harness.

它没有值得抽出的纯核：间隔解析/格式化是仅有的候选，为两个十行函数引入依赖过不了
dependencies-over-hand-rolling 检验；而投递机制（向 live agent 的 inbox followup）
脱离挂载着的 harness 根本不存在。

**Conclusion**: bundle plugin, host + client halves, no library extraction.
**结论**：bundle 插件，host + client 双面，不做库抽取。
