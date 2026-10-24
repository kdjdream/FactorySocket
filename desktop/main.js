const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

app.setName("KIMS Smart Factory");
app.setPath("userData", path.join(app.getPath("appData"), "KIMS Smart Factory"));

const preload = path.join(__dirname, "preload.js");
const webPreferences = { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false };

function serverAddress(args) {
  const index = args.indexOf("--url");
  const url = new URL(index === -1 ? "http://localhost:8080" : args[index + 1]);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) server URL without embedded credentials.");
  }
  return url;
}

app.whenReady().then(async () => {
  let address;
  try {
    address = serverAddress(process.argv);
  } catch (error) {
    dialog.showErrorBox("Invalid server address", error.message);
    app.quit();
    return;
  }
  const main = new BrowserWindow({ width: 1280, height: 900, webPreferences });
  const children = new Set();
  const session = main.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  main.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== address.origin) event.preventDefault();
  });
  main.webContents.on("will-redirect", (event, url) => {
    if (new URL(url).origin !== address.origin) event.preventDefault();
  });
  main.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== "about:blank" || !frameName.startsWith("factory-channel-")
      || new URL(main.webContents.getURL()).pathname !== "/user_customization.html") {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 640, height: 508, minWidth: 240, minHeight: 180,
        frame: false, transparent: false, resizable: true,
        minimizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true, webPreferences
      }
    };
  });
  main.webContents.on("did-create-window", child => {
    children.add(child);
    child.setMenu(null);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", event => event.preventDefault());
    child.webContents.on("will-redirect", event => event.preventDefault());
    child.on("closed", () => children.delete(child));
  });
  main.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) for (const child of children) child.close();
  });
  main.on("closed", () => {
    for (const child of children) child.close();
  });
  main.setMenu(null);
  try {
    await main.loadURL(address.href);
  } catch (error) {
    dialog.showErrorBox("Server connection failed", `${address.origin}\n${error.message}`);
    main.close();
  }
});

app.on("window-all-closed", () => app.quit());
