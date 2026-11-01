// Shared page capabilities. A backend adapter configures runtime and storage before core scripts run.
globalThis.Backend = {
  // A page root owns UI commands and scroll positions, even when embedded in another page.
  isPageRoot: () => globalThis.top === globalThis.self,
  emulateClickDefaultAction: false,
  // A host can supply a clipboard writer when Vimium's HUD frame cannot access its clipboard.
  writeClipboard: null,
  // Integrations may expose a content URL instead of their extension page URL.
  getPageUrl: () => globalThis.location.href,
  navigate: (url) => {
    globalThis.location.href = url;
  },
};
