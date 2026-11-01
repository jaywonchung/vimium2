import assert from "node:assert/strict";
import * as path from "node:path";
import puppeteer from "puppeteer";

export async function testRecoveryNotice(
  { patched, vimiumDirectory, executablePath, url, artifacts, pass },
) {
  const filename = path.join(patched.output, "vimium2", "bridge-0.js");
  const bundle = await Deno.readTextFile(filename);
  const stale = bundle.replace(/fingerprint: "[a-f0-9]{64}"/, 'fingerprint: "outdated"');
  assert.notEqual(stale, bundle, "The probe must contain a different embedded core fingerprint");
  await Deno.writeTextFile(filename, stale);
  const errors = [];
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: true,
    args: ["--disable-frame-rate-limit"],
    executablePath,
    userDataDir: path.join(path.dirname(patched.output), "recovery-profile"),
  });
  try {
    const vimiumId = await browser.installExtension(vimiumDirectory);
    const bridgeExtensionId = await browser.installExtension(patched.output);
    const settingsPage = await browser.newPage();
    await settingsPage.goto(`chrome-extension://${vimiumId}/pages/options.html`);
    await settingsPage.evaluate(async (id) => {
      await Settings.onLoaded();
      await Settings.set("allowedBridgeExtensions", [id]);
    }, bridgeExtensionId);
    await settingsPage.close();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(url);
    const reader = await page.waitForFrame((frame) =>
      frame.url().startsWith(`chrome-extension://${bridgeExtensionId}/`)
    );
    await reader.waitForFunction(() => globalThis.__vimium2?.state === "error");
    await reader.waitForFunction(() => document.body.textContent.includes("Needle alpha"));
    await reader.evaluate(() =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const notice = await reader.$eval("#vimium2-error", (element) => ({
      text: element.textContent,
      height: element.getBoundingClientRect().height,
      viewport: innerHeight,
      link: element.querySelector("a")?.href,
      role: element.getAttribute("role"),
    }));
    assert.equal(
      notice.text,
      "Vimium2: This extension was patched for a different Vimium2 build. Update instructions.",
    );
    const instructionsUrl = "https://github.com/jaywonchung/vimium2#updating-a-patched-reader";
    assert.equal(notice.link, instructionsUrl);
    assert(notice.height > 0 && notice.height <= notice.viewport);
    assert.equal(notice.role, "alert");
    assert.equal(await reader.evaluate(() => typeof globalThis.NormalMode), "undefined");
    await page.screenshot({ path: path.join(artifacts, "recovery.png") });
    const opened = browser.waitForTarget((target) => target.url() === instructionsUrl);
    await reader.click("#vimium2-error a");
    await (await (await opened).page()).close();
    assert.equal(page.url().includes("sample.pdf"), true, "The PDF tab remains open");
    pass(
      "a stale reader links to README update instructions in a new tab before enabling keys",
    );
    assert.equal(errors.length, 1, "The stale reader emits one expected mismatch error");
    assert.match(errors[0], /patched for a different Vimium2 build/);
    return errors;
  } finally {
    await browser.close();
    await Deno.writeTextFile(filename, bundle);
  }
}
