import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../pwa-install.js", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

function loadPwa({ standalone = false, nav = {}, stored = null } = {}) {
  const values = new Map(stored === null ? [] : [["rss-reader.pwa-install-dismissed.v1", stored]]);
  const window = { matchMedia: () => ({ matches: standalone }) };
  const navigator = { userAgent: "", platform: "", ...nav };
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  vm.runInNewContext(source, { window, navigator, localStorage });
  return { api: window.RSSReaderPWA, values };
}

test("installed-state detection supports display mode and iOS standalone", () => {
  assert.equal(loadPwa({ standalone: true }).api.isInstalled(), true);
  assert.equal(loadPwa({ nav: { standalone: true } }).api.isInstalled(), true);
  assert.equal(loadPwa().api.isInstalled(), false);
});

test("platform guidance distinguishes iOS Safari and macOS Safari", () => {
  const ios = loadPwa({ nav: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone"
  }});
  assert.equal(ios.api.detectPlatform(), "ios-safari");
  assert.match(ios.api.getGuidance("ios-safari").body, /Share button.*Add to Home Screen/);
  const mac = loadPwa({ nav: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    platform: "MacIntel"
  }});
  assert.equal(mac.api.detectPlatform(), "mac-safari");
  assert.match(mac.api.getGuidance("mac-safari").body, /File.*Add to Dock/);
});

test("Chromium browsers are not misidentified as Safari", () => {
  const chrome = loadPwa({ nav: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    platform: "MacIntel"
  }});
  assert.equal(chrome.api.detectPlatform(), "other");
});

test("dismissal persists across page loads", () => {
  const first = loadPwa();
  assert.equal(first.api.isDismissed(), false);
  first.api.saveDismissal();
  assert.equal(first.api.isDismissed(), true);
  assert.equal(loadPwa({ stored: "true" }).api.isDismissed(), true);
});

test("native installation prompt is invoked and its choice is returned", async () => {
  let prompted = false;
  const event = { prompt: async () => { prompted = true; }, userChoice: Promise.resolve({ outcome: "accepted" }) };
  const { api } = loadPwa();
  const result = await api.requestInstall(event);
  assert.equal(prompted, true);
  assert.equal(result.outcome, "accepted");
  assert.equal((await api.requestInstall(null)).outcome, "unavailable");
});

test("installation script is included in the offline shell cache", () => {
  assert.match(serviceWorker, /const CACHE = "rss-reader-shell-v\d+";/);
  assert.match(serviceWorker, /"\.\/pwa-install\.js"/);
  assert.match(serviceWorker, /pwa-install\\\.js/);
});
