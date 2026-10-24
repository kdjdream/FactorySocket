const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const clientSource = fs.readFileSync(path.join(__dirname, "../public/user_customization.js"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "../desktop/main.js"), "utf8");

test("desktop preload exposes only the popup capability, not native APIs", () => {
  const exposed = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../desktop/preload.js"), "utf8"), {
    require: name => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (key, value) => exposed.push({ key, value }) } };
    }
  });
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].key, "factoryDesktop");
  assert.deepEqual(Object.keys(exposed[0].value), ["channelPopups"]);
  assert.equal(exposed[0].value.channelPopups, true);
  assert.equal(Object.isFrozen(exposed[0].value), true);
});

function clientFunction(name, globals) {
  const start = clientSource.indexOf(`function ${name}(`);
  const end = clientSource.indexOf("\nfunction ", start + 1);
  const context = vm.createContext(globals);
  vm.runInContext(clientSource.slice(start, end), context);
  return context[name];
}

test("every desktop channel uses a native popup, never the single-window PiP path", () => {
  const opened = [];
  const windows = new Map();
  const reserve = clientFunction("User_customizationReservePopup", {
    User_customizationPopupWindows: windows,
    window: {
      factoryDesktop: { channelPopups: true },
      documentPictureInPicture: { requestWindow() { assert.fail("PiP must not be used"); } },
      open(url, name, features) {
        const popup = { closed: false, document: { body: {} } };
        opened.push({ url, name, features, popup });
        return popup;
      }
    }
  });
  for (const type of ["switch", "lamp", "graph"]) {
    const key = JSON.stringify(["device", "OS1", type]);
    const reserved = reserve(key);
    assert.equal(reserved.created, true);
    windows.set(key, reserved.window);
    assert.equal(reserve(key).window, reserved.window);
    assert.equal(reserve(key).created, false);
  }
  assert.equal(opened.length, 3);
  assert.equal(new Set(opened.map(item => item.name)).size, 3);
  for (const item of opened) {
    assert.equal(item.url, "about:blank");
    assert.ok(item.name.startsWith("factory-channel-"));
    assert.match(item.features, /resizable=yes/);
  }
  const first = windows.values().next().value;
  first.closed = true;
  reserve(windows.keys().next().value);
  assert.equal(opened.length, 4);
});

test("desktop popup failure is returned to the existing save failure path", () => {
  const reserve = clientFunction("User_customizationReservePopup", {
    User_customizationPopupWindows: new Map(),
    window: { factoryDesktop: { channelPopups: true }, open: () => null }
  });
  assert.equal(reserve("channel"), null);
});

test("browser popup behavior is preserved without the desktop bridge", async () => {
  const pipWindow = {};
  const reserve = clientFunction("User_customizationReservePopup", {
    User_customizationPopupWindows: new Map(),
    window: { documentPictureInPicture: { requestWindow: () => Promise.resolve(pipWindow) } }
  });
  assert.equal(await reserve("channel").promise, pipWindow);
  let features;
  const fallback = clientFunction("User_customizationReservePopup", {
    User_customizationPopupWindows: new Map(),
    window: {
      documentPictureInPicture: { window: pipWindow },
      open(_url, _name, options) { features = options; return { document: { body: {} } }; }
    }
  });
  assert.ok(fallback("another").created);
  assert.match(features, /toolbar=no/);
});

function element(tag) {
  return {
    tag, children: [], attributes: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, callback) { this.listeners[type] = callback; }
  };
}

test("desktop titlebar has only a working close button and survives card replacement", () => {
  const source = {
    dataset: { deviceId: "device", pin: "OS1", displayType: "graph", channelName: "Temperature" },
    cloneNode: () => element("article")
  };
  const key = JSON.stringify(["device", "OS1", "graph"]);
  const popup = {
    closed: false,
    close() { this.closed = true; },
    document: { body: element("body"), createElement: element }
  };
  const windows = new Map([[key, popup]]);
  const globals = {
    window: { factoryDesktop: { channelPopups: true } },
    User_customizationPopupWindows: windows,
    User_customizationElements: { User_customizationGrid: { children: [source] } },
    User_customizationItemKey: channel => JSON.stringify([channel.device_id, channel.output_signal, channel.display_type]),
    User_customizationRenderedMarkup: "markup",
    User_customizationSaving: false
  };
  const sync = clientFunction("User_customizationSyncPopups", globals);
  sync();
  const [bar, card] = popup.document.body.children;
  assert.equal(card.tag, "article");
  assert.equal(bar.className, "simple-popup-titlebar");
  assert.deepEqual(bar.children.map(child => child.tag), ["span", "button"]);
  assert.equal(bar.children[0].textContent, "Temperature");
  assert.equal(popup.document.title, "Temperature");
  popup.User_customizationMarkup = "old";
  sync();
  assert.equal(popup.document.body.children.length, 2);
  popup.document.body.children[0].children[1].listeners.click();
  assert.equal(popup.closed, true);
  sync();
  assert.equal(windows.size, 0);
});

