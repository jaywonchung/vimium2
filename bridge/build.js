import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function bridgeFingerprint() {
  const manifest = JSON5.parse(await Deno.readTextFile(path.join(root, "manifest.json")));
  const files = [
    "bridge/build.js",
    "bridge/remote_backend.js",
    "background_scripts/all_commands.js",
    "background_scripts/bridge.js",
    "background_scripts/commands.js",
    "background_scripts/main.js",
    "background_scripts/marks.js",
    "background_scripts/tab_operations.js",
    "pages/ui_component_messenger.js",
    "pages/hud_page.js",
    "pages/vomnibar_page.js",
    "pages/help_dialog_page.js",
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css,
  ];
  const contents = await Promise.all(files.map((file) => Deno.readTextFile(path.join(root, file))));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(contents)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Optional provider source must define createPageUrlProvider(), returning a page URL getter.
// It runs in the target extension and may initialize asynchronously.
export async function buildBridge({ pageUrlProvider } = {}) {
  const manifest = JSON5.parse(
    await Deno.readTextFile(path.join(root, "manifest.json")),
  );
  const scripts = manifest.content_scripts[0].js.filter((file) =>
    !["core/backend.js", "local_backend.js"].includes(file)
  );
  const core = await Promise.all(
    scripts.map((file) => Deno.readTextFile(path.join(root, file))),
  );
  const backend = await Deno.readTextFile(path.join(root, "core/backend.js"));
  const remote = await Deno.readTextFile(
    path.join(root, "bridge/remote_backend.js"),
  );
  const css = await Deno.readTextFile(
    path.join(root, manifest.content_scripts[0].css[0]),
  );
  const bridgeCss =
    ":root > div.vimium-reset:not(#vimium-hint-marker-container) { position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; } body.vimium-find-mode ::selection { background: #ff9632 !important; color: #000 !important; }";
  return `// Vimium2 bridge. See the accompanying MIT-LICENSE.txt.\n(function () {
  "use strict";
  if (globalThis.__vimium2) throw new Error("Vimium2 is already initialized.");
  const state = globalThis.__vimium2 = { state: "connecting", protocol: 1 };
  const config = {
    fingerprint: ${JSON.stringify(await bridgeFingerprint())},
    vimiumId: document.currentScript.dataset.vimiumId,
    scrollContainer: document.currentScript.dataset.vimiumScrollContainer,
    navigateInTab: document.currentScript.dataset.vimiumNavigateInTab === "true",
    onConnected() {
      state.state = "ready";
      delete state.error;
      document.getElementById("vimium2-error")?.remove();
    },
    onError(error) {
      state.state = "error";
      state.error = error.message;
      console.error("[Vimium2]", error);
      let notice = document.getElementById("vimium2-error");
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "vimium2-error";
        notice.setAttribute("role", "alert");
        notice.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:2147483647;background:#fff;color:#900;padding:12px;max-width:min(440px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;overflow-wrap:anywhere;user-select:text;font:14px/1.5 sans-serif;border:1px solid #900";
        document.documentElement.appendChild(notice);
      }
      notice.textContent = "Vimium2: " + error.message;
      if (error.code === "CORE_MISMATCH") {
        const link = document.createElement("a");
        link.href = "https://github.com/jaywonchung/vimium2#updating-a-patched-reader";
        link.textContent = "Update instructions";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.style.cssText = "color:#0645ad;text-decoration:underline";
        notice.append(" ", link, ".");
      }
    },
  };
${backend}
${remote}
${pageUrlProvider ?? ""}
  async function start() {
${
    pageUrlProvider === undefined ? "" : `
    config.getPageUrl = await createPageUrlProvider();
    if (typeof config.getPageUrl !== "function") {
      throw new Error("Page URL provider must return a function.");
    }
`
  }
    const remote = initRemoteBackend(config);
    await remote.attach();
    remote.configureBackend();
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css + "\n" + bridgeCss)};
    document.head.appendChild(style);
${core.join("\n")}
    await Settings.onLoaded();
    const userStyle = document.createElement("style");
    document.head.appendChild(userStyle);
    const updateStyle = () => {
      userStyle.textContent = Settings.get("userDefinedLinkHintCss");
    };
    updateStyle();
    Settings.addEventListener("change", updateStyle);
    if (config.scrollContainer) Scroller.setScrollContainerSelector(config.scrollContainer);
    remote.coreLoaded();
    state.state = "ready";
  }
  const run = () => start().catch(config.onError);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();\n`;
}
