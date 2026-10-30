---
title: freedrop 给 AI Agent：让 Agent 和人互传文件
description: 沙箱、容器或远程机器里的编程 Agent 如何用 npx -y freedrop --json 把文件交给你、或接收你的文件，以及稳定的退出码。
---

# 让 AI Agent 和人互传文件

编程 Agent 跑在你的下载文件夹够不着的地方：沙箱、容器、CI、远程机器。**freedrop** 给 Agent 一条命令把文件交给你——你在任意设备上打开一个链接就能收；再给它一条命令，接收你在浏览器里选好的文件。中间不上传到任何地方：数据在两端之间直接传输，端到端加密。

## 告诉你的 Agent

把下面这段粘贴到 Agent 会读的指令里（`AGENTS.md`、`CLAUDE.md` 或系统提示词）：

```text
要给我发文件时，在后台运行 `npx -y freedrop --json --timeout 10m <文件>`，
把它第一行输出里的 `link` 给我。要接收我的文件时，向我要 https://freedrop.dev/
页面上显示的链接，然后运行 `npx -y freedrop --json -y -o <目录> '<链接>'`。
详见 https://freedrop.dev/llms.txt
```

任何能执行 shell 命令的 Agent 都能用：Claude Code、Codex CLI、Gemini CLI、Cursor、Aider 等等。Agent 那一端需要 Node.js 22 及以上；你这边只要一个浏览器。

## 流程

1. **Agent → 你。** Agent 在后台启动发送端，stdout 的第一行是带 `link` 的 `ready` 事件；Agent 把链接转给你，你在手机或电脑上打开、保存文件。你那边每个字节校验通过后，发送端以 0 退出。
2. **你 → Agent。** 你打开 [freedrop.dev](/zh/)，选好文件，把页面给出的链接贴进对话。Agent 运行接收端，每个校验通过的文件都会产生一个带绝对路径的 `saved` 事件。传完之前请保持页面打开。

## 为什么它适合在 Agent 的 shell 里跑

- **没有终端也不卡住。** 没有 TTY 时只输出纯文本行——不打二维码、不原地刷新进度条；接收端没加 `-y` 会直接退出，而不是等一个没人能回答的确认。
- **输出可解析。** 加 `--json` 后 stdout 上只有逐行的 JSON 事件，给人看的文字改走 stderr。
- **退出码说明下一步。** 连接中途断开（8）就重跑同一条命令续传；连不上（4）就加 TURN 中继重试；超时（7）说明没人来接。
- **等待有上限。** `--timeout` 只计算没有传输进行时的时间，慢速传输不会被误杀。
- **链接和代码都认。** 接收端接受浏览器链接（带不带 `https://` 都行），也接受裸代码。

## 参考

下面是 [/llms.txt](https://freedrop.dev/llms.txt) 中的同一份参考——写给 Agent 本身读的说明，原文为英文，与 llms.txt 保持同步。

@include llms.txt