test("channel removal closes its independent window", () => {
  const popup = { close() { this.closed = true; } };
  const windows = new Map([["removed", popup]]);
  clientFunction("User_customizationSyncPopups", {
    User_customizationPopupWindows: windows,
    User_customizationElements: { User_customizationGrid: { children: [] } },
    User_customizationSaving: false
  })();
  assert.equal(popup.closed, true);
  assert.equal(windows.size, 0);
});

async function desktop(args = []) {
  const instances = [];
  const errors = [];
  const app = new EventEmitter();
  app.setName = name => { app.name = name; };
  app.getPath = () => __dirname;
  app.setPath = (key, value) => { app[key] = value; };
  app.whenReady = () => Promise.resolve();
  app.quit = () => { app.quitting = true; };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.session = {
        setPermissionRequestHandler(handler) { this.request = handler; },
        setPermissionCheckHandler(handler) { this.check = handler; }
      };
      this.webContents.setWindowOpenHandler = handler => { this.open = handler; };
      this.webContents.getURL = () => this.url;
      instances.push(this);
    }
    setMenu(menu) { this.menu = menu; }
    async loadURL(url) { this.url = url; }
    close() { this.closed = true; this.emit("closed"); }
  }
  vm.runInNewContext(mainSource, {
    require: name => name === "electron" ? {
      app, BrowserWindow, dialog: { showErrorBox: (...values) => errors.push(values) }
    } : require(name),
    __dirname: path.join(__dirname, "../desktop"),
    process: { argv: ["electron", "main.js", ...args] },
    URL
  });
  await new Promise(resolve => setImmediate(resolve));
  return { app, instances, errors, BrowserWindow };
}

test("desktop allows only frameless channel windows and cleans them up on navigation", async () => {
  const { instances, BrowserWindow, app } = await desktop();
  assert.equal(app.name, "KIMS Smart Factory");
  assert.equal(app.userData, path.join(__dirname, "KIMS Smart Factory"));
  const main = instances[0];
  assert.equal(main.url, "http://localhost:8080/");
  main.url += "user_customization.html";
  for (let index = 0; index < 3; index++) {
    const result = main.open({ url: "about:blank", frameName: `factory-channel-${index}` });
    assert.equal(result.action, "allow");
    const options = result.overrideBrowserWindowOptions;
    for (const key of ["frame", "minimizable", "maximizable", "fullscreenable"]) assert.equal(options[key], false);
    assert.equal(options.resizable, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.sandbox, true);
    const child = new BrowserWindow(options);
    main.webContents.emit("did-create-window", child);
    assert.equal(child.menu, null);
    assert.equal(child.open({}).action, "deny");
    let prevented = false;
    child.webContents.emit("will-navigate", { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  for (const request of [
    { url: "https://other.example", frameName: "factory-channel-test" },
    { url: "about:blank", frameName: "_blank" }
  ]) assert.equal(main.open(request).action, "deny");
  main.url = "http://localhost:8080/user-login.html";
  assert.equal(main.open({ url: "about:blank", frameName: "factory-channel-test" }).action, "deny");
  main.webContents.emit("did-start-navigation", {}, main.url, false, true);
  assert.ok(instances.slice(1).every(child => child.closed));
  app.emit("window-all-closed");
  assert.equal(app.quitting, true);
});

test("desktop rejects unsafe addresses and cross-origin navigation", async () => {
  for (const url of ["file:///C:/Windows", "https://user:password@example.com", "invalid"]) {
    const result = await desktop(["--url", url]);
    assert.equal(result.instances.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.app.quitting, true);
  }
  const { instances } = await desktop(["--url", "https://factory.example.com"]);
  const main = instances[0];
  for (const type of ["will-navigate", "will-redirect"]) {
    let prevented = false;
    main.webContents.emit(type, { preventDefault() { prevented = true; } }, "https://other.example");
    assert.equal(prevented, true);
  }
  assert.equal(main.webContents.session.check(), false);
  main.webContents.session.request(null, "camera", allowed => assert.equal(allowed, false));
});
