(() => {
"use strict";

/* RSS Reader — client-only, PWA.
   Feed loading, in order, all from this page (no install, no backend of ours):
   1. Direct fetch of the feed (works when the publisher sends CORS headers).
   2. WordPress REST API (/wp-json/wp/v2/posts) for WordPress sites — WordPress
      sends permissive CORS headers on its API even when its /feed does not.
   3. A public feed-to-JSON service (rss2json), as a last resort: the feed
      passes through a third party.
   Full-article text is fetched the same way: directly, or via the
   WordPress API looked up by the article slug (which returns full
   content), or via the reader/proxy services. */

const $ = s => document.querySelector(s);
const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function (...args) {
  if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "-1");
  nativeShowModal.apply(this, args);
  this.focus({ preventScroll: true });
};
const $$ = s => [...document.querySelectorAll(s)];
const K = "rss-reader.feeds.v1", S = "rss-reader.settings.v1", DB = "rss-reader-cache";
const KF = "rss-reader.folders.v1", KT = "rss-reader.tags.v1", LR = "rss-reader.lastRefresh.v1";
const KS = "rss-reader.savedSearches.v1", KR = "rss-reader.rules.v1";
const SESSION_KEY = "rss-reader.session.v1";
const PROXY_API = "https://api.rss2json.com/v1/api.json?rss_url=";
const ALLORIGINS = "https://api.allorigins.win/raw?url=";
const JINA = "https://r.jina.ai/";
/* 30 s, not 15: a feed fetch can be a redirect chain (one slow hop
   each), and a single 15 s budget for the whole chain times out
   feeds that are alive but slow — e.g. NASA's Image of the Day
   feed, whose 301 to a second slow fetch exceeded 15 s in the
   cloud browser and fell through to the site's main feed (#163).
   Matches the proxy timeout below. */
const FETCH_TIMEOUT_MS = 30000;
const PROXY_TIMEOUT_MS = 30000;
const MAX_ITEMS_PER_FEED = 200;
/* The version shown in Settings and in the update check (#144). Bump
   it with every release, alongside package.json and the SW cache. */
const APP_VERSION = "1.10.2";

const state = {
  feeds: [], items: [], highlights: [], view: "all", feed: null, folder: null, filter: "all",
  sort: "newest", query: "", selected: null, tag: null, savedSearch: null,
  folders: [], tags: [], savedSearches: [], rules: [],
  settings: { theme: "dark", width: "comfortable", size: "normal", readerFont: "serif", lineHeight: "comfortable", ttsRate: 1, hideDuplicates: true, sidebarCollapsed: false, sidebarWidth: 250, listWidth: 400, sort: "newest", filter: "all", progressPosition: "bottom", cardExcerpt: "full", cardImage: true, backgroundSync: false, notifyNew: false, mobileReaderBar: "bottom", shortcutPreset: "inoreader", shortcutCoaching: matchMedia("(min-width:821px)").matches, shortcutCoachingExplicit: false, shortcutBar: true, retentionDays: 0, retentionCount: 0, globalRefreshMinutes: 30 }
};
let db, timer, pendingSeq = null, pendingSeqTimer = null, refreshAt = 0, orgEdit = null, pendingDelete = null, searchTimer = null, ruleEdit = null, automaticRefreshTimer = null, sessionSaveTimer = null;
/* Text-to-speech state (#105): the article being read, its sentence
   chunks, and where playback has reached. Null when nothing is playing. */
let tts = null;
/* Tag box expanded state (#171): the article id whose tag input is
   open, or null. Per article, so re-renders keep it and opening
   another article collapses it again. */
let tagsExpandedId = null;

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const id = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decodeHtml = s => {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
};
const plainText = s => decodeHtml(stripTags(s));
/* Inline SVG icons from the <symbol> sprite in index.html. */
const icon = (name, cls) => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
/* Reader toolbar (#197): icon-only buttons, in an order the user can
   rearrange in Settings (stored in settings.toolbarOrder). */
const TOOLBAR_KEYS = ["back", "save", "tags", "read", "fulltext", "listen", "note", "share", "snooze", "open", "close"];
const TOOLBAR_DEFAULT = [...TOOLBAR_KEYS];
const TOOLBAR_LABELS = { back: "Back", save: "Save", tags: "Add tags", read: "Mark read", fulltext: "Full article", listen: "Listen", note: "Add note", share: "Share", snooze: "Snooze", open: "Open original", close: "Close" };
function toolbarOrder() {
  return normalizeToolbarOrder(state.settings.toolbarOrder, TOOLBAR_KEYS, TOOLBAR_DEFAULT);
}
function toolbarButtonHTML(key, x, ctx) {
  const { fullLabel, canListen, canFull, hasNote } = ctx;
  const fullTextLoading = loadingFullTextIds.has(x.id);
  const fullTextActive = fullTextState(x).showingFull;
  switch (key) {
    case "back": return `<button data-reader="back" class="reader-btn reader-back" title="Back to list" aria-label="Back to list">‹</button>`;
    case "save": return `<button data-reader="save" class="reader-btn" title="Save (s)" aria-label="${x.saved ? "Unsave article" : "Save article"}" aria-pressed="${x.saved}">${icon(x.saved ? "star-filled" : "star")}</button>`;
    case "tags": return `<button data-reader="tags" class="reader-btn" title="Add tags (T)" aria-label="Add tags" aria-expanded="${tagsExpandedId === x.id}">${icon("tag")}</button>`;
    case "read": return `<button data-reader="read" class="reader-btn" title="${x.read ? "Mark unread (m)" : "Mark read (m)"}" aria-label="${x.read ? "Mark unread" : "Mark read"}">${x.read ? "○" : "●"}</button>`;
    case "fulltext": return `<button data-reader="fulltext" class="reader-btn${fullTextActive ? " fulltext-active" : ""}${fullTextLoading ? " fulltext-loading" : ""}" title="${fullTextLoading ? "Loading full article…" : fullLabel + (canFull ? " (w)" : "")}" aria-label="${fullLabel}" aria-busy="${fullTextLoading}" ${canFull && !fullTextLoading ? "" : "disabled"}>${fullTextLoading ? '<span class="reader-spinner" aria-hidden="true"></span>' : icon("book-open")}</button>`;
    case "listen": return `<button data-reader="listen" class="reader-btn" title="${tts?.itemId === x.id ? "Stop listening" : canListen ? "Listen to article" : "Text-to-speech is not available in this browser"}" aria-label="Listen to article" aria-pressed="${tts?.itemId === x.id}" ${canListen ? "" : "disabled"}>${icon("speak")}</button>`;
    case "note": return `<button data-reader="note" class="reader-btn${hasNote ? " on" : ""}" title="Add note" aria-label="Add note" aria-pressed="${hasNote}">${icon("note")}</button>`;
    case "share": return `<button data-reader="share" class="reader-btn" title="Share article" aria-label="Share article">${icon("share")}</button>`;
    case "snooze": return `<button data-reader="snooze" class="reader-btn" title="Snooze article" aria-label="Snooze article" aria-haspopup="true" aria-expanded="false">${icon("clock")}</button>`;
    case "open": return `<button data-reader="open" class="reader-btn" title="Open original (v)" aria-label="Open original">↗</button>`;
    case "close": return `<button data-reader="close" class="reader-btn" title="Close (u / Esc)" aria-label="Close article">${icon("close")}</button>`;
    default: return "";
  }
}
let readerToolbarObserver = null;
function setupReaderToolbarOverflow() {
  readerToolbarObserver?.disconnect();
  const top = $("#reader .reader-top");
  const actions = top?.querySelector(".reader-actions");
  if (!actions) return;
  const buttons = [...actions.querySelectorAll(":scope > .reader-btn")];
  const wrap = document.createElement("div");
  wrap.className = "reader-overflow";
  wrap.innerHTML = '<button type="button" class="reader-btn" data-reader-more aria-label="More article actions" title="More article actions" aria-haspopup="true" aria-expanded="false">···</button><div class="menu" role="menu" aria-label="More article actions" hidden></div>';
  actions.append(wrap);
  const moreButton = wrap.querySelector("[data-reader-more]");
  const menu = wrap.querySelector(".menu");
  const update = () => {
    buttons.forEach(button => { button.hidden = false; });
    menu.replaceChildren();
    wrap.hidden = true;
    if (actions.scrollWidth <= actions.clientWidth) return;
    wrap.hidden = false;
    const overflowed = [];
    for (let i = buttons.length - 1; i >= 0 && actions.scrollWidth > actions.clientWidth; i--) {
      buttons[i].hidden = true;
      overflowed.unshift(buttons[i].cloneNode(true));
    }
    menu.replaceChildren(...overflowed);
    wrap.hidden = overflowed.length === 0;
    menu.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
  };
  update();
  if ("ResizeObserver" in window) {
    readerToolbarObserver = new ResizeObserver(update);
    readerToolbarObserver.observe(top);
    readerToolbarObserver.observe(actions);
  } else window.addEventListener("resize", update);
}
/* Article notes (#197): a freeform note attached to one article, kept
   in localStorage (not the feed item, which refreshes overwrite). */
const NK = "rss-reader.notes.v1";
let articleNotes = {};
try { articleNotes = JSON.parse(localStorage.getItem(NK) || "{}"); if (!articleNotes || typeof articleNotes !== "object") articleNotes = {}; } catch { articleNotes = {}; }
function getArticleNote(id) { return articleNotes[id] || ""; }
function setArticleNote(id, text) {
  if (text && text.trim()) articleNotes[id] = text.trim(); else delete articleNotes[id];
  try { localStorage.setItem(NK, JSON.stringify(articleNotes)); } catch {}
}
function articleNoteHTML(x) {
  const note = getArticleNote(x.id);
  if (!note) return "";
  return `<div class="article-note"><strong>Note</strong><p>${esc(note)}</p><div class="hl-actions"><button type="button" class="quiet" data-note-edit="${esc(x.id)}">Edit note</button><button type="button" class="quiet" data-note-delete="${esc(x.id)}">Delete</button></div></div>`;
}
let noteArticleId = null;
function showArticleNoteDialog(x) {
  noteArticleId = x.id;
  const ta = $("#articleNoteText");
  if (ta) ta.value = getArticleNote(x.id);
  $("#articleNoteDialog").showModal();
  if (ta) ta.focus();
}
function saveArticleNoteFromDialog() {
  if (!noteArticleId) return;
  setArticleNote(noteArticleId, $("#articleNoteText")?.value || "");
  $("#articleNoteDialog").close();
  const x = selectedItem();
  if (x && x.id === noteArticleId) renderReader(x);
  noteArticleId = null;
  toast("Note saved.");
}

/* Per-feed options menu (#183): a small popup on each feed row, like
   FriRSS. One shared fixed-position menu; the feed it belongs to is
   tracked in feedMenuFeedId. */
let feedMenuFeedId = null;
function feedMenuHTML(f) {
  const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id;
  const orderLabel = !f.sort || f.sort === "global" ? "Use global" : f.sort === "newest" ? "Newest" : "Oldest";
  const refreshInterval = Number(f.refreshMinutes) || 0;
  return `<button type="button" data-feed-opt="rename">Rename</button>` +
    `<button type="button" data-feed-opt="open">Open site</button>` +
    `<button type="button" data-feed-opt="autofull" aria-pressed="${!!f.autoFull}">${f.autoFull ? "✓ " : ""}Full article: ${f.autoFull ? "Always fetch" : "Use RSS text"}</button>` +
    `<button type="button" data-feed-opt="layout">Layout for this feed</button>` +
    `<button type="button" data-feed-opt="order">Order for this feed: ${orderLabel}</button>` +
    `<button type="button" data-feed-opt="interval">Refresh interval: ${refreshInterval ? refreshInterval + " min" : "Global"}</button>` +
    `<button type="button" data-feed-opt="unsub">${armed ? "Click again to unsubscribe" : "Unsubscribe"}</button>`;
}
function renderFeedMenu() {
  const m = $("#feedMenu");
  if (!m || !feedMenuFeedId) return;
  const f = state.feeds.find(fe => fe.id === feedMenuFeedId);
  if (!f) { closeFeedMenu(); return; }
  m.innerHTML = feedMenuHTML(f);
}
function openFeedMenu(feedId, anchor) {
  const f = state.feeds.find(fe => fe.id === feedId);
  if (!f) return;
  if (feedMenuFeedId === feedId && !$("#feedMenu").hidden) { closeFeedMenu(); return; }
  closeFeedMenu();
  feedMenuFeedId = feedId;
  renderFeedMenu();
  const m = $("#feedMenu");
  m.hidden = false;
  // Position below the button, clamped to the viewport; flip above it
  // when there is not enough room below.
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = left + "px";
  m.style.top = top + "px";
  anchor.setAttribute("aria-expanded", "true");
}
function closeFeedMenu() {
  const m = $("#feedMenu");
  if (m) m.hidden = true;
  const prev = feedMenuFeedId ? document.querySelector(`[data-feed-opts="${CSS.escape(feedMenuFeedId)}"]`) : null;
  prev?.setAttribute("aria-expanded", "false");
  feedMenuFeedId = null;
}
let renameFeedId = null;
function showFeedRenameDialog(f) {
  renameFeedId = f.id;
  const inp = $("#feedRenameInput");
  if (inp) inp.value = f.customTitle || "";
  $("#feedRenameDialog").showModal();
  if (inp) { inp.focus(); inp.select(); }
}
function saveFeedRenameFromDialog() {
  if (!renameFeedId) return;
  const f = state.feeds.find(fe => fe.id === renameFeedId);
  if (f) {
    const v = ($("#feedRenameInput")?.value || "").trim();
    if (v) f.customTitle = v; else delete f.customTitle;
    saveFeeds();
    renderNav(); renderList();
    const x = selectedItem();
    if (x && x.feedId === f.id) renderReader(x);
    toast(v ? `Feed renamed to “${v}”.` : "Custom title cleared.");
  }
  $("#feedRenameDialog").close();
  renameFeedId = null;
}
let layoutFeedId = null;
function showFeedLayoutDialog(f) {
  layoutFeedId = f.id;
  $("#feedLayoutExcerpt").value = f.cardExcerpt || "global";
  $("#feedLayoutImage").value = f.cardImage || "global";
  $("#feedLayoutDialog").showModal();
}
function saveFeedLayoutFromDialog() {
  if (!layoutFeedId) return;
  const f = state.feeds.find(fe => fe.id === layoutFeedId);
  if (f) {
    f.cardExcerpt = $("#feedLayoutExcerpt").value;
    f.cardImage = $("#feedLayoutImage").value;
    saveFeeds();
    renderList();
    toast(`Layout saved for ${feedDisplayTitle(f)}.`);
  }
  $("#feedLayoutDialog").close();
  layoutFeedId = null;
}
/* Relative dates for list cards ("5m ago", "Yesterday"), with the full
   date kept in the title attribute. */
const relDate = d => {
  if (!d) return "No date";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const days = Math.floor(s / 86400);
  if (days === 1) return "Yesterday";
  if (days < 7) return days + "d ago";
  return d.toLocaleDateString();
};
/* Shorten text for list cards: cut at a word boundary and add an
   ellipsis, instead of slicing mid-word. */
/* Estimated reading time (#110): words in the text the reader would
   show (full text when loaded, otherwise the feed content or summary)
   at about 200 words per minute. Under 40 words there is nothing
   worth estimating, so the caller omits it. */
const readingTimeText = x => {
  const words = plainText(x.fullContent || x.content || x.summary || "").split(/\s+/).filter(Boolean).length;
  if (words < 40) return "";
  return Math.max(1, Math.round(words / 200)) + " min read";
};
/* Canonical article URL (#115): the strict duplicate definition. The
   same story at the same address is one article, even when feeds carry
   it with different tracking parameters, a fragment, or a www prefix.
   A different address is a different article, even with the same title. */
/* Byline timestamp without seconds ("11/16/2026 · 11:00 AM"). */
const fmtDateTime = d => d.toLocaleDateString() + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/* Strip publisher boilerplate out of summaries before they reach the
   list. Hacker News descriptions are "Article URL: … Comments URL: …
   Points: N # Comments: M"; some feeds (e.g. NASA APOD via WordPress)
   ship site navigation in the summary, which is cut at the first nav
   marker with the leading header tokens dropped. */
/* Strip publisher navigation boilerplate from the top of an article
   body element, using the same NAV_MARKERS as the summary cleaner so
   the two rules stay in sync. Only the leading boilerplate is removed:
   the run of leading nodes whose text contains a marker. A marker that
   appears later in the body is legitimate content and is left alone.
   A container holding nav and article together is stripped from the
   inside, and nav mixed with article text in one long node is cut
   through the last marker instead of deleting the node. A leading
   breadcrumb — a short list whose text holds a run of the article
   title — is also removed, so a nav block sitting under it becomes
   leading and is stripped too. Returns false when the strip would
   remove more than 40% of the body text, so the caller can keep the
   un-stripped body rather than risk gutting the article. Runs after
   cleanHTML has dropped the page chrome, so a nav block that sat under
   the site header is leading by the time it runs. */
function stripLeadingNavEl(body, title) {
  const total = (body.textContent || "").length;
  let removed = 0;
  const cutAfterLastMarker = n => {
    const raw = n.textContent || "";
    const norm = raw.replace(/[\u2018\u2019]/g, "'");
    let end = -1;
    for (const m of NAV_MARKERS) {
      const i = norm.lastIndexOf(m);
      if (i >= 0) end = Math.max(end, i + m.length);
    }
    if (end < 0) return true;
    const rest = raw.slice(end).replace(/^[\s|·:–—-]+/, "");
    if (!rest.trim()) { n.remove(); return false; }
    n.textContent = rest;
    return true;
  };
  const strip = el => {
    while (el.firstChild) {
      const n = el.firstChild;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      // Empty nodes are skipped, except media (an image paragraph is
      // article content, not boilerplate) which stops the strip.
      if (!t) {
        const hasMedia = n.nodeType === Node.ELEMENT_NODE && n.querySelector("img,video,audio,iframe,canvas,svg,object,embed");
        if (hasMedia) return true;
        el.removeChild(n);
        continue;
      }
      if (!NAV_MARKERS.some(m => t.includes(m))) {
        // A leading breadcrumb (a short list holding a run of the
        // article title) is boilerplate too; removing it lets the nav
        // block under it become leading and be stripped.
        if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === "OL" || n.tagName === "UL") &&
            t.length < 300 && title && titleAnchorPos(t, title) >= 0) {
          el.removeChild(n);
          removed += t.length;
          if (removed > total * 0.4) return false;
          continue;
        }
        return true;
      }
      if (n.nodeType === Node.ELEMENT_NODE && n.children.length && t.length > 400) {
        if (!strip(n)) return false;
        if (!n.textContent.trim()) { el.removeChild(n); continue; }
        return true;
      }
      if (t.length > 400) {
        if (cutAfterLastMarker(n)) return true;
        continue;
      }
      el.removeChild(n);
      removed += t.length;
      if (removed > total * 0.4) return false;
    }
    return true;
  };
  return strip(body);
}
/* Position of the article title inside a body of text, as the longest run
   of consecutive title words (at least 3) that appears in the text, or -1
   when no such run exists. Title prefixes (a site name, a date, "APOD: …")
   are skipped by trying shorter runs from the front. */
function titleAnchorPos(text, title) {
  const words = String(title || "").split(/\s+/).filter(Boolean);
  for (let len = words.length; len >= 3; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      const pos = text.indexOf(phrase);
      if (pos >= 0) return pos;
    }
  }
  return -1;
}
/* Drop everything before the first block containing the article title.
   Reader-service output (and some feed content) can carry the whole page
   — site menus, nav, footer — flattened into plain blocks with no
   structure to strip by tag or class. The title is the one reliable
   anchor: it sits at the head of the article itself. Only cuts when the
   title is within the first 8000 characters and no long prose paragraph
   sits before it — a title mentioned late in a real article is a mention,
   not the article head, and the prose before it is the article itself.
   Returns true when it removed anything. */
function cutBeforeTitleEl(body, title) {
  const text = body.textContent || "";
  const pos = titleAnchorPos(text, title);
  if (pos < 0 || pos > 8000) return false;
  let seen = 0;
  let longProse = 0;
  const toRemove = [];
  for (const child of [...body.children]) {
    const len = (child.textContent || "").length;
    if (seen + len > pos) break;
    if ((child.tagName === "P" || child.tagName === "BLOCKQUOTE") && len > 300) longProse += len;
    seen += len;
    toRemove.push(child);
  }
  // If most of what would be removed is article prose, the title is a
  // late mention, not the article head — leave it alone.
  if (seen > 0 && longProse / seen > 0.5) return false;
  toRemove.forEach(c => body.removeChild(c));
  return toRemove.length > 0;
}
/* Feed label for a list card. The stored feedTitle can be empty for
   items saved by an older build, and the feed may have been re-added
   since (new id), so fall back to the feed's current title, then to
   matching the article's host against the feeds' sites and feed URLs.
   The host match ignores scheme and www, since older saved links can
   be http: while the feed is now https:. */
/* Per-feed display title (#183): a custom title set in the feed's
   options menu wins over the feed's own title. */
const feedDisplayTitle = f => (f?.customTitle || "").trim() ? f.customTitle.trim() : (f?.title || "");
/* Per-feed card layout (#183): an override wins, otherwise the global
   setting. "global" means no override. */
const feedCardExcerpt = f => (f?.cardExcerpt && f.cardExcerpt !== "global") ? f.cardExcerpt : (state.settings.cardExcerpt || "full");
const feedCardImage = f => f?.cardImage === "hide" ? false : f?.cardImage === "show" ? true : (state.settings.cardImage !== false);
/* The sort for the current view (#183): a feed's own sort wins when
   viewing that feed, otherwise the global sort. */
function effectiveSort() {
  if (state.feed) {
    const f = state.feeds.find(fe => fe.id === state.feed);
    if (f?.sort && f.sort !== "global") return f.sort;
  }
  return state.sort;
}
const feedTitleFor = x => {
  // Resolve the feed's CURRENT title at render time (#183), so a rename
  // updates every card at once; the stored title is only a fallback
  // for feeds that are gone.
  const byId = state.feeds.find(f => f.id === x.feedId);
  if (byId) return feedDisplayTitle(byId);
  if (x.feedTitle) return x.feedTitle;
  try {
    const host = new URL(x.url).hostname.replace(/^www\./, "");
    const byHost = state.feeds.find(f => [f.site, f.url].some(u => {
      try { return u && new URL(u).hostname.replace(/^www\./, "") === host; } catch { return false; }
    }));
    if (byHost) return feedDisplayTitle(byHost);
  } catch {}
  return "";
};

function toast(s, action) {
  const e = $("#toast");
  e.textContent = s;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => { e.classList.remove("show"); action.fn(); };
    e.appendChild(b);
  }
  e.classList.add("show");
  clearTimeout(timer);
  // Long messages stay up longer so they can actually be read; an
  // action (e.g. Undo) gets a full 8 seconds to be noticed and used.
  const ms = action ? 8000 : Math.min(9000, 3200 + Math.max(0, s.length - 60) * 30);
  timer = setTimeout(() => e.classList.remove("show"), ms);
}
function local(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { toast("Browser storage is full."); }
}
/* Whitelist + validate stored settings: unknown keys and out-of-range
   values are dropped instead of silently corrupting the settings.
   Shared by loadLocal (a corrupt localStorage entry) and
   importSettings (an imported file). */
function validateSettings(d) {
  if (!d || typeof d !== "object") return {};
  const pick = (sel, val) => { const opts = [...$(sel).options].map(o => o.value); return opts.includes(val) ? val : null; };
  const next = {};
  const theme = pick("#themeSelect", d.theme); if (theme) next.theme = theme;
  const width = pick("#widthSelect", d.width); if (width) next.width = width;
  const size = pick("#sizeSelect", d.size); if (size) next.size = size;
  const font = pick("#fontSelect", d.readerFont); if (font) next.readerFont = font;
  const lh = pick("#lineHeightSelect", d.lineHeight); if (lh) next.lineHeight = lh;
  if (typeof d.ttsRate === "number" && d.ttsRate >= 0.5 && d.ttsRate <= 2) next.ttsRate = d.ttsRate;
  const prog = pick("#progressSelect", d.progressPosition); if (prog) next.progressPosition = prog;
  const mbar = pick("#mobileBarSelect", d.mobileReaderBar); if (mbar) next.mobileReaderBar = mbar;
  const preset = pick("#shortcutPresetSelect", d.shortcutPreset); if (preset) next.shortcutPreset = preset;
  // Migrate the former standalone Vim toggle into the unified preset selector.
  if (d.vimNavigation === true) next.shortcutPreset = "vim";
  const exc = pick("#cardExcerptSelect", d.cardExcerpt); if (exc) next.cardExcerpt = exc;
  if (typeof d.cardImage === "boolean") next.cardImage = d.cardImage;
  if (typeof d.hideDuplicates === "boolean") next.hideDuplicates = d.hideDuplicates;
  if (typeof d.backgroundSync === "boolean") next.backgroundSync = d.backgroundSync;
  if (typeof d.notifyNew === "boolean") next.notifyNew = d.notifyNew;
  if (typeof d.sidebarCollapsed === "boolean") next.sidebarCollapsed = d.sidebarCollapsed;
  if (typeof d.sidebarWidth === "number" && d.sidebarWidth >= 180 && d.sidebarWidth <= 420) next.sidebarWidth = d.sidebarWidth;
  if (typeof d.listWidth === "number" && d.listWidth >= 280 && d.listWidth <= 640) next.listWidth = d.listWidth;
  if (["sidebar", "list", "article"].includes(d.vimPane)) next.vimPane = d.vimPane;
  if (d.shortcutCoachingExplicit === true && typeof d.shortcutCoaching === "boolean") {
    next.shortcutCoaching = d.shortcutCoaching;
    next.shortcutCoachingExplicit = true;
  } else {
    // Older settings stored the former off-by-default value without recording
    // a user choice. Apply the responsive default during this migration.
    next.shortcutCoaching = matchMedia("(min-width:821px)").matches;
    next.shortcutCoachingExplicit = false;
  }
  if (typeof d.shortcutBar === "boolean") next.shortcutBar = d.shortcutBar;
  if ([0,30,90,180,365].includes(Number(d.retentionDays))) next.retentionDays = Number(d.retentionDays);
  if ([0,250,500,1000,2500,5000].includes(Number(d.retentionCount))) next.retentionCount = Number(d.retentionCount);
  if ([15,30,60,180,360,720,1440].includes(Number(d.globalRefreshMinutes))) next.globalRefreshMinutes = Number(d.globalRefreshMinutes);
  if (d.sort === "newest" || d.sort === "oldest") next.sort = d.sort;
  if (["all", "today", "week"].includes(d.filter)) next.filter = d.filter;
  if (Array.isArray(d.toolbarOrder)) {
    const clean = d.toolbarOrder.filter(k => TOOLBAR_KEYS.includes(k));
    const missing = TOOLBAR_KEYS.filter(k => !clean.includes(k));
    if (clean.length) next.toolbarOrder = [...clean, ...missing];
  }
  return next;
}
function loadLocal() {
  try {
    state.feeds = JSON.parse(localStorage.getItem(K) || "[]");
    if (!Array.isArray(state.feeds)) throw Error("bad feeds");
  } catch {
    try {
      state.feeds = JSON.parse(localStorage.getItem(K + ".bak") || "[]");
      if (!Array.isArray(state.feeds)) throw Error("bad backup");
      state.feedsRestored = true;
    } catch { state.feeds = []; }
  }
  // A stored group that is not a string (corrupt state) must never
  // reach the sidebar: it renders as "[object Object]" and breaks the
  // folder sort. Recover it as ungrouped.
  for (const f of state.feeds) if (typeof f.group !== "string") f.group = "";
  try { state.settings = { ...state.settings, ...validateSettings(JSON.parse(localStorage.getItem(S) || "{}")) }; } catch {}
  state.sort = state.settings.sort === "oldest" ? "oldest" : "newest";
  state.filter = ["all", "today", "week"].includes(state.settings.filter) ? state.settings.filter : "all";
  try { state.folders = JSON.parse(localStorage.getItem(KF) || "[]"); if (!Array.isArray(state.folders)) state.folders = []; } catch { state.folders = []; }
  try { state.tags = JSON.parse(localStorage.getItem(KT) || "[]"); if (!Array.isArray(state.tags)) state.tags = []; } catch { state.tags = []; }
  try { state.savedSearches = JSON.parse(localStorage.getItem(KS) || "[]"); if (!Array.isArray(state.savedSearches)) state.savedSearches = []; } catch { state.savedSearches = []; }
  try { state.rules = JSON.parse(localStorage.getItem(KR) || "[]"); if (!Array.isArray(state.rules)) state.rules = []; } catch { state.rules = []; }
  try { state.lastRefresh = Number(localStorage.getItem(LR) || 0) || 0; } catch { state.lastRefresh = 0; }
  syncFolders();
}
function saveFeeds() {
  // Keep a backup copy: a corrupt primary entry must not silently
  // erase every subscription (loadLocal restores from it).
  local(K, state.feeds);
  local(K + ".bak", state.feeds);
  mirrorSync();
}
function saveFolders() { local(KF, state.folders); }
function saveTags() { local(KT, state.tags); }
function saveSavedSearches() { local(KS, state.savedSearches); }
function saveRules() { local(KR, state.rules); }
/* Folders come from the stored list plus any group a feed already has
   (e.g. from an OPML import), so imported folders never vanish. */
function syncFolders() {
  const names = new Set(state.folders.filter(f => typeof f === "string"));
  for (const f of state.feeds) if (typeof f.group === "string" && f.group) names.add(f.group);
  state.folders = [...names].sort((a, b) => a.localeCompare(b));
}
/* Tags likewise: the stored list plus any tag already on an article. */
function syncTags() {
  const names = new Set(state.tags);
  for (const x of state.items) for (const t of x.tags || []) names.add(t);
  state.tags = [...names].sort((a, b) => a.localeCompare(b));
}

/* ---------- storage ---------- */
/* IndexedDB connections can be closed by the browser (versionchange from
   another tab, storage pressure). A closed connection makes every
   transaction throw "The database connection is closing", so every
   operation retries once after reopening. */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
      // The service worker reads this store for background refresh:
      // it cannot see localStorage, so the feed list and the
      // sync-relevant settings are mirrored here.
      if (!d.objectStoreNames.contains("sync")) d.createObjectStore("sync", { keyPath: "key" });
      // Highlights (#116): the article id, the selected text, and an
      // optional note, rendered back into the article when it opens.
      if (!d.objectStoreNames.contains("highlights")) d.createObjectStore("highlights", { keyPath: "id" });
    };
    r.onsuccess = () => {
      r.result.onclose = () => { db = null; };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  });
}
function runTx(mode, op, store = "items") {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const attempt = () => {
      if (!db) {
        openDB().then(ndb => { db = ndb; attempt(); }).catch(reject);
        return;
      }
      let req;
      try {
        req = op(db.transaction(store, mode).objectStore(store));
      } catch (e) {
        if (retries < 1) {
          retries++;
          db = null;
          attempt();
        } else reject(e);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
    attempt();
  });
}
function dbAll() { return runTx("readonly", s => s.getAll()); }
function put(item) { return runTx("readwrite", s => s.put(item)); }
function dbDelete(itemId) { return runTx("readwrite", s => s.delete(itemId)); }
/* Highlights (#116) live in their own store, keyed by highlight id. */
function hlAll() { return runTx("readonly", s => s.getAll(), "highlights"); }
function hlPut(h) { return runTx("readwrite", s => s.put(h), "highlights"); }
function hlDelete(hlId) { return runTx("readwrite", s => s.delete(hlId), "highlights"); }
/* Batch IndexedDB writes: one transaction for many items, with the
   same reopen-and-retry as runTx. */
function runBatch(mode, fn, store = "items") {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const attempt = () => {
      if (!db) { openDB().then(ndb => { db = ndb; attempt(); }).catch(reject); return; }
      let tx;
      try { tx = db.transaction(store, mode); fn(tx.objectStore(store)); }
      catch (e) { if (retries < 1) { retries++; db = null; attempt(); } else reject(e); return; }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    attempt();
  });
}
function putMany(items) { return runBatch("readwrite", s => { for (const x of items) s.put(x); }); }
function deleteMany(ids) { return runBatch("readwrite", s => { for (const id of ids) s.delete(id); }); }
/* Mirror the feed list and the sync-relevant settings into IndexedDB,
   where the service worker can read them for background refresh.
   Fire-and-forget: a mirror failure must not break the UI. */
function mirrorSync() {
  const feeds = state.feeds.map(f => ({ id: f.id, url: f.url, title: f.title, via: f.via, wpRoot: f.wpRoot, site: f.site }));
  const settings = { notifyNew: !!state.settings.notifyNew };
  runBatch("readwrite", s => {
    s.put({ key: "feeds", value: feeds });
    s.put({ key: "settings", value: settings });
  }, "sync").catch(() => {});
}
/* Periodic Background Sync registration. Only Chrome on Android (for an
   installed PWA) supports it; elsewhere the registration throws and the
   setting is turned back off with an explanation. Notifications only
   come from a background refresh, so turning refresh off also turns
   notifications off. */
async function applyBackgroundSync(quiet) {
  const off = (msg) => {
    state.settings.backgroundSync = false;
    state.settings.notifyNew = false;
    local(S, state.settings);
    mirrorSync();
    const b = $("#backgroundSyncToggle"), n = $("#notifyNewToggle");
    if (b) b.checked = false;
    if (n) n.checked = false;
    if (msg && !quiet) toast(msg);
  };
  if (!("serviceWorker" in navigator)) { if (state.settings.backgroundSync) off("Background refresh is not available in this browser."); return; }
  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { reg = null; }
  if (!reg || !("periodicSync" in reg)) { if (state.settings.backgroundSync) off("Background refresh is not available in this browser. It needs Chrome on Android with the app installed."); return; }
  if (state.settings.backgroundSync) {
    try {
      const status = await navigator.permissions.query({ name: "periodic-background-sync" });
      if (status.state === "denied") throw Error("denied");
      // 12 hours is the minimum the browser allows; it decides the
      // actual timing and may run less often.
      await reg.periodicSync.register("refresh-feeds", { minInterval: 12 * 60 * 60 * 1000 });
    } catch (e) {
      off("Background refresh could not be turned on. It needs Chrome on Android with the app installed, and the browser grants it based on use.");
      return;
    }
    if (state.settings.notifyNew && "Notification" in window) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        state.settings.notifyNew = false;
        local(S, state.settings);
        mirrorSync();
        const n = $("#notifyNewToggle");
        if (n) n.checked = false;
        if (!quiet) toast("Notifications are blocked in this browser, so new-article notifications are off.");
      }
    }
  } else {
    try { await reg.periodicSync.unregister("refresh-feeds"); } catch {}
    if (state.settings.notifyNew) {
      state.settings.notifyNew = false;
      local(S, state.settings);
      mirrorSync();
      const n = $("#notifyNewToggle");
      if (n) n.checked = false;
    }
  }
}

