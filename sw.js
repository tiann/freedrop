// The service worker that makes the page an installable app.
//
// The app shell (page, modules, manifest, icons) goes network-first and
// lands in the cache on the way, so a deploy is live on the next start
// and an offline start still opens the page. Nothing else passes through
// here: signaling is WebSocket, received files are blob: URLs.
//
// Android's share sheet hands files to the installed app as a POST
// navigation to ./?share-target, or ./zh/?share-target when it was
// installed from the Chinese page (manifest share_target). The worker
// answers with a redirect to that page and holds the files until the page
// asks for them ("share-ready").

const CACHE = "freedrop";
// the app's pages and every file they load — an offline start breaks on
// the one left out
const SHELL = [
    "./", "zh/", "r/", "app.js", "signal.mjs", "qr.mjs", "site.css",
    "manifest.webmanifest", "manifest.zh.webmanifest",
    "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png",
    "icons/apple-touch-icon.png", "icons/scan-96.png",
];
const shell = new Set(SHELL.map((p) => new URL(p, location).href));

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (!shell.has(req.url)) await cache.delete(req);
    await self.clients.claim();
})()));

let shared = null; // { files: Promise<File[]>, done } until the page takes them

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method === "POST" && url.searchParams.has("share-target")) {
        e.respondWith(Response.redirect(`${url.pathname}?share-target`, 303));
        // stay alive until the page has the files, or give up after a minute
        e.waitUntil(new Promise((done) => {
            shared = { files: req.formData().then((d) => d.getAll("files"), () => []), done };
            setTimeout(done, 60_000);
        }));
        return;
    }
    if (req.method !== "GET") return;
    // ./zh/, ./zh/index.html, ./zh/?scan … are all the one page
    const key = url.origin + url.pathname.replace(/\/index\.html$/, "/");
    if (!shell.has(key)) return;
    e.respondWith((async () => {
        try {
            const res = await fetch(req);
            if (res.ok) {
                const copy = res.clone();
                e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
            }
            return res;
        } catch (error) {
            const hit = await caches.match(key);
            if (hit) return hit;
            throw error;
        }
    })());
});

self.addEventListener("message", (e) => {
    if (e.data !== "share-ready") return;
    const s = shared;
    shared = null;
    e.waitUntil((s?.files ?? Promise.resolve([]))
        .then((files) => e.source.postMessage({ t: "share", files }))
        .finally(() => s?.done()));
});
