import assert from "node:assert/strict";
import * as path from "node:path";

// These controls were inspected in Scholar 0.5.2 and PDF Viewer 4.6.129 at 1440 x 900.
// PDF link targets come from sample_pdf.js, independently of Vimium's hint discovery.
function expectedTargets(target, pageNumber) {
  const controls = target === "google-scholar-pdf-reader"
    ? [
      ...[
        "Previous page",
        "Next page",
        "Zoom out",
        "Zoom in",
        "Fit to width",
        "Rotate",
        "Search",
        "Cite",
        "Google Scholar",
        "Download",
        "Print",
        "More",
        "AI Outline",
        "Thumbnails",
      ].map((name) => ({ name, selector: `button[aria-label="${name}"]` })),
      { name: "Page number", selector: ".gsr-tb-pn-input" },
      { name: "Zoom value", selector: ".gsr-tb-zoom-input" },
      { name: "Collapse sidebar", selector: ".gsr-nav-collapse-btn" },
      { name: "Sign in", selector: ".gsr-account:not(.gsr-disable)" },
      ...[1, 2, 3].map((n) => ({
        name: `Thumbnail ${n}`,
        selector: `.gsr-thumbnail[aria-label="Page ${n}"]`,
      })),
    ]
    : [
      "sidebarToggle",
      "viewFind",
      ...(pageNumber > 1 ? ["previous"] : []),
      "next",
      "pageNumber",
      "editorHighlight",
      "editorFreeText",
      "editorInk",
      "editorStamp",
      "print",
      "download",
      "secondaryToolbarToggle",
      "zoomOut",
      "zoomIn",
      "scaleSelect",
    ].map((id) => ({ name: id, selector: `#${id}` }));
  const links = pageNumber === 1
    ? [
      { name: "External link one", selector: 'a[href$="/linked?one"]' },
      { name: "External link two", selector: 'a[href$="/linked?two"]' },
      {
        name: "Internal page 2 link",
        selector: target === "google-scholar-pdf-reader"
          ? '.gsr-annotation-link[href="#"]'
          : '[data-annotation-id="12R"] > a',
      },
    ]
    : [{ name: "External page 2 link", selector: 'a[href$="/linked?page2"]' }];
  return [...controls, ...links];
}

export async function assertHints(
  { page, reader, target, pageNumber, artifacts, mode = "f" },
) {
  const expected = expectedTargets(target, pageNumber);
  for (const { selector } of expected) await reader.waitForSelector(selector, { visible: true });
  await page.keyboard.press(mode);
  await reader.waitForSelector(".vimiumHintMarker", { visible: true });
  const report = await reader.evaluate((expected) => {
    const nodes = new Map();
    const invalidExpected = [];
    for (const entry of expected) {
      const matches = [...document.querySelectorAll(entry.selector)];
      if (matches.length !== 1) invalidExpected.push({ ...entry, count: matches.length });
      else nodes.set(matches[0], entry.name);
    }
    const actual = HintCoordinator.linkHintsMode.hintMarkers.map((marker) => {
      const target = marker.localHint.element;
      const targetRect = target.getBoundingClientRect();
      const markerRect = marker.element.getBoundingClientRect();
      const style = getComputedStyle(marker.element);
      return {
        name: nodes.get(target) ?? target.outerHTML.split(">")[0] + ">",
        expected: nodes.has(target),
        label: marker.hintString,
        drawn: marker.element.isConnected && style.visibility === "visible" &&
          markerRect.width > 0 && markerRect.height > 0 && markerRect.bottom > 0 &&
          markerRect.top < innerHeight && markerRect.right > 0 && markerRect.left < innerWidth,
        overlapsTarget: markerRect.right > targetRect.left && markerRect.left < targetRect.right &&
          markerRect.bottom > targetRect.top && markerRect.top < targetRect.bottom,
      };
    });
    return {
      expected: expected.map((entry) => entry.name),
      actual,
      invalidExpected,
      markerCount: document.querySelectorAll(".vimiumHintMarker").length,
    };
  }, expected);
  const name = `hints-page${pageNumber}-${mode}`;
  await Deno.writeTextFile(
    path.join(artifacts, `${name}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  await reader.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  assert.deepEqual(report.invalidExpected, [], "Expected targets must resolve uniquely");
  const actualNames = report.actual.map((hint) => hint.name);
  const missing = report.expected.filter((name) => !actualNames.includes(name));
  const unexpected = report.actual.filter((hint) => !hint.expected).map((hint) => hint.name);
  assert.deepEqual(
    { missing, unexpected },
    { missing: [], unexpected: [] },
    "Exact hint target set",
  );
  assert.equal(new Set(actualNames).size, report.expected.length, "One hint per expected target");
  assert.equal(
    report.markerCount,
    report.expected.length,
    "One visible marker per expected target",
  );
  assert.equal(
    new Set(report.actual.map((hint) => hint.label)).size,
    report.actual.length,
    "Unique hint keys",
  );
  assert(
    report.actual.every((hint) => hint.drawn && hint.overlapsTarget),
    "Hints must be drawn over their targets",
  );
  return Object.fromEntries(report.actual.map((hint) => [hint.name, hint.label]));
}
