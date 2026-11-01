// Connects an embedded Vimium2 core to the Vimium2 extension.
// deno-lint-ignore no-unused-vars -- Called from the generated bridge bundle.
function initRemoteBackend(config) {
  const VIMIUM_ID = config.vimiumId;
  const cachedSettings = {};
  const cachedSession = {};
  const storageChangeListeners = [];
  const listeners = new Map();
  let version;
  let alive = false;
  let failed = false;
  let reconnecting = null;
  let currentConnection;
  let coreReady = false;

  function fail(error) {
    failed = ["CORE_MISMATCH", "BRIDGE_REJECTED"].includes(error.code);
    alive = false;
    config.onError(error);
  }

  function updateCache(cache, values, area) {
    const changes = {};
    for (const key of new Set([...Object.keys(cache), ...Object.keys(values)])) {
      if (JSON.stringify(cache[key]) === JSON.stringify(values[key])) continue;
      changes[key] = { oldValue: cache[key], newValue: values[key] };
    }
    for (const key of Object.keys(cache)) delete cache[key];
    Object.assign(cache, values);
    if (Object.keys(changes).length) {
      for (const listener of storageChangeListeners) listener(changes, area);
    }
  }

  async function attach() {
    if (!/^[a-p]{32}$/.test(VIMIUM_ID ?? "")) {
      throw new Error("Missing Vimium2 extension ID.");
    }
    alive = false;
    await new Promise((resolve, reject) => {
      const connection = chrome.runtime.connect(VIMIUM_ID, { name: "vimium2-bridge" });
      currentConnection = connection;
      let attached = false;
      let rejected = false;
      connection.onMessage.addListener((msg) => {
        if (connection !== currentConnection) return;
        if (msg.type === "error") {
          rejected = true;
          alive = false;
          const error = new Error(msg.error);
          error.code = "BRIDGE_REJECTED";
          if (attached) fail(error);
          else reject(error);
          return;
        }
        if (msg.type === "attached") {
          if (
            msg.protocol !== 1 || !msg.storage?.session?.normalModeKeyStateMapping ||
            msg.fingerprint !== config.fingerprint
          ) {
            rejected = true;
            connection.disconnect();
            const error = new Error("This extension was patched for a different Vimium2 build.");
            error.code = "CORE_MISMATCH";
            reject(error);
            return;
          }
          version = msg.version;
          updateCache(cachedSettings, msg.storage.sync, "sync");
          updateCache(cachedSession, msg.storage.session, "session");
          attached = true;
          alive = true;
          if (coreReady) {
            connection.postMessage({ type: "ready" });
            config.onConnected();
          }
          resolve();
        } else if (msg.type === "storageChanged" && attached) {
          const cache = { sync: cachedSettings, session: cachedSession }[msg.area];
          if (!cache) return;
          const next = { ...cache };
          for (const [key, value] of Object.entries(msg.changes)) {
            if (value.newValue === undefined) delete next[key];
            else next[key] = value.newValue;
          }
          updateCache(cache, next, msg.area);
        } else if (msg.type === "request") {
          try {
            dispatchMessage(
              msg.message,
              (response) => connection.postMessage({ type: "response", id: msg.id, response }),
            );
          } catch (error) {
            connection.postMessage({ type: "response", id: msg.id, error: error.message });
          }
        }
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (connection !== currentConnection) return;
        alive = false;
        if (rejected) return;
        if (!attached) {
          const failure = new Error(
            "Cannot connect to Vimium2. Check its extension ID, enable it, and reload this page. " +
              (error?.message ?? ""),
          );
          reject(failure);
          return;
        }
        // An open Vimium UI frame must still be able to send commands to this extension page.
        setTimeout(() => reconnect().catch(() => {}), 0);
      });
    });
  }

  function dispatchMessage(message, respond = () => {}) {
    if (message.handler === "getPageUrl") return respond(Backend.getPageUrl());
    for (const listener of listeners.keys()) {
      if (listener(message, { id: VIMIUM_ID }, respond) === true) return;
    }
    respond(null);
  }

  function makeStorageAdapter(cache) {
    return {
      get(keys, callback) {
        let result;
        if (keys == null || typeof keys === "function") {
          if (typeof keys === "function") callback = keys;
          result = globalThis.structuredClone(cache);
        } else {
          result = {};
          const entries = typeof keys === "string"
            ? [[keys]]
            : Array.isArray(keys)
            ? keys.map((key) => [key])
            : Object.entries(keys);
          for (const [key, defaultValue] of entries) {
            if (Object.hasOwn(cache, key)) result[key] = structuredClone(cache[key]);
            else if (!Array.isArray(keys) && typeof keys === "object") {
              result[key] = structuredClone(defaultValue);
            }
          }
        }
        if (callback) {
          setTimeout(() => callback(result), 0);
          return;
        }
        return Promise.resolve(result);
      },
    };
  }

  function reconnect() {
    if (failed) {
      return Promise.reject(new Error("Vimium2 is disconnected. Reload this extension page."));
    }
    if (alive) return Promise.resolve();
    return reconnecting ??= attach().catch((error) => {
      fail(error);
      throw error;
    }).finally(() => {
      reconnecting = null;
    });
  }

  function configureBackend() {
    globalThis.addEventListener("focus", () => {
      if (!failed) reconnect().catch(() => {});
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !failed) reconnect().catch(() => {});
    });
    Backend.runtime = {};
    Backend.runtime.sendMessage = function (message, callback) {
      message = structuredClone(message);
      const send = async () => {
        await reconnect();
        const response = await chrome.runtime.sendMessage(VIMIUM_ID, {
          ...message,
          pageUrl: Backend.getPageUrl(),
        });
        if (response?.error) throw new Error(response.error);
        return response;
      };
      const result = send();
      if (callback) return result.then(callback);
      return result;
    };
    Backend.runtime.onMessage = {
      addListener(fn) {
        listeners.set(fn, fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
    };
    Backend.storage = {
      sync: makeStorageAdapter(cachedSettings),
      session: {
        ...makeStorageAdapter(cachedSession),
        set(items, callback) {
          const result = Backend.runtime.sendMessage({
            handler: "storage",
            area: "session",
            operation: "set",
            value: items,
          }).then(() => updateCache(cachedSession, { ...cachedSession, ...items }, "session"));
          if (callback) return result.then(callback);
          return result;
        },
      },
      onChanged: {
        addListener(fn) {
          storageChangeListeners.push(fn);
        },
      },
    };
    Backend.runtime.getURL = (path) => "chrome-extension://" + VIMIUM_ID + "/" + path;
    Backend.runtime.getManifest = () => ({ version });
    Backend.emulateClickDefaultAction = true;
    Backend.writeClipboard = (text) => {
      const textarea = document.createElement("textarea");
      textarea.value = text.replace(/\xa0/g, " ");
      textarea.style.cssText = "position:fixed;opacity:0;left:-9999px";
      const focusedElement = document.activeElement;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (!document.execCommand("copy")) throw new Error("Clipboard write failed.");
      } finally {
        textarea.remove();
        focusedElement?.focus();
      }
    };
    Backend.isAlive = () => !failed;
    Backend.isPageRoot = () => true;
    Backend.isIncognito = () => !!chrome.extension?.inIncognitoContext;
    const getPageUrl = config.getPageUrl ?? Backend.getPageUrl;
    Backend.getPageUrl = () => {
      const url = new URL(getPageUrl());
      const isOwnPage = url.protocol === "chrome-extension:" && url.hostname === location.hostname;
      if (!["http:", "https:", "file:", "blob:"].includes(url.protocol) && !isOwnPage) {
        throw new Error("Unsupported extension page URL.");
      }
      return url.href;
    };
    if (config.navigateInTab) {
      Backend.navigate = (url) =>
        Backend.runtime.sendMessage({ handler: "openUrlInCurrentTab", url });
    }
  }

  function coreLoaded() {
    coreReady = true;
    currentConnection.postMessage({ type: "ready" });
  }

  return { attach, configureBackend, coreLoaded };
}
