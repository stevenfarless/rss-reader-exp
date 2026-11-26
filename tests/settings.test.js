import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, installScript] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../pwa-install.js", import.meta.url), "utf8")
]);

const dialogStart = html.indexOf('<dialog id="settingsDialog"');
const dialogEnd = html.indexOf("</dialog>", dialogStart);
const settingsDialog = dialogStart >= 0 && dialogEnd >= 0
  ? html.slice(dialogStart, dialogEnd + "</dialog>".length)
  : "";

test("settings dialog keeps all existing setting controls", () => {
  assert.ok(settingsDialog, "settings dialog exists");
  const ids = [
    "themeSelect", "widthSelect", "sizeSelect", "fontSelect", "lineHeightSelect",
    "progressSelect", "mobileBarSelect", "shortcutPresetSelect", "cardExcerptSelect",
    "cardImageToggle", "toolbarOrderList", "hideDuplicatesToggle",
    "shortcutCoachingToggle", "shortcutBarToggle", "globalRefreshMinutesSelect",
    "retentionDaysSelect", "retentionCountSelect", "backgroundSyncToggle",
    "notifyNewToggle", "syncNote", "appVersion", "checkUpdates", "updateStatus",
    "exportBackup", "importBackup", "backupFile", "exportAnnotationsJSON",
    "exportAnnotationsMarkdown", "storageUsage", "previewCleanup", "openFeedHealth",
    "openStats", "exportSettings", "importSettings", "settingsFile", "organize",
    "manageRules", "importOpml", "exportOpml", "opmlFile", "saveSettings"
  ];
  for (const id of ids) {
    assert.ok(settingsDialog.includes('id="' + id + '"'), id + " remains available");
  }
});

test("settings are grouped into labelled, non-empty sections", () => {
  assert.ok(settingsDialog);
  const sections = [...settingsDialog.matchAll(/<section class="settings-section" data-settings-section="([^"]+)" aria-labelledby="([^"]+)">([\s\S]*?)<\/section>/g)];
  assert.deepEqual(sections.map(section => section[1]), [
    "appearance", "reading", "feeds", "data", "application"
  ]);
  for (const section of sections) {
    assert.ok(section[3].includes('id="' + section[2] + '"'));
    assert.match(section[3], /<h3 class="settings-group"/);
  }
});

test("settings dialog retains native close and Done submission behavior", () => {
  assert.match(settingsDialog, /<form method="dialog">/);
  assert.match(settingsDialog, /<button class="x" value="cancel" aria-label="Close settings"/);
  assert.match(settingsDialog, /<button value="default" id="saveSettings" class="primary">Done<\/button>/);
});

test("PWA installation guidance is inserted in the Application section", () => {
  assert.match(installScript, /#settingsDialog \.settings-section\[data-settings-section='application'\]/);
  assert.match(installScript, /applicationHeading\.after\(button\)/);
});