/* ---------- settings ---------- */
/* Read the settings dialog's controls into a settings object. Shared by
   Done and by live-apply (#162): changing a control applies at once, so
   closing with × no longer silently discards the change. */
function readSettingsFromDialog() {
  return {
    theme: $("#themeSelect").value, width: $("#widthSelect").value, size: $("#sizeSelect").value,
    readerFont: $("#fontSelect").value, lineHeight: $("#lineHeightSelect").value,
    ttsRate: state.settings.ttsRate || 1,
    hideDuplicates: $("#hideDuplicatesToggle").checked,
    progressPosition: $("#progressSelect").value,
    mobileReaderBar: $("#mobileBarSelect").value,
    shortcutPreset: $("#shortcutPresetSelect").value,
    vimPane: state.settings.vimPane || "list",
    cardExcerpt: $("#cardExcerptSelect").value, cardImage: $("#cardImageToggle").checked,
    backgroundSync: $("#backgroundSyncToggle").checked, notifyNew: $("#notifyNewToggle").checked,
    shortcutCoaching: $("#shortcutCoachingToggle").checked,
    shortcutCoachingExplicit: true,
    shortcutBar: $("#shortcutBarToggle").checked,
    retentionDays: Number($("#retentionDaysSelect").value),
    retentionCount: Number($("#retentionCountSelect").value),
    globalRefreshMinutes: Number($("#globalRefreshMinutesSelect").value),
    sidebarCollapsed: state.settings.sidebarCollapsed || false,
    sidebarWidth: state.settings.sidebarWidth, listWidth: state.settings.listWidth,
    // Sort and filter are set elsewhere (the sort button, the filter
    // pills) and must survive a settings save, or a trip through
    // Settings silently resets them.
    sort: state.settings.sort || "newest",
    filter: state.settings.filter || "all",
    // The toolbar order comes from the reorder list in the dialog; if
    // the list is not populated (dialog never opened), keep the stored
    // order instead of wiping it.
    toolbarOrder: toolbarOrderFromDialog() || state.settings.toolbarOrder || [...TOOLBAR_DEFAULT]
  };
}
function applySettingsFromDialog(runSync) {
  state.settings = readSettingsFromDialog();
  local(S, state.settings);
  applySettings();
  mirrorSync();
  if (runSync) applyBackgroundSync();
  // Card options apply to the list; the progress bar's place is set
  // when an article opens, so re-render both at once.
  renderList();
  // The progress bar's place in the reader is set when an article opens;
  // re-render the open article so a changed position applies at once,
  // keeping the reader's scroll position (renderReader resets it).
  if (state.selected) {
    const x = selectedItem();
    if (x) {
      const sc = $("#reader").scrollTop;
      renderReader(x);
      $("#reader").scrollTop = sc;
      updateReadProgress();
    }
  }
}
/* Background refresh and notifications cannot work everywhere (#162):
   when the dialog opens, disable the toggles that cannot work here and
   say why, instead of letting them be switched on to no effect. */
async function refreshSyncCapability() {
  const b = $("#backgroundSyncToggle"), n = $("#notifyNewToggle"), note = $("#syncNote");
  const disable = msg => {
    if (b) { b.disabled = true; b.checked = false; }
    if (n) { n.disabled = true; n.checked = false; }
    if (note) note.textContent = msg;
  };
  if (!("serviceWorker" in navigator)) { disable("Background refresh is not available in this browser."); return; }
  let reg = null;
  try { reg = await navigator.serviceWorker.ready; } catch {}
  if (!reg || !("periodicSync" in reg)) { disable("Background refresh needs Chrome on Android with the app installed."); return; }
  if (b) b.disabled = false;
  if (n) {
    const blocked = !("Notification" in window) || Notification.permission === "denied";
    n.disabled = blocked;
    if (blocked) n.checked = false;
  }
  if (note) note.textContent = n?.disabled ? "Notifications are blocked in this browser." : "";
}
function applyVimPaneFocus() {
  const pane = ["sidebar", "list", "article"].includes(state.settings.vimPane) ? state.settings.vimPane : "list";
  document.body.dataset.vimPane = pane;
  $("#sidebar")?.classList.toggle("vim-focused", shortcutPreset() === "vim" && pane === "sidebar");
  $(".list-pane")?.classList.toggle("vim-focused", shortcutPreset() === "vim" && pane === "list");
  $("#reader")?.classList.toggle("vim-focused", shortcutPreset() === "vim" && pane === "article");
}
function setVimPaneFocus(pane) {
  if (!["sidebar", "list", "article"].includes(pane)) return;
  state.settings.vimPane = pane;
  local(S, state.settings);
  applyVimPaneFocus();
}
function applySettings() {
  let t = state.settings.theme;
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  // Keep the browser chrome (status bar, task switcher) on the same
  // color as the theme, so the theme never flashes the wrong color.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#f4f2ec" : t === "white" ? "#ffffff" : "#000000";
  document.documentElement.dataset.width = state.settings.width;
  document.documentElement.dataset.size = state.settings.size;
  // Reader typography (#111): serif/comfortable are the defaults, so
  // the existing look is unchanged until the user picks otherwise.
  document.documentElement.dataset.readerFont = state.settings.readerFont || "serif";
  document.documentElement.dataset.lineHeight = state.settings.lineHeight || "comfortable";
  // Mobile article actions (#179): bottom bar by default, top bar when
  // the user picks it in Settings. The CSS keys off this class.
  document.body.classList.toggle("mobile-bar-top", state.settings.mobileReaderBar === "top");
  document.body.classList.toggle("vim-navigation-enabled", shortcutPreset() === "vim");
  applyVimPaneFocus();
  applySidebarCollapsed();
  applyPaneWidths();
  renderShortcutBar();
}
/* Sidebar collapse: the sidebar becomes a 52px rail holding only the
   toggle (top left), so the list and reader get the full width. The
   choice persists with the other settings. */
function applySidebarCollapsed() {
  const collapsed = !!state.settings.sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if (collapsed) {
    document.documentElement.style.setProperty(
      "--collapsed-list-extra",
      Math.max(0, state.settings.sidebarWidth - 52) + "px"
    );
  } else {
    document.documentElement.style.removeProperty("--collapsed-list-extra");
  }
  const btn = $("#sideToggle");
  if (!btn) return;
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  // The chevron icon flips via CSS (body.sidebar-collapsed rotates it).
  positionSplitters();
}

/* Draggable pane widths (#90): the sidebar and article-list widths are
   CSS variables on the grid (--side-w, --list-w), persisted in settings.
   The splitter handles are absolutely positioned in .layout and placed
   from the panes' actual rects, so they stay on the boundary even when
   the grid clamps a column on a narrow viewport. */
const SIDE_W = { min: 180, max: 420, def: 250 };
const LIST_W = { min: 280, max: 640, def: 400 };
function clampW(v, r) { return Math.min(r.max, Math.max(r.min, Math.round(v) || r.def)); }
function applyPaneWidths() {
  const side = clampW(state.settings.sidebarWidth, SIDE_W);
  const list = clampW(state.settings.listWidth, LIST_W);
  state.settings.sidebarWidth = side;
  state.settings.listWidth = list;
  document.documentElement.style.setProperty("--side-w", side + "px");
  document.documentElement.style.setProperty("--list-w", list + "px");
  // The splitters report their size to assistive tech, like a slider.
  const ss = $("#splitSide"), sl = $("#splitList");
  if (ss) ss.setAttribute("aria-valuenow", String(side));
  if (sl) sl.setAttribute("aria-valuenow", String(list));
  positionSplitters();
  if (typeof updatePanePresetSelect === "function") updatePanePresetSelect();
}
/* Place the splitter handles on the panes' right edges. Skipped on
   mobile, where the sidebar is a drawer and the splitters are hidden. */
function positionSplitters() {
  if (!matchMedia("(min-width:821px)").matches) return;
  const layout = $(".layout");
  const side = $("#sidebar"), list = $(".list-pane");
  if (!layout || !side || !list) return;
  const l = layout.getBoundingClientRect();
  const place = (el, edge) => { if (el) el.style.left = (edge - l.left - 4.5) + "px"; };
  place($("#splitSide"), side.getBoundingClientRect().right);
  place($("#splitList"), list.getBoundingClientRect().right);
}
/* Pointer drag on a splitter: move the pane edge, live. Double-click
   resets that pane to its default width; arrow keys nudge it. */
function bindSplitter(el, kind) {
  if (!el) return;
  const range = kind === "side" ? SIDE_W : LIST_W;
  const key = kind === "side" ? "sidebarWidth" : "listWidth";
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (kind === "list" && document.body.classList.contains("sidebar-collapsed")) {
      // Once the user manually resizes the collapsed layout, treat the
      // chosen width as the actual list width instead of adding the
      // sidebar's freed space on top of it.
      document.documentElement.style.setProperty("--collapsed-list-extra", "0px");
    }
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    document.body.classList.add("dragging-splitter");
    const startX = e.clientX, start = state.settings[key];
    const move = ev => {
      state.settings[key] = clampW(start + (ev.clientX - startX), range);
      document.documentElement.style.setProperty(kind === "side" ? "--side-w" : "--list-w", state.settings[key] + "px");
      el.setAttribute("aria-valuenow", String(state.settings[key]));
      positionSplitters();
    };
    const up = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("dragging-splitter");
      // A drag can still leave a selection behind; clear it (#139).
      try { getSelection()?.removeAllRanges(); } catch {}
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      local(S, state.settings);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("dblclick", () => {
    state.settings[key] = range.def;
    applyPaneWidths();
    local(S, state.settings);
  });
  el.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    state.settings[key] = clampW(state.settings[key] + (e.key === "ArrowRight" ? 10 : -10), range);
    applyPaneWidths();
    local(S, state.settings);
  });
}
function bindSplitters() {
  bindSplitter($("#splitSide"), "side");
  bindSplitter($("#splitList"), "list");
  window.addEventListener("resize", () => {
    positionSplitters();
    if (!isShortcutCoachingAvailable()) $("#shortcutCoach")?.classList.remove("show");
    if (!state.settings.shortcutCoachingExplicit) {
      state.settings.shortcutCoaching = isShortcutCoachingAvailable();
      local(S, state.settings);
      const toggle = $("#shortcutCoachingToggle");
      if (toggle) toggle.checked = state.settings.shortcutCoaching;
    }
    renderShortcutBar();
  });
}

/* Reading progress (#92): thin bar at the bottom of the reader, filled
   by how far the open article is scrolled. Hidden when the article is
   too short to scroll. */
function updateReadProgress() {
  const reader = $("#reader"), bar = $("#readProgress");
  if (!reader || !bar) return;
  const max = reader.scrollHeight - reader.clientHeight;
  // A few pixels of scrollable distance is rounding and the bar's own
  // height, not a real scroll: hide the bar for a short article.
  if (max < 10) { bar.style.display = "none"; return; }
  bar.style.display = "";
  const pct = Math.min(100, Math.max(0, reader.scrollTop / max * 100));
  bar.firstElementChild.style.width = pct + "%";
}

/* Dates: null when missing/unparseable, so dateless items sort after dated
   ones instead of silently becoming 1970-01-01. */
function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function dateSortKey(x) {
  const d = date(x.published);
  return d ? d.getTime() : null;
}

/* ---------- error classification ---------- */
function classifyError(e, wasHttp) {
  if (e && e.name === "AbortError") return "Timed out after " + (FETCH_TIMEOUT_MS / 1000) + "s. The publisher did not respond in time.";
  const msg = String((e && e.message) || e || "");
  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    // The address was http: and was rewritten to https: for the fetch, so
    // name the original scheme instead of blaming the rewritten one.
    if (wasHttp) return "Could not be reached from this browser. This feed only serves http:, which a secure page cannot load. Try the site's https address, if it has one.";
    return "Could not be reached from this browser. This usually means the publisher does not allow cross-origin requests (CORS), or the address uses http: on a secure page.";
  }
  if (/^HTTP \d+/.test(msg)) return "The publisher answered with " + msg + ".";
  if (/No feed link found/i.test(msg)) return msg;
  if (/not a supported/i.test(msg)) return msg;
  return msg || "Could not load this feed.";
}

/* ---------- fetching ---------- */
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  return r;
}
async function fetchText(url) {
  const r = await fetchWithTimeout(url, {
    headers: { Accept: "application/atom+xml,application/rss+xml,application/xml,text/xml,application/feed+json,application/json,*/*" },
    cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  return { text: await r.text(), finalUrl: r.url || url };
}
const looksLikeFeed = t => {
  const s = t.trim();
  return s.startsWith("<?xml") || /<(rss|feed|rdf:RDF)\b/i.test(s) || s.startsWith("{");
};

/* ---------- feed parsing ---------- */
/* localName-based lookups: getElementsByTagName("creator") does NOT match
   <dc:creator>, and <content:encoded> is localName "encoded". */
function childEl(node, name) {
  if (!node) return null;
  for (const c of node.childNodes) {
    if (c.nodeType === 1 && c.localName === name) return c;
  }
  return null;
}
function childText(node, name) {
  const el = childEl(node, name);
  return el ? (el.textContent || "").trim() : "";
}
function atomLink(node) {
  if (!node) return "";
  const links = [...node.childNodes].filter(c => c.nodeType === 1 && c.localName === "link");
  const pick = links.find(l => l.getAttribute("rel") === "alternate")
    || links.find(l => { const r = l.getAttribute("rel"); return !r || r !== "self"; })
    || links[0];
  return pick ? (pick.getAttribute("href") || "") : "";
}
/* First image in a block of HTML. Many feeds carry the photo in the
   article's own description, not in a media tag, so this is the
   fallback that makes card thumbnails actually appear. */
function firstImgSrc(html) {
  const m = (html || "").match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : "";
}
function itemImage(n) {
  const thumb = childEl(n, "thumbnail");
  if (thumb && thumb.getAttribute("url")) return thumb.getAttribute("url");
  const media = childEl(n, "content");
  if (media && media.getAttribute("url") && /^image\//.test(media.getAttribute("type") || "")) return media.getAttribute("url");
  const enc = childEl(n, "enclosure");
  if (enc && enc.getAttribute("url") && /^image\//.test(enc.getAttribute("type") || "")) return enc.getAttribute("url");
  return firstImgSrc(childText(n, "encoded") || childText(n, "content") || childText(n, "description") || childText(n, "summary") || "");
}
function itemEnclosure(n) {
  const enc = childEl(n, "enclosure");
  if (enc && enc.getAttribute("url")) return { url: enc.getAttribute("url"), type: enc.getAttribute("type") || "" };
  const media = childEl(n, "content");
  if (media && media.getAttribute("url") && /^(audio|video)\//.test(media.getAttribute("type") || "")) {
    return { url: media.getAttribute("url"), type: media.getAttribute("type") };
  }
  return null;
}
function itemAuthor(n) {
  const dc = childText(n, "creator");
  if (dc) return dc;
  const a = childEl(n, "author");
  if (a) return childText(a, "name") || (a.textContent || "").trim();
  return "";
}

function parseFeed(text, url) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    try {
      const j = JSON.parse(text);
      if (j.items) {
        return {
          title: j.title || host(url), site: j.home_page_url || url,
          items: j.items.map(x => ({
            title: x.title || "(untitled)",
            url: x.url || x.external_url || url,
            guid: x.id || x.url || x.external_url || "",
            summary: x.summary || x.content_text || "",
            content: x.content_html || x.content_text || "",
            author: typeof x.author === "string" ? x.author : (x.author?.name || ""),
            date: x.date_published || x.date_modified || "",
            image: x.image || "", enclosure: null
          }))
        };
      }
    } catch {}
    throw Error("The response is not a supported RSS, Atom, or JSON Feed document.");
  }
  const root = doc.documentElement;
  const atom = root.localName === "feed";
  const channel = atom ? root : (doc.querySelector("channel") || root);
  const nodes = atom
    ? [...root.children].filter(n => n.localName === "entry")
    : [...doc.querySelectorAll("item")];
  const site = atom ? (atomLink(channel) || url) : (childText(channel, "link") || url);
  return {
    title: (atom ? (childText(channel, "title")) : childText(channel, "title")) || host(url),
    site,
    items: nodes.map(n => {
      const link = atom ? atomLink(n) : (childText(n, "link") || "");
      const guid = childText(n, "guid") || "";
      const encodedContent = childEl(n, "encoded");
      const atomContent = atom && childEl(n, "content");
      const content = childText(n, "encoded") || childText(n, "content") || childText(n, "description") || childText(n, "summary");
      const summary = childText(n, "summary") || childText(n, "description") || content;
      return {
        title: childText(n, "title") || "(untitled)",
        url: link || guid || url,
        guid,
        summary, content,
        fullContentIncluded: !!(encodedContent || atomContent),
        author: itemAuthor(n),
        date: childText(n, "pubDate") || childText(n, "published") || childText(n, "updated") || childText(n, "date") || "",
        image: itemImage(n),
        enclosure: itemEnclosure(n)
      };
    })
  };
}

/* WordPress REST API adapter. WordPress sends permissive CORS headers on
   /wp-json/ even when /feed sends none, and its posts carry full content. */
async function loadWordPressFeed(origin, knownTitle) {
  const base = origin.replace(/\/$/, "") + "/wp-json/wp/v2/posts";
  // 30 posts, not 100: with _embed the 100-post payload is ~4.5 MB and
  // Some publisher sites can take longer than the 15 s fetch timeout.
  // on a slow connection and fail the add/refresh entirely.
  const r = await fetchWithTimeout(base + "?per_page=30&_embed&orderby=date&order=desc", {
    headers: { Accept: "application/json" }, cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const posts = await r.json();
  if (!Array.isArray(posts)) throw Error("Unexpected WordPress API response.");
  // The site title comes from the /wp-json/ root, but only on add: on
  // refresh the feed already has its title, and a second fetch per
  // feed per refresh is wasted.
  let siteTitle = knownTitle || host(origin), siteUrl = origin;
  if (!knownTitle) {
    try {
      const ir = await fetchWithTimeout(origin.replace(/\/$/, "") + "/wp-json/", {
        headers: { Accept: "application/json" }, cache: "no-store"
      });
      if (ir.ok) {
        const info = await ir.json();
        siteTitle = info.name || siteTitle;
        siteUrl = info.url || siteUrl;
      }
    } catch {}
  }  return {
    title: siteTitle, site: siteUrl,
    items: posts.map(p => ({
      title: plainText(p.title?.rendered) || "(untitled)",
      url: p.link || origin,
      guid: (typeof p.guid === "string" ? p.guid : p.guid?.rendered) || p.link || "",
      summary: plainText(p.excerpt?.rendered) || "",
      content: p.content?.rendered || "",
      author: p._embedded?.author?.[0]?.name || "",
      date: p.date || p.modified || "",
      image: p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || firstImgSrc(p.content?.rendered || ""),
      enclosure: null
    }))
  };
}

/* Public feed-to-JSON fallback (opt-in). The feed passes through a third
   party, so this runs only when the user enables it in Settings. */
async function loadViaProxy(feedUrl) {
  const r = await fetchWithTimeout(PROXY_API + encodeURIComponent(feedUrl), {
    headers: { Accept: "application/json" }, cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "ok" || !Array.isArray(j.items)) throw Error("The proxy could not read this feed.");
  return {
    title: j.feed?.title || host(feedUrl), site: j.feed?.link || feedUrl,
    items: j.items.map(x => ({
      title: x.title || "(untitled)",
      url: x.link || feedUrl,
      guid: x.guid || x.link || "",
      summary: plainText(x.description) || "",
      content: x.content || x.description || "",
      author: x.author || "",
      date: x.pubDate || "",
      image: x.thumbnail || x.enclosure?.link || firstImgSrc(x.content || x.description || ""),
      enclosure: x.enclosure?.link ? { url: x.enclosure.link, type: x.enclosure.type || "" } : null
    }))
  };
}

/* Fetch the raw feed XML through AllOrigins and parse it with the
   app's own parser (#181). AllOrigins returns the feed as-is, so
   this is the exact feed asked for (unlike WordPress, which returns
   the site's main posts feed). The original feed URL is the parse
   base, not the AllOrigins address, so relative links resolve. */
async function loadViaAllOrigins(feedUrl) {
  const { text } = await fetchText(ALLORIGINS + encodeURIComponent(feedUrl));
  return parseFeed(text, feedUrl);
}
/* Try the two always-on helpers in order (#181): rss2json first, then
   AllOrigins — or the reverse when the feed was last loaded through
   AllOrigins. Returns { parsed, via } for the first one that works,
   or throws when both fail. */
async function loadViaHelpers(feedUrl, preferAllOrigins) {
  const first = preferAllOrigins ? loadViaAllOrigins : loadViaProxy;
  const second = preferAllOrigins ? loadViaProxy : loadViaAllOrigins;
  const firstVia = preferAllOrigins ? "allorigins" : "proxy";
  const secondVia = preferAllOrigins ? "proxy" : "allorigins";
  try {
    return { parsed: await first(feedUrl), via: firstVia };
  } catch {}
  return { parsed: await second(feedUrl), via: secondVia };
}

async function discover(url) {
  const { text, finalUrl } = await fetchText(url);
  if (looksLikeFeed(text)) return { url: finalUrl, text };
  const doc = new DOMParser().parseFromString(text, "text/html");
  const pick = sel => doc.querySelector(sel);
  const l = pick('link[rel="alternate"][type*="rss"]')
    || pick('link[rel="alternate"][type*="atom"]')
    || pick('link[rel="alternate"][type*="json"]');
  if (!l) throw Error("No feed link found on that page. Try the direct feed URL.");
  const feedUrl = new URL(l.getAttribute("href"), url).href;
  const found = await fetchText(feedUrl);
  return { url: found.finalUrl, text: found.text };
}
/* Try every in-page source for a feed URL, in order. Returns
   { parsed, via, url, wpRoot }. Throws the direct-fetch error when all fail. */
/* Conventional feed locations, tried in order when only a bare website
   address is given, or when the page advertises no feed link. */
const FEED_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"];
async function loadFeedFromUrl(rawUrl) {
  const url = normalizeFeedUrl(rawUrl);
  let directError = null;
  try {
    const found = await discover(url);
    return { parsed: parseFeed(found.text, found.url), via: "feed", url: found.url, wpRoot: "" };
  } catch (e) { directError = e; }
  const origin = new URL(url).origin;
  // A bare site address, or a page that advertises no feed: probe the
  // conventional locations before falling back to the WordPress API.
  // A specific feed URL that failed (404, bad XML) is not probed — the
  // user asked for that address, so its error is the answer.
  const bare = new URL(url).pathname.replace(/\/$/, "") === "";
  const noLink = /No feed link found/.test(directError?.message || "");
  if (bare || noLink) {
    // Probe the conventional locations in parallel: the first one in
    // list order that returns a feed wins, so a slow 404 on /feed does
    // not hold up the rest.
    const attempts = await Promise.allSettled(FEED_PATHS.map(async p => {
      const found = await discover(origin + p);
      return { parsed: parseFeed(found.text, found.url), via: "feed", url: found.url, wpRoot: "" };
    }));
    for (const a of attempts) {
      if (a.status === "fulfilled") return a.value;
    }
  }
  // Fallbacks, in an order that never substitutes a different feed
  // for the one asked for. WordPress always returns the site's main
  // posts feed, and the proxy fetches the exact address typed.
  // A specific feed address names one feed, so the exact fetch goes
  // first there (#163): with WordPress first, a slow or blocked
  // Image of the Day feed was replaced by the main feed and then
  // refused as its duplicate. For a bare site the main feed IS the
  // answer, so WordPress goes first there.
  const tryWP = async () => {
    try {
      const parsed = await loadWordPressFeed(origin);
      // The feed URL is the site's canonical /feed/, not the typed
      // address: the API returns the same main-posts feed, and using
      // /feed/ lets the duplicate check catch an already-subscribed
      // main feed added by its feed URL (#160). Refresh loads through
      // wpRoot, not this URL.
      if (parsed.items.length) return { parsed, via: "wp", url: origin + "/feed/", wpRoot: origin };
    } catch {}
    return null;
  };
  const tryProxy = async () => {
    try {
      const parsed = await loadViaProxy(url);
      return { parsed, via: "proxy", url, wpRoot: "" };
    } catch {}
    return null;
  };
  // AllOrigins fetches the exact address (#181), so it goes before
  // WordPress for a specific feed URL (WordPress returns the site's
  // main feed, which is a different feed). For a bare site the main
  // feed IS the answer, so it stays last there.
  const tryAllOrigins = async () => {
    try {
      const parsed = await loadViaAllOrigins(url);
      return { parsed, via: "allorigins", url, wpRoot: "" };
    } catch {}
    return null;
  };
  const loaded = (!bare && !noLink ? (await tryProxy()) || (await tryAllOrigins()) || (await tryWP()) : (await tryWP()) || (await tryProxy()) || (await tryAllOrigins()));
  if (loaded) return loaded;
  throw directError || Error("Could not load this feed.");
}


/* ---------- unified feed discovery ---------- */
const DISCOVERY_PROVIDERS = [
  {
    name: "Apple Podcasts",
    search: async (q, signal) => {
      const params = new URLSearchParams({
        term: q, media: "podcast", entity: "podcast", country: "us", limit: "50"
      });
      const data = await discoveryJSON("https://itunes.apple.com/search?" + params, signal);
      return (Array.isArray(data.results) ? data.results : [])
        .map(x => discoveryNormalize(x, "Apple Podcasts"))
        .filter(Boolean);
    }
  },
  {
    name: "RSS.mobi",
    search: async (q, signal) => {
      const params = new URLSearchParams({ q, limit: "100" });
      const data = await discoveryJSON("https://rss.mobi/api/v1/feeds?" + params, signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "RSS.mobi")).filter(Boolean);
    }
  },
  {
    name: "RSSAmp",
    search: async (q, signal) => {
      const data = await discoveryJSON("https://rssamp.com/api/search?q=" + encodeURIComponent(q), signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "RSSAmp")).filter(Boolean);
    }
  },
  {
    name: "Feedsearch",
    search: async (q, signal) => {
      if (!/^(https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(q.trim())) return [];
      const data = await discoveryJSON("https://origin.feedsearch.dev/api/v1/search?url=" + encodeURIComponent(q.trim()), signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "Feedsearch")).filter(Boolean);
    }
  }
];
let discoveryTimer = null, discoveryController = null, discoveryRun = 0;
function discoveryText(x) { return String(x ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
async function discoveryJSON(url, signal) {
  const r = await fetch(url, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw Error("HTTP " + r.status);
  return r.json();
}
function discoveryRecords(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== "object") return [];
  for (const k of ["feeds", "results", "blogs", "items", "data"]) if (Array.isArray(d[k])) return d[k];
  const out = [];
  for (const k of ["feed", "blog", "result"]) if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) out.push(d[k]);
  return out;
}
function discoveryNormalize(record, source) {
  if (!record || typeof record !== "object") return null;
  const x = Object.assign({}, record, record.feed && typeof record.feed === "object" ? record.feed : {});
  const raw = x.feedUrl || x.feed_url || x.feedURL || x.xmlUrl || x.xml_url || x.rssUrl || x.rss_url || x.feed || x.url;
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  let url;
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    u.searchParams.sort();
    [...u.searchParams.keys()].forEach(k => { if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k); });
    url = u.href;
  } catch { return null; }
  const siteRaw = x.site || x.siteUrl || x.site_url || x.homepage || x.website || x.link || x.collectionViewUrl || "";
  let site = "";
  try { if (typeof siteRaw === "string" && /^https?:\/\//i.test(siteRaw)) site = new URL(siteRaw).href; } catch {}
  return {
    url, site: site || url,
    title: discoveryText(x.title || x.name || x.collectionName || x.collectionCensoredName || x.feedTitle || x.feed_title || x.blogTitle || x.blog_title || x.label) || host(site || url),
    description: discoveryText(x.description || x.summary || x.subtitle || x.about || ""),
    source
  };
}
function discoveryKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "").toLowerCase() + (u.pathname.replace(/\/+$/, "") || "/") + u.search).replace(/:443(?=\/|$)/, "");
  } catch { return String(url).toLowerCase(); }
}
function mergeDiscoveryResults(groups) {
  const map = new Map();
  groups.flat().forEach(x => {
    const key = discoveryKey(x.url), old = map.get(key);
    if (!old) map.set(key, Object.assign({}, x, { sources: [x.source] }));
    else {
      if (!old.description && x.description) old.description = x.description;
      if (old.title === host(old.site || old.url) && x.title.length > old.title.length) old.title = x.title;
      if (!old.sources.includes(x.source)) old.sources.push(x.source);
    }
  });
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}
/* Podcast hosts, used to tell a podcast result from an article result
   when the result came from a general RSS catalog rather than the
   Apple Podcasts directory. */
const PODCAST_HOSTS = ["libsyn.com", "blubrry.com", "podbean.com", "anchor.fm", "spreaker.com", "transistor.fm", "buzzsprout.com", "simplecast.com", "megaphone.fm", "rss.com", "podomatic.com", "audioboom.com"];
function isPodcastResult(x) {
  if ((x.sources || []).includes("Apple Podcasts")) return true;
  const h = host(x.url);
  return PODCAST_HOSTS.some(p => h === p || h.endsWith("." + p));
}
/* Which kind of search result to show: "all", "podcasts", or "articles".
   Reset to "all" on each new search. */
