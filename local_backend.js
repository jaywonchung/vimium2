// LocalBackend wraps chrome.* APIs for the Vimium extension itself.
// Loaded as a content script right after core/backend.js.
Backend.runtime = {
  sendMessage(msg, callback) {
    if (callback) {
      chrome.runtime.sendMessage(msg, callback);
      return;
    }
    return chrome.runtime.sendMessage(msg);
  },
  onMessage: chrome.runtime.onMessage,
  getURL: (path) => chrome.runtime.getURL(path),
  getManifest: () => chrome.runtime.getManifest(),
};
Backend.storage = {
  sync: chrome.storage.sync,
  session: chrome.storage.session,
  local: chrome.storage.local,
  onChanged: chrome.storage.onChanged,
};
Backend.isAlive = () => !!chrome.runtime?.id;
Backend.isIncognito = () => !!chrome.extension?.inIncognitoContext;
