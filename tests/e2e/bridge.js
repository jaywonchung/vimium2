import assert from "node:assert/strict";
import * as path from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer";
import { bridgeFingerprint } from "../../bridge/build.js";
import { patchExtension } from "../../patcher/patch.js";
import { resumeWorkerDebugger, stopWorker } from "./worker.js";

const { values } = parseArgs({
  args: Deno.args,
  options: { chrome: { type: "string" } },
});
const root = new URL("../../", import.meta.url);
const temp = await Deno.makeTempDir({ prefix: "vimium2-bridge-e2e-" });
const errors = [];
const monitors = [];
const checks = [];
let browser;
let lifecycle;
let server;
function pass(name) {
  checks.push(name);
  console.log(`PASS: ${name}`);
}

async function focus(page) {
  await page.bringToFront();
  await page.evaluate(() => globalThis.focus());
  await page.waitForFunction(() => document.hasFocus());
}

async function vomnibar(page, keys) {
  await page.keyboard.type(keys);
  const frame = await page.waitForFrame((frame) =>
    frame.url().endsWith("/pages/vomnibar_page.html")
  );
  await frame.waitForFunction(() => document.activeElement === document.querySelector("input"));
  return frame;
}

try {
  server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () =>
    new Response(
      `<!doctype html><title>Native fixture</title><h1>Native fixture</h1>
      <p style="white-space:pre;line-height:24px">${"Text before match\n".repeat(100)}Needle alpha
      ${"Text between matches\n".repeat(100)}Needle beta
      ${"Text after match\n".repeat(40)}</p>`,
      { headers: { "Content-Type": "text/html" } },
    ));
  const origin = `http://127.0.0.1:${server.addr.port}`;
  browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: true,
    executablePath: values.chrome,
    userDataDir: path.join(temp, "browser-profile"),
  });
  browser.on("targetcreated", (target) => {
    if (target.type() !== "service_worker") return;
    monitors.push(
      (async () => {
        const worker = await target.worker();
        const session = worker.client;
        if (!session) throw new Error("Worker error monitoring is unavailable.");
        session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
          errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
        });
      })().catch((error) => errors.push(error.message)),
    );
  });
  const vimiumId = await browser.installExtension(new URL("dist/vimium2", root).pathname);
  const source = path.join(temp, "source");
  const extension = path.join(temp, "extension");
  await Deno.mkdir(path.join(source, "nested"), { recursive: true });
  await Deno.writeTextFile(
    path.join(source, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Bridge test fixture",
      version: "1.0",
      permissions: ["storage"],
      web_accessible_resources: [{
        resources: ["nested/page.html"],
        matches: ["http://127.0.0.1/*"],
      }],
    }),
  );
  const html = `<!doctype html><html><head><title>Extension fixture</title>
    <script src="/fixture.js" defer></script>
    <style>body { margin: 24px; } #second { margin-top: 1800px; } #tail { height: 3000px; }</style>
    </head><body>
    <h1>Extension fixture</h1><a id="link" href="${origin}/link">A link</a>
    <button id="action">Action</button><input id="editor" aria-label="Editor">
    <a id="handled" href="${origin}/handled">Handled link</a>
    <p>Needle alpha</p><p id="second">Needle beta</p><div id="tail"></div></body></html>`;
  await Deno.writeTextFile(path.join(source, "page.html"), html);
  await Deno.writeTextFile(path.join(source, "nested/page.html"), html);
  await Deno.writeTextFile(
    path.join(source, "fixture.js"),
    `document.querySelector("#action").addEventListener("click", () => document.body.dataset.clicked = "yes");
    document.querySelector("#handled").addEventListener("click", (event) => {
      event.preventDefault();
      document.body.dataset.handled = "yes";
    });`,
  );
  await Deno.writeTextFile(
    path.join(source, "probe.html"),
    "<!doctype html><title>Probe</title>",
  );
  await patchExtension({
    profile: { pages: [{ html: "page.html" }, { html: "nested/page.html" }] },
    source,
    output: extension,
    vimiumId,
  });
  const bundle = await Deno.readTextFile(path.join(extension, "vimium2/bridge-0.js"));
  const patchedHtml = await Deno.readTextFile(path.join(extension, "page.html"));
  const extensionId = await browser.installExtension(extension);
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/probe.html`);
  const rejected = await page.evaluate((id) =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connect(id, { name: "vimium2-bridge" });
      port.onMessage.addListener((message) => {
        if (message.type === "error") resolve(message.error);
      });
      port.onDisconnect.addListener(() =>
        reject(new Error(chrome.runtime.lastError?.message ?? "Disconnected without rejection"))
      );
    }), vimiumId);
  assert.match(rejected, /Allowed bridge extensions/);
  pass("unlisted extensions cannot attach");
  await page.evaluate(() => chrome.storage.sync.set({ keyMappings: "unmapAll" }));
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${vimiumId}/pages/options.html`);
  options.on("pageerror", (error) => errors.push(error.message));
  await options.evaluate(async ({ extensionId, origin }) => {
    await Settings.onLoaded();
    await Settings.setSettings({
      ...Settings.getSettings(),
      allowedBridgeExtensions: [extensionId],
      smoothScroll: false,
      keyMappings: "map q scrollDown",
      newTabDestination: "customUrl",
      newTabCustomUrl: `${origin}/created`,
    });
  }, { extensionId, origin });
  await page.goto(`chrome-extension://${extensionId}/page.html`);
  await page.waitForFunction(() => globalThis.__vimium2?.state === "ready");
  await focus(page);
  const providers = await page.evaluate(async () => ({
    own: (await chrome.storage.sync.get("keyMappings")).keyMappings,
    shared: Settings.get("keyMappings"),
    sharedUrl: Backend.runtime.getURL("pages/options.html"),
    pageUrl: await Backend.runtime.sendMessage({ handler: "getCurrentTabUrl" }),
    privateKeys: Object.keys(await Backend.storage.session.get(null)).filter((key) =>
      ["vimiumSecret", "findModeRawQueryListIncognito"].includes(key)
    ),
  }));
  assert.deepEqual(providers, {
    own: "unmapAll",
    shared: "map q scrollDown",
    sharedUrl: `chrome-extension://${vimiumId}/pages/options.html`,
    pageUrl: `chrome-extension://${extensionId}/page.html`,
    privateKeys: [],
  });
  pass("runtime and storage use Vimium services while preserving the host's own storage");

  const secondPage = await browser.newPage();
  await secondPage.goto(`chrome-extension://${extensionId}/nested/page.html?view=tasks#today`);
  await secondPage.waitForFunction(() => globalThis.__vimium2?.state === "ready");
  await focus(secondPage);
  for (const route of ["today", "tomorrow"]) {
    await secondPage.evaluate(
      (route) => history.replaceState(null, "", `?view=tasks#${route}`),
      route,
    );
    const editor = await vomnibar(secondPage, "ge");
    assert.equal(await editor.$eval("input", (input) => input.value), secondPage.url());
    await secondPage.keyboard.press("Escape");
    const iframe = await editor.frameElement();
    await secondPage.waitForFunction(
      (iframe) =>
        getComputedStyle(iframe).display === "none" &&
        document.activeElement === document.body,
      {},
      iframe,
    );
    await iframe.dispose();
  }
  await secondPage.close();
  await focus(page);
  pass("a patched extension needs no worker or URL adapter and ge follows each page's current URL");

  const permissionState = () =>
    options.evaluate(async () => ({
      tabs: (await chrome.tabs.query({})).map(({ id, url }) => ({ id, url })),
      history: await chrome.storage.session.get("findModeRawQueryListIncognito"),
    }));
  const beforePermissions = await permissionState();
  const responses = await page.evaluate((id) =>
    Promise.all([
      { handler: "filterCompletions", completerName: "omni", query: "" },
      { handler: "openUrlInCurrentTab", url: "javascript:document.title='unexpected'" },
      {
        handler: "openUrlInCurrentTab",
        url: "\u00a0javascript:document.title='unexpected'",
        allowJavascript: true,
      },
      { handler: "openUrlInCurrentTab", url: "\ufeffjavascript:document.title='unexpected'" },
      { handler: "openUrlInCurrentTab", url: 42 },
      { handler: "storage", area: "session", operation: "set", value: { vimiumSecret: "fake" } },
      {
        handler: "storage",
        area: "session",
        operation: "set",
        value: { findModeRawQueryListIncognito: ["private"] },
      },
      { handler: "runBackgroundCommand", registryEntry: { command: "createTab" }, count: 101 },
      {
        handler: "runBackgroundCommand",
        registryEntry: { command: "createTab", options: {} },
        urls: ["https://example.com/one", "https://example.com/two"],
        count: 60,
      },
    ].map((request) => chrome.runtime.sendMessage(id, request))), vimiumId);
  assert.deepEqual(responses.map((response) => response.error), [
    "Unsupported bridge message.",
    ...Array(3).fill("Bridged extensions cannot execute javascript URLs."),
    "URLs must be strings.",
    "Unsupported bridge storage write.",
    "Unsupported bridge storage write.",
    "Bridge command count must be between 1 and 100.",
    "Extension requests can create at most 100 tabs.",
  ]);
  assert.deepEqual(await permissionState(), beforePermissions);
  assert.equal(await page.title(), "Extension fixture");
  pass(
    "privileged handlers, script URLs, private writes, and excessive command counts are rejected",
  );

  await page.keyboard.press("f");
  await page.waitForSelector(".vimiumHintMarker", { visible: true });
  const hints = await page.evaluate(() =>
    HintCoordinator.linkHintsMode.hintMarkers.map((marker) => {
      const rect = marker.element.getBoundingClientRect();
      return {
        id: marker.localHint.element.id,
        label: marker.hintString,
        drawn: marker.element.isConnected &&
          getComputedStyle(marker.element).visibility === "visible" &&
          rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0,
      };
    })
  );
  assert.deepEqual(hints.map(({ id }) => id).sort(), ["action", "editor", "handled", "link"]);
  assert(hints.every(({ drawn }) => drawn));
  await page.keyboard.type(hints.find(({ id }) => id === "action").label);
  await page.waitForFunction(() => document.body.dataset.clicked === "yes");
  pass("hints match the fixture's exact controls and activate the selected button");
  const tabsBeforeClick = (await browser.pages()).length;
  await page.keyboard.press("F");
  await page.waitForSelector(".vimiumHintMarker", { visible: true });
  const handledHint = await page.evaluate(() =>
    HintCoordinator.linkHintsMode.hintMarkers.find((marker) =>
      marker.localHint.element.id === "handled"
    ).hintString
  );
  await page.keyboard.type(handledHint);
  await page.waitForFunction(() => document.body.dataset.handled === "yes");
  assert.equal((await browser.pages()).length, tabsBeforeClick);
  pass("modified link activation preserves the extension's click handler and cancellation");
  await page.click("#editor");
  await page.keyboard.type("jq");
  assert.equal(await page.$eval("#editor", (input) => input.value), "jq");
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("q");
  await page.waitForFunction(() => scrollY === Settings.get("scrollStepSize"));
  pass("editable controls receive text and shared key mappings scroll the host page");

  await page.keyboard.type("gg");
  const commands = await vomnibar(page, "2:");
  await page.keyboard.type("Scroll down");
  await commands.waitForFunction(() =>
    document.querySelector("li.selected .title")?.textContent.trim() === "Scroll down"
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    scrollY === 2 * Settings.get("scrollStepSize") && !Vomnibar.vomnibarUI.showing &&
    document.hasFocus()
  );
  pass("the command picker returns its command and count to the originating extension frame");

  await page.keyboard.type("gg/");
  const hud = await page.waitForFrame((frame) => frame.url().endsWith("/pages/hud_page.html"));
  await hud.waitForFunction(() => document.activeElement?.isContentEditable);
  await page.keyboard.type("Needle");
  await hud.waitForFunction(() => document.body.textContent.includes("2 Matches"));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => getSelection().toString() === "Needle" && document.hasFocus());
  await page.keyboard.press("n");
  await page.waitForFunction(() => getSelection().anchorNode.parentElement.id === "second");
  assert(
    await page.evaluate(() => {
      const rect = getSelection().getRangeAt(0).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  );
  await page.keyboard.press("N");
  await page.waitForFunction(() => getSelection().anchorNode.textContent.includes("Needle alpha"));
  const history = await options.evaluate(() => chrome.storage.session.get("findModeRawQueryList"));
  assert.equal(history.findModeRawQueryList[0], "Needle");
  pass("find, Enter, n, and N select visible matches and save history in Vimium");
  await page.keyboard.press("Escape");

  let native = await browser.newPage();
  await native.goto(`${origin}/native`);
  await focus(native);
  await native.keyboard.press("j");
  await native.waitForFunction(() => scrollY > 0);
  const nativeCreated = browser.waitForTarget((target) => target.url() === `${origin}/created`);
  await native.keyboard.press("t");
  const nativeNewTab = await (await nativeCreated).page();
  assert(nativeNewTab);
  await nativeNewTab.close();
  pass("ordinary webpages can scroll and create tabs through the shared dispatcher");
  await browser.defaultBrowserContext().overridePermissions(origin, [
    "clipboard-read",
    "clipboard-write",
  ]);
  await focus(native);
  await native.keyboard.type("yy");
  await native.waitForFunction(async () => await navigator.clipboard.readText() === location.href);
  pass("yy on ordinary webpages writes their URL to the clipboard");
  for (
    const [key, expected] of [["n", "Needle alpha"], ["n", "Needle beta"], ["N", "Needle alpha"]]
  ) {
    await native.keyboard.press(key);
    await native.waitForFunction(
      (expected) => {
        const selection = getSelection();
        if (selection.toString() !== "Needle") return false;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        return range.startContainer.textContent.slice(range.startOffset).startsWith(expected) &&
          rect.top >= 0 && rect.bottom <= innerHeight;
      },
      {},
      expected,
    );
  }
  await native.keyboard.press("Escape");
  pass(
    "native n/N reuse another frame's query and reveal the expected match inside a long paragraph",
  );
  const nativeMarkPosition = await native.evaluate(() => scrollY);
  await native.keyboard.press("m");
  await native.keyboard.down("Shift");
  await native.keyboard.press("A");
  await native.keyboard.up("Shift");
  const nativeHud = await native.waitForFrame((frame) =>
    frame.url().endsWith("/pages/hud_page.html")
  );
  await nativeHud.waitForFunction(() =>
    document.getElementById("hud").textContent === 'Created global mark "A".'
  );
  await native.close();
  await focus(page);
  const restoredNative = browser.waitForTarget((target) => target.url() === `${origin}/native`);
  await page.keyboard.press("Backquote");
  await page.keyboard.down("Shift");
  await page.keyboard.press("A");
  await page.keyboard.up("Shift");
  native = await (await restoredNative).page();
  await native.waitForFunction((position) => scrollY === position, {}, nativeMarkPosition);
  pass("a global mark reopens a closed website tab and restores its saved position");
  const localError = await options.evaluate(async () => {
    try {
      await Backend.runtime.sendMessage({ handler: "filterCompletions", completerName: "missing" });
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert.equal(typeof localError, "string");
  pass("native message failures reject the caller's request");
  await focus(page);
  const tabs = await vomnibar(page, "T");
  await page.keyboard.type("Native fixture");
  await tabs.waitForFunction(() => document.querySelectorAll("li").length === 1);
  await page.keyboard.press("Enter");
  await native.waitForFunction(() => document.hasFocus());
  pass("the tab picker selects a browser tab through Vimium's UI");

  const hostPosition = await native.evaluate(() => scrollY);
  await native.evaluate((extensionId) => {
    const frame = document.createElement("iframe");
    frame.id = "extension-page";
    frame.src = `chrome-extension://${extensionId}/nested/page.html`;
    frame.style.cssText = "position:fixed;top:0;left:0;width:900px;height:650px;z-index:9999";
    document.body.appendChild(frame);
  }, extensionId);
  const embedded = await native.waitForFrame((frame) =>
    frame.url() === `chrome-extension://${extensionId}/nested/page.html`
  );
  await embedded.waitForFunction(() => globalThis.__vimium2?.state === "ready");
  await embedded.evaluate(() => globalThis.focus());
  await embedded.waitForFunction(() => document.hasFocus());
  await native.keyboard.type("3j");
  await embedded.waitForFunction(() => scrollY > 0);
  const embeddedPosition = await embedded.evaluate(() => scrollY);
  await native.keyboard.press("m");
  const embeddedHud = await native.waitForFrame((frame) =>
    frame.parentFrame() === embedded && frame.url().endsWith("/pages/hud_page.html")
  );
  const saved = embeddedHud.waitForFunction(
    () => document.getElementById("hud").textContent === 'Created global mark "B".',
    { polling: "mutation" },
  );
  await native.keyboard.down("Shift");
  await native.keyboard.press("B");
  await native.keyboard.up("Shift");
  await saved;
  await native.keyboard.type("3j");
  await embedded.waitForFunction((position) => scrollY > position, {}, embeddedPosition);
  await focus(page);
  await page.keyboard.press("Backquote");
  await page.keyboard.down("Shift");
  await page.keyboard.press("B");
  await page.keyboard.up("Shift");
  await embedded.waitForFunction((position) => scrollY === position, {}, embeddedPosition);
  assert.equal(await native.evaluate(() => scrollY), hostPosition);
  await native.evaluate(() => document.getElementById("extension-page").remove());
  pass("an embedded extension page without a scroll override restores its own global mark");

  await options.evaluate(() => Settings.set("keyMappings", "unmap j\nmap z scrollDown"));
  await focus(page);
  await page.waitForFunction(() => Settings.get("keyMappings").includes("map z scrollDown"));
  await page.keyboard.type("ggz");
  await page.waitForFunction(() => scrollY === Settings.get("scrollStepSize"));
  pass("settings changes reach connected extensions without a reload");
  await page.keyboard.type("gg");
  const pendingCommand = await vomnibar(page, ":");
  await page.keyboard.type("Scroll down");
  await pendingCommand.waitForFunction(() =>
    document.querySelector("li.selected .title")?.textContent.trim() === "Scroll down"
  );
  lifecycle = await stopWorker(page, vimiumId, errors);
  await resumeWorkerDebugger(browser, vimiumId);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    scrollY === Settings.get("scrollStepSize") && document.hasFocus()
  );
  const created = browser.waitForTarget((target) => target.url() === `${origin}/created`);
  await page.keyboard.press("t");
  const newTab = await (await created).page();
  assert(newTab);
  await newTab.close();
  await focus(page);
  pass("an open command picker and browser commands work after the service worker stops");

  const fingerprint = JSON.stringify(await bridgeFingerprint());
  const stale = bundle.replace(`fingerprint: ${fingerprint}`, 'fingerprint: "outdated"');
  assert.notEqual(stale, bundle);
  await Deno.writeTextFile(path.join(extension, "stale.js"), stale);
  await Deno.writeTextFile(
    path.join(extension, "stale.html"),
    patchedHtml.replace('src="/vimium2/bridge-0.js"', 'src="/stale.js"'),
  );
  const stalePage = await browser.newPage();
  await stalePage.goto(`chrome-extension://${extensionId}/stale.html`);
  await stalePage.waitForSelector("#vimium2-error a");
  assert.equal(
    await stalePage.$eval("#vimium2-error a", (a) => a.href),
    "https://github.com/jaywonchung/vimium2#updating-a-patched-reader",
  );
  assert.equal(await stalePage.evaluate(() => typeof NormalMode), "undefined");
  await stalePage.close();
  pass("stale bridge code is rejected before starting the core and links to recovery instructions");

  await focus(page);
  await vomnibar(page, "o");
  const frames = page.frames().filter((frame) =>
    frame.url().startsWith(`chrome-extension://${vimiumId}/pages/`)
  );
  assert(frames.length > 0);
  await Promise.all(monitors);
  assert.deepEqual(errors, []);
  const blank = frames.map((frame) => frame.waitForFunction(() => location.href === "about:blank"));
  await options.evaluate(() => Settings.set("allowedBridgeExtensions", []));
  await page.waitForFunction(() => globalThis.__vimium2.state === "error");
  await Promise.all(blank);
  assert.equal(await page.evaluate(() => Backend.isAlive()), false);
  const revoked = await page.evaluate(
    (id) => chrome.runtime.sendMessage(id, { handler: "getCurrentTabUrl" }),
    vimiumId,
  );
  assert.match(revoked.error, /Allowed bridge extensions/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no longer allowed/);
  pass("revoking access disconnects the bridge and closes existing UI frames");
  console.log(`Passed ${checks.length} browser checks.`);
} finally {
  await lifecycle?.detach();
  await browser?.close();
  await server?.shutdown();
  await Deno.remove(temp, { recursive: true });
}
