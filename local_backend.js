// LocalBackend wraps chrome.* APIs for the Vimium extension itself.
// Loaded as a content script right after core/backend.js.
Backend.runtime = {
  sendMessage(msg, callback) {
    const result = chrome.runtime.sendMessage(msg).then((response) => {
      if (response?.error) throw new Error(response.error);
      return response;
    });
    if (callback) {
      return result.then(callback);
    }
    return result;
  },
  onMessage: chrome.runtime.onMessage,
  getURL: (path) => chrome.runtime.getURL(path),
  getManifest: () => chrome.runtime.getManifest(),
};
// Firefox does not have the storage.session API as of 2023-05-20. Until it does, use storage.local.
// Firefox 115 has beta support for storage.session, but this storage is not exposed to content
// scripts unless we use `setAccessLevel`, and that API is not yet implemented in Firefox 115.
if (chrome.storage.session == null || chrome.storage.session.setAccessLevel == null) {
  chrome.storage.session = chrome.storage.local;
  // Polyfill chrome.storage.session.setAccessLevel.
  chrome.storage.session.setAccessLevel = function () {};
}

Backend.storage = {
  sync: chrome.storage.sync,
  session: chrome.storage.session,
  local: chrome.storage.local,
  onChanged: chrome.storage.onChanged,
};
Backend.isAlive = () => !!chrome.runtime?.id;
Backend.isIncognito = () => !!chrome.extension?.inIncognitoContext;
