// Backend singleton for abstracting chrome.* API calls.
// Must be loaded FIRST in the content_scripts list.
// Overridden by local_backend.js (extension) or remote_backend.js (bridge) before core scripts run.
//
// If chrome is available and no backend is configured, auto-configure from chrome.
// This handles UI page iframes that import utils.js but don't have an explicit backend setup.
if (typeof globalThis.Backend === "undefined" || globalThis.Backend === null) {
  const noopStorage = {
    get() {
      return Promise.resolve({});
    },
    async set() {},
    async remove() {},
    async clear() {},
    setAccessLevel() {},
  };
  const hasChrome = typeof chrome !== "undefined" && chrome.runtime;
  globalThis.Backend = {
    runtime: {
      sendMessage: hasChrome
        ? function (msg, cb) {
          if (cb) {
            chrome.runtime.sendMessage(msg, cb);
            return;
          }
          return chrome.runtime.sendMessage(msg);
        }
        : null,
      onMessage: hasChrome ? chrome.runtime.onMessage : { addListener() {}, removeListener() {} },
      getURL: hasChrome ? (path) => chrome.runtime.getURL(path) : () => "",
      getManifest: hasChrome ? () => chrome.runtime.getManifest() : () => ({}),
    },
    storage: hasChrome
      ? {
        sync: chrome.storage.sync,
        session: chrome.storage.session,
        local: chrome.storage.local,
        onChanged: chrome.storage.onChanged,
      }
      : {
        sync: { ...noopStorage },
        session: { ...noopStorage },
        local: { ...noopStorage },
        onChanged: { addListener() {} },
      },
    isAlive: hasChrome ? () => !!chrome.runtime?.id : () => true,
    isIncognito: hasChrome ? () => !!chrome.extension?.inIncognitoContext : () => false,
  };
}
