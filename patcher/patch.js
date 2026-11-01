import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cp } from "node:fs/promises";
import { buildBridge } from "../bridge/build.js";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function loadIntegration(directory) {
  const filename = path.join(await Deno.realPath(directory), "integration.js");
  const { default: profile } = await import(pathToFileURL(filename).href);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`${filename} must export an integration configuration as its default export.`);
  }
  return profile;
}

export async function exists(filename) {
  try {
    await Deno.lstat(filename);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function resolveDestination(filename) {
  if (await exists(filename)) return await Deno.realPath(filename);
  return path.join(
    await resolveDestination(path.dirname(filename)),
    path.basename(filename),
  );
}

function addFrameOrigin(policy, origin) {
  const directives = new Map(
    policy.split(";").filter((s) => s.trim()).map((s) => {
      const [key, ...values] = s.trim().split(/\s+/);
      return [key, values];
    }),
  );
  const sources = directives.get("frame-src") ?? directives.get("child-src") ??
    directives.get("default-src");
  if (sources) {
    directives.set("frame-src", [
      ...new Set([...sources.filter((s) => s !== "'none'"), origin]),
    ]);
  }
  return [...directives].map(([key, values]) => [key, ...values].join(" "))
    .join("; ");
}

async function validateTree(directory, root = directory) {
  for await (const entry of Deno.readDir(directory)) {
    if (directory === root && [".git", "_metadata"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isSymlink) {
      throw new Error(`Source contains a symbolic link: ${filename}`);
    }
    if (entry.isDirectory) await validateTree(filename, root);
  }
}

export async function patchExtension({ profile, source, output, vimiumId }) {
  if (!/^[a-p]{32}$/.test(vimiumId ?? "")) {
    throw new Error("A valid --vimium-id is required.");
  }
  source = await Deno.realPath(source);
  output = path.resolve(output);
  if (await exists(output)) {
    throw new Error(
      `Output already exists: ${output}. Rerun with --output pointing to a directory that does not exist.`,
    );
  }
  output = await resolveDestination(output);
  const relative = path.relative(source, output);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  ) {
    throw new Error("Output must be outside the source directory.");
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(path.join(source, "manifest.json")),
  );
  if (manifest.manifest_version !== 3) {
    throw new Error("Only Manifest V3 targets are supported.");
  }
  if (
    profile.serviceWorker !== undefined &&
    manifest.background?.service_worker !== profile.serviceWorker
  ) {
    throw new Error(
      "Unexpected service worker. The integration profile needs review.",
    );
  }
  if (!Array.isArray(profile.pages) || profile.pages.length === 0) {
    throw new Error("The integration profile must specify at least one HTML page.");
  }
  if (await exists(path.join(source, "vimium2"))) {
    throw new Error(
      "Source is already patched. Use an original extension package.",
    );
  }
  await validateTree(source);
  const pages = [];
  for (const [index, page] of profile.pages.entries()) {
    if (
      typeof page.html !== "string" || !page.html || path.isAbsolute(page.html) ||
      page.html.split(/[\\/]/).includes("..") ||
      pages.some((entry) => path.normalize(entry.html) === path.normalize(page.html))
    ) throw new Error("HTML pages must have unique paths inside the extension.");
    const html = await Deno.readTextFile(path.join(source, page.html));
    if (!/<\/head\s*>/i.test(html)) throw new Error(`Missing </head> in ${page.html}`);
    if (html.includes("/vimium2/")) {
      throw new Error("Source is already patched. Use an original extension package.");
    }
    const bundlePath = `vimium2/bridge-${index}.js`;
    const attributes = {
      src: `/${bundlePath}`,
      "data-vimium-id": vimiumId,
    };
    if (page.scrollContainer !== undefined) {
      attributes["data-vimium-scroll-container"] = page.scrollContainer;
    }
    if (page.navigateInTab === true) attributes["data-vimium-navigate-in-tab"] = "true";
    const escapedAttributes = Object.entries(attributes).map(([key, value]) =>
      `${key}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`
    ).join(" ");
    const tag = `<script ${escapedAttributes} defer></script>`;
    const pageUrlProvider = page.pageUrlProvider === undefined
      ? undefined
      : await Deno.readTextFile(page.pageUrlProvider);
    pages.push({
      html: page.html,
      content: html.replace(/<\/head\s*>/i, (closingTag) => `${tag}\n${closingTag}`),
      bundlePath,
      bundle: await buildBridge({ pageUrlProvider }),
    });
  }
  let displayName = manifest.name;
  const localized = /^__MSG_(.+)__$/.exec(displayName);
  if (localized) {
    const messages = JSON.parse(
      await Deno.readTextFile(
        path.join(source, "_locales", manifest.default_locale, "messages.json"),
      ),
    );
    displayName = messages[localized[1]]?.message;
    if (!displayName) throw new Error("Missing localized extension name.");
  }
  manifest.name = `${displayName} (Vimium2)`;
  delete manifest.key;
  delete manifest.update_url;
  if (manifest.content_security_policy?.extension_pages) {
    manifest.content_security_policy.extension_pages = addFrameOrigin(
      manifest.content_security_policy.extension_pages,
      `chrome-extension://${vimiumId}`,
    );
  }
  await Deno.mkdir(path.dirname(output), { recursive: true });
  const stage = await Deno.makeTempDir({
    dir: path.dirname(output),
    prefix: ".vimium2-patch-",
  });
  try {
    await cp(source, stage, {
      recursive: true,
      filter: (filename) => ![".git", "_metadata"].includes(path.relative(source, filename)),
    });
    await Deno.mkdir(path.join(stage, "vimium2"));
    await Deno.copyFile(
      path.join(projectRoot, "LICENSE"),
      path.join(stage, "vimium2", "LICENSE"),
    );
    for (const page of pages) {
      await Deno.writeTextFile(path.join(stage, page.bundlePath), page.bundle);
      await Deno.chmod(path.join(stage, page.html), 0o644);
      await Deno.writeTextFile(path.join(stage, page.html), page.content);
    }
    await Deno.chmod(path.join(stage, "manifest.json"), 0o644);
    await Deno.writeTextFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (await exists(output)) {
      throw new Error(
        `Output appeared during patching: ${output}. Rerun with --output pointing to a directory that does not exist.`,
      );
    }
    await Deno.rename(stage, output);
  } catch (error) {
    await Deno.remove(stage, { recursive: true });
    throw error;
  }
  return { output, version: manifest.version, name: manifest.name };
}
