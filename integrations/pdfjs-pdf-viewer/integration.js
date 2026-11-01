export default {
  name: "PDF.js PDF Viewer",
  extensionId: "oemmndcbldboiebfnladdacbdfmadadm",
  serviceWorker: "background.js",
  pages: [{
    html: "content/web/viewer.html",
    scrollContainer: "#viewerContainer",
    navigateInTab: true,
    pageUrlProvider: new URL("./page.js", import.meta.url),
  }],
};
