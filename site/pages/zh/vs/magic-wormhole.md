---
title: freedrop 和 magic-wormhole 对比：链接与续传，还是短口令
description: freedrop 和 magic-wormhole 都端到端加密传文件。对比口令、中继、浏览器支持、文件夹和续传，以及各自适合的场景。
---

# freedrop 和 magic-wormhole 对比

magic-wormhole 是这类工具的经典：`7-crossover-clockwork` 这样一次性的短口令，靠 PAKE 保证短口令的安全，支持文件夹，直连失败时有中转中继接手。freedrop 放弃了短口令，换来任意浏览器都能打开的链接和二维码；数据路径保持直连、不设中继兜底；传输中断可以续传。怎么选，看对方手上有什么、口令怎么传过去。

## 一览

| 项目 | freedrop | magic-wormhole |
|---|---|---|
| 数据走向 | WebRTC 点对点直连；除非你自己加 TURN 服务器，否则永远不经过中继 | 能直连就直连，否则经公共中转中继（transit relay） |
| 依赖的服务器 | 公共 MQTT 服务器，只传几 KB 的加密握手 | 负责握手的 mailbox 服务器，以及中转中继；客户端内置了公共的默认地址 |
| 口令 | 一个 256 位密钥，约 43 个字符：链接、二维码或命令 | 数字加单词，如 `7-crossover-clockwork`；一次性；SPAKE2 PAKE |
| 加密 | 数据用 DTLS 端到端加密，握手用 AES-256-GCM | NaCl secretbox，密钥由 PAKE 推导 |
| 浏览器 | freedrop.dev 可收可发，直连 CLI 或另一个浏览器 | 官方客户端是命令行；Winden、wormhole.page 等第三方网页客户端兼容同一协议 |
| 文件夹 | 暂不支持，先用 `tar` 打包 | 支持 |
| 续传 | 支持：重跑命令或重新打开链接 | 文档未提及；传输完成前两端客户端都必须保持运行 |
| 时间要求 | 两端同时在线；发送方愿意等多久就等多久（`--timeout`） | 两端客户端应在大约一小时内先后启动 |
| 安装 | `npx freedrop`（需 Node.js 22+），浏览器端什么都不用装 | Python 包：pip、apt、Homebrew、Snap、winget、Chocolatey；另有 Go、Rust 实现 |

## 数据走哪条路

magic-wormhole 的两端先在 mailbox 服务器上碰头——一个小型 WebSocket 中继，负责转交 PAKE 握手和少量消息。之后两端尝试直连，失败了就退回中转中继。无论走哪条路，数据都用 PAKE 得出的密钥加密，中继转发的只是密文。

freedrop 的握手走的是类似的路——公共 MQTT 服务器，发在由密钥推导出的话题上的 AES-256-GCM 密文——但数据只有一条路可走：WebRTC 直连。没有中转中继可退。好处是没有流量费用、路径上没有服务器；代价是两端都在对称型 NAT 后面时，需要你用 `--turn` 自备一个 TURN 中继。

## 短口令还是长密钥

wormhole 口令短到可以在电话里念，而且只能用一次。正是 PAKE 让这么短的口令可以放心用。

freedrop 没有 PAKE：代码就是每次传输新生成的 256 位密钥。念不出来，只能以链接、二维码或复制的命令传递。链接把密钥放在 `#` 后面，浏览器从不把这部分发给托管页面的服务器。

## 什么时候 magic-wormhole 更合适

- 口令只能靠嘴说，或者得手敲。
- 两端都在对称型 NAT 或 CGNAT 后面，你希望开箱即用：中转中继会接手。
- 要发整个目录。
- 想在 Python 程序里集成传输功能，或者想从众多兼容同一协议的桌面和手机应用里挑一个。

## 什么时候 freedrop 更合适

- 对方只有浏览器：在任意设备上打开链接，直接和你的终端连通。
- 文件大、传输可能被打断：重跑命令或重新打开链接，只补传缺失的部分。
- 数据路径上一律不要中继。
- 文件要端到端校验：按 4 MiB 分块做 SHA-256，通过后才以真实文件名出现。
- 由脚本或 AI Agent 执行传输：有 `--json` 事件和明确的退出码，见 [给 AI Agent 用](/zh/agents/)。

## 命令对照

| magic-wormhole | freedrop |
|---|---|
| `wormhole send report.pdf` | `npx freedrop report.pdf` |
| `wormhole receive`，再输入口令 | `npx freedrop <code>`，或者直接打开链接 |
| `wormhole send photos/` | `tar czf photos.tgz photos && npx freedrop photos.tgz` |
| 自建 mailbox 服务器 | `--broker` 指定自己的 `wss://` MQTT 服务器 |
| 自建中转中继 | `--turn turn:host:3478 --turn-auth user:pass` |

握手、加密和校验的细节见 [freedrop 的工作原理](/zh/security/)；全部选项见 [命令行指南](/zh/cli/)。
