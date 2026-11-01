import "./test_helper.js";
import { withPromise } from "./test_helper.js";
import "../../core/lib/settings.js";
import "../../background_scripts/main.js";
import { RegistryEntry } from "../../background_scripts/commands.js";

function sendBackgroundMessage(request, sender, event = chrome.runtime.onMessage) {
  assert.equal(1, event.listeners.length);
  const { promise, resolve, reject } = Promise.withResolvers();
  // Stubbed handlers require no I/O; fail missing responses after one second.
  const timer = setTimeout(() => reject(new Error("Background message did not respond.")), 1000);
  try {
    assert.isTrue(event.listeners[0](request, sender, resolve));
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  return promise.finally(() => clearTimeout(timer));
}

context("Background message dispatch", () => {
  const sender = { tab: { id: 7, url: "https://example.com/" }, frameId: 0 };

  should("leave unrelated messages for other listeners", () => {
    assert.equal(1, chrome.runtime.onMessage.listeners.length);
    const [listener] = chrome.runtime.onMessage.listeners;
    for (const request of [null, {}, { handler: "unknown" }, { handler: "toString" }]) {
      assert.isFalse(listener(request, sender, () => assert.fail("Unexpected response")));
    }
  });

  should("use Chrome's sender to read and navigate the current tab", async () => {
    const forged = { tab: { id: 99, url: "https://other.example/" }, tabId: 99 };
    assert.equal(
      sender.tab.url,
      await sendBackgroundMessage({
        handler: "getCurrentTabUrl",
        ...forged,
      }, sender),
    );
    const updates = [];
    stub(chrome.tabs, "update", (id, options) => updates.push({ id, ...options }));
    const url = "https://destination.example/";
    await sendBackgroundMessage({ handler: "openUrlInCurrentTab", url, ...forged }, sender);
    assert.equal([{ id: 7, url }], updates);
  });

  should("wait for settings and report loading failures before running commands", async () => {
    const loaded = Promise.withResolvers();
    const queries = [];
    stub(Settings, "onLoaded", () => loaded.promise);
    stub(chrome.search, "query", (query) => queries.push(query));
    const request = { handler: "launchSearchQuery", query: "example", openInNewTab: false };
    const response = sendBackgroundMessage(request, sender);
    await Promise.resolve();
    const callsBeforeLoaded = queries.length;
    loaded.resolve();
    await response;
    assert.equal(0, callsBeforeLoaded);
    assert.equal([{ disposition: "CURRENT_TAB", text: "example" }], queries);

    stub(Settings, "onLoaded", () => Promise.reject(new Error("Settings failed to load.")));
    assert.equal(
      { error: "Settings failed to load." },
      await sendBackgroundMessage(request, sender),
    );
    assert.equal(1, queries.length);
  });

  should("preserve default, explicit, and null counts when closing tabs", async () => {
    stub(chrome.tabs, "query", withPromise(() => [sender.tab, { id: 8 }, { id: 9 }, { id: 10 }]));
    const removed = [];
    stub(chrome.tabs, "remove", withPromise((ids) => removed.push(ids)));
    for (const count of [undefined, 2, null]) {
      await sendBackgroundMessage({
        handler: "runBackgroundCommand",
        registryEntry: { command: "closeTabsOnRight" },
        count,
      }, sender);
    }
    assert.equal([[8], [8, 9], [8, 9, 10]], removed);
  });

  should("ignore page commands without a sender tab", async () => {
    const updates = [];
    stub(chrome.tabs, "update", (...args) => updates.push(args));
    assert.equal(
      undefined,
      await sendBackgroundMessage({
        handler: "openUrlInCurrentTab",
        url: "https://destination.example/",
        tabId: 99,
      }, {}),
    );
    assert.equal([], updates);
  });

  should("reply when a browser operation throws or rejects", async () => {
    for (
      const query of [
        () => {
          throw new Error("Browser operation failed.");
        },
        () => Promise.reject(new Error("Browser operation failed.")),
      ]
    ) {
      stub(chrome.tabs, "query", query);
      assert.equal(
        { error: "Browser operation failed." },
        await sendBackgroundMessage({
          handler: "runBackgroundCommand",
          registryEntry: { command: "closeTabsOnRight" },
        }, sender),
      );
    }
  });
});

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
        { ...sender, tab: undefined },
      ]
    ) {
      assert.equal(
        {
          error: "Add this reader's ID to Allowed bridge extensions in Vimium2 options.",
        },
        await send({ handler: "openUrlInCurrentTab", url: "https://destination.example/" }, source),
      );
    }
    assert.equal([], updates);
  });

  should(
    "wait for URL validation and reject excessive tab creation before running the command",
    async () => {
      const started = Promise.withResolvers();
      const checked = Promise.withResolvers();
      let calls = 0;
      stub(UrlUtils, "isUrl", () => {
        started.resolve();
        return checked.promise;
      });
      stub(BackgroundCommands, "createTab", () => calls++);
      const response = send({
        handler: "runBackgroundCommand",
        count: 51,
        registryEntry: {
          command: "createTab",
          options: { "https://one.example/": true, "https://two.example/": true },
        },
      });
      await started.promise;
      const callsWhileChecking = calls;
      checked.resolve(true);
      assert.equal({ error: "Reader requests can create at most 100 tabs." }, await response);
      assert.equal(0, callsWhileChecking);
      assert.equal(0, calls);
    },
  );

  should(
    "derive the target tab from Chrome and reject JavaScript despite caller permission",
    async () => {
      const updates = [];
      const scripts = [];
      stub(chrome.tabs, "update", (id, options) => updates.push({ id, ...options }));
      stub(chrome.scripting, "executeScript", (options) => scripts.push(options));
      const request = {
        handler: "openUrlInCurrentTab",
        url: "https://destination.example/",
        tab: { id: 99 },
        tabId: 99,
        allowJavascript: true,
      };
      assert.equal(null, await send(request));
      assert.equal([{ id: 7, url: request.url }], updates);
      assert.equal(
        { error: "Reader extensions cannot execute javascript URLs." },
        await send({
          ...request,
          url: "javascript:document.title='unexpected'",
        }),
      );
      assert.equal([], scripts);
    },
  );

  should("return the page URL while withholding browser-command results", async () => {
    assert.equal(sender.url, await send({ handler: "getCurrentTabUrl" }));
    stub(BackgroundCommands, "createTab", () => ({ privateValue: "private" }));
    assert.equal(
      null,
      await send({
        handler: "runBackgroundCommand",
        url: "https://destination.example/",
        registryEntry: { command: "createTab", options: {} },
      }),
    );
    assert.equal({ error: "Unsupported bridge message." }, await send({ handler: "toString" }));
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
