import assert from "node:assert/strict";
import vm from "node:vm";

const source = await Deno.readTextFile(new URL("../bridge/remote_backend.js", import.meta.url));
function event() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    emit(value) {
      for (const fn of listeners) fn(value);
    },
  };
}
function fixture(fingerprint = "current") {
  const ports = [];
  const notices = [];
  const hintMessages = [];
  const Backend = {};
  const chrome = {
    runtime: {
      connect() {
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          disconnect() {},
          postMessage() {},
        };
        ports.push(port);
        queueMicrotask(() =>
          port.onMessage.emit({
            type: "attached",
            protocol: 1,
            version: "2.4.2",
            fingerprint,
            storage: { sync: {}, session: { normalModeKeyStateMapping: {}, mapKeyRegistry: {} } },
          })
        );
        return port;
      },
      sendMessage(_id, message) {
        return Promise.resolve(
          message.handler === "runBackgroundCommand"
            ? { error: "No tab to restore." }
            : "chrome-extension://" + "b".repeat(32) + "/page.html",
        );
      },
    },
  };
  const init = vm.runInNewContext(source + "\ninitRemoteBackend;", {
    Backend,
    chrome,
    structuredClone,
    URL,
    setTimeout,
    document: { addEventListener() {} },
    addEventListener() {},
    HUD: {
      show(message) {
        notices.push(message);
      },
    },
    HintCoordinator: {
      willHandleMessage() {
        return true;
      },
      updateKeyState(message) {
        hintMessages.push(message.hintKeystrokeQueue);
      },
    },
  });
  const remote = init({
    vimiumId: "a".repeat(32),
    fingerprint: "current",
    onError(error) {
      notices.push(error.message);
    },
  });
  return { remote, Backend, ports, notices, hintMessages, chrome };
}

Deno.test("reject stale embedded code before configuring the core", async () => {
  const { remote } = fixture("old");
  await assert.rejects(remote.attach(), (error) => {
    assert.equal(error.message, "This reader's integration needs an update.");
    assert.equal(error.code, "CORE_MISMATCH");
    return true;
  });
});

Deno.test("storage reads omit absent keys and preserve caller defaults", async () => {
  const { remote, Backend } = fixture();
  await remote.attach();
  remote.configureBackend();
  assert.equal(Object.hasOwn(await Backend.storage.session.get("missing"), "missing"), false);
  assert.equal((await Backend.storage.session.get({ missing: "default" })).missing, "default");
});

Deno.test("command errors and unhandled broadcasts preserve keyboard availability", async () => {
  const { remote, Backend, notices } = fixture();
  await remote.attach();
  remote.configureBackend();
  await Backend.runtime.sendMessage({
    handler: "sendMessageToFrames",
    message: { handler: "userIsInteractingWithThePage" },
  });
  await Backend.runtime.sendMessage({
    handler: "runBackgroundCommand",
    registryEntry: { command: "restoreTab" },
  });
  assert.equal(Backend.isAlive(), true);
  assert.deepEqual(notices, ["No tab to restore."]);
});

Deno.test("idle disconnect waits for a remote call before restarting the worker", async () => {
  const { remote, Backend, ports } = fixture();
  await remote.attach();
  remote.configureBackend();
  ports[0].onDisconnect.emit();
  await Promise.resolve();
  assert.equal(ports.length, 1);
  assert.equal(Backend.isAlive(), true);
  assert.equal(
    await Backend.runtime.sendMessage({ handler: "getCurrentTabUrl" }),
    "chrome-extension://" + "b".repeat(32) + "/page.html",
  );
  assert.equal(ports.length, 2);
});

Deno.test("local messages snapshot mutable hint queues before asynchronous dispatch", async () => {
  const { remote, Backend, hintMessages } = fixture();
  await remote.attach();
  remote.configureBackend();
  const queue = ["s"];
  const first = Backend.runtime.sendMessage({
    handler: "broadcastLinkHintsMessage",
    messageType: "updateKeyState",
    hintKeystrokeQueue: queue,
  });
  queue.push("a");
  const second = Backend.runtime.sendMessage({
    handler: "broadcastLinkHintsMessage",
    messageType: "updateKeyState",
    hintKeystrokeQueue: queue,
  });
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(hintMessages, [["s"], ["s", "a"]]);
});

Deno.test("a browser lifecycle disconnect remains recoverable", async () => {
  const { remote, Backend, ports, chrome, notices } = fixture();
  await remote.attach();
  remote.configureBackend();
  chrome.runtime.lastError = {
    message:
      "The page keeping the extension port is moved into back/forward cache, so the message channel is closed.",
  };
  ports[0].onDisconnect.emit();
  delete chrome.runtime.lastError;
  assert.equal(Backend.isAlive(), true);
  assert.equal(
    await Backend.runtime.sendMessage({ handler: "getCurrentTabUrl" }),
    "chrome-extension://" + "b".repeat(32) + "/page.html",
  );
  assert.equal(ports.length, 2);
  assert.deepEqual(notices, []);
});
