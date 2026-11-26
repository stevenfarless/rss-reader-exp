import { test, expect } from "@playwright/test";

test("desktop sidebar controls open commands and activity without a top toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#appToolbar")).toHaveCount(0);
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#commandButton")).toBeVisible();
  await expect(page.locator("#panePreset")).toHaveCount(0);

  await page.locator("#commandButton").click();
  await expect(page.locator("#commandDialog")).toBeVisible();
  await page.locator("#commandInput").fill("settings");
  await page.getByRole("option", { name: /Open settings/ }).click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await page.locator("#settingsDialog .x").click();

  await page.keyboard.press("Control+k");
  await expect(page.locator("#commandDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#commandButton").click();
  await page.locator("#commandInput").fill("text size: large");
  await page.getByRole("option", { name: /Text size: Large/ }).click();
  await expect(page.locator("#toast")).toContainText("Text size set to Large");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rss-reader.settings.v1")).size)).toBe("large");
  await page.locator("#settings").click();
  await expect(page.locator("#sizeSelect")).toHaveValue("large");
  await page.locator("#settingsDialog .x").click();

  await page.locator("#activityButton").click();
  await expect(page.locator("#activityDialog")).toBeVisible();
  await expect(page.locator("#activityContent")).toContainText("Online");
  await expect(page.locator("#activityContent")).toContainText("Feed problems");
});

test("desktop sidebar automatically collapses before its controls become cramped", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("rss-reader.settings.v1") || "{}");
    settings.sidebarWidth = 200;
    settings.sidebarCollapsed = false;
    localStorage.setItem("rss-reader.settings.v1", JSON.stringify(settings));
  });
  await page.reload();

  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("#sideToggle")).toHaveAttribute("aria-label", "Expand sidebar");
  await expect(page.locator("#sidebar")).toHaveCSS("width", "52px");

  await page.locator("#sideToggle").click();
  await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("#sidebar")).toHaveCSS("width", "230px");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rss-reader.settings.v1")).sidebarWidth)).toBe(230);
});

test("article selection controls appear only after entering selection mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.evaluate(async () => {
    const request = indexedDB.open("rss-reader-cache", 3);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").put({ id:"selection-mode-article", feedId:"selection-mode-feed", feedTitle:"Selection Test Feed", title:"Article for selection mode", url:"https://example.com/selection-mode", summary:"Test article", content:"<p>Selection test content.</p>", published:new Date().toISOString(), read:false, saved:false, queued:false, tags:[] });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  const article = page.locator('[data-item="selection-mode-article"]');
  await expect(article).toBeVisible();
  await expect(article.locator("[data-select-item]")).toBeHidden();
  await expect(page.locator("#selectionToolbar")).toBeHidden();
  await page.locator("#selectArticlesBtn").click();
  await expect(page.locator("#selectArticlesBtn")).toHaveText("Done");
  await expect(article.locator("[data-select-item]")).toBeVisible();
  await expect(page.locator("#selectionToolbar")).toBeHidden();
  await article.locator("[data-select-item]").click();
  await expect(page.locator("#selectionToolbar")).toBeVisible();
  await expect(page.locator("#selectionCount")).toHaveText("1 selected");
  await page.locator("#selectArticlesBtn").click();
  await expect(page.locator("#selectArticlesBtn")).toHaveText("Select");
  await expect(article.locator("[data-select-item]")).toBeHidden();
  await expect(page.locator("#selectionToolbar")).toBeHidden();
});
test("sidebar sections collapse independently and mobile navigation uses a full-height drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const sidebar = page.locator("#sidebar");
  await page.locator("#menu").click();
  await expect(sidebar).toHaveClass(/open/);
  await expect(sidebar).toHaveCSS("width", "390px");
  await page.locator("#librarySection > summary").click();
  await expect(page.locator("#librarySection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#feedsSection")).toHaveAttribute("open", "");
  await page.locator("#feedsSection > summary").click();
  await expect(page.locator("#feedsSection")).not.toHaveAttribute("open", "");
  await page.locator("#mobileSidebarClose").click();
  await expect(sidebar).not.toHaveClass(/open/);
});

test("mobile navigation exposes primary and secondary library views", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#mobileNavigation")).toBeVisible();
  await page.locator('#mobileNavigation [data-view="unread"]').click();
  await expect(page.locator("#heading")).toHaveText("Unread");

  await page.locator("#mobileMore").click();
  await expect(page.locator("#moreDialog")).toBeVisible();
  await page.locator('#moreDialog [data-view="snoozed"]').click();
  await expect(page.locator("#moreDialog")).not.toBeVisible();
  await expect(page.locator("#heading")).toHaveText("Snoozed");
  await page.reload();
  await expect(page.locator("#heading")).toHaveText("Snoozed");
});

test("focus mode requires an article and exits cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#appFocus").click();
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
  await expect(page.locator("#toast")).toContainText("Open an article");
});

test("reopening the app restores the selected article and reader scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.evaluate(async () => {
    const request = indexedDB.open("rss-reader-cache", 3);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const paragraphs = Array.from({ length: 45 }, (_, i) => `<p>Persisted article paragraph ${i + 1}. This text provides enough content to test restoration of the reader's scroll position after a reload.</p>`).join("");
    await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").put({
        id: "session-restore-article",
        feedId: "session-restore-feed",
        feedTitle: "Session Restore Feed",
        title: "Restored article",
        url: "https://example.com/restored-article",
        summary: "A test article for session restoration.",
        content: paragraphs,
        published: new Date().toISOString(),
        read: false,
        saved: false,
        queued: false,
        tags: []
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.reload();
  await page.locator('[data-item="session-restore-article"]').click();
  await expect(page.locator("#reader h1")).toHaveText("Restored article");
  await page.locator("#reader").evaluate(el => {
    el.scrollTop = 360;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(250);
  await page.reload();

  await expect(page.locator("#reader")).toHaveClass(/open/);
  await expect(page.locator("#reader h1")).toHaveText("Restored article");
  await expect.poll(() => page.locator("#reader").evaluate(el => el.scrollTop)).toBeGreaterThan(300);
});
