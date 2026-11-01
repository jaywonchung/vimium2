const ports = new Map();
const sessionKeys = [
  "normalModeKeyStateMapping",
  "mapKeyRegistry",
  "useVimLikeEscape",
  "passNextKeyKeys",
  "vimiumCSSInChromeStorage",
  "findModeRawQueryList",
];
const allowedHandlers = new Set([
  "initializeFrame",
  "domReady",
  "runBackgroundCommand",
  "getCurrentTabUrl",
  "getBrowserInfo",
  "sendMessageToFrames",
  "prepareToActivateLinkHintsMode",
  "broadcastLinkHintsMessage",
  "openUrlInNewTab",
  "openUrlInCurrentTab",
  "openUrlInNewWindow",
  "openUrlInIncognito",
  "createMark",
  "gotoMark",
]);

export function isBridgeSender(sender) {
  return !!sender?.id &&
    Settings.get("allowedBridgeExtensions").includes(sender.id) &&
    sender.url?.startsWith(`chrome-extension://${sender.id}/`);
}

function validateBridgeSender(sender) {
  if (!isBridgeSender(sender)) {
    throw new Error("Add this extension's ID to Allowed bridge extensions in Vimium2 options.");
  }
  if (sender.tab?.id == null) {
    throw new Error("Vimium2 requires a page in a browser tab. Open this extension page in a tab.");
  }
}

function keysFor(sender) {
  return sender.tab.incognito ? [...sessionKeys, "findModeRawQueryListIncognito"] : sessionKeys;
}

export function sendToTab(tabId, message, options = {}) {
  const { includeExtensionPages = true, ...frameOptions } = options;
  const connections = [...ports.values()].filter(({ port, ready }) =>
    includeExtensionPages && ready &&
    port.sender.tab.id === tabId &&
    (options.frameId == null || port.sender.frameId === options.frameId)
  );
  const ignoreClosedReceiver = (error) => {
    if (
      /Could not establish connection\. Receiving end does not exist\.|moved into back\/forward cache|^Extension page disconnected\.$/
        .test(error.message)
    ) return null;
    throw error;
  };
  if (!connections.length) {
    const result = chrome.tabs.sendMessage(tabId, message, frameOptions);
    return options.frameId == null ? result.catch(ignoreClosedReceiver) : result;
  }
  const responses = connections.map((connection) => {
    const response = requestExtensionPage(connection, message);
    return options.frameId == null ? response.catch(ignoreClosedReceiver) : response;
  });
  if (options.frameId == null) {
    responses.unshift(
      chrome.tabs.sendMessage(tabId, message).catch(ignoreClosedReceiver),
    );
  }
  return Promise.all(responses).then((values) => values.find((value) => value != null) ?? null);
}

function requestExtensionPage(connection, message, timeout = 10000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // An unresponsive page must not leave a browser command pending indefinitely.
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new Error("Extension page command timed out."));
    }, timeout);
    connection.pending.set(id, { resolve, reject, timer });
    connection.port.postMessage({ type: "request", id, message });
  });
}

