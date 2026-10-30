---
title: freedrop 和 croc 对比：WebRTC 直连，还是有中继兜底
description: freedrop 和 croc 都端到端加密传文件。对比数据走向、口令、文件夹、续传和浏览器支持，以及各自适合什么场景。
---

# freedrop 和 croc 对比

要发文件夹、要一个能念出来的短口令，或者两端都在严格的 NAT 后面也必须传过去，选 croc——它有中继兜底。要数据路径上始终没有中继（包括一端是浏览器的时候），并且传输中断后用同一条命令或同一个链接就能续传，选 freedrop。

## 一览

| 项目 | freedrop | croc |
|---|---|---|
| 数据走向 | WebRTC 点对点直连；除非你自己加 TURN 服务器，否则永远不经过中继 | 两个新版 CLI 之间 NAT 穿透成功时直连；否则——以及对端是浏览器时——经中继转发 |
| 依赖的服务器 | 公共 MQTT 服务器，只传几 KB 的加密握手 | getcroc.com 域名下的公共中继，建立直连期间还会用公共 DERP 服务器 |
| 口令 | 一个 256 位密钥，约 43 个字符：复制、点链接或扫二维码 | 由几个单词组成的短口令，经 PAKE 保护；可自定义（至少 6 个字符） |
| 浏览器 | freedrop.dev 可收可发，直连 CLI 或另一个浏览器 | getcroc.com 可收可发，与 CLI 互通，经中继 |
| 文件夹 | 暂不支持，先用 `tar` 打包 | 支持，可一次发多个文件和文件夹 |
| 续传 | 支持：重跑命令或重新打开链接 | 支持 |
| 校验 | 按 4 MiB 分块做 SHA-256，通过后才以真实文件名出现 | 对文件做哈希，算法用 `--hash` 指定 |
| 接收方不在线 | 不行，两端必须同时在线 | 可选的存储模式，在服务器上暂存一份加密副本 |
| 安装 | `npx freedrop`（需 Node.js 22+），浏览器端什么都不用装 | 单个二进制：安装脚本、Homebrew、Scoop、apt 等；浏览器端什么都不用装 |

## 数据走哪条路

freedrop 只有一条数据路径：两台设备之间的 WebRTC 直连，DTLS 端到端加密。公共 MQTT 服务器只负责“介绍”——几 KB 的 AES-256-GCM 密文——之后就退出。freedrop 故意不设中继兜底：所以它没有流量费用，也没有任何服务器经手你的数据。

croc（v11）为了连上会更努力，也接受用中继来做到这一点。两个新版 CLI 之间，它先经 DERP 建立连接，NAT 穿透成功后再升级为 UDP 直连。如果失败，或者对端是浏览器、旧版客户端，数据就走 croc 的中继。croc 用 PAKE 握手得出的密钥做端到端加密，中继按理读不到内容——但它确实在路径上。

这个取舍是实打实的：croc 能连通的地方，freedrop 单靠自己不一定连得通。两端都在对称型 NAT 或运营商级 NAT（CGNAT）后面时，freedrop 需要你用 `--turn` 指定一个 TURN 中继（Cloudflare 的免费额度，或自建 coturn）。

## 口令和链接

croc 的口令是几个单词组成的短语，靠 PAKE 保证安全：电话里念得出，另一台机器上手敲也方便。`croc send --qr` 打印的二维码会打开 `https://getcroc.com/?code=…`——口令放在查询参数里，浏览器加载页面时会把它发给服务器。

freedrop 的代码就是密钥本身：256 位随机数，长到没法念。你只能复制、发链接或扫码。链接里的密钥在 `#` 后面，浏览器从不把这部分发给任何服务器——包括提供页面的 freedrop.dev。

## 什么时候 croc 更合适

- 两台机器都在对称型 NAT 或 CGNAT 后面，你又不想搭 TURN 服务器。
- 要发文件夹，或者带 `--exclude` 规则发一批文件。
- 口令只能靠嘴说，或者得手敲。
- 接收方没法同时在线：croc 可选的存储模式会暂存一份加密副本（默认一天、可下载一次）。
- 想用 `croc send --text` 发一段文字。

## 什么时候 freedrop 更合适

- 数据路径上一律不要中继——浏览器到终端、浏览器到浏览器也一样。
- 接收方用的是手机或别人的电脑：任意浏览器打开链接即可，中断了重新打开就续传。
- 文件必须原样到达：每个文件都经 SHA-256 校验后才以真实文件名出现，发送途中源文件被改动会明确报错。
- 由脚本或 AI Agent 执行传输：有 `--json` 事件和明确的退出码，见 [给 AI Agent 用](/zh/agents/)。
- 机器上已经有 Node.js：`npx freedrop` 就是全部安装步骤。

## 命令对照

| croc | freedrop |
|---|---|
| `croc send report.pdf` | `npx freedrop report.pdf` |
| `croc send photos/` | `tar czf photos.tgz photos && npx freedrop photos.tgz` |
| `croc <code>`（Windows），`CROC_SECRET=<code> croc`（Linux、macOS） | `npx freedrop <code>`，或者直接用链接 |
| `croc send --qr report.pdf` | `npx freedrop report.pdf`（在终端里会打印二维码） |
| `croc --relay host:9009 send report.pdf` | `npx freedrop --turn turn:host:3478 --turn-auth user:pass report.pdf` |
| `croc relay` | 任意 TURN 服务器，比如 coturn |
| `croc send --text "hi"` | 没有对应功能，写进文件再发 |

握手、加密和校验的细节见 [freedrop 的工作原理](/zh/security/)；全部选项见 [命令行指南](/zh/cli/)。
