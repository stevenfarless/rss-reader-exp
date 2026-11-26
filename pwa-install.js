(() => {
  "use strict";
  const DISMISSAL_KEY = "rss-reader.pwa-install-dismissed.v1";
  let deferredPrompt = null, installed = false, banner = null, dialog = null;

  function isInstalled(win = window, nav = navigator) {
    return Boolean(nav.standalone === true || win.matchMedia?.("(display-mode: standalone)").matches);
  }
  function detectPlatform(nav = navigator) {
    const ua = nav.userAgent || "";
    const platform = nav.userAgentData?.platform || nav.platform || "";
    const safari = /Safari/i.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox|DuckDuckGo)/i.test(ua);
    if (safari && (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && nav.maxTouchPoints > 1))) return "ios-safari";
    if (safari && /Mac/i.test(platform || ua)) return "mac-safari";
    return "other";
  }
  function getGuidance(platform) {
    if (platform === "ios-safari") return {
      title: "Add RSS Reader to your Home Screen",
      body: "In Safari, tap the Share button, scroll the share sheet if needed, then choose Add to Home Screen. Confirm by tapping Add."
    };
    if (platform === "mac-safari") return {
      title: "Add RSS Reader to your Dock",
      body: "In Safari on macOS Sonoma or later, choose File → Add to Dock. RSS Reader will then open in its own app window."
    };
    return {
      title: "Install RSS Reader",
      body: "Your browser does not currently offer an install prompt. Check the browser menu for an Install app, Install RSS Reader, or Add to Home Screen option. Availability depends on the browser and its installation requirements."
    };
  }
  function isDismissed(storage = localStorage) {
    try { return storage.getItem(DISMISSAL_KEY) === "true"; } catch { return false; }
  }
  function saveDismissal(storage = localStorage) {
    try { storage.setItem(DISMISSAL_KEY, "true"); return true; } catch { return false; }
  }
  async function requestInstall(event) {
    if (!event || typeof event.prompt !== "function") return { outcome: "unavailable" };
    await event.prompt();
    const choice = await event.userChoice;
    return { outcome: choice?.outcome || "unknown" };
  }

  window.RSSReaderPWA = { isInstalled, detectPlatform, getGuidance, isDismissed, saveDismissal, requestInstall };
  if (typeof document === "undefined") return;

  const platform = detectPlatform();
  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  installed = isInstalled();

  function $(selector) { return document.querySelector(selector); }
  function createInterface() {
    const style = document.createElement("style");
    style.textContent = [
      ".pwa-install-banner{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:9px 14px;background:var(--panel2);border-bottom:1px solid var(--line);color:var(--text);font-size:13px}",
      ".pwa-install-banner[hidden]{display:none}.pwa-install-banner p{margin:0;flex:1;min-width:180px;text-align:center}",
      ".pwa-install-banner button,.pwa-install-dialog button{font:inherit}",
      ".pwa-install-banner .pwa-install-action,.pwa-install-dialog .pwa-install-action{padding:7px 12px;border:1px solid var(--accent);border-radius:5px;background:var(--accent);color:var(--on-accent);font-weight:650}",
      ".pwa-install-banner .pwa-install-dismiss{padding:6px 9px;border:0;background:transparent;color:var(--muted)}",
      ".pwa-install-dialog{width:min(440px,calc(100vw - 32px));max-height:min(80vh,620px);padding:24px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--text);box-shadow:0 18px 60px #0008}",
      ".pwa-install-dialog::backdrop{background:#0009}.pwa-install-dialog h2{margin:0 32px 12px 0;font:700 23px/1.2 var(--serif)}",
      ".pwa-install-dialog p{line-height:1.6;color:var(--muted)}.pwa-install-dialog .pwa-install-status{min-height:1.5em;margin:10px 0 0;font-size:12px}",
      ".pwa-install-dialog .pwa-install-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}",
      ".pwa-install-dialog .pwa-install-close{padding:7px 12px;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--text)}",
      ".pwa-install-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:4px 0 14px;padding:10px 0;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left;cursor:pointer}",
      ".pwa-install-setting span{color:var(--accent);font-weight:600}.pwa-install-setting[hidden]{display:none}@media(max-width:480px){.pwa-install-banner{gap:8px}.pwa-install-banner p{flex-basis:100%}}"
    ].join("");
    document.head.append(style);

    banner = document.createElement("section");
    banner.className = "pwa-install-banner";
    banner.id = "pwaInstallBanner";
    banner.setAttribute("aria-label", "Install RSS Reader");
    banner.hidden = true;
    banner.innerHTML = '<p id="pwaInstallBannerText">Install RSS Reader for a dedicated app window.</p><button type="button" class="pwa-install-action" id="pwaInstallBannerAction">Install</button><button type="button" class="pwa-install-dismiss" id="pwaInstallDismiss">Dismiss</button>';
    document.body.insertBefore(banner, document.body.firstChild);

    dialog = document.createElement("dialog");
    dialog.className = "pwa-install-dialog";
    dialog.setAttribute("aria-labelledby", "pwaInstallTitle");
    dialog.innerHTML = '<h2 id="pwaInstallTitle">Install RSS Reader</h2><p id="pwaInstallInstructions"></p><p class="pwa-install-status" id="pwaInstallStatus" role="status" aria-live="polite"></p><div class="pwa-install-actions"><button type="button" class="pwa-install-close" id="pwaInstallClose">Close</button><button type="button" class="pwa-install-action" id="pwaInstallDialogAction" hidden>Install</button></div>';
    document.body.append(dialog);

    const applicationSection = $("#settingsDialog .settings-section[data-settings-section='application']");
    const applicationHeading = applicationSection?.querySelector(".settings-group");
    if (applicationHeading) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pwa-install-setting";
      button.id = "installAppSetting";
      button.innerHTML = "<strong>Install App</strong><span>View options →</span>";
      applicationHeading.after(button);
      button.addEventListener("click", openGuidance);
    }

    $("#pwaInstallBannerAction")?.addEventListener("click", handleInstallAction);
    $("#pwaInstallDismiss")?.addEventListener("click", () => { saveDismissal(); banner.hidden = true; });
    $("#pwaInstallClose")?.addEventListener("click", () => dialog.close());
    $("#pwaInstallDialogAction")?.addEventListener("click", handleInstallAction);
    document.querySelectorAll("#settings, #railSettings").forEach(button => {
      button.addEventListener("click", () => window.setTimeout(updateSettingsAvailability, 0));
    });
  }

  function updateSettingsAvailability() {
    const setting = $("#installAppSetting");
    if (setting) setting.hidden = installed;
  }
  function updateDialog() {
    if (!dialog) return;
    const guidance = getGuidance(platform);
    $("#pwaInstallTitle").textContent = deferredPrompt ? "Install RSS Reader" : guidance.title;
    $("#pwaInstallInstructions").textContent = deferredPrompt
      ? "Install RSS Reader to open it in its own app window and keep it available from your device."
      : guidance.body;
    $("#pwaInstallDialogAction").hidden = !deferredPrompt;
    $("#pwaInstallStatus").textContent = "";
  }
  function openGuidance() {
    if (installed) return;
    updateDialog();
    if (!dialog.open) dialog.showModal();
  }
  async function handleInstallAction() {
    if (installed) return;
    if (!deferredPrompt) { openGuidance(); return; }
    const event = deferredPrompt;
    deferredPrompt = null;
    updateDialog();
    if (!dialog.open) dialog.showModal();
    $("#pwaInstallDialogAction").disabled = true;
    $("#pwaInstallBannerAction").disabled = true;
    $("#pwaInstallStatus").textContent = "Waiting for your choice…";
    try {
      const result = await requestInstall(event);
      $("#pwaInstallStatus").textContent = result.outcome === "accepted"
        ? "Installation started. The app will update when installation completes."
        : "Installation was dismissed. You can check your browser menu or return to Settings for guidance.";
    } catch {
      $("#pwaInstallStatus").textContent = "The browser could not start installation. Check its menu for installation options.";
    } finally {
      $("#pwaInstallDialogAction").hidden = true;
      $("#pwaInstallDialogAction").disabled = false;
      $("#pwaInstallBannerAction").disabled = false;
      // The deferred event can only be used once. Update the banner so its
      // action accurately changes from native installation to guidance.
      showBanner();
    }
  }
  function showBanner() {
    if (installed || isDismissed()) { banner.hidden = true; return; }
    const safariInstall = platform === "ios-safari" || platform === "mac-safari";
    if (!deferredPrompt && !safariInstall) { banner.hidden = true; return; }
    $("#pwaInstallBannerText").textContent = deferredPrompt
      ? "Install RSS Reader for a dedicated app window."
      : platform === "ios-safari"
        ? "Add RSS Reader to your Home Screen for quick access."
        : "Add RSS Reader to your Dock for a dedicated app window.";
    $("#pwaInstallBannerAction").textContent = deferredPrompt ? "Install" : "How to install";
    banner.hidden = false;
  }
  function markInstalled() {
    installed = true;
    deferredPrompt = null;
    banner.hidden = true;
    const setting = $("#installAppSetting");
    if (setting) setting.hidden = true;
    if (dialog?.open) dialog.close();
  }

  createInterface();
  updateSettingsAvailability();
  showBanner();

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed) return;
    deferredPrompt = event;
    showBanner();
    updateDialog();
  });
  window.addEventListener("appinstalled", markInstalled);
  displayMode?.addEventListener?.("change", event => {
    if (event.matches) markInstalled();
    else { installed = isInstalled(); updateSettingsAvailability(); showBanner(); }
  });
})();