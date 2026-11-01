import { parseArgs } from "node:util";
import * as path from "node:path";
import { prepareSource } from "./source.js";
import { loadIntegration, patchExtension, projectRoot } from "../patcher/patch.js";

const { values, positionals } = parseArgs({
  args: Deno.args,
  allowPositionals: true,
  options: {
    source: { type: "string" },
    crx: { type: "string" },
    "chrome-version": { type: "string" },
    "vimium-id": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(
    "Usage: deno task patch INTEGRATION_DIR --vimium-id ID [--output DIR]",
  );
  console.log(
    "  Downloads from the Chrome Web Store by default; supply --chrome-version VERSION.",
  );
  console.log("  --source DIR or --crx FILE uses a local copy instead of downloading.");
} else {
  const [directory] = positionals;
  if (positionals.length !== 1) {
    throw new Error("Specify an integration directory containing integration.js.");
  }
  if (!/^[a-p]{32}$/.test(values["vimium-id"] ?? "")) {
    throw new Error("A valid --vimium-id is required.");
  }
  const profile = await loadIntegration(directory);
  const temp = await Deno.makeTempDir({ prefix: "vimium2-source-" });
  try {
    const source = await prepareSource({
      ...values,
      chromeVersion: values["chrome-version"],
      profile,
      directory: temp,
    });
    const result = await patchExtension({
      profile,
      source,
      vimiumId: values["vimium-id"],
      output: values.output ??
        path.join(projectRoot, "dist", "patched", path.basename(path.resolve(directory))),
    });
    console.log(`Patched ${result.name} ${result.version}: ${result.output}`);
    console.log(
      "In chrome://extensions, disable the original extension and load this directory unpacked.",
    );
    console.log(
      "Add the patched extension's ID to Allowed bridge extensions in Vimium2 options.",
    );
    console.log("Reload the extension page after saving the setting.");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}
