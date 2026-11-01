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
  "openUrlInNewTab",
  "openUrlInCurrentTab",
  "openUrlInNewWindow",
  "openUrlInIncognito",
  "createMark",
  "gotoMark",
]);

export function isBridgeSender(sender) {
  return !!sender?.id && sender.tab?.id != null &&
    Settings.get("allowedBridgeExtensions").includes(sender.id) &&
    sender.url?.startsWith(`chrome-extension://${sender.id}/`);
}

function keysFor(sender) {
  return sender.tab.incognito ? [...sessionKeys, "findModeRawQueryListIncognito"] : sessionKeys;
}

export function sendToTab(tabId, message, options = {}) {
  const connections = [...ports.values()].filter(({ port, ready }) =>
    ready &&
    port.sender.tab.id === tabId &&
    (options.frameId == null || port.sender.frameId === options.frameId)
  );
  const ignoreClosedReceiver = (error) => {
    if (
      /Could not establish connection\. Receiving end does not exist\.|moved into back\/forward cache|^Reader disconnected\.$/
        .test(error.message)
    ) return null;
    throw error;
  };
  if (!connections.length) {
    const result = chrome.tabs.sendMessage(tabId, message, options);
    return options.frameId == null ? result.catch(ignoreClosedReceiver) : result;
  }
  const responses = connections.map((connection) => {
    const response = requestReader(connection, message);
    return options.frameId == null ? response.catch(ignoreClosedReceiver) : response;
  });
  if (options.frameId == null) {
    responses.unshift(
      chrome.tabs.sendMessage(tabId, message).catch(ignoreClosedReceiver),
    );
  }
  return Promise.all(responses).then((values) => values.find((value) => value != null) ?? null);
}

function requestReader(connection, message) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // An unresponsive page must not leave a browser command pending indefinitely.
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new Error("Reader command timed out."));
    }, 10000);
    connection.pending.set(id, { resolve, reject, timer });
    connection.port.postMessage({ type: "request", id, message });
  });
}

export async function sendToReader(tabId, readerId, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const connections = [...ports.values()].filter(({ port, ready }) =>
      ready && port.sender.tab.id === tabId && port.sender.id === readerId
    );
    if (connections.length > 1) {
      throw new Error("More than one matching reader is open in this tab.");
    }
    if (connections.length === 1) return await requestReader(connections[0], message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Reader did not reconnect. Reload its tab.");
}

export const bridgeRequestHandlers = {
  async hasMark(request) {
    if (typeof request.key !== "string" || !request.key.startsWith("vimiumGlobalMark|")) {
      throw new Error("Invalid mark key.");
    }
    return Object.hasOwn(await chrome.storage.local.get(request.key), request.key);
  },

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

export async function validateBridgeRequest(request, sender, backgroundCommands) {
  if (!isBridgeSender(sender)) {
    throw new Error("Add this reader's ID to Allowed bridge extensions in Vimium2 options.");
  }
  if (Object.hasOwn(bridgeRequestHandlers, request.handler)) return;
  if (!allowedHandlers.has(request.handler)) throw new Error("Unsupported bridge message.");
  const { count } = request;
  // Reader scripts can request browser commands; cap repeated work at 100 operations.
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
    const urls = request.urls ??
      (request.url ? [request.url] : (await Promise.all(
        Object.keys(request.registryEntry.options ?? {}).map(async (key) =>
          await UrlUtils.isUrl(key) ? key : null
        ),
      )).filter(Boolean));
    if (
      !Array.isArray(urls) || urls.some((url) => typeof url !== "string") ||
      Math.max(1, urls.length) * (count ?? 1) > 100
    ) {
      throw new Error("Reader requests can create at most 100 tabs.");
    }
  }
  if (
    ["createMark", "gotoMark"].includes(request.handler) &&
    !/^[A-Z]$/.test(request.markName ?? "")
  ) {
    throw new Error("Reader global marks must be uppercase letters.");
  }
  if (request.handler.startsWith("openUrl") && typeof request.url !== "string") {
    throw new Error("Reader URLs must be strings.");
  }
}

export function filterBridgeResponse(request, result) {
  return ["initializeFrame", "getCurrentTabUrl", "hasMark"].includes(request.handler)
    ? result
    : null;
}

export function initializeBridgeConnections(ready) {
  let revision = 0;
  const metadata = ready.then(async () => {
    if (globalThis.isUnitTests) return {};
    const response = await fetch(chrome.runtime.getURL("bridge.json"));
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
        pending.reject(new Error(error?.message ?? "Reader disconnected."));
      }
      connection.pending.clear();
    });
    (async () => {
      const info = await metadata;
      if (port.name !== "vimium2-bridge" || !isBridgeSender(port.sender)) {
        throw new Error("Add this reader's ID to Allowed bridge extensions in Vimium2 options.");
      }
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
          error: "This reader is no longer allowed to connect to Vimium2.",
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
