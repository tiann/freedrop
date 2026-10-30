#!/usr/bin/env node
// Builds freedrop.dev into one directory (default _site/), ready to serve
// as it is:
//
//   /  and /zh/     the home pages, the app in their first screen
//   /r/             where every link opens: the receiving card, nothing else
//   /cli/, /vs/croc/ … and /zh/…   content pages from site/pages/<lang>/*.md
//   index.md        a Markdown twin next to every page, for agents
//   sitemap.xml, 404.html, manifest.zh.webmanifest
//
// plus the app's own files (app.js, signal.mjs, sw.js …), copied untouched —
// the app itself has no build step. No dependencies either:
// `node site/build.mjs [outDir]`.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SITE);
export const ORIGIN = "https://freedrop.dev/";
const REPO = "https://github.com/tiann/freedrop";
const NPM = "https://www.npmjs.com/package/freedrop";
const OG_IMAGE = `${ORIGIN}icons/og.png`;

// served path ← source, relative to the repo root
const COPY = {
    "app.js": "app.js", "signal.mjs": "signal.mjs", "qr.mjs": "qr.mjs", "sw.js": "sw.js",
    "manifest.webmanifest": "manifest.webmanifest", "icons": "icons", "llms.txt": "llms.txt",
    "site.css": "site/site.css", "robots.txt": "site/robots.txt",
};

const L = {
    en: {
        html: "en", hreflang: "en", og: "en_US", home: "", other: "zh",
        nav: "Site", how: "How it works", agents: "Agents", security: "Security", send: "Send files",
        switchTo: "中文", toc: "On this page", md: "This page in Markdown",
        ctaTitle: "Send something now", ctaLead: "No sign-up, and nothing to install on the other side.",
        ctaBtn: "Open freedrop", copy: "Copy command",
        footTag: "Peer-to-peer file transfer, no server in between.", footBy: "MIT License · by",
        footUse: "Use it", footCompare: "Compare", footMore: "More",
        sendLink: "Send files in the browser",
        what: "What is freedrop?",
    },
    zh: {
        html: "zh-Hans", hreflang: "zh-Hans", og: "zh_CN", home: "zh/", other: "en",
        nav: "站点导航", how: "原理", agents: "AI Agent", security: "安全", send: "发送文件",
        switchTo: "English", toc: "本页内容", md: "本页的 Markdown 版本",
        ctaTitle: "现在就发一个试试", ctaLead: "不用注册，接收方也不用装任何东西。",
        ctaBtn: "打开 freedrop", copy: "复制命令",
        footTag: "点对点传文件，不经过任何服务器。", footBy: "MIT 协议 · 作者",
        footUse: "使用", footCompare: "对比", footMore: "更多",
        sendLink: "在浏览器里发送文件",
        what: "freedrop 是什么？",
    },
};

const HOME = {
    en: {
        title: "freedrop — send files peer-to-peer, browser or terminal",
        description: "Send files of any size straight to another device, browser or terminal. End-to-end encrypted WebRTC: no upload, no account, no size limit. Free and open source.",
        ogTitle: "freedrop — send files peer-to-peer, no server in between",
        ogDescription: "Browser or terminal, either side. End-to-end encrypted, no upload, no account, no size limit.",
        ogAlt: "freedrop: send files peer-to-peer, browser or terminal, no server in between",
        trust: "End-to-end encrypted · nothing is uploaded",
    },
    zh: {
        title: "freedrop — 点对点传文件，浏览器与终端互传，不经过服务器",
        description: "freedrop 是免费开源的点对点文件传输工具：浏览器、终端任意互传，WebRTC 端到端加密。文件不上传、不限大小、无需注册，打开网页或运行 npx freedrop 即可。",
        ogTitle: "freedrop — 点对点传文件，不经过任何服务器",
        ogDescription: "浏览器、终端任意互传。端到端加密，不上传，不限大小，无需注册。",
        ogAlt: "freedrop：点对点传文件，浏览器与终端互传，不经过服务器",
        trust: "端到端加密 · 文件不上传",
    },
};