let discoveryFilter = "all";
function renderDiscoveryResults(items) {
  const root = $("#feedSearchResults");
  if (!items.length) {
    root.innerHTML = '<p class="muted discovery-empty">No matching feeds found. Try a different name, topic, or website address.</p>';
    return;
  }
  const row = (x, i) => {
    const added = state.feeds.some(f => sameFeedUrl(f.url, x.url));
    return '<article class="discovery-result"><div class="discovery-result-main"><strong>' + esc(x.title) +
      '</strong><span>' + esc(host(x.site || x.url)) + '</span>' +
      (x.description ? '<p>' + esc(x.description) + '</p>' : '') +
      '<small>' + esc(x.sources.join(" · ")) + '</small></div>' +
      '<button type="button" class="primary discovery-add" data-discovery-add="' + i + '"' +
      (added ? ' disabled' : '') + '>' + (added ? 'Added' : 'Add') + '</button></article>';
  };
  // Split the results into Podcasts and Articles so the user can pick
  // one or both. The original index is kept, because the Add button
  // looks the result up by its place in feedDiscoveryResults.
  const podcasts = [], articles = [];
  items.forEach((x, i) => (isPodcastResult(x) ? podcasts : articles).push([x, i]));
  const btn = (key, label, n) => '<button type="button" class="discovery-filter-btn' + (discoveryFilter === key ? ' active' : '') + '" data-discovery-filter="' + key + '"' + (n ? '' : ' disabled') + '>' + label + ' (' + n + ')</button>';
  const bar = '<div class="discovery-filter" role="group" aria-label="Show podcasts, articles, or both">' + btn("all", "All", items.length) + btn("podcasts", "Podcasts", podcasts.length) + btn("articles", "Articles", articles.length) + '</div>';
  const sec = (label, list) => list.length ? '<h3 class="discovery-section">' + label + '</h3>' + list.map(([x, i]) => row(x, i)).join("") : "";
  root.innerHTML = bar +
    (discoveryFilter === "articles" ? sec("Articles", articles) :
     discoveryFilter === "podcasts" ? sec("Podcasts", podcasts) :
     sec("Podcasts", podcasts) + sec("Articles", articles));
}
async function runDiscoveryProvider(provider, query, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    return await provider.search(query, controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}
async function searchFeeds(raw) {
  const q = String(raw || "").trim(), status = $("#feedSearchStatus"), root = $("#feedSearchResults");
  if (q.length < 2) { status.textContent = "Enter at least two characters."; root.innerHTML = ""; return; }
  if (discoveryController) discoveryController.abort();
  const controller = new AbortController();
  discoveryController = controller;
  const run = ++discoveryRun;
  const timeout = setTimeout(() => controller.abort(), 10000);
  status.textContent = "Searching feed directories…";
  root.innerHTML = "";
  try {
    const settled = await Promise.allSettled(DISCOVERY_PROVIDERS.map(p => runDiscoveryProvider(p, q, controller.signal)));
    if (run !== discoveryRun) return;
    const groups = settled.map(r => r.status === "fulfilled" ? r.value : []);
    const items = mergeDiscoveryResults(groups);
    window.feedDiscoveryResults = items;
    discoveryFilter = "all";
    const failed = settled.filter(r => r.status === "rejected").length;
    const podCount = items.filter(isPodcastResult).length;
    const artCount = items.length - podCount;
    status.textContent = items.length + " unique feed" + (items.length === 1 ? "" : "s") + " found" +
      (items.length ? " (" + podCount + " podcast" + (podCount === 1 ? "" : "s") + ", " + artCount + " article" + (artCount === 1 ? "" : "s") + ")" : "") +
      " across " + (settled.length - failed) + " source" + (settled.length - failed === 1 ? "" : "s") +
      (failed ? " · " + failed + " source" + (failed === 1 ? "" : "s") + " unavailable" : "");
    renderDiscoveryResults(items);
  } finally { clearTimeout(timeout); }
}
/* One box for adding a feed (#157): an address (feed URL or bare
   website) goes the direct-add path; anything else is a directory
   search. Same address test Feedsearch uses for URL queries. */
function looksLikeAddress(q) {
  return /^(https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(q.trim());
}
function scheduleFeedSearch() {
  discoveryRun++;
  clearTimeout(discoveryTimer);
  const q = $("#feedSearchInput").value;
  $("#feedError").textContent = "";
  if (q.trim().length < 2) {
    if (discoveryController) discoveryController.abort();
    $("#feedSearchStatus").textContent = "Type an address to add it, or a name or topic to search.";
    $("#feedSearchResults").innerHTML = "";
    return;
  }
  if (looksLikeAddress(q)) {
    if (discoveryController) discoveryController.abort();
    $("#feedSearchStatus").textContent = "Press Enter or Add feed to add this address.";
    $("#feedSearchResults").innerHTML = "";
    return;
  }
  $("#feedSearchStatus").textContent = "Searching feed directories…";
  $("#feedSearchResults").innerHTML = "";
  discoveryTimer = setTimeout(() => searchFeeds(q), 700);
}
async function addDiscoveredFeed(index) {
  const x = window.feedDiscoveryResults && window.feedDiscoveryResults[index];
  if (!x) return;
  const b = $('[data-discovery-add="' + index + '"]');
  if (b) { b.disabled = true; b.textContent = "Adding…"; }
  try {
    await addFeed(x.url);
    if (b) b.textContent = "Added";
    $("#feedSearchStatus").textContent = "Added " + x.title + ".";
  } catch (e) {
    if (b) { b.disabled = false; b.textContent = "Add"; }
    $("#feedError").textContent = classifyError(e);
  }
}

async function addFeed(raw) {
  const url = normalizeFeedUrl(raw);
  if (state.feeds.some(f => sameFeedUrl(f.url, url))) throw Error("You already subscribe to this feed.");
  const loaded = await loadFeedFromUrl(url);
  // The check above only sees the address typed in. The same feed can
  // be reached another way (the bare site vs its /feed, or a probed
  // /rss), so check the resolved feed URL too. Title + site is NOT
  // checked on the feed path: one publisher can run several feeds
  // under one title (NASA titles both its main feed and its Image of
  // the Day feed "NASA", #159), and a different address is a different
  // feed. The WordPress and proxy paths are the exceptions
  // (#160, #163): the API only ever serves the site's main posts
  // feed, and the proxy echoes the requested address as the feed
  // URL, so neither loaded URL carries a feed identity of its own.
  // Same site + same title is the same feed on those paths,
  // whichever load path produced it (direct fetch, probe, or fallback).
  const originKey = s => { try { const u = new URL(s); return u.hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
  const loadedOrigin = originKey(loaded.wpRoot || loaded.parsed.site || "");
  const dup = state.feeds.find(f =>
    sameFeedUrl(f.url, loaded.url) ||
    ((loaded.via === "wp" || loaded.via === "proxy" || loaded.via === "allorigins") && loadedOrigin && originKey(f.wpRoot || f.site) === loadedOrigin &&
      (f.title || "").trim().toLowerCase() === (loaded.parsed.title || "").trim().toLowerCase()));
  if (dup) throw Error(`You already subscribe to this feed (“${dup.title}”).`);
  const feed = {
    id: id(), url: loaded.url, title: loaded.parsed.title, site: loaded.parsed.site,
    added: new Date().toISOString(), error: "", via: loaded.via, wpRoot: loaded.wpRoot || "", group: "", lastAttempt: Date.now(), lastSuccess: Date.now(), retrievalPath: loaded.via, consecutiveFailures: 0
  };
  state.feeds.push(feed);
  saveFeeds();
  try {
    await saveItems(feed, loaded.parsed.items);
  } catch (e) {
    // The subscription itself is saved; a storage failure must not leave
    // an invisible feed that blocks re-adding. Show it with its error.
    feed.error = classifyError(e);
    saveFeeds();
    render();
    toast("Feed added, but its articles failed to save. Refresh to retry.");
    return;
  }
  // Rules can tag a newly added feed's articles; sync the tag list so
  // those tags appear in the sidebar immediately, not at the next refresh.
  syncTags(); saveTags();
  // Make the add unmissable (#137): open the new feed's view, flash
  // its row in the sidebar, and name it in the confirmation.
  state.view = "feed"; state.feed = feed.id; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  render();
  const row = document.querySelector(`[data-feed="${CSS.escape(feed.id)}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    row.classList.add("just-added");
    setTimeout(() => row.classList.remove("just-added"), 2300);
  }
  const n = loaded.parsed.items.length;
  toast(`“${feed.title}” added — ${n} article${n === 1 ? "" : "s"}.`);
}

/* Rules (#109): run on newly fetched articles at refresh time. A rule
   matches when its scope (all feeds, one folder, or one feed) matches
   and every condition it sets (title keyword, author) matches. The
   actions add a tag, save the article, or mark it read. Rules never
   delete anything, and they only run on new arrivals, never on articles
   the user already has (so a rule cannot re-tag something the user
   untagged, and a rule that marks read cannot hide an article the user
   already read and then unread). */
function applyRules(feed, item) {
  for (const rule of state.rules) {
    if (!ruleMatches(rule, feed, item)) continue;
    if (rule.tag) {
      const t = rule.tag.trim();
      if (t && !(item.tags || []).includes(t)) (item.tags ||= []).push(t);
    }
    if (rule.save) item.saved = true;
    if (rule.markRead) item.read = true;
  }
}
async function saveItems(feed, items) {
  const seen = new Set();
  // Map lookups instead of a linear scan per item, and one batched
  // write instead of a transaction per item. The maps are scoped to
  // this feed's items: the key carries the feed id, so no other feed's
  // items can match.
  const mine = state.items.filter(i => i.feedId === feed.id);
  const byId = new Map(mine.map(i => [i.id, i]));
  const byUrl = new Map();
  for (const i of mine) if (!byUrl.has(i.feedId + "|" + i.url)) byUrl.set(i.feedId + "|" + i.url, i);
  const fresh = [];
  for (const x of items) {
    const link = x.url || feed.url;
    const key = feed.id + "|" + (x.guid || link);
    seen.add(key);
    const old = byId.get(key) || byUrl.get(feed.id + "|" + link);
    const d = date(x.date);
    const content = x.content || "";
    let summary = cleanSummary(x.summary || "");
    // When the feed carries no separate description, the summary IS
    // the full content; storing both duplicates the whole article in
    // IndexedDB. Keep a short plaintext snippet for the card preview
    // instead.
    if (summary && summary === cleanSummary(content)) summary = snippet(plainText(summary), 210);
    const freshItem = {
      id: key, feedId: feed.id, feedTitle: feed.title,
      title: x.title, url: link, guid: x.guid || "",
      // The canonical URL is computed once here, at save time, so the
      // duplicate check on every render does not re-parse every URL.
      canonical: old?.canonical || canonicalUrl(link),
      summary, content,
      fullContent: old?.fullContent || "",
      fullContentIncluded: !!x.fullContentIncluded,
      author: x.author || "",
      published: d ? d.toISOString() : null,
      image: x.image || old?.image || "",
      enclosure: x.enclosure || old?.enclosure || null,
      read: old?.read || false, readAt: old?.readAt || null, saved: old?.saved || false, queued: old?.queued || false, queueOrder: old?.queueOrder || 0,
      snoozedUntil: old?.snoozedUntil || null,
      tags: old?.tags || []
    };
    // Rules (#109) run on new arrivals only.
    if (!old) applyRules(feed, freshItem);
    fresh.push(freshItem);
  }
  await putMany(fresh);
  // Mirror the writes in memory instead of re-reading the whole table
  // from IndexedDB (the old code did two full getAlls per feed), and
  // drop the cached search text: the articles' bodies may have changed.
  const byIdAll = new Map(state.items.map(i => [i.id, i]));
  for (const x of fresh) byIdAll.set(x.id, x);
  state.items = [...byIdAll.values()];
  searchTextCache.clear();
  // Prune items no longer in the feed, unless the user saved them, read them,
  // or snoozed them (a snoozed article must survive until it comes back).
  // Cap each feed at MAX_ITEMS_PER_FEED newest items.
  const mineNow = state.items.filter(i => i.feedId === feed.id);
  const pruneIds = mineNow.filter(old => !seen.has(old.id) && !old.saved && !old.read && !(old.snoozedUntil && old.snoozedUntil > Date.now())).map(o => o.id);
  if (pruneIds.length) {
    await deleteMany(pruneIds);
    const ps = new Set(pruneIds);
    state.items = state.items.filter(i => !ps.has(i.id));
  }
  const freshMine = state.items.filter(i => i.feedId === feed.id)
    .sort((a, b) => (dateSortKey(b) ?? -1) - (dateSortKey(a) ?? -1));
  const extraIds = freshMine.slice(MAX_ITEMS_PER_FEED).filter(x => !x.saved).map(x => x.id);
  if (extraIds.length) {
    await deleteMany(extraIds);
    const es = new Set(extraIds);
    state.items = state.items.filter(i => !es.has(i.id));
  }
}

async function refreshFeed(f) {
  if (f.refreshing) return false;
  f.refreshing = true;
  f.lastAttempt = Date.now();
  try {
    let loaded;
    if (f.via === "wp" && f.wpRoot) {
      loaded = { parsed: await loadWordPressFeed(f.wpRoot, f.title), via: "wp", url: f.url, wpRoot: f.wpRoot };
    } else if (f.via === "proxy" || f.via === "allorigins") {
      // A helper-fed feed tries both helpers on refresh (#181): the
      // one that loaded it last time first, then the other, so a
      // rate-limited or failing helper no longer stops the feed.
      const viaHelpers = await loadViaHelpers(f.url, f.via === "allorigins");
      loaded = { parsed: viaHelpers.parsed, via: viaHelpers.via, url: f.url, wpRoot: "" };
    } else {
      loaded = await loadFeedFromUrl(f.url);
    }
    f.title = loaded.parsed.title || f.title;
    f.error = "";
    f.consecutiveFailures = 0; f.nextRetryAt = 0; f.retrievalPath = loaded.via;
    f.via = loaded.via;
    f.wpRoot = loaded.wpRoot || f.wpRoot || "";
    if (loaded.url) f.url = loaded.url;
    await saveItems(f, loaded.parsed.items);
    f.lastSuccess = Date.now();
    return true;
  } catch (e) {
    f.error = e?.name === "QuotaExceededError" ? "Browser storage is full. Use Settings > Storage management to remove older articles, then retry." : classifyError(e); f.lastError = f.error; f.lastErrorAt = Date.now();
    f.consecutiveFailures = (Number(f.consecutiveFailures) || 0) + 1;
    const backoff = Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.min(8, f.consecutiveFailures - 1)));
    f.nextRetryAt = Date.now() + backoff;
    return false;
  } finally {
    f.refreshing = false;
  }
}
/* A failed feed shows its full error with Retry and Unsubscribe (#162). */
function showFeedError(id) {
  const f = state.feeds.find(v => v.id === id);
  if (!f) return;
  $("#feedErrorText").textContent = [f.error || "This feed failed to load.", f.lastAttempt ? "Last attempt: " + new Date(f.lastAttempt).toLocaleString() : "", f.lastSuccess ? "Last success: " + new Date(f.lastSuccess).toLocaleString() : "No successful refresh recorded", "Consecutive failures: " + (Number(f.consecutiveFailures) || 0), f.retrievalPath ? "Retrieval path: " + f.retrievalPath : "", f.lastError ? "Most recent error: " + f.lastError + (f.lastErrorAt ? " (" + new Date(f.lastErrorAt).toLocaleString() + ")" : "") : ""].filter(Boolean).join("\n");
  $("#feedErrorDialog").dataset.feed = id;
  $("#feedErrorDialog").showModal();
}
async function refresh(automatic = false) {
  if (!state.feeds.length) { toast("Add a feed first."); return; }
  const now = Date.now();
  if (now - refreshAt < 2000) return; // debounce repeated refreshes (incl. holding "r")
  refreshAt = now;
  const btn = $("#refresh");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    // Refresh feeds through a small worker pool (#181) instead of
    // firing them all at once: a ~100-feed profile used to send ~100
    // concurrent requests, and the burst is what gets the shared
    // helper (rss2json) rate-limited by publishers. Five at a time
    // is far gentler and still fast enough.
    const eligibleFeeds = state.feeds.filter(f => !automatic || ((!f.nextRetryAt || Date.now() >= f.nextRetryAt) && Date.now() - (f.lastAttempt || 0) >= (Number(f.refreshMinutes) || Number(state.settings.globalRefreshMinutes) || 30) * 60000));
    if (!eligibleFeeds.length) { if (!automatic) toast("All feeds are within their refresh interval."); return; }
    const results = new Array(eligibleFeeds.length);
    let next = 0;
    const REFRESH_CONCURRENCY = 5;
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, eligibleFeeds.length) }, async () => {
      while (next < eligibleFeeds.length) {
        const i = next++;
        results[i] = await refreshFeed(eligibleFeeds[i]);
      }
    }));
    const ok = results.filter(Boolean).length;
    const failed = eligibleFeeds.filter((f, i) => !results[i]).map(f => f.title);
    saveFeeds();
    // Rules (#109) can add tags to new articles; keep the tag list
    // current after a refresh.
    syncTags();
    saveTags();
    state.lastRefresh = Date.now();
    try { localStorage.setItem(LR, String(state.lastRefresh)); } catch {}
    render();
    toast(ok === eligibleFeeds.length
      ? `Refreshed ${ok} of ${eligibleFeeds.length} feeds.`
      : `Refreshed ${ok} of ${eligibleFeeds.length} feeds. Failed: ${failed.join(", ")}.`);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/* ---------- list / render ---------- */
/* A snoozed article is hidden from every list until its time comes, and
   only the Snoozed view shows it. Expired snoozes reappear on their own,
   because this is a time comparison, not a flag that needs clearing. */
const isSnoozed = x => x.snoozedUntil && x.snoozedUntil > Date.now();
/* A muted feed (#117) still exists in the sidebar, but its articles
   stay out of the cross-feed lists until it is unmuted. */
const isMutedFeed = feedId => state.feeds.find(f => f.id === feedId)?.muted;
/* Full-text article match (#107, reused by saved searches #108): the
   short fields first, then the body the reader would show (loaded
   full text, then the feed content), stripped of markup. The combined
   lowercase text is cached per item and reused across keystrokes,
   instead of re-stripping and re-lowercasing the whole body per item
   per keystroke. Cleared when the library is reloaded. */
const searchTextCache = new Map();
function searchText(x) {
  let t = searchTextCache.get(x.id);
  if (t === undefined) {
    t = [x.title, x.summary, x.author, x.feedTitle, (x.tags || []).join(" ")].join(" ").toLowerCase()
      + "\n" + plainText(x.fullContent || x.content || "").toLowerCase();
    searchTextCache.set(x.id, t);
  }
  return t;
}
function matchesQuery(x, q) {
  q = String(q || "").toLowerCase();
  if (!q) return true;
  return searchText(x).includes(q);
}
/* Does an article match a saved search (#108)? The feed group comes
   from a lookup map when the caller has one (visible builds it once),
   otherwise from the feed list. */
function savedSearchMatches(s, x, feedById) {
  if (!s) return false;
  if (s.scope?.startsWith("feed:")) { if (x.feedId !== s.scope.slice(5)) return false; }
  else if (s.scope?.startsWith("folder:")) {
    const g = feedById ? (feedById.get(x.feedId)?.group || "") : (state.feeds.find(f => f.id === x.feedId)?.group || "");
    if (g !== s.scope.slice(7)) return false;
  }
  if (s.tag && !(x.tags || []).includes(s.tag)) return false;
  if (s.unreadOnly && x.read) return false;
  return matchesQuery(x, s.query);
}
function visible() {
  // A folder view (#118) and a saved search (#108) need each article's
  // feed group; build the lookup once instead of scanning per article.
  const feedById = (state.view === "folder" || state.view === "savedSearch") ? new Map(state.feeds.map(f => [f.id, f])) : null;
  // The muted feeds, as a set: checking each article against it is
  // O(1), where the old per-item feed lookup was O(feeds). The saved
  // search is looked up once, not once per article.
  const mutedIds = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  const savedSearch = state.view === "savedSearch" ? state.savedSearches.find(v => v.id === state.savedSearch) : null;
  let a = state.items.filter(x => {
    if (state.view === "snoozed") return isSnoozed(x);
    if (state.view === "queue") return !!x.queued;
    if (isSnoozed(x)) return false;
    if (state.view === "unread") return !x.read && !mutedIds.has(x.feedId);
    if (state.view === "saved") return x.saved;
    // The Highlights view (#116) lists the highlights themselves, not
    // articles, so renderList renders it separately; visible returns
    // the highlighted articles for the counts and keyboard navigation.
    if (state.view === "highlights") return state.highlights.some(h => h.itemId === x.id);
    if (state.view === "feed") return x.feedId === state.feed;
    if (mutedIds.has(x.feedId)) return false;
    // A folder view (#118) is a cross-feed list, like All and Unread:
    // muted feeds and snoozed articles stay out, duplicates collapse.
    if (state.view === "folder") return (feedById.get(x.feedId)?.group || "") === state.folder;
    if (state.view === "tag") return (x.tags || []).includes(state.tag);
    // A saved search (#108) is a stored filter: keywords, a feed or
    // folder scope, a tag, and unread-only, run over the library.
    if (state.view === "savedSearch") {
      return savedSearchMatches(savedSearch, x, feedById);
    }
    return true;
  });
  if (state.filter === "today") {
    const today = new Date().toDateString();
    a = a.filter(x => { const d = date(x.published); return d && d.toDateString() === today; });
  }
  if (state.filter === "week") {
    a = a.filter(x => { const d = date(x.published); return d && (Date.now() - d.getTime() < 7 * 864e5); });
  }
  if (state.query) {
    a = a.filter(x => matchesQuery(x, state.query));
  }
  const newest = effectiveSort() === "newest";
  // Precompute the date keys once: the old comparator re-parsed each
  // article's date O(log N) times during the sort.
  if (state.view === "queue") return a.sort((x,y)=>(x.queueOrder||0)-(y.queueOrder||0));
  const keyed = a.map(x => [dateSortKey(x), x]);
  keyed.sort((p, q) => {
    const dx = p[0], dy = q[0];
    if (dx === null && dy === null) return 0;
    if (dx === null) return 1; // dateless items always last
    if (dy === null) return -1;
    return (dy - dx) * (newest ? 1 : -1);
  });
  a = keyed.map(p => p[1]);
  // Duplicates are collapsed in the cross-feed lists only (#115): a
  // feed's own view shows its articles as they are, saved articles
  // are keepers, and snoozed articles are already one-per-time.
  if (state.settings.hideDuplicates !== false && !["feed", "saved", "snoozed"].includes(state.view)) a = dedupeItems(a);
  return a;
}
/* What the All/Unread lists actually show, for the sidebar counts:
   no muted feeds, no snoozed articles, duplicates collapsed. */
function countableItems() {
  const mutedIds = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  let a = state.items.filter(x => !isSnoozed(x) && !mutedIds.has(x.feedId));
  if (state.settings.hideDuplicates !== false) a = dedupeItems(a);
  return a;
}
/* Collapsed feed folders (#175), persisted in localStorage so the
   sidebar keeps its shape across reloads. */
const COLLAPSED_FOLDERS_KEY = "rss-reader.collapsed-folders.v1";
let collapsedFolders = new Set();
try { collapsedFolders = new Set(JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || "[]")); } catch { collapsedFolders = new Set(); }
function saveCollapsedFolders() { try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...collapsedFolders])); } catch {} }

/* Counts in the sidebar cap at 999+, like Inoreader and Orpington (#177). */
function fmtCount(n) { return n > 999 ? "999+" : String(n); }

function renderNav() {
  updateActivityIndicator();
  const shown = countableItems();
  $("#allCount").textContent = fmtCount(shown.length);
  $("#unreadCount").textContent = fmtCount(shown.filter(x => !x.read).length);
  $("#savedCount").textContent = fmtCount(state.items.filter(x => x.saved && !isSnoozed(x)).length);
  $("#snoozedCount").textContent = fmtCount(state.items.filter(isSnoozed).length);
  $("#highlightsCount").textContent = fmtCount(state.highlights.length);
  const queueCount = $("#queueCount"); if (queueCount) queueCount.textContent = fmtCount(state.items.filter(x => x.queued).length);
  const moreCount = $("#libraryMoreCount"); if (moreCount) moreCount.textContent = fmtCount(state.items.filter(x => x.saved || isSnoozed(x)).length + state.highlights.length);
  $("#libraryMore")?.querySelector("summary")?.classList.toggle("active", ["saved","snoozed","highlights"].includes(state.view));
  $$(".nav").forEach(b => {
    b.classList.toggle("active", b.dataset.view === state.view && state.view !== "feed");
    if (b.dataset.view === state.view && state.view !== "feed") b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  const groups = {};
  for (const f of state.feeds) (groups[f.group || ""] ||= []).push(f);
  const groupNames = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  // The collapse/expand-all toggle at the YOUR FEEDS heading (#187):
  // hidden with no named folders; otherwise it offers the opposite of
  // the current state (collapse all unless every folder is collapsed).
  const allBtn = $("#toggleAllFolders");
  if (allBtn) {
    const named = groupNames.filter(g => g);
    const allCollapsed = allFoldersCollapsed(named, collapsedFolders);
    allBtn.hidden = named.length === 0;
    allBtn.textContent = allCollapsed ? "Expand all" : "Collapse all";
    const label = allCollapsed ? "Expand all folders" : "Collapse all folders";
    allBtn.setAttribute("aria-label", label);
    allBtn.title = label;
  }
  // Unread counts, aggregated in one pass over the articles instead of
  // a full scan per feed (and per folder) on every render.
  const unreadByFeed = new Map();
  for (const x of state.items) {
    if (!x.read && !isSnoozed(x)) unreadByFeed.set(x.feedId, (unreadByFeed.get(x.feedId) || 0) + 1);
  }
  $("#feeds").innerHTML = state.feeds.length ? groupNames.map(g => {
    // Ungrouped feeds render last, after the folders; label them so they
    // are not misread as belonging to the folder above them.
    // A folder name is a button (#118): it opens the folder's feeds as
    // one merged list, with its unread count beside it.
    const folderUnread = g ? groups[g].reduce((n, f) => n + (unreadByFeed.get(f.id) || 0), 0) : 0;
    // A folder's chevron collapses its feeds (#175); the name still
    // opens the folder's merged list, as before.
    const collapsed = g ? collapsedFolders.has(g) : false;
    const label = g ? `<div class="folder-head" data-drop-folder="${esc(g)}"><button type="button" class="folder-toggle" data-folder-toggle="${esc(g)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? "Expand" : "Collapse"} folder ${esc(g)}"><span class="folder-chevron" aria-hidden="true">▾</span></button><button type="button" class="feed-group folder-open${state.view === "folder" && state.folder === g ? " active" : ""}" data-folder="${esc(g)}" ${state.view === "folder" && state.folder === g ? 'aria-current="true"' : ""}>${esc(g)}${folderUnread ? `<span>${fmtCount(folderUnread)}</span>` : ""}</button></div>` : (groupNames.length > 1 ? `<div class="feed-group" data-drop-folder="">Ungrouped</div>` : "");
    const rows = groups[g].map(f => {
      const unreadCount = unreadByFeed.get(f.id) || 0;
      const staleAfter = (Number(f.refreshMinutes) || Number(state.settings.globalRefreshMinutes) || 30) * 3 * 60000;
      const health = f.error ? " feed-error" : f.lastSuccess && Date.now() - f.lastSuccess > staleAfter ? " feed-stale" : "";
      const err = f.error ? " feed-error" : "";
      const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id;
      // The site's own favicon marks the row; if it fails to load the
      // dot comes back (the img hides itself and unhides the dot).
      let fav = "";
      try { fav = new URL(f.site || f.url).origin + "/favicon.ico"; } catch {}
      const mark = fav
        ? `<img class="feed-favicon" src="${esc(fav)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="feed-dot" style="display:none"></span>`
        : `<span class="feed-dot"></span>`;
      const displayTitle = feedDisplayTitle(f);
      const countBtn = unreadCount ? `<button type="button" class="feed-count" data-mark-read="${esc(f.id)}" title="Mark ${esc(displayTitle)} read" aria-label="Mark ${esc(displayTitle)} read">${fmtCount(unreadCount)}</button>` : "";
      const muteBtn = `<button type="button" class="feed-mute${f.muted ? " on" : ""}" data-mute="${esc(f.id)}" title="${f.muted ? "Unmute" : "Mute"} ${esc(displayTitle)}" aria-label="${f.muted ? "Unmute" : "Mute"} ${esc(displayTitle)}" aria-pressed="${!!f.muted}">${f.muted ? "Muted" : "Mute"}</button>`;
      const optsBtn = `<button type="button" class="feed-opts" data-feed-opts="${esc(f.id)}" title="Options for ${esc(displayTitle)}" aria-label="Options for ${esc(displayTitle)}" aria-haspopup="true" aria-expanded="false">···</button>`;
      return `<div class="feed-row-wrap${g ? " nested-feed" : ""}"><button class="feed-row${state.feed === f.id ? " active" : ""}${f.muted ? " muted" : ""}${health}" draggable="true" title="${esc(displayTitle + (f.lastSuccess ? " · Last successful refresh: " + new Date(f.lastSuccess).toLocaleString() : ""))}" data-feed="${esc(f.id)}" ${state.feed === f.id ? 'aria-current="true"' : ""}>${mark}<span class="feed-name">${esc(displayTitle)}</span></button>${f.error ? `<button type="button" class="feed-err" data-feed-err="${esc(f.id)}" title="This feed failed to load — click for details" aria-label="Feed error: ${esc(displayTitle)}">!</button>` : ""}${countBtn}${muteBtn}${optsBtn}<button type="button" class="feed-unsub${armed ? " armed" : ""}" data-unsub="${esc(f.id)}" title="${armed ? "Click again to unsubscribe" : `Unsubscribe from ${esc(displayTitle)}`}" aria-label="${armed ? `Click again to unsubscribe from ${esc(displayTitle)}` : `Unsubscribe from ${esc(displayTitle)}`}">${armed ? "Sure?" : "×"}</button></div>`;
    }).join("");
    return label + (g ? `<div class="folder-feeds" data-drop-folder="${esc(g)}"${collapsed ? " hidden" : ""}>${rows}</div>` : rows);
  }).join("") : '<p class="muted">Your feeds will appear here.</p>';
  const tagCounts = {};
  for (const x of state.items) for (const t of x.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  $("#tags").innerHTML = state.tags.length ? state.tags.map(t =>
    `<button class="nav tag-row${state.view === "tag" && state.tag === t ? " active" : ""}" data-tag="${esc(t)}" ${state.view === "tag" && state.tag === t ? 'aria-current="true"' : ""}>${icon("tag")} ${esc(t)}<span>${fmtCount(tagCounts[t] || 0)}</span></button>`
  ).join("") : "";
  // Empty sections do not render at all (#177): no heading, no
  // placeholder prose. They appear the moment they have content.
  $("#tagsHead").hidden = !state.tags.length;
  $("#tags").hidden = !state.tags.length;
  // Saved searches (#108): a stored filter as a sidebar view, with its
  // matching count. The feed map is built once for all searches.
  const ssFeedById = new Map(state.feeds.map(f => [f.id, f]));
  const ssMuted = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  $("#savedSearches").innerHTML = state.savedSearches.length ? state.savedSearches.map(s => {
    const n = state.items.filter(x => !isSnoozed(x) && !ssMuted.has(x.feedId) && savedSearchMatches(s, x, ssFeedById)).length;
    const active = state.view === "savedSearch" && state.savedSearch === s.id;
    return `<button class="nav tag-row${active ? " active" : ""}" data-saved-search="${esc(s.id)}" ${active ? 'aria-current="true"' : ""}>${icon("search")} ${esc(s.name)}<span>${fmtCount(n)}</span></button>`;
  }).join("") : "";
  $("#savedSearchesHead").hidden = !state.savedSearches.length;
  $("#savedSearches").hidden = !state.savedSearches.length;
}
/* Sidebar drag and drop (#182): reorder feeds and move them between
   folders. The feed rows are draggable; dropping on a row reorders
   (joining that row's folder), dropping on a folder head or container
   moves the feed to the end of that folder, and dropping on Ungrouped
   moves it out. Delegated on #feeds, which outlives renderNav's
   innerHTML. The Folders & tags dialog's per-feed folder select stays
   as the touch and keyboard path: HTML5 drag does not work on touch. */
let draggedFeedId = null, dropTarget = null;
function clearDropIndicators() {
  $$("#feeds .drop-before, #feeds .drop-after, #feeds .drop-target").forEach(el => el.classList.remove("drop-before", "drop-after", "drop-target"));
  dropTarget = null;
}
/* The drop target under the pointer (#182): a feed row (reorder,
   joining that row's folder) or a folder head/container (append to
   that folder; "" is Ungrouped). Computed from the event, so the drop
   does not depend on the target stored during dragover. */
function dropTargetAt(e) {
  const wrap = e.target.closest(".feed-row-wrap");
  if (wrap) {
    const row = wrap.querySelector(".feed-row");
    if (row && row.dataset.feed !== draggedFeedId) {
      const r = wrap.getBoundingClientRect();
      return { kind: "row", feedId: row.dataset.feed, before: e.clientY < r.top + r.height / 2 };
    }
    return null;
  }
  const folder = e.target.closest("[data-drop-folder]");
  if (folder) return { kind: "folder", group: folder.dataset.dropFolder || "" };
  return null;
}
function setupFeedDrag() {
  const nav = $("#feeds");
  nav.addEventListener("dragstart", e => {
    const row = e.target.closest(".feed-row");
    if (!row) return;
    draggedFeedId = row.dataset.feed;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedFeedId);
    row.closest(".feed-row-wrap")?.classList.add("dragging");
  });
  nav.addEventListener("dragover", e => {
    if (!draggedFeedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropIndicators();
    const target = dropTargetAt(e);
    if (!target) return;
    dropTarget = target;
    if (target.kind === "row") {
      e.target.closest(".feed-row-wrap").classList.add(target.before ? "drop-before" : "drop-after");
    } else {
      e.target.closest("[data-drop-folder]").classList.add("drop-target");
    }
  });
  // dragleave fires with a null relatedTarget as the drag ends, right
  // before drop — clearing the stored target there ate the drop, so
  // only clear when the drag really moves to another element outside
  // the sidebar.
  nav.addEventListener("dragleave", e => {
    if (e.relatedTarget && !nav.contains(e.relatedTarget)) clearDropIndicators();
  });
  // The drop recomputes its target from the release event and reads the
  // dragged id from the drag data, so it does not depend on the stored
  // target or on dragend ordering.
  nav.addEventListener("drop", e => {
    e.preventDefault();
    const id = (e.dataTransfer.getData("text/plain") || draggedFeedId || "").trim();
    const target = dropTargetAt(e) || dropTarget;
    clearDropIndicators();
    if (id && target) moveFeedByDrag(id, target);
  });
  nav.addEventListener("dragend", () => {
    draggedFeedId = null;
    clearDropIndicators();
    $$("#feeds .dragging").forEach(el => el.classList.remove("dragging"));
  });
}
function moveFeedByDrag(draggedId, target) {
  const before = state.feeds.find(f => f.id === draggedId)?.group || "";
  const feed = moveFeedInList(state.feeds, draggedId, target);
  if (!feed) return;
  // Dropping on a collapsed folder expands it, so the feed is visible
  // where it landed.
  if (target.kind === "folder" && target.group && collapsedFolders.has(target.group)) {
    collapsedFolders.delete(target.group);
    saveCollapsedFolders();
  }
  saveFeeds();
  renderNav();
  // Only name a folder change: a reorder inside the same folder
  // (including ungrouped) is just a move, not "out of its folder".
  let where = "";
  if (feed.group && feed.group !== before) where = ` to ${feed.group}`;
  else if (!feed.group && before) where = " out of its folder";
  toast(`Moved “${feed.title}”${where}.`);
}
/* The sort control is a compact arrow in the list header (#175):
   ↓ newest first, ↑ oldest first. */
function renderSortBtn() {
  const b = $("#sort");
  if (!b) return;
  const s = effectiveSort();
  b.textContent = s === "newest" ? "↓" : "↑";
  b.title = s === "newest" ? "Newest first — click for oldest first" : "Oldest first — click for newest first";
}

/* The Highlights view (#116): every highlight, newest first, with the
   article it came from. Clicking one opens the article at the passage. */
function renderHighlightsList() {
  const list = [...state.highlights].sort((a, b) => (b.created || 0) - (a.created || 0));
  renderSortBtn();
  $$(".filter").forEach(x => x.classList.toggle("active", x.dataset.filter === state.filter));
  const upd = state.lastRefresh ? " · Updated " + new Date(state.lastRefresh).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  $("#subtitle").textContent = "Passages you highlighted, with your notes." + upd;
  $("#articleList").innerHTML = list.length ? list.map(h => {
    const x = state.items.find(i => i.id === h.itemId);
    const d = x ? date(x.published) : null;
    return `<article class="article hl-row" data-hl-open="${esc(h.id)}" tabindex="0"><div class="article-main"><div class="article-meta"><span>${esc(x ? feedTitleFor(x) : "Article")}</span><span>·</span><time>${esc(h.created ? relDate(new Date(h.created)) : "")}</time></div><blockquote class="hl-quote">${esc(h.text)}</blockquote>${h.note ? `<p class="hl-note">${esc(h.note)}</p>` : ""}<div class="article-bottom"><span>${esc(x ? x.title : "Article no longer in the library")}</span><span class="article-actions"><button data-action="hl-delete" data-id="${esc(h.id)}" title="Delete highlight" aria-label="Delete highlight">×</button></span></div></div></article>`;
  }).join("") : '<div class="empty"><div class="empty-mark">R</div><h2>No highlights yet.</h2><p>Select text in an article to highlight it, with an optional note.</p></div>';
  const ma = $("#markAbove"), mb = $("#markBelow");
  if (ma) ma.disabled = true;
  if (mb) mb.disabled = true;
}
async function removeVisibleFromQueue() {
  const targets = visible().filter(item => item.queued);
  if (!targets.length) { toast("There are no queued articles in this view."); return; }
  const previousOrder = new Map(targets.map(item => [item.id, item.queueOrder || 0]));
  for (const item of targets) { item.queued = false; item.queueOrder = 0; }
  await putMany(targets);
  render();
  toast("Removed " + targets.length + " article" + (targets.length === 1 ? "" : "s") + " from the queue.", {
    label: "Undo",
    fn: async () => {
      for (const item of targets) { item.queued = true; item.queueOrder = previousOrder.get(item.id); }
      await putMany(targets);
      render();
    }
  });
}
function renderList() {
  const a = visible();
  renderSelectionToolbar();
  const titles = { all: "All articles", unread: "Unread", queue: "Reading queue", saved: "Saved", snoozed: "Snoozed", highlights: "Highlights", feed: state.feeds.find(f => f.id === state.feed)?.title || "Feed", folder: state.folder || "Folder", savedSearch: state.savedSearches.find(s => s.id === state.savedSearch)?.name || "Saved search", tag: state.tag ? "Tag: " + state.tag : "Tag" };
  $("#heading").textContent = titles[state.view];
  $("#removeQueue").hidden = state.view !== "queue";
  $("#mobileTitle").textContent = titles[state.view];
  // The Highlights view (#116) lists the highlights themselves, newest
  // first, with the article each came from; clicking one opens it.
  if (state.view === "highlights") { renderHighlightsList(); return; }
  $("#mobileTitle").textContent = titles[state.view];
  // Keep the sort button and the filter pills in step with the
  // persisted sort/filter, so a reload restores them.
  renderSortBtn();
  $$(".filter").forEach(x => x.classList.toggle("active", x.dataset.filter === state.filter));
  // The filter menu button shows the active filter (#175).
  const fb = $("#filterMenuBtn");
  if (fb) fb.querySelector(".disclosure-label").textContent = ({ all: "All", today: "Today", week: "This week" }[state.filter] || "All");
  const base = state.view === "queue" ? "Articles arranged for your next reading session."
    : state.view === "saved" ? "Articles you have kept for later."
    : state.view === "snoozed" ? "Articles waiting to come back."
    : state.view === "unread" ? "Stories you have not read yet."
    : state.view === "highlights" ? "Passages you highlighted, with your notes."
    : state.view === "folder" ? ""
    : state.view === "savedSearch" ? "A saved filter, run over your library."
    : state.view === "tag" ? `Articles tagged “${state.tag}”.`
    : "";
  const upd = state.lastRefresh ? "Updated " + new Date(state.lastRefresh).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  // The All view has no description to show — the subtitle is just the
  // last refresh time (#146), not filler.
  $("#subtitle").textContent = [base, upd].filter(Boolean).join(" · ");
  // A search in progress says what it is and how many it found (#162).
  if (state.query) $("#subtitle").textContent = `Searching for "${state.query}" — ${a.length} article${a.length === 1 ? "" : "s"}`;
  $("#articleList").innerHTML = a.length ? a.map(x => {
    const d = date(x.published);
    // Card options: how much preview text, and whether to show the thumbnail.
    // A feed's own layout override (#183) wins over the global setting.
    const srcFeed = state.feeds.find(f => f.id === x.feedId);
    const exc = feedCardExcerpt(srcFeed);
    const excerpt = exc === "none" ? "" : `<p>${esc(snippet(cleanSummary(x.summary), exc === "short" ? 100 : 210))}</p>`;
    const feedTitle = feedTitleFor(x);
    // The author is shown in the bottom row only when it differs from the
    // feed title in the source line and is not empty (#189, #191).
    const showAuthor = !!(x.author && x.author.trim()) && !authorIsFeedTitle(x.author, feedTitle);
    // The feed favicon for the source line, from the feed site (#191).
    let fav = "";
    try { fav = new URL(srcFeed?.site || srcFeed?.url || x.url).origin + "/favicon.ico"; } catch {}
    const thumb = feedCardImage(srcFeed) && x.image ? `<img class="article-thumb" src="${esc(x.image)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    const rt = readingTimeText(x);
    const snoozeNote = state.view === "snoozed" && x.snoozedUntil ? ` · <span>Snoozed until ${esc(fmtDateTime(new Date(x.snoozedUntil)))}</span>` : "";
    return `<article class="article ${x.read ? "" : "unread"} ${x.id === state.selected ? "selected" : ""} ${selectedArticleIds.has(x.id) ? "multi-selected" : ""}" data-item="${esc(x.id)}" tabindex="0" role="button" aria-label="Open: ${esc(x.title)}"><button type="button" class="article-select" data-select-item="${esc(x.id)}" aria-label="Select: ${esc(x.title)}" aria-pressed="${selectedArticleIds.has(x.id)}">${selectedArticleIds.has(x.id) ? "✓" : ""}</button>${thumb}<div class="article-main"><h2>${esc(x.title)}</h2><div class="article-source">${fav ? `<img class="card-favicon" src="${esc(fav)}" alt="" loading="lazy" onerror="this.remove()">` : ""}<span>${esc(feedTitle)}</span></div>${excerpt}<div class="article-bottom"><span>${showAuthor ? `${esc(x.author)} · ` : ""}<time datetime="${esc(d ? d.toISOString() : "")}" title="${esc(d ? d.toLocaleDateString() : "")}">${esc(relDate(d))}</time>${rt ? ` · <span>${rt}</span>` : ""}${snoozeNote}</span><span class="article-actions"><button data-action="read" data-id="${esc(x.id)}" title="Toggle read (m)" aria-label="${x.read ? "Mark unread" : "Mark read"}: ${esc(x.title)}" aria-pressed="${x.read}">${x.read ? "○" : "●"}</button><button data-action="save" data-id="${esc(x.id)}" title="Save (s)" aria-label="${x.saved ? "Unsave" : "Save"}: ${esc(x.title)}" aria-pressed="${x.saved}">${icon(x.saved ? "star-filled" : "star")}</button><button data-action="share" data-id="${esc(x.id)}" title="Share article" aria-label="Share: ${esc(x.title)}">${icon("share")}</button><button data-action="queue" data-id="${esc(x.id)}" title="${x.queued ? "Remove from queue" : "Add to queue"}" aria-label="${x.queued ? "Remove from queue" : "Add to queue"}: ${esc(x.title)}" aria-pressed="${!!x.queued}">${x.queued ? "☷" : "＋"}</button>${state.view === "queue" ? `<button class="text-btn" data-action="queue-up" data-id="${esc(x.id)}" title="Move earlier">↑</button><button class="text-btn" data-action="queue-down" data-id="${esc(x.id)}" title="Move later">↓</button>` : ""}${state.view === "snoozed" ? `<button class="text-btn" data-action="unsnooze" data-id="${esc(x.id)}" title="Bring back now" aria-label="Unsnooze: ${esc(x.title)}">Unsnooze</button>` : ""}</span></div></div></article>`;
  }).join("") : (state.query || state.filter !== "all" ? `<div class="empty"><div class="empty-mark">R</div><h2>Nothing to show.</h2><p>No articles match${state.query ? " &quot;" + esc(state.query) + "&quot;" : ""}.</p><button class="primary" id="emptyClear">Clear search</button></div>` : '<div class="empty"><div class="empty-mark">R</div><h2>Nothing to show.</h2><p>Add a feed or change the current filter.</p><button class="primary" id="emptyAdd">Add a feed</button></div>');
  const b = $("#emptyAdd");
  if (b) b.onclick = showFeed;
  const c = $("#emptyClear");
  if (c) c.onclick = () => { $("#search").value = ""; state.query = ""; state.filter = "all"; $("#searchClear").hidden = true; renderList(); $("#search").focus(); };
  // Mark above/below act on the selected article in this list: without
  // a selection there is nothing above or below to mark. Mark visible
  // read is disabled when nothing visible is unread (#136 follow-up).
  const hasSel = a.some(x => x.id === state.selected);
  const ma = $("#markAbove"), mb = $("#markBelow"), mr = $("#markRead");
  if (ma) { ma.disabled = !hasSel; ma.title = hasSel ? "Marks every article above the open one read (Ctrl+M)" : "Open an article first — this acts on the articles around it."; }
  if (mb) { mb.disabled = !hasSel; mb.title = hasSel ? "Marks every article below the open one read (Shift+M)" : "Open an article first — this acts on the articles around it."; }
  if (mr) mr.disabled = !a.some(x => !x.read);
  // Save search only appears when there is an active search to save (#146).
  const ss = $("#saveSearchBtn");
  if (ss) ss.hidden = !state.query;
  renderSelectionToolbar();
  scheduleAppSessionSave();
}

/* ---------- sanitising ---------- */
/* Resolve relative URLs BEFORE stripping, or they become "/null".
   Handles href, src, srcset and poster. */
function resolveAttr(el, name, base) {
  const v = el.getAttribute(name);
  if (!v) return;
  if (/^(https?:|mailto:|#|data:)/i.test(v)) return;
  try { el.setAttribute(name, new URL(v, base).href); } catch { el.removeAttribute(name); }
}
function resolveSrcset(el, base) {
  const v = el.getAttribute("srcset");
  if (!v) return;
  const out = v.split(",").map(part => {
    const [u, ...rest] = part.trim().split(/\s+/);
    if (!u || /^(https?:|data:)/i.test(u)) return part.trim();
    try { return [new URL(u, base).href, ...rest].join(" "); } catch { return ""; }
  }).filter(Boolean).join(", ");
  if (out) el.setAttribute("srcset", out); else el.removeAttribute("srcset");
}
/* Page chrome: site furniture, not article text. React/Next.js sites
   (e.g. science.nasa.gov) build their header and footer from <div>s,
   so semantic tags alone do not catch them — roles and the usual
   site-chrome class names are needed too. Shared by cleanHTML and
   extractArticle. */
const CHROME_SELECTOR = "header,nav,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='search'],.site-header,.site-footer,.site-nav,.global-header,.global-footer,.navbar,.nav,.navigation,.nav-menu,.main-nav,.site-menu,.page-header,.page-footer,.share,.social,.related,.comments,#comments";
function cleanHTML(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta,noscript," + CHROME_SELECTOR).forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(n => {
    ["href", "src", "poster"].forEach(name => resolveAttr(n, name, base));
    resolveSrcset(n, base);
    [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name)) { n.removeAttribute(a.name); return; }
      if ((a.name === "href" || a.name === "src") && !/^(https?:|mailto:|#|data:image\/)/i.test(a.value)) n.removeAttribute(a.name);
      // SVG's xlink:href is a second href the check above never sees:
      // <a xlink:href="javascript:..."> would run on click.
      if (a.name === "xlink:href") n.removeAttribute(a.name);
      if (a.name === "style") n.removeAttribute(a.name);
    });
    if (n.tagName === "A" && n.getAttribute("href")) { n.target = "_blank"; n.rel = "noopener noreferrer"; }
    if (n.tagName === "IMG") {
      // Lazy-loaded images only carry data-src until the page's scripts
      // run; promote it so the image survives extraction.
      if (!n.getAttribute("src")) {
        const ds = n.getAttribute("data-src") || n.getAttribute("data-lazy-src") || n.getAttribute("data-original");
        if (ds) { n.setAttribute("src", ds); resolveAttr(n, "src", base); }
      }
      if (!n.getAttribute("src")) n.remove();
    }
  });
  return doc.body;
}

/* Full-article extraction (#146): Mozilla Readability first — the same
   library Firefox Reader View and FriRSS use. It scores paragraphs and
   strips the page chrome (nav, sidebars, footers) that the hand-rolled
   heuristic below can leave behind (e.g. the NASA footer on APOD
   pages). Readability needs a document whose base URL resolves
   relative links, so a <base> tag is inserted first, as FriRSS does.
   Its cost grows with the page's nesting, so it is bounded
   (maxElemsToParse) and any failure — or a too-short result — falls
   back to the hand-rolled heuristic, which never throws. */
let readabilityLoadPromise;
function loadReadability() {
  if (typeof Readability === "function") return Promise.resolve();
  if (!readabilityLoadPromise) {
    readabilityLoadPromise = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "./readability.js";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); resolve(); };
      document.head.append(script);
    });
  }
  return readabilityLoadPromise;
}
async function extractArticle(html, base) {
  await loadReadability();
  if (typeof Readability === "function") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      // A relative URL in the page means nothing to a document parsed
      // from a string; <base> resolves it here.
      const b = doc.createElement("base");
      b.setAttribute("href", base);
      if (doc.head) doc.head.prepend(b);
      // Resolve lazy images before Readability scores the page, so an
      // image-heavy article is not scored as empty.
      doc.querySelectorAll("img").forEach(n => {
        const ds = n.getAttribute("data-src") || n.getAttribute("data-lazy-src") || n.getAttribute("data-original");
        if (ds && !n.getAttribute("src")) n.setAttribute("src", ds);
      });
      const parsed = new Readability(doc, { maxElemsToParse: 8000 }).parse();
      if (parsed?.content && (parsed.textContent || "").trim().length >= 200) {
        return cleanHTML(parsed.content, base);
      }
    } catch {}
  }
  return extractArticleHeuristic(html, base);
}
/* The hand-rolled fallback: prefer <article>/<main>, otherwise the
   block with the most paragraph text; drop nav/chrome. */
function extractArticleHeuristic(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Drop page chrome before choosing the article root, or the
  // largest-text scoring picks a page wrapper that contains it.
  doc.querySelectorAll("script,style,form,noscript," + CHROME_SELECTOR).forEach(n => n.remove());
  let root = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector('[role="main"]');
  if (!root) {
    let best = null, bestScore = 0;
    doc.querySelectorAll("div,section").forEach(el => {
      const ps = [...el.querySelectorAll("p")].reduce((t, p) => t + (p.textContent || "").length, 0);
      if (ps > bestScore && ps > 400) { bestScore = ps; best = el; }
    });
    root = best || doc.body;
  }
  const clone = root.cloneNode(true);
  return cleanHTML(clone.innerHTML, base);
}
async function fetchArticleHtml(url, title) {
  let directErr = null;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }, cache: "no-store"
    });
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) { directErr = e; }
  // Reader service (returns the article as Markdown). Fast when it works;
  // it rate-limits shared IPs, so a failure here just falls through.
  // If the title appears only after a long run of navigation text, the
  // service returned the whole page, not the article: keep its output as
  // a last resort, but prefer the raw page HTML below.
  let jinaHtml = null;
  try {
    const r = await fetchWithTimeout(JINA + url, {
      headers: { Accept: "text/plain" }, cache: "no-store"
    }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const md = await r.text();
    if (/RateLimitTriggeredError/i.test(md)) throw Error("Reader service rate-limited.");
    const html = markdownToHTML(md);
    if (stripTags(html).length < 200) throw Error("No article text found.");
    const pos = titleAnchorPos(stripTags(html), title);
    if (pos < 0 || pos <= 1200) return html;
    jinaHtml = html;
  } catch {}
  // Generic proxy (returns the raw page HTML). Slow and flaky per site.
  try {
    const r = await fetchWithTimeout(ALLORIGINS + encodeURIComponent(url), { cache: "no-store" }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) {
    if (jinaHtml) return jinaHtml;
    throw directErr || e;
  }
}
/* The site's own WordPress API, looked up by the article slug. No third
   party is involved, so this runs whether or not the proxy is on — the
   same principle as feed loading. Returns the post HTML, or null. */
async function fetchViaWordPress(url) {
  let origin, slug;
  try {
    const u = new URL(url);
    origin = u.origin;
    const parts = u.pathname.split("/").filter(Boolean);
    slug = parts[parts.length - 1] || "";
  } catch { return null; }
  if (!slug) return null;
  try {
    const r = await fetchWithTimeout(`${origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&per_page=1`, {
      headers: { Accept: "application/json" }, cache: "no-store"
    });
    if (!r.ok) return null;
    const posts = await r.json();
    if (!Array.isArray(posts) || !posts.length) return null;
    const content = posts[0]?.content?.rendered || "";
    if (stripTags(content).length < 200) return null;
    return content;
  } catch { return null; }
}
/* Small Markdown → HTML converter for the reader service's output.
   The source is escaped first, so raw HTML in the article cannot inject. */
function markdownToHTML(md) {
  const start = md.indexOf("Markdown Content:");
  const text = start >= 0 ? md.slice(start + "Markdown Content:".length) : md;
  const escMd = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => escMd(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) => `<img src="${u}" alt="${escMd(alt)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = text.split("\n");
  let html = "", para = [], list = null;
  /* Consecutive list items belong in ONE list element, not a stack of
     one-item lists. */
  const flushList = () => {
    if (!list) return;
    html += `<${list.tag}>` + list.items.map(i => `<li>${i}</li>`).join("") + `</${list.tag}>`;
    list = null;
  };
  const flush = () => { flushList(); if (para.length) { html += "<p>" + para.join(" ") + "</p>"; para = []; } };
  const startList = tag => {
    if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); const lvl = h[1].length + 1; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
    if (/^---+$/.test(line)) { flush(); html += "<hr>"; continue; }
    if (/^>\s?/.test(line)) { flush(); html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; continue; }
    if (/^[-*]\s+/.test(line)) { startList("ul"); list.items.push(inline(line.replace(/^[-*]\s+/, ""))); continue; }
    if (/^\d+[.)]\s+/.test(line)) { startList("ol"); list.items.push(inline(line.replace(/^\d+[.)]\s+/, ""))); continue; }
    para.push(inline(line));
  }
  flush();
  return html;
}
async function loadFullText(item) {
  if (!item || loadingFullTextIds.has(item.id) || item.fullContent) return;
  loadingFullTextIds.add(item.id);
  if (state.selected === item.id) renderReader(item);
  try {
    // The site's own WordPress API first — but only for sites we know
    // are WordPress (their feed loaded via the WP API). Asking every
    // other publisher's origin for /wp-json/ can only 404.
    const f = state.feeds.find(f => f.id === item.feedId);
    const wp = (f?.via === "wp" || f?.wpRoot) ? await fetchViaWordPress(item.url) : null;
    if (wp) {
      item.fullContent = wp;
    } else {
      const html = await fetchArticleHtml(item.url, item.title);
      const body = await extractArticle(html, item.url);
      if (!body || !body.textContent.trim()) throw Error("No article text found.");
      item.fullContent = body.innerHTML;
    }
    await put(item);
    loadingFullTextIds.delete(item.id);
    // The article's body changed, so its cached search text is stale.
    searchTextCache.delete(item.id);
    // The load can take tens of seconds; the user may have opened
    // another article or closed the reader meanwhile. Only re-open the
    // article if it is still the one on screen, or the completed load
    // would yank the reader back to a stale article.
    if (state.selected === item.id) openItem(item.id);
    toast("Full article loaded.");
  } catch (e) {
    loadingFullTextIds.delete(item.id);
    if (state.selected === item.id) renderReader(item);
    toast("Full text unavailable — the publisher blocks direct access and the reader services could not fetch this page.");
  }
}

/* Full-article view state (#173): ids the user toggled back to the feed
   excerpt with W (or the More menu). In-memory only: the fetched full
   text stays stored on the item, so toggling back on is instant. */
const fullOffIds = new Set();
const loadingFullTextIds = new Set();
/* Whether the reader is showing fetched full text, and whether the feed
   content already IS the full article (nothing to load or toggle). */
function fullTextState(x) {
  const f = state.feeds.find(f => f.id === x.feedId);
  const showingFull = !!x.fullContent && !fullOffIds.has(x.id);
  const alreadyFull = !showingFull && (
    (f?.via === "wp" && stripTags(x.content || "").length > 200) ||
    (x.fullContentIncluded && stripTags(x.content || "").length > 200)
  );
  return { showingFull, alreadyFull };
}

/* W toggles full article on and off, like Inoreader (#173). Toggling
   off just hides the fetched text; toggling on again needs no fetch. */
function toggleFullText(x) {
  if (!x) return;
  const { showingFull, alreadyFull } = fullTextState(x);
  if (alreadyFull) return;
  if (showingFull) {
    fullOffIds.add(x.id);
    renderReader(x);
  } else if (x.fullContent) {
    fullOffIds.delete(x.id);
    renderReader(x);
  } else {
    fullOffIds.delete(x.id);
    loadFullText(x);
  }
}

function readerBodyHTML(x) {
  const { showingFull } = fullTextState(x);
  let body = showingFull ? x.fullContent : (x.content || x.summary || "<p>No article text was included in this feed.</p>");
  // Convert plain-text Markdown locally; preserve existing HTML feeds.
  const hasHTML = body.trimStart().startsWith("<");
  if (window.RSSMarkdown && window.DOMPurify && !hasHTML && RSSMarkdown.looksLikeMarkdown(body)) {
    body = DOMPurify.sanitize(RSSMarkdown.render(body), { USE_PROFILES: { html: true } });
  }
  return { showingFull, body };
}
/* Build the reader pane for an item without changing its read state.
   openItem() marks the item read first; toggles (m, list buttons) call
   this directly so marking an item unread is not immediately undone. */
/* Text-to-speech bar (#105): shown while an article is being read
   aloud. The speed selector applies from the next spoken chunk. */
const ttsBarHTML = x => {
  const active = tts && tts.itemId === x.id;
  const rate = state.settings.ttsRate || 1;
  const opt = v => `<option value="${v}"${rate === v ? " selected" : ""}>${v}×</option>`;
  return `<div class="tts-bar" id="ttsBar"${active ? "" : " hidden"}><span>Listening</span><button type="button" data-tts="pause">${tts?.paused ? "Resume" : "Pause"}</button><button type="button" data-tts="stop">Stop</button><label>Speed <select id="ttsSpeed" aria-label="Reading speed">${opt(0.75)}${opt(1)}${opt(1.25)}${opt(1.5)}${opt(2)}</select></label></div>`;
};
/* ---------- snoozing (#113) ---------- */
/* Later today is four hours out; tomorrow and next week come back at
   9:00 AM. Saved is keep forever; snoozed is come back later — the
   two stay separate, and a snoozed article is never deleted. */
function snoozeUntil(kind) {
  const now = new Date();
  if (kind === "later") return Date.now() + 4 * 3600 * 1000;
  const d = new Date(now);
  d.setDate(d.getDate() + (kind === "tomorrow" ? 1 : 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
const snoozeMenuHTML = x => {
  const until = isSnoozed(x) ? new Date(x.snoozedUntil) : null;
  const fmt = d => d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const later = new Date(Date.now() + 4 * 3600 * 1000);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(); week.setDate(week.getDate() + 7); week.setHours(9, 0, 0, 0);
  return `<div class="snooze-menu" id="snoozeMenu" hidden><button type="button" data-snooze="later">Later today · ${esc(fmt(later))}</button><button type="button" data-snooze="tomorrow">Tomorrow · ${esc(fmt(tomorrow))}</button><button type="button" data-snooze="week">Next week · ${esc(fmt(week))}</button>${until ? `<button type="button" data-snooze="clear">Unsnooze (back now)</button>` : ""}</div>`;
};
async function snoozeItem(x, kind) {
  const until = snoozeUntil(kind);
  x.snoozedUntil = until;
  await put(x);
  renderNav();
  renderList();
  toast(`Snoozed until ${fmtDateTime(new Date(until))}.`, { label: "Undo", fn: async () => {
    x.snoozedUntil = null;
    await put(x);
    render();
  } });
}
async function unsnoozeItem(x) {
  x.snoozedUntil = null;
  await put(x);
  render();
  if (state.selected === x.id) renderReader(x);
  toast("Back in your lists.");
}
function renderReader(x) {
  // Re-rendering the same article (a save/read toggle, a tag change)
  // must not stop playback: only stop TTS when the article changes.
  if (tts?.itemId !== x.id) stopTTS();
  // Preserve podcast playback across re-renders of the same episode:
  // the audio element is rebuilt below, so its position, speed, and
  // playing state are captured first and restored after. The scroll
  // position is captured the same way, so a toggle does not jump the
  // reader back to the top.
  const oldAudio = $("#audioPlayer");
  const audioState = oldAudio ? { time: oldAudio.currentTime, playing: !oldAudio.paused, rate: oldAudio.playbackRate } : null;
  const prevScroll = $("#reader").scrollTop;
  const wasOpen = $("#reader").dataset.openId === x.id;
  const f = state.feeds.find(f => f.id === x.feedId);
  const d = date(x.published);
  const rt = readingTimeText(x);
  const { showingFull, body } = readerBodyHTML(x);
  // WordPress API items already carry the full article, and so does any
  // feed item with long content — do not offer to "load" what is there.
  /* "Full article included in feed" only when we know it: the feed was
     loaded from the site's own WordPress API, whose posts carry full
     content. Length is NOT a signal — some feeds (e.g. NASA) ship long
     excerpts padded with site boilerplate, which the old >1500-char
     guess mislabelled as full and left with no way to fetch the rest. */
  const { alreadyFull } = fullTextState(x);
  // The menu item toggles (#173): enabled unless the feed content
  // already is the full article.
  const canFull = !alreadyFull;
  // The progress bar sits at the very edge of the reader (top or bottom,
  // per the setting), so it is placed before the content for top and
  // after it for bottom.
  const progTop = state.settings.progressPosition === "top";
  const barHTML = `<div id="readProgress" class="${progTop ? "top" : "bottom"}"><i></i></div>`;
  const isAudio = !!x.enclosure?.type?.startsWith("audio/");
  const canListen = "speechSynthesis" in window;
  const audioHTML = isAudio ? `<div class="audio-player"><audio id="audioPlayer" controls preload="metadata" src="${esc(x.enclosure.url)}"></audio><div class="audio-controls"><label>Speed <select id="audioSpeed" aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><a href="${esc(x.enclosure.url)}" target="_blank" rel="noopener">Open audio ↗</a></div></div>` : "";
  // The tag box stays collapsed by default (#171): a Tag button in the
  // top bar, expanded by clicking it or pressing T. Expanded state is
  // per article, so re-renders keep it and opening another article
  // collapses it again.
  const tagsOpen = tagsExpandedId === x.id;
  const fullLabel = showingFull ? "Show feed excerpt" : x.fullContent ? "Show full article" : alreadyFull ? "Full article included in feed" : "Load full article";
  // The tags row lives below the header (#197), not inside it, so the
  // header stays one short row. It renders only when the article has
  // tags or the input is open; the toolbar Tag button toggles it.
  const tagsRowHTML = ((x.tags || []).length || tagsOpen) ? `<div class="tags-row" id="tagsRow">${(x.tags || []).map(t => `<span class="tag-chip">${esc(t)}<button type="button" data-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon("close")}</button></span>`).join("")}<span id="tagInputWrap" ${tagsOpen ? "" : "hidden"}><input id="tagInput" list="tagList" placeholder="Add a tag… (t)" aria-label="Add a tag"><button type="button" class="quiet" id="tagAddBtn">Add</button></span></div>` : "";
  const hasNote = !!getArticleNote(x.id);
  const readerFeedTitle = f ? feedDisplayTitle(f) : x.feedTitle;
  $("#reader").innerHTML = `${progTop ? barHTML : ""}<div class="reader-content"><div class="reader-top"><button type="button" id="focusExit" class="focus-exit" title="Exit focus reading mode">Exit focus</button><span title="${esc(readerFeedTitle)}" aria-label="${esc(readerFeedTitle)}">${esc(readerFeedTitle)}</span><div class="reader-actions">${toolbarOrder().map(k => toolbarButtonHTML(k, x, {fullLabel, canListen, canFull, hasNote})).join("")}<button type="button" class="reader-btn" data-reader="queue" title="${x.queued ? "Remove from queue" : "Add to reading queue"}" aria-label="${x.queued ? "Remove from reading queue" : "Add to reading queue"}" aria-pressed="${!!x.queued}">${x.queued ? "☷" : "＋"}</button></div></div>${tagsRowHTML}${snoozeMenuHTML(x)}${ttsBarHTML(x)}<h1>${esc(x.title)}</h1><div class="byline">${[x.author ? esc(x.author) : "", esc(d ? fmtDateTime(d) : "No date"), rt].filter(Boolean).join(" · ")}</div>${articleNoteHTML(x)}${audioHTML}<div class="reader-body" id="body"></div><div class="reader-footer"><p>${showingFull ? "Full article text, extracted from the original page." : "Content supplied by the publisher's feed."}</p></div>${highlightsSectionHTML(x)}</div>${progTop ? "" : barHTML}`;
  setupReaderToolbarOverflow();
  const focusExit = $("#focusExit");
  if (focusExit) focusExit.onclick = () => { document.body.classList.remove("focus-mode"); updateFocusButton(); };
  const tagAdd = $("#tagAddBtn");
  if (tagAdd) tagAdd.onclick = () => { const x = selectedItem(); const inp = $("#tagInput"); if (x && inp) addTagToItem(x, inp.value); };
  const bodyEl = $("#body");
  // Append the cleaned body's children, not the <body> element itself.
  // cleanHTML drops the page chrome (header/nav/footer); the leading-nav
  // strip then removes any boilerplate nav block (e.g. APOD) that was
  // a plain div/table, now that the chrome above it is gone. The strip
  // runs on a clone, so if it would gut the article the un-stripped
  // body is used instead.
  const cleaned = cleanHTML(body, x.url);
  // A content image (the article's picture) vs site chrome: logos,
  // thumbnails, icons, SVGs and WordPress theme assets are chrome.
  const isContentImg = im => {
    const src = im.getAttribute("src") || "";
    return src && !/logo|thumb|icon|\.svg$|\/themes\//i.test(src);
  };
  // Capture the article's main image before the title cut can remove
  // it: the last content image in the body. The feed often stores no
  // image and the feed content may not carry one either, so the full
  // text itself is the only source of the picture. The article
  // picture sits after the site's teaser images and before the
  // footer logo, so the last content image is it.
  let articleImgSrc = "";
  for (const im of cleaned.querySelectorAll("img")) {
    if (!isContentImg(im)) continue;
    articleImgSrc = im.getAttribute("src") || "";
  }
  // The title is the anchor for reader-service output that flattened the
  // whole page into plain blocks: drop everything before it, then strip
  // any leading nav block that remains.
  cutBeforeTitleEl(cleaned, x.title);
  const stripped = cleaned.cloneNode(true);
  const bodyToUse = stripLeadingNavEl(stripped, x.title) ? stripped : cleaned;
  // The title cut can remove a leading article picture (an image
  // paragraph has no text, so it is swept up with the chrome). If the
  // body has no picture near the top, restore the article's image
  // there. The footer logo at the bottom does not count — only the
  // first few children are checked. The feed's image is preferred;
  // when the item has none stored, the first image in the feed
  // content is the article's picture, and failing that the picture
  // captured from the full text before the cut.
  // This is the ONLY place a hero image is added (#150): the reader
  // template used to render x.image as a hero too, so any article
  // whose body carried no image got the same picture twice, back
  // to back. If the body already has a picture near the top, no
  // hero is added at all.
  const heroSrc = x.image || firstImgSrc(x.content) || articleImgSrc;
  const topImgChild = [...bodyToUse.children].slice(0, 10).find(c =>
    [...c.querySelectorAll("img")].some(isContentImg));
  if (heroSrc && !topImgChild) {
    const hero = document.createElement("p");
    hero.className = "reader-hero";
    const img = document.createElement("img");
    img.src = heroSrc;
    img.alt = "";
    img.loading = "lazy";
    hero.appendChild(img);
    bodyToUse.prepend(hero);
  }
  bodyEl.append(...bodyToUse.childNodes);
  // Highlights (#116): mark the saved passages back into the text.
  applyHighlights(bodyEl, highlightsFor(x.id));
  $("#reader").classList.add("open");
  document.body.classList.add("reader-open");
  // A fresh article starts at the top; a re-render of the same article
  // (a save/read toggle, a tag change) keeps its scroll position.
  $("#reader").dataset.openId = x.id;
  $("#reader").scrollTop = wasOpen ? prevScroll : 0;
  updateReadProgress();
  bindAudioPlayer(x);
  // Restore a playing episode across the re-render (see above): the
  // position can only be set once the audio metadata has loaded.
  if (audioState) {
    const a2 = $("#audioPlayer");
    if (a2) {
      a2.playbackRate = audioState.rate;
      const speed = $("#audioSpeed");
      if (speed) speed.value = String(audioState.rate);
      const restore = () => { try { a2.currentTime = audioState.time; } catch {} if (audioState.playing) a2.play().catch(() => {}); };
      if (a2.readyState >= 1) restore();
      else a2.addEventListener("loadedmetadata", restore, { once: true });
    }
  }
  if (history.state?.reader !== x.id) {
    try {
      if (history.state?.reader) history.replaceState({ reader: x.id }, "");
      else history.pushState({ reader: x.id }, "");
    } catch {}
  }
}
/* Wire the inline audio player for a podcast episode: the speed
   selector, and the Media Session API so the phone's lock screen and
   notification show the episode with play/pause and seek. Audio
   streams over the network and is not kept offline. */
function bindAudioPlayer(x) {
  const audio = $("#audioPlayer");
  if (!audio) return;
  const speed = $("#audioSpeed");
  if (speed) speed.onchange = () => { audio.playbackRate = Number(speed.value) || 1; };
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: x.title,
        artist: x.author || x.feedTitle,
        album: x.feedTitle
      });
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("seekto", d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
    } catch {}
  }
}
/* ---------- text-to-speech (#105) ---------- */
/* The Web Speech API is built into the browser: no backend, no cost.
   The article is read in sentence chunks of about 500 characters, so
   pause/resume and speed changes have somewhere to take effect, and
   one failed utterance does not lose the whole article. No sentence
   highlighting: boundary events are unreliable across browsers, so
   this version just plays the text. */
function ttsChunksFor(x) {
  const text = (x.title + ". " + plainText(x.fullContent || x.content || x.summary || "")).replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > 500) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
function updateTTSUI() {
  const bar = $("#ttsBar");
  const btn = $('[data-reader="listen"]');
  if (btn) {
    btn.classList.toggle("listening", !!tts);
    btn.setAttribute("aria-pressed", String(!!tts));
    btn.title = tts ? "Stop listening" : "Listen to article";
  }
  if (!bar) return;
  bar.hidden = !tts;
  const pause = bar.querySelector('[data-tts="pause"]');
  if (pause) pause.textContent = tts?.paused ? "Resume" : "Pause";
}
function speakChunk() {
  if (!tts) return;
  if (tts.index >= tts.chunks.length) { stopTTS(); toast("Finished reading."); return; }
  const u = new SpeechSynthesisUtterance(tts.chunks[tts.index]);
  u.rate = state.settings.ttsRate || 1;
  u.onend = () => {
    if (!tts) return;
    // Paused when the chunk ended: do not advance; resuming replays
    // this chunk from its start rather than skipping ahead.
    if (tts.paused) return;
    tts.index++;
    speakChunk();
  };
  u.onerror = e => {
    if (!tts) return;
    if (e?.error === "canceled" || e?.error === "interrupted") return;
    stopTTS();
    toast("Text-to-speech stopped: the browser could not read this article.");
  };
  speechSynthesis.speak(u);
  updateTTSUI();
}
function startTTS(x) {
  if (!("speechSynthesis" in window)) { toast("Text-to-speech is not available in this browser."); return; }
  stopTTS();
  const chunks = ttsChunksFor(x);
  if (!chunks.length) { toast("Nothing to read in this article."); return; }
  tts = { itemId: x.id, chunks, index: 0, paused: false };
  speakChunk();
}
function pauseTTS() {
  if (!tts || tts.paused) return;
  tts.paused = true;
  try { speechSynthesis.pause(); } catch {}
  updateTTSUI();
}
function resumeTTS() {
  if (!tts || !tts.paused) return;
  tts.paused = false;
  try { speechSynthesis.resume(); } catch {}
  // If the utterance already ended while paused, resume() does
  // nothing: restart the current chunk so playback continues.
  setTimeout(() => { if (tts && !speechSynthesis.speaking && tts.index < tts.chunks.length) speakChunk(); }, 300);
  updateTTSUI();
}
function stopTTS() {
  if (!tts) return;
  tts = null;
  try { speechSynthesis.cancel(); } catch {}
  updateTTSUI();
}

/* ---------- sharing (#112) ---------- */
/* Share the original article link, not anything stored in the app.
   The system share sheet where the browser has one; otherwise copy
   the link to the clipboard, with a textarea fallback for browsers
   whose clipboard API is unavailable. */
async function shareArticle(x) {
  if (navigator.share) {
    try { await navigator.share({ title: x.title, text: x.title, url: x.url }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  const copyFallback = () => {
    const ta = document.createElement("textarea");
    ta.value = x.url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  };
  try {
    await navigator.clipboard.writeText(x.url);
    toast("Link copied to clipboard.");
  } catch {
    toast(copyFallback() ? "Link copied to clipboard." : "Sharing is not available in this browser. Open the original article to copy its address.");
  }
}
/* ---------- highlights and notes (#116) ---------- */
/* The article's highlights, newest first. */
const highlightsFor = itemId => state.highlights.filter(h => h.itemId === itemId).sort((a, b) => (b.created || 0) - (a.created || 0));
/* Wrap a highlight's text in the rendered article body. The body is
   rebuilt from HTML on every open, so highlights are found again by
   their text: walk the text nodes in order, track the character offset,
   and wrap the matching range by splitting nodes. Whitespace is
   collapsed on both sides first, so a selection that crossed a line
   break still matches. A highlight whose text is no longer in the
   article (the text changed after a re-fetch) is skipped, not forced. */
function markHighlightText(bodyEl, h) {
  const text = h?.text || "";
  const needle = String(text || "").replace(/\s+/g, " ").trim();
  if (!needle) return false;
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let raw = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push(n); raw += n.nodeValue; }
  // Collapse runs of whitespace to one space, remembering for each
  // collapsed character the raw index it came from.
  const map = [];
  let collapsed = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (/\s/.test(c)) {
      if (collapsed && !collapsed.endsWith(" ")) { collapsed += " "; map.push(i); }
    } else { collapsed += c; map.push(i); }
  }
  const start = collapsed.indexOf(needle);
  if (start < 0) return false;
  const rawStart = map[start];
  const rawEnd = map[start + needle.length - 1] + 1;
  // Collect the (node, local start, local end) pieces, then wrap them
  // last-to-first so splitting one node never moves another's offsets.
  const pieces = [];
  let offset = 0;
  for (const n of nodes) {
    const nodeEnd = offset + n.nodeValue.length;
    const s = Math.max(rawStart, offset), e = Math.min(rawEnd, nodeEnd);
    if (s < e) pieces.push([n, s - offset, e - offset]);
    offset = nodeEnd;
  }
  for (let i = pieces.length - 1; i >= 0; i--) {
    const [n, s, e] = pieces[i];
    const mid = n.splitText(s);
    mid.splitText(e - s);
    const mark = document.createElement("mark");
    mark.className = "hl";
    if (h?.id) mark.dataset.hlId = h.id;
    mid.parentNode.replaceChild(mark, mid);
    mark.appendChild(mid);
  }
  return pieces.length > 0;
}
function applyHighlights(bodyEl, highlights) {
  for (const h of highlights) markHighlightText(bodyEl, h);
}
async function saveHighlight(itemId, text, note) {
  const h = { id: id(), itemId, text: String(text || "").replace(/\s+/g, " ").trim(), note: (note || "").trim(), created: Date.now() };
  if (!h.text) return null;
  state.highlights.push(h);
  try { await hlPut(h); } catch (e) { state.highlights = state.highlights.filter(v => v.id !== h.id); toast("Could not save the highlight."); return null; }
  return h;
}
async function deleteHighlight(hlId) {
  state.highlights = state.highlights.filter(v => v.id !== hlId);
  try { await hlDelete(hlId); } catch {}
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  toast("Highlight deleted.");
}
async function updateHighlightNote(hlId, note) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  h.note = (note || "").trim();
  try { await hlPut(h); } catch {}
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  renderNav();
}
/* The text the user has selected in the open article, waiting to be
   saved as a highlight, and the highlight being edited (its note). */
let pendingHighlight = null, editingHlId = null;
/* Show the floating Highlight button while there is a selection inside
   the article body (#116). It sits just above the selection so it does
   not cover the text, and hides on scroll or when the selection clears. */
function updateHlBtn() {
  const btn = $("#hlBtn");
  if (!btn || !state.selected) { if (btn) btn.hidden = true; return; }
  // Typing in a field is not a selection to highlight.
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { btn.hidden = true; return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { btn.hidden = true; return; }
  const body = $("#body");
  if (!body || !body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) { btn.hidden = true; return; }
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) { btn.hidden = true; return; }
  pendingHighlight = { itemId: state.selected, text };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  btn.style.left = Math.max(8, Math.min(window.innerWidth - 110, r.left + r.width / 2 - 45)) + "px";
  btn.style.top = Math.max(8, r.top - 42) + "px";
  btn.hidden = false;
}
function showHlDialog() {
  if (!pendingHighlight) return;
  editingHlId = null;
  $("#hlQuote").textContent = pendingHighlight.text;
  $("#hlNote").value = "";
  $("#hlDialog").showModal();
  $("#hlNote").focus();
}
/* Edit the note on an existing highlight, reusing the same dialog. */
function showHlNoteDialog(hlId) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  editingHlId = hlId;
  pendingHighlight = null;
  $("#hlQuote").textContent = h.text;
  $("#hlNote").value = h.note || "";
  $("#hlDialog").showModal();
  $("#hlNote").focus();
}
async function saveHlFromDialog() {
  if (editingHlId) {
    await updateHighlightNote(editingHlId, $("#hlNote").value);
    $("#hlDialog").close();
    editingHlId = null;
    toast("Note saved.");
    return;
  }
  if (!pendingHighlight) return;
  const h = await saveHighlight(pendingHighlight.itemId, pendingHighlight.text, $("#hlNote").value);
  $("#hlDialog").close();
  $("#hlBtn").hidden = true;
  window.getSelection()?.removeAllRanges();
  pendingHighlight = null;
  if (h) {
    const x = selectedItem();
    if (x) renderReader(x);
    renderNav();
    toast("Highlight saved.");
  }
}
/* The article's highlights, listed under it: the quoted text, the note,
   and a way to jump to the passage or delete it. */
