# dsh-loop 持久化战役 · 决策与约束记忆

> 更新：2026-09-02。锚定：本文件 + 会话（dsh/1f1e8fd8）。供后续会话 obelisk --search "dsh-loop" 命中。

## 决策（Decision）
1. dsh-loop 分发线 = 私网 npm（@nelsonlongxiang/dsh-loop，jf-tech Gitea registry）；公网 @vlln scope 已弃（无权限+白名单）。
2. PR 线 = Gitee（NelsonLongXiang/dsh-loop，private）；GitHub fork 降级为镜像。作者不自合，合并归运维线。
3. 流水线固定五段：worktree(.claude/worktrees/*) → Gitee PR → 门禁(build+selftest+@vlln 零) → 私网发版+tarball 直验 → 3082 干净验证 → 3080 生产（红线：loops.json 数据守恒）。
4. 跨节点对账纪律：先 git fetch <remote> 再读远端；grep 转义防模板字面量吃反斜杠（两次事故：fetch origin fork 坏 refspec、\| 被吃成 |）。
5. 生产 profile package.json 多会话并发写无串行化——file: 引用必须有属主确认，用后还原 spec（taskboard 事故 2026-08-22）。

## 理由（Rationale）
- catch-up 缺陷（0.4.4 修复对象）：deliver() busy-skip 无补偿 → 宿主常驻 turn 时循环饿死（实证：12/16 overdue，最大 5.6 天，loop-169 迟 60min=连踩 3 tick）。
- 暂停三态（0.4.3）：active/paused/stopped；paused 豁免 sweep；重启保持 paused；resume 从 now 起算不补投。

## 关键约束（Constraints）
- 3080 生产 = 本 GUI；重启需外部节点（20bf4588 系统运维位）执行，寄宿会话不能自重启。
- 进程查杀铁律：锚定名+滤父链+pgrep 核对+精确 kill（龙翔令 2026-08-23）。
- 工作区七规范（dsh-open-a2a-net/docs/a2a-workspace-collaboration.md @05279c0）：主区只读/worktree 强制仓内/禁 /tmp 可复现脚本/Gitee 内部 PR/门禁强制/PR 后 20min 定时查。
- loops.history.jsonl append-only，永不删（审计特性）。
- 属地优先：自己工作区任务优先执行；跨区仅空闲协助；派单前核属地待办。

## 版本史
0.4.1 持久化上线 → 0.4.2 退避+台账 → 0.4.3 暂停/恢复（Gitee PR#1, 582887e）→ 0.4.4 catch-up（d42fe125 承接）→ 0.4.5 双线收口：上游 vlln 同步（设置页注入/0.2.0 对齐/`/loop` 菜单图标，00c8411）+ gitee 0.4.4 catch-up 整合（02a89a4），lib 重建、selftest 8/8 → 0.4.6 哑弹（宽区间 peer 过不了安装门禁，勿装）→ 0.4.7 修正 peer 后发布实装 → 0.4.8 原地编辑指令/间隔（editLoop：运行/暂停/休眠三态、interval 重挂、台账 edited、状态条 ✎ 内联编辑；selftest 场景 9）→ 0.4.9 状态条编辑框补间隔字段（纯 client 面：intervalToToken 回填 + 非法红边禁提交；服务端 0.4.8 已支持 interval）→ 0.4.10 路由 fail-closed：显式未知 action 一律 400 不再回落 stop（事故：3080 宿主未重启、node 半停在 0.4.7，新 client 的 edit 被旧路由当未知动作回落成 stop 删掉 loop-201；裸 `{id}` 无 action 仍按 0.1 兼容视为 stop；selftest 场景 7 加回归）。

## 运行态（2026-10-16 归档会话实测，供后续会话判据）
- 3080 宿主进程 67288 于 2026-10-16 04:56:05 启动（晚于 0.4.4 部署 → 交接要求的重启已完成）；ledger 最后写入停在 04:45（属于上一个进程）。
- 当前 web profile 组合**不含 dsh-loop**：`profiles/web/package.json` 无该依赖、`~/.dsh` 与 DSH 安装树内无安装目录、补丁条目现为 `@nelsonlongxiang/dsh-graph-loop`（profile 于 12:29 重建、补丁 13:10 改动）。
- 后果：`/plugins/dsh-loop/loops` 与 client bundle 均 404；`plugins-data/dsh-loop/loops.json` 尚存 4 条（2 条 paused，含 2026-09-23 起暂停的 A2A 代决策 loop-186），当前无人驱动。
- 处置边界：本次未改 profile、未重启/杀进程、未装包（属地铁律）；恢复需属地授权。
- 分支卫生（2026-10-16）：gitee `fix/catchup-0.4.4`/`catchup-fix-gitee-0.4.4`/`fix/catchup-delivery` 与 fork `perf/poll-60s`/`feat/0.4.2-idle-backoff-audit` 已删（内容均在 main）；fork `fix/catchup-delivery-v2`(708c5a4) 保留——同功能但基线为已废弃的会话作用域线（`settingsNamespace` 导入已被上游 de50862 删除）。
