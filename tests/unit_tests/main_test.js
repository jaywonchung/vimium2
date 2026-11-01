import "./test_helper.js";
import { withPromise } from "./test_helper.js";
import "../../core/lib/settings.js";
import "../../background_scripts/main.js";
import { RegistryEntry } from "../../background_scripts/commands.js";

function sendBackgroundMessage(request, sender, event = chrome.runtime.onMessage) {
  const { promise, resolve, reject } = Promise.withResolvers();
  // Stubbed handlers require no I/O; fail missing responses after one second.
  const timer = setTimeout(() => reject(new Error("Background message did not respond.")), 1000);
  try {
    for (const listener of event.listeners) listener(request, sender, resolve);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  return promise.finally(() => clearTimeout(timer));
}

context("External background message dispatch", () => {
  const sender = {
    id: "allowed",
    url: "chrome-extension://allowed/page.html",
    tab: { id: 7, url: "chrome-extension://allowed/page.html" },
    frameId: 0,
  };
  const send = (request, source = sender) =>
    sendBackgroundMessage(request, source, chrome.runtime.onMessageExternal);

  setup(async () => {
    await Settings.onLoaded();
    stub(Settings._settings, "allowedBridgeExtensions", [sender.id]);
  });

  should("reject an unlisted extension, a mismatched origin, and a missing tab", async () => {
    const updates = [];
    stub(chrome.tabs, "update", (...args) => updates.push(args));
    for (
      const source of [
        { ...sender, id: "denied" },
        { ...sender, url: "https://other.example/" },
      ]
    ) {
      assert.equal(
        {
          error: "Add this extension's ID to Allowed bridge extensions in Vimium2 options.",
        },
        await send({ handler: "openUrlInCurrentTab", url: "https://destination.example/" }, source),
      );
    }
    assert.equal(
      { error: "Vimium2 requires a page in a browser tab. Open this extension page in a tab." },
      await send({ handler: "openUrlInCurrentTab", url: "https://destination.example/" }, {
        ...sender,
        tab: undefined,
      }),
    );
    assert.equal([], updates);
  });

  should(
    "derive the target tab from Chrome despite caller-supplied tab IDs",
    async () => {
      const updates = [];
      stub(chrome.tabs, "update", (id, options) => updates.push({ id, ...options }));
      const request = {
        handler: "openUrlInCurrentTab",
        url: "https://destination.example/",
        tab: { id: 99 },
        tabId: 99,
      };
      assert.equal(null, await send(request));
      assert.equal([{ id: 7, url: request.url }], updates);
    },
  );

  should("validate page identity before initialization or saving marks", async () => {
    const before = await chrome.storage.local.get(null);
    assert.equal(sender.url, await send({ handler: "getCurrentTabUrl" }));
    for (
      const [pageUrl, error] of [
        [42, "Page URL must be a string."],
        ["javascript:alert(1)", "Unsupported extension page URL."],
        ["chrome-extension://another/page.html", "Unsupported extension page URL."],
      ]
    ) {
      assert.equal({ error }, await send({ handler: "createMark", markName: "A", pageUrl }));
    }
    assert.equal(before, await chrome.storage.local.get(null));
    for (const pageUrl of [sender.url, "https://example.com/article"]) {
      assert.equal(pageUrl, await send({ handler: "getCurrentTabUrl", pageUrl }));
    }
  });
});

context("HintCoordinator", () => {
  should("prepareToActivateLinkHintsMode", async () => {
    let receivedMessages = [];
    const frameIdToHintDescriptors = {
      "0": { frameId: 0, localIndex: 123, linkText: null },
      "1": { frameId: 1, localIndex: 456, linkText: null },
    };

    stub(chrome.webNavigation, "getAllFrames", () => [{ frameId: 0 }, { frameId: 1 }]);

    stub(
      chrome.tabs,
      "sendMessage",
      withPromise((_tabId, message, options) => {
        if (message.messageType == "getHintDescriptors") {
          return frameIdToHintDescriptors[options.frameId];
        } else if (message.messageType == "activateMode") {
          receivedMessages.push(message);
        }
      }),
    );

    await HintCoordinator.prepareToActivateLinkHintsMode(0, 0, {
      modeIndex: 0,
      requestedByHelpDialog: false,
    });

    receivedMessages = receivedMessages.map(
      (m) => Utils.pick(m, ["frameId", "frameIdToHintDescriptors"]),
    );

    // Each frame should receive only the hint descriptors from the other frames.
    assert.equal([
      { frameId: 0, frameIdToHintDescriptors: { "1": frameIdToHintDescriptors[1] } },
      { frameId: 1, frameIdToHintDescriptors: { "0": frameIdToHintDescriptors[0] } },
    ], receivedMessages);
  });
});

context("createTab command", () => {
  let tabCreated;
  let requestStub;

  setup(async () => {
    stub(chrome.tabs, "create", (args) => {
      tabCreated = args;
    });
    requestStub = {
      registryEntry: new RegistryEntry({ options: {} }),
      tab: {},
      count: 1,
    };
    await Settings.load();
  });

  should("open the provided URL", async () => {
    requestStub.url = "https://example.com";
    await BackgroundCommands.createTab(requestStub);
    assert.equal("https://example.com", tabCreated.url);
  });

  should("open the vimium new tab page", async () => {
    await Settings.set("newTabDestination", Settings.newTabDestinations.vimiumNewTabPage);
    await BackgroundCommands.createTab(requestStub);
    assert.equal(Settings.vimiumNewTabPageUrl, tabCreated.url);
  });

  should("open the browser's new tab page", async () => {
    await Settings.set("newTabDestination", Settings.newTabDestinations.browserNewTabPage);
    await BackgroundCommands.createTab(requestStub);
    // The URL argument to chrome.tabs.create is omitted when we want to use the browser's NTP.
    assert.isTrue(tabCreated != null);
    assert.equal(undefined, tabCreated.url);
  });

  should("open custom URL", async () => {
    await Settings.set("newTabDestination", Settings.newTabDestinations.customUrl);
    await BackgroundCommands.createTab(requestStub);
    // If a specific custom URL isn't provided, the browser's new tab page will be used.
    // The URL argument to chrome.tabs.create is omitted when we want to use the browser's NTP.
    assert.isTrue(tabCreated != null);
    assert.equal(undefined, tabCreated.url);

    await Settings.set("newTabCustomUrl", "http://example.com");
    await BackgroundCommands.createTab(requestStub);
    assert.equal("http://example.com", tabCreated.url);
  });

  teardown(() => {
    tabCreated = null;
    Settings.clear();
  });
});

context("Next zoom level", () => {
  // All these tests use the Chrome zoom levels, which are the default.
  should("Zoom in 0 times", async () => {
    const zoom = await nextZoomLevel(1.00, 0);
    assert.equal(1.00, zoom);
  });

  should("Zoom in 1", async () => {
    const zoom = await nextZoomLevel(1.00, 1);
    assert.equal(1.10, zoom);
  });

  should("Zoom out 1", async () => {
    const zoom = await nextZoomLevel(1.00, -1);
    assert.equal(0.90, zoom);
  });

  should("Zoom in 2", async () => {
    const zoom = await nextZoomLevel(1.00, 2);
    assert.equal(1.25, zoom);
  });

  should("Zoom out 2", async () => {
    const zoom = await nextZoomLevel(1.00, -2);
    assert.equal(0.80, zoom);
  });

  should("Zoom in from between values", async () => {
    const zoom = await nextZoomLevel(1.05, 1);
    assert.equal(1.10, zoom);
  });

  should("Zoom out from between values", async () => {
    const zoom = await nextZoomLevel(1.05, -1);
    assert.equal(1.00, zoom);
  });

  should("Zoom in past the maximum", async () => {
    const zoom = await nextZoomLevel(1.00, 15);
    assert.equal(5.00, zoom);
  });

  should("Zoom out past the minimum", async () => {
    const zoom = await nextZoomLevel(1.00, -15);
    assert.equal(0.25, zoom);
  });

  should("Zoom in from below the minimum", async () => {
    const lowZoom = 0.01; // Lowest non-broken Chrome zoom level
    const zoom = await nextZoomLevel(lowZoom, 1);
    assert.equal(0.25, zoom);
  });

  should("Zoom out from above the maximum", async () => {
    const highZoom = 9.99; // highest non-broken Chrome zoom level
    const zoom = await nextZoomLevel(highZoom, -1);
    assert.equal(5.00, zoom);
  });

  should("Zoom in from above the maximum", async () => {
    const highZoom = 9.99; // highest non-broken Chrome zoom level
    const zoom = await nextZoomLevel(highZoom, 1);
    assert.equal(5.00, zoom);
  });

  should("Zoom out from below the minimum", async () => {
    const lowZoom = 0.01; // lowest non-broken Chrome zoom level
    const zoom = await nextZoomLevel(lowZoom, -1);
    assert.equal(0.25, zoom);
  });

  should("Test Chrome 33% zoom in with float error", async () => {
    const floatZoom = 0.32999999999999996; // The value chrome actually gives for 33%.
    const zoom = await nextZoomLevel(floatZoom, 1);
    assert.equal(0.50, zoom);
  });

  should("Test Chrome 175% zoom in with float error", async () => {
    const floatZoom = 1.7499999999999998; // The value chrome actually gives for 175%.
    const zoom = await nextZoomLevel(floatZoom, 1);
    assert.equal(2.00, zoom);
  });
});

context("Selecting frames", () => {
  should("nextFrame", async () => {
    const focusedFrames = [];
    stub(chrome.webNavigation, "getAllFrames", () => [{ frameId: 1 }, { frameId: 2 }]);
    stub(
      chrome.tabs,
      "sendMessage",
      withPromise((_tabId, message, options) => {
        if (message.handler == "getFocusStatus") {
          return { focused: options.frameId == 2, focusable: true };
        } else if (message.handler == "focusFrame") {
          focusedFrames.push(options.frameId);
        }
      }),
    );

    await BackgroundCommands.nextFrame(1, 0);
    assert.equal([1], focusedFrames);
  });
});

context("majorVersionHasIncreased", () => {
  should("return whether the major version has changed", () => {
    assert.equal(false, majorVersionHasIncreased(null));
    shoulda.stub(Utils, "getCurrentVersion", () => "2.0.1");
    assert.equal(false, majorVersionHasIncreased("2.0.0"));
    shoulda.stub(Utils, "getCurrentVersion", () => "2.1.0");
    assert.equal(true, majorVersionHasIncreased("2.0.0"));
  });
});