const APP = {
    "@type": "SoftwareApplication",
    "@id": `${ORIGIN}#app`,
    name: "freedrop",
    url: ORIGIN,
    description: "Free, open-source peer-to-peer file transfer between browsers and terminals. Files travel directly over end-to-end encrypted WebRTC; public MQTT brokers carry only an encrypted handshake. No upload, no account, no size limit; interrupted transfers resume and every file is verified with SHA-256.",
    applicationCategory: "UtilitiesApplication",
    applicationSubCategory: "File transfer",
    operatingSystem: "Any modern web browser; Linux, macOS and Windows via Node.js 22+ (npx freedrop)",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: "https://opensource.org/licenses/MIT",
    downloadUrl: NPM,
    image: OG_IMAGE,
    author: { "@id": `${ORIGIN}#author` },
    sameAs: [REPO, NPM],
    featureList: [
        "Peer-to-peer transfer over WebRTC; no server stores or relays the files",
        "End-to-end encryption: DTLS for data, AES-256-GCM for the handshake",
        "Any mix of browser and command line (npx freedrop) on either side",
        "No file size limit and no account",
        "Resumes interrupted transfers",
        "SHA-256 verification of every 4 MiB block",
        "QR code scanning and an installable web app with Android share target",
        "JSON events and stable exit codes for scripts and AI agents",
    ],
};

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#2f6bed"/><path d="M16 8v13m-5.5-5.5L16 21l5.5-5.5M10 24h12" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%232f6bed'/%3E%3Cpath d='M16 8v13m-5.5-5.5L16 21l5.5-5.5M10 24h12' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
const COPY_ICONS = `<svg class="cp" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg><svg class="ok" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;

const read = (path) => readFileSync(join(ROOT, path), "utf8");
export const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unesc = (s) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
// "../" per directory level: links between pages stay relative, so a copy
// hosted under any path works
const rootOf = (path) => "../".repeat(path.split("/").length - 1);
const json = (data) => JSON.stringify(data, null, 4).replaceAll("</", "<\\/");

// ---- Markdown → HTML ---------------------------------------------------------
// Only the dialect site/pages is written in: ATX headings, paragraphs, one
// level of - / 1. lists, fenced code, pipe tables, "> " callouts; inline
// `code`, **bold**, *em*, [links](url). Root-relative links (/cli/) come
// back through `href` so each page can make them relative.

export function inline(src, href) {
    const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;
    let out = "";
    let last = 0;
    for (let m; (m = re.exec(src));) {
        out += esc(src.slice(last, m.index));
        if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
        else if (m[2] !== undefined) out += `<a href="${esc(href(m[3]))}">${inline(m[2], href)}</a>`;
        else if (m[4] !== undefined) out += `<strong>${inline(m[4], href)}</strong>`;
        else out += `<em>${inline(m[5], href)}</em>`;
        last = re.lastIndex;
    }
    return out + esc(src.slice(last));
}

const slug = (text, seen) => {
    let id = text.toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    if (seen.has(id)) for (let n = 2; ; n++) if (!seen.has(`${id}-${n}`)) { id = `${id}-${n}`; break; }
    seen.add(id);
    return id;
};

const SHELLS = new Set(["bash", "sh", "shell", "console"]);
const codeBlock = (lang, lines) => {
    const body = lines.map((l) => {
        if (!SHELLS.has(lang)) return esc(l);
        if (l.startsWith("$ ")) return `<span class="p">$ </span>${esc(l.slice(2))}`;
        if (/^#( |$)/.test(l)) return `<span class="d">${esc(l)}</span>`;
        return esc(l);
    });
    return `<pre class="term"><code>${body.join("\n")}</code></pre>`;
};

export function markdown(src, href = (u) => u) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    const toc = [];
    const seen = new Set();
    let h1 = "";
    let lead = false; // the first paragraph after the h1 is the lead
    const isBlockStart = (l) => /^(```|#{1,3} |> |\||- |\d+\. )/.test(l);
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        let m;
        if (!line.trim()) { i++; continue; }
        if ((m = /^```(\w*)\s*$/.exec(line))) {
            const body = [];
            for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
            i++;
            html.push(codeBlock(m[1], body));
        } else if ((m = /^(#{1,3}) (.+?)\s*$/.exec(line))) {
            const level = m[1].length;
            const text = m[2];
            i++;
            if (level === 1) {
                h1 = text.replace(/[`*]/g, "");
                lead = true;
                html.push(`<h1>${inline(text, href)}</h1>`);
                continue;
            }
            const id = slug(text, seen);
            if (level === 2) toc.push({ id, text: text.replace(/[`*]/g, "") });
            html.push(`<h${level} id="${id}">${inline(text, href)}</h${level}>`);
        } else if (line.startsWith("> ")) {
            const body = [];
            for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^> ?/, ""));
            html.push(`<aside class="callout"><p>${inline(body.join(" "), href)}</p></aside>`);
        } else if (line.startsWith("|")) {
            const rows = [];
            for (; i < lines.length && lines[i].startsWith("|"); i++) {
                rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
            }
            const [head, , ...body] = rows; // row 2 is the |---| separator
            const label = head.map((h) => esc(h.replace(/[`*]/g, "")));
            html.push(`<table class="table">\n<thead><tr>${head.map((h) => `<th scope="col">${inline(h, href)}</th>`).join("")}</tr></thead>\n<tbody>\n${
                body.map((r) => `<tr>${r.map((c, j) => (j === 0
                    ? `<th scope="row">${inline(c, href)}</th>`
                    : `<td data-label="${label[j]}">${inline(c, href)}</td>`)).join("")}</tr>`).join("\n")
            }\n</tbody>\n</table>`);
        } else if ((m = /^(- |\d+\. )/.exec(line))) {
            const ordered = m[1] !== "- ";
            const items = [];
            for (; i < lines.length; i++) {
                const l = lines[i];
                if ((ordered ? /^\d+\. / : /^- /).test(l)) items.push(l.replace(/^(- |\d+\. )/, ""));
                else if (/^ {2,}\S/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
                else break;
            }
            const tag = ordered ? "ol" : "ul";
            html.push(`<${tag}>\n${items.map((t) => `<li>${inline(t, href)}</li>`).join("\n")}\n</${tag}>`);
        } else {
            const body = [];
            for (; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]); i++) body.push(lines[i].trim());
            html.push(`<p${lead ? ' class="lead"' : ""}>${inline(body.join(" "), href)}</p>`);
        }
        lead = false;
    }
    return { html: html.join("\n"), h1, toc };
}

