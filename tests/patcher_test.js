import assert from "node:assert/strict";
import * as path from "node:path";
import { zipSync } from "fflate";
import { exists, loadIntegration, patchExtension, projectRoot } from "../patcher/patch.js";
import { unpackCrx } from "../integrations/source.js";

const vimiumId = "a".repeat(32);
const targets = ["google-scholar-pdf-reader", "pdfjs-pdf-viewer"];
const genericProfile = { name: "Fixture extension", pages: [{ html: "page.html" }] };

async function fixture(profile, run) {
  const temp = await Deno.makeTempDir({ prefix: "vimium2-patcher-test-" });
  const source = path.join(temp, "source");
  const output = path.join(temp, "output");
  const manifest = {
    manifest_version: 3,
    name: profile.name,
    version: "1.0.0",
    key: "original-key",
    update_url: "https://example.com/update",
    permissions: ["storage"],
    content_security_policy: {
      extension_pages: "script-src 'self'; frame-src 'self'",
    },
  };
  if (profile.serviceWorker !== undefined) {
    manifest.background = { service_worker: profile.serviceWorker };
  }
  await Deno.mkdir(path.dirname(path.join(source, profile.pages[0].html)), {
    recursive: true,
  });
  const manifestText = JSON.stringify(manifest);
  await Deno.writeTextFile(path.join(source, "manifest.json"), manifestText);
  await Deno.writeTextFile(
    path.join(source, profile.pages[0].html),
    "<!doctype html><html><head></head><body>Extension page</body></html>",
  );
  if (profile.serviceWorker !== undefined) {
    await Deno.writeTextFile(
      path.join(source, profile.serviceWorker),
      "// Test fixture.\n",
    );
  }
  await Deno.mkdir(path.join(source, "_metadata"));
  await Deno.writeTextFile(
    path.join(source, "_metadata", "verified_contents.json"),
    "{}",
  );
  try {
    await run({ source, output, profile, manifest, manifestText });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}

for (const target of targets) {
  const profile = await loadIntegration(path.join(projectRoot, "integrations", target));
  Deno.test(`${target}: patch an MV3 copy without changing source or script permissions`, () =>
    fixture(profile, async ({ source, output, profile, manifestText }) => {
      await patchExtension({ profile, source, output, vimiumId });
      assert.equal(
        await Deno.readTextFile(path.join(source, "manifest.json")),
        manifestText,
      );
      assert.equal(await exists(path.join(source, "vimium2")), false);
      const manifest = JSON.parse(
        await Deno.readTextFile(path.join(output, "manifest.json")),
      );
      assert.equal(manifest.key, undefined);
      assert.equal(manifest.update_url, undefined);
      assert.deepEqual(manifest.permissions, ["storage"]);
      assert.equal(
        manifest.content_security_policy.extension_pages,
        `script-src 'self'; frame-src 'self' chrome-extension://${vimiumId}`,
      );
      assert.equal(await exists(path.join(output, "_metadata")), false);
      const html = await Deno.readTextFile(path.join(output, profile.pages[0].html));
      assert(html.includes('src="/vimium2/bridge-0.js"'));
      assert(html.includes(`data-vimium-id="${vimiumId}"`));
      assert.equal(
        await Deno.readTextFile(path.join(output, "vimium2", "LICENSE")),
        await Deno.readTextFile(path.join(projectRoot, "LICENSE")),
      );
      await assert.rejects(
        () => patchExtension({ profile, source, output, vimiumId }),
        /already exists/,
      );
      await assert.rejects(() =>
        patchExtension({
          profile,
          source: output,
          output: output + "-again",
          vimiumId,
        }), /already patched/);
      await Deno.remove(path.join(output, "vimium2"), { recursive: true });
      await assert.rejects(() =>
        patchExtension({
          profile,
          source: output,
          output: output + "-again",
          vimiumId,
        }), /already patched/);
    }));
}

Deno.test("reject nested output before creating directories in the source", () =>
  fixture(genericProfile, async ({ source, profile }) => {
    const output = path.join(source, "new-parent", "output");
    await assert.rejects(
      () => patchExtension({ profile, source, output, vimiumId }),
      /outside the source/,
    );
    assert.equal(await exists(path.dirname(output)), false);
  }));

Deno.test("patch read-only package files without changing source permissions", () =>
  fixture(genericProfile, async ({ source, output, profile }) => {
    const html = path.join(source, profile.pages[0].html);
    await Deno.chmod(html, 0o444);
    await patchExtension({ profile, source, output, vimiumId });
    assert.equal((await Deno.stat(html)).mode & 0o777, 0o444);
    assert(
      (await Deno.readTextFile(path.join(output, profile.pages[0].html))).includes(
        "/vimium2/bridge-0.js",
      ),
    );
  }));

Deno.test("reject changed target layouts before creating output", () =>
  fixture(
    { ...genericProfile, serviceWorker: "background.js" },
    async ({ source, profile, output, manifest }) => {
      manifest.background.service_worker = "unknown.js";
      await Deno.writeTextFile(
        path.join(source, "manifest.json"),
        JSON.stringify(manifest),
      );
      await assert.rejects(
        () => patchExtension({ profile, source, output, vimiumId }),
        /needs review/,
      );
      assert.equal(await exists(output), false);
    },
  ));

Deno.test("reject symbolic links in source packages", () =>
  fixture(genericProfile, async ({ source, profile, output }) => {
    await Deno.symlink(
      path.join(source, "manifest.json"),
      path.join(source, "linked.json"),
    );
    await assert.rejects(
      () => patchExtension({ profile, source, output, vimiumId }),
      /symbolic link/,
    );
    assert.equal(await exists(output), false);
  }));

Deno.test("patch a directory integration offline from unpacked files or a CRX package", () =>
  fixture(genericProfile, async ({ source, output, profile, manifestText }) => {
    const directory = path.join(path.dirname(source), "custom integration");
    await Deno.mkdir(directory);
    await Deno.writeTextFile(
      path.join(directory, "integration.js"),
      `export default ${JSON.stringify({ pages: [{ html: profile.pages[0].html }] })};\n`,
    );
    const crx = path.join(path.dirname(source), "extension.crx");
    const archive = {};
    for (const filename of ["manifest.json", profile.pages[0].html]) {
      archive[filename] = await Deno.readFile(path.join(source, filename));
    }
    await Deno.writeFile(crx, makeCrx(archive));
    for (const [option, input] of [["--source", source], ["--crx", crx]]) {
      const destination = output + option;
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "-A",
          "--deny-net",
          path.join(projectRoot, "integrations/patch.js"),
          directory,
          "--vimium-id",
          vimiumId,
          option,
          input,
          "--output",
          destination,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      const manifest = JSON.parse(await Deno.readTextFile(path.join(destination, "manifest.json")));
      assert.equal(manifest.name, profile.name + " (Vimium2)");
      assert((await Deno.readTextFile(path.join(destination, profile.pages[0].html)))
        .includes("/vimium2/bridge-0.js"));
    }
    assert.equal(await Deno.readTextFile(path.join(source, "manifest.json")), manifestText);
  }));

function makeCrx(files) {
  const zip = zipSync(files);
  const crx = new Uint8Array(12 + zip.length);
  crx.set(new TextEncoder().encode("Cr24"));
  new DataView(crx.buffer).setUint32(4, 3, true);
  crx.set(zip, 12);
  return crx;
}

Deno.test("reject CRX archive traversal and malformed headers", () => {
  const crx = makeCrx({
    "manifest.json": new TextEncoder().encode("{}"),
    "../outside": new Uint8Array(),
  });
  assert.throws(() => unpackCrx(crx), /Unsafe archive path/);
  assert.throws(() => unpackCrx(new Uint8Array()), /Expected a CRX3/);
});
