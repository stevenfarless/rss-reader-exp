const CACHE = "rss-reader-shell-v85";
const RUNTIME_CACHE = "rss-reader-runtime-v8";
const RUNTIME_MAX = 50;
const FILES = ["./", "./index.html", "./styles.css", "./markdown.js", "./purify.min.js", "./utils.js", "./app.js", "./pwa-install.js", "./manifest.webmanifest", "./assets/icon.svg", "./assets/icon-192.png", "./assets/icon-512.png", "./assets/icon-maskable-512.png", "./assets/apple-touch-icon.png", "./fonts/GentiumBookPlus-Regular.woff2", "./fonts/GentiumBookPlus-Bold.woff2", "./fonts/GentiumBookPlus-Italic.woff2", "./fonts/GentiumBookPlus-BoldItalic.woff2", "./fonts/InterVariable.woff2", "./fonts/InterVariable-Italic.woff2", "./fonts/NunitoVariable.woff2", "./fonts/NunitoVariable-Italic.woff2", "./fonts/Ubuntu-Regular.woff2", "./fonts/Ubuntu-Bold.woff2", "./fonts/Ubuntu-Italic.woff2", "./fonts/Ubuntu-BoldItalic.woff2"];
/* Install is per-file, not all-or-nothing: one missing file (a font,
   an icon) must not reject the whole install and leave the worker
   unregistered, with no offline and no background sync. A failed file
   is skipped; the shell is network-first, so it is fetched on demand.
   The worker does NOT skip waiting here: a new build waits until the
   user chooses Reload (#144), so an update never interrupts reading. */
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.all(FILES.map(async f => {
      try { await c.add(f); } catch {}
    }));
  }));
});
/* The page asks a waiting worker to take over only when the user
   chooses Reload in the update banner (#144). */
self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
async function trimRuntime(cache) {
  const keys = await cache.keys();
  if (keys.length > RUNTIME_MAX) {
    await Promise.all(keys.slice(0, keys.length - RUNTIME_MAX).map(k => cache.delete(k)));
  }
}
/* Navigations are network-first so returning users can discover new
   deployments. Versioned application assets are cache-first for fast
   repeat visits; bump CACHE when the shell changes. Other static assets
   use the runtime cache and are capped to limit storage growth. */
const SHELL_RE = /(^|\/)(index\.html|styles\.css|markdown\.js|purify\.min\.js|utils\.js|readability\.js|app\.js|pwa-install\.js)$|\/$/;
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // feed fetches are cross-origin: never intercepted
  e.respondWith((async () => {
    if (e.request.mode === "navigate") {
      try {
        const r = await fetch(e.request);
        if (r.ok) {
          const cache = await caches.open(CACHE);
          cache.put(e.request, r.clone()).catch(() => {});
        }
        return r;
      } catch {
        const cached = await caches.match(e.request, { cacheName: CACHE });
        if (cached) return cached;
        return caches.match("./index.html");
      }
    }
    if (SHELL_RE.test(u.pathname)) {
      const cached = await caches.match(e.request, { cacheName: CACHE });
      if (cached) return cached;
      const r = await fetch(e.request);
      if (r.ok) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, r.clone()).catch(() => {});
      }
      return r;
    }
    const cached = await caches.match(e.request, { cacheName: CACHE });
    if (cached) return cached;
    try {
      const r = await fetch(e.request);
      if (r.ok && /\.(css|js|woff2|svg|png)$/.test(u.pathname)) {
        const copy = r.clone();
        const runtime = await caches.open(RUNTIME_CACHE);
        await runtime.put(e.request, copy);
        await trimRuntime(runtime);
      }
      return r;
    } catch {
      throw e;
    }
  })());
});

/* ---------- background refresh (Periodic Background Sync) ---------- */
/* The page mirrors the feed list and the sync-relevant settings into
   IndexedDB (the "sync" store) because a worker cannot read
   localStorage. The worker refreshes each feed, stores new articles
   (text only, no images), and notifies when new articles arrive.
   This only runs where the browser allows Periodic Background Sync
   (Chrome on Android, installed PWA, granted on engagement). */