// front matter: `key: value` lines between --- fences
const frontMatter = (src) => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
    if (!m) throw new Error("missing front matter");
    const meta = Object.fromEntries(m[1].split("\n").filter(Boolean).map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
    return { meta, body: src.slice(m[0].length) };
};

// `@include llms.txt` pastes the agent guide's reference sections, so the
// --json/exit-code contract keeps one source on the site too
const includes = (body) => body.replace(/^@include llms\.txt$/m, () => {
    const llms = read("llms.txt");
    return llms.slice(llms.indexOf("\n## ") + 1, llms.indexOf("\n## Docs")).trim();
});

// ---- HTML → Markdown -----------------------------------------------------------
// For the home pages' twins: their hand-written HTML, read back as text.
// Handles only the markup those pages use.
export function htmlToMarkdown(html, base) {
    const abs = (u) => (/^[a-z]+:/.test(u) ? u : new URL(u, base).href);
    const text = (s) => unesc(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const span = (s) => {
        // code first, held aside: its text may look like tags once unescaped
        const codes = [];
        s = s.replace(/<code>(.*?)<\/code>/gs, (_, c) => `\u0001${codes.push(unesc(c.replace(/<[^>]+>/g, ""))) - 1}\u0001`)
            .replace(/<(strong|b)>(.*?)<\/\1>/gs, "**$2**")
            .replace(/<em>(.*?)<\/em>/gs, "*$1*")
            .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs, (_, u, t) => `[${t}](${abs(unesc(u))})`)
            .replace(/<[^>]+>/g, "");
        return unesc(s).replace(/\s+/g, " ").trim().replace(/\u0001(\d+)\u0001/g, (_, n) => `\`${codes[n]}\``);
    };
    const blocks = [];
    const keep = (md) => `\u0000${blocks.push(md) - 1}\u0000`;
    let s = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(svg|script|style|button|figure)\b[\s\S]*?<\/\1>/g, "")
        .replace(/<p class="eyebrow">[\s\S]*?<\/p>/g, "")
        .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, c) => keep(`\`\`\`\n${unesc(c.replace(/<[^>]+>/g, ""))}\n\`\`\``))
        .replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, t) => {
            const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
                .map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => span(c[1])));
            const [head, ...body] = rows;
            return keep([head, head.map(() => "---"), ...body].map((r) => `| ${r.join(" | ")} |`).join("\n"));
        })
        .replace(/<span class="cmd"><span>([\s\S]*?)<\/span>/g, (_, c) => keep(`\`${unesc(c)}\``))
        .replace(/<li><h3>([\s\S]*?)<\/h3>([\s\S]*?)<\/li>/g, (_, h, t) => keep(`### ${text(h)}\n\n${span(t)}`))
        .replace(/<details><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
            (_, q, a) => keep(`### ${text(q)}\n\n${span(a)}`))
        .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => keep(`${"#".repeat(+n)} ${text(t)}`))
        .replace(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g, (_, t, d) => keep(`- **${text(t)}** ${span(d)}`))
        .replace(/<li>([\s\S]*?)<\/li>/g, (_, t) => keep(`- ${span(t)}`))
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, t) => keep(span(t)))
        .replace(/<[^>]+>/g, "\n");
    s = s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
        .replace(/\u0000(\d+)\u0000/g, (_, n) => `\n${blocks[n]}\n`);
    // list items stay together; everything else gets a blank line between
    return `${s.replace(/\n{2,}/g, "\n\n").replace(/^(- .*)\n\n(?=- )/gm, "$1\n").trim()}\n`;
}

