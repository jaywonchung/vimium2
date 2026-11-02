# Contributing to Vimium2

Report bugs and propose changes in [Vimium2's issue tracker](https://github.com/jaywonchung/vimium2/issues).
For bugs inside patched extensions, include the extension name and version, patching command, and steps to reproduce.

## Development

Follow the [setup instructions](README.md#using-vimium2) to build and load Vimium2.
Keep support for other extensions generic; put extension-specific behavior in its [integration directory](integrations/).

## Checks

Run the checks relevant to your change and describe what you tested in your pull request.
Tests use [shoulda.js](https://github.com/philc/shoulda.js) and [Puppeteer](https://github.com/puppeteer/puppeteer).
Browser tests require Chrome for Testing, which you can install with `deno run -A puppeteer browsers install chrome`.

```sh
deno task test:unit
deno task test:dom
deno task test:patcher
deno task build
deno task test:bridge-browser
```

To test the PDF integrations end to end, run:

```sh
deno task test:e2e --target google-scholar-pdf-reader --chrome-version CHROME_VERSION
deno task test:e2e --target pdfjs-pdf-viewer --chrome-version CHROME_VERSION
```

Replace `CHROME_VERSION` with the full Chrome version from `chrome://version`.
These tests download and patch the target extensions in temporary directories.

Run `deno fmt --check` and `deno lint` on the files you changed.
