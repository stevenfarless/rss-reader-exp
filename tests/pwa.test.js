import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.webmanifest"));
const html = read("../index.html");
const worker = read("../sw.js");
const app = read("../app.js");

test("web app manifest includes the required app identity and launch settings", () => {
  assert.ok(manifest.name, "manifest must define name");
  assert.ok(manifest.short_name, "manifest must define short_name");
  assert.ok(manifest.start_url, "manifest must define start_url");
  assert.ok(["standalone", "fullscreen", "minimal-ui"].includes(manifest.display),
    "manifest display must support an app-like window");
  assert.ok(manifest.background_color, "manifest must define background_color");
  assert.ok(manifest.theme_color, "manifest must define theme_color");
});

test("manifest provides the expected install and maskable icons", () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0,
    "manifest must define icons");

  for (const size of ["192x192", "512x512"]) {
    assert.ok(manifest.icons.some(icon => icon.sizes === size),
      `manifest must include a ${size} icon`);
  }

  assert.ok(manifest.icons.some(icon => icon.purpose?.split(/\s+/).includes("maskable")),
    "manifest must include a maskable icon");

  for (const icon of manifest.icons) {
    assert.ok(existsSync(new URL(`../${icon.src.replace(/^\.\//, "")}`, import.meta.url)),
      `manifest icon is missing: ${icon.src}`);
  }
});

test("document links the manifest and declares a mobile viewport", () => {
  assert.match(html, /<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"/i);
  assert.match(html, /<meta\s+name="viewport"[^>]*>/i);
  assert.match(html, /<meta\s+name="theme-color"[^>]*>/i);
});

test("the app registers a service worker with install, activation, and fetch handlers", () => {
  assert.match(app, /serviceWorker\.register\s*\(/);
  assert.match(worker, /addEventListener\s*\(\s*["']install["']/);
  assert.match(worker, /addEventListener\s*\(\s*["']activate["']/);
  assert.match(worker, /addEventListener\s*\(\s*["']fetch["']/);
});
