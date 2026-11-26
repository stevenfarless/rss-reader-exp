/* Pure helpers shared by the reader and its tests. No DOM, no state:
   these functions are deterministic and safe to import in Node. Loaded
   as a classic script before app.js, so app.js uses the same globals. */
function normalizeFeedUrl(raw) {
  let s = String(raw || "").trim();
  // Accept a bare address ("example.com/feed", "example.com") — assume https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol === "http:") u.protocol = "https:";
  return u.href;
}
function sameFeedUrl(a, b) {
  try {
    const na = new URL(a), nb = new URL(b);
    // Only the scheme and host are case-insensitive: URL paths are
    // case-sensitive, so /Feed.xml and /feed.xml are different feeds.
    const norm = u => (u.protocol + "//" + u.hostname.replace(/^www\./, "").toLowerCase() + u.pathname.replace(/\/$/, "") + u.search);
    return norm(na) === norm(nb);
  } catch { return a === b; }
}
/* Canonical article URL (#115): the strict duplicate definition. The
   same story at the same address is one article, even when feeds carry
   it with different tracking parameters, a fragment, or a www prefix.
   A different address is a different article, even with the same title. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid)/i;
const canonicalUrl = u => {
  try {
    const p = new URL(u);
    p.hash = "";
    p.hostname = p.hostname.replace(/^www\./, "").toLowerCase();
    [...p.searchParams.keys()].forEach(k => { if (TRACKING_PARAMS.test(k)) p.searchParams.delete(k); });
    p.searchParams.sort();
    p.pathname = p.pathname.replace(/\/+$/, "") || "/";
    return p.href;
  } catch { return String(u || ""); }
};
function dedupeItems(a) {
  const seen = new Set();
  return a.filter(x => {
    // The canonical URL is stored at save time; older items predate
    // the field and fall back to computing it.
    const k = x.canonical || canonicalUrl(x.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/* Shorten text to n characters at a word boundary, with an ellipsis. */
const snippet = (s, n) => {
  s = String(s || "");
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, n)) + "…";
};
/* Rules (#109): a rule matches when its scope (all feeds, one folder,
   or one feed) matches and every condition it sets (title keyword,
   author) matches. */
function ruleMatches(rule, feed, item) {
  if (!rule.enabled) return false;
  if (rule.scope?.startsWith("feed:")) { if (feed.id !== rule.scope.slice(5)) return false; }
  else if (rule.scope?.startsWith("folder:")) { if ((feed.group || "") !== rule.scope.slice(7)) return false; }
  if (rule.keyword && !(item.title || "").toLowerCase().includes(rule.keyword.toLowerCase())) return false;
  if (rule.author && !(item.author || "").toLowerCase().includes(rule.author.toLowerCase())) return false;
  return true;
}
/* Strip publisher boilerplate out of summaries before they reach the
   list. Hacker News descriptions are "Article URL: … Comments URL: …
   Points: N # Comments: M"; some feeds (e.g. NASA APOD via WordPress)
   ship site navigation in the summary, which is cut at the first nav
   marker with the leading header tokens dropped. */
