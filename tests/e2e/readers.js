import { parseArgs } from "node:util";
import * as path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { prepareSource } from "../../integrations/source.js";
import { loadIntegration, patchExtension, projectRoot } from "../../patcher/patch.js";
import { samplePdf } from "./sample_pdf.js";
import { assertHints } from "./hints.js";
import { testFind } from "./search.js";
import { testMarks } from "./marks.js";
import { testBrowserCommands } from "./browser_commands.js";
import { testEmbeddedReader } from "./embedded.js";
import { testDocumentUrls } from "./urls.js";
import { testRecoveryNotice } from "./recovery.js";
import { resumeWorkerDebugger, stopWorker } from "./worker.js";

const { values } = parseArgs({
  args: Deno.args,
  options: {
    target: { type: "string" },
    source: { type: "string" },
    crx: { type: "string" },
    "chrome-version": { type: "string" },
    chrome: { type: "string" },
    artifacts: { type: "string" },
  },
});
const targets = ["google-scholar-pdf-reader", "pdfjs-pdf-viewer"];
if (!targets.includes(values.target)) {
  throw new Error(`--target must be one of: ${targets.join(", ")}.`);
}
const integration = await loadIntegration(path.join(projectRoot, "integrations", values.target));
const profile = integration.pages[0];
const temp = await Deno.makeTempDir({ prefix: "vimium2-e2e-" });
const artifacts = path.resolve(
  values.artifacts ?? path.join(projectRoot, "dist", "e2e", values.target),
);
await Deno.mkdir(artifacts, { recursive: true });
for await (const entry of Deno.readDir(artifacts)) {
  if (
    entry.isFile &&
    /^(result\.json|failure\.png|help\.png|hints(?:-.*)?\.(?:png|json)|find(?:-\d+)?\.(?:png|json))$/
      .test(entry.name)
  ) {
    await Deno.remove(path.join(artifacts, entry.name));
  }
}
const resultPath = path.join(artifacts, "result.json");
await Deno.writeTextFile(
  resultPath,
  JSON.stringify({ target: values.target, status: "running" }) + "\n",
);
let browser;
let server;
let page;
const errors = [];
const workerMonitors = [];
const checks = [];
const limitations = values.target === "google-scholar-pdf-reader"
  ? [
    "History navigation checks the PDF URL only. Scholar's native PDF embed can disappear after Back in headless Chrome; the reload test starts a new document.",
  ]
  : [];
function pass(name) {
  checks.push(name);
  console.log(`PASS ${values.target}: ${name}`);
}

