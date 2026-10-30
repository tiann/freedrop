---
title: freedrop 命令行：在终端、SSH 服务器和手机之间传文件
description: 一条命令把文件从终端或 SSH 服务器发到手机、浏览器或另一台电脑：点对点直连、端到端加密、可断点续传，无需注册。
---

# 在终端里传文件

`npx freedrop <文件>` 能把文件从任意终端——你的笔记本、SSH 登录的服务器、CI 机器——直接发到另一台设备。对方在自己的终端里运行 `npx freedrop <code>`，或者在任意浏览器里打开一个链接就能接收。数据经端到端加密的 WebRTC 连接点对点传输，没有服务器存储或中转，不用注册，也不限文件大小。

## 发送

```bash
npx freedrop report.pdf photos.tgz
```

在终端里，发送方会打印三种进入同一次传输的方式，背后都是同一个新生成的 256 位密钥：

- 在另一台机器上运行的命令：`npx freedrop <code>`
- 任意浏览器都能打开的链接：`https://freedrop.dev/r/#<code>`
- 这个链接的二维码，给手机摄像头扫

之后它会一直等接收方（加 `--timeout` 才会超时退出），等接收方校验完每一个字节后退出。多个文件作为一次传输发出。参数必须是普通文件，目录请先用 `tar` 打包。

## 接收

```bash
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

在 `npx freedrop` 后面跟上代码，或者整个链接（带不带 `https://` 都行）。接收方会先列出要收的文件，问过你才保存；加 `-y` 跳过确认，用 `-o <目录>` 保存到当前目录以外的地方。

收到的数据先暂存在隐藏的 `.freedrop-stage/` 目录里，旁边有一个记录已到达部分的小日志。每个文件通过 SHA-256 校验后才以真实文件名出现，传输完成后暂存目录自动删除。已有文件不会被覆盖：重名的文件会存为 `name(1).ext`。接收方每存好一个文件打印一行 `saved: <path>`。

## 从服务器传到手机

你登录在一台远程机器上，想把上面的某个文件弄到手机里：

```bash
ssh build-box
npx freedrop build/app-release.apk
```

用手机相机扫终端里的二维码，或者在 [freedrop.dev](/zh/) 上用「扫码接收」。传输会在手机浏览器里打开，点保存，文件就到了手机上。手机上什么都不用装，也不用先 `scp` 到笔记本再转一道。

## 从手机或任意浏览器传到服务器

在手机上打开 [freedrop.dev](/zh/)，选好文件。页面会显示一个链接、一个二维码和一行 `npx freedrop <code>`；把其中任意一个弄到要接收的机器上（比如把链接发给自己），然后运行：

```bash
npx freedrop 'https://freedrop.dev/r/#uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA'
```

传完之前请保持网页打开：浏览器作为发送方时，刷新页面后无法续传。

## 两台电脑之间

```bash
# 在第一台机器上
npx freedrop dataset.tar
# 在第二台机器上：运行第一台打印出来的那行
npx freedrop uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA
```

家里、公司、云服务器，不同网络、不同 NAT 都没关系。不用配 SSH 密钥，不用端口转发，也不用共享网盘。速度取决于两台机器之间的网络路径：本机回环 CLI 对 CLI 约 430 MB/s，超过 64 MB 的传输拆到四条连接上并行，小文件一个接一个流水线发送。

## 传输中断了

不会从头再来。接收方的日志记着哪些字节区间已经落盘，任何一次重连都只补传缺失的部分。

- **网络抖动**：两端都还在运行，会自动重连；接收方会持续重试约 90 秒。
- **接收方停了**：重新运行同一条接收命令，`-o` 目录保持不变。
- **发送方停了**：用同一个代码、同样的文件重新运行（见下），还在等待的接收方会自动重连。

```bash
npx freedrop --code uMDpiKrcHEIabTuxSCnCUOTdLoMs4DRLGP0lPmC8gVA dataset.tar
```

中断或掉线的传输会打印出续传所需的完整命令。如果源文件在中途被改动，校验会明确报错，而不是落下一个损坏的文件；重新运行会把这个文件完整重传。

## 严格的 NAT 环境

NAT 打洞能覆盖大多数家庭和移动网络。唯一打不通的情况，是两端都在对称型 NAT 或运营商级 NAT（CGNAT）后面，这时传输会以退出码 4 失败。给发送方加一个 TURN 中继即可——传输仍然端到端加密，中继只转发它解不开的数据包：

```bash
# Cloudflare TURN，每月 1 TB 免费（控制台 → Realtime → TURN）
CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… npx freedrop --turn cloudflare big.iso

# 或自建 coturn，或任何静态凭据的 TURN 服务
npx freedrop --turn turn:turn.example.com:3478 --turn-auth user:pass big.iso
```

freedrop 故意不内置中继兜底：正因如此它没有流量费用，也没有谁的服务器会经手你的数据。[工作原理](/zh/security/)一页讲了这个取舍。

## 选项

| 参数 | 用于 | 作用 |
|---|---|---|
| `-y`, `--yes` | 接收 | 跳过确认提示（没有终端时必须加） |
| `-o`, `--out <dir>` | 接收 | 保存到这个目录（默认：当前目录） |
| `--code <code>` | 发送 | 复用一个传输代码，用来续传中断的发送 |
| `--turn <target>` | 两端 | `cloudflare`，或一个 `turn:` / `turns:` 地址 |
| `--turn-auth <u:p>` | 两端 | `--turn` 地址的凭据 |
| `--broker <list>` | 两端 | 自定义的 `wss://` MQTT 服务器，逗号分隔 |
| `--no-qr` | 发送 | 不打印二维码（没有终端时本来就不打印） |
| `--timeout <dur>` | 发送 | 没有传输在进行时，等这么久就放弃（`600`、`90s`、`10m`、`1h`） |
| `--json` | 两端 | stdout 上每行一个 JSON 事件，给人看的文字改走 stderr |

`-h` 显示帮助，`-v` 显示版本。

## 在脚本和 CI 里

没有终端时——在脚本里、CI 任务里、AI Agent 的 shell 里——freedrop 只输出纯文本行：不打二维码，不原地刷新进度条（改为每 10 秒一行进度），接收方没加 `-y` 会直接退出，而不是等一个没人回答的确认。加 `--json` 得到逐行的机器可读事件，加 `--timeout` 免得发送方一直等下去：

```bash
npx -y freedrop --json --timeout 10m report.pdf
npx -y freedrop --json -y -o downloads 'https://freedrop.dev/r/#…'
```

`npx -y` 跳过 npm 的安装确认，第二个 `-y` 是 freedrop 自己的。退出码是稳定的，并且说明下一步该做什么——完整的事件和退出码参考见[给 AI Agent 用的 freedrop](/zh/agents/)。

## 装不装都行

`npx freedrop` 不用安装任何东西就能运行。想常驻的话：

```bash
npm i -g freedrop
freedrop report.pdf
```

freedrop 需要 Node.js 22 及以上（用到它内置的 WebSocket）。CLI 通过 node-datachannel 使用原生 WebRTC，Linux、macOS、Windows 的 x64 和 arm64 都有预编译版本；其他平台会退回纯 JavaScript 实现的 werift（约 40–70 MB/s）。设置 `FREEDROP_RTC=js` 可以强制使用后者。
