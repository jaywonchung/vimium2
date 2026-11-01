import assert from "node:assert/strict";
import { selectCommand } from "./browser_commands.js";
import { assertEditUrl } from "./urls.js";

export async function testEmbeddedReader(
  { browser, mainPage, readerId, vimiumId, origin, getWorker, pass, errors },
) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewport({ width: 1440, height: 900 });
  try {
    await page.goto(`${origin}/embedded`);
    const reader = await page.waitForFrame((frame) =>
      frame.url().startsWith(`chrome-extension://${readerId}/`)
    );
    await reader.waitForFunction(() =>
      globalThis.__vimium2?.state === "ready" && Number.isInteger(globalThis.frameId) &&
      document.body.textContent.includes("Needle alpha")
    );
    assert(reader.parentFrame(), "The fixture must contain an embedded reader");
    await assertEditUrl(page, reader, "ge", `${origin}/sample.pdf`);
    pass("ge inside an embedded reader edits its PDF URL instead of the host page URL");
    const blocked = await reader.evaluate((id) =>
      chrome.runtime.sendMessage(id, {
        handler: "openUrlInCurrentTab",
        url: "\u00a0javascript:globalThis.__scriptProbe=true",
        allowJavascript: true,
      }), vimiumId);
    assert.equal(blocked.error, "Bridged extensions cannot execute javascript URLs.");
    assert.equal(await page.evaluate(() => globalThis.__scriptProbe), undefined);
    await reader.evaluate(() => globalThis.focus());
    await reader.waitForFunction(() => document.hasFocus());
    const readerTop = await reader.evaluate(() => Scroller.getScrollPosition().scrollY);
    const hostTop = await page.evaluate(() => scrollY);
    await selectCommand(page, "2:", "Scroll down");
    await reader.waitForFunction(
      (top) => Scroller.getScrollPosition().scrollY === top + 2 * Settings.get("scrollStepSize"),
      {},
      readerTop,
    );
    assert.equal(await page.evaluate(() => scrollY), hostTop);
    pass(": sends an embedded reader command only to its originating frame");
    await page.evaluate(() => globalThis.focus());
    await page.keyboard.press("o");
    const bar = await page.waitForFrame((frame) =>
      frame.url().endsWith("/pages/vomnibar_page.html") && frame.parentFrame() === page.mainFrame()
    );
    await bar.waitForFunction(() => document.activeElement === document.querySelector("input"));
    for (const frame of page.frames()) {
      if (frame.url().endsWith("/pages/vomnibar_page.html") && frame.parentFrame() === reader) {
        assert.equal(await frame.evaluate(() => document.hasFocus()), false);
      }
    }
    assert.equal(
      bar.parentFrame(),
      page.mainFrame(),
      "Website commands must open UI in the website",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() =>
      document.activeElement?.shadowRoot?.activeElement?.tagName !== "IFRAME"
    );
    await page.keyboard.press("f");
    await page.waitForSelector(".vimiumHintMarker", { visible: true });
    const worker = await getWorker();
    const key = await worker.evaluate(async (origin) => {
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/embedded`);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: "ISOLATED",
        func: () =>
          HintCoordinator.linkHintsMode.hintMarkers.find((marker) =>
            marker.localHint?.element.id === "outside"
          )?.hintString,
      });
      return result;
    }, origin);
    assert.equal(typeof key, "string", "The outside link must have a hint");
    const navigation = page.waitForNavigation();
    await page.keyboard.type(key);
    await navigation;
    assert.equal(page.url(), `${origin}/linked?outside`);
    pass(
      "an embedded reader cannot execute scripts in its host; host Vomnibar and hint activation still work",
    );
  } finally {
    await page.close();
    const worker = await getWorker();
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
      await chrome.tabs.update(tab.id, { active: true });
    }, mainPage.url());
  }
}