function highlightsSectionHTML(x) {
  const list = highlightsFor(x.id);
  if (!list.length) return "";
  return `<div class="hl-section"><h3>Highlights (${list.length})</h3>` + list.map(h =>
    `<div class="hl-item" data-hl-id="${esc(h.id)}"><blockquote>${esc(h.text)}</blockquote>` +
    (h.note ? `<p class="hl-note">${esc(h.note)}</p>` : "") +
    `<div class="hl-actions"><button type="button" class="quiet" data-hl-note="${esc(h.id)}">${h.note ? "Edit note" : "Add note"}</button><button type="button" class="quiet" data-hl-goto="${esc(h.id)}">Show in article</button><button type="button" class="quiet" data-hl-delete="${esc(h.id)}">Delete</button></div></div>`
  ).join("") + `</div>`;
}
/* Open a highlight's article and scroll to the passage (#116). */
function scrollToHighlight(hlId) {
  const mark = document.querySelector(`mark.hl[data-hl-id="${CSS.escape(hlId)}"]`);
  if (!mark) { toast("That passage is not in the article text anymore."); return; }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("hl-flash");
  setTimeout(() => mark.classList.remove("hl-flash"), 1200);
}
function openHighlight(hlId) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  openItem(h.itemId);
  // The reader renders synchronously, so the mark is there to scroll to.
  requestAnimationFrame(() => scrollToHighlight(hlId));
}
function openItem(itemId) {
  if (selectedArticleIds.size) { toggleArticleSelection(itemId); return; }
  const x = state.items.find(i => i.id === itemId);
  if (!x) return;
  const prevId = state.selected;
  state.selected = itemId;
  const wasUnread = !x.read;
  if (wasUnread) { x.read = true; put(x); }
  renderNav();
  // Opening an article in the Unread view removes it from that list,
  // so the whole list has to be rebuilt there. Everywhere else the
  // read state does not change membership, so only the two affected
  // rows are updated instead of rebuilding the whole list.
  if (state.view === "unread") {
    renderList();
  } else {
    const prevRow = prevId ? document.querySelector(`[data-item="${CSS.escape(prevId)}"]`) : null;
    if (prevRow) prevRow.classList.remove("selected");
    const row = document.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
    if (row) {
      row.classList.add("selected");
      if (wasUnread) {
        row.classList.remove("unread");
        const readBtn = row.querySelector('[data-action="read"]');
        if (readBtn) { readBtn.textContent = "○"; readBtn.setAttribute("aria-pressed", "true"); readBtn.setAttribute("aria-label", "Mark unread: " + x.title); }
      }
    }
  }
  const row = document.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
  if (row) { row.scrollIntoView({ block: "nearest" }); row.focus({ preventScroll: true }); }
  // Mark above/below act on the selected article in this list: with a
  // selection in the list, they are enabled.
  const ma = $("#markAbove"), mb = $("#markBelow");
  if (ma) { ma.disabled = !row; ma.title = row ? "Marks every article above the open one read (Ctrl+M)" : "Open an article first — this acts on the articles around it."; }
  if (mb) { mb.disabled = !row; mb.title = row ? "Marks every article below the open one read (Shift+M)" : "Open an article first — this acts on the articles around it."; }
  renderReader(x);
  saveAppSession();
  // Auto full article (#183): this feed always loads the full article
  // text when an article is opened, unless the feed already carries it
  // or the full text is already fetched.
  const feed = state.feeds.find(fe => fe.id === x.feedId);
  if (feed?.autoFull) {
    const { showingFull, alreadyFull } = fullTextState(x);
    if (!showingFull && !alreadyFull && !x.fullContent) loadFullText(x);
  }
}
function closeReader() {
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  const wasOpen = $("#reader").classList.contains("open") || !!state.selected;
  $("#reader").classList.remove("open");
  delete $("#reader").dataset.openId;
  state.selected = null;
  render(); // resets the reader pane to "Select an article to read"
  if (wasOpen && history.state?.reader) {
    try { history.back(); } catch {}
  }
}

