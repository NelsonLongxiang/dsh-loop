# @dsh-external/dsh-loop

定时循环插件：`/loop` 命令 + `loop` 工具（模型自调节）+ 对话页活动状态条。按固定间隔向当前 agent 重复投递 prompt——适合轮询、PR 看护、build-fix-test 循环。对齐 Claude Code 的 `/loop` 语义，支持**多 loop 并行**（一个会话可同时跑多个）。

形态：官方 **bundle 插件**（`dsh.bundle` + dshClient 通道），经 `dsh plugin --profile web add` 挂载，0 patch。

## 能力

| 能力 | 说明 |
|---|---|
| `/loop [间隔] <prompt>` | 启动新循环（间隔支持 `5m`/`30s`/`1h`/`2d` 或裸数字=分钟；裸 `/loop` 用内置维护 prompt） |
| `/loop list` | 列出当前会话全部循环（含 id） |
| `/loop stop <id>` / `/loop stop` | 停指定循环 / 停全部 |
| `loop` 工具 | 模型自调节入口：`start` / `stop [loop_id]` / `status` / `list` |
| 活动状态条 | 对话页输入框上方 dock 卡片：`● ⟳ 循环中 · <prompt> · 5m · 下次 23s`，多循环堆叠显示 |

## 安装

```sh
# 本地目录（开发/分发）
dsh plugin --profile web add <此仓库路径>

# git 源（需先构建产物入库或本地可解析；peer 依赖 @deepseek-ai/* 需能被 profile
# pnpm 闭包解析——官方流程要求 git 包构建后 lib/ 存在）
dsh plugin --profile web add git+file:///<此仓库路径>#<commit>
```

装完 **重启 web** 生效（bundle 挂载在启动时合成）；之后可在设置页「插件」面板停用/启用（运行时生效 + 持久化）。

## 使用

```sh
# 用户侧
/loop 5m 检查 deploy 分支的 PR      # 每 5 分钟投递一次
/loop list                           # loop-1: every 5m — 检查 deploy 分支的 PR
/loop stop loop-1                    # 停指定
/loop stop                           # 停全部

# 模型侧（loop 工具，每轮可自调节）
loop action=start prompt="修 flaky test" interval="2m"
loop action=status
loop action=stop loop_id="loop-2"
```

循环活在当前 harness 进程，随进程退出消失（不跨重启持久化，与 Claude Code `/loop` 一致）。

## 开发

```sh
pnpm install
pnpm run build      # tsdown：Node half (lib/index.mjs) + client bundle (lib/client.js)
```

- Node half：`src/index.mjs`（命令/工具/loops 状态路由 `/plugins/dsh-loop/loops`）
- client：`src/client/index.tsx`（dock 槽状态条）
- 构建产物 `lib/` 不入库（安装路径含 `pnpm run build`/`prepare`）

## 许可

BSD-3-Clause（dsh-external 生态示例插件）。