// ---- page shell -------------------------------------------------------------------

const topbar = ({ lang, root, app, alt }) => {
    const t = L[lang];
    const home = root + t.home;
    return `<header class="topbar">
    <a class="brand" href="${home || "./"}">${LOGO}freedrop</a>
    <nav aria-label="${t.nav}">
        <a class="opt" href="${home}#how">${t.how}</a>
        <a class="opt" href="${home}cli/">CLI</a>
        <a class="opt" href="${home}agents/">${t.agents}</a>
        <a class="opt" href="${home}security/">${t.security}</a>
        ${alt ? `<a class="lang" href="${alt}" hreflang="${L[t.other].hreflang}" lang="${L[t.other].html}">${t.switchTo}</a>` : ""}
        ${app ? `<a class="opt" href="${REPO}">GitHub</a>\n        <button id="install" type="button" hidden></button>`
        : `<a class="btn" href="${home || "./"}">${t.send}</a>`}
    </nav>
</header>`;
};

const footer = ({ lang, root, alt }) => {
    const t = L[lang];
    const home = root + t.home;
    return `<footer class="site-foot"><div class="in">
    <div class="foot-about">
        <a class="brand" href="${home || "./"}">${LOGO}freedrop</a>
        <p>${t.footTag}</p>
        <p>${t.footBy} <a href="https://github.com/tiann">weishu</a></p>
    </div>
    <nav aria-label="${t.footUse}"><p>${t.footUse}</p>
        <a href="${home || "./"}">${t.sendLink}</a>
        <a href="${home}cli/">CLI</a>
        <a href="${home}agents/">${t.agents}</a>
        <a href="${home}security/">${t.security}</a>
    </nav>
    <nav aria-label="${t.footCompare}"><p>${t.footCompare}</p>
        <a href="${home}vs/croc/">freedrop vs croc</a>
        <a href="${home}vs/magic-wormhole/">freedrop vs magic-wormhole</a>
        <a href="${home}vs/wetransfer/">freedrop vs WeTransfer</a>
    </nav>
    <nav aria-label="${t.footMore}"><p>${t.footMore}</p>
        <a href="${REPO}">GitHub</a>
        <a href="${NPM}">npm</a>
        <a href="${root}llms.txt">llms.txt</a>
        <a href="index.md" type="text/markdown">Markdown</a>
        ${alt ? `<a href="${alt}" hreflang="${L[t.other].hreflang}" lang="${L[t.other].html}">${t.switchTo}</a>` : ""}
    </nav>
</div></footer>`;
};

const cmd = (lang, text, copy = text) => `<span class="cmd"><span>${esc(text)}</span><button class="copy" type="button" data-copy="${esc(copy)}" aria-label="${L[lang].copy}">${COPY_ICONS}</button></span>`;

const COPY_SCRIPT = `<script>
    // copy buttons
    addEventListener("click", (e) => {
        const copy = e.target.closest?.("[data-copy]");
        if (!copy) return;
        navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
            copy.classList.add("done");
            setTimeout(() => copy.classList.remove("done"), 1500);
        }, () => {});
    });
</script>`;

