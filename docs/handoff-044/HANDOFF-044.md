# dsh-loop 0.4.4 上线交接（唯一剩余动作：重启 3080）

> 2026-09-02 05:30。监督环 loop-174 已停（剩余动作非催办可解，重启按钮在龙翔/守护手里）。

## 归档说明（2026-10-16，归档会话补记）
- **重启动作已完成**：3080 宿主进程 67288 于 2026-10-16 04:56:05 启动（晚于本交接的部署动作）；本交接的「唯一剩余动作」已消解。
- **0.4.4 → main 已收口**：gitee/main（967e96f）并入 main（合并提交 02a89a4），catch-up 修复（armCatchUp 短周期补投）现同时在 main 源码与 lib 构建产物中；selftest 8/8 绿。
- **快照已删**：`.tmp-snap-pre044.json` / `.tmp-loops-pre044.json`（升级前 route/store 各 15 条）在其用途（升级前后守恒比对）完成后随清理删除，本文件保留其结论数字。
- **脚本归档修正**：`verify-044.mjs` 随档迁入本目录，并修正原稿 require（在 "type":"module" 下无法运行）为 ESM import。
- **注意（当时运行态）**：3080 当前组合已不含 dsh-loop（profile 于 2026-10-16 12:29 重建，补丁引入 `@nelsonlongxiang/dsh-graph-loop`），`/plugins/dsh-loop/loops` 返回 404，本脚本的 1)/4) 项在插件重新装入前必然失败。

## 唯一剩余动作
```bash
taskkill /PID 300840 /F
# 守护按原命令自动拉起（node --import tsx/esm apps/cli/src/bin.ts web --port 3080）
```

## 重启后一键终验
```bash
node D:\workspace\dsh-loop\verify-044.mjs
```
预期四件：route 200 + loops≈15 条守恒 / overdue 应逐步收敛（catch-up 生效）/ ledger remounted 行新增 / bundle POLL_IDLE_MS = 3e5。

## 已就绪证据链
- 0.4.4 合并：Gitee PR#3（PR#4 号位）merged，main=967e96f
- npm：@nelsonlongxiang/dsh-loop@0.4.4，shasum 6cdf0ca4，七项直验全绿
- 3080 磁盘：manifest+node_modules 双证 0.4.4（编排节点 03:49 装机）
- 3082：0.4.4 实装运行态（02:48 重启，路由 200）
- selftest：8/8 绿（场景 8 = 饿死修复核心：无 tick 落 idle 窗时定时器自行补投）
- 快照：升级前 route/store 各 15 条（.tmp-snap-pre044.json / .tmp-loops-pre044.json）

## 修复语义
busy tick 吞掉一整个 interval（overdueMs >= intervalMs）→ 武装 armCatchUp 短周期补投定时器
（min(60s, intervalMs/4)，ctx.timeout + setTimeout 降级），idle 即投一次（合并 overdue 轮防风暴），
仍忙则续期；投递后恢复正常 interval 节奏。paused/remount/sweep 语义不变。
