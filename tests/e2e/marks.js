export async function testMarks({ page, reader, profile, pass }) {
  const shifted = async (key) => {
    await page.keyboard.down("Shift");
    await page.keyboard.press(key);
    await page.keyboard.up("Shift");
  };
  const top = () => reader.$eval(profile.scrollContainer, (element) => element.scrollTop);
  const waitTop = (position) =>
    reader.waitForFunction(
      (selector, position) => document.querySelector(selector).scrollTop === position,
      {},
      profile.scrollContainer,
      position,
    );
  const initial = await top();
  await page.keyboard.type("ma");
  await page.keyboard.type("3j");
  await reader.waitForFunction(
    (selector, position) => document.querySelector(selector).scrollTop > position,
    {},
    profile.scrollContainer,
    initial,
  );
  await page.keyboard.type("`a");
  await waitTop(initial);
  const hud = await page.waitForFrame((frame) => frame.url().endsWith("/pages/hud_page.html"));
  const created = hud.waitForFunction(
    () => document.getElementById("hud")?.textContent === 'Created global mark "A".',
    { polling: "mutation" },
  );
  await page.keyboard.press("m");
  await shifted("A");
  await created;
  await page.keyboard.type("3j");
  await reader.waitForFunction(
    (selector, position) => document.querySelector(selector).scrollTop > position,
    {},
    profile.scrollContainer,
    initial,
  );
  await page.keyboard.press("Backquote");
  await shifted("A");
  await waitTop(initial);
  await page.keyboard.type("gg");
  await waitTop(0);
  await page.keyboard.type("``");
  await waitTop(initial);
  const missing = hud.waitForFunction(
    () => document.getElementById("hud")?.textContent === "Global mark not set 'B'",
    { polling: "mutation" },
  );
  await page.keyboard.press("Backquote");
  await shifted("B");
  await missing;
  await page.keyboard.press("j");
  await reader.waitForFunction(
    (selector, position) => document.querySelector(selector).scrollTop > position,
    {},
    profile.scrollContainer,
    initial,
  );
  pass(
    "local, global, and previous-position marks restore the reader; an unset mark preserves keyboard input",
  );
}
