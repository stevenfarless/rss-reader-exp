"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFeedUrl, sameFeedUrl, canonicalUrl, dedupeItems, snippet, ruleMatches, cleanSummary, moveFeedInList, namedFolderNames, allFoldersCollapsed, authorIsFeedTitle, normalizeToolbarOrder, nextFeedSort, keyDesc, PRESETS, ACTION_LABELS } = require("../utils.js");

test("normalizeFeedUrl adds https to a bare address and upgrades http", () => {
  assert.equal(normalizeFeedUrl("example.com/feed"), "https://example.com/feed");
  assert.equal(normalizeFeedUrl("http://example.com/feed"), "https://example.com/feed");
  assert.equal(normalizeFeedUrl("https://example.com/feed"), "https://example.com/feed");
});

test("sameFeedUrl ignores www and a trailing slash, but not path case", () => {
  assert.equal(sameFeedUrl("https://www.example.com/feed/", "https://example.com/feed"), true);
  assert.equal(sameFeedUrl("https://example.com/Feed.xml", "https://example.com/feed.xml"), false);
  assert.equal(sameFeedUrl("https://example.com/feed", "https://other.com/feed"), false);
});

test("canonicalUrl strips tracking params, fragments, and www, and sorts the rest", () => {
  assert.equal(canonicalUrl("https://www.example.com/a/?utm_source=x&b=2#frag"), "https://example.com/a?b=2");
  assert.equal(canonicalUrl("https://example.com/a/?fbclid=1&gclid=2"), "https://example.com/a");
  assert.equal(canonicalUrl("https://example.com/a/?z=1&a=2"), "https://example.com/a?a=2&z=1");
  assert.equal(canonicalUrl("https://example.com/a/"), "https://example.com/a");
});

test("dedupeItems collapses the same canonical URL and keeps the first", () => {
  const a = { url: "https://example.com/a/?utm_source=x" };
  const b = { url: "https://example.com/a/" };
  const c = { url: "https://example.com/b/" };
  assert.deepEqual(dedupeItems([a, b, c]), [a, c]);
  // A stored canonical value is used instead of re-parsing the URL.
  const d = { url: "https://example.com/a/?utm_source=x", canonical: "https://example.com/a" };
  assert.deepEqual(dedupeItems([d, b]), [d]);
});

test("snippet shortens at a word boundary and leaves short text alone", () => {
  assert.equal(snippet("short", 10), "short");
  assert.equal(snippet("one two three four", 10), "one two…");
});

test("ruleMatches respects scope, keyword, and author, and requires enabled", () => {
  const feed = { id: "f1", group: "Space" };
  const item = { title: "NASA Launches Rover", author: "Jane Doe" };
  const base = { enabled: true, scope: "all", keyword: "NASA", author: "" };
  assert.equal(ruleMatches(base, feed, item), true);
  assert.equal(ruleMatches({ ...base, enabled: false }, feed, item), false);
  assert.equal(ruleMatches({ ...base, keyword: "nasa" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, keyword: "Mars" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, author: "jane" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, author: "John" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, scope: "feed:f1" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, scope: "feed:f2" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, scope: "folder:Space" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, scope: "folder:Other" }, feed, item), false);
});

test("cleanSummary strips Hacker News boilerplate and APOD navigation", () => {
  assert.equal(cleanSummary("Article URL: https://example.com/ · Comments URL: https://news.ycombinator.com/item?id=1 · Points: 42 # Comments: 7"), "42 points · 7 comments");
  assert.equal(cleanSummary("A real summary. Today's APOD Archive Submissions Previous APOD"), "A real summary.");
  assert.equal(cleanSummary("A plain summary."), "A plain summary.");
});

test("moveFeedInList reorders within a folder", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "Space" }, { id: "c", group: "Space" }];
  moveFeedInList(feeds, "a", { kind: "row", feedId: "c", before: false });
  assert.deepEqual(feeds.map(f => f.id), ["b", "c", "a"]);
  moveFeedInList(feeds, "a", { kind: "row", feedId: "b", before: true });
  assert.deepEqual(feeds.map(f => f.id), ["a", "b", "c"]);
});

