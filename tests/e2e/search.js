import assert from "node:assert/strict";
import * as path from "node:path";

export async function testFind({ page, reader, profile, artifacts, pass }) {
  const expected = ["Needle alpha", "Needle beta", "Needle gamma"];
  await reader.evaluate((selector) => {
    const container = document.querySelector(selector);
    const first = [...document.querySelectorAll("span")].find((element) =>
      element.textContent === "Needle alpha"
    );
    if (!first || container.getBoundingClientRect().top <= 0) {
      throw new Error("Missing toolbar-overlap fixture");
    }
    container.scrollTop += first.getBoundingClientRect().top -
      Math.floor(container.getBoundingClientRect().top / 2);
  }, profile.scrollContainer);
  await reader.waitForFunction(
    (selector) => {
      const first = [...document.querySelectorAll("span")].find((element) =>
        element.textContent === "Needle alpha"
      );
      const top = first.getBoundingClientRect().top;
      return top >= 0 && top < document.querySelector(selector).getBoundingClientRect().top;
    },
    {},
    profile.scrollContainer,
  );
  await page.keyboard.press("/");
  const hud = await page.waitForFrame((frame) => frame.url().endsWith("/pages/hud_page.html"));
  await hud.waitForFunction(() => document.activeElement?.id === "hud-find-input");
  await page.keyboard.type("Needle");
  await hud.waitForFunction(() =>
    document.querySelector("#hud-match-count")?.textContent.trim() === "(3 Matches)"
  );
  await page.keyboard.press("Enter");
  const visited = [];
  for (
    const [key, text] of [[null, "Needle alpha"], ["n", "Needle beta"], ["n", "Needle gamma"], [
      "N",
      "Needle beta",
    ]]
  ) {
    if (key) await page.keyboard.press(key);
    await reader.waitForFunction(
      (text, selector) => {
        const selection = getSelection();
        if (
          selection.toString() !== "Needle" || selection.anchorNode?.textContent !== text
        ) return false;
        const r = selection.getRangeAt(0).getBoundingClientRect();
        const container = document.querySelector(selector).getBoundingClientRect();
        const highlight = getComputedStyle(selection.anchorNode.parentElement, "::selection");
        return highlight.color === "rgb(0, 0, 0)" &&
          highlight.backgroundColor === "rgb(255, 150, 50)" &&
          r.height > 0 && r.top >= Math.max(0, container.top) &&
          r.bottom <= Math.min(innerHeight, container.bottom) &&
          r.left >= Math.max(0, container.left) &&
          r.right <= Math.min(innerWidth, container.right);
      },
      {},
      text,
      profile.scrollContainer,
    );
    visited.push(
      await reader.evaluate(() => ({
        text: getSelection().anchorNode.textContent,
        selected: getSelection().toString(),
        rect: getSelection().getRangeAt(0).getBoundingClientRect().toJSON(),
      })),
    );
    // Wait for the reader to paint the selected result before capturing it.
    await reader.evaluate(() =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await page.screenshot({ path: path.join(artifacts, `find-${visited.length}.png`) });
  }
  const matches = visited.slice(0, expected.length).map(({ text }) => text);
  assert.deepEqual(matches, expected, "Search must select exactly the fixture's three text spans");
  await Deno.writeTextFile(
    path.join(artifacts, "find.json"),
    JSON.stringify({ expected, matches, visited }, null, 2) + "\n",
  );
  pass("find matches exact text spans; Enter, n, and N select and reveal the expected result");
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await page.keyboard.press("l");
  await reader.waitForFunction(() => getSelection().toString() === "Needle ");
  await page.keyboard.press("Escape");
  pass("v enters visual mode, l extends the selection, and Escape exits");
  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
  await reader.evaluate(() => {
    globalThis.__insertKeys = [];
    document.addEventListener("keydown", (event) => __insertKeys.push(event.key));
  });
  await page.keyboard.press("i");
  await page.keyboard.press("q");
  await reader.waitForFunction(() => __insertKeys.includes("q"));
  assert.equal(await reader.$eval(profile.scrollContainer, (element) => element.scrollTop), 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("j");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop > 0,
    {},
    profile.scrollContainer,
  );
  pass("i passes keys through; Escape restores Vimium scrolling");
  await page.keyboard.type("gg");
  await reader.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    {},
    profile.scrollContainer,
  );
}
