import { test, expect } from "@playwright/test";

test("desktop sidebar controls open commands and activity without a top toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#appToolbar")).toHaveCount(0);
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#commandButton")).toBeVisible();
  await expect(page.locator("#panePreset")).toBeVisible();

  await page.locator("#commandButton").click();
  await expect(page.locator("#commandDialog")).toBeVisible();
  await page.locator("#commandInput").fill("settings");
  await page.getByRole("option", { name: /Open settings/ }).click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await page.locator("#settingsDialog .x").click();

  await page.keyboard.press("Control+k");
  await expect(page.locator("#commandDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#panePreset").selectOption("compact");
  await expect(page.locator("html")).toHaveCSS("--side-w", "205px");
  await page.reload();
  await expect(page.locator("#panePreset")).toHaveValue("compact");

  await page.locator("#activityButton").click();
  await expect(page.locator("#activityDialog")).toBeVisible();
  await expect(page.locator("#activityContent")).toContainText("Online");
  await expect(page.locator("#activityContent")).toContainText("Feed problems");
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