// one page: head, then body as given
function shell({ lang, path, title, description, ogTitle, ogDescription, ogAlt, ogType = "website",
    alternates, jsonld, app, noindex, head = "", body, htmlAttrs = "" }) {
    const t = L[lang];
    const root = rootOf(path);
    const url = ORIGIN + path;
    return `<!DOCTYPE html>
<html lang="${t.html}"${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e0f11" media="(prefers-color-scheme: dark)">
${head}<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? `<meta name="robots" content="noindex">\n` : `<link rel="canonical" href="${url}">\n`}${
    Object.entries(alternates ?? {}).map(([hl, u]) => `<link rel="alternate" hreflang="${hl}" href="${u}">\n`).join("")
}${noindex ? "" : `<link rel="alternate" type="text/markdown" href="index.md">\n`}<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="freedrop">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(ogTitle ?? title)}">
<meta property="og:description" content="${esc(ogDescription ?? description)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(ogAlt ?? HOME[lang].ogAlt)}">
<meta property="og:locale" content="${t.og}">
<meta name="twitter:card" content="summary_large_image">
${jsonld ? `<script type="application/ld+json">\n${json(jsonld)}\n</script>\n` : ""}<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${root}icons/apple-touch-icon.png">
${app ? `<link rel="manifest" href="${root}${lang === "zh" ? "manifest.zh.webmanifest" : "manifest.webmanifest"}">
<style>
${read("site/app.css")}</style>
` : ""}<link rel="stylesheet" href="${root}site.css">
</head>
${body}
</html>
`;
}

// ---- the pages ----------------------------------------------------------------------

