//
// These are functions for a page in a UIComponent iframe to communicate to its parent frame.
//

let ownerPagePort = null;
let ownerExtensionId = null;
let handleMessage = null;

export function getOwnerExtensionId() {
  return ownerExtensionId;
}

export async function registerPortWithOwnerPage(event) {
  if (event.source !== globalThis.parent) return;
  // The Vimium content script that's running on the parent page has access to this vimiumSecret
  // fetched from session storage, so if it matches, then we know that event.ports came from the
  // Vimium extension.
  const secret = (await chrome.storage.session.get("vimiumSecret")).vimiumSecret;
  const { allowedBridgeExtensions = [] } = await chrome.storage.sync.get("allowedBridgeExtensions");
  const bridgeOrigin = /^chrome-extension:\/\/([a-p]{32})$/.exec(event.origin);
  const allowedBridge = bridgeOrigin && allowedBridgeExtensions.includes(bridgeOrigin[1]);
  if (!(secret && event.data === secret) && !allowedBridge) {
    Utils.debugLog("ui_component_messenger.js: vimiumSecret is incorrect.");
    return;
  }
  if (event.ports.length !== 1) return;
  openPort(event.ports[0], allowedBridge ? bridgeOrigin[1] : null);
  // Once we complete a handshake with the parent page hosting this page's iframe, stop listening
  // for messages on the window object.
  globalThis.removeEventListener("message", registerPortWithOwnerPage);
}

// Used by unit tests.
export function unregister() {
  ownerPagePort = null;
  ownerExtensionId = null;
  handleMessage = null;
}

export function init() {
  globalThis.addEventListener("message", registerPortWithOwnerPage);
}

function openPort(port, bridgeId) {
  ownerPagePort = port;
  ownerExtensionId = bridgeId;
  const revoke = () => {
    ownerPagePort?.close();
    ownerPagePort = null;
    ownerExtensionId = null;
    handleMessage = null;
    globalThis.location.replace("about:blank");
  };
  if (bridgeId) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        area === "sync" && changes.allowedBridgeExtensions &&
        !changes.allowedBridgeExtensions.newValue?.includes(bridgeId)
      ) revoke();
    });
  }
  ownerPagePort.onmessage = async (event) => {
    if (bridgeId) {
      const { allowedBridgeExtensions = [] } = await chrome.storage.sync.get(
        "allowedBridgeExtensions",
      );
      if (!allowedBridgeExtensions.includes(bridgeId)) {
        revoke();
        return;
      }
    }
    if (handleMessage) {
      return await handleMessage(event);
    }
  };
  dispatchReadyEventWhenReady();
}

export function registerHandler(messageHandlerFn) {
  handleMessage = messageHandlerFn;
}

export function postMessage(data) {
  if (!ownerPagePort) return;
  ownerPagePort.postMessage(data);
}

// We require both that the DOM is ready and that the port has been opened before the UIComponent
// is ready. These events can happen in either order. We count them, and notify the content script
// when we've seen both.
let hasDispatchedReadyEvent = false;
function dispatchReadyEventWhenReady() {
  if (hasDispatchedReadyEvent) return;

  if (document.readyState === "loading") {
    globalThis.addEventListener("DOMContentLoaded", () => dispatchReadyEventWhenReady());
    return;
  }
  if (!ownerPagePort) return;

  if (globalThis.frameId != null) {
    postMessage({ name: "setIframeFrameId", iframeFrameId: globalThis.frameId });
  }
  hasDispatchedReadyEvent = true;
  postMessage({ name: "uiComponentIsReady" });
}
