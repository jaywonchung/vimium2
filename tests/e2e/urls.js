import assert from "node:assert/strict";

export async function assertEditUrl(page, reader, keys, expected) {
  await reader.evaluate(() => globalThis.focus());
  await reader.waitForFunction(() => document.hasFocus());
  await page.keyboard.type(keys);
  const bar = await page.waitForFrame((frame) =>
    frame.url().endsWith("/pages/vomnibar_page.html") && frame.parentFrame() === reader
  );
  await bar.waitForFunction(() => document.activeElement === document.querySelector("input"));
  assert.equal(await bar.$eval("input", (input) => input.value), expected);
  await page.keyboard.press("Escape");
  await reader.waitForFunction(() => !Vomnibar.vomnibarUI.showing && document.hasFocus());
}

export async function testDocumentUrls(
  { browser, page, reader, getReader, getWorker, origin, pass },
) {
  const source = `${origin}/papers/2026/sample.pdf?download=/wrong/parent`;
  const load = async (url) => {
    await page.goto(url);
    reader = await getReader();
    await reader.waitForFunction(() => document.hasFocus());
    return reader;
  };
  await load(source);
  await assertEditUrl(page, reader, "ge", source);
  await assertEditUrl(page, reader, "gE", source);
  pass("ge/gE prefill the PDF URL, including query parameters");

  await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read"]);
  const clipboard = await browser.newPage();
  await clipboard.goto(origin + "/clipboard");
  await page.bringToFront();
  await reader.evaluate(() => globalThis.focus());
  await page.keyboard.type("yy");
  const hud = await page.waitForFrame((frame) => frame.url().endsWith("/pages/hud_page.html"));
  await hud.waitForFunction(() => document.getElementById("hud").textContent.startsWith("Yanked "));
  await clipboard.bringToFront();
  assert.equal(await clipboard.evaluate(() => navigator.clipboard.readText()), source);
  await clipboard.close();
  await page.bringToFront();
  await reader.evaluate(() => globalThis.focus());
  pass("yy writes the PDF URL to the clipboard");

  const sourceTarget = browser.waitForTarget((target) => target.url() === `view-source:${source}`);
  await page.keyboard.type("gs");
  await (await (await sourceTarget).page()).close();
  await reader.waitForFunction(() => document.hasFocus());
  pass("gs opens view-source for the PDF URL");

  await page.keyboard.type("gg");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 0);
  await page.keyboard.type("3jmz");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 180);
  await load(`${origin}/other.pdf`);
  await page.keyboard.type("gg");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 0);
  await page.keyboard.type("jmz");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 60);
  await load(source);
  await page.keyboard.type("`z");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 180);
  await load(`${origin}/other.pdf`);
  await page.keyboard.type("`z");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 60);
  pass("the same local mark name restores independent positions in two PDFs");

  for (
    const [keys, expected] of [
      ["gu", `${origin}/papers/2026`],
      ["2gu", `${origin}/papers`],
      ["99gu", `${origin}/`],
      ["gU", `${origin}/`],
    ]
  ) {
    await load(source);
    const navigation = page.waitForNavigation();
    await page.keyboard.type(keys);
    await navigation;
    assert.equal(page.url(), expected);
    await page.waitForSelector("h1");
  }
  pass("gu, 2gu, 99gu, and gU navigate the tab using the PDF path, ignoring query slashes");

  const worker = await getWorker();
  const tab = (await worker.evaluate(() => chrome.tabs.query({})))
    .find((tab) => tab.url === `${origin}/`);
  await worker.evaluate(async ({ id, source }) => {
    await Settings.set("exclusionRules", [{ pattern: source.split("?")[0] + "*", passKeys: "j" }]);
    await chrome.tabs.update(id, { active: true });
  }, { id: tab.id, source });
  await load(source);
  await reader.evaluate(() => {
    globalThis.__passedKeys = [];
    document.addEventListener("keydown", (event) => {
      globalThis.__passedKeys.push(event.key);
      // Prevent the reader's native shortcuts after observing the passed key.
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  });
  const top = await reader.evaluate(() => Scroller.getScrollPosition().scrollY);
  await page.keyboard.press("j");
  await reader.waitForFunction(() => globalThis.__passedKeys.includes("j"));
  assert.equal(await reader.evaluate(() => Scroller.getScrollPosition().scrollY), top);
  await worker.evaluate(() => Settings.set("exclusionRules", []));
  pass("a PDF-specific exclusion applies to the reader's source URL");
  return await load(`${origin}/sample.pdf`);
}
