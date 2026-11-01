import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";
import JSON5 from "json5";
import { zipSync } from "fflate";
import { bridgeFingerprint } from "../bridge/build.js";

async function collect(directory, archive, prefix = "") {
  const entries = Array.from(Deno.readDirSync(directory)).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory) {
      await collect(path.join(directory, entry.name), archive, name + "/");
    } else {
      archive[name] = [
        await Deno.readFile(path.join(directory, entry.name)),
        // A fixed timestamp keeps builds independent of source file modification times.
        { mtime: new Date("2026-01-01T00:00:00Z") },
      ];
    }
  }
}

async function removeGenerated(directory) {
  try {
    await Deno.remove(directory, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist", "vimium2");
const manifest = JSON5.parse(
  await Deno.readTextFile(path.join(root, "manifest.json")),
);
const manifestPaths = new Set([
  ...Object.values(manifest.icons),
  manifest.background.service_worker,
  manifest.options_ui.page,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
  ...manifest.web_accessible_resources.flatMap(({ resources }) => resources)
    .filter((resource) => !resource.includes("*")),
]);
const files = [
  "background_scripts",
  "core",
  "local_backend.js",
  "pages",
  "icons",
  "resources",
  "LICENSE",
];
await Deno.mkdir(path.join(root, "dist"), { recursive: true });
const stage = await Deno.makeTempDir({
  dir: path.join(root, "dist"),
  prefix: ".build-",
});
try {
  for (const file of files) {
    await cp(path.join(root, file), path.join(stage, file), {
      recursive: true,
    });
  }
  for (const file of manifestPaths) {
    if (!(await Deno.stat(path.join(stage, file))).isFile) {
      throw new Error(`Manifest resource is not a file: ${file}`);
    }
  }
  await Deno.writeTextFile(
    path.join(stage, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const archive = {};
  await Deno.writeTextFile(
    path.join(stage, "bridge.json"),
    JSON.stringify({ fingerprint: await bridgeFingerprint() }) + "\n",
  );
  await collect(stage, archive);
  const zip = zipSync(archive);
  await removeGenerated(output);
  await Deno.rename(stage, output);
  await Deno.writeFile(path.join(root, "dist", "vimium2.zip"), zip);
  console.log(`Built ${output} and dist/vimium2.zip`);
} finally {
  await removeGenerated(stage);
}
