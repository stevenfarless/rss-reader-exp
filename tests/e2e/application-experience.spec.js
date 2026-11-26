import { test, expect } from "@playwright/test";

test("desktop application toolbar opens commands and activity", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#appToolbar")).toBeVisible();
  await expect(page.locator("#appbarTitle")).toHaveText("All articles");

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
});

test("focus mode requires an article and exits cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#appFocus").click();
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
  await expect(page.locator("#toast")).toContainText("Open an article");
});