const SYNC_TAG = "refresh-feeds";
const SW_FETCH_TIMEOUT = 15000;
const SW_MAX_ITEMS_PER_FEED = 200;
function swFetch(url, opts) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), SW_FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
function swOpenDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("rss-reader-cache", 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
      if (!d.objectStoreNames.contains("sync")) d.createObjectStore("sync", { keyPath: "key" });
      // The page owns highlights; the worker only creates the store so
      // the schema stays in step with the page (version 3).
      if (!d.objectStoreNames.contains("highlights")) d.createObjectStore("highlights", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function swGet(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function swGetAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
function swPutAll(db, store, records) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    for (const r of records) s.put(r);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
function swDeleteAll(db, store, ids) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    for (const id of ids) s.delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
/* Minimal XML helpers: a service worker has no DOMParser, so the
   feed parser below works on the raw text. Handles the well-formed
   RSS 2.0 and Atom feeds this app subscribes to. */
function swDecode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}
function swPlain(s) { return swDecode((s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }
function swTagText(block, name) {
  const re = new RegExp("<(?:[A-Za-z0-9_\\-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_\\-]+:)?" + name + ">", "i");
  const m = block.match(re);
  if (!m) return "";
  let t = m[1].trim();
  if (t.startsWith("<![CDATA[") && t.endsWith("]]>")) t = t.slice(9, -3);
  return t;
}
function swAtomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map(m => m[1]);
  for (const attrs of links) {
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!rel || rel[1] === "alternate") {
      const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs);
      if (href) return href[1];
    }
  }
  return "";
}
function swAuthor(b) {
  const c = swTagText(b, "creator");
  if (c) return swPlain(c);
  const am = b.match(/<author[\s>][\s\S]*?<\/author>/i);
  if (am) {
    const n = swTagText(am[0], "name");
    if (n) return swPlain(n);
  }
  return "";
}
function swDate(s) { const d = new Date(s || ""); return isNaN(d) ? null : d.toISOString(); }
function swParseXml(text, url) {
  const isAtom = /<feed[\s>]/.test(text);
  const blocks = isAtom
    ? [...text.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map(m => m[0])
    : [...text.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => m[0]);
  return blocks.map(b => {
    const link = isAtom ? swAtomLink(b) : swTagText(b, "link");
    const guid = swTagText(b, "guid") || swTagText(b, "id") || "";
    const content = swTagText(b, "encoded") || swTagText(b, "content") || swTagText(b, "description") || swTagText(b, "summary") || "";
    return {
      title: swPlain(swTagText(b, "title")) || "(untitled)",
      url: link || guid || url,
      guid,
      summary: swPlain(swTagText(b, "summary") || swTagText(b, "description") || content),
      content,
      author: swAuthor(b),
      date: swTagText(b, "pubDate") || swTagText(b, "published") || swTagText(b, "updated") || swTagText(b, "date") || "",
      image: ""
    };
  });
}
function swWpPost(p, origin) {
  return {
    title: swPlain(p.title?.rendered) || "(untitled)",
    url: p.link || origin,
    guid: (typeof p.guid === "string" ? p.guid : p.guid?.rendered) || p.link || "",
    summary: swPlain(p.excerpt?.rendered) || "",
    content: p.content?.rendered || "",
    author: p._embedded?.author?.[0]?.name || "",
    date: p.date || p.modified || "",
    image: ""
  };
}
function swParseFeed(text, url) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j.map(p => swWpPost(p, url));
    if (j.items) {
      return j.items.map(x => ({
        title: x.title || "(untitled)",
        url: x.url || x.external_url || url,
        guid: x.id || x.url || x.external_url || "",
        summary: x.summary || x.content_text || "",
        content: x.content_html || x.content_text || "",
        author: typeof x.author === "string" ? x.author : (x.author?.name || ""),
        date: x.date_published || x.date_modified || "",
        image: ""
      }));
    }
  } catch {}
  return swParseXml(text, url);
}
async function swLoadWordPress(origin) {
  const base = origin.replace(/\/$/, "") + "/wp-json/wp/v2/posts";
  const r = await swFetch(base + "?per_page=30&_embed&orderby=date&order=desc", { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw Error("HTTP " + r.status);
  const posts = await r.json();
  if (!Array.isArray(posts)) throw Error("Unexpected WordPress API response.");
  return posts.map(p => swWpPost(p, origin));
}
async function swLoadProxy(feedUrl) {
  const r = await swFetch("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feedUrl), { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw Error("HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "ok" || !Array.isArray(j.items)) throw Error("The proxy could not read this feed.");
  return j.items.map(x => ({
    title: x.title || "(untitled)",
    url: x.link || feedUrl,
    guid: x.guid || x.link || "",
    summary: swPlain(x.description) || "",
    content: x.content || x.description || "",
    author: x.author || "",
    date: x.pubDate || "",
    image: ""
  }));
}
/* Fetch one feed the way the page does: direct first, then the
   WordPress API, then the public proxy (only when the user opted in).
   The mirrored feed already carries the resolved feed URL, so no
   discovery or conventional-path probing is needed here. */
async function swLoadFeed(feed, settings) {
  if (feed.via === "wp" && feed.wpRoot) {
    try { return await swLoadWordPress(feed.wpRoot); } catch {}
  }
  if (feed.via === "proxy") {
    try { return await swLoadProxy(feed.url); } catch {}
  }
  try {
    const r = await swFetch(feed.url, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*" }, cache: "no-store" });
    if (!r.ok) throw Error("HTTP " + r.status);
    return swParseFeed(await r.text(), feed.url);
  } catch (e) {
    if (feed.wpRoot) {
      try { return await swLoadWordPress(feed.wpRoot); } catch {}
    }
    try {
      return await swLoadWordPress(new URL(feed.url).origin);
    } catch {}
    try {
      return await swLoadProxy(feed.url);
    } catch {}
    throw e;
  }
}
/* Store the fetched items, preserving read/saved/tags/fullContent from
   the stored copy, and return how many are new. Text only: a new
   article stores no image. Caps each feed at 200 newest, never
   deleting a saved article. */
async function swSaveItems(db, feed, rawItems) {
  const all = await swGetAll(db, "items");
  const mine = all.filter(i => i.feedId === feed.id);
  const byId = new Map(mine.map(i => [i.id, i]));
  const byUrl = new Map();
  for (const i of mine) if (!byUrl.has(feed.id + "|" + i.url)) byUrl.set(feed.id + "|" + i.url, i);
  const fresh = [];
  let added = 0;
  for (const x of rawItems) {
    const link = x.url || feed.url;
    const key = feed.id + "|" + (x.guid || link);
    const old = byId.get(key) || byUrl.get(feed.id + "|" + link);
    if (!old) added++;
    fresh.push({
      id: key, feedId: feed.id, feedTitle: feed.title,
      title: x.title, url: link, guid: x.guid || "",
      summary: x.summary || "", content: x.content || "",
      fullContent: old?.fullContent || "",
      author: x.author || "",
      published: swDate(x.date),
      image: old?.image || "",
      enclosure: old?.enclosure || null,
      read: old?.read || false, saved: old?.saved || false,
      tags: old?.tags || []
    });
  }
  if (fresh.length) await swPutAll(db, "items", fresh);
  // Cap the feed in memory instead of re-reading the whole table: the
  // fresh items replace their old versions, the rest carry over.
  const freshIds = new Set(fresh.map(x => x.id));
  const mineAfter = [...fresh, ...mine.filter(m => !freshIds.has(m.id))]
    .sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0));
  const extra = mineAfter.slice(SW_MAX_ITEMS_PER_FEED).filter(x => !x.saved).map(x => x.id);
  if (extra.length) await swDeleteAll(db, "items", extra);
  return added;
}
async function swRefreshFeeds() {
  const db = await swOpenDB();
  try {
    const feedsRec = await swGet(db, "sync", "feeds");
    const settingsRec = await swGet(db, "sync", "settings");
    const feeds = feedsRec?.value || [];
    const settings = settingsRec?.value || {};
    if (!feeds.length) return;
    let newCount = 0;
    const newByFeed = [];
    // Refresh up to 3 feeds at a time instead of one after another:
    // a slow publisher no longer holds up every feed behind it.
    const pool = async (items, n, fn) => {
      const queue = [...items];
      const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          await fn(item);
        }
      });
      await Promise.all(workers);
    };
    await pool(feeds, 3, async feed => {
      try {
        const items = await swLoadFeed(feed, settings);
        const added = await swSaveItems(db, feed, items);
        if (added > 0) { newCount += added; newByFeed.push({ title: feed.title, count: added }); }
      } catch (e) {
        // One feed failing must not stop the others.
      }
    });
    if (newCount > 0 && settings.notifyNew) {
      await self.registration.showNotification("RSS Reader", {
        body: newByFeed.length === 1
          ? `${newByFeed[0].count} new article${newByFeed[0].count === 1 ? "" : "s"} in ${newByFeed[0].title}`
          : `${newCount} new articles in ${newByFeed.length} feeds`,
        tag: "rss-reader-new",
        renotify: true
      });
    }
  } finally {
    db.close();
  }
}
self.addEventListener("periodicsync", e => {
  if (e.tag === SYNC_TAG) e.waitUntil(swRefreshFeeds());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) return open.focus();
    return self.clients.openWindow("./");
  }));
});
