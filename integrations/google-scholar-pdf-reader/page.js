// deno-lint-ignore no-unused-vars -- Included in the reader bundle.
async function createPageUrlProvider() {
  const url = await new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "vimium2-document-url" });
    let settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      if (error) reject(error);
      else resolve(url);
    };
    const timer = setTimeout(
      () => finish(new Error("Scholar did not provide its PDF URL.")),
      10000,
    );
    port.onMessage.addListener((message) => {
      if (typeof message.pdfUrl === "string") finish(null, message.pdfUrl);
    });
    port.onDisconnect.addListener(() =>
      finish(new Error(chrome.runtime.lastError?.message ?? "Scholar URL connection closed."))
    );
    port.postMessage({ type: "getUrl" });
  });
  return () => url;
}