const NAV_MARKERS = ["Today's APOD", "Archive Submissions", "Previous APOD"];
const cleanSummary = s => {
  // Curly apostrophes/quotes (e.g. "Today’s APOD" from a decoded
  // excerpt) must be normalized before the marker match below.
  s = (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
  const hn = s.match(/Article URL:.*?Points:\s*(\d+)\s*# Comments:\s*(\d+)/i);
  if (hn) return `${hn[1]} points · ${hn[2]} comments`;
  let cut = s.length;
  for (const m of NAV_MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  s = s.slice(0, cut).trim();
  // The navigation cut leaves a leading run of header tokens
  // ("APOD Astronomy Picture of the Day"); drop them.
  const lead = s.match(/^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}\s+){1,3}(?=[A-Z])/);
  if (lead && s.length > lead[0].length + 20) s = s.slice(lead[0].length).trim();
  return s;
};

/* Move a feed within the sidebar list (#182): reorder it, or move it
   into another folder (or out to Ungrouped). `target` is either
   { kind: "row", feedId, before } (drop on a feed row, joining that
   feed's folder) or { kind: "folder", group } (drop on a folder head
   or container: append at the end of that folder; "" is Ungrouped).
   Mutates the array in place and returns the moved feed, or null when
   the dragged feed is unknown. Dropping a feed on itself is a no-op. */
function moveFeedInList(feeds, draggedId, target) {
  const from = feeds.findIndex(f => f.id === draggedId);
  if (from < 0) return null;
  const [feed] = feeds.splice(from, 1);
  if (target.kind === "row") {
    const to = feeds.findIndex(f => f.id === target.feedId);
    if (to < 0) { feeds.splice(from, 0, feed); return feed; }
    feed.group = typeof feeds[to].group === "string" ? feeds[to].group : "";
    feeds.splice(target.before ? to : to + 1, 0, feed);
  } else {
    feed.group = typeof target.group === "string" ? target.group : "";
    let at = feeds.length;
    for (let i = feeds.length - 1; i >= 0; i--) {
      if ((feeds[i].group || "") === feed.group) { at = i + 1; break; }
    }
    feeds.splice(at, 0, feed);
  }
  return feed;
}

/* Whether the article author is already shown as the feed title, so
   the card should not repeat it in the bottom row. */
function authorIsFeedTitle(author, feedTitle) {
  const a = (author || "").trim().toLowerCase();
  const t = (feedTitle || "").trim().toLowerCase();
  return !!a && a === t;
}

/* The named folders a set of feeds belongs to, sorted; ungrouped ("")
   is not a folder and is left out. */
function namedFolderNames(feeds) {
  return [...new Set(feeds.map(f => f.group).filter(g => typeof g === "string" && g))].sort((a, b) => a.localeCompare(b));
}
/* Cycle a feed's own sort (#183): use global, then newest, then
   oldest, then back to global. */
function nextFeedSort(current) {
  return !current || current === "global" ? "newest" : current === "newest" ? "oldest" : "global";
}

/* Normalize a stored reader-toolbar button order (#197): keep known
   keys in their stored order, drop unknown keys, and append any keys
   the stored order is missing (so a new button still appears). */
function normalizeToolbarOrder(stored, keys, fallback) {
  const list = Array.isArray(stored) ? stored.filter(k => keys.includes(k)) : [];
  const base = list.length ? list : [...fallback];
  const missing = keys.filter(k => !base.includes(k));
  return [...base, ...missing];
}

/* Whether every named folder is collapsed, so the collapse/expand-all
   toggle should offer "expand all". False when there are no folders. */
function allFoldersCollapsed(names, collapsed) {
  return names.length > 0 && names.every(n => collapsed.has(n));
}

/* ---------- keyboard shortcut presets (#185) ----------
   The default is Inoreader (the user's choice). Each preset is a map
   from a normalized key descriptor to an action name; the keydown
   handler dispatches through the active preset's map. A descriptor is
   built from e.code (so Shift+1 still reads as "1", not "!") with
   Ctrl+/Alt+/Shift+ prefixes. Only keys verified in the research
   (SHORTCUTS-RESEARCH-2026-11-20.md) are bound; the quick-access
   jump palette ("." and the g/d sequences that need it) is deferred,
   so "." is left unassigned in every preset. */
function keyDesc(e) {
  let base = "";
  const c = e.code || "";
  if (c.startsWith("Key")) base = c.slice(3).toLowerCase();
  else if (c.startsWith("Digit")) base = c.slice(5);
  else if (c === "Space") base = "Space";
  else if (c === "Escape") base = "Esc";
  else if (c === "Enter") base = "Enter";
  else if (c === "Tab") base = "Tab";
  else if (c === "Equal") base = "=";
  else if (c === "Minus") base = "-";
  else if (c === "BracketLeft") base = "[";
  else if (c === "BracketRight") base = "]";
  else if (c === "Slash") base = "/";
  else if (c === "Period") base = ".";
  else if (c === "Comma") base = ",";
  else if (c === "Quote") base = "'";
  else if (c === "Semicolon") base = ";";
  else if (c === "Backquote") base = "`";
  else if (c === "Backslash") base = "\\";
  else if (c === "ArrowUp") base = "ArrowUp";
  else if (c === "ArrowDown") base = "ArrowDown";
  else if (c === "ArrowLeft") base = "ArrowLeft";
  else if (c === "ArrowRight") base = "ArrowRight";
  else if (c === "PageUp") base = "PageUp";
  else if (c === "PageDown") base = "PageDown";
  else if (c === "Home") base = "Home";
  else if (c === "End") base = "End";
  else base = e.key || "";
  let d = "";
  if (e.ctrlKey) d += "Ctrl+";
  if (e.altKey) d += "Alt+";
  if (e.metaKey) d += "Meta+";
  if (e.shiftKey) d += "Shift+";
  return d + base;
}
/* Human-readable labels for the help dialog, per action. */
const ACTION_LABELS = {
  nextOpen: "Next article", prevOpen: "Previous article",
  moveNext: "Move to next article (without opening)", movePrev: "Move to previous article (without opening)",
  nextUnread: "Next unread article", prevUnread: "Previous unread article", oldestUnread: "Oldest unread article",
  openSelected: "Open selected article", openOriginal: "Open original article in a new tab",
  openBackground: "Open original in a new tab", openCurrentTab: "Open original in the current tab",
  toggleRead: "Toggle read / unread", toggleReadNext: "Toggle read, move to next", toggleReadPrev: "Toggle read, move to previous",
  markVisibleRead: "Mark all articles in this list read", markAbove: "Mark articles above the selected one read",
  markBelow: "Mark articles below the selected one read", markReadAdvance: "Mark as read and move to next",
  markUnreadSkip: "Mark as unread and move to next",
  save: "Save / unsave article", tag: "Add a tag to the open article", fullArticle: "Toggle full article / feed excerpt",
  share: "Share article", addFeed: "Add a feed", refresh: "Refresh all feeds", search: "Search articles",
  help: "Show this help", closeReader: "Back to the article list", sidebarToggle: "Show / hide the sidebar",
  textBigger: "Larger article text", textSmaller: "Smaller article text", textReset: "Reset article text size",
  unreadView: "Show unread only", allView: "Show all articles", folderToggle: "Expand / collapse the folder",
  nextFeed: "Next feed", prevFeed: "Previous feed", parentFolder: "Select the parent folder",
  firstArticle: "First article in the list", lastArticle: "Last article in the list",
  scrollTop: "Scroll article to the top", copyUrl: "Copy article link", fullscreen: "Toggle full screen",
  unsubscribe: "Unsubscribe from this feed", editFeed: "Edit this feed's options",
  goAll: "Go to All articles", goUnread: "Go to Unread", goSaved: "Go to Saved", goSnoozed: "Go to Snoozed",
  goHighlights: "Go to Highlights", goToday: "Go to Today (Unread)", goIndex: "Go to All (Index)",
  goOrganize: "Open Folders & tags", goPrefs: "Open Settings", goStarred: "Go to Saved (Starred)",
  goFeeds: "Go to the feeds list", goHome: "Go to All (Home)"
};
/* The shared spine: these bindings are the same in nearly every
   reader, so each preset starts from them and overrides the keys
   that differ. */
const PRESET_SPINE = {
  "o": "openSelected", "Enter": "openSelected", "v": "openOriginal", "m": "toggleRead",
  "s": "save", "t": "tag", "w": "fullArticle", "r": "refresh", "/": "search",
  "Shift+/": "help", "h": "help", "Esc": "closeReader",
  "g a": "goAll", "g u": "goUnread", "g s": "goSaved", "g z": "goSnoozed", "g h": "goHighlights",
  "g g": "firstArticle", "Ctrl+m": "markAbove", "Shift+m": "markBelow"
};
const PRESETS = {
  inoreader: { name: "Inoreader", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "Space": "nextOpen", "Shift+Space": "prevOpen",
    "n": "moveNext", "p": "movePrev", "Shift+j": "nextUnread", "Shift+k": "prevUnread",
    "Shift+n": "moveNext", "Shift+p": "movePrev", "Shift+o": "openSelected",
    "a": "addFeed", "Shift+a": "markVisibleRead", "e": "share", "b": "openBackground",
    "=": "textBigger", "-": "textSmaller", "0": "textReset",
    "Shift+1": "unreadView", "Shift+2": "allView", "Shift+x": "folderToggle", "d": "sidebarToggle",
    "u": "closeReader"
  } },
  feedly: { name: "Feedly", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "n": "moveNext", "p": "movePrev",
    "Shift+j": "nextFeed", "Shift+k": "prevFeed", "Shift+a": "markVisibleRead",
    "x": "markReadAdvance", "t": "save", "s": "save", "[": "sidebarToggle",
    "g t": "goToday", "g a": "goAll", "g l": "goSaved", "g i": "goIndex",
    "g o": "goOrganize", "g p": "goPrefs", "g f": "goStarred", "g g": "firstArticle",
    "u": "closeReader"
  } },
  newsblur: { name: "NewsBlur", keys: { ...PRESET_SPINE,
    "j": "moveNext", "k": "movePrev", "n": "nextUnread", "m": "oldestUnread", "u": "toggleRead",
    "s": "save", "Shift+a": "markVisibleRead", "Shift+j": "nextFeed", "Shift+k": "prevFeed",
    "Shift+Enter": "fullArticle", "Enter": "openSelected", "Space": "nextUnread", "Shift+Space": "prevUnread"
  } },
  feedbin: { name: "Feedbin", keys: { ...PRESET_SPINE,
    "j": "moveNext", "k": "movePrev", "ArrowDown": "moveNext", "ArrowUp": "movePrev",
    "Space": "nextUnread", "c": "fullArticle", "f": "share", "a": "addFeed",
    "e": "folderToggle", "Shift+e": "editFeed", "Shift+c": "copyUrl", "Shift+f": "fullscreen",
    "Shift+a": "markVisibleRead", "g u": "goUnread", "g s": "goSaved", "g a": "goAll",
    "u": "closeReader"
  } },
  freshrss: { name: "FreshRSS", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "n": "moveNext", "p": "movePrev",
    "m": "toggleRead", "s": "save", "f": "fullscreen", "Shift+a": "markVisibleRead",
    "Shift+j": "nextFeed", "Shift+k": "prevFeed", "Alt+j": "nextFeed", "Alt+k": "prevFeed",
    "u": "closeReader"
  } },
  miniflux: { name: "Miniflux", keys: { ...PRESET_SPINE,
    "n": "moveNext", "j": "moveNext", "p": "movePrev", "k": "movePrev",
    "m": "toggleReadNext", "Shift+m": "toggleReadPrev", "Shift+a": "markVisibleRead",
    "f": "save", "s": "share", "d": "fullArticle", "g g": "firstArticle", "Shift+g": "lastArticle",
    "z t": "scrollTop", "Shift+r": "refresh", "#": "unsubscribe", "Shift+v": "openCurrentTab",
    "g u": "goUnread", "g b": "goStarred", "g f": "goFeeds", "g s": "goPrefs",
    "+": "addFeed", "u": "closeReader"
  } },
  oldreader: { name: "The Old Reader / Google Reader", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "n": "moveNext", "p": "movePrev",
    "Shift+n": "nextFeed", "Shift+p": "prevFeed", "Shift+x": "folderToggle",
    "s": "save", "t": "tag", "Shift+s": "share", "e": "share", "Shift+a": "markVisibleRead",
    "f": "fullscreen", "u": "sidebarToggle", "a": "addFeed", "b": "openBackground", "x": "openSelected",
    "g h": "goHome", "g a": "goAll", "g s": "goSaved", "g u": "goUnread"
  } },
  bazqux: { name: "BazQux", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "Shift+j": "nextFeed", "Shift+k": "prevFeed",
    "Shift+x": "folderToggle", "Shift+u": "parentFolder", "Shift+q": "markAbove", "Shift+z": "markBelow",
    "-": "textSmaller", "=": "textBigger", "Shift+-": "textSmaller", "Shift+=": "textBigger",
    "Shift+l": "markUnreadSkip", "u": "scrollTop", "Shift+a": "markVisibleRead", "s": "save", "m": "toggleRead",
    "d a": "goAll", "d s": "goSaved"
  } },
  commafeed: { name: "CommaFeed", keys: { ...PRESET_SPINE,
    "j": "nextOpen", "k": "prevOpen", "n": "moveNext", "p": "movePrev",
    "Space": "nextOpen", "m": "toggleRead", "s": "save", "Shift+j": "nextFeed", "Shift+k": "prevFeed",
    "Shift+a": "markVisibleRead", "v": "openOriginal", "u": "closeReader"
  } }
};