export async function sendToExtensionPage(tabId, bridgeExtensionId, message, pageUrl, frameId) {
  const deadline = Date.now() + 10000;
  let connected = false;
  while (Date.now() < deadline) {
    let connections = [...ports.values()].filter(({ port, ready }) =>
      ready && port.sender.tab.id === tabId && port.sender.id === bridgeExtensionId &&
      (frameId == null || port.sender.frameId === frameId)
    );
    if (connections.length) connected = true;
    if (pageUrl) {
      const urls = await Promise.all(
        connections.map((connection) =>
          requestExtensionPage(
            connection,
            { handler: "getPageUrl" },
            Math.max(1, deadline - Date.now()),
          )
        ),
      );
      connections = connections.filter((_connection, index) =>
        urls[index].split("#")[0] === pageUrl
      );
    }
    if (connections.length > 1) {
      throw new Error("More than one matching extension page is open in this tab.");
    }
    if (connections.length === 1) return await requestExtensionPage(connections[0], message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (connected && pageUrl) {
    throw new Error("The marked page is not open in this tab: " + pageUrl);
  }
  throw new Error("The extension page did not reconnect. Reload its tab.");
}

export const bridgeRequestHandlers = {
  async storage(request, sender) {
    // Bound shared storage use to 51 queries of at most 4096 UTF-16 code units each.
    const allowed = sender.tab.incognito
      ? ["findModeRawQueryListIncognito"]
      : ["findModeRawQueryList"];
    if (
      request.area !== "session" || request.operation !== "set" || !request.value ||
      Object.keys(request.value).some((key) => !allowed.includes(key)) ||
      Object.values(request.value).some((value) =>
        !Array.isArray(value) || value.length > 51 ||
        value.some((item) => typeof item !== "string" || item.length > 4096)
      )
    ) {
      throw new Error("Unsupported bridge storage write.");
    }
    await chrome.storage.session.set(request.value);
    return null;
  },
};

export function validateBridgeRequest(request, sender, backgroundCommands) {
  validateBridgeSender(sender);
  if (Object.hasOwn(bridgeRequestHandlers, request.handler)) return;
  if (!allowedHandlers.has(request.handler)) throw new Error("Unsupported bridge message.");
  if (
    request.handler === "sendMessageToFrames" &&
    !["runInTopFrame", "focusFrame", "userIsInteractingWithThePage"].includes(
      request.message?.handler,
    )
  ) throw new Error("Unsupported frame message.");
  const { count } = request;
  // Extension pages can request browser commands; cap repeated work at 100 operations.
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 100)) {
    throw new Error("Bridge command count must be between 1 and 100.");
  }
  if (
    request.handler === "runBackgroundCommand" &&
    !Object.hasOwn(backgroundCommands, request.registryEntry?.command)
  ) throw new Error("Unsupported browser command.");
  if (
    request.handler === "runBackgroundCommand" && request.registryEntry.command === "createTab"
  ) {
    request.maxTabs = Math.floor(100 / (count ?? 1));
  }
  if (
    ["createMark", "gotoMark"].includes(request.handler) &&
    !/^[A-Z]$/.test(request.markName ?? "")
  ) {
    throw new Error("Global marks must be uppercase letters.");
  }
  if (request.handler.startsWith("openUrl") && typeof request.url !== "string") {
    throw new Error("URLs must be strings.");
  }
  if (request.pageUrl !== undefined) {
    if (typeof request.pageUrl !== "string") {
      throw new Error("Page URL must be a string.");
    }
    const url = new URL(request.pageUrl);
    const isOwnPage = url.protocol === "chrome-extension:" && url.hostname === sender.id;
    if (!["http:", "https:", "file:", "blob:"].includes(url.protocol) && !isOwnPage) {
      throw new Error("Unsupported extension page URL.");
    }
  }
}

export function filterBridgeResponse(request, result) {
  return ["initializeFrame", "getCurrentTabUrl", "getBrowserInfo"].includes(
      request.handler,
    )
    ? result
    : null;
}

export function initializeBridgeConnections(ready) {
  let revision = 0;
  const metadata = ready.then(async () => {
    if (globalThis.isUnitTests) return {};
    let response;
    try {
      response = await fetch(chrome.runtime.getURL("bridge.json"));
    } catch (cause) {
      throw new Error("Rebuild Vimium2 before loading it.", { cause });
    }
    if (!response.ok) throw new Error("Rebuild Vimium2 before loading it.");
    return await response.json();
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    let closed = false;
    const connection = { port, pending: new Map(), ready: false };
    port.onMessage.addListener((message) => {
      if (message.type === "ready") {
        connection.ready = true;
        return;
      }
      if (message.type !== "response") return;
      const pending = connection.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      connection.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.response);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      closed = true;
      ports.delete(port);
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(error?.message ?? "Extension page disconnected."));
      }
      connection.pending.clear();
    });
    (async () => {
      const info = await metadata;
      if (port.name !== "vimium2-bridge") throw new Error("Unsupported bridge connection.");
      validateBridgeSender(port.sender);
      if (closed) return;
      ports.set(port, connection);
      let storage, observed;
      do {
        observed = revision;
        const [sync, session] = await Promise.all([
          chrome.storage.sync.get(null),
          chrome.storage.session.get(keysFor(port.sender)),
        ]);
        storage = { sync, session };
      } while (observed !== revision);
      if (!closed) {
        port.postMessage({
          type: "attached",
          protocol: 1,
          fingerprint: info.fingerprint,
          version: chrome.runtime.getManifest().version,
          storage,
        });
      }
    })().catch((error) => {
      if (!closed) {
        port.postMessage({ type: "error", error: error.message });
        port.disconnect();
      }
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    revision++;
    for (const { port } of ports.values()) {
      const allowed = area === "sync" && changes.allowedBridgeExtensions
        ? (changes.allowedBridgeExtensions.newValue ?? []).includes(port.sender.id)
        : isBridgeSender(port.sender);
      if (!allowed) {
        port.postMessage({
          type: "error",
          error: "This extension is no longer allowed to connect to Vimium2.",
        });
        port.disconnect();
        ports.delete(port);
        continue;
      }
      const filtered = area === "sync" ? changes : area === "session"
        ? Object.fromEntries(
          Object.entries(changes).filter(([key]) => keysFor(port.sender).includes(key)),
        )
        : {};
      if (Object.keys(filtered).length) {
        port.postMessage({ type: "storageChanged", changes: filtered, area });
      }
    }
  });
}