try {
  const source = await prepareSource({
    ...values,
    chromeVersion: values["chrome-version"],
    profile: integration,
    directory: path.join(temp, "source"),
  });
  server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      if (new URL(req.url).pathname.endsWith(".pdf")) {
        const pdf = samplePdf(new URL(req.url).origin);
        return new Response(pdf, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(pdf.length),
          },
        });
      }
      const label = new URL(req.url).pathname.slice(1) || "test";
      return new Response(
        label === "embedded"
          ? '<!doctype html><title>Vimium2 embedded</title><a id="outside" href="/linked?outside">Outside link</a><iframe src="/sample.pdf" style="display:block;width:1000px;height:650px"></iframe><div style="height:4000px">Outside reader</div>'
          : `<!doctype html><title>Vimium2 ${label}</title><h1>Vimium2 ${label}</h1><a href="/sample.pdf">PDF</a><div style="height:4000px">Test page</div>`,
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    },
  );
  browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: true,
    // Allow headless rendering without display vsync.
    args: ["--disable-frame-rate-limit"],
    protocolTimeout: 30000,
    executablePath: values.chrome,
    userDataDir: path.join(temp, "browser-profile"),
  });
  browser.on("targetcreated", (target) => {
    if (target.type() !== "service_worker") return;
    workerMonitors.push(
      (async () => {
        const worker = await target.worker();
        const session = worker.client;
        if (!session) throw new Error("Puppeteer worker error monitoring is unavailable.");
        session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
          errors.push(
            `Worker ${target.url()}: ${
              exceptionDetails.exception?.description ?? exceptionDetails.text
            }`,
          );
        });
        session.on("Runtime.consoleAPICalled", (event) => {
          if (event.type === "error") {
            errors.push(
              `Worker ${target.url()}: ${
                event.args.map((arg) => arg.description ?? arg.value).join(" ")
              }`,
            );
          }
        });
      })().catch((error) => errors.push(`Worker monitor: ${error.message}`)),
    );
  });
  const vimiumId = await browser.installExtension(
    path.join(projectRoot, "dist", "vimium2"),
  );
  const patched = await patchExtension({
    profile: integration,
    source,
    output: path.join(temp, "patched"),
    vimiumId,
  });
  const readerId = await browser.installExtension(patched.output);
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${vimiumId}/pages/options.html`);
  await options.evaluate(async ({ id, origin }) => {
    await Settings.onLoaded();
    await Settings.setSettings({
      ...Settings.getSettings(),
      allowedBridgeExtensions: [id],
      smoothScroll: false,
      grabBackFocus: true,
      keyMappings: "mapkey q j\nmap gO Vomnibar.activateInNewTab keyword=w",
      newTabDestination: "customUrl",
      newTabCustomUrl: `${origin}/created`,
    });
  }, { id: readerId, origin: `http://127.0.0.1:${server.addr.port}` });
  await options.close();
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewport({ width: 1440, height: 900 });
  const url = `http://127.0.0.1:${server.addr.port}/sample.pdf`;
  await page.goto(url, { waitUntil: "load" });
  const getReader = async () => {
    const frame = await page.waitForFrame((frame) =>
      frame.url().startsWith(`chrome-extension://${readerId}/`)
    );
    await frame.waitForFunction(() =>
      globalThis.__vimium2?.state === "ready" && Number.isInteger(globalThis.frameId)
    );
    await frame.waitForFunction(() => document.body.textContent.includes("Needle alpha"));
    await frame.evaluate(() => globalThis.focus());
    return frame;
  };
  let reader = await getReader();
  const getWorker = async () =>
    await (await browser.waitForTarget((target) =>
      target.type() === "service_worker" &&
      target.url().startsWith(`chrome-extension://${vimiumId}/`)
    )).worker();
  await reader.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector);
      return el && el.scrollHeight > el.clientHeight && el.clientHeight > 0;
    },
    {},
    profile.scrollContainer,
  );
  pass(`bridge connected (${patched.version}, ${await browser.version()})`);
  await reader.evaluate(() => globalThis.focus());
  const scrollTop = () => reader.$eval(profile.scrollContainer, (el) => el.scrollTop);
  const before = await scrollTop();
  await page.keyboard.press("q");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop > top,
    {},
    profile.scrollContainer,
    before,
  );
  pass("saved mapkey mappings work on first load");
  const beforeJ = await scrollTop();
  await page.keyboard.press("j");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop > top,
    {},
    profile.scrollContainer,
    beforeJ,
  );
  const after = await scrollTop();
  await page.keyboard.press("k");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop < top,
    {},
    profile.scrollContainer,
    after,
  );
  pass("j/k scroll the reader");
  await testMarks({ page, reader, profile, pass });
  for (const key of ["d", "u"]) {
    const beforePage = await scrollTop();
    const distance = await reader.$eval(
      profile.scrollContainer,
      (el) => Math.round(el.clientHeight / 2),
    );
    await page.keyboard.press(key);
    await reader.waitForFunction(
      (selector, top, down) =>
        down
          ? document.querySelector(selector).scrollTop > top
          : document.querySelector(selector).scrollTop < top,
      {},
      profile.scrollContainer,
      beforePage,
      key === "d",
    );
    assert.equal(
      await scrollTop(),
      beforePage + (key === "d" ? distance : -distance),
      "Half-page commands use the reader viewport height",
    );
  }
  await page.keyboard.press("G");
  await reader.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector);
      return el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
    },
    {},
    profile.scrollContainer,
  );
  pass("d/u scroll by a page fraction; G reaches the document bottom");

  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
  await reader.waitForFunction(() => document.querySelectorAll('a[href*="/linked?"]').length >= 2);
  const hintContext = { page, reader, target: values.target, pageNumber: 1, artifacts };
  await assertHints(hintContext);
  await page.keyboard.press("Escape");
  await reader.waitForFunction(() => document.querySelectorAll(".vimiumHintMarker").length === 0);
  pass("f highlights exactly the expected links and controls");
  const newTabHints = await assertHints({ ...hintContext, mode: "F" });
  const hintWorker = await getWorker();
  const beforeHintTabs = await hintWorker.evaluate(() =>
    chrome.tabs.query({ currentWindow: true })
  );
  const linkedTarget = browser.waitForTarget((target) =>
    target.url() === new URL("/linked?one", url).href
  );
  await page.keyboard.type(newTabHints["External link one"]);
  const linkedPage = await (await linkedTarget).page();
  await linkedPage.waitForSelector("a");
  await reader.waitForFunction(() => !HintCoordinator.linkHintsMode);
  const afterHintTabs = await hintWorker.evaluate(() => chrome.tabs.query({ currentWindow: true }));
  const openedTabs = afterHintTabs.filter((tab) =>
    !beforeHintTabs.some((before) => before.id === tab.id)
  );
  assert.deepEqual(openedTabs.map((tab) => tab.url), [new URL("/linked?one", url).href]);
  assert.equal(openedTabs[0].active, false, "F must leave the selected link in a background tab");
  await linkedPage.close();
  pass("F opens exactly one background tab for the selected PDF link");
  const currentHints = await assertHints(hintContext);
  await page.keyboard.type(currentHints["Internal page 2 link"]);
  await reader.waitForFunction(
    (selector) => {
      const link = document.querySelector('a[href$="/linked?page2"]');
      if (!link) return false;
      const rect = link.getBoundingClientRect();
      const container = document.querySelector(selector).getBoundingClientRect();
      return rect.height > 0 && rect.top >= container.top && rect.bottom <= container.bottom;
    },
    {},
    profile.scrollContainer,
  );
  await assertHints({ ...hintContext, pageNumber: 2 });
  await page.keyboard.press("Escape");
  pass("internal PDF link jumps to page 2; scrolled hints match exactly");
  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
  await testFind({ page, reader, profile, artifacts, pass });
  await page.keyboard.press("?");
  const help = await page.waitForFrame((frame) =>
    frame.url().endsWith("/pages/help_dialog_page.html")
  );
  await help.waitForFunction(() =>
    document.querySelector("#commands-section")?.textContent.includes("Scroll")
  );
  await page.screenshot({ path: path.join(artifacts, "help.png") });
  pass("help iframe loads");
  await page.keyboard.press("Escape");
  await reader.waitForFunction(() =>
    !HelpDialog.isShowing() &&
    document.activeElement?.shadowRoot?.activeElement?.tagName !== "IFRAME"
  );
  await page.keyboard.type("gO");
  const vomnibar = await page.waitForFrame((frame) =>
    frame.url().endsWith("/pages/vomnibar_page.html")
  );
  await vomnibar.waitForSelector("input", { visible: true });
  await vomnibar.waitForFunction(() => document.activeElement === document.querySelector("input"));
  await page.keyboard.type("Vimium2 integration");
  const wikipediaTarget = browser.waitForTarget((target) => {
    try {
      const url = new URL(target.url());
      return url.hostname === "www.wikipedia.org" &&
        url.searchParams.get("search") === "Vimium2 integration";
    } catch {
      return false;
    }
  });
  await page.keyboard.press("Enter");
  await (await (await wikipediaTarget).page()).close();
  await reader.waitForFunction(() =>
    !Vomnibar.vomnibarUI.showing &&
    document.activeElement?.shadowRoot?.activeElement?.tagName !== "IFRAME"
  );
  const beforeFocus = await scrollTop();
  await page.keyboard.press("j");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop > top,
    {},
    profile.scrollContainer,
    beforeFocus,
  );
  pass("gO submits a Wikipedia query in a new tab and returns keyboard focus");
  reader = await testBrowserCommands({
    browser,
    page,
    reader,
    getReader,
    getWorker,
    origin: new URL(url).origin,
    pass,
  });
  reader = await testDocumentUrls({
    browser,
    page,
    reader,
    getReader,
    getWorker,
    origin: new URL(url).origin,
    pass,
  });

  await page.keyboard.press("n");
  await reader.waitForFunction(() => getSelection().toString() === "Needle");
  pass("find history survives reader reload");
  await page.keyboard.press("Escape");
  await testEmbeddedReader({
    browser,
    mainPage: page,
    readerId,
    vimiumId,
    origin: new URL(url).origin,
    getWorker,
    pass,
    errors,
  });
  await reader.evaluate(() => globalThis.focus());
  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
  await page.keyboard.type("3j");
  const markedPosition = await scrollTop();
  assert(markedPosition > 0);
  await page.keyboard.press("m");
  const markHud = await page.waitForFrame((frame) => frame.url().endsWith("/pages/hud_page.html"));
  const created = markHud.waitForFunction(
    () => document.getElementById("hud")?.textContent === 'Created global mark "C".',
    { polling: "mutation" },
  );
  await page.keyboard.down("Shift");
  await page.keyboard.press("C");
  await page.keyboard.up("Shift");
  await created;
  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
  const markOrigin = await browser.newPage();
  await markOrigin.goto(new URL("/mark-origin", url).href);
  await markOrigin.bringToFront();
  await markOrigin.evaluate(() => globalThis.focus());
  await markOrigin.waitForFunction(() => document.hasFocus());
  await markOrigin.keyboard.press("j");
  await markOrigin.waitForFunction(() => scrollY > 0);
  const lifecycleSession = await stopWorker(page, vimiumId, errors);
  await markOrigin.keyboard.press("Backquote");
  await markOrigin.keyboard.down("Shift");
  await markOrigin.keyboard.press("C");
  await markOrigin.keyboard.up("Shift");
  await resumeWorkerDebugger(browser, vimiumId);
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop === top,
    {},
    profile.scrollContainer,
    markedPosition,
  );
  await markOrigin.close();
  pass("a global mark from another tab reconnects an idle reader and restores its position");
  const settingsPage = await browser.newPage();
  await settingsPage.goto(`chrome-extension://${vimiumId}/pages/options.html`);
  await settingsPage.evaluate(async () => {
    await Settings.onLoaded();
    await Settings.set("keyMappings", "unmap j\nmap z scrollDown");
  });
  await page.bringToFront();
  await reader.evaluate(() => globalThis.focus());
  await reader.waitForFunction(async () => {
    const { normalModeKeyStateMapping } = await Backend.storage.session.get(
      "normalModeKeyStateMapping",
    );
    return normalModeKeyStateMapping.z?.command === "scrollDown";
  });
  await reader.waitForFunction(() => document.hasFocus());
  const beforeCustom = await scrollTop();
  await page.keyboard.press("z");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop > top,
    {},
    profile.scrollContainer,
    beforeCustom,
  );
  pass("custom key mappings update without reloading the reader");

  const currentWorker = settingsPage;
  await currentWorker.evaluate(async () => {
    await Settings.setSettings({
      ...Settings.getSettings(),
      keyMappings: "mapkey q j\nmap z scrollDown",
      exclusionRules: [{ pattern: "*", passKeys: "j" }],
    });
  });
  const exclusionReload = page.waitForNavigation();
  await page.keyboard.press("r");
  await exclusionReload;
  reader = await getReader();
  await reader.evaluate(() => {
    globalThis.__passedKeys = [];
    document.addEventListener("keydown", (event) => globalThis.__passedKeys.push(event.key));
  });
  const beforeExcluded = await scrollTop();
  await page.keyboard.press("q");
  await reader.waitForFunction(() => globalThis.__passedKeys.includes("q"));
  assert.equal(await scrollTop(), beforeExcluded, "Excluded q must not execute its mapkey command");
  await page.keyboard.press("z");
  await reader.waitForFunction(
    (selector, top) => document.querySelector(selector).scrollTop > top,
    {},
    profile.scrollContainer,
    beforeExcluded,
  );
  assert.deepEqual(await reader.evaluate(() => globalThis.__passedKeys), ["q"]);
  pass("exclusion pass keys reach the reader while other Vimium keys remain active");
  assert.equal(
    await reader.evaluate(() => document.getElementById("vimium2-error")?.textContent),
    undefined,
  );
  await currentWorker.evaluate(async () => {
    await Settings.set(
      "userDefinedLinkHintCss",
      ".vimiumHintMarker { color: rgb(1, 2, 3) !important; }",
    );
  });
  await reader.waitForFunction(() =>
    Settings.get("userDefinedLinkHintCss").includes("rgb(1, 2, 3)")
  );
  await page.keyboard.press("f");
  await reader.waitForFunction(() => {
    const marker = document.querySelector(".vimiumHintMarker");
    return marker && getComputedStyle(marker).color === "rgb(1, 2, 3)";
  });
  await page.keyboard.press("Escape");
  pass("custom hint CSS updates in the reader without reloading");
  await currentWorker.evaluate(async () => {
    await Settings.set("smoothScroll", true);
  });
  await reader.waitForFunction(() => Settings.get("smoothScroll"));
  const smoothStart = await scrollTop();
  const smoothDistance = await reader.evaluate(() => Settings.get("scrollStepSize"));
  await page.keyboard.press("z");
  await reader.waitForFunction(
    (selector, expected) => document.querySelector(selector).scrollTop === expected,
    {},
    profile.scrollContainer,
    smoothStart + smoothDistance,
  );
  pass("default smooth scrolling reaches the configured distance");
  await Promise.all(workerMonitors);
  assert.deepEqual(errors, [], "Browser and service worker errors");
  pass("no browser errors");
  const expectedErrors = [];
  await lifecycleSession.detach();
  expectedErrors.push(
    ...await testRecoveryNotice({
      patched,
      vimiumDirectory: path.join(projectRoot, "dist", "vimium2"),
      executablePath: values.chrome,
      profile,
      url,
      artifacts,
      pass,
    }),
  );
  await Deno.writeTextFile(
    resultPath,
    JSON.stringify(
      {
        target: values.target,
        status: "passed",
        version: patched.version,
        browser: await browser.version(),
        checks,
        errors,
        expectedErrors,
        limitations,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await Deno.writeTextFile(
    resultPath,
    JSON.stringify(
      { target: values.target, status: "failed", checks, errors, failure: error.message },
      null,
      2,
    ) + "\n",
  );
  if (page) {
    console.error("Frames:", page.frames().map((frame) => frame.url()));
    console.error("Browser errors:", errors);
    await page.screenshot({ path: path.join(artifacts, "failure.png") });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await server.shutdown();
  await Deno.remove(temp, { recursive: true });
}