// a site page given as HTML (the home pages); {{card}}, {{trust}} and
// {{root}} are filled in, the FAQ becomes the FAQPage
function homePage(lang, alternates) {
    const path = L[lang].home;
    const root = rootOf(path);
    const h = HOME[lang];
    const card = read("site/card.html").replace("{{trust}}", h.trust);
    const content = read(`site/home.${lang}.html`).replace(/^<!--[\s\S]*?-->\n/, "").replaceAll("{{root}}", root)
        .replace(/\{\{cmd (.+?)\}\}/g, (_, c) => cmd(lang, unesc(c), unesc(c).replace(/<file>|<文件>/, "")));
    const faq = [...content.matchAll(/<details><summary>(.*?)<\/summary>(.*?)<\/details>/gs)].map((m) => ({
        "@type": "Question",
        name: unesc(m[1].replace(/<[^>]+>/g, "")),
        acceptedAnswer: { "@type": "Answer", text: unesc(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() },
    }));
    const url = ORIGIN + path;
    const graph = lang === "en" ? [
        {
            "@type": "WebSite", "@id": `${ORIGIN}#website`, url: ORIGIN, name: "freedrop",
            inLanguage: ["en", "zh-Hans"], publisher: { "@id": `${ORIGIN}#author` },
        },
        { "@type": "Person", "@id": `${ORIGIN}#author`, name: "weishu", url: "https://github.com/tiann" },
        APP,
    ] : [{
        "@type": "WebPage", "@id": `${url}#webpage`, url, name: h.title, description: h.description,
        inLanguage: L[lang].html, isPartOf: { "@id": `${ORIGIN}#website` }, about: { "@id": `${ORIGIN}#app` },
    }];
    graph.push({ "@type": "FAQPage", "@id": `${url}#faq`, inLanguage: L[lang].html, mainEntity: faq });
    const alt = alternates[L[lang].other] !== undefined && root + L[L[lang].other].home;
    const html = shell({
        lang, path, ...h, alternates: hreflangs(alternates), app: true,
        jsonld: { "@context": "https://schema.org", "@graph": graph },
        htmlAttrs: ` data-lang="${lang}" data-receive="${root}r/"`,
        head: `<script>
    // a link from before the receive page moved: /#<code> → r/#<code>
    if (/^#(k=)?[\\w-]{40,48}$/.test(location.hash)) location.replace("${root}r/" + location.hash);
</script>
`,
        body: `<body class="home">
${topbar({ lang, root, app: true, alt: alt || "" })}
<main class="site">
${content.replace("{{card}}", card)}
</main>
${footer({ lang, root, alt })}
${COPY_SCRIPT}
<script>
    // files dropped anywhere start a send: show it happening
    addEventListener("drop", (e) => {
        if (e.dataTransfer?.files.length) scrollTo({ top: 0, behavior: "smooth" });
    });
</script>
<script type="module" src="${root}app.js"></script>
</body>`,
    });
    return { path, html, md: htmlToMarkdown(content.replace("{{card}}", ""), url) };
}

// where every link opens: the card alone, in the browser's language
function receivePage() {
    const path = "r/";
    const card = read("site/card.html").replace("{{trust}}", HOME.en.trust);
    const html = shell({
        lang: "en", path, noindex: true, app: true,
        title: "freedrop — receive files",
        description: "Someone sent you files with freedrop: they come straight from their device to yours, end-to-end encrypted.",
        htmlAttrs: ` data-receive="./"`,
        head: `<script>
    // no transfer in the link: there's nothing to receive here
    if (!location.hash) location.replace("../");
</script>
`,
        body: `<body>
<style>
    #app {
        min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 1.5rem; padding: 2rem 1rem;
    }
    #app > header { text-align: center; }
    #app .brand { font-size: 1.35rem; }
    #app .brand svg { width: 30px; height: 30px; }
    #tagline { margin: .35rem 0 0; color: var(--muted); font-size: .9rem; }
    #app > footer { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: .9rem; font-size: .8rem; color: var(--faint); }
    #app > footer a { color: inherit; text-decoration: none; }
    #app > footer a:hover { color: var(--muted); text-decoration: underline; }
    @media (max-width: 480px) { #app { justify-content: flex-start; padding-top: 2.5rem; gap: 1.25rem; } }
</style>
<div id="app">
<header>
    <a class="brand" href="../">${LOGO}freedrop</a>
    <p id="tagline"></p>
</header>
<main>
${card}
</main>
<footer><a id="what" href="../">${L.en.what}</a><a href="${REPO}">github.com/tiann/freedrop</a><button id="install" type="button" hidden></button></footer>
</div>
<script>
    if ((navigator.language || "").toLowerCase().startsWith("zh")) {
        document.getElementById("what").textContent = "${L.zh.what}";
        document.getElementById("what").href = "../zh/";
    }
</script>
<script type="module" src="../app.js"></script>
</body>`,
    });
    return { path, html };
}

// a content page from site/pages/<lang>/<rel>.md
function contentPage(lang, rel, alternates) {
    const path = L[lang].home + rel.replace(/\.md$/, "/");
    const root = rootOf(path);
    const url = ORIGIN + path;
    const { meta, body } = frontMatter(read(`site/pages/${lang}/${rel}`));
    for (const k of ["title", "description"]) if (!meta[k]) throw new Error(`${lang}/${rel}: no ${k}`);
    const source = includes(body);
    const rootRel = (u) => (u.startsWith("/") ? (root + u.slice(1)) || "./" : u);
    const { html: article, h1, toc } = markdown(source, rootRel);
    const t = L[lang];
    const home = root + t.home;
    const alt = alternates[t.other] !== undefined && root + L[t.other].home + rel.replace(/\.md$/, "/");
    const html = shell({
        lang, path, title: meta.title, description: meta.description, ogType: "article",
        alternates: hreflangs(alternates),
        jsonld: {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "TechArticle", "@id": `${url}#article`, url, headline: h1,
                    description: meta.description, inLanguage: t.html, image: OG_IMAGE,
                    isPartOf: { "@id": `${ORIGIN}#website` }, about: { "@id": `${ORIGIN}#app` },
                    author: { "@id": `${ORIGIN}#author` },
                },
                {
                    "@type": "BreadcrumbList",
                    itemListElement: [
                        { "@type": "ListItem", position: 1, name: "freedrop", item: ORIGIN + t.home },
                        { "@type": "ListItem", position: 2, name: h1, item: url },
                    ],
                },
            ],
        },
        body: `<body>
${topbar({ lang, root, alt })}
<main class="site">
<div class="doc-wrap in">
    <article class="doc">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="${home || "./"}">freedrop</a><span aria-hidden="true">/</span><span aria-current="page">${esc(h1)}</span></nav>
${article}
        <p class="small md-twin"><a href="index.md" type="text/markdown">${t.md}</a></p>
    </article>
    ${toc.length > 2 ? `<aside class="toc" aria-label="${t.toc}"><p>${t.toc}</p>
        ${toc.map((s) => `<a href="#${s.id}">${esc(s.text)}</a>`).join("\n        ")}
    </aside>` : ""}
</div>
<section class="final"><div class="in">
    <h2>${t.ctaTitle}</h2>
    <p class="lead">${t.ctaLead}</p>
    <div class="ctas">
        <a class="btn" href="${home || "./"}">${t.ctaBtn}</a>
        ${cmd(lang, lang === "zh" ? "npx freedrop <文件>" : "npx freedrop <file>", "npx freedrop ")}
    </div>
</div></section>
</main>
${footer({ lang, root, alt })}
${COPY_SCRIPT}
</body>`,
    });
    // the twin: the same text, every link absolute
    const md = source.replace(/\]\((\/[^)\s]*)\)/g, (_, u) => `](${ORIGIN}${u.slice(1)})`);
    return { path, html, md: `${md.trim()}\n` };
}