/* Restore the reader's local navigation context after a reload or PWA
   relaunch. Only view state and scroll positions are stored; feeds,
   articles, and reading data remain in their existing local stores. */
function saveAppSession() {
  const list = $(".list-pane"), reader = $("#reader");
  const session = {
    view: state.view,
    feed: state.feed,
    folder: state.folder,
    tag: state.tag,
    savedSearch: state.savedSearch,
    selected: state.selected,
    query: state.query,
    filter: state.filter,
    sort: state.sort,
    listScroll: list?.scrollTop || 0,
    readerScroll: reader?.scrollTop || 0,
    savedAt: Date.now()
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}
function scheduleAppSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveAppSession, 180);
}
function restoreAppSession() {
  let session;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return false; }
  if (!session || typeof session !== "object") return false;
  const views = ["all","unread","queue","saved","snoozed","highlights","feed","folder","savedSearch","tag"];
  if (!views.includes(session.view)) return false;
  if (session.view === "feed" && !state.feeds.some(f => f.id === session.feed)) return false;
  if (session.view === "folder" && !state.feeds.some(f => f.group === session.folder)) return false;
  if (session.view === "savedSearch" && !state.savedSearches.some(s => s.id === session.savedSearch)) return false;
  if (session.view === "tag" && !state.tags.includes(session.tag)) return false;
  state.view = session.view;
  state.feed = session.view === "feed" ? session.feed : null;
  state.folder = session.view === "folder" ? session.folder : null;
  state.tag = session.view === "tag" ? session.tag : null;
  state.savedSearch = session.view === "savedSearch" ? session.savedSearch : null;
  state.query = typeof session.query === "string" ? session.query.slice(0,500) : "";
  state.filter = ["all","today","week"].includes(session.filter) ? session.filter : "all";
  state.sort = session.sort === "oldest" ? "oldest" : "newest";
  state.settings.filter = state.filter;
  state.settings.sort = state.sort;
  $("#search").value = state.query;
  $("#searchClear").hidden = !state.query;
  state.selected = typeof session.selected === "string" && state.items.some(x => x.id === session.selected) ? session.selected : null;
  render();
  if (state.selected) {
    const item = state.items.find(x => x.id === state.selected);
    if (item) {
      renderReader(item);
      document.body.classList.add("reader-open");
      $("#reader").scrollTop = Math.max(0, Number(session.readerScroll) || 0);
    }
  }
  $(".list-pane").scrollTop = Math.max(0, Number(session.listScroll) || 0);
  saveAppSession();
  return true;
}
function render() {
  if (!state.selected) {
    document.body.classList.remove("reader-open");
    if (document.body.classList.contains("focus-mode")) document.body.classList.remove("focus-mode");
    updateFocusButton();
  }
  renderNav();
  renderList();
  // The tag suggestions live in one static datalist (#162), kept in step
  // here so the reader and the rule editor always offer current tags.
  const tl = $("#tagList");
  if (tl) tl.innerHTML = state.tags.map(t => `<option value="${esc(t)}">`).join("");
  if (!state.selected) $("#reader").innerHTML = '<div class="reader-empty">' + icon("rss", "big") + '<h2>Nothing open yet</h2><p>Pick an article from the list to read it here.</p><small>Tip: press ? any time to see keyboard shortcuts.</small></div>';
  saveAppSession();
}

/* ---------- folders & tags ---------- */
function goTag(tag) {
  clearArticleSelection();
  $("#moreDialog")?.close();
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  state.view = "tag"; state.tag = tag; state.feed = null; state.folder = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
async function addTagToItem(x, rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return;
  x.tags = x.tags || [];
  if (x.tags.some(t => t.toLowerCase() === name.toLowerCase())) return;
  x.tags.push(name);
  if (!state.tags.some(t => t.toLowerCase() === name.toLowerCase())) {
    state.tags.push(name);
    state.tags.sort((a, b) => a.localeCompare(b));
    saveTags();
  }
  await put(x);
  render();
  renderReader(x);
  $("#tagInput")?.focus();
}
async function removeTagFromItem(x, name) {
  x.tags = (x.tags || []).filter(t => t !== name);
  await put(x);
  // A tag left on no article stops being listed (tags created in the
  // dialog but never applied stay until deleted there).
  if (!state.items.some(i => (i.tags || []).includes(name))) {
    state.tags = state.tags.filter(t => t !== name);
    saveTags();
  }
  render();
  renderReader(x);
}
function createFolder(rawName) {
  const name = String(rawName || "").trim().slice(0, 60);
  if (!name) return toast("Enter a folder name.");
  if (state.folders.some(f => f.toLowerCase() === name.toLowerCase())) return toast("That folder already exists.");
  state.folders.push(name);
  state.folders.sort((a, b) => a.localeCompare(b));
  saveFolders();
  renderOrganize();
  render();
  toast("Folder added.");
}
function createTag(rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return toast("Enter a tag name.");
  if (state.tags.some(t => t.toLowerCase() === name.toLowerCase())) return toast("That tag already exists.");
  state.tags.push(name);
  state.tags.sort((a, b) => a.localeCompare(b));
  saveTags();
  renderOrganize();
  render();
  toast("Tag added.");
}
function renameFolder(oldName, rawName) {
  const name = String(rawName || "").trim().slice(0, 60);
  if (!name || name === oldName) return;
  if (state.folders.some(f => f.toLowerCase() === name.toLowerCase())) return toast("That folder already exists.");
  state.folders = state.folders.map(f => f === oldName ? name : f);
  if (collapsedFolders.has(oldName)) { collapsedFolders.delete(oldName); collapsedFolders.add(name); saveCollapsedFolders(); }
  for (const f of state.feeds) if (f.group === oldName) f.group = name;
  saveFolders();
  saveFeeds();
  toast("Folder renamed.");
}
/* Deletes use a two-step confirm inside the dialog (click Delete, then
   click Confirm delete) instead of a native confirm(), which some
   browsers dismiss without the user ever seeing it. */
function deleteFolder(name) {
  if (!pendingDelete || pendingDelete.kind !== "folder" || pendingDelete.name !== name) {
    pendingDelete = { kind: "folder", name };
    renderOrganize();
    toast("Click Delete again to remove the folder.");
    return;
  }
  pendingDelete = null;
  for (const f of state.feeds) if (f.group === name) f.group = "";
  state.folders = state.folders.filter(f => f !== name);
  if (collapsedFolders.has(name)) { collapsedFolders.delete(name); saveCollapsedFolders(); }
  saveFeeds();
  saveFolders();
  renderOrganize();
  render();
  toast("Folder deleted.");
}
async function renameTag(oldName, rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name || name === oldName) return;
  if (state.tags.some(t => t.toLowerCase() === name.toLowerCase())) return toast("That tag already exists.");
  state.tags = state.tags.map(t => t === oldName ? name : t);
  const changed = [];
  for (const x of state.items) {
    if ((x.tags || []).includes(oldName)) {
      x.tags = x.tags.map(t => t === oldName ? name : t);
      changed.push(x);
    }
  }
  // One batched write instead of a transaction per tagged article.
  if (changed.length) await putMany(changed);
  if (state.view === "tag" && state.tag === oldName) state.tag = name;
  saveTags();
  toast("Tag renamed.");
}
async function deleteTag(name) {
  if (!pendingDelete || pendingDelete.kind !== "tag" || pendingDelete.name !== name) {
    pendingDelete = { kind: "tag", name };
    renderOrganize();
    toast("Click Delete again to remove the tag.");
    return;
  }
  pendingDelete = null;
  const changed = [];
  for (const x of state.items) {
    if ((x.tags || []).includes(name)) {
      x.tags = x.tags.filter(t => t !== name);
      changed.push(x);
    }
  }
  if (changed.length) await putMany(changed);
  state.tags = state.tags.filter(t => t !== name);
  if (state.view === "tag" && state.tag === name) goView("all");
  saveTags();
  renderOrganize();
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  toast("Tag deleted.");
}
function moveFeed(feedId, folder) {
  const f = state.feeds.find(f => f.id === feedId);
  if (!f) return;
  f.group = folder;
  saveFeeds();
  syncFolders();
  renderOrganize();
  render();
  toast(folder ? `Moved to “${folder}”.` : "Moved out of its folder.");
}
/* Unsubscribing uses the same two-step confirm as folder and tag
   deletes (click once to arm, click again to confirm) instead of a
   native confirm(), which some browsers dismiss without the user ever
   seeing it. The feed's articles go with it, except ones the user
   saved — those stay in Saved, and merge back if the feed is ever
   re-added (saveItems preserves saved/read/tags/fullContent). */
function requestUnsubscribe(id) {
  const f = state.feeds.find(f => f.id === id);
  if (!f) return;
  if (!pendingDelete || pendingDelete.kind !== "feed" || pendingDelete.id !== id) {
    pendingDelete = { kind: "feed", id };
    renderNav();
    renderOrganize();
    toast(`Click again to unsubscribe from “${f.title}”.`);
    return;
  }
  unsubscribeFeed(id);
}
async function unsubscribeFeed(id) {
  const f = state.feeds.find(f => f.id === id);
  if (!f) return;
  pendingDelete = null;
  const idx = state.feeds.findIndex(x => x.id === id);
  const removed = state.items.filter(x => x.feedId === id && !x.saved);
  state.feeds = state.feeds.filter(x => x.id !== id);
  saveFeeds();
  if (removed.length) await deleteMany(removed.map(x => x.id));
  state.items = state.items.filter(x => x.feedId !== id || x.saved);
  const used = new Set();
  for (const x of state.items) for (const t of x.tags || []) used.add(t);
  if (state.tags.some(t => !used.has(t))) { state.tags = state.tags.filter(t => used.has(t)); saveTags(); }
  if (state.view === "feed" && state.feed === id) { state.view = "all"; state.feed = ""; }
  render();
  renderOrganize();
  if (state.selected) {
    const x = selectedItem();
    if (x) renderReader(x);
    else closeReader();
  }
  toast(`Unsubscribed from “${f.title}”. Saved articles were kept.`, { label: "Undo", fn: async () => {
    state.feeds.splice(idx, 0, f);
    saveFeeds();
    if (removed.length) {
      await putMany(removed);
      // Merge by id: a refresh between the unsubscribe and the Undo
      // may have re-added these articles, and concatenating would
      // duplicate them in memory.
      const byId = new Map(state.items.map(x => [x.id, x]));
      for (const x of removed) byId.set(x.id, x);
      state.items = [...byId.values()];
    }
    render();
  } });
}
async function doRename(rawName) {
  if (!orgEdit) return;
  const { kind, old } = orgEdit;
  orgEdit = null;
  if (kind === "folder") renameFolder(old, rawName);
  else if (kind === "savedSearch") renameSavedSearch(old, rawName);
  else await renameTag(old, rawName);
  renderOrganize();
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
}
/* Rename a saved search (#108): only the name changes, the filter
   stays as it is. */
