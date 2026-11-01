export async function resumeWorkerDebugger(browser, extensionId) {
  const target = await browser.waitForTarget((target) =>
    target.type() === "service_worker" &&
    target.url().startsWith(`chrome-extension://${extensionId}/`)
  );
  const worker = await target.worker();
  // A debugging session can pause a restarted worker before its message handlers run.
  await worker.client.send("Runtime.runIfWaitingForDebugger");
}

export async function stopWorker(page, extensionId, errors) {
  const session = await page.createCDPSession();
  session.on(
    "ServiceWorker.workerErrorReported",
    ({ errorMessage }) =>
      errors.push(`Worker ${errorMessage.sourceURL}: ${errorMessage.errorMessage}`),
  );
  const versions = new Map();
  const waiters = new Set();
  session.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
    for (const check of waiters) check();
  });
  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Service worker lifecycle event timed out"));
      }, 30000);
      const check = () => {
        const version = [...versions.values()].find(predicate);
        if (version) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(version);
        }
      };
      waiters.add(check);
      check();
    });
  try {
    await session.send("ServiceWorker.enable");
    const version = await waitFor((version) =>
      version.scriptURL.startsWith(`chrome-extension://${extensionId}/`) &&
      version.runningStatus === "running"
    );
    const stopped = waitFor((candidate) =>
      candidate.versionId === version.versionId && candidate.runningStatus === "stopped"
    );
    await session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
    await stopped;
    return session;
  } catch (error) {
    await session.detach();
    throw error;
  }
}