const hreflangs = (alternates) => {
    const out = {};
    for (const [lang, path] of Object.entries(alternates)) out[L[lang].hreflang] = ORIGIN + path;
    if (alternates.en !== undefined) out["x-default"] = ORIGIN + alternates.en;
    return out;
};

function notFound() {
    // served for any missing path, at any depth: links are root-relative
    const t = L.en;
    return shell({
        lang: "en", path: "404.html", noindex: true,
        title: "Page not found — freedrop",
        description: "This page doesn't exist. freedrop sends files peer-to-peer between browsers and terminals.",
        head: `<base href="/">\n`,
        body: `<body>
${topbar({ lang: "en", root: "" })}
<main class="site"><section class="final"><div class="in">
    <h1>Nothing here</h1>
    <p class="lead">This page doesn't exist. A transfer link looks like <code>freedrop.dev/r/#…</code> — check it was copied whole.</p>
    <div class="ctas"><a class="btn" href="./">${t.ctaBtn}</a></div>
</div></section></main>
</body>`,
    });
}

// the installed app from /zh/: same app (same id), Chinese way in
const zhManifest = () => {
    const m = JSON.parse(read("manifest.webmanifest"));
    m.lang = "zh-Hans";
    m.description = "点对点传文件，不经过任何服务器";
    m.start_url = "./zh/";
    m.shortcuts = m.shortcuts.map((s) => ({ ...s, name: "扫码接收", short_name: "扫码", url: s.url.replace("./", "./zh/") }));
    m.share_target = { ...m.share_target, action: m.share_target.action.replace("./", "./zh/") };
    return `${JSON.stringify(m, null, 4)}\n`;
};

const sitemap = (pages) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.map((p) => `    <url>
        <loc>${ORIGIN}${p.path}</loc>
${Object.entries(hreflangs(p.alternates)).map(([hl, u]) => `        <xhtml:link rel="alternate" hreflang="${hl}" href="${u}"/>\n`).join("")}    </url>`).join("\n")}
</urlset>
`;

const mdFiles = (dir, prefix = "") => readdirSync(join(SITE, "pages", dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? mdFiles(join(dir, e.name), `${prefix}${e.name}/`) : e.name.endsWith(".md") ? [prefix + e.name] : []));

export function build(out = join(ROOT, "_site")) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const [to, from] of Object.entries(COPY)) cpSync(join(ROOT, from), join(out, to), { recursive: true });

    const write = (path, data) => {
        mkdirSync(dirname(join(out, path)), { recursive: true });
        writeFileSync(join(out, path), data);
    };
    const indexed = [];
    const emit = ({ path, html, md }, alternates) => {
        write(`${path}index.html`, html);
        if (md) write(`${path}index.md`, md);
        if (alternates) indexed.push({ path, alternates });
    };

    const homes = { en: "", zh: "zh/" };
    for (const lang of ["en", "zh"]) emit(homePage(lang, homes), homes);
    const pages = new Set(["en", "zh"].flatMap((lang) => mdFiles(lang)));
    for (const rel of [...pages].sort()) {
        const alternates = {};
        for (const lang of ["en", "zh"]) {
            try { readFileSync(join(SITE, "pages", lang, rel)); } catch { continue; }
            alternates[lang] = L[lang].home + rel.replace(/\.md$/, "/");
        }
        for (const lang of Object.keys(alternates)) emit(contentPage(lang, rel, alternates), alternates);
    }
    emit(receivePage());
    write("404.html", notFound());
    write("manifest.zh.webmanifest", zhManifest());
    write("sitemap.xml", sitemap(indexed));
    return { out, pages: indexed.map((p) => p.path) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { out, pages } = build(process.argv[2]);
    console.log(`built ${pages.length} pages into ${out}`);
}