function renameSavedSearch(id, rawName) {
  const name = (rawName || "").trim();
  const s = state.savedSearches.find(v => v.id === id);
  if (!s || !name) return;
  s.name = name;
  saveSavedSearches();
  toast(`Renamed to “${name}”.`);
}
function deleteSavedSearch(id) {
  if (!pendingDelete || pendingDelete.kind !== "savedSearch" || pendingDelete.id !== id) {
    pendingDelete = { kind: "savedSearch", id };
    renderOrganize();
    toast("Click Delete again to remove the saved search.");
    return;
  }
  pendingDelete = null;
  state.savedSearches = state.savedSearches.filter(v => v.id !== id);
  saveSavedSearches();
  if (state.view === "savedSearch" && state.savedSearch === id) goView("all");
  renderOrganize();
  render();
  toast("Saved search deleted.");
}
function renderOrganize() {
  const folderRow = name => {
    const count = state.feeds.filter(f => f.group === name).length;
    const armed = pendingDelete?.kind === "folder" && pendingDelete.name === name;
    if (orgEdit?.kind === "folder" && orgEdit.old === name) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(name)}" aria-label="Folder name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    return `<div class="org-row"><span class="org-name">${esc(name)}</span><small>${count} feed${count === 1 ? "" : "s"}</small><button type="button" class="quiet" data-org-rename-folder="${esc(name)}">Rename</button><button type="button" class="quiet" data-org-delete-folder="${esc(name)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  const tagRow = name => {
    const count = state.items.filter(x => (x.tags || []).includes(name)).length;
    const armed = pendingDelete?.kind === "tag" && pendingDelete.name === name;
    if (orgEdit?.kind === "tag" && orgEdit.old === name) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(name)}" aria-label="Tag name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    return `<div class="org-row"><span class="org-name">${icon("tag")} ${esc(name)}</span><small>${count} article${count === 1 ? "" : "s"}</small><button type="button" class="quiet" data-org-rename-tag="${esc(name)}">Rename</button><button type="button" class="quiet" data-org-delete-tag="${esc(name)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  const savedSearchRow = s => {
    const armed = pendingDelete?.kind === "savedSearch" && pendingDelete.id === s.id;
    if (orgEdit?.kind === "savedSearch" && orgEdit.old === s.id) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(s.name)}" aria-label="Saved search name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    const desc = [s.query, s.tag ? "tag: " + s.tag : "", s.unreadOnly ? "unread only" : ""].filter(Boolean).join(" · ") || "All articles";
    return `<div class="org-row"><span class="org-name">${esc(s.name)}</span><small>${esc(desc)}</small><button type="button" class="quiet" data-org-rename-saved-search="${esc(s.id)}">Rename</button><button type="button" class="quiet" data-org-delete-saved-search="${esc(s.id)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  $("#organizeBody").innerHTML = `
    <div class="org-section"><h3>Folders</h3><p class="muted">Group your feeds. Deleting a folder keeps its feeds, ungrouped.</p>${state.folders.map(folderRow).join("") || '<p class="muted">No folders yet.</p>'}<div class="org-new"><input id="newFolder" placeholder="New folder name" aria-label="New folder name"><button type="button" class="primary" data-org-add-folder>Add</button></div></div>
    <div class="org-section"><h3>Feeds</h3><p class="muted">Move each feed into a folder, mute it, or unsubscribe from it.</p>${state.feeds.map(f => { const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id; return `<div class="org-row"><span class="org-name">${esc(f.title)}</span><select data-org-move="${esc(f.id)}" aria-label="Folder for ${esc(f.title)}"><option value="">No folder</option>${state.folders.map(g => `<option value="${esc(g)}" ${f.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select><button type="button" class="quiet" data-org-mute="${esc(f.id)}">${f.muted ? "Unmute" : "Mute"}</button><button type="button" class="quiet" data-org-unsub="${esc(f.id)}">${armed ? "Confirm unsubscribe" : "Unsubscribe"}</button></div>`; }).join("") || '<p class="muted">No feeds yet.</p>'}</div>
    <div class="org-section"><h3>Tags</h3><p class="muted">Tags are applied to articles from the reader (press t). Renaming a tag updates every article that has it.</p>${state.tags.map(tagRow).join("") || '<p class="muted">No tags yet.</p>'}<div class="org-new"><input id="newTag" placeholder="New tag name" aria-label="New tag name"><button type="button" class="primary" data-org-add-tag>Add</button></div></div>
    <div class="org-section"><h3>Saved searches</h3><p class="muted">Named filters kept in the sidebar. Deleting one only removes the filter, not any articles.</p>${state.savedSearches.map(savedSearchRow).join("") || '<p class="muted">No saved searches yet.</p>'}</div>`;
}
function showOrganize() {
  orgEdit = null;
  renderOrganize();
  $("#organizeDialog").showModal();
}
function showFeed() {
  $("#feedError").textContent = "";
  $("#feedSearchInput").value = "";
  $("#feedSearchStatus").textContent = "Type an address to add it, or a name or topic to search.";
  $("#feedSearchResults").innerHTML = "";
  window.feedDiscoveryResults = [];
  $("#feedDialog").showModal();
  $("#feedSearchInput").focus();
}
/* Save a search (#108): the dialog is prefilled from the current state
   — the search box, the view (feed, folder, tag, or unread), and the
   tag — so the common case is just naming it. */
function showSaveSearch() {
  const scope = $("#saveSearchScope");
  const groups = [...new Set(state.feeds.map(f => f.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  scope.innerHTML = `<option value="all">All feeds</option>` +
    groups.map(g => `<option value="folder:${esc(g)}">Folder: ${esc(g)}</option>`).join("") +
    state.feeds.map(f => `<option value="feed:${esc(f.id)}">Feed: ${esc(f.title)}</option>`).join("");
  const tagSel = $("#saveSearchTag");
  tagSel.innerHTML = `<option value="">Any tag</option>` + state.tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  // The current view becomes the scope: a feed view scopes to that
  // feed, a folder view to that folder, a tag view to that tag, and
  // the Unread view turns on unread-only.
  let curScope = "all", curTag = "", curUnread = false;
  if (state.view === "feed" && state.feed) curScope = "feed:" + state.feed;
  else if (state.view === "folder" && state.folder) curScope = "folder:" + state.folder;
  else if (state.view === "tag" && state.tag) curTag = state.tag;
  else if (state.view === "unread") curUnread = true;
  else if (state.view === "savedSearch") {
    const s = state.savedSearches.find(v => v.id === state.savedSearch);
    if (s) { curScope = s.scope || "all"; curTag = s.tag || ""; curUnread = !!s.unreadOnly; }
  }
  scope.value = curScope;
  tagSel.value = curTag;
  $("#saveSearchUnread").checked = curUnread;
  $("#saveSearchQuery").value = state.query;
  $("#saveSearchName").value = "";
  $("#saveSearchDialog").showModal();
  $("#saveSearchName").focus();
}
function saveSearchFromDialog() {
  const name = $("#saveSearchName").value.trim();
  if (!name) { toast("Give the saved search a name."); return; }
  const s = {
    id: id(), name,
    query: $("#saveSearchQuery").value.trim(),
    scope: $("#saveSearchScope").value || "all",
    tag: $("#saveSearchTag").value || "",
    unreadOnly: $("#saveSearchUnread").checked
  };
  state.savedSearches.push(s);
  saveSavedSearches();
  $("#saveSearchDialog").close();
  render();
  goSavedSearch(s.id);
  toast(`Saved search “${name}”.`);
}
/* ---------- rules (#109) ---------- */
/* A rule in plain words, for the list: what it matches and what it does. */
function ruleDesc(r) {
  const scope = r.scope?.startsWith("feed:") ? "Feed: " + (state.feeds.find(f => f.id === r.scope.slice(5))?.title || "a feed")
    : r.scope?.startsWith("folder:") ? "Folder: " + r.scope.slice(7) : "All feeds";
  const cond = [r.keyword ? `title contains “${r.keyword}”` : "", r.author ? `author contains “${r.author}”` : ""].filter(Boolean).join(", ") || "any article";
  const act = [r.tag ? `tag “${r.tag}”` : "", r.save ? "save" : "", r.markRead ? "mark read" : ""].filter(Boolean).join(", ") || "nothing";
  return `${scope} · ${cond} → ${act}`;
}
function renderRules() {
  const editorHTML = cur => {
    const groups = [...new Set(state.feeds.map(f => f.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return `<div class="org-section"><label>Name<input id="ruleName" type="text" value="${esc(cur.name)}" placeholder="e.g. Save every post from this feed"></label><label>Look in<select id="ruleScope"><option value="all">All feeds</option>${groups.map(g => `<option value="folder:${esc(g)}" ${cur.scope === "folder:" + g ? "selected" : ""}>Folder: ${esc(g)}</option>`).join("")}${state.feeds.map(f => `<option value="feed:${esc(f.id)}" ${cur.scope === "feed:" + f.id ? "selected" : ""}>Feed: ${esc(f.title)}</option>`).join("")}</select></label><label>Title contains<input id="ruleKeyword" type="text" value="${esc(cur.keyword || "")}" placeholder="Optional"></label><label>Author contains<input id="ruleAuthor" type="text" value="${esc(cur.author || "")}" placeholder="Optional"></label><label>Add tag<input id="ruleTag" type="text" list="tagList" value="${esc(cur.tag || "")}" placeholder="Optional"></label><label class="setting">Save the article<input id="ruleSave" type="checkbox" ${cur.save ? "checked" : ""}></label><label class="setting">Mark the article read<input id="ruleMarkRead" type="checkbox" ${cur.markRead ? "checked" : ""}></label><div class="dialog-actions"><button type="button" class="quiet" data-rule-cancel>Cancel</button><button type="button" class="primary" data-rule-save>${ruleEdit === "new" ? "Add rule" : "Save rule"}</button></div></div>`;
  };
  const row = r => {
    const armed = pendingDelete?.kind === "rule" && pendingDelete.id === r.id;
    if (ruleEdit === r.id) return editorHTML(r);
    return `<div class="org-row"><span class="org-name">${esc(r.name)}</span><small>${esc(ruleDesc(r))}</small><button type="button" class="quiet" data-rule-toggle="${esc(r.id)}" aria-pressed="${r.enabled !== false}">${r.enabled !== false ? "On" : "Off"}</button><button type="button" class="quiet" data-rule-edit="${esc(r.id)}">Edit</button><button type="button" class="quiet" data-rule-delete="${esc(r.id)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  // The editor replaces the row being edited, or sits above the list
  // when adding a new rule; otherwise the list ends with an Add button.
  const body = state.rules.length ? state.rules.map(row).join("") : '<p class="muted">No rules yet. Rules tag, save, or mark read new articles as they arrive.</p>';
  $("#rulesBody").innerHTML = (ruleEdit === "new" ? editorHTML({ name: "", scope: "all", keyword: "", author: "", tag: "", save: false, markRead: false }) : "") + body + (ruleEdit ? "" : `<div class="org-new"><button type="button" class="primary" data-rule-add>Add a rule</button></div>`);
  syncRuleSave();
}
function showRules() {
  ruleEdit = null;
  pendingDelete = null;
  renderRules();
  $("#rulesDialog").showModal();
}
function syncRuleSave() {
  const btn = document.querySelector("[data-rule-save]");
  if (!btn) return;
  btn.disabled = !($("#ruleTag")?.value.trim() || $("#ruleSave")?.checked || $("#ruleMarkRead")?.checked);
}
function saveRuleFromDialog() {
  const name = $("#ruleName")?.value.trim();
  if (!name) { toast("Give the rule a name."); return; }
  const data = {
    name,
    scope: $("#ruleScope")?.value || "all",
    keyword: $("#ruleKeyword")?.value.trim() || "",
    author: $("#ruleAuthor")?.value.trim() || "",
    tag: $("#ruleTag")?.value.trim() || "",
    save: $("#ruleSave")?.checked || false,
    markRead: $("#ruleMarkRead")?.checked || false
  };
  if (!data.tag && !data.save && !data.markRead) { toast("Pick at least one thing for the rule to do — add a tag, save the article, or mark it read."); return; }
  if (ruleEdit === "new") {
    state.rules.push({ id: id(), enabled: true, ...data });
    toast(`Rule “${name}” added. It runs on new articles at refresh.`);
  } else {
    const r = state.rules.find(v => v.id === ruleEdit);
    if (r) Object.assign(r, data);
    toast(`Rule “${name}” saved.`);
  }
  ruleEdit = null;
  saveRules();
  renderRules();
}
function deleteRule(id) {
  if (!pendingDelete || pendingDelete.kind !== "rule" || pendingDelete.id !== id) {
    pendingDelete = { kind: "rule", id };
    renderRules();
    toast("Click Delete again to remove the rule.");
    return;
  }
  pendingDelete = null;
  state.rules = state.rules.filter(v => v.id !== id);
  saveRules();
  renderRules();
  toast("Rule deleted.");
}
function download(data, name, type) {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
const xml = s => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

/* ---------- OPML / settings import-export ---------- */
function exportOPML() {
  const groups = {};
  for (const f of state.feeds) (groups[f.group || ""] ||= []).push(f);
  const row = f => `<outline text="${xml(f.title)}" title="${xml(f.title)}" type="rss" xmlUrl="${xml(f.url)}" htmlUrl="${xml(f.site)}"/>`;
  const body = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(g =>
    g ? `<outline text="${xml(g)}" title="${xml(g)}">${groups[g].map(row).join("")}</outline>` : groups[g].map(row).join("")
  ).join("");
  download(`<?xml version="1.0"?><opml version="2.0"><head><title>RSS Reader subscriptions</title></head><body>${body}</body></opml>`, "rss-reader-subscriptions.opml", "text/xml");
}
async function importOPML(file, selectedUrls = null) {
  const d = new DOMParser().parseFromString(await file.text(), "text/xml");
  if (d.querySelector("parsererror") || d.documentElement.localName !== "opml") return toast("Invalid OPML file.");
  let added = 0, skipped = 0, failed = 0, done = 0;
  const jobs = [];
  const seenBatch = new Set();
  for (const o of d.querySelectorAll("outline[xmlUrl]")) {
    const rawUrl = o.getAttribute("xmlUrl");
    let url;
    try { url = normalizeFeedUrl(rawUrl); } catch { skipped++; continue; }
    if (selectedUrls && !selectedUrls.has(url)) continue;
    if (state.feeds.some(f => sameFeedUrl(f.url, url)) || seenBatch.has(url)) { skipped++; continue; }
    seenBatch.add(url);
    const parent = o.parentElement;
    const group = parent && parent.localName === "outline" ? (parent.getAttribute("text") || parent.getAttribute("title") || "") : "";
    jobs.push(async () => {
      try {
        const loaded = await loadFeedFromUrl(url);
        const feed = {
          id: id(), url: loaded.url, title: loaded.parsed.title, site: loaded.parsed.site,
          added: new Date().toISOString(), error: "", via: loaded.via, wpRoot: loaded.wpRoot || "", group, lastAttempt: Date.now(), lastSuccess: Date.now(), retrievalPath: loaded.via, consecutiveFailures: 0
        };
        state.feeds.push(feed);
        await saveItems(feed, loaded.parsed.items);
        added++;
      } catch (e) { failed++; }
      // Update the progress toast only every 5 feeds: rewriting it on
      // every completion makes it flicker through a large import.
      finally { done++; if (done % 5 === 0 || done === jobs.length) toast(`Importing feeds… ${done} of ${jobs.length}`); }
    });
  }
  // Cap concurrency so a large import does not fire all fetches at once.
  const pool = async (fns, n) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
      while (i < fns.length) { const fn = fns[i++]; await fn(); }
    }));
  };
  await pool(jobs, 3);
  saveFeeds();
  syncFolders();
  saveFolders();
  render();
  toast(`Imported ${added} feed${added === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped (duplicate or invalid)` : ""}${failed ? `, ${failed} failed to load` : ""}.`);
}
function exportSettings() {
  download(JSON.stringify({ format: "rss-reader-settings", version: 1, settings: state.settings }, null, 2), "rss-reader-settings.json", "application/json");
}
async function importSettings(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.format !== "rss-reader-settings" || d.version !== 1 || !d.settings || typeof d.settings !== "object") throw Error("Unsupported settings file.");
    const next = validateSettings(d.settings);
    if (!Object.keys(next).length) throw Error("No valid settings found in this file.");
    state.settings = { ...state.settings, ...next };
    state.sort = state.settings.sort || "newest";
    state.filter = state.settings.filter || "all";
    local(S, state.settings);
    applySettings();
    mirrorSync();
    applyBackgroundSync();
    render();
    toast("Settings imported.");
  } catch (e) { toast(e.message); }
}
let pendingOPMLFile = null, pendingOPMLFeedUrls = [];
let pointerActivation = null, coachTimer = null;
async function exportCompleteBackup(){try{const d={format:"rss-reader-backup",version:1,exportedAt:new Date().toISOString(),profile:{feeds:state.feeds,folders:state.folders,tags:state.tags,savedSearches:state.savedSearches,rules:state.rules,settings:state.settings,notes:articleNotes,collapsedFolders:[...collapsedFolders],lastRefresh:state.lastRefresh||0},items:await dbAll(),highlights:await hlAll()};download(JSON.stringify(d,null,2),"rss-reader-backup.json","application/json");toast("Complete profile backup exported.");}catch(e){toast("Backup export failed: "+e.message);}}
function validateCompleteBackup(d){if(!d||d.format!=="rss-reader-backup"||d.version!==1||!d.profile||!Array.isArray(d.profile.feeds)||!Array.isArray(d.items)||!Array.isArray(d.highlights)||!d.profile.settings||typeof d.profile.settings!=="object")throw Error("Unsupported or incomplete backup file.");if(!d.profile.feeds.every(x=>x&&typeof x.id==="string"&&typeof x.url==="string")||!d.items.every(x=>x&&typeof x.id==="string"&&typeof x.feedId==="string")||!d.highlights.every(x=>x&&typeof x.id==="string"&&typeof x.itemId==="string"))throw Error("Backup contains invalid records.");return d;}
async function importCompleteBackup(file) {
  let backup;
  let settings;
  try {
    backup = validateCompleteBackup(JSON.parse(await file.text()));
    settings = validateSettings(backup.profile.settings);
    for (const key of ["folders", "tags", "savedSearches", "rules"]) {
      if (backup.profile[key] !== undefined && !Array.isArray(backup.profile[key])) {
        throw new Error("Backup contains an invalid " + key + " collection.");
      }
    }
    if (backup.profile.notes !== undefined &&
        (!backup.profile.notes || typeof backup.profile.notes !== "object" || Array.isArray(backup.profile.notes))) {
      throw new Error("Backup contains invalid article notes.");
    }
  } catch (error) {
    toast("Backup validation failed: " + error.message);
    return;
  }

  const summary = "Backup contains " + backup.profile.feeds.length + " feeds, " +
    backup.items.length + " articles, and " + backup.highlights.length +
    " highlights. Choose OK to replace this profile. Choose Cancel to merge it into the current profile.";
  const replace = confirm(summary);
  if (!replace && !confirm("Merge backup records? Existing records with matching IDs or feed URLs will be kept.")) return;

  const storageKeys = [K, KF, KT, KS, KR, S, NK, COLLAPSED_FOLDERS_KEY];
  const previousStorage = new Map(storageKeys.map(key => [key, localStorage.getItem(key)]));
  const previousState = {
    feeds: state.feeds, folders: state.folders, tags: state.tags,
    savedSearches: state.savedSearches, rules: state.rules, settings: state.settings,
    notes: articleNotes, collapsedFolders, lastRefresh: state.lastRefresh,
    items: state.items, highlights: state.highlights
  };

  let previousItems;
  let previousHighlights;
  let transactionCommitted = false;
  try {
    previousItems = await dbAll();
    previousHighlights = await hlAll();
    const mergeById = (current, incoming) => {
      const map = new Map(current.map(item => [item.id, item]));
      for (const item of incoming) if (!map.has(item.id)) map.set(item.id, item);
      return [...map.values()];
    };
    const items = replace ? backup.items : mergeById(previousItems, backup.items);
    const highlights = replace ? backup.highlights : mergeById(previousHighlights, backup.highlights);
    const profile = backup.profile;

    const tx = db.transaction(["items", "highlights"], "readwrite");
    const itemStore = tx.objectStore("items");
    const highlightStore = tx.objectStore("highlights");
    if (replace) { itemStore.clear(); highlightStore.clear(); }
    for (const item of items) itemStore.put(item);
    for (const highlight of highlights) highlightStore.put(highlight);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Restore transaction aborted."));
    });
    transactionCommitted = true;

    if (replace) {
      state.feeds = [...profile.feeds];
      state.folders = Array.isArray(profile.folders) ? [...profile.folders] : [];
      state.tags = Array.isArray(profile.tags) ? [...profile.tags] : [];
      state.savedSearches = Array.isArray(profile.savedSearches) ? [...profile.savedSearches] : [];
      state.rules = Array.isArray(profile.rules) ? [...profile.rules] : [];
      state.settings = { ...state.settings, ...settings };
      articleNotes = profile.notes || {};
      collapsedFolders = new Set(Array.isArray(profile.collapsedFolders) ? profile.collapsedFolders : []);
      state.lastRefresh = Number(profile.lastRefresh) || 0;
    } else {
      state.feeds = [...state.feeds, ...profile.feeds.filter(incoming =>
        !state.feeds.some(existing => existing.id === incoming.id || sameFeedUrl(existing.url, incoming.url))
      )];
      state.folders = [...new Set([...state.folders, ...(profile.folders || [])])];
      state.tags = [...new Set([...state.tags, ...(profile.tags || [])])];
      state.savedSearches = mergeById(state.savedSearches, profile.savedSearches || []);
      state.rules = mergeById(state.rules, profile.rules || []);
      articleNotes = { ...articleNotes, ...(profile.notes || {}) };
      collapsedFolders = new Set([...collapsedFolders, ...(profile.collapsedFolders || [])]);
    }

    localStorage.setItem(K, JSON.stringify(state.feeds));
    localStorage.setItem(KF, JSON.stringify(state.folders));
    localStorage.setItem(KT, JSON.stringify(state.tags));
    localStorage.setItem(KS, JSON.stringify(state.savedSearches));
    localStorage.setItem(KR, JSON.stringify(state.rules));
    localStorage.setItem(S, JSON.stringify(state.settings));
    localStorage.setItem(NK, JSON.stringify(articleNotes));
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...collapsedFolders]));

    state.items = items;
    state.highlights = highlights;
    syncFolders();
    applySettings();
    mirrorSync();
    render();
    toast("Backup restored: " + state.feeds.length + " feeds, " + items.length +
      " articles, and " + highlights.length + " highlights.");
  } catch (error) {
    console.error(error);
    try {
      if (transactionCommitted) {
        const rollback = db.transaction(["items", "highlights"], "readwrite");
        const itemStore = rollback.objectStore("items");
        const highlightStore = rollback.objectStore("highlights");
        itemStore.clear();
        highlightStore.clear();
        for (const item of previousItems || []) itemStore.put(item);
        for (const highlight of previousHighlights || []) highlightStore.put(highlight);
        await new Promise((resolve, reject) => {
          rollback.oncomplete = resolve;
          rollback.onerror = () => reject(rollback.error);
          rollback.onabort = () => reject(rollback.error || new Error("Rollback aborted."));
        });
      }
      for (const [key, value] of previousStorage) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      state.feeds = previousState.feeds;
      state.folders = previousState.folders;
      state.tags = previousState.tags;
      state.savedSearches = previousState.savedSearches;
      state.rules = previousState.rules;
      state.settings = previousState.settings;
      articleNotes = previousState.notes;
      collapsedFolders = previousState.collapsedFolders;
      state.lastRefresh = previousState.lastRefresh;
      state.items = previousState.items;
      state.highlights = previousState.highlights;
      render();
    } catch (rollbackError) {
      console.error("Backup rollback failed", rollbackError);
      toast("Restore failed and rollback was incomplete. Close other tabs and check available browser storage.");
      return;
    }
    toast("Restore failed. Your previous profile was restored: " + error.message);
  }
}
function exportAnnotations(format){const byId=new Map(state.items.map(x=>[x.id,x]));const rows=[...state.highlights.map(h=>{const x=byId.get(h.itemId)||{};return {type:"highlight",title:x.title||"",url:x.url||"",feed:x.feedTitle||"",text:h.text||h.quote||"",note:h.note||"",createdAt:h.created||null,updatedAt:h.updated||null};}),...Object.entries(articleNotes).map(([id,note])=>{const x=byId.get(id)||{};return {type:"note",title:x.title||"",url:x.url||"",feed:x.feedTitle||"",note,createdAt:null,updatedAt:null};})];if(format==="json"){download(JSON.stringify({format:"rss-reader-annotations",version:1,annotations:rows},null,2),"rss-reader-annotations.json","application/json");return;}const md=rows.map(x=>"## "+(x.title||"Untitled article")+"\n\nSource: "+(x.url||"Unavailable")+"\n\nFeed: "+(x.feed||"Unknown")+"\n\n"+(x.createdAt?"Created: "+new Date(x.createdAt).toISOString()+"\n\n":"")+(x.updatedAt?"Updated: "+new Date(x.updatedAt).toISOString()+"\n\n":"")+(x.text?"> "+x.text+"\n\n":"")+(x.note||"")).join("\n---\n\n");download(md,"rss-reader-annotations.md","text/markdown");}
async function updateStorageUsage(){const el=$("#storageUsage");if(!el)return;if(!navigator.storage?.estimate){el.textContent="Storage usage estimates are unavailable.";return;}try{const d=await navigator.storage.estimate(),fmt=n=>n<1048576?Math.round(n/1024)+" KB":(n/1048576).toFixed(1)+" MB";el.textContent="Approximate browser storage: "+fmt(d.usage||0)+" used of "+(d.quota?fmt(d.quota):"unknown quota")+". ";}catch{el.textContent="Storage usage could not be read.";}}
async function previewRetentionCleanup() {
  const days = Number(state.settings.retentionDays) || 0;
  const limit = Number(state.settings.retentionCount) || 0;
  if (!days && !limit) { toast("Choose an article age limit or maximum count in Settings first."); return; }
  const protectedIds = new Set([...state.highlights.map(x => x.itemId), ...Object.keys(articleNotes)]);
  const sorted = [...state.items].sort((a,b) => (dateSortKey(b) || 0) - (dateSortKey(a) || 0));
  const beyondLimit = limit ? new Set(sorted.slice(limit).map(x => x.id)) : new Set();
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const removable = sorted.filter(item => {
    const timestamp = dateSortKey(item);
    const tooOld = days && timestamp && timestamp < cutoff;
    const beyondCount = limit && beyondLimit.has(item.id);
    return (tooOld || beyondCount) && !item.saved && !item.queued && !protectedIds.has(item.id);
  });
  if (!removable.length) { toast("No unprotected articles exceed the selected retention limits."); return; }
  if (!confirm("Remove " + removable.length + " articles outside the selected retention limits? Saved, queued, highlighted, and noted articles are protected.")) return;
  const ids = removable.map(x => x.id);
  for (let i = 0; i < ids.length; i += 250) await deleteMany(ids.slice(i, i + 250));
  const removed = new Set(ids);
  state.items = state.items.filter(x => !removed.has(x.id));
  render();
  updateStorageUsage();
  toast("Removed " + ids.length + " old or excess articles.");
}
function showFeedHealth() {
  const now = Date.now();
  const unhealthy = state.feeds.map(feed => {
    const interval = (Number(feed.refreshMinutes) || Number(state.settings.globalRefreshMinutes) || 30) * 60000;
    const stale = !!feed.lastSuccess && now - feed.lastSuccess > interval * 3;
    const failed = !!feed.error;
    const status = failed ? "Failing" : stale ? "Stale" : feed.lastSuccess ? "Healthy" : "No refresh history";
    return { feed, stale, failed, status };
  }).filter(x => x.failed || x.stale || !x.feed.lastSuccess);
  if (!unhealthy.length) {
    $("#feedHealthList").innerHTML = "<p>All subscriptions have a recent successful refresh.</p>";
  } else {
    $("#feedHealthList").innerHTML = unhealthy.map(({feed,stale,failed,status}) =>
      '<section class="health-row"><strong>' + esc(feed.title || feed.url) + '</strong><p>' + status +
      (feed.lastSuccess ? ' · Last success: ' + esc(new Date(feed.lastSuccess).toLocaleString()) : ' · No successful refresh recorded') +
      (feed.lastAttempt ? ' · Last attempt: ' + esc(new Date(feed.lastAttempt).toLocaleString()) : '') +
      (feed.consecutiveFailures ? ' · Failures: ' + Number(feed.consecutiveFailures) : '') +
      '</p>' + (feed.error ? '<p class="muted">Current error: ' + esc(feed.error) + '</p>' : feed.lastError ? '<p class="muted">Most recent error: ' + esc(feed.lastError) + (feed.lastErrorAt ? " · " + esc(new Date(feed.lastErrorAt).toLocaleString()) : "") + '</p>' : '') +
      '<button type="button" class="quiet" data-health-retry="' + esc(feed.id) + '">Retry feed</button></section>'
    ).join("");
  }
  $("#feedHealthDialog").showModal();
}
function showReadingStats(days = 30) {
  const read = state.items.filter(item => item.read);
  const recent = read.filter(item => item.readAt && (days === 0 || Date.now() - item.readAt <= days * 86400000));
  const daily = new Map();
  const byFeed = new Map();
  for (const item of recent) {
    const day = new Date(item.readAt).toLocaleDateString();
    daily.set(day, (daily.get(day) || 0) + 1);
    const feed = state.feeds.find(entry => entry.id === item.feedId);
    const name = feed?.title || item.feedTitle || "Unknown feed";
    byFeed.set(name, (byFeed.get(name) || 0) + 1);
  }
  const rows = [...daily.entries()].sort((a,b) => new Date(a[0]) - new Date(b[0])).slice(-30);
  const topFeeds = [...byFeed.entries()].sort((a,b) => b[1] - a[1]).slice(0,5);
  const period = days === 0 ? "all recorded history" : "the last " + days + " days";
  const queued = state.items.filter(item => item.queued);
  const completedQueue = queued.filter(item => item.read).length;
  $("#statsBody").innerHTML =
    "<p>" + state.items.length + " cached articles</p>" +
    "<p>" + read.length + " currently marked read</p>" +
    "<p>" + recent.length + " articles marked read during " + period + "</p>" +
    "<p>" + state.items.filter(item => item.saved).length + " saved · " + queued.length + " queued · " + completedQueue + " queued and read · " + state.highlights.length + " highlights</p>" +
    "<p class=\"muted\">Period totals use local read timestamps. Older read states without timestamps are excluded.</p>" +
    "<h3>Reading activity by day</h3>" +
    (rows.length ? rows.map(row => "<p>" + esc(row[0]) + ": " + row[1] + "</p>").join("") : "<p>No timestamped reading activity for this period.</p>") +
    "<h3>Most-read feeds</h3>" +
    (topFeeds.length ? topFeeds.map(row => "<p>" + esc(row[0]) + ": " + row[1] + "</p>").join("") : "<p>No feed-level reading history for this period.</p>");
  $("#statsDialog").showModal();
}
function previewOPML(file) {
  file.text().then(text => {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror") || doc.documentElement.localName !== "opml") {
      toast("Invalid OPML file.");
      return;
    }
    const entries = [];
    const folderPaths = new Set();
    const walk = (parent, path = []) => {
      for (const outline of [...parent.children].filter(node => node.localName === "outline")) {
        const title = outline.getAttribute("title") || outline.getAttribute("text") || outline.getAttribute("xmlUrl") || "Untitled";
        const url = outline.getAttribute("xmlUrl");
        if (url) entries.push({ outline, path, title, url });
        else {
          const nextPath = [...path, title];
          folderPaths.add(nextPath.join(" / "));
          walk(outline, nextPath);
        }
      }
    };
    walk(doc.querySelector("body") || doc.documentElement);
    const seen = new Set();
    const duplicates = [];
    const invalid = [];
    for (const entry of entries) {
      try {
        const url = normalizeFeedUrl(entry.url);
        if (seen.has(url) || state.feeds.some(feed => sameFeedUrl(feed.url, url))) {
          duplicates.push((entry.path.length ? entry.path.join(" / ") + " / " : "") + entry.title + " — " + url);
        }
        seen.add(url);
      } catch (error) {
        invalid.push(entry.title + " — " + entry.url + " (" + (error.message || "invalid URL") + ")");
      }
    }
    const folders = [...folderPaths];
    const normalizedByEntry = new Map();
    const invalidEntries = new Set();
    const seenUrls = new Set();
    const duplicateEntries = new Set();
    for (const entry of entries) {
      try {
        const url = normalizeFeedUrl(entry.url);
        normalizedByEntry.set(entry, url);
        if (seenUrls.has(url) || state.feeds.some(feed => sameFeedUrl(feed.url, url))) duplicateEntries.add(entry);
        seenUrls.add(url);
      } catch { invalidEntries.add(entry); }
    }
    const eligible = entries.filter(entry => normalizedByEntry.has(entry) && !duplicateEntries.has(entry) && !state.feeds.some(feed => sameFeedUrl(feed.url, normalizedByEntry.get(entry))));
    pendingOPMLFeedUrls = eligible.map(entry => normalizedByEntry.get(entry));
    $("#opmlPreviewSummary").textContent = eligible.length + " available feed" + (eligible.length === 1 ? "" : "s") + " selected by default. " + duplicateEntries.size + " duplicates and " + invalidEntries.size + " invalid URLs will be skipped."; 
    $("#opmlPreviewDetails").textContent = folders.length ? "Folders found: " + folders.join(" · ") : "No named folders."; 
    const eligibleEntries = new Set(eligible);
    $("#opmlFeedSelection").innerHTML = entries.map(entry => {
      const url = normalizedByEntry.get(entry) || "";
      const selectable = eligibleEntries.has(entry);
      const status = invalidEntries.has(entry) ? "Invalid URL" : !selectable ? "Duplicate or already subscribed" : "";
      const label = [...entry.path, entry.title].filter(Boolean).join(" / ");
      return '<label class="opml-feed-option' + (selectable ? "" : " unavailable") + '"><input type="checkbox" data-opml-feed="' + esc(url) + '"' + (selectable ? " checked" : " disabled") + '><span class="opml-feed-title">' + esc(label) + '</span>' + (status ? '<span class="opml-feed-status">' + esc(status) + '</span>' : "") + '</label>';
    }).join("");
    $("#opmlSelectAll").disabled = eligible.length === 0;
    $("#opmlSelectNone").disabled = eligible.length === 0;
    $("#opmlPreviewConfirm").disabled = eligible.length === 0;
    $("#opmlPreviewConfirm").textContent = eligible.length ? "Import " + eligible.length + " feeds" : "No new feeds to import";
    pendingOPMLFile = file;
    // The file picker is inside Settings. Wait for its close event before
    // opening the preview so the browser has removed it from the modal stack.
    const settingsDialog = $("#settingsDialog");
    if (settingsDialog?.open) settingsDialog.close();
    // Give the browser a frame to remove Settings from the top layer
    // before promoting the preview dialog to a modal.
    requestAnimationFrame(() => {
      const previewDialog = $("#opmlPreviewDialog");
      // Other app dialogs should be closed before promoting this one.
      $$("dialog[open]").forEach(dialog => {
        if (dialog !== previewDialog) dialog.close();
      });
      if (previewDialog.open) return;
      try {
        previewDialog.showModal();
      } catch (error) {
        // Keep the import usable if the browser rejects modal promotion
        // after the Settings dialog has closed.
        console.warn("Could not open the OPML preview as a modal.", error);
        previewDialog.show();
      }
    });
  }).catch(error => toast("Could not read OPML file: " + error.message));
}
function isShortcutCoachingAvailable() {
  return matchMedia("(min-width:821px)").matches;
}
function showShortcutCoach(label, shortcut) {
  const el = $("#shortcutCoach");
  if (!el) return;

  if (!isShortcutCoachingAvailable() || !shortcut) {
    el.classList.remove("show");
    return;
  }
  el.textContent = label + " · Shortcut: " + shortcut;
  el.classList.add("show");
  clearTimeout(coachTimer);
  coachTimer = setTimeout(() => el.classList.remove("show"), 7000);
}

function coachShortcut(e) {
  if (!isShortcutCoachingAvailable() || !state.settings.shortcutCoaching ||
      !isShortcutCoachPointerEvent(e, pointerActivation)) return;

  const target = e.target?.closest?.("button,a,[role='button'],summary,input[type='search'],input[type='button'],input[type='submit'],input[type='reset'],[data-action],[data-reader],[data-view],[data-rail-next-unread],[data-rail-search],[data-rail-refresh],[data-folder-toggle]");
  if (!target || target.closest("#shortcutCoach")) return;

  const readerAction = target.dataset.reader;
  const appAction = target.dataset.action;
  const view = target.dataset.view;
  let action = target.dataset.shortcutAction || readerAction || appAction || view ||
    (target.hasAttribute("data-rail-next-unread") ? "nextUnread" :
      target.hasAttribute("data-rail-search") ? "search" :
        target.hasAttribute("data-rail-refresh") ? "refresh" :
          target.hasAttribute("data-folder-toggle") ? "folderToggle" : target.id) || "";
  let label = target.getAttribute("aria-label") ||
    target.getAttribute("title") ||
    target.textContent?.replace(/\s+/g, " ").trim() ||
    target.value ||
    "Action";

  const knownActions = {
    save: ["save", "Save article"],
    read: ["toggleRead", "Toggle read state"],
    tags: ["tag", "Add article tag"],
    fulltext: ["fullArticle", "Toggle full article"],
    open: ["openOriginal", "Open original article"],
    close: ["closeReader", "Close article"],
    share: ["share", "Share article"],
    all: ["allView", "All articles"],
    unread: ["unreadView", "Unread"],
    saved: ["goSaved", "Saved articles"],
    snoozed: ["goSnoozed", "Snoozed articles"],
    highlights: ["goHighlights", "Highlights"],
    refresh: ["refresh", "Refresh feeds"],
    add: ["addFeed", "Add feed"],
    settings: ["goPrefs", "Settings"],
    railSettings: ["goPrefs", "Settings"],
    search: ["search", "Search"],
    sideToggle: ["sidebarToggle", "Toggle sidebar"],
    home: ["allView", "All articles"],
    back: ["closeReader", "Back to list"],
    mobileAdd: ["addFeed", "Add feed"],
    firstAdd: ["addFeed", "Add feed"],
    organize: ["goOrganize", "Folders and tags"]
  };
  const known = knownActions[action] || knownActions[target.id];
  if (known) [action, label] = known;

  if (target.dataset.id && !state.items.some(item => item.id === target.dataset.id)) return;

  const shortcutKey = findShortcutForAction(shortcutPreset(), action);
  if (!shortcutKey) return;
  const shortcut = shortcutKey.split(" ").map(displayDesc).join(" then ");
  showShortcutCoach(label, shortcut);
}
function toolbarOrderFromDialog() {
  const items = [...document.querySelectorAll("#toolbarOrderList [data-tb-key]")];
  if (!items.length) return null;
  return items.map(el => el.dataset.tbKey);
}
/* The Settings reorder list (#197): each toolbar button with up/down
   arrows. The order is read from the DOM when the user saves Settings. */
function renderToolbarOrderList(order) {
  const list = $("#toolbarOrderList");
  if (!list) return;
  order = order || toolbarOrder();
  list.innerHTML = order.map((k, i) => `<div class="toolbar-order-row" data-tb-key="${esc(k)}"><span>${esc(TOOLBAR_LABELS[k] || k)}</span><span class="toolbar-order-btns"><button type="button" class="quiet" data-tb-move="${i}:-1" aria-label="Move ${esc(TOOLBAR_LABELS[k] || k)} up" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="quiet" data-tb-move="${i}:1" aria-label="Move ${esc(TOOLBAR_LABELS[k] || k)} down" ${i === order.length - 1 ? "disabled" : ""}>↓</button></span></div>`).join("");
}
function showSettings() {
  $("#themeSelect").value = state.settings.theme;
  $("#widthSelect").value = state.settings.width;
  $("#sizeSelect").value = state.settings.size;
  $("#fontSelect").value = state.settings.readerFont || "serif";
  $("#lineHeightSelect").value = state.settings.lineHeight || "comfortable";
  $("#progressSelect").value = state.settings.progressPosition || "bottom";
  $("#mobileBarSelect").value = state.settings.mobileReaderBar || "bottom";
  $("#shortcutPresetSelect").value = state.settings.shortcutPreset || "inoreader";
  $("#cardExcerptSelect").value = state.settings.cardExcerpt || "full";
  $("#cardImageToggle").checked = state.settings.cardImage !== false;
  $("#hideDuplicatesToggle").checked = state.settings.hideDuplicates !== false;
  $("#backgroundSyncToggle").checked = !!state.settings.backgroundSync;
  $("#notifyNewToggle").checked = !!state.settings.notifyNew;
  $("#shortcutCoachingToggle").checked = !!state.settings.shortcutCoaching;
  $("#shortcutBarToggle").checked = state.settings.shortcutBar !== false;
  $("#retentionDaysSelect").value = String(state.settings.retentionDays || 0);
  $("#retentionCountSelect").value = String(state.settings.retentionCount || 0);
  $("#globalRefreshMinutesSelect").value = String(state.settings.globalRefreshMinutes || 30);
  updateStorageUsage();
  // App updates (#144): the running version, and the last check result
  // (an update waiting shows here as well as in the banner).
  const av = $("#appVersion");
  if (av) av.textContent = "v" + APP_VERSION;
  const st = $("#updateStatus");
  if (st) st.textContent = updateBannerShown ? "A new version is available. Reload to update." : "";
  refreshSyncCapability();
  renderToolbarOrderList();
  $("#settingsDialog").showModal();
}
function showHelp() { renderHelpRows(); $("#helpDialog").showModal(); }
/* Display label for one key descriptor in the help dialog. A plain
   letter stays lowercase ("g"); with a modifier it reads uppercase
   ("Shift+A", "Ctrl+M"). */
function displayDesc(desc) {
  if (desc === "Shift+/") return "?";
  const parts = desc.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  let label = key;
  if (key === "Space") label = "Space";
  else if (key === "Esc") label = "Esc";
  else if (key === "Enter") label = "Enter";
  else if (key.length === 1 && mods.length) label = key.toUpperCase();
  return [...mods, label].join("+");
}
/* Rebuild the help dialog's table from the active preset's map, so
   "?" always lists the keys that are actually live. Descriptors
   that map to the same action share one row. */
function renderHelpRows() {
  const preset = PRESETS[shortcutPreset()] || PRESETS.inoreader;
  const byAction = new Map();
  for (const [desc, action] of Object.entries(preset.keys)) {
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(desc);
  }
  const order = ["search", "nextOpen", "prevOpen", "moveNext", "movePrev", "nextUnread", "prevUnread", "oldestUnread",
    "openSelected", "openOriginal", "openBackground", "openCurrentTab", "toggleRead", "toggleReadNext", "toggleReadPrev",
    "markVisibleRead", "markAbove", "markBelow", "markReadAdvance", "markUnreadSkip", "save", "tag", "fullArticle",
    "share", "addFeed", "refresh", "help", "closeReader", "sidebarToggle", "textBigger", "textSmaller", "textReset",
    "unreadView", "allView", "folderToggle", "nextFeed", "prevFeed", "parentFolder", "firstArticle", "lastArticle",
    "scrollTop", "copyUrl", "fullscreen", "unsubscribe", "editFeed",
    "goAll", "goUnread", "goSaved", "goSnoozed", "goHighlights", "goToday", "goIndex", "goOrganize", "goPrefs", "goStarred", "goFeeds", "goHome"];
  const rows = [...byAction.entries()]
    .filter(([action]) => ACTION_LABELS[action])
    .sort((x, y) => (order.indexOf(x[0]) + 1 || 99) - (order.indexOf(y[0]) + 1 || 99));
  const body = rows.map(([action, descs]) => {
    const keys = descs.map(d => {
      // A two-key sequence ("g a", "z t") reads as "g then a".
      const parts = d.split(" ");
      return parts.map(p => `<kbd>${esc(displayDesc(p))}</kbd>`).join(" then ");
    }).join(" / ");
    return `<tr><td>${keys}</td><td>${esc(ACTION_LABELS[action])}</td></tr>`;
  }).join("");
  const tbody = $("#helpRows");
  if (tbody) tbody.innerHTML = body;
  const vimRows = shortcutPreset() === "vim" ? [
    ["h / l", "Move focus between sidebar, article list, and article"],
    ["j / k", "Move through the focused pane"],
    ["d / u", "Page down / up in the focused pane"],
    ["Ctrl+d / Ctrl+u", "Page down / up in the focused pane"],
    ["g g / G", "Top / bottom of the focused pane"],
    ["Enter", "Open selected article; expand or collapse selected folder"],
    ["Space / Shift+Space", "Page down / up in the focused pane"],
    ["Esc", "Exit an input; press again to focus the sidebar"],
    ["D", "Collapse or expand the sidebar while the sidebar is focused"],
    ["q", "Close article and return focus to the article list"]
  ].map(([keys, action]) => `<tr><td>${esc(keys)}</td><td>${esc(action)}</td></tr>`).join("") : "";
  if (tbody) tbody.innerHTML = body + vimRows;
  const note = $("#helpPresetNote");
  if (note) note.textContent = `Preset: ${preset.name}. Change it in Settings under Keyboard shortcuts. ${shortcutPreset() === "vim" ? "Use Esc to leave an input and return to navigation; press Esc again to focus the sidebar. D toggles the sidebar while it is focused." : "The shortcut strip at the bottom shows commonly used keys. Turn it off in Settings if you prefer."}`;
}


function shortcutPreset() { return state.settings.shortcutPreset || "inoreader"; }
/* Persistent shortcut reference strip. Keep the list short enough to scan
   at a glance; the help dialog remains the complete reference. */
function renderShortcutBar() {
  const bar = $("#shortcutBar");
  if (!bar) return;
  const visible = state.settings.shortcutBar !== false &&
    window.matchMedia("(min-width: 821px)").matches;
  bar.hidden = !visible;
  document.body.classList.toggle("shortcut-bar-visible", visible);
  if (!visible) return;

  const items = shortcutPreset() === "vim"
    ? [
        ["Esc", "Exit input / focus sidebar"],
        ["h / l", "Switch panes"],
        ["j / k", "Move"],
        ["D", "Toggle sidebar"],
        ["Enter", "Open"],
        ["q", "Close article"],
        ["?", "All shortcuts"]
      ]
    : (() => {
        const preset = PRESETS[shortcutPreset()] || PRESETS.inoreader;
        const shortcuts = [
          ["search", "Search"],
          ["nextOpen", "Next article"],
          ["prevOpen", "Previous article"],
          ["openSelected", "Open article"],
          ["toggleRead", "Mark read"],
          ["save", "Save article"],
          ["help", "All shortcuts"]
        ];
        return shortcuts.flatMap(([action, label]) => {
          const key = Object.keys(preset.keys).find(desc => preset.keys[desc] === action);
          return key ? [[key.split(" ").map(displayDesc).join(" then "), label]] : [];
        });
      })();

  bar.innerHTML = items.map(([key, label]) =>
    `<span class="shortcut-bar-item"><kbd>${esc(key)}</kbd><span>${esc(label)}</span></span>`
  ).join("");
}
/* ---------- shortcut actions (#185) ----------
   The preset maps above name these actions; each one is a small
   function over the existing helpers. Actions that need an article
   use the selected one (state.selected) and no-op when there is none. */
function moveHighlight(dir) {
  // Move the list highlight without opening the reader (Inoreader
  // n/p): only state.selected changes, so "o" then opens it.
  const list = visible();
  if (!list.length) return;
  const i = list.findIndex(x => x.id === state.selected);
  const n = i === -1 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
  state.selected = list[n].id;
  render();
  document.querySelector(`[data-article="${CSS.escape(list[n].id)}"]`)?.scrollIntoView({ block: "nearest" });
}
const TEXT_SIZES = ["small", "normal", "large"];
function changeTextSize(dir) {
  const i = TEXT_SIZES.indexOf(state.settings.size || "normal");
  const n = Math.min(TEXT_SIZES.length - 1, Math.max(0, i + dir));
  if (n === i) return;
  state.settings.size = TEXT_SIZES[n];
  local(S, state.settings);
  applySettings();
  toast(`Article text: ${TEXT_SIZES[n]}.`);
}
function resetTextSize() {
  if ((state.settings.size || "normal") === "normal") return;
  state.settings.size = "normal";
  local(S, state.settings);
  applySettings();
  toast("Article text: normal.");
}
function moveFeedSelection(dir) {
  // Next/previous feed in sidebar order (Feedly/NewsBlur/FreshRSS/
  // CommaFeed Shift+J/K, Google Reader Shift+N/P).
  const feeds = state.feeds;
  if (!feeds.length) return;
  const cur = feeds.findIndex(f => f.id === state.feed);
  const n = cur === -1 ? (dir > 0 ? 0 : feeds.length - 1) : (cur + dir + feeds.length) % feeds.length;
  const feed = feeds[n];
  state.view = "feed"; state.feed = feed.id; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  render();
  document.querySelector(`[data-feed="${CSS.escape(feed.id)}"]`)?.scrollIntoView({ block: "nearest" });
}
function toggleCurrentFolder() {
  // Expand/collapse the folder holding the current feed (Inoreader /
  // Google Reader / BazQux Shift+X, Feedbin e).
  const group = state.folder || (state.feed ? (state.feeds.find(f => f.id === state.feed)?.group || "") : "");
  if (!group) { toast("This feed is not in a folder."); return; }
  if (collapsedFolders.has(group)) collapsedFolders.delete(group); else collapsedFolders.add(group);
  saveCollapsedFolders();
  renderNav();
}
function toggleSidebar() {
  state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
  local(S, state.settings);
  applySidebarCollapsed();
}
function markReadAdvance() {
  // Feedly x: mark the selected article read and move to the next.
  const sel = selectedItem();
  if (!sel) return;
  if (!sel.read) { sel.read = true; put(sel); }
  render();
  moveSelection(1);
}
function markUnreadSkip() {
  // BazQux L: mark the selected article unread and move to the next.
  const sel = selectedItem();
  if (!sel) return;
  if (sel.read) { sel.read = false; put(sel); }
  render();
  moveSelection(1);
}
function copyArticleUrl() {
  const sel = selectedItem();
  if (!sel) return;
  const done = () => toast("Article link copied.");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(sel.url).then(done, () => toast("Could not copy the link."));
  else toast("Copy is not available in this browser.");
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => toast("Full screen is not available."));
}
function jumpFirstArticle() { const list = visible(); if (list.length) openItem(list[0].id); }
function jumpLastArticle() { const list = visible(); if (list.length) openItem(list[list.length - 1].id); }
function scrollArticleTop() {
  const reader = $("#reader");
  if (reader.classList.contains("open")) reader.scrollTo({ top: 0 });
  else $("#articleList")?.scrollTo({ top: 0 });
}
function unsubscribeCurrentFeed() {
  const feedId = state.feed || selectedItem()?.feedId;
  if (!feedId) { toast("Open a feed first."); return; }
  requestUnsubscribe(feedId);
}
function openInCurrentTab() {
  const sel = selectedItem();
  if (sel) window.location.href = sel.url;
}
function oldestUnread() {
  // NewsBlur m: the oldest unread article (the list is newest-first,
  // so it is the last unread in it).
  const unread = visible().filter(x => !x.read);
  if (!unread.length) { toast("No unread articles in this view."); return; }
  openItem(unread[unread.length - 1].id);
}
function selectParentFolder() {
  // BazQux Shift+U: open the folder view for the current feed's folder.
  const group = state.feed ? (state.feeds.find(f => f.id === state.feed)?.group || "") : (state.folder || "");
  if (!group) { toast("This feed is not in a folder."); return; }
  state.view = "folder"; state.folder = group; state.feed = null; state.tag = null; state.savedSearch = null; state.selected = null;
  render();
}
function toggleReadNext() {
  const sel = selectedItem();
  if (!sel) return;
  sel.read = !sel.read; put(sel); render(); renderReader(sel);
  moveSelection(1);
}
function toggleReadPrev() {
  const sel = selectedItem();
  if (!sel) return;
  sel.read = !sel.read; put(sel); render(); renderReader(sel);
  moveSelection(-1);
}
function openBackgroundTab() {
  // Inoreader b: open in a background tab. Browsers force a scripted
  // window.open to the foreground, so this opens a normal new tab.
  const sel = selectedItem();
  if (sel) window.open(sel.url, "_blank", "noopener");
}
function editCurrentFeed() {
  // Feedbin Shift+E: open the per-feed options menu (#183) for the
  // current feed, anchored on its sidebar row.
  const feedId = state.feed || selectedItem()?.feedId;
  if (!feedId) { toast("Open a feed first."); return; }
  const anchorEl = document.querySelector(`[data-feed="${CSS.escape(feedId)}"]`);
  openFeedMenu(feedId, anchorEl || document.body);
}
/* Run one named action from the active preset's map. Returns true
   when the action ran (so the handler can stop). */
function runShortcutAction(name, e) {
  const sel = selectedItem();
  switch (name) {
    case "nextOpen": moveSelection(1); return true;
    case "prevOpen": moveSelection(-1); return true;
    case "moveNext": moveHighlight(1); return true;
    case "movePrev": moveHighlight(-1); return true;
    case "nextUnread": moveUnread(1); return true;
    case "prevUnread": moveUnread(-1); return true;
    case "oldestUnread": oldestUnread(); return true;
    case "openSelected":
      if (state.selected) openItem(state.selected);
      else { const list = visible(); if (list.length) openItem(list[0].id); }
      return true;
    case "openOriginal": if (sel) window.open(sel.url, "_blank", "noopener"); return true;
    case "openBackground": openBackgroundTab(); return true;
    case "openCurrentTab": openInCurrentTab(); return true;
    case "toggleRead":
      if (!sel) return false;
      sel.read = !sel.read; sel.readAt = sel.read ? Date.now() : null; put(sel); render(); renderReader(sel); return true;
    case "toggleReadNext": toggleReadNext(); return true;
    case "toggleReadPrev": toggleReadPrev(); return true;
    case "markVisibleRead": markVisibleRead(); return true;
    case "markAbove": markAboveBelow("above"); return true;
    case "markBelow": markAboveBelow("below"); return true;
    case "markReadAdvance": markReadAdvance(); return true;
    case "markUnreadSkip": markUnreadSkip(); return true;
    case "save":
      if (!sel) return false;
      sel.saved = !sel.saved; put(sel); render(); openItem(sel.id); return true;
    case "tag":
      if (!sel) return false;
      e.preventDefault();
      if (tagsExpandedId !== sel.id) { tagsExpandedId = sel.id; renderReader(sel); }
      { const inp = $("#tagInput"); if (inp) { inp.focus(); inp.select(); } }
      return true;
    case "fullArticle": if (sel) toggleFullText(sel); return true;
    case "share": if (sel) shareArticle(sel); return true;
    case "addFeed": showFeed(); return true;
    case "refresh": refresh(); return true;
    case "search": $("#search").focus(); return true;
    case "help": showHelp(); return true;
    case "closeReader": closeReader(); return true;
    case "sidebarToggle": toggleSidebar(); return true;
    case "textBigger": changeTextSize(1); return true;
    case "textSmaller": changeTextSize(-1); return true;
    case "textReset": resetTextSize(); return true;
    case "unreadView": goView("unread"); return true;
    case "allView": goView("all"); return true;
    case "folderToggle": toggleCurrentFolder(); return true;
    case "nextFeed": moveFeedSelection(1); return true;
    case "prevFeed": moveFeedSelection(-1); return true;
    case "parentFolder": selectParentFolder(); return true;
    case "firstArticle": jumpFirstArticle(); return true;
    case "lastArticle": jumpLastArticle(); return true;
    case "scrollTop": scrollArticleTop(); return true;
    case "copyUrl": copyArticleUrl(); return true;
    case "fullscreen": toggleFullscreen(); return true;
    case "unsubscribe": unsubscribeCurrentFeed(); return true;
    case "editFeed": editCurrentFeed(); return true;
    case "goAll": goView("all"); return true;
    case "goUnread": goView("unread"); return true;
    case "goSaved": goView("saved"); return true;
    case "goSnoozed": goView("snoozed"); return true;
    case "goHighlights": goView("highlights"); return true;
    case "goToday": goView("unread"); return true;
    case "goIndex": goView("all"); return true;
    case "goOrganize": showOrganize(); return true;
    case "goPrefs": showSettings(); return true;
    case "goStarred": goView("saved"); return true;
    case "goFeeds": $("#sidebar")?.scrollIntoView(); return true;
    case "goHome": goView("all"); return true;
    default: return false;
  }
}

/* ---------- keyboard shortcuts ---------- */
/* Industry-standard set (Google Reader / Inoreader / Feedly / NewsBlur):
   / search · j/k next/previous · n/p next/previous unread · o/Enter open ·
   v open original · m toggle read · s save · a mark visible read ·
   u back to list · g then a/u/s go to All/Unread/Saved · r refresh ·
   Space scroll reader · ? help · Esc close. */
function selectedItem() { return state.items.find(i => i.id === state.selected); }
function moveSelection(dir) {
  const a = visible();
  if (!a.length) return;
  const i = a.findIndex(x => x.id === state.selected);
  let n;
  if (i === -1) n = dir > 0 ? 0 : a.length - 1;
  else n = Math.min(a.length - 1, Math.max(0, i + dir));
  openItem(a[n].id);
}
function moveUnread(dir) {
  const a = visible().filter(x => !x.read);
  if (!a.length) { toast("No unread articles in this view."); return; }
  const i = a.findIndex(x => x.id === state.selected);
  let n;
  if (i === -1) n = dir > 0 ? 0 : a.length - 1;
  else n = Math.min(a.length - 1, Math.max(0, i + dir));
  openItem(a[n].id);
}
function goView(view) {
  clearArticleSelection();
  $("#moreDialog")?.close();
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  state.view = view; state.feed = null; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
/* Open a folder as one merged list (#118): every feed in the folder,
   newest first, with the same mark-read controls as the other views. */
function goFolder(name) {
  clearArticleSelection();
  $("#moreDialog")?.close();
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  state.view = "folder"; state.folder = name; state.feed = null; state.tag = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
/* Open a saved search (#108): the stored filter, run over the library. */
function goSavedSearch(id) {
  clearArticleSelection();
  $("#moreDialog")?.close();
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  state.view = "savedSearch"; state.savedSearch = id; state.feed = null; state.folder = null; state.tag = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
async function markVisibleRead() {
  const targets = visible().filter(x => !x.read);
  if (!targets.length) { toast("Visible articles are already read."); return; }
  for (const x of targets) { x.read = true; x.readAt = Date.now(); }
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} read.`, { label: "Undo", fn: async () => {
    for (const x of targets) { x.read = false; x.readAt = null; }
    await putMany(targets);
    render();
  } });
}

/* Mark one feed read (#93): the unread count next to a feed is a
   button that clears that feed, with the same Undo as Mark visible read. */
async function markFeedRead(feedId) {
  const feed = state.feeds.find(f => f.id === feedId);
  const targets = state.items.filter(x => x.feedId === feedId && !x.read);
  if (!targets.length) { toast("That feed is already read."); return; }
  for (const x of targets) { x.read = true; x.readAt = Date.now(); }
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} in “${feed?.title || "feed"}” read.`, { label: "Undo", fn: async () => {
    for (const x of targets) { x.read = false; x.readAt = null; }
    await putMany(targets);
    render();
  } });
}

/* Mute a feed (#117): hide its articles from All and Unread without
   unsubscribing. The feed stays in the sidebar (greyed, with its
   count) and its articles are still there in its own view; saved
   articles stay in Saved. */
function toggleMute(feedId) {
  const f = state.feeds.find(f => f.id === feedId);
  if (!f) return;
  f.muted = !f.muted;
  saveFeeds();
  render();
  renderOrganize();
  toast(f.muted ? `Muted “${f.title}”. Its articles are hidden from All and Unread.` : `Unmuted “${f.title}”.`);
}

/* Mark above / below (#106): everything before or after the selected
   article in the list as it currently stands (view, filter, search,
   sort), with the same Undo as the other bulk mark-read actions. Only
   the visible list is acted on, never the whole library. */
async function markAboveBelow(which) {
  const a = visible();
  const i = a.findIndex(x => x.id === state.selected);
  if (i === -1) { toast("Select an article first."); return; }
  const targets = (which === "above" ? a.slice(0, i) : a.slice(i + 1)).filter(x => !x.read);
  if (!targets.length) { toast(which === "above" ? "Nothing above this article is unread." : "Nothing below this article is unread."); return; }
  for (const x of targets) { x.read = true; x.readAt = Date.now(); }
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} ${which} read.`, { label: "Undo", fn: async () => {
    for (const x of targets) { x.read = false; x.readAt = null; }
    await putMany(targets);
    render();
  } });
}


/* ---------- application shell and command system ---------- */
const selectedArticleIds = new Set();
let lastSelectedArticleId = null;
let swipeHandled = false;
let longPressTimer = null;
let longPressTriggered = false;
function clearArticleSelection() {
  selectedArticleIds.clear();
  lastSelectedArticleId = null;
  renderSelectionToolbar();
}
function renderSelectionToolbar() {
  const bar = $("#selectionToolbar");
  if (!bar) return;
  const visibleIds = new Set(visible().map(x => x.id));
  for (const itemId of selectedArticleIds) if (!visibleIds.has(itemId)) selectedArticleIds.delete(itemId);
  const count = selectedArticleIds.size;
  bar.hidden = count === 0;
  $("#selectionCount").textContent = count + " selected";
}
function toggleArticleSelection(itemId, range = false) {
  const items = visible();
  const targetIndex = items.findIndex(x => x.id === itemId);
  if (targetIndex < 0) return;
  const anchorIndex = items.findIndex(x => x.id === lastSelectedArticleId);
  if (range && anchorIndex >= 0) {
    const start = Math.min(anchorIndex, targetIndex), end = Math.max(anchorIndex, targetIndex);
    for (const item of items.slice(start, end + 1)) selectedArticleIds.add(item.id);
  } else if (selectedArticleIds.has(itemId)) selectedArticleIds.delete(itemId);
  else selectedArticleIds.add(itemId);
  lastSelectedArticleId = itemId;
  renderList();
}
async function runBulkAction(action) {
  const targets = state.items.filter(x => selectedArticleIds.has(x.id));
  if (!targets.length) return;
  if (action === "clear") { clearArticleSelection(); renderList(); return; }
  const before = targets.map(x => ({ id:x.id, read:x.read, readAt:x.readAt, saved:x.saved, queued:x.queued, queueOrder:x.queueOrder }));
  for (const x of targets) {
    if (action === "read") { x.read = true; x.readAt = Date.now(); }
    if (action === "unread") { x.read = false; x.readAt = null; }
    if (action === "save") x.saved = true;
    if (action === "unsave") x.saved = false;
    if (action === "queue") { x.queued = true; x.queueOrder ||= Date.now(); }
    if (action === "dequeue") { x.queued = false; x.queueOrder = 0; }
  }
  await putMany(targets);
  clearArticleSelection(); render();
  const labels = {read:"Marked read",unread:"Marked unread",save:"Saved",unsave:"Removed from Saved",queue:"Added to the reading queue",dequeue:"Removed from the reading queue"};
  toast(`${labels[action] || "Updated"} ${targets.length} article${targets.length === 1 ? "" : "s"}.`, {
    label:"Undo",
    fn:async()=>{
      const previous = new Map(before.map(x=>[x.id,x]));
      for(const item of targets){const old=previous.get(item.id);if(!old)continue;item.read=old.read;item.readAt=old.readAt;item.saved=old.saved;item.queued=old.queued;item.queueOrder=old.queueOrder;}
      await putMany(targets);render();
    }
  });
}
function updateActivityIndicator() {
  const count = state.feeds.filter(f => !!f.error).length;
  const badge = $("#activityCount");
  if (badge) { badge.textContent = count > 99 ? "99+" : String(count); badge.hidden = count === 0; }
  const button = $("#activityButton");
  if (button) {
    button.classList.toggle("has-errors", count > 0);
    button.setAttribute("aria-label", count ? `Activity and feed status, ${count} feed errors` : "Activity and feed status");
  }
}
function renderActivityCenter() {
  const root = $("#activityContent");
  if (!root) return;
  const errors = state.feeds.filter(f => f.error);
  const refreshing = !!$("#refresh")?.disabled;
  const online = navigator.onLine !== false;
  const last = state.lastRefresh ? new Date(state.lastRefresh).toLocaleString() : "No refresh recorded in this browser";
  const unread = countableItems().filter(x => !x.read).length;
  const saved = state.items.filter(x => x.saved && !isSnoozed(x)).length;
  const queued = state.items.filter(x => x.queued).length;
  root.innerHTML = `<div class="activity-status"><span class="status-indicator ${online ? "online" : "offline"}"></span><div><strong>${online ? "Online" : "Offline"}</strong><p>${online ? "Network connection is available." : "Check your connection. Feed refreshes may fail until you reconnect."}</p></div></div><div class="activity-status"><span class="status-indicator ${refreshing ? "busy" : "idle"}"></span><div><strong>${refreshing ? "Refreshing feeds" : "Refresh idle"}</strong><p>${refreshing ? "Feed updates are being retrieved." : "Last refresh: " + esc(last)}</p></div></div><div class="activity-status"><span class="status-indicator idle"></span><div><strong>Reading library</strong><p>${unread} unread · ${saved} saved · ${queued} queued</p></div></div><section class="activity-errors"><h3>Feed problems <span>${errors.length}</span></h3>${errors.length ? errors.map(f => `<div class="activity-feed"><button type="button" data-activity-feed="${esc(f.id)}"><strong>${esc(feedDisplayTitle(f))}</strong><small>${esc(f.error)}</small></button><button type="button" data-activity-retry="${esc(f.id)}">Retry</button></div>`).join("") : '<p class="muted">All subscribed feeds are healthy.</p>'}</section>`;
}
function showActivityCenter() { renderActivityCenter(); $("#activityDialog").showModal(); }
function goFeedById(feedId) {
  const feed = state.feeds.find(f => f.id === feedId);
  if (!feed) return;
  clearArticleSelection();
  document.body.classList.remove("focus-mode", "reader-open");
  updateFocusButton();
  stopTTS();
  state.view = "feed"; state.feed = feed.id; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
function focusSearch() {
  if (matchMedia("(max-width:820px)").matches) {
    $("#sidebar").classList.add("open");
    $("#scrim").classList.add("show");
  } else if (state.settings.sidebarCollapsed) {
    state.settings.sidebarCollapsed = false;
    local(S,state.settings);
    applySidebarCollapsed();
  }
  $("#search").focus();
}
const COMMANDS = [
  ["all","All articles","Library",()=>goView("all")],
  ["unread","Open unread articles","Library",()=>goView("unread")],
  ["queue","Open reading queue","Library",()=>goView("queue")],
  ["saved","Open saved articles","Library",()=>goView("saved")],
  ["snoozed","Open snoozed articles","Library",()=>goView("snoozed")],
  ["highlights","Open highlights","Library",()=>goView("highlights")],
  ["refresh","Refresh all feeds","Feeds",()=>refresh()],
  ["add","Add a feed","Feeds",()=>showFeed()],
  ["search","Search articles","Navigation",focusSearch],
  ["settings","Open settings","Application",()=>showSettings()],
  ["activity","Open activity center","Application",()=>showActivityCenter()],
  ["sidebar","Toggle feed sidebar","Layout",()=>toggleSidebar()],
  ["focus","Toggle focus reading mode","Layout",()=>toggleFocusMode()],
  ["fullscreen","Toggle full screen","Layout",()=>toggleFullscreen()],
  ["mark-read","Mark visible articles read","Articles",()=>markVisibleRead()],
  ["export","Export subscriptions (OPML)","Data",()=>exportOPML()]
];
let commandActiveIndex = 0;
function renderCommandResults() {
  const q = ($("#commandInput")?.value || "").trim().toLowerCase();
  const feedCommands = state.feeds.map(f => [`feed-${f.id}`, `Open feed: ${feedDisplayTitle(f)}`, "Feeds", () => goFeedById(f.id)]);
  const articleCommands = q.length >= 2 ? state.items.filter(x => (x.title || "").toLowerCase().includes(q)).slice(0,8).map(x => [`article-${x.id}`, x.title, feedTitleFor(x), () => openItem(x.id)]) : [];
  const matches = [...COMMANDS, ...feedCommands, ...articleCommands].filter(c => (c[1] + " " + c[2]).toLowerCase().includes(q));
  commandActiveIndex = Math.min(commandActiveIndex, Math.max(0, matches.length - 1));
  $("#commandResults").innerHTML = matches.length ? matches.map((c,i)=>`<button type="button" role="option" aria-selected="${i===commandActiveIndex}" data-command-id="${c[0]}"><span><strong>${esc(c[1])}</strong><small>${esc(c[2])}</small></span><kbd>${i===commandActiveIndex ? "↵" : ""}</kbd></button>`).join("") : '<p class="muted">No matching commands.</p>';
}
function runCommand(id) {
  let command = COMMANDS.find(c => c[0] === id);
  if (!command && id.startsWith("feed-")) {
    const feed = state.feeds.find(f => "feed-" + f.id === id);
    if (feed) command = [id, feedDisplayTitle(feed), "Feeds", () => goFeedById(feed.id)];
  }
  if (!command && id.startsWith("article-")) {
    const item = state.items.find(x => "article-" + x.id === id);
    if (item) command = [id, item.title, feedTitleFor(item), () => openItem(item.id)];
  }
  if (!command) return;
  $("#commandDialog").close();
  command[3]();
}
function showCommandPalette() {
  const dialog = $("#commandDialog");
  if (!dialog || dialog.open) return;
  $("#commandInput").value = "";
  commandActiveIndex = 0;
  renderCommandResults();
  dialog.showModal();
  $("#commandInput").focus();
}
const PANE_PRESETS = {standard:[250,400],compact:[205,320],reading:[190,320]};
function applyPanePreset(name) {
  if (name === "custom") return;
  const sizes = PANE_PRESETS[name];
  if (!sizes) return;
  state.settings.sidebarWidth = sizes[0];
  state.settings.listWidth = sizes[1];
  local(S,state.settings);
  applyPaneWidths();
  const select = $("#panePreset"); if (select) select.value = name;
}
function updatePanePresetSelect() {
  const select = $("#panePreset");
  if (!select) return;
  const found = Object.entries(PANE_PRESETS).find(([,sizes]) => sizes[0] === Number(state.settings.sidebarWidth) && sizes[1] === Number(state.settings.listWidth));
  select.value = found ? found[0] : "custom";
}
function updateFocusButton() {
  const button = $("#appFocus");
  if (!button) return;
  const active = document.body.classList.contains("focus-mode");
  button.setAttribute("aria-pressed",String(active));
  const label = button.querySelector("span:last-child");
  if (label) label.textContent = active ? "Exit focus" : "Focus";
  else button.textContent = active ? "Exit focus" : "Focus";
  button.title = active ? "Exit focus reading mode" : "Focus reading mode";
}
function toggleFocusMode() {
  if (!document.body.classList.contains("focus-mode") && !state.selected) {
    const first = visible()[0];
    if (!first) { toast("Open an article before entering focus mode."); return; }
    openItem(first.id);
  }
  document.body.classList.toggle("focus-mode");
  updateFocusButton();
}
function bindApplicationChrome() {
  $("#commandButton").onclick = showCommandPalette;
  $("#appSearch").onclick = focusSearch;
  $("#appRefresh").onclick = () => refresh();
  $("#activityButton").onclick = showActivityCenter;
  $("#appFocus").onclick = toggleFocusMode;
  $("#panePreset").onchange = e => applyPanePreset(e.target.value);
  $("[data-rail-commands]").forEach(button => button.addEventListener("click", showCommandPalette));
  $("[data-rail-activity]").forEach(button => button.addEventListener("click", showActivityCenter));
  $("[data-rail-focus]").forEach(button => button.addEventListener("click", toggleFocusMode));
  $("#commandInput").addEventListener("input", () => { commandActiveIndex=0; renderCommandResults(); });
  $("#commandInput").addEventListener("keydown", e => {
    const options = [...$("#commandResults").querySelectorAll("[data-command-id]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); commandActiveIndex = (commandActiveIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1,options.length); renderCommandResults(); }
    if (e.key === "Enter" && options.length) { e.preventDefault(); const active = $("#commandResults").querySelector('[aria-selected="true"]') || options[0]; if(active) runCommand(active.dataset.commandId); }
  });
  $("#commandResults").addEventListener("click", e => { const button=e.target.closest("[data-command-id]"); if(button) runCommand(button.dataset.commandId); });
  $("#mobileMore").onclick = () => $("#moreDialog").showModal();
  $("#moreDone").onclick = () => $("#moreDialog").close();
  $("#moreFeeds").onclick = () => { $("#moreDialog").close(); $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); };
  $("#moreSearch").onclick = () => { $("#moreDialog").close(); focusSearch(); };
  $("#moreAdd").onclick = () => { $("#moreDialog").close(); showFeed(); };
  $("#moreRefresh").onclick = () => { $("#moreDialog").close(); refresh(); };
  $("#moreActivity").onclick = () => { $("#moreDialog").close(); showActivityCenter(); };
  $("#moreSettings").onclick = () => { $("#moreDialog").close(); showSettings(); };
  $("#activityClose").onclick = $("#activityDone").onclick = () => $("#activityDialog").close();
  $("#activityRefresh").onclick = async () => { await refresh(); renderActivityCenter(); };
  document.addEventListener("click", async e => {
    const bulk = e.target.closest("[data-bulk]");
    if (bulk) { await runBulkAction(bulk.dataset.bulk); return; }
    const activityFeed = e.target.closest("[data-activity-feed]");
    if (activityFeed) { $("#activityDialog").close(); showFeedError(activityFeed.dataset.activityFeed); return; }
    const retry = e.target.closest("[data-activity-retry]");
    if (retry) {
      const feed = state.feeds.find(f=>f.id===retry.dataset.activityRetry);
      if (!feed) return;
      retry.disabled = true; await refreshFeed(feed); saveFeeds(); render(); renderActivityCenter(); return;
    }
  });
  $("#articleList").addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || e.target.closest("button,a,input,select")) return;
    const row=e.target.closest("[data-item]"); if(!row) return;
    row.dataset.swipeStart = [e.clientX,e.clientY].join(",");
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      toggleArticleSelection(row.dataset.item);
    }, 550);
  });
  $("#articleList").addEventListener("pointermove", e => {
    if (!longPressTimer) return;
    const row=e.target.closest("[data-item]"); if(!row?.dataset.swipeStart) return;
    const [x,y]=row.dataset.swipeStart.split(",").map(Number);
    if(Math.abs(e.clientX-x)>12 || Math.abs(e.clientY-y)>12){clearTimeout(longPressTimer);longPressTimer=null;}
  });
  $("#articleList").addEventListener("pointerup", async e => {
    clearTimeout(longPressTimer); longPressTimer=null;
    if (longPressTriggered) {
      longPressTriggered = false;
      swipeHandled = true;
      setTimeout(() => { swipeHandled = false; }, 500);
      return;
    }
    const row=e.target.closest("[data-item]"); if(!row?.dataset.swipeStart) return;
    const [x,y]=row.dataset.swipeStart.split(",").map(Number); delete row.dataset.swipeStart;
    const dx=e.clientX-x, dy=e.clientY-y;
    if(Math.abs(dx)<75 || Math.abs(dx)<Math.abs(dy)*1.25) return;
    const item=state.items.find(i=>i.id===row.dataset.item); if(!item) return;
    swipeHandled=true;
    if(dx>0){item.read=!item.read;item.readAt=item.read?Date.now():null;await put(item);renderNav();renderList();toast(item.read?"Marked read.":"Marked unread.");}
    else {item.saved=!item.saved;await put(item);renderNav();renderList();toast(item.saved?"Saved article.":"Removed from saved.");}
    setTimeout(()=>{swipeHandled=false;},300);
  });
  $("#articleList").addEventListener("pointercancel",()=>{clearTimeout(longPressTimer);longPressTimer=null;longPressTriggered=false;swipeHandled=false;});
  $("#reader").addEventListener("pointerdown", e => {
    if(e.pointerType!=="touch" || e.target.closest("a,button,input,select,audio,video")) return;
    $("#reader").dataset.swipeStart=[e.clientX,e.clientY].join(",");
  });
  $("#reader").addEventListener("pointerup", e => {
    const raw=$("#reader").dataset.swipeStart; if(!raw) return; delete $("#reader").dataset.swipeStart;
    const [x,y]=raw.split(",").map(Number), dx=e.clientX-x, dy=e.clientY-y;
    if(Math.abs(dx)<90 || Math.abs(dx)<Math.abs(dy)*1.3) return;
    const items=visible(), index=items.findIndex(i=>i.id===state.selected), next=items[index+(dx<0?1:-1)];
    if(next) openItem(next.id);
  });
  window.addEventListener("online",renderActivityCenter);
  window.addEventListener("offline",renderActivityCenter);
  $(".list-pane").addEventListener("scroll",scheduleAppSessionSave,{passive:true});
  $("#reader").addEventListener("scroll",scheduleAppSessionSave,{passive:true});
  window.addEventListener("pagehide",saveAppSession);
  updatePanePresetSelect();
  updateFocusButton();
}

function bind() {
  document.addEventListener("pointerdown", e => { pointerActivation = { type:e.pointerType, at:Date.now(), isTrusted:e.isTrusted }; }, true);
  document.addEventListener("click", e => coachShortcut(e), true);
  document.addEventListener("click", async e => { const retry = e.target.closest("[data-health-retry]"); if (!retry) return; const feed = state.feeds.find(x => x.id === retry.dataset.healthRetry); if (!feed) return; retry.disabled = true; await refreshFeed(feed); saveFeeds(); render(); $("#feedHealthDialog").close(); showFeedHealth(); });
  document.addEventListener("click", async e => {
    // The snooze menu closes on any click outside it or its button.
    // Remember whether it was open first: the snooze button toggles
    // from that pre-click state, so it can still close the menu.
    const snoozeMenu = $("#snoozeMenu");
    const snoozeMenuWasOpen = !!(snoozeMenu && !snoozeMenu.hidden);
    if (snoozeMenuWasOpen && !e.target.closest("#snoozeMenu") && !e.target.closest('[data-reader="snooze"]')) snoozeMenu.hidden = true;
    // The mark-read menu (#146) closes on any click outside it or its button.
    const markMenu = $("#markReadMenu");
    if (markMenu && !markMenu.hidden && !e.target.closest("#markReadMenu") && !e.target.closest("#markReadMenuBtn")) {
      markMenu.hidden = true;
      $("#markReadMenuBtn")?.setAttribute("aria-expanded", "false");
    }
    // The date filter menu (#175) closes the same way.
    const filterMenu = $("#filterMenu");
    if (filterMenu && !filterMenu.hidden && !e.target.closest("#filterMenu") && !e.target.closest("#filterMenuBtn")) {
      filterMenu.hidden = true;
      $("#filterMenuBtn")?.setAttribute("aria-expanded", "false");
    }
    // The per-feed options menu (#183) closes on any click outside it
    // or its button.
    const feedMenu = $("#feedMenu");
    if (feedMenu && !feedMenu.hidden && !e.target.closest("#feedMenu") && !e.target.closest("[data-feed-opts]")) closeFeedMenu();
    const scrim = e.target.closest("#scrim");
    if (scrim) { $("#sidebar").classList.remove("open"); scrim.classList.remove("show"); return; }
    const nav = e.target.closest("[data-view]");
    if (nav) { goView(nav.dataset.view); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) { goTag(tagBtn.dataset.tag); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const ssBtn = e.target.closest("[data-saved-search]");
    if (ssBtn) { goSavedSearch(ssBtn.dataset.savedSearch); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const folderToggle = e.target.closest("[data-folder-toggle]");
    if (folderToggle) {
      const name = folderToggle.dataset.folderToggle;
      if (collapsedFolders.has(name)) collapsedFolders.delete(name); else collapsedFolders.add(name);
      saveCollapsedFolders();
      renderNav();
      return;
    }
    // Collapse/expand all folders from the YOUR FEEDS heading (#187).
    const allFoldersBtn = e.target.closest("[data-toggle-all-folders]");
    if (allFoldersBtn) {
      const named = namedFolderNames(state.feeds);
      if (allFoldersCollapsed(named, collapsedFolders)) named.forEach(g => collapsedFolders.delete(g));
      else named.forEach(g => collapsedFolders.add(g));
      saveCollapsedFolders();
      renderNav();
      return;
    }
    const unsub = e.target.closest("[data-unsub]");
    if (unsub) { requestUnsubscribe(unsub.dataset.unsub); return; }
    const markReadBtn = e.target.closest("[data-mark-read]");
    if (markReadBtn) { markFeedRead(markReadBtn.dataset.markRead); return; }
    const muteBtn = e.target.closest("[data-mute]");
    if (muteBtn) { toggleMute(muteBtn.dataset.mute); return; }
    const folderBtn = e.target.closest("[data-folder]");
    if (folderBtn) { goFolder(folderBtn.dataset.folder); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const feedErr = e.target.closest("[data-feed-err]");
    if (feedErr) { showFeedError(feedErr.dataset.feedErr); return; }
    const feedOpts = e.target.closest("[data-feed-opts]");
    if (feedOpts) { openFeedMenu(feedOpts.dataset.feedOpts, feedOpts); return; }
    const feed = e.target.closest("[data-feed]");
    if (feed) {
      state.view = "feed"; state.feed = feed.dataset.feed; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
      render();
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      return;
    }
    const act = e.target.closest("[data-action]");
    if (act) {
      if (act.dataset.action === "hl-delete") { await deleteHighlight(act.dataset.id); return; }
      const x = state.items.find(i => i.id === act.dataset.id);
      if (x) {
        if (act.dataset.action === "share") { shareArticle(x); return; }
        if (act.dataset.action === "unsnooze") { await unsnoozeItem(x); return; }
        if (act.dataset.action === "queue") { x.queued = !x.queued; x.queueOrder = x.queued ? Date.now() : 0; await put(x); render(); toast(x.queued ? "Added to reading queue." : "Removed from reading queue."); return; }
        if (act.dataset.action === "queue-up" || act.dataset.action === "queue-down") { const q=state.items.filter(v=>v.queued).sort((u,v)=>(u.queueOrder||0)-(v.queueOrder||0)); const i=q.findIndex(v=>v.id===x.id),j=i+(act.dataset.action==="queue-up"?-1:1); if(i>=0&&j>=0&&j<q.length){const old=q[i].queueOrder;q[i].queueOrder=q[j].queueOrder;q[j].queueOrder=old;await putMany([q[i],q[j]]);render();} return; }
        const key = act.dataset.action === "save" ? "saved" : "read";
        x[key] = !x[key];
        if (key === "read") x.readAt = x.read ? Date.now() : null;
        await put(x);
        render();
        // renderReader, not openItem: opening would mark an item read
        // again right after the user marked it unread.
        if (state.selected === x.id) renderReader(x);
      }
      return;
    }
    // A highlight row in the Highlights view (#116): open its article
    // and scroll to the passage.
    const hlRow = e.target.closest("[data-hl-open]");
    if (hlRow) { openHighlight(hlRow.dataset.hlOpen); return; }
    const hlNote = e.target.closest("[data-hl-note]");
    if (hlNote) { showHlNoteDialog(hlNote.dataset.hlNote); return; }
    const hlGoto = e.target.closest("[data-hl-goto]");
    if (hlGoto) { scrollToHighlight(hlGoto.dataset.hlGoto); return; }
    const hlDel = e.target.closest("[data-hl-delete]");
    if (hlDel) { await deleteHighlight(hlDel.dataset.hlDelete); return; }
    const tagRemove = e.target.closest("[data-tag-remove]");
    if (tagRemove && state.selected) {
      const x = selectedItem();
      if (x) removeTagFromItem(x, tagRemove.dataset.tagRemove);
      return;
    }
    const snz = e.target.closest("[data-snooze]");
    if (snz && state.selected) {
      const x = selectedItem();
      if (x) {
        if (snz.dataset.snooze === "clear") await unsnoozeItem(x);
        else await snoozeItem(x, snz.dataset.snooze);
      }
      const m = $("#snoozeMenu"); if (m) m.hidden = true;
      return;
    }
    const ttsBtn = e.target.closest("[data-tts]");
    if (ttsBtn) {
      if (ttsBtn.dataset.tts === "pause") { if (tts?.paused) resumeTTS(); else pauseTTS(); }
      if (ttsBtn.dataset.tts === "stop") stopTTS();
      return;
    }
    const more = e.target.closest("[data-reader-more]");
    if (more) {
      const menu = more.nextElementSibling;
      if (menu) {
        menu.hidden = !menu.hidden;
        more.setAttribute("aria-expanded", String(!menu.hidden));
      }
      return;
    }
    const ra = e.target.closest("[data-reader]");
    if (ra && state.selected) {
      const overflowMenu = ra.closest(".reader-overflow .menu");
      if (overflowMenu) {
        overflowMenu.hidden = true;
        overflowMenu.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
      const x = selectedItem();
      if (!x) return;
      if (ra.dataset.reader === "save") { x.saved = !x.saved; await put(x); openItem(x.id); return; }
      if (ra.dataset.reader === "queue") { x.queued = !x.queued; x.queueOrder = x.queued ? Date.now() : 0; await put(x); renderNav(); renderList(); renderReader(x); toast(x.queued ? "Added to reading queue." : "Removed from reading queue."); return; }
      if (ra.dataset.reader === "read") { x.read = !x.read; x.readAt = x.read ? Date.now() : null; await put(x); renderNav(); renderList(); renderReader(x); toast(x.read ? "Article marked read." : "Article marked unread."); return; }
      if (ra.dataset.reader === "listen") { if (tts?.itemId === x.id) stopTTS(); else startTTS(x); return; }
      if (ra.dataset.reader === "share") { shareArticle(x); return; }
      if (ra.dataset.reader === "snooze") { const m = $("#snoozeMenu"); if (m) { m.hidden = snoozeMenuWasOpen; ra.setAttribute("aria-expanded", String(!m.hidden)); if (!m.hidden) m.scrollIntoView({ block: "nearest" }); } return; }
      if (ra.dataset.reader === "open") { window.open(x.url, "_blank", "noopener"); return; }
      if (ra.dataset.reader === "fulltext") { toggleFullText(x); return; }
      if (ra.dataset.reader === "tags") { tagsExpandedId = tagsExpandedId === x.id ? null : x.id; renderReader(x); if (tagsExpandedId === x.id) { const inp = $("#tagInput"); if (inp) { inp.focus(); inp.select(); } } return; }
      if (ra.dataset.reader === "note") { showArticleNoteDialog(x); return; }
      if (ra.dataset.reader === "close" || ra.dataset.reader === "back") { closeReader(); return; }
    }
    const noteEdit = e.target.closest("[data-note-edit]");
    if (noteEdit) { const x2 = selectedItem(); if (x2) showArticleNoteDialog(x2); return; }
    const noteDel = e.target.closest("[data-note-delete]");
    if (noteDel) { const x2 = selectedItem(); if (x2) { setArticleNote(x2.id, ""); renderReader(x2); toast("Note deleted."); } return; }
    const selectButton = e.target.closest("[data-select-item]");
    if (selectButton) { e.preventDefault(); toggleArticleSelection(selectButton.dataset.selectItem, e.shiftKey); return; }
    const row = e.target.closest("[data-item]");
    if (row) {
      if (swipeHandled) { swipeHandled = false; return; }
      if (selectedArticleIds.size || e.shiftKey) { toggleArticleSelection(row.dataset.item, e.shiftKey); return; }
      openItem(row.dataset.item); return;
    }
  });
  document.addEventListener("keydown", e => {
    const selectButton = e.target.closest?.("[data-select-item]");
    if (selectButton && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleArticleSelection(selectButton.dataset.selectItem, e.shiftKey); return; }
    const row = e.target.closest?.("[data-item]");
    // Only when the row itself is focused: an inner button (read/save)
    // must keep its own Enter/Space behavior.
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(row.dataset.item); }
    if (e.target.id === "tagInput" && e.key === "Enter") {
      e.preventDefault();
      const x = selectedItem();
      if (x) addTagToItem(x, e.target.value);
    }
  });
  $("#home").onclick = () => { goView("all"); };
  $("#add").onclick = $("#mobileAdd").onclick = $("#firstAdd").onclick = showFeed;
  $("#feedSearchInput").addEventListener("input", scheduleFeedSearch);
  // Enter in the single box submits the form, which runs the unified
  // add logic (#157): direct add for an address, directory search
  // for words. No separate key handler.
  $("#feedSearchResults").addEventListener("click", e => {
    const f = e.target.closest("[data-discovery-filter]");
    if (f && !f.disabled) {
      discoveryFilter = f.dataset.discoveryFilter;
      renderDiscoveryResults(window.feedDiscoveryResults || []);
      return;
    }
    const b = e.target.closest("[data-discovery-add]");
    if (b) addDiscoveredFeed(Number(b.dataset.discoveryAdd));
  });
  // Folders & tags lives in Settings now: close Settings, then open the
  // manage dialog on its own.
  $("#organize").onclick = () => { $("#settingsDialog").close(); showOrganize(); };
  // Rules likewise: close Settings, then open the rules dialog.
  $("#manageRules").onclick = () => { $("#settingsDialog").close(); showRules(); };
  $("#rulesDialog").addEventListener("click", e => {
    const add = e.target.closest("[data-rule-add]");
    if (add) { ruleEdit = "new"; renderRules(); $("#ruleName")?.focus(); return; }
    const edit = e.target.closest("[data-rule-edit]");
    if (edit) { ruleEdit = edit.dataset.ruleEdit; renderRules(); $("#ruleName")?.focus(); return; }
    const save = e.target.closest("[data-rule-save]");
    if (save) { saveRuleFromDialog(); return; }
    const cancel = e.target.closest("[data-rule-cancel]");
    if (cancel) { ruleEdit = null; renderRules(); return; }
    const toggle = e.target.closest("[data-rule-toggle]");
    if (toggle) {
      const r = state.rules.find(v => v.id === toggle.dataset.ruleToggle);
      if (r) { r.enabled = r.enabled === false; saveRules(); renderRules(); toast(r.enabled !== false ? `Rule “${r.name}” on.` : `Rule “${r.name}” off.`); }
      return;
    }
    const del = e.target.closest("[data-rule-delete]");
    if (del) { deleteRule(del.dataset.ruleDelete); return; }
    if (e.target.closest("#rulesDone") || e.target.closest("#rulesClose")) $("#rulesDialog").close();
  });
  // Feed-error dialog (#162): Retry reloads that feed; Unsubscribe uses
  // the same two-step arming as the sidebar ×.
  $("#feedErrorRetry").onclick = async () => {
    const id = $("#feedErrorDialog").dataset.feed;
    const f = state.feeds.find(v => v.id === id);
    $("#feedErrorDialog").close();
    if (!f) return;
    const ok = await refreshFeed(f);
    saveFeeds();
    render();
    toast(ok ? `“${f.title}” loaded.` : `“${f.title}” still failing: ${f.error || "unknown error"}`);
  };
  $("#feedErrorUnsub").onclick = () => { const id = $("#feedErrorDialog").dataset.feed; $("#feedErrorDialog").close(); if (id) requestUnsubscribe(id); };
  $("#feedErrorClose").onclick = () => $("#feedErrorDialog").close();
  // A rule must do something: Save stays disabled until a tag is typed
  // or Save / Mark read is checked (#162).
  $("#rulesDialog").addEventListener("input", syncRuleSave);
  $("#rulesDialog").addEventListener("change", syncRuleSave);
  $("#organizeDialog").addEventListener("close", () => { pendingDelete = null; orgEdit = null; });
  $("#organizeDialog").addEventListener("click", async e => {
    const addFolder = e.target.closest("[data-org-add-folder]");
    if (addFolder) { createFolder($("#newFolder")?.value); return; }
    const addTag = e.target.closest("[data-org-add-tag]");
    if (addTag) { createTag($("#newTag")?.value); return; }
    const renameFolderBtn = e.target.closest("[data-org-rename-folder]");
    if (renameFolderBtn) { orgEdit = { kind: "folder", old: renameFolderBtn.dataset.orgRenameFolder }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const renameTagBtn = e.target.closest("[data-org-rename-tag]");
    if (renameTagBtn) { orgEdit = { kind: "tag", old: renameTagBtn.dataset.orgRenameTag }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const renameSsBtn = e.target.closest("[data-org-rename-saved-search]");
    if (renameSsBtn) { orgEdit = { kind: "savedSearch", old: renameSsBtn.dataset.orgRenameSavedSearch }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const saveRename = e.target.closest("[data-org-save-rename]");
    if (saveRename) { await doRename($("#orgEditInput")?.value); return; }
    const cancelRename = e.target.closest("[data-org-cancel-rename]");
    if (cancelRename) { orgEdit = null; renderOrganize(); return; }
    const delFolder = e.target.closest("[data-org-delete-folder]");
    if (delFolder) { deleteFolder(delFolder.dataset.orgDeleteFolder); return; }
    const delTag = e.target.closest("[data-org-delete-tag]");
    if (delTag) { await deleteTag(delTag.dataset.orgDeleteTag); return; }
    const delSs = e.target.closest("[data-org-delete-saved-search]");
    if (delSs) { deleteSavedSearch(delSs.dataset.orgDeleteSavedSearch); return; }
    const orgUnsub = e.target.closest("[data-org-unsub]");
    if (orgUnsub) { await requestUnsubscribe(orgUnsub.dataset.orgUnsub); return; }
    const orgMute = e.target.closest("[data-org-mute]");
    if (orgMute) { toggleMute(orgMute.dataset.orgMute); return; }
    if (e.target.closest("#organizeDone") || e.target.closest("#organizeClose")) $("#organizeDialog").close();
  });
  $("#organizeDialog").addEventListener("change", e => {
    const sel = e.target.closest("[data-org-move]");
    if (sel) moveFeed(sel.dataset.orgMove, sel.value);
  });
  $("#organizeDialog").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    if (e.target.id === "newFolder") { e.preventDefault(); createFolder(e.target.value); }
    else if (e.target.id === "newTag") { e.preventDefault(); createTag(e.target.value); }
    else if (e.target.id === "orgEditInput") { e.preventDefault(); doRename(e.target.value); }
  });
  $("#refresh").onclick = refresh;
  $("#removeQueue").onclick = removeVisibleFromQueue;
  bindSplitters();
  $("#reader").addEventListener("scroll", updateReadProgress, { passive: true });
  // Highlights (#116): the button follows the selection in the article
  // body, and hides when the reader scrolls (its position is by
  // viewport, so a scroll would leave it in the wrong place).
  $("#reader").addEventListener("mouseup", () => setTimeout(updateHlBtn, 0));
  $("#reader").addEventListener("scroll", () => { const b = $("#hlBtn"); if (b) b.hidden = true; }, { passive: true });
  document.addEventListener("selectionchange", () => { if (state.selected) updateHlBtn(); });
  $("#hlBtn").onclick = showHlDialog;
  $("#hlForm").onsubmit = e => { e.preventDefault(); saveHlFromDialog(); };
  $("#articleNoteForm").onsubmit = e => { e.preventDefault(); saveArticleNoteFromDialog(); };
  $("#feedRenameForm").onsubmit = e => { e.preventDefault(); saveFeedRenameFromDialog(); };
  $("#feedLayoutForm").onsubmit = e => { e.preventDefault(); saveFeedLayoutFromDialog(); };
  $("#feedMenu")?.addEventListener("click", e => {
    // Menu clicks are handled here only: if they bubbled to the
    // document handler, the innerHTML replacement below would detach
    // the clicked button and the outside-click check would close the
    // menu after every toggle.
    e.stopPropagation();
    const b = e.target.closest("[data-feed-opt]");
    if (!b || !feedMenuFeedId) return;
    const f = state.feeds.find(fe => fe.id === feedMenuFeedId);
    if (!f) { closeFeedMenu(); return; }
    const opt = b.dataset.feedOpt;
    if (opt === "rename") { closeFeedMenu(); showFeedRenameDialog(f); return; }
    if (opt === "open") { closeFeedMenu(); window.open(f.site || f.url, "_blank", "noopener"); return; }
    if (opt === "autofull") { f.autoFull = !f.autoFull; saveFeeds(); renderFeedMenu(); toast(`Auto full article ${f.autoFull ? "on" : "off"} for ${feedDisplayTitle(f)}.`); return; }
    if (opt === "layout") { closeFeedMenu(); showFeedLayoutDialog(f); return; }
    if (opt === "interval") {
      const choices = [0,15,30,60,180,360,720,1440], current = Number(f.refreshMinutes) || 0;
      f.refreshMinutes = choices[(choices.indexOf(current) + 1) % choices.length];
      saveFeeds(); renderFeedMenu(); toast(f.refreshMinutes ? `Refresh interval set to ${f.refreshMinutes} minutes.` : "Feed uses the global interval."); return;
    }
    if (opt === "order") {
      f.sort = nextFeedSort(f.sort);
      saveFeeds(); renderFeedMenu(); renderSortBtn(); renderList();
      toast(`Order for ${feedDisplayTitle(f)}: ${f.sort === "global" ? "use global" : f.sort}.`);
      return;
    }
    if (opt === "unsub") {
      const wasArmed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id;
      requestUnsubscribe(f.id);
      if (wasArmed) closeFeedMenu(); else renderFeedMenu();
      return;
    }
  });
  $("#toolbarOrderList")?.addEventListener("click", e => {
    const b = e.target.closest("[data-tb-move]");
    if (!b || b.disabled) return;
    const [idx, delta] = b.dataset.tbMove.split(":").map(Number);
    const order = toolbarOrderFromDialog() || toolbarOrder();
    const j = idx + delta;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    renderToolbarOrderList(order);
  });
  $("#hlDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#hlDialog").close();
  });
  // The same Cancel/X close for the note, rename, and layout dialogs
  // (#197, #183): without it their Cancel buttons do nothing.
  for (const d of ["#articleNoteDialog", "#feedRenameDialog", "#feedLayoutDialog"]) {
    $(d)?.addEventListener("click", e => {
      if (e.target.closest('button[value="cancel"]')) $(d).close();
    });
  }
  // The listening speed applies from the next spoken chunk and is
  // remembered with the other settings.
  document.addEventListener("change", e => {
    if (e.target.id === "ttsSpeed") {
      state.settings.ttsRate = Number(e.target.value) || 1;
      local(S, state.settings);
    }
  });
  window.addEventListener("resize", updateReadProgress);
  $("#settings").onclick = showSettings;
  $("#theme").onclick = () => {
    state.settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    local(S, state.settings);
    applySettings();
  };
  // Full-text search (#107) scans stored article bodies, so the list
  // re-render is debounced while typing instead of running per keystroke.
  $("#search").oninput = e => { state.query = e.target.value.toLowerCase(); $("#searchClear").hidden = !e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); };
  $("#searchClear").onclick = () => { $("#search").value = ""; state.query = ""; $("#searchClear").hidden = true; renderList(); $("#search").focus(); };
  $("#sort").onclick = () => {
    // The sort button toggles the sort for the view on screen (#183):
    // a feed's own sort when viewing that feed, otherwise the global one.
    const next = effectiveSort() === "newest" ? "oldest" : "newest";
    if (state.feed) {
      const f = state.feeds.find(fe => fe.id === state.feed);
      if (f && f.sort && f.sort !== "global") { f.sort = next; saveFeeds(); renderSortBtn(); renderList(); return; }
    }
    state.sort = next;
    state.settings.sort = state.sort;
    local(S, state.settings);
    renderSortBtn();
    renderList();
  };
  $$(".filter").forEach(b => b.onclick = () => {
    $$(".filter").forEach(x => x.classList.toggle("active", x === b));
    state.filter = b.dataset.filter;
    state.settings.filter = state.filter;
    local(S, state.settings);
    renderList();
  });
  $("#markRead").onclick = markVisibleRead;
  $("#markAbove").onclick = () => markAboveBelow("above");
  $("#markBelow").onclick = () => markAboveBelow("below");
  // Mark read dropdown (#146): one button holds the three actions.
  // The menu closes after an action, on an outside click, or on Esc.
  const markMenu = $("#markReadMenu"), markBtn = $("#markReadMenuBtn");
  const closeMarkMenu = () => {
    if (markMenu) markMenu.hidden = true;
    if (markBtn) markBtn.setAttribute("aria-expanded", "false");
  };
  if (markBtn && markMenu) {
    markBtn.onclick = e => {
      e.stopPropagation();
      const open = markMenu.hidden;
      markMenu.hidden = !open;
      markBtn.setAttribute("aria-expanded", String(open));
    };
    markMenu.addEventListener("click", e => { if (e.target.closest("button")) closeMarkMenu(); });
  }
  // Date filter dropdown (#175): the same pattern as Mark read — the
  // full-width filters bar is gone, so the filter lives up in the
  // list header as one compact button.
  const filterMenu = $("#filterMenu"), filterBtn = $("#filterMenuBtn");
  if (filterBtn && filterMenu) {
    filterBtn.onclick = e => {
      e.stopPropagation();
      const open = filterMenu.hidden;
      filterMenu.hidden = !open;
      filterBtn.setAttribute("aria-expanded", String(open));
    };
    filterMenu.addEventListener("click", e => { if (e.target.closest("button")) { filterMenu.hidden = true; filterBtn.setAttribute("aria-expanded", "false"); } });
  }
  $("#saveSearchBtn").onclick = showSaveSearch;
  $("#saveSearchDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#saveSearchDialog").close();
  });
  // The form's submit covers both the Save button and Enter in a field,
  // so a missing name keeps the dialog open instead of closing it.
  $("#saveSearchForm").onsubmit = e => {
    e.preventDefault();
    saveSearchFromDialog();
  };
  $("#importOpml").onclick = () => $("#opmlFile").click();
  $("#exportOpml").onclick = exportOPML;
  $("#opmlFile").onchange = e => { if (e.target.files[0]) previewOPML(e.target.files[0]); e.target.value = ""; };
  const closeOPMLPreview = () => { pendingOPMLFile = null; pendingOPMLFeedUrls = []; $("#opmlPreviewDialog").close(); };
  $("#opmlPreviewClose").onclick = $("#opmlPreviewCancel").onclick = closeOPMLPreview;
  const updateOPMLSelection = () => {
    const selected = $$("#opmlFeedSelection input[data-opml-feed]:checked").length;
    $("#opmlPreviewConfirm").disabled = selected === 0;
    $("#opmlPreviewConfirm").textContent = selected ? "Import " + selected + " feed" + (selected === 1 ? "" : "s") : "Select feeds to import";
  };
  $("#opmlFeedSelection").addEventListener("change", updateOPMLSelection);
  $("#opmlSelectAll").onclick = () => { $$("#opmlFeedSelection input[data-opml-feed]:not(:disabled)").forEach(input => { input.checked = true; }); updateOPMLSelection(); };
  $("#opmlSelectNone").onclick = () => { $$("#opmlFeedSelection input[data-opml-feed]:not(:disabled)").forEach(input => { input.checked = false; }); updateOPMLSelection(); };
  $("#opmlPreviewConfirm").onclick = async () => {
    if (!pendingOPMLFile) return;
    const file = pendingOPMLFile;
    const selected = new Set($$("#opmlFeedSelection input[data-opml-feed]:checked").map(input => input.dataset.opmlFeed));
    pendingOPMLFile = null;
    pendingOPMLFeedUrls = [];
    $("#opmlPreviewDialog").close();
    await importOPML(file, selected);
  };
  // The X and Cancel buttons are type="button" (not submit), so the
  // Add feed button is the form's only submit button and therefore
  // the one Enter submits with. They close the dialog explicitly
  // instead of relying on method="dialog".
  $("#feedDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#feedDialog").close();
  });
  // Unified add (#157): one box. An address is added directly
  // (loadFeedFromUrl probes /feed, /rss, … and WordPress for a bare
  // site); words run a directory search instead.
  $("#feedForm").onsubmit = async e => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    clearTimeout(discoveryTimer);
    if (discoveryController) discoveryController.abort();
    const q = $("#feedSearchInput").value.trim();
    if (!q) { $("#feedSearchStatus").textContent = "Type a feed or website address, or a name or topic to search."; return; }
    if (!looksLikeAddress(q)) { searchFeeds(q); return; }
    const b = $("#saveFeed");
    b.disabled = true;
    try {
      await addFeed(q);
      $("#feedDialog").close();
    } catch (err) {
      $("#feedError").textContent = classifyError(err, /^http:/i.test(q));
      // Direct add failed: fall back to directory search, which can
      // surface the site's feeds even when a direct fetch cannot.
      // An already-subscribed feed needs no search.
      if (!/already subscribe/i.test(err.message || "")) searchFeeds(q);
    } finally { b.disabled = false; }
  };
  $("#saveSettings").onclick = () => applySettingsFromDialog(true);
  $("#shortcutHelp").onclick = showHelp;
  // Settings apply live (#162): a change to any control saves and applies
  // at once, so closing with × keeps the change. The background-sync
  // registration only runs when its own toggles change.
  $("#settingsDialog").addEventListener("change", e => {
    if (e.target.type === "file") return;
    applySettingsFromDialog(e.target.id === "backgroundSyncToggle" || e.target.id === "notifyNewToggle");
  });
  $("#exportSettings").onclick = exportSettings;
  $("#importSettings").onclick = () => $("#settingsFile").click();
  $("#checkUpdates").onclick = checkForUpdates;
  $("#settingsFile").onchange = e => { if (e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ""; };
  $("#exportBackup").onclick = exportCompleteBackup; $("#importBackup").onclick = () => $("#backupFile").click();
  $("#backupFile").onchange = e => { if (e.target.files[0]) importCompleteBackup(e.target.files[0]); e.target.value = ""; };
  $("#exportAnnotationsJSON").onclick = () => exportAnnotations("json"); $("#exportAnnotationsMarkdown").onclick = () => exportAnnotations("markdown");
  $("#previewCleanup").onclick = previewRetentionCleanup; $("#openStats").onclick = showReadingStats;
  $("#openFeedHealth").onclick = showFeedHealth;
  $("#feedHealthClose").onclick = $("#feedHealthDone").onclick = () => $("#feedHealthDialog").close();
  $("#statsClose").onclick = $("#statsDone").onclick = () => $("#statsDialog").close();
  $("#statsRange").onchange = e => { $("#statsDialog").close(); showReadingStats(Number(e.target.value)); };
  $("#libraryMore").addEventListener("toggle", () => { try { localStorage.setItem("rss-reader.library-more-open", $("#libraryMore").open ? "1" : "0"); } catch {} });
  try { $("#libraryMore").open = localStorage.getItem("rss-reader.library-more-open") === "1"; } catch {}
  document.addEventListener("click", e => { if (e.target.closest("[data-rail-search]")) { state.settings.sidebarCollapsed = false; local(S, state.settings); applySidebarCollapsed(); $("#search").focus(); } if (e.target.closest("[data-rail-refresh]")) refresh(); if (e.target.closest("[data-rail-next-unread]")) moveUnread(1); if (e.target.closest("#railTheme")) $("#theme").click(); if (e.target.closest("#railSettings")) showSettings(); });
  $("#menu").onclick = () => {
    const open = $("#sidebar").classList.toggle("open");
    $("#scrim").classList.toggle("show", open);
  };
  $("#sideToggle").onclick = () => {
    state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
    local(S, state.settings);
    applySidebarCollapsed();
  };
  window.addEventListener("popstate", () => {
    document.body.classList.remove("reader-open", "focus-mode");
    updateFocusButton();
    stopTTS();
    if ($("#reader").classList.contains("open") || state.selected) {
      $("#reader").classList.remove("open");
      state.selected = null;
      render();
    }
  });
  // Follow the OS theme live when the user chose "System".
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (state.settings.theme === "system") applySettings();
  });
  let vimPendingG = false, vimPendingGTimer = null;
  function visibleVimSidebarItems() {
    return $("#feeds .folder-toggle, #feeds .feed-row").filter(node => node.getClientRects().length);
  }
  function moveVimSidebarCursor(direction) {
    const nodes = visibleVimSidebarItems();
    if (!nodes.length) return;
    let index = nodes.findIndex(node => node.classList.contains("vim-cursor"));
    if (index < 0) {
      index = nodes.findIndex(node => node.dataset.feed === state.feed);
      if (index < 0) index = direction > 0 ? -1 : nodes.length;
    }
    index = Math.max(0, Math.min(nodes.length - 1, index + direction));
    nodes.forEach(node => node.classList.toggle("vim-cursor", nodes[index] === node));
    nodes[index].scrollIntoView({block:"nearest"});
  }
  function vimSidebarEnter() {
    const selected = $("#feeds .vim-cursor");
    if (selected) selected.click();
    else if (state.feed) $("#feeds [data-feed=\"" + CSS.escape(state.feed) + "\"]")?.click();
  }
  function vimListEdge(edge) {
    const items = visible();
    if (!items.length) return;
    const item = edge === "top" ? items[0] : items[items.length - 1];
    state.selected = item.id;
    renderList();
    document.querySelector("[data-article=\"" + CSS.escape(item.id) + "\"]")?.scrollIntoView({block:"nearest"});
  }
  function handleVimNavigation(e) {
    if (shortcutPreset() !== "vim" || e.altKey || e.metaKey) return false;
    const pane = state.settings.vimPane || "list", key = e.key;
    if (vimPendingG) {
      clearTimeout(vimPendingGTimer); vimPendingG = false;
      if (key === "g" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (pane === "sidebar") visibleVimSidebarItems()[0]?.scrollIntoView({block:"nearest"});
        else if (pane === "list") vimListEdge("top");
        else $("#reader")?.scrollTo({top:0});
        return true;
      }
      // Preserve the preset's other g-prefixed commands (g a, g u, etc.).
      const sequenceAction = (PRESETS[shortcutPreset()] || PRESETS.inoreader).keys["g " + keyDesc(e)];
      if (sequenceAction) {
        e.preventDefault();
        runShortcutAction(sequenceAction, e);
        return true;
      }
    }
    if (key === "g" && !e.ctrlKey && !e.shiftKey) {
      vimPendingG = true;
      vimPendingGTimer = setTimeout(() => { vimPendingG = false; }, 1000);
      e.preventDefault(); return true;
    }
    if (key === "D" && pane === "sidebar" && !e.ctrlKey && !e.altKey) {
      toggleSidebar();
      setVimPaneFocus("sidebar");
      e.preventDefault(); return true;
    }
    if ((key === "h" || key === "l") && !pendingSeq) {
      const panes = ["sidebar", "list", "article"];
      setVimPaneFocus(panes[Math.max(0, Math.min(2, panes.indexOf(pane) + (key === "h" ? -1 : 1)))]);
      e.preventDefault(); return true;
    }
    if (key === "j" || key === "k") {
      const dir = key === "j" ? 1 : -1;
      if (pane === "sidebar") moveVimSidebarCursor(dir);
      else if (pane === "list") moveHighlight(dir);
      else $("#reader")?.scrollBy({top:dir * 40});
      e.preventDefault(); return true;
    }
    if (key === "G" && !e.ctrlKey) {
      if (pane === "sidebar") visibleVimSidebarItems().at(-1)?.scrollIntoView({block:"nearest"});
      else if (pane === "list") vimListEdge("bottom");
      else $("#reader")?.scrollTo({top:$("#reader").scrollHeight});
      e.preventDefault(); return true;
    }
    if ((key === "d" || key === "u") && !e.altKey && !e.metaKey) {
      const target = pane === "sidebar" ? $("#sidebar") : pane === "list" ? $(".list-pane") : $("#reader");
      target?.scrollBy({top:(key === "d" ? 1 : -1) * target.clientHeight / 2});
      e.preventDefault(); return true;
    }
    if (key === " ") {
      const target = pane === "sidebar" ? $("#sidebar") : pane === "list" ? $(".list-pane") : $("#reader");
      target?.scrollBy({top:(e.shiftKey ? -1 : 1) * target.clientHeight / 2});
      e.preventDefault(); return true;
    }
    if (key === "Enter") {
      if (pane === "sidebar") vimSidebarEnter();
      else if (pane === "list" && state.selected) openItem(state.selected);
      e.preventDefault(); return true;
    }
    if (key === "q" && pane === "article") {
      closeReader(); setVimPaneFocus("list"); e.preventDefault(); return true;
    }
    return false;
  }
  for (const [selector, pane] of [["#sidebar", "sidebar"], [".list-pane", "list"], ["#reader", "article"]]) {
    $(selector)?.addEventListener("pointerdown", () => {
      if (shortcutPreset() === "vim") setVimPaneFocus(pane);
    });
  }
  document.onkeydown = e => {
    const active = document.activeElement;
    const tag = active?.tagName;
    const editable = ["INPUT", "SELECT", "TEXTAREA"].includes(tag) || active?.isContentEditable;
    const dialogOpen = $("dialog[open]");
    // Escape leaves an editing field first. A second Escape in Normal
    // mode moves focus to the sidebar, where global navigation lives.
    if (shortcutPreset() === "vim" && e.key === "Escape" && !dialogOpen) {
      clearTimeout(vimPendingGTimer);
      vimPendingG = false;
      clearTimeout(pendingSeqTimer);
      pendingSeq = null;
      if (editable) {
        e.preventDefault();
        active.blur();
        setVimPaneFocus(state.settings.vimPane || "list");
        return;
      }
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      setVimPaneFocus("sidebar");
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !dialogOpen) {
      e.preventDefault();
      showCommandPalette();
      return;
    }
    if (editable || dialogOpen) return;
    if (handleVimNavigation(e)) return;
    if (e.key === "Escape") {
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      // An open menu closes first; only a bare Escape closes the
      // reader (#173: Escape used to close both at once).
      const mr = $("#markReadMenu");
      if (mr && !mr.hidden) { closeMarkMenu(); return; }
      const fm = $("#filterMenu");
      if (fm && !fm.hidden) { fm.hidden = true; $("#filterMenuBtn")?.setAttribute("aria-expanded", "false"); return; }
      const sm = $("#snoozeMenu");
      if (sm && !sm.hidden) { sm.hidden = true; return; }
      if (feedMenuFeedId && !$("#feedMenu").hidden) { closeFeedMenu(); return; }
      closeReader();
      return;
    }
    // A focused button keeps its normal Space/Enter behavior; the
    // shortcuts below must not hijack it (or double-activate it).
    // Letter shortcuts still work from button focus: no button
    // activates on a letter key, so there is nothing to double-fire.
    if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    const desc = keyDesc(e);
    const preset = PRESETS[shortcutPreset()] || PRESETS.inoreader;
    // A two-key sequence (g, z, d) is pending: the second key
    // completes it. An unmatched second key falls through to the
    // normal dispatch below, so "/" still searches after a stray "g".
    if (pendingSeq) {
      const first = pendingSeq;
      clearTimeout(pendingSeqTimer);
      pendingSeq = null;
      const seqAction = preset.keys[first + " " + desc];
      if (seqAction) { e.preventDefault(); runShortcutAction(seqAction, e); return; }
    }
    // Space scrolls the open reader; with no article open it runs
    // the preset's Space binding (Inoreader: open next article).
    if (desc === "Space" || desc === "Shift+Space") {
      const reader = $("#reader");
      if (reader.classList.contains("open")) {
        e.preventDefault();
        reader.scrollBy({ top: (desc === "Shift+Space" ? -1 : 1) * reader.clientHeight * 0.9 });
        return;
      }
      const spaceAction = preset.keys[desc];
      if (spaceAction) { e.preventDefault(); runShortcutAction(spaceAction, e); }
      return;
    }
    // A key that starts a two-key sequence (g, z, d) waits for the
    // next key instead of running an action. A key is a prefix only
    // when the active preset actually has a sequence starting with
    // it, so "d" still toggles the sidebar in Inoreader (where it is
    // a single key) and starts a sequence in BazQux (where it is not).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && Object.keys(preset.keys).some(k => k.startsWith(desc + " "))) {
      clearTimeout(pendingSeqTimer);
      pendingSeq = desc;
      pendingSeqTimer = setTimeout(() => { pendingSeq = null; }, 1200);
      return;
    }
    const action = preset.keys[desc];
    if (!action) return;
    // Toggles and one-shot actions do not auto-repeat when the key
    // is held down; navigation does.
    if (e.repeat && ["toggleRead", "toggleReadNext", "toggleReadPrev", "save", "fullArticle", "markVisibleRead", "markAbove", "markBelow", "markReadAdvance", "markUnreadSkip", "refresh", "addFeed", "share", "tag", "copyUrl", "unsubscribe", "editFeed", "fullscreen", "textBigger", "textSmaller", "textReset", "sidebarToggle", "folderToggle", "closeReader", "help", "search"].includes(action)) return;
    e.preventDefault();
    runShortcutAction(action, e);
  };
  bindApplicationChrome();
  // Sidebar drag and drop (#182).
  setupFeedDrag();
}

/* ---------- app updates (#144) ----------
   The service worker is the update mechanism: a new build ships a new
   sw.js, the worker installs it and waits, and the page offers the
   reload. The worker never activates on its own, so an update never
   interrupts reading. Checks run on launch, every 30 minutes, and
   whenever the tab becomes visible again, plus on demand from Settings. */
let swReg = null, updateBannerShown = false, updateReloadPending = false;
function showUpdateBanner() {
  if (updateBannerShown) return;
  updateBannerShown = true;
  const b = $("#updateBanner");
  if (b) b.hidden = false;
  const st = $("#updateStatus");
  if (st) st.textContent = "A new version is available. Reload to update.";
}
function hideUpdateBanner() {
  updateBannerShown = false;
  const b = $("#updateBanner");
  if (b) b.hidden = true;
}
async function checkForUpdates() {
  const st = $("#updateStatus");
  if (st) st.textContent = "Checking for updates…";
  if (!swReg) {
    if (st) st.textContent = "Updates are not available in this browser.";
    return;
  }
  try { await swReg.update(); } catch {
    if (st) st.textContent = "Could not check for updates. Try again later.";
    return;
  }
  // update() resolves when the check finishes, but a new worker may
  // still be installing, so the updatefound handler reports the result
  // when it lands. If nothing is waiting after a short pause, the app
  // is current.
  setTimeout(() => {
    if (swReg.waiting) {
      showUpdateBanner();
      if (st) st.textContent = "A new version is available. Reload to update.";
    } else if (st && !updateBannerShown) {
      st.textContent = `You're up to date (v${APP_VERSION}).`;
    }
  }, 1500);
}
function initServiceWorker() {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then(reg => {
      swReg = reg;
      // A worker that finishes installing while this page is open
      // means a new build is waiting.
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
      // A worker may already be waiting (installed while the page
      // was closed); offer the update now.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  // The waiting worker takes over only when the user chooses Reload,
  // so a reload here always lands on the new build.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateReloadPending) { updateReloadPending = false; location.reload(); }
  });
  const reloadBtn = $("#updateReload");
  if (reloadBtn) reloadBtn.onclick = () => {
    updateReloadPending = true;
    if (swReg?.waiting) swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    // Fallback: if the worker does not take over promptly, reload
    // anyway rather than leaving the user stuck on the banner.
    setTimeout(() => { if (updateReloadPending) location.reload(); }, 5000);
  };
  const dismissBtn = $("#updateDismiss");
  if (dismissBtn) dismissBtn.onclick = hideUpdateBanner;
}

