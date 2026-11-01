// deno-lint-ignore no-unused-vars -- Included in the reader bundle.
async function createPageUrlProvider() {
  const deadline = Date.now() + 10000;
  while (!globalThis.PDFViewerApplication?.url) {
    if (Date.now() >= deadline) throw new Error("PDF.js did not provide its PDF URL.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return () => globalThis.PDFViewerApplication.url;
}