/* Vim is a first-class preset. The pane-navigation handler owns its
   movement keys, so remove the overlapping Inoreader bindings here. */
const vimKeys = { ...PRESETS.inoreader.keys };
for (const key of ["h", "j", "k", "d", "u", "Enter", "Space", "Shift+Space", "g g"]) delete vimKeys[key];
PRESETS.vim = { name: "Vim", keys: vimKeys };



// Shared lookup and event eligibility for contextual shortcut coaching.
function findShortcutForAction(presetName, action, presets = PRESETS) {
  const preset = presets?.[presetName];
  if (!preset?.keys || typeof action !== "string") return null;
  const match = Object.entries(preset.keys).find(([, boundAction]) => boundAction === action);
  return match?.[0] || null;
}

function isShortcutCoachPointerEvent(event, activation, now = Date.now(), maxAge = 1200) {
  return Boolean(
    event?.isTrusted === true &&
    Number(event.detail) > 0 &&
    activation?.isTrusted === true &&
    (activation.type === "mouse" || activation.type === "pen" || activation.type === "touch") &&
    Number.isFinite(activation.at) &&
    now >= activation.at &&
    now - activation.at <= maxAge
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeFeedUrl, sameFeedUrl, canonicalUrl, dedupeItems, snippet, ruleMatches, cleanSummary, moveFeedInList, namedFolderNames, allFoldersCollapsed, authorIsFeedTitle, normalizeToolbarOrder, nextFeedSort, keyDesc, PRESETS, ACTION_LABELS, findShortcutForAction, isShortcutCoachPointerEvent };
}
