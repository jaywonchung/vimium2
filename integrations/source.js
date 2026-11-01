import * as path from "node:path";
import { unzipSync } from "fflate";

export function unpackCrx(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "Cr24" ||
    view.getUint32(4, true) !== 3
  ) throw new Error("Expected a CRX3 extension package.");
  const offset = 12 + view.getUint32(8, true);
  if (offset >= bytes.length) throw new Error("Invalid CRX3 header length.");
  const files = unzipSync(bytes.subarray(offset));
  for (const filename of Object.keys(files)) {
    if (
      filename.startsWith("/") || filename.includes("\\") ||
      filename.includes(":") ||
      filename.split("/").includes("..")
    ) throw new Error(`Unsafe archive path: ${filename}`);
  }
  if (!files["manifest.json"]) {
    throw new Error("Package does not contain manifest.json.");
  }
  return files;
}

export async function prepareSource(
  { source, crx, chromeVersion, profile, directory },
) {
  if (source !== undefined && crx !== undefined) {
    throw new Error(
      "Specify either --source DIR or --crx FILE, not both.",
    );
  }
  if (source !== undefined) {
    if (!source) throw new Error("--source requires a directory.");
    return path.resolve(source);
  }
  let bytes;
  if (crx !== undefined) {
    if (!crx) throw new Error("--crx requires a package file.");
    bytes = await Deno.readFile(crx);
  } else {
    if (!/^[a-p]{32}$/.test(profile.extensionId ?? "")) {
      throw new Error(
        "This integration has no Chrome Web Store extension ID. Supply --source DIR or --crx FILE.",
      );
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(chromeVersion ?? "")) {
      throw new Error(
        "Downloading requires --chrome-version, as shown in chrome://version.",
      );
    }
    const url = new URL("https://clients2.google.com/service/update2/crx");
    url.search = new URLSearchParams({
      response: "redirect",
      prodversion: chromeVersion,
      acceptformat: "crx3",
      x: `id=${profile.extensionId}&uc`,
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Extension download failed: HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const files = unpackCrx(bytes);
  for (const [filename, data] of Object.entries(files)) {
    if (filename.endsWith("/")) continue;
    const destination = path.join(directory, filename);
    await Deno.mkdir(path.dirname(destination), { recursive: true });
    await Deno.writeFile(destination, data);
  }
  return directory;
}
