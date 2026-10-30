// The site as site/build.mjs builds it for freedrop.dev: what search
// engines and AI crawlers read without running any JavaScript, and the
// pages the app runs in. File checks only — no browser, no network — so a
// wrong canonical, a dead link or a FAQPage that drifted from the visible
// FAQ fails here, not quietly in a search index.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { build, ORIGIN, markdown, htmlToMarkdown } from "../site/build.mjs";

const OUT = join(ROOT, "test", ".tmp", "site");
build(OUT);
const read = (path) => readFileSync(join(OUT, path), "utf8");
// a URL on the site → the file it is answered with
const fileOf = (url) => {
    const path = decodeURIComponent(new URL(url, ORIGIN).pathname.slice(1));
    return path === "" || path.endsWith("/") ? `${path}index.html` : path;
};
const plain = (html) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const meta = (html, key) => html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1];
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .flatMap((m) => JSON.parse(m[1])["@graph"]);
const alternates = (html) => Object.fromEntries([...html.matchAll(
    /<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));

const PAGES = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const html = Object.fromEntries(PAGES.map((url) => [url, read(fileOf(url))]));
const HOMES = [ORIGIN, `${ORIGIN}zh/`];
const APP_PAGES = ["index.html", "zh/index.html", "r/index.html"];

test("site: robots.txt points at the sitemap, the sitemap at every page", () => {
    assert.match(read("robots.txt"), new RegExp(`^Sitemap: ${ORIGIN}sitemap\\.xml$`, "m"));
    for (const home of HOMES) assert.ok(PAGES.includes(home), home);
    for (const page of ["cli/", "agents/", "security/", "vs/croc/", "vs/magic-wormhole/", "vs/wetransfer/"]) {
        assert.ok(PAGES.includes(ORIGIN + page) && PAGES.includes(`${ORIGIN}zh/${page}`), page);
    }
    assert.ok(!PAGES.some((u) => u.includes("/r/")), "the receive page stays out");
    assert.ok(existsSync(join(OUT, "llms.txt")));
});

test("site: every page describes itself", () => {
    for (const url of PAGES) {
        const page = html[url];
        assert.match(page, /<html lang="[a-zA-Z-]+"/, url);
        const title = page.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
        assert.ok(title.length > 10 && title.length <= 70, `${url}: title "${title}"`);
        const description = meta(page, "description") ?? "";
        assert.ok(description.length >= 50 && description.length <= 170, `${url}: description "${description}"`);
        assert.equal(page.match(/<link rel="canonical" href="([^"]+)">/)?.[1], url);
        assert.equal(page.match(/<h1[ >]/g)?.length, 1, `${url}: one <h1>`);
        assert.equal(meta(page, "og:url"), url);
        assert.ok(existsSync(join(OUT, fileOf(meta(page, "og:image")))), `${url}: og:image`);
        assert.ok(jsonLd(page).length > 0, `${url}: structured data`);
        assert.match(page, /<link rel="alternate" type="text\/markdown" href="index\.md">/, `${url}: Markdown twin`);
        const twin = read(fileOf(url).replace(/html$/, "md"));
        assert.equal(twin.match(/^# .+/m)?.[0], `# ${plain(page.match(/<h1>(.*?)<\/h1>/s)[1])}`, `${url}: twin's h1`);
    }
});

test("site: language alternates point at each other", () => {
    for (const url of PAGES) {
        const alt = alternates(html[url]);
        assert.ok(Object.values(alt).includes(url), `${url} lists itself`);
        assert.ok(alt["x-default"], `${url}: x-default`);
        for (const other of Object.values(alt)) {
            assert.ok(PAGES.includes(other), `${url} → ${other} is in the sitemap`);
            assert.deepEqual(alternates(html[other]), alt, `${other} lists the same alternates as ${url}`);
        }
    }
});

test("site: links resolve, anchors included", () => {
    const ids = (page) => new Set([...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const check = (from, ref, base) => {
        if (/^(data:|mailto:)/.test(ref) || (/^https?:/.test(ref) && !ref.startsWith(ORIGIN))) return;
        const to = new URL(ref, base);
        const file = fileOf(to.href);
        assert.ok(existsSync(join(OUT, file)), `${from}: ${ref}`);
        const frag = decodeURIComponent(to.hash.slice(1));
        if (frag && file.endsWith(".html")) assert.ok(ids(read(file)).has(frag), `${from}: ${ref} — no #${frag}`);
    };
    for (const file of [...PAGES.map(fileOf), "r/index.html"]) {
        for (const [, ref] of read(file).matchAll(/(?:href|src)="([^"]+)"/g)) check(file, ref, ORIGIN + file);
        const twin = file.replace(/html$/, "md");
        if (!existsSync(join(OUT, twin))) continue;
        for (const [, ref] of read(twin).matchAll(/\]\((https?:[^)\s]+)\)/g)) check(twin, ref, ORIGIN);
    }
    // the 404 page is served at any depth: its links are root-relative
    for (const [, ref] of read("404.html").matchAll(/(?:href|src)="([^"]+)"/g)) check("404.html", ref, ORIGIN);
});

test("site: each home page's FAQPage says what it shows", () => {
    for (const url of HOMES) {
        const faq = jsonLd(html[url]).find((n) => n["@type"] === "FAQPage");
        const shown = [...html[url].matchAll(/<details><summary>(.*?)<\/summary>(.*?)<\/details>/gs)]
            .map((m) => [plain(m[1]), plain(m[2])]);
        assert.ok(shown.length >= 5, `${url}: a FAQ`);
        assert.deepEqual(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]), shown, url);
    }
});

test("site: the English and Chinese pages match", () => {
    const sections = (page) => [...page.matchAll(/<section[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sections(html[`${ORIGIN}zh/`]), sections(html[ORIGIN]));
    for (const url of PAGES) {
        const other = url.startsWith(`${ORIGIN}zh/`) ? url.replace(`${ORIGIN}zh/`, ORIGIN) : url.replace(ORIGIN, `${ORIGIN}zh/`);
        assert.ok(PAGES.includes(other), `${url} has a counterpart`);
    }
});

test("site: the app's pages carry the app; links open on the receive page", () => {
    for (const file of APP_PAGES) {
        const page = read(file);
        for (const id of ["card", "drop", "picker", "link", "status", "trust-text", "install"]) {
            assert.equal(page.match(new RegExp(` id="${id}"`, "g"))?.length, 1, `${file}: #${id}`);
        }
        assert.match(page, /<script type="module" src="(\.\.\/)?app\.js"><\/script>/, file);
        assert.match(page, /<link rel="manifest" href="[^"]*manifest(\.zh)?\.webmanifest">/, file);
    }
    assert.match(read("index.html"), /<html lang="en" data-lang="en" data-receive="r\/">/);
    assert.match(read("zh/index.html"), /<html lang="zh-Hans" data-lang="zh" data-receive="\.\.\/r\/">/);
    // the receive page: the browser's language, not indexed
    const r = read("r/index.html");
    assert.match(r, /<html lang="en" data-receive="\.\/">/);
    assert.match(r, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(r, /rel="canonical"/);
    // the installed app from /zh/ is the same app, opened on /zh/
    const en = JSON.parse(read("manifest.webmanifest"));
    const zh = JSON.parse(read("manifest.zh.webmanifest"));
    assert.equal(zh.id, en.id);
    assert.equal(zh.start_url, "./zh/");
    assert.equal(zh.share_target.action, "./zh/?share-target");
    assert.deepEqual(zh.shortcuts.map((s) => s.url), ["./zh/?scan"]);
});

test("site: the service worker's shell is all there", () => {
    const shell = JSON.parse(read("sw.js").match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
    for (const path of shell) assert.ok(existsSync(join(OUT, fileOf(new URL(path, ORIGIN).href))), path);
    for (const file of APP_PAGES) assert.ok(shell.includes(file.replace("index.html", "") || "./"), file);
});

test("site: the Markdown the pages are written in", () => {
    const { html: out, h1, toc } = markdown([
        "# Title `x`", "", "The lead.", "", "## A *b* section", "", "Text with `<code>` and [a link](/cli/).",
        "continued.", "", "- one", "  more", "- two", "", "1. first", "2. second", "",
        "```bash", "# a comment", "$ npx freedrop file", "output", "```", "",
        "| Name | Value |", "|---|---|", "| `a` | b |", "", "> Note.", "", "## A *b* section",
    ].join("\n"), (u) => `rel:${u}`);
    assert.equal(h1, "Title x");
    assert.equal(toc.map((s) => s.id).join(), "a-b-section,a-b-section-2");
    for (const part of [
        "<h1>Title <code>x</code></h1>", '<p class="lead">The lead.</p>',
        '<h2 id="a-b-section">A <em>b</em> section</h2>',
        '<p>Text with <code>&lt;code&gt;</code> and <a href="rel:/cli/">a link</a>. continued.</p>',
        "<li>one more</li>", "<ol>\n<li>first</li>",
        '<span class="d"># a comment</span>\n<span class="p">$ </span>npx freedrop file\noutput',
        '<th scope="row"><code>a</code></th><td data-label="Value">b</td>',
        '<aside class="callout"><p>Note.</p></aside>',
    ]) assert.ok(out.includes(part), part);
    assert.equal(htmlToMarkdown(
        '<h2>Hi</h2><p>Run <code>npx freedrop &lt;code&gt;</code>, see <a href="cli/">CLI</a>.</p><ul><li>a</li><li>b</li></ul>',
        ORIGIN,
    ), "## Hi\n\nRun `npx freedrop <code>`, see [CLI](https://freedrop.dev/cli/).\n\n- a\n- b\n");
});