test("moveFeedInList moves a feed into another folder at a row", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "" }, { id: "c", group: "" }];
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "c", before: true });
  assert.equal(moved.group, "");
  assert.deepEqual(feeds.map(f => f.id), ["b", "a", "c"]);
});

test("moveFeedInList appends to a folder on a folder drop", () => {
  const feeds = [{ id: "a", group: "" }, { id: "b", group: "Space" }, { id: "c", group: "Space" }];
  moveFeedInList(feeds, "a", { kind: "folder", group: "Space" });
  assert.deepEqual(feeds.map(f => [f.id, f.group]), [["b", "Space"], ["c", "Space"], ["a", "Space"]]);
  moveFeedInList(feeds, "b", { kind: "folder", group: "" });
  assert.deepEqual(feeds.map(f => [f.id, f.group]), [["c", "Space"], ["a", "Space"], ["b", ""]]);
});

test("moveFeedInList is a no-op for an unknown feed or a drop on itself", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "Space" }];
  assert.equal(moveFeedInList(feeds, "z", { kind: "row", feedId: "b", before: true }), null);
  assert.deepEqual(feeds.map(f => f.id), ["a", "b"]);
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "a", before: true });
  assert.equal(moved.id, "a");
  assert.deepEqual(feeds.map(f => f.id), ["a", "b"]);
});

test("moveFeedInList never stores a non-string group", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: { name: "Space" } }, { id: "c", group: "" }];
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "b", before: true });
  assert.equal(moved.group, "");
  assert.equal(typeof moved.group, "string");
  const moved2 = moveFeedInList(feeds, "c", { kind: "folder", group: { name: "Space" } });
  assert.equal(moved2.group, "");
  assert.equal(typeof moved2.group, "string");
});

test("no duplicate top-level function declarations in the app source", () => {
  // Two functions with the same name silently shadow each other: the
  // drag handler once called the organize dialog's moveFeed(feedId,
  // folder) instead of the drag one, storing the whole drop-target
  // object as the feed's folder ("[object Object]").
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["app.js", "utils.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const names = [...src.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map(m => m[1]);
    const seen = new Set();
    for (const name of names) {
      assert.ok(!seen.has(name), `${file} declares function ${name} more than once`);
      seen.add(name);
    }
  }
});

test("namedFolderNames returns sorted unique named folders, skipping ungrouped", () => {
  assert.deepEqual(namedFolderNames([{ group: "Tech" }, { group: "" }, { group: "News" }, { group: "Tech" }, { group: null }, {}]), ["News", "Tech"]);
  assert.deepEqual(namedFolderNames([{ group: "" }]), []);
  assert.deepEqual(namedFolderNames([]), []);
});

test("allFoldersCollapsed is true only when every named folder is collapsed", () => {
  assert.equal(allFoldersCollapsed(["News", "Tech"], new Set(["News", "Tech"])), true);
  assert.equal(allFoldersCollapsed(["News", "Tech"], new Set(["News"])), false);
  assert.equal(allFoldersCollapsed(["News"], new Set()), false);
  assert.equal(allFoldersCollapsed([], new Set()), false);
});

test("authorIsFeedTitle matches the author to the feed title, ignoring case and whitespace", () => {
  assert.equal(authorIsFeedTitle("Bart D. Ehrman", "Bart D. Ehrman"), true);
  assert.equal(authorIsFeedTitle(" bart d. ehrman ", "Bart D. Ehrman"), true);
  assert.equal(authorIsFeedTitle("John Smith", "Bart D. Ehrman"), false);
  assert.equal(authorIsFeedTitle("", "Bart D. Ehrman"), false);
  assert.equal(authorIsFeedTitle(null, "Bart D. Ehrman"), false);
  assert.equal(authorIsFeedTitle("Bart D. Ehrman", ""), false);
});

test("normalizeToolbarOrder keeps stored order, drops unknown keys, appends missing ones", () => {
  const keys = ["a", "b", "c", "d"];
  assert.deepEqual(normalizeToolbarOrder(["c", "a", "zzz"], keys, keys), ["c", "a", "b", "d"]);
  assert.deepEqual(normalizeToolbarOrder(null, keys, keys), ["a", "b", "c", "d"]);
  assert.deepEqual(normalizeToolbarOrder([], keys, keys), ["a", "b", "c", "d"]);
  assert.deepEqual(normalizeToolbarOrder(["d", "b"], keys, keys), ["d", "b", "a", "c"]);
});

