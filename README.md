<h1 align="center">loop</h1>

<p align="center">定时循环插件：/loop 命令 + loop 工具（模型自调节）+ 对话页活动状态条，支持多循环并行</p>

<p align="center">
  <img src="https://badgen.net/badge/license/BSD-3-Clause/blue" alt="license">
</p>

按固定间隔向当前 agent 重复投递 prompt——适合轮询、PR 看护、build-fix-test 循环。对齐 Claude Code 的 `/loop` 语义，**一个会话可同时跑多个循环**。形态：官方 **bundle 插件**（`dsh.bundle` + dshClient 通道），0 patch。

## 效果

![loop 状态条（真实运行截图：对话页 dock 双循环）](docs/preview/loop.png)

## 能力

**工具**（`defineTool` 注册，模型每轮可自调节）：

| 工具 | 说明 |
|---|---|
| `loop` | start（启动新循环）/ stop（停指定或全部）/ status / list（列出当前会话循环） |

**命令**（用户侧）：

| 命令 | 说明 |
|---|---|
| `/loop [间隔] <prompt>` | 启动新循环（间隔 `5m`/`30s`/`1h`/`2d` 或裸数字=分钟；裸 `/loop` 用内置维护 prompt） |
| `/loop list` | 列出当前会话全部循环（含 id） |
| `/loop stop <id>` / `/loop stop` | 停指定循环 / 停全部 |

**UI**（对话页输入框上方 dock 槽）：

| 功能 | 说明 |
|---|---|
| 活动状态条 | `● ⟳ 循环中 · <prompt> · 5m · 下次 23s`，多循环堆叠、带 loop id |

## 安装

**推荐：git 源一行安装**（构建产物已入库，git 源不触发构建）：

```sh
dsh plugin --profile web add "github:vlln/dsh-loop#main"
```

或本地目录（有源码时）：`git clone` 后 `cd dsh-loop && dsh plugin --profile web add .`。

装完 **重启 web** 生效（bundle 挂载在启动时合成）；之后可在设置页「插件」面板停用/启用（运行时生效 + 持久化）。

## 使用

```sh
# 用户侧
/loop 5m 检查 deploy 分支的 PR      # 每 5 分钟投递一次
/loop list                           # loop-1: every 5m — 检查 deploy 分支的 PR
/loop stop loop-1                    # 停指定
/loop stop                           # 停全部

# 模型侧（loop 工具）
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

## 许可

BSD-3-Clause（dsh-external 生态示例插件）。