async function init() {
  loadLocal();
  // Open storage with one retry: a transient failure must not leave a
  // dead page. If it still fails, show the shell with a retry instead.
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt++) {
    try { db = await openDB(); opened = true; }
    catch (e) { if (attempt === 0) await new Promise(r => setTimeout(r, 600)); }
  }
  bind();
  applySettings();
  if (opened) {
    try {
      state.items = await dbAll();
      state.highlights = await hlAll();
      syncTags();
      saveTags();
      mirrorSync();
    } catch (e) {
      console.error(e);
      toast("Could not load your articles.");
    }
  }
  if (!restoreAppSession()) render();
  if (!opened) {
    toast("Could not open browser storage. Your articles are unavailable.", { label: "Retry", fn: () => location.reload() });
  } else {
    if (state.feedsRestored) toast("Your subscriptions were restored from a backup copy.");
    // Evaluate each feed against its own interval and retry backoff on
    // launch; a minute-level scheduler handles due feeds while the app is visible.
    if (state.feeds.length) {
      refresh(true);
      if (!automaticRefreshTimer) automaticRefreshTimer = setInterval(() => {
        if (document.visibilityState === "visible" && !$("#refresh")?.disabled) refresh(true);
      }, 60000);
    }
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    initServiceWorker();
  }
  // Re-register the periodic sync if it was on: a browser restart or
  // a service worker update can drop the registration.
  if (state.settings.backgroundSync) applyBackgroundSync(true);
}
init();
})();
