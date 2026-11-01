import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

async function waitUntil(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function openVomnibar(page, keys) {
  await page.keyboard.type(keys);
  const frame = await page.waitForFrame((frame) =>
    frame.url().endsWith("/pages/vomnibar_page.html")
  );
  await frame.waitForFunction(() => {
    const input = document.querySelector("input");
    return document.activeElement === input && input.value === "";
  });
  return frame;
}

export async function selectCommand(page, keys, title) {
  const frame = await openVomnibar(page, keys);
  assert.equal(await frame.$eval("input", (input) => input.placeholder), "Commands");
  await page.keyboard.type(title);
  await frame.waitForFunction(
    (title) => {
      const selected = document.querySelector("li.selected .title");
      return selected?.textContent.trim() === title;
    },
    {},
    title,
  );
  await page.keyboard.press("Enter");
}

export async function testBrowserCommands(
  { browser, page, reader, getWorker, getReader, origin, pass },
) {
  const worker = await getWorker();
  const tabs = () => worker.evaluate(() => chrome.tabs.query({ currentWindow: true }));
  const readerTab = (await tabs()).find((tab) => tab.url.includes("/sample.pdf"));
  assert(readerTab, "Reader tab exists");
  const activeIs = async (id) => (await tabs()).some((tab) => tab.id === id && tab.active);
  const neighbor = await browser.newPage();
  await neighbor.goto(`${origin}/neighbor`);
  const neighborTab = (await tabs()).find((tab) => tab.url === `${origin}/neighbor`);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), readerTab.id);
  await waitUntil(() => activeIs(readerTab.id), "activate the reader fixture");
  await reader.evaluate(() => globalThis.focus());
  await reader.waitForFunction(() => document.hasFocus());
  await page.keyboard.type("gg");
  await reader.waitForFunction(() => Scroller.getScrollPosition().scrollY === 0);
  await selectCommand(page, "2:", "Scroll down");
  await reader.waitForFunction(() =>
    Scroller.getScrollPosition().scrollY === 2 * Settings.get("scrollStepSize") &&
    !Vomnibar.vomnibarUI.showing && document.hasFocus()
  );
  pass(": selects a reader command and applies its numeric prefix exactly once");

  await selectCommand(page, ":", "Go one tab right");
  await waitUntil(() => activeIs(neighborTab.id), "command picker selects the next tab");
  await selectCommand(neighbor, ":", "Go one tab left");
  await waitUntil(() => activeIs(readerTab.id), "website command picker returns to the reader");
  await reader.waitForFunction(() => document.hasFocus());
  pass(": executes browser commands from both a reader and a website");

  await page.keyboard.type("gt");
  await waitUntil(() => activeIs(neighborTab.id), "gt activates the next tab");
  await neighbor.keyboard.type("gT");
  await waitUntil(() => activeIs(readerTab.id), "gT activates the previous tab");
  pass("gt/gT change Chrome's active tab in both directions");

  const selection = await openVomnibar(page, "T");
  await page.keyboard.type("Vimium2 neighbor");
  await selection.waitForFunction(() => {
    const results = [...document.querySelectorAll("li")];
    return results.length === 1 && results[0].textContent.includes("Vimium2 neighbor");
  });
  await page.keyboard.press("Enter");
  await waitUntil(() => activeIs(neighborTab.id), "T selects the requested tab");
  await neighbor.keyboard.type("gT");
  await waitUntil(() => activeIs(readerTab.id), "return to reader");
  await neighbor.close();
  await reader.waitForFunction(() => document.hasFocus());
  pass("T filters tabs and selects the requested tab on Enter");

  await openVomnibar(page, "O");
  const query = "vimium2 keyboard integration test";
  await page.keyboard.type(query);
  const googleTarget = browser.waitForTarget((target) => {
    if (!target.url().startsWith("https://www.google.com/search?")) return false;
    const url = new URL(target.url());
    return url.hostname === "www.google.com" && url.pathname === "/search" &&
      url.searchParams.get("q") === query;
  });
  await page.keyboard.press("Enter");
  await (await (await googleTarget).page()).close();
  await reader.waitForFunction(() => document.hasFocus());
  pass("O submits the typed query to Google's search URL in a new tab");

  await page.keyboard.press("t");
  const createdTarget = await browser.waitForTarget((target) =>
    target.url() === `${origin}/created`
  );
  const created = await createdTarget.page();
  await created.waitForSelector("h1");
  const createdTab = (await tabs()).find((tab) => tab.url === `${origin}/created`);
  assert(await activeIs(createdTab.id));
  await created.keyboard.down("x");
  await waitUntil(
    async () => !(await tabs()).some((tab) => tab.id === createdTab.id),
    "x closes the new tab",
  );
  await page.keyboard.up("x");
  const closedSessions = await worker.evaluate(() => chrome.sessions.getRecentlyClosed());
  const closedSession = closedSessions.find((session) => session.tab?.url === `${origin}/created`);
  assert(closedSession, "The closed tab must be in Chrome's session history");
  await page.keyboard.press("X");
  const restoredTarget = await browser.waitForTarget((target) =>
    target.url() === `${origin}/created`
  );
  const restored = await restoredTarget.page();
  await restored.waitForSelector("h1");
  await waitUntil(
    async () =>
      !(await worker.evaluate(() => chrome.sessions.getRecentlyClosed())).some((session) =>
        session.tab?.sessionId === closedSession.tab.sessionId
      ),
    "X consumes the closed session",
  );
  await restored.close();
  await reader.waitForFunction(() => document.hasFocus());
  pass("t creates a tab, x closes it, and X restores its URL");

  await openVomnibar(page, "o");
  await page.keyboard.type(`${origin}/landing`);
  const navigation = page.waitForNavigation();
  await page.keyboard.press("Enter");
  await navigation;
  assert.equal(page.url(), `${origin}/landing`);
  await page.waitForSelector("h1");
  const back = page.waitForNavigation();
  await page.keyboard.press("H");
  await back;
  assert(page.url().endsWith("/sample.pdf"));
  pass("o opens the typed URL; H restores the PDF URL");
  // Native Scholar can lose its PDF embed on history restoration in headless Chrome.
  // Reload starts an independent document for the reader-reload check.
  await page.reload();
  reader = await getReader();
  const reload = page.waitForNavigation();
  await page.keyboard.press("r");
  await reload;
  reader = await getReader();
  pass("r reloads the reader and reconnects its bridge");
  return reader;
}