test("nextFeedSort cycles global to newest to oldest and back", () => {
  assert.equal(nextFeedSort(undefined), "newest");
  assert.equal(nextFeedSort("global"), "newest");
  assert.equal(nextFeedSort("newest"), "oldest");
  assert.equal(nextFeedSort("oldest"), "global");
});

test("keyDesc normalizes a keyboard event to a preset descriptor", () => {
  // keyDesc reads e.code, so Shift+1 still reads as "1" (not "!").
  const ev = (code, mods = {}) => ({ code, key: mods.key || "", shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta });
  assert.equal(keyDesc(ev("KeyJ")), "j");
  assert.equal(keyDesc(ev("KeyA", { shift: true })), "Shift+a");
  assert.equal(keyDesc(ev("Digit1", { shift: true })), "Shift+1");
  assert.equal(keyDesc(ev("Digit0")), "0");
  assert.equal(keyDesc(ev("Slash", { shift: true })), "Shift+/");
  assert.equal(keyDesc(ev("Space")), "Space");
  assert.equal(keyDesc(ev("Space", { shift: true })), "Shift+Space");
  assert.equal(keyDesc(ev("KeyM", { ctrl: true })), "Ctrl+m");
  assert.equal(keyDesc(ev("Equal")), "=");
  assert.equal(keyDesc(ev("BracketLeft")), "[");
});

test("every preset action has a help label, and no preset binds a browser-reserved key", () => {
  const reserved = new Set(["Ctrl+w", "Ctrl+t", "Ctrl+n", "Ctrl+l", "Ctrl+d", "Ctrl+h", "Ctrl+j", "Ctrl+s", "Ctrl+p", "Ctrl+f", "Ctrl+u", "Ctrl+a", "Ctrl+c", "Ctrl+v", "Ctrl+x", "Ctrl+z", "Ctrl+r", "Ctrl+g", "Ctrl+b", "Ctrl+e", "Ctrl+k", "Ctrl+0", "Ctrl+=", "Ctrl+-"]);
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.name, `${name} has a display name`);
    for (const [desc, action] of Object.entries(preset.keys)) {
      assert.ok(ACTION_LABELS[action], `${name}: action "${action}" (${desc}) has no help label`);
      assert.ok(!reserved.has(desc), `${name}: "${desc}" is a browser-reserved key`);
    }
  }
});

test("the Inoreader default opens with j/k, moves with n/p, and adds a feed with a", () => {
  const keys = PRESETS.inoreader.keys;
  assert.equal(keys["j"], "nextOpen");
  assert.equal(keys["k"], "prevOpen");
  assert.equal(keys["n"], "moveNext");
  assert.equal(keys["p"], "movePrev");
  assert.equal(keys["a"], "addFeed");
  assert.equal(keys["Shift+a"], "markVisibleRead");
  assert.equal(keys["w"], "fullArticle");
  assert.equal(keys["h"], "help");
  assert.equal(keys["Shift+/"], "help");
  assert.equal(keys["d"], "sidebarToggle");
  assert.equal(keys["="], "textBigger");
  assert.equal(keys["-"], "textSmaller");
  assert.equal(keys["0"], "textReset");
});

test("every preset keeps the shared spine (open, original, save, refresh, search, help)", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const k = preset.keys;
    assert.equal(k["o"], "openSelected", `${name}: o opens the selected article`);
    assert.equal(k["v"], "openOriginal", `${name}: v opens the original`);
    // Miniflux is the one exception: s saves to a service (share) and
    // f stars (save), per its own docs.
    if (name === "miniflux") {
      assert.equal(k["s"], "share", `${name}: s shares`);
      assert.equal(k["f"], "save", `${name}: f saves`);
    } else {
      assert.equal(k["s"], "save", `${name}: s saves`);
    }
    assert.equal(k["r"], "refresh", `${name}: r refreshes`);
    assert.equal(k["/"], "search", `${name}: / searches`);
    assert.ok(k["Shift+/"] === "help" || k["h"] === "help", `${name}: help is reachable`);
    assert.equal(k["g a"], "goAll", `${name}: g a goes to All`);
  }
});
