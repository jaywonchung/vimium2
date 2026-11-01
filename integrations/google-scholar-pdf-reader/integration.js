export default {
  name: "Google Scholar PDF Reader",
  extensionId: "dahenjhkoodjbpjheillcadbppiidmhp",
  serviceWorker: "background-compiled.js",
  pages: [{
    html: "reader.html",
    scrollContainer: ".gsr-body",
    navigateInTab: true,
    pageUrlProvider: new URL("./page.js", import.meta.url),
  }],
};
