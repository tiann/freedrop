# AGENTS.md

Notes for coding agents (and people) working on freedrop. The README
covers what the tool does and how it works; this file covers what the
code won't tell you at a glance.

## Layout

| File | Role |
|---|---|
| `cli.mjs` | the whole Node CLI: arg parsing, WebRTC engine choice, send, receive, staging and landing |
| `app.js`, `index.html` | the web client — a static page, no build step |
| `signal.mjs` | rendezvous over MQTT (encrypted room, SDP/ICE exchange), used by both CLI and page |
| `lock.mjs` | directory lease lock guarding the CLI receiver's staging directory |
| `qr.mjs` | dependency-free QR encoder for the page |
| `test/` | `node --test` suites; `helpers.mjs` spawns real CLI processes |

`.github/workflows/pages.yml` publishes the **entire repository root** to
freedrop.dev on every push to `main` — anything committed is public on the
site.

## Commands

- `npm test` — lock, CLI⇆CLI and QR suites. Real WebRTC over loopback,
  SIGKILL-driven resume scenarios; takes minutes, not seconds.
- `npm run test:browser` — Playwright. Run `npx playwright install chromium`
  once, or set `FREEDROP_TEST_CHROMIUM` to a Chromium / headless-shell binary.
- One test: `node --test --test-name-pattern="<regex>" test/cli.test.mjs`.
- Signaling goes through public MQTT brokers by default and can flake. For
  a hermetic run, point `FREEDROP_TEST_BROKER` at a local `ws://` MQTT
  broker — CI runs mosquitto with a websockets listener
  (`.github/workflows/test.yml`).
- No build, linter or type checker. Node 22+.

## Environment hooks

| Variable | Effect |
|---|---|
| `FREEDROP_TEST_BROKER` | tests: every CLI gets `--broker`, and the page's `DEFAULT_BROKERS` is rewritten |
| `FREEDROP_TEST_CHROMIUM` | browser tests: Chromium executable to launch |
| `FREEDROP_BPS` | sender rate cap in bytes/s — gives kill-mid-transfer tests a deterministic window |
| `FREEDROP_RTC=js` | force the werift (pure JS) engine instead of node-datachannel |
| `FREEDROP_DEBUG` | `[dbg]` / `[rtc:…]` logging to stderr |
| `FREEDROP_PAGE` | base URL of the links the CLI prints (default `https://freedrop.dev/`) |

## Invariants that break things quietly

- **The protocol is implemented three times**: in `cli.mjs`, in `app.js`,
  and again in the worker source string `WORKER_SRC` inside `app.js` —
  framing, offset ranges, block hashing and timing constants
  (`STRIPE_MIN`, `CONNECT_WINDOW`, …). Change them together and run the
  browser tests, which cover CLI⇆browser in both directions.
- **Codes are base64url, so 1 in 64 starts with `-`.** The arg parser
  must recognize a code (`looksLikeCode`) before treating a leading dash
  as an option. There is a regression test for it.
- **Don't use node-datachannel's `setSctpSettings`.** Any buffer override
  tears down associations under full-rate load (see the note in
  `cli.mjs`); WAN throughput comes from striping over 4 connections.
- **npm ships only what `files` in `package.json` lists** (`cli.mjs`,
  `lock.mjs`, `signal.mjs`). A new module the CLI imports must be added
  there, or the published package breaks while every local test passes.
- **`signal.mjs` is shared with tango-mirror**: keep it dependency-free
  and its exports stable. The browser test server rewrites its
  `export const DEFAULT_BROKERS = [...]` line by regex — keep that
  declaration in that shape.
- **Staging, landing and `lock.mjs` are concurrency-critical.** Receivers
  stage under `.freedrop-stage/<rid>/` (rid derives from the code, the
  slot is the manifest index) and land files with no-replace semantics.
  Plausible-looking changes here have failed under multi-process stress
  before; a change needs an adversarial test in the style of
  `test/lock.test.mjs`.

## Output the tests depend on

CLI — tests merge stdout and stderr and match on text:

- the sender prints `npx freedrop <code>`
- `resuming`, `reconnecting`, `no longer matches`
- the receiver prints one `saved: <path>` line per file
- without a terminal: no QR code, no `\r`/ANSI redraws, and a receiver
  without `-y` exits 1 saying `pass -y`

Web page — `test/browser.test.mjs` reads state from the DOM:

- `#link` text contains `npx freedrop <code>` with nothing alphanumeric
  right after the code, so the CLI command must be the last text in
  `#link` and its copy button stays icon-only
- `#status` contains `✓` when done and has the `error` class on failure
- the receive button's accessible name matches `/Save|保存/`; file rows
  are `.file a` containing the file name; progress is the single
  `#bar div`, with a percentage `style.width`; the sender's file input
  is `#picker`
- a sending page sets `onbeforeunload`, so a test that reloads or
  navigates away from it gets blocked

## Releasing

Never `npm publish` by hand: `npm version patch` then
`git push origin main --follow-tags`. The tag runs `release.yml` (both
test suites, then npm Trusted Publishing). See README → Publishing.
