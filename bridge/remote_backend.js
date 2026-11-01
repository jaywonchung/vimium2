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
    failed = true;
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
        if (msg.type === "error") {
          rejected = true;
          alive = false;
          const error = new Error(msg.error);
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
            const error = new Error("This reader's integration needs an update.");
            error.code = "CORE_MISMATCH";
            reject(error);
            return;
          }
          version = msg.version;
          updateCache(cachedSettings, msg.storage.sync, "sync");
          updateCache(cachedSession, msg.storage.session, "session");
          attached = true;
          alive = true;
          if (coreReady) connection.postMessage({ type: "ready" });
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
        alive = false;
        if (rejected) return;
        if (!attached) {
          const failure = new Error(
            "Cannot connect to Vimium2. Check its extension ID, enable it, and reload this reader. " +
              (error?.message ?? ""),
          );
          reject(failure);
          return;
        }
        reconnecting = null;
      });
    });
  }

  function dispatchMessage(message, respond = () => {}, forceTopFrame = false) {
    if (forceTopFrame && message.handler === "runInTopFrame") {
      const command = NormalModeCommands[message.registryEntry.command];
      if (!command) throw new Error("Unsupported reader command: " + message.registryEntry.command);
      return Promise.resolve(command(message.sourceFrameId, message.registryEntry)).then(respond);
    }
    for (const listener of listeners.keys()) {
      if (listener(message, { id: VIMIUM_ID }, respond) === true) return;
    }
    respond(null);
  }

  const localHandlers = {
    userIsInteractingWithThePage() {
      return null;
    },
    getBrowserInfo() {
      return { isFirefox: false, firefoxVersion: null };
    },
    runBackgroundCommand(request) {
      if (request.registryEntry?.command === "reload") {
        location.reload();
        return null;
      }
      return undefined;
    },
    prepareToActivateLinkHintsMode(request) {
      // Short-circuit multi-frame coordination for single-frame bridge mode.
      setTimeout(() => {
        if (typeof HintCoordinator === "undefined") return;
        HintCoordinator.getHintDescriptors(request);
        HintCoordinator.activateMode({
          frameId: globalThis.frameId ?? 0,
          frameIdToHintDescriptors: {},
          modeIndex: request.modeIndex,
          originatingFrameId: globalThis.frameId ?? 0,
        });
      }, 0);
      return null;
    },
    broadcastLinkHintsMessage(request) {
      setTimeout(() => {
        if (
          typeof HintCoordinator !== "undefined" &&
          HintCoordinator.willHandleMessage(request.messageType)
        ) {
          HintCoordinator[request.messageType](request);
        }
      }, 0);
      return null;
    },
    linkHintsMessage() {
      return null;
    },
    sendMessageToFrames(request) {
      dispatchMessage(request.message, () => {}, true);
      return null;
    },
  };

  function makeStorageAdapter(cache, area) {
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
      set(items, callback) {
        return writeStorage(area, "set", items, callback);
      },
      remove(keys, callback) {
        return writeStorage(area, "remove", keys, callback);
      },
      clear(callback) {
        return writeStorage(area, "clear", null, callback);
      },
      setAccessLevel() {},
    };
  }

  function writeStorage(area, operation, value, callback) {
    const result = Backend.runtime.sendMessage({ handler: "storage", area, operation, value }).then(
      () => {
        const cache = { sync: cachedSettings, session: cachedSession }[area];
        const next = operation === "clear" ? {} : { ...cache };
        if (operation === "set") Object.assign(next, value);
        if (operation === "remove") {
          for (const key of Array.isArray(value) ? value : [value]) delete next[key];
        }
        updateCache(cache, next, area);
      },
    );
    if (callback) {
      result.then(callback);
      return;
    }
    return result;
  }

  function configureBackend() {
    const reconnect = () => {
      if (failed) {
        return Promise.reject(new Error("Vimium2 is disconnected. Reload this reader tab."));
      }
      if (alive) return Promise.resolve();
      return reconnecting ??= attach().catch((error) => {
        fail(error);
        throw error;
      }).finally(() => {
        reconnecting = null;
      });
    };
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
        const handler = localHandlers[message.handler];
        if (handler) {
          const result = handler(message);
          if (result !== undefined) return result;
        }
        const response = await chrome.runtime.sendMessage(VIMIUM_ID, message);
        if (response?.error) throw new Error(response.error);
        return response;
      };
      const result = send().catch((error) => {
        if (typeof HUD !== "undefined") HUD.show(error.message, 3000);
        else config.onError(error);
        if (["runBackgroundCommand", "gotoMark"].includes(message.handler)) return null;
        throw error;
      });
      if (callback) {
        result.then(callback);
        return;
      }
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
      sync: makeStorageAdapter(cachedSettings, "sync"),
      session: makeStorageAdapter(cachedSession, "session"),
      local: {
        get(key, callback) {
          const result = Backend.runtime.sendMessage({ handler: "hasMark", key }).then((exists) =>
            exists ? { [key]: true } : {}
          );
          if (callback) {
            result.then(callback);
            return;
          }
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
    Backend.isAlive = () => !failed;
    Backend.isIncognito = () => !!chrome.extension?.inIncognitoContext;
  }

  async function applyPostLoadPatches() {
    await Settings.onLoaded();
    const userStyle = document.createElement("style");
    document.head.appendChild(userStyle);
    const updateStyle = () => {
      userStyle.textContent = Settings.get("userDefinedLinkHintCss");
    };
    updateStyle();
    Settings.addEventListener("change", updateStyle);
    if (
      typeof DomUtils !== "undefined" && typeof KeyboardUtils !== "undefined"
    ) {
      const origSimulateClick = DomUtils.simulateClick.bind(DomUtils);
      DomUtils.simulateClick = function (element, modifiers) {
        if (modifiers) {
          const isMac = KeyboardUtils.platform === "Mac";
          const isNewTab = isMac
            ? (modifiers.metaKey && !modifiers.ctrlKey)
            : (!modifiers.metaKey && modifiers.ctrlKey);
          if (isNewTab) {
            const href = element.href || element.closest?.("a")?.href;
            if (href) {
              Backend.runtime.sendMessage({
                handler: "openUrlInNewTab",
                url: href,
                active: !!modifiers.shiftKey,
              });
              return;
            }
          }
        }
        return origSimulateClick(element, modifiers);
      };
    }

    if (typeof HUD !== "undefined") {
      HUD.copyToClipboard = function (text) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        try {
          if (!document.execCommand("copy")) throw new Error("Clipboard write failed.");
          return true;
        } catch (error) {
          HUD.show(error.message, 3000);
          return false;
        } finally {
          ta.remove();
        }
      };
    }

    if (typeof HUD !== "undefined") {
      const origHide = HUD.hide.bind(HUD);
      HUD.hide = function (...args) {
        origHide(...args);
        // If focus is on a vimium-reset element (HUD wrapper), return it to the page
        if (document.activeElement?.classList?.contains("vimium-reset")) {
          document.activeElement.blur();
          globalThis.focus();
        }
      };
    }

    coreReady = true;
    currentConnection.postMessage({ type: "ready" });
  }

  return { attach, configureBackend, applyPostLoadPatches };
}
