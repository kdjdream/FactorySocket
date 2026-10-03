const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const postcss = require("postcss");

function readCss() {
  const root = postcss.parse(fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8"));
  const serialize = node => {
    if (node.type === "decl") return `${node.prop}: ${node.value}${node.important ? " !important" : ""};`;
    if (node.type === "rule") return `${node.selector.replace(/\s+/g, " ")} { ${node.nodes.map(serialize).filter(Boolean).join(" ")} }`;
    if (node.type === "atrule") return `@${node.name} ${node.params}${node.nodes ? ` { ${node.nodes.map(serialize).filter(Boolean).join(" ")} }` : ";"}`;
    return "";
  };
  return root.nodes.map(serialize).filter(Boolean).join("\n");
}

test("server and Wemos browser scripts parse as complete JavaScript files", () => {
  for (const filename of ["server.js", "public/wemos-active-devices.js", "public/wemos-view.js", "public/wemos.js", "public/wemos-admin.js", "public/settings.js", "public/page-settings.js"]) {
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), { filename });
  }
});

test("all HTML pages load the shared title code and use the same initial title", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  const pages = fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"));
  assert.ok(pages.length >= 11);
  const initialTitles = new Set();
  for (const filename of pages) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    assert.ok(html.includes("/page-settings.js"), `${filename} is missing shared title code`);
    const title = /<title>([^<]*)<\/title>/.exec(html);
    assert.ok(title, `${filename} is missing the initial title`);
    initialTitles.add(title[1]);
  }
  assert.equal(initialTitles.size, 1);
  const source = fs.readFileSync(path.join(publicDirectory, "page-settings.js"), "utf8");
  const titleCode = source.slice(0, source.indexOf("const VIEW_SETTINGS_KEY"));
  const document = { title: "old title" };
  const configuredTitle = vm.runInNewContext(`${titleCode}\nPAGE_TITLE;`, { document });
  assert.equal(document.title, configuredTitle);
  vm.runInNewContext(titleCode.replace(JSON.stringify(configuredTitle), JSON.stringify("FACTORY TEST TITLE")), { document });
  assert.equal(document.title, "FACTORY TEST TITLE");
});

test("shared login identity joins the standard header without duplicates or HTML injection", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function applyPageUser(");
  const end = source.indexOf("const protectedPageAccess =", start);
  assert.ok(start >= 0 && end > start);
  const menus = ["header-actions", "wemos-page-links", "auth-links"].map(name => {
    const menu = { name, children: [{ link: true }], legacy: { hidden: false, dataset: {} } };
    menu.querySelector = selector => selector === "#userInfo" ? menu.legacy : menu.children.find(child => selector === "[data-page-user-bar]" ? child.dataset?.pageUserBar !== undefined : child.dataset?.pageUserInfo !== undefined);
    menu.prepend = label => { label.menu = menu; menu.children.unshift(label); };
    return menu;
  });
  const classes = new Set();
  const createNode = () => ({
    dataset: {}, children: [],
    append(child) { child.parent = this; this.children.push(child); },
    prepend(child) { child.parent = this; this.children.unshift(child); },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.dataset && (selector === "[data-page-user-bar]" ? child.dataset.pageUserBar !== undefined : child.dataset.pageUserInfo !== undefined)) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  });
  const body = createNode();
  const header = createNode();
  const headerActions = menus[0];
  headerActions.append = label => { label.parent = headerActions; headerActions.children.push(label); };
  const findHeaderChild = header.querySelector.bind(header);
  header.querySelector = selector => selector === ".header-actions" ? headerActions : findHeaderChild(selector);
  header.append(headerActions);
  body.append(header);
  body.classList = { add: name => classes.add(name), remove: name => classes.delete(name) };
  const context = vm.createContext({ document: {
    body,
    querySelector: selector => {
      assert.equal(selector, "body:not(.auth-body) > header, body.wemos-page .wemos-header");
      return header;
    },
    querySelectorAll: () => menus, createElement: createNode
  } });
  vm.runInContext(source.slice(start, end), context);
  context.applyPageUser({ username: "operator", name: "Hong <A>" }, 8);
  context.applyPageUser({ username: "operator", name: "Hong <A>" }, 8);
  assert.equal(header.children.length, 2);
  const bar = header.children[1];
  assert.equal(bar.className, "page-user-bar");
  assert.equal(bar.children[0].textContent, "Log in : operator (Hong <A>, 8등급)");
  assert.equal(bar.children[0].innerHTML, undefined);
  assert.equal(classes.has("has-page-user"), true);
  for (const menu of menus) {
    assert.equal(menu.children.length, 1);
    assert.equal(menu.legacy.hidden, true);
  }
  context.applyPageUser(null);
  assert.equal(header.children.length, 1);
  assert.equal(classes.has("has-page-user"), false);
  assert.ok(menus.every(menu => menu.children.length === 1));
});

test("login identity uses a right-aligned responsive flow rather than an overlay", () => {
  const css = readCss();
  assert.match(css, /\.page-user-bar \{[^}]*display: flex;[^}]*justify-content: flex-end;/);
  assert.match(css, /body:not\(\.wemos-page\):not\(\.auth-body\)\.has-page-user > header \{[^}]*grid-template-areas:[^}]*"title user"[^}]*"title actions";/);
  assert.match(css, /body:not\(\.wemos-page\):not\(\.auth-body\)\.has-page-user > header > \.page-user-bar \{[^}]*grid-area: user;[^}]*justify-self: end;/);
  assert.match(css, /body:not\(\.wemos-page\):not\(\.auth-body\)\.has-page-user > header > \.header-actions \{\s*grid-area: actions;/);
  assert.match(css, /body\.wemos-page\.has-page-user \.wemos-header \{[^}]*"heading user"[^}]*"heading links";/);
  assert.match(css, /body\.wemos-page\.has-page-user \.wemos-header > \.page-user-bar \{[^}]*grid-area: user;/);
  assert.match(css, /\.page-user-info \{[^}]*text-align: right;/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.page-user-bar \{ width: calc\(100% - 24px\); \}/);
  assert.match(css, /body\.auth-body\.has-page-user \{ flex-direction: column; justify-content: flex-start; \}/);
});

test("every page has a link container supported by the shared user display", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  for (const filename of fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    assert.match(html, /class="[^"]*\b(?:header-actions|wemos-page-links|auth-links)\b[^"]*"/, filename);
    assert.ok(html.includes("/page-settings.js"), filename);
  }
});

test("shared user refresh updates identity and menu access after permission changes or logout", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function refreshPageUser()");
  const end = source.indexOf("\nrefreshPageUser();", start);
  assert.ok(start >= 0 && end > start);
  let user = { username: "operator", name: "User", permission_level: 8, status: "APPROVED" };
  const identities = [];
  let hidden = true;
  const context = vm.createContext({
    fetch: async (_url, options) => { assert.equal(options.cache, "no-store"); return { ok: !!user, json: async () => ({ user }) }; },
    applyPageUser: (current, level) => identities.push({ current, level }),
    protectedLinks: [{
      link: { classList: { add: () => { hidden = true; }, toggle: (_name, value) => { hidden = value; } } },
      canAccess: access => access.active && access.approved && access.permissionLevel >= 8
    }]
  });
  vm.runInContext(source.slice(start, end), context);
  await context.refreshPageUser();
  assert.equal(identities.at(-1).level, 8);
  assert.equal(hidden, false);
  user = { ...user, permission_level: 6 };
  await context.refreshPageUser();
  assert.equal(identities.at(-1).level, 6);
  assert.equal(hidden, true);
  user = null;
  await context.refreshPageUser();
  assert.equal(identities.at(-1).current, null);
  assert.equal(hidden, true);
});

test("all page body layouts share a configurable heading style", () => {
  const css = readCss();
  const sharedRule = /body:not\(\.wemos-page\):not\(\.auth-body\) > header > div:first-child::before,\s*body\.wemos-page \.wemos-header > \.wemos-heading::before,\s*body\.auth-body \.auth-card > h1::before \{([^}]*)\}/.exec(css);
  assert.ok(sharedRule);
  const headingText = /content: "([^"]+)";/.exec(sharedRule[1]);
  assert.ok(headingText);
  assert.ok(css.includes("color: var(--site-green, var(--wemos-green, #087a67));"));
  assert.equal(css.includes('content: "FACTORY MONITOR"'), false);
  assert.equal(css.split(`content: "${headingText[1]}"`).length - 1, 1);
  const publicDirectory = path.join(__dirname, "..", "public");
  for (const filename of fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    if (html.includes('class="auth-body"')) {
      assert.match(html, /class="auth-card"[^>]*>\s*<h1>/, filename);
    } else if (html.includes('class="wemos-page"')) {
      assert.match(html, /class="wemos-header"[^>]*>\s*<div class="wemos-heading">/, filename);
    } else {
      assert.match(html, /<header[^>]*>\s*<div/, filename);
    }
  }
});

test("three Wemos pages share the same CSS-controlled header eyebrow", () => {
  const css = readCss();
  assert.ok(css.includes('.wemos-heading > .wemos-eyebrow::before { content: "WEMOS D1 R1"; }'));
  assert.ok(css.includes('.wemos-heading > .wemos-eyebrow::after { content: "DEVICE CONTROL"; }'));
  for (const filename of ["wemos.html", "wemos-view.html", "wemos-admin.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
    const heading = /<div class="wemos-heading">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(heading, filename);
    assert.ok(heading[1].includes('<p class="wemos-eyebrow"><span>·</span></p>'), filename);
    assert.equal(/DEVICE CONTROL|OUTPUT MONITOR|DEVICE ADMINISTRATION/.test(heading[1].split("<h1>")[0]), false);
  }
});

test("Wemos management APIs require level eight while lower-level controls stay unchanged", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const guardStart = source.indexOf("function requireAdminLevel(");
  const guardEnd = source.indexOf("function requireMaster(", guardStart);
  const middlewareStart = source.indexOf("function wemosAdminMiddleware(");
  const middlewareEnd = source.indexOf("async function getManagedWemosDevices", middlewareStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart && middlewareStart >= 0 && middlewareEnd > middlewareStart);
  const passthrough = (_req, _res, next) => next();
  const context = vm.createContext({
    getPermissionLevel: user => user.permissionLevel,
    requireLogin: passthrough, requireActiveAccount: passthrough, requireApproved: passthrough
  });
  vm.runInContext(source.slice(guardStart, guardEnd) + source.slice(middlewareStart, middlewareEnd), context);
  for (let level = 1; level <= 10; level++) {
    let authorized = false;
    let status;
    const response = { status: value => { status = value; return response; }, json: () => {} };
    context.wemosAdminMiddleware({ path: "/api/admin/wemos/devices", user: { permissionLevel: level } }, response, () => { authorized = true; });
    assert.equal(authorized, level >= 8);
    if (level < 8) assert.equal(status, 403);
  }
  assert.match(source, /app\.get\("\/wemos-admin\.html",[^\n]*requireAdminLevel\(8\)/);
  assert.match(source, /app\.get\("\/product-admin\.html",[^\n]*requireAdminLevel\(6\)/);
  assert.match(source, /app\.get\("\/wemos\.html",[^\n]*requireAdminLevel\(2\)/);
  const managementRoutes = [...source.matchAll(/app\.(?:get|post|put|delete)\("\/api\/admin\/wemos[^\n]+/g)].map(match => match[0]);
  assert.equal(managementRoutes.length, 6);
  assert.ok(managementRoutes.every(route => route.includes("wemosAdminMiddleware")));
});

test("Wemos management menu is visible only for approved active level-eight members", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("const protectedPageAccess =");
  const end = source.indexOf("const protectedLinks =", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  for (let level = 1; level <= 10; level++) {
    context.access = { active: true, approved: true, permissionLevel: level };
    assert.equal(vm.runInContext('protectedPageAccess["/wemos-admin.html"](access)', context), level >= 8);
  }
  for (const access of [{ active: false, approved: true, permissionLevel: 10 }, { active: true, approved: false, permissionLevel: 10 }]) {
    context.access = access;
    assert.equal(vm.runInContext('protectedPageAccess["/wemos-admin.html"](access)', context), false);
  }
  const adminScript = fs.readFileSync(path.join(__dirname, "..", "public", "wemos-admin.js"), "utf8");
  assert.ok(adminScript.includes('if (level < 8 || data.user.status !== "APPROVED")'));
});

function createSettingsHarness() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const SETTINGS_DEFAULTS =");
  const end = source.indexOf('app.get("/api/me/settings"', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("Wemos visibility settings default to shown and accept per-user hidden values", () => {
  const context = createSettingsHarness();
  const defaults = context.validateSettings({});
  for (const name of ["show_wemos_istr", "show_wemos_ostr", "show_wemos_ostr_inputs"]) {
    assert.equal(defaults[name], true);
    assert.equal(context.validateSettings({ [name]: false })[name], false);
    assert.ok(context.validateSettings({ [name]: "false" }).error);
  }
});

test("stored Wemos visibility values restore as booleans", () => {
  const context = createSettingsHarness();
  const settings = context.rowToSettings({ show_wemos_istr: 0, show_wemos_ostr: 1, show_wemos_ostr_inputs: 0 });
  assert.equal(settings.show_wemos_istr, false);
  assert.equal(settings.show_wemos_ostr, true);
  assert.equal(settings.show_wemos_ostr_inputs, false);
  assert.equal(context.rowToSettings({}).show_wemos_istr, true);
});

test("settings form restores and submits all three Wemos visibility options", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "settings.js"), "utf8");
  const start = source.indexOf("function applySettingsToForm(");
  const end = source.indexOf("function showMessage(", start);
  assert.ok(start >= 0 && end > start);
  const elements = {};
  const context = vm.createContext({ document: { getElementById: id => elements[id] ||= {} } });
  vm.runInContext(source.slice(start, end), context);
  context.applySettingsToForm({ show_wemos_istr: false, show_wemos_ostr: true, show_wemos_ostr_inputs: false });
  const settings = context.readSettingsFromForm();
  assert.equal(settings.show_wemos_istr, false);
  assert.equal(settings.show_wemos_ostr, true);
  assert.equal(settings.show_wemos_ostr_inputs, false);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "settings.html"), "utf8");
  for (const id of ["showWemosIstr", "showWemosOstr", "showWemosOstrInputs"]) assert.ok(html.includes(`type="checkbox" id="${id}"`));
});

test("settings API stores Wemos options only for the authenticated member", async () => {
  const context = createSettingsHarness();
  const calls = [];
  let handler;
  context.app = { put: (_path, ...handlers) => { handler = handlers.at(-1); } };
  context.requireLogin = () => {};
  context.requireActiveAccount = () => {};
  context.console = console;
  context.query = async (sql, params) => { calls.push({ sql, params }); return []; };
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf('app.put("/api/me/settings"');
  const end = source.indexOf("\n// ---------------------------------------------------------", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const response = { status: () => response, json: () => {} };
  await handler({ user: { id: 101 }, body: {
    user_id: 999, show_wemos_istr: false, show_wemos_ostr: true, show_wemos_ostr_inputs: false
  } }, response);
  const insert = calls.find(call => call.sql.includes("INSERT INTO user_settings"));
  assert.equal(insert.params[0], 101);
  assert.equal(insert.params.length, 15);
  assert.deepEqual(Array.from(insert.params).slice(12), [0, 1, 0]);
});

test("shared page settings independently apply all Wemos visibility flags without caching them across accounts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const end = source.indexOf("window.applyFactoryViewSettings");
  assert.ok(end > 0);
  const dataset = {};
  let cached;
  const context = vm.createContext({
    document: { documentElement: { dataset } },
    localStorage: { setItem: (_key, value) => { cached = JSON.parse(value); } }
  });
  vm.runInContext(source.slice(0, end), context);
  context.applyViewSettings({ show_wemos_istr: false, show_wemos_ostr: true, show_wemos_ostr_inputs: false });
  assert.equal(dataset.showWemosIstr, "false");
  assert.equal(dataset.showWemosOstr, "true");
  assert.equal(dataset.showWemosOstrInputs, "false");
  assert.equal(Object.hasOwn(cached, "show_wemos_istr"), false);
  context.applyViewSettings({});
  assert.equal(dataset.showWemosIstr, "true");
  assert.equal(dataset.showWemosOstrInputs, "true");
});

test("Wemos page restores visibility settings when returning from cache or regaining focus", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function refreshViewSettings()");
  assert.ok(start >= 0);
  const listeners = {};
  let loads = 0;
  let settingsApplied = 0;
  const context = vm.createContext({
    fetch: async (_url, options) => { assert.equal(options.cache, "no-store"); loads++; return { ok: true, json: async () => ({ show_wemos_istr: false }) }; },
    applyViewSettings: settings => { assert.equal(settings.show_wemos_istr, false); settingsApplied++; },
    location: { pathname: "/wemos-view.html" },
    window: { addEventListener: (event, handler) => { listeners[event] = handler; } },
    document: { visibilityState: "visible", addEventListener: (event, handler) => { listeners[event] = handler; } }
  });
  vm.runInContext(source.slice(start), context);
  await new Promise(setImmediate);
  assert.equal(loads, 1);
  listeners.pageshow({ persisted: true });
  listeners.focus();
  listeners.visibilitychange();
  await new Promise(setImmediate);
  assert.equal(loads, 4);
  assert.equal(settingsApplied, 4);
});

test("both Wemos pages render visibility targets for every channel while view stays read-only", async () => {
  const css = readCss();
  for (const name of ["istr", "ostr", "ostr-inputs"]) {
    assert.ok(css.includes(`html[data-show-wemos-${name}="false"] .wemos-page [data-wemos-${name}]`));
  }
  for (const viewOnly of [false, true]) {
    const { root } = createUiHarness(viewOnly, [1, 2, 3, 4, 5, 6, 7, 8]);
    await new Promise(setImmediate);
    assert.equal([...root.innerHTML.matchAll(/data-wemos-istr>/g)].length, 8);
    assert.equal([...root.innerHTML.matchAll(/data-wemos-ostr>/g)].length, 8);
    assert.equal([...root.innerHTML.matchAll(/data-wemos-ostr-inputs>/g)].length, viewOnly ? 0 : 8);
  }
});

function createTokenCopyHarness(clipboard, fallbackResult = true) {
  const writes = [];
  const inputs = [];
  const commands = [];
  let restoredFocus = false;
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "wemos-admin.js"), "utf8");
  const start = source.indexOf("async function copyDeviceToken(");
  const end = source.indexOf("function renderRows()", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    navigator: clipboard ? { clipboard: { writeText: async token => { writes.push(token); return clipboard(token); } } } : {},
    document: {
      activeElement: { focus: () => { restoredFocus = true; } },
      getSelection: () => null,
      createElement: tag => {
        assert.equal(tag, "textarea");
        const input = { style: {}, focus: () => {}, select: () => { input.selected = true; },
          setSelectionRange: (startIndex, endIndex) => { input.range = [startIndex, endIndex]; },
          remove: () => { input.removed = true; } };
        inputs.push(input);
        return input;
      },
      body: { appendChild: () => {} },
      execCommand: command => { commands.push(command); return fallbackResult; }
    }
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, writes, inputs, commands, restoredFocus: () => restoredFocus };
}

test("token copy uses the modern clipboard when available", async () => {
  const harness = createTokenCopyHarness(async () => {});
  assert.equal(await harness.context.copyDeviceToken("test-device-token"), true);
  assert.deepEqual(harness.writes, ["test-device-token"]);
  assert.equal(harness.inputs.length, 0);
});

test("token copy works without Clipboard API on HTTP deployments", async () => {
  const harness = createTokenCopyHarness(null);
  assert.equal(await harness.context.copyDeviceToken("test-device-token"), true);
  assert.deepEqual(harness.commands, ["copy"]);
  assert.equal(harness.inputs[0].value, "test-device-token");
  assert.equal(harness.inputs[0].selected, true);
  assert.deepEqual(harness.inputs[0].range, [0, 17]);
  assert.equal(harness.inputs[0].removed, true);
  assert.equal(harness.restoredFocus(), true);
});

test("token copy falls back after Clipboard API permission rejection", async () => {
  const harness = createTokenCopyHarness(async () => { throw new Error("NotAllowedError"); });
  assert.equal(await harness.context.copyDeviceToken("test-device-token"), true);
  assert.deepEqual(harness.commands, ["copy"]);
  assert.equal(harness.inputs[0].removed, true);
});

test("token copy does not report success when compatibility copy is blocked", async () => {
  const harness = createTokenCopyHarness(null, false);
  assert.equal(await harness.context.copyDeviceToken("test-device-token"), false);
  assert.equal(harness.inputs[0].removed, true);
  assert.equal(await harness.context.copyDeviceToken(""), false);
  assert.equal(harness.inputs.length, 1);
});

test("token copy button reports its result and selects the token only when copying fails", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "wemos-admin.js"), "utf8");
  const start = source.indexOf('copyButton.addEventListener("click", async () => {');
  const end = source.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start);
  for (const copied of [true, false]) {
    let click;
    let selected = null;
    const button = { textContent: "토큰 복사", disabled: false, addEventListener: (_event, handler) => { click = handler; } };
    const tokenValue = { textContent: "test-device-token" };
    const message = { textContent: "previous-message" };
    const context = vm.createContext({
      copyButton: button, tokenValue, data: { deviceToken: "test-device-token" }, $: () => message,
      copyDeviceToken: async token => { assert.equal(token, "test-device-token"); return copied; },
      document: {
        getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
        createRange: () => ({ selectNodeContents: element => { selected = element; } })
      }
    });
    vm.runInContext(source.slice(start, end + 7), context);
    await click();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, copied ? "복사됨" : "복사 실패");
    assert.equal(selected, copied ? null : tokenValue);
    assert.equal(message.textContent, copied ? "장치 토큰이 복사되었습니다." : "브라우저에서 자동 복사를 허용하지 않습니다.");
  }
});

test("control page has six history columns and no recent commands list", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "wemos.html"), "utf8");
  const historyHeader = html.slice(html.indexOf('aria-labelledby="history-title"'), html.indexOf('<tbody id="history"'));
  assert.equal([...historyHeader.matchAll(/<th>/g)].length, 6);
  assert.equal(html.includes("Command ID"), false);
  assert.equal(html.includes('id="commands"'), false);
  assert.equal(html.includes("최근 명령"), false);
  assert.equal(historyHeader.includes("<th>이전</th>"), false);
  assert.ok(historyHeader.includes("<th>현재</th>\n\t\t\t\t\t\t\t<th>문자열</th>"));
  const target = { innerHTML: "" };
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "wemos.js"), "utf8");
  const start = source.indexOf("function renderHistory()");
  const end = source.indexOf("function renderCommands()", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    $: id => id === "history" ? target : null,
    historyRows: [{ changed_at: "2026-10-03", device_id: "WEMOS-D1-001", output_signal: "OS1",
      previous_output_state: "OFF", output_state: "ON", change_source: "operator", command_id: "hidden-command-id",
      signal_message: "MOTOR_ON" }],
    formatDate: value => value, escapeHtml: value => String(value)
  });
  vm.runInContext(source.slice(start, end), context);
  context.renderHistory();
  assert.equal([...target.innerHTML.matchAll(/<td>/g)].length, 6);
  assert.equal(target.innerHTML.includes("hidden-command-id"), false);
  assert.equal(target.innerHTML.includes("<td>OFF</td>"), false);
  assert.ok(target.innerHTML.includes("<td>ON</td>\n      <td>MOTOR_ON</td>"));
  context.historyRows[0].signal_message = "sensor-new";
  context.renderHistory();
  assert.ok(target.innerHTML.includes("<td>sensor-new</td>"));
  assert.equal(target.innerHTML.includes("IStr:"), false);
  assert.equal(target.innerHTML.includes("OStr:"), false);
  assert.equal(target.innerHTML.includes("MOTOR_ON"), false);
  context.historyRows[0].signal_message = null;
  context.renderHistory();
  assert.ok(target.innerHTML.includes("<td>-</td>"));
});

test("history device column has a wider non-wrapping layout scoped to its table", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "wemos.html"), "utf8");
  const css = readCss();
  assert.ok(html.includes('class="wemos-table wemos-history-table"'));
  assert.match(css, /\.wemos-page \.wemos-history-table \{ table-layout: auto; \}/);
  assert.match(css, /\.wemos-history-table td:nth-child\(2\) \{ width: 22%; min-width: 180px; white-space: nowrap; \}/);
});

test("control and view channels share strong four-sided borders and clear spacing", async () => {
  const css = readCss();
  assert.match(css, /\.active-wemos-channels \{[^}]*gap: 12px; padding: 12px;/);
  assert.match(css, /\.active-wemos-channels \.channel-card \{ box-sizing: border-box; border: 2px solid var\(--wemos-green\); \}/);
  assert.match(css, /@media \(max-width: 980px\) \{\s*\.active-wemos-channels \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  for (const viewOnly of [false, true]) {
    const { root } = createUiHarness(viewOnly, [1, 2, 3, 4, 5, 6, 7, 8]);
    await new Promise(setImmediate);
    assert.ok(root.innerHTML.includes('class="active-wemos-channels"'));
    assert.equal([...root.innerHTML.matchAll(/class="channel-card channel-/g)].length, 8);
  }
});

test("browser ACK events use canonical command metadata without changing socket fields", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "wemos.js"), "utf8");
  const start = source.indexOf("function handle(message)");
  const end = source.indexOf("function updateRealtimeState", start);
  assert.ok(start >= 0 && end > start);
  const commands = [];
  const context = vm.createContext({ upsertCommand: row => commands.push(row), $: () => null });
  vm.runInContext(source.slice(start, end), context);
  context.handle({ type: "commandAck", commandId: "cmd-1", OutputSignal: "OS8", state: "ON", status: "ACKED", changedAt: "2026-10-03T03:00:00Z" });
  assert.equal(commands[0].command_status, "ACKED");
  assert.equal(commands[0].output_signal, "OS8");
  assert.equal(commands[0].status_changed_at, "2026-10-03T03:00:00Z");
});

test("device management returns canonical channel metadata", async () => {
  const { context } = createHarness();
  context.query = async sql => sql.includes("FROM wemos_channels")
    ? [{ id: 1, channel_name: "Channel 8", input_signal: "IS8", output_signal: "OS8", is_active: 1, output_state: "ON" }]
    : [{ device_id: "WEMOS-D1-002", device_name: "Machine", is_active: 1 }];
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function getManagedWemosDevices()");
  const end = source.indexOf('app.get("/api/admin/wemos/devices"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const devices = await context.getManagedWemosDevices();
  assert.equal(devices[0].is_active, 1);
  assert.equal(devices[0].sets[0].channel_name, "Channel 8");
  assert.equal(devices[0].sets[0].input_signal, "IS8");
  assert.equal(devices[0].sets[0].output_state, "ON");
});

test("history string migration copies values before dropping old columns and is repeatable", async () => {
  const { context, sqlCalls } = createHarness();
  const columns = new Set(["string_type", "input_string", "output_string"]);
  await context.migrateWemosHistoryStrings(columns);
  assert.ok(sqlCalls[0].sql.includes("ADD COLUMN signal_message"));
  assert.ok(sqlCalls[1].sql.includes("WHEN string_type='IStr' THEN input_string"));
  assert.ok(sqlCalls[1].sql.includes("WHEN string_type='OStr' THEN output_string"));
  assert.ok(sqlCalls[1].sql.includes("WHERE signal_message IS NULL"));
  assert.ok(sqlCalls[2].sql.includes("DROP COLUMN input_string"));
  assert.ok(sqlCalls[3].sql.includes("DROP COLUMN output_string"));
  assert.ok(sqlCalls[4].sql.includes("DROP COLUMN string_type"));
  assert.deepEqual([...columns], ["signal_message"]);
  await context.migrateWemosHistoryStrings(columns);
  assert.equal(sqlCalls.length, 5);
});

test("schema naming migration plans table and column renames before changing data", async () => {
  const { context } = createHarness();
  const operations = [];
  context.query = async (sql, params = []) => {
    if (sql.includes("information_schema.TABLES")) return [{ table_name: "wemos_contact_sets" }];
    if (sql.includes("information_schema.COLUMNS")) {
      assert.equal(params[0], "wemos_contact_sets");
      return ["set_name", "Digital_input", "Degital_output", "current_state"].map(column_name => ({ column_name }));
    }
    operations.push(sql);
    return { affectedRows: 0 };
  };
  await context.migrateWemosSchemaNames();
  assert.equal(operations[0], "RENAME TABLE `wemos_contact_sets` TO `wemos_channels`");
  assert.ok(operations.includes("ALTER TABLE `wemos_channels` RENAME COLUMN `Digital_input` TO `input_signal`"));
  assert.ok(operations.includes("ALTER TABLE `wemos_channels` RENAME COLUMN `current_state` TO `output_state`"));
  assert.equal(operations.some(sql => /DROP|DELETE|UPDATE|INSERT/.test(sql)), false);
});

test("schema naming migration refuses conflicting tables before any DDL", async () => {
  const { context } = createHarness();
  let changes = 0;
  context.query = async sql => {
    if (sql.includes("information_schema.TABLES")) return ["wemos_contact_sets", "wemos_channels"].map(table_name => ({ table_name }));
    changes++;
    return [];
  };
  await assert.rejects(context.migrateWemosSchemaNames(), /이름 변경 충돌/);
  assert.equal(changes, 0);
});

test("existing unified String values only require removal of string_type", async () => {
  const { context, sqlCalls } = createHarness();
  const columns = new Set(["signal_message", "string_type"]);
  await context.migrateWemosHistoryStrings(columns);
  assert.equal(sqlCalls.length, 1);
  assert.equal(sqlCalls[0].sql, "ALTER TABLE wemos_state_history DROP COLUMN string_type");
  await context.migrateWemosHistoryStrings(columns);
  assert.equal(sqlCalls.length, 1);
});

function createHarness(command = null) {
  const sqlCalls = [];
  const events = [];
  const sent = [];
  const channel = {
    output_state: "OFF", input_state: "ON", last_change_source: "operator",
    input_message: "sensor-data", output_message: "previous-command", last_changed_at: "2026-10-03 12:00:00.000"
  };
  const query = async (sql, params = []) => {
    sqlCalls.push({ sql, params });
    if (sql.includes("SELECT output_state")) return [{ ...channel }];
    if (sql.includes("SELECT device_id,is_active")) return [{ device_id: "WEMOS-D1-002", is_active: 1 }];
    if (sql.includes("SELECT output_message")) return [{ output_message: channel.output_message }];
    if (sql.includes("SELECT command_id,output_signal")) return command ? [command] : [];
    if (sql.includes("SELECT id,command_id")) return [];
    return { affectedRows: 1 };
  };
  const connection = {
    beginTransaction: async () => {}, commit: async () => {},
    rollback: async () => {}, release: () => {}
  };
  const sockets = new Map();
  const browser = { readyState: 1, wemosSubscriber: true, send: data => events.push(JSON.parse(data)) };
  const ws = {
    deviceId: "WEMOS-D1-002", wemosIdentified: true, readyState: 1,
    send: data => sent.push(JSON.parse(data)), close: () => {}
  };
  sockets.set(ws.deviceId, ws);
  const context = vm.createContext({
    query, connectionQuery: (_connection, sql, params) => query(sql, params),
    pool: { getConnection: async () => connection },
    crypto: require("node:crypto"), WebSocket: { OPEN: 1 },
    clients: new Set([browser]), wemosDeviceSockets: sockets,
    WEMOS_DEVICE_ID: ws.deviceId, WEMOS_DEVICE_TOKEN: "test-token",
    wemosDeviceSocket: null, toKoreaDateTime: date => date.toISOString(), console
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const WEMOS_CHANNEL_COUNT =");
  const end = source.indexOf("function getUserFromRequest", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { context, sqlCalls, events, sent, ws };
}

test("hello registers all eight firmware channels", async () => {
  const { context, sqlCalls, ws } = createHarness();
  ws.wemosIdentified = false;
  await context.handleWemosDeviceMessage(ws, {
    type: "hello", deviceId: ws.deviceId, OutputSignal: "OS1",
    inputs: Array.from({ length: 8 }, (_, index) => `IS${index + 1}`),
    outputs: Array.from({ length: 8 }, (_, index) => `OS${index + 1}`)
  });
  const inserts = sqlCalls.filter(call => call.sql.includes("INSERT INTO wemos_channels"));
  assert.equal(inserts.length, 8);
  assert.deepEqual(Array.from(inserts[7].params), [ws.deviceId, "채널 08", "IS8", "OS8", 7]);
});

test("firmware state preserves independent input, output and strings", async () => {
  const { context, sqlCalls, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", state: "ON",
    InputSignal: "IS8", inputState: "OFF", source: "WEMOS", IStr: "sensor-8", OStr: "motor-8"
  });
  const update = sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "OFF", ws.deviceId, "sensor-8", "motor-8"]);
  assert.equal(events[0].inputState, "OFF");
  assert.equal(events[0].IStr, "sensor-8");
  assert.equal(events[0].InputSignal, "IS8");
  assert.equal(events[0].OutputSignal, "OS8");
  assert.equal(events[0].pin, undefined);
  assert.equal(events[0].inputPin, undefined);
  const history = sqlCalls.find(call => call.sql.includes("INSERT INTO wemos_state_history"));
  assert.equal(history.params[6], "sensor-8");
  assert.equal(events[0].stringType, undefined);
  assert.equal(events[0].String, "sensor-8");
});

test("firmware ACK without telemetry does not erase input state or IStr", async () => {
  const command = {
    command_id: "cmd-1", output_signal: "OS1", requested_output_state: "ON",
    output_message: "MOTOR_ON", requested_by: "operator", command_status: "DELIVERED"
  };
  const { context, sqlCalls, events, ws } = createHarness(command);
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", deviceId: ws.deviceId, commandId: "cmd-1", OutputSignal: "OS1", state: "ON", success: true
  });
  const update = sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "ON", "operator", "sensor-data", "MOTOR_ON"]);
  assert.equal(events.find(event => event.type === "commandAck").status, "ACKED");
  const history = sqlCalls.find(call => call.sql.includes("INSERT INTO wemos_state_history"));
  assert.equal(history.params[6], "MOTOR_ON");
  assert.equal(events.find(event => event.type === "stateChanged").stringType, undefined);
  assert.equal(events.find(event => event.type === "stateChanged").String, "MOTOR_ON");
});

test("CLIENT state reports retain telemetry and empty strings", async () => {
  const { context, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS1", state: "OFF",
    inputState: "OFF", source: "CLIENT", IStr: "", OStr: ""
  });
  assert.equal(events[0].inputState, "OFF");
  assert.equal(events[0].IStr, "");
  assert.equal(events[0].OStr, "");
  assert.equal(events[0].source, "operator");
});

test("ACK with unexpected state fails instead of marking the command successful", async () => {
  const { context, events, ws } = createHarness({
    command_id: "cmd-1", output_signal: "OS1", requested_output_state: "ON", command_status: "DELIVERED"
  });
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", commandId: "cmd-1", OutputSignal: "OS1", state: "OFF", success: true
  });
  assert.equal(events[0].status, "FAILED");
});

test("server commands send only OStr for the device output string", async () => {
  const { context, ws, sent } = createHarness();
  await context.deliverWemosCommand(ws.deviceId, "cmd-8", "OS8", "ON", "operator", "MOTOR_ON");
  assert.equal(sent[0].OutputSignal, "OS8");
  assert.equal(sent[0].InputSignal, "IS8");
  assert.equal(sent[0].pin, undefined);
  assert.equal(sent[0].inputPin, undefined);
  assert.equal(sent[0].OStr, "MOTOR_ON");
  assert.equal(sent[0].severSignal, "ON");
  assert.equal(Object.hasOwn(sent[0], "state"), false);
  assert.equal(Object.hasOwn(sent[0], "receiveString"), false);
  assert.equal(Object.hasOwn(sent[0], "outputString"), false);
  assert.equal(sent[0].commandId, "cmd-8");
});

test("channelString updates only IStr and refreshes the device timestamp", async () => {
  const { context, sqlCalls, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "channelString", deviceId: ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8", sendString: "sensor-only"
  });
  assert.ok(sqlCalls[0].sql.includes("SET input_message=?"));
  assert.equal(sqlCalls[0].params[0], "sensor-only");
  assert.ok(sqlCalls[1].sql.includes("last_seen_at=?"));
  assert.equal(events[0].IStr, "sensor-only");
  assert.equal(events[0].OStr, undefined);
});

test("invalid input pairing and ACK for another channel are ignored", async () => {
  const { context, sqlCalls, events, ws } = createHarness({
    command_id: "cmd-1", output_signal: "OS1", requested_output_state: "ON", command_status: "DELIVERED"
  });
  await context.handleWemosDeviceMessage(ws, {
    type: "state", OutputSignal: "OS8", InputSignal: "IS1", state: "ON"
  });
  assert.equal(sqlCalls.length, 0);
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", commandId: "cmd-1", OutputSignal: "OS8", state: "ON", success: true
  });
  assert.equal(events.length, 0);
  assert.equal(sqlCalls.length, 1);
});

test("duplicate ACK cannot reapply a finished command", async () => {
  const { context, events, sqlCalls, ws } = createHarness({
    command_id: "cmd-1", output_signal: "OS1", requested_output_state: "ON", command_status: "ACKED"
  });
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", commandId: "cmd-1", OutputSignal: "OS1", state: "ON", success: true
  });
  assert.equal(events.length, 0);
  assert.equal(sqlCalls.length, 1);
});

test("messages arriving during authentication wait and keep firmware order", async () => {
  const { context, events, ws, sqlCalls } = createHarness();
  let finishAuthorization;
  const authorization = new Promise(resolve => { finishAuthorization = resolve; });
  let onMessage;
  ws.wemosIdentified = false;
  ws.on = (_event, handler) => { onMessage = handler; };
  const waitForMessages = context.attachWemosDeviceMessageHandler(ws, authorization);
  onMessage(Buffer.from(JSON.stringify({ type: "hello", deviceId: ws.deviceId })));
  for (let index = 1; index <= 8; index++) {
    onMessage(Buffer.from(JSON.stringify({
      type: "state", deviceId: ws.deviceId, OutputSignal: `OS${index}`,
      InputSignal: `IS${index}`, state: "OFF", inputState: "ON", source: "WEMOS"
    })));
  }
  assert.equal(sqlCalls.length, 0);
  finishAuthorization(true);
  await waitForMessages();
  assert.equal(ws.wemosIdentified, true);
  assert.deepEqual(events.filter(event => event.type === "state").map(event => event.OutputSignal),
    Array.from({ length: 8 }, (_, index) => `OS${index + 1}`));
});

test("unauthenticated queued messages cannot change device data", async () => {
  const { context, sqlCalls, ws } = createHarness();
  let onMessage;
  ws.on = (_event, handler) => { onMessage = handler; };
  const waitForMessages = context.attachWemosDeviceMessageHandler(ws, Promise.resolve(false));
  onMessage(Buffer.from(JSON.stringify({ type: "state", OutputSignal: "OS1", state: "ON" })));
  await waitForMessages();
  assert.equal(sqlCalls.length, 0);
});

function createUiHarness(viewOnly = false, channels = [8], channelOverrides = {}, deviceOverrides = {}) {
  const listeners = {};
  const nodes = {
    inputString: { textContent: "sensor" }, outputString: { textContent: "MOTOR_ON" },
    inputState: { textContent: "OFF", dataset: {} }, outputState: { textContent: "OFF", dataset: {} },
    lastSource: { textContent: "initial-operator" }, lastChangedAt: { textContent: "initial-time" }
  };
  const buttons = ["ON", "OFF"].map(state => ({
    dataset: { state }, active: state === "OFF", pressed: String(state === "OFF"),
    classList: { toggle: (_name, active) => { buttons.find(button => button.dataset.state === state).active = active; } },
    setAttribute: (_name, value) => { buttons.find(button => button.dataset.state === state).pressed = value; }
  }));
  const root = { innerHTML: "", hidden: true };
  const commands = [];
  const context = vm.createContext({
    window: {
      addEventListener: (event, handler) => { listeners[event] = handler; },
      sendWemosCommand: message => commands.push(message)
    },
    document: {
      querySelector: () => null,
      querySelectorAll: selector => {
        if (selector.includes("data-active-command")) return buttons;
        if (selector.includes("data-active-input-string")) return [nodes.inputString];
        if (selector.includes("data-active-output-string")) return [nodes.outputString];
        if (selector.includes("data-active-input-pin")) return [nodes.inputState];
        if (selector.includes("data-active-pin")) return [nodes.outputState];
        if (selector.includes("data-active-last-source")) return [nodes.lastSource];
        if (selector.includes("data-active-last-changed-at")) return [nodes.lastChangedAt];
        return [];
      },
      getElementById: () => root,
      addEventListener: (event, handler) => { listeners[event] = handler; }
    },
    location: { pathname: viewOnly ? "/wemos-view.html" : "/wemos.html" },
    CSS: { escape: value => value }, console,
    fetch: async () => ({ ok: true, json: async () => [{
      device_id: "WEMOS-D1-002", ...deviceOverrides, sets: channels.map(channel => ({
        input_signal: `IS${channel}`, output_signal: `OS${channel}`, input_signal: `IS${channel}`, output_signal: `OS${channel}`,
        output_state: "OFF", input_state: "ON", input_message: "sensor", output_message: "MOTOR_ON", last_change_source: "initial-operator",
        last_changed_at: "2026-10-03 12:00:00.000", created_at: "2026-10-03 09:00:00.000", ...channelOverrides
      }))
    }] })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "wemos-active-devices.js"), "utf8"), context);
  return { listeners, nodes, root, commands, buttons };
}

test("channelString in browser leaves OStr unchanged", () => {
  const { listeners, nodes } = createUiHarness();
  listeners["wemos-state-update"]({ detail: {
    type: "channelString", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", IStr: "new-sensor"
  } });
  assert.equal(nodes.inputString.textContent, "new-sensor");
  assert.equal(nodes.outputString.textContent, "MOTOR_ON");
});

test("control and view cards show identical device information above every channel number", async () => {
  const control = createUiHarness(false, [1, 2, 3, 4, 5, 6, 7, 8], {}, {
    device_id: "DEVICE-TEST-001", device_name: "Line <A> & Machine"
  });
  const view = createUiHarness(true, [1, 2, 3, 4, 5, 6, 7, 8], {}, {
    device_id: "DEVICE-TEST-001", device_name: "Line <A> & Machine"
  });
  await new Promise(setImmediate);
  for (const page of [control, view]) {
    const cards = [...page.root.innerHTML.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(match => match[0]);
    assert.equal(cards.length, 8);
    for (const card of cards) {
      const identity = card.indexOf('class="channel-device-identity"');
      const channelNumber = card.indexOf('class="channel-number"');
      assert.ok(identity >= 0 && identity < channelNumber);
      assert.ok(card.includes("<code>DEVICE-TEST-001</code>"));
      assert.ok(card.includes("<span>Line &lt;A&gt; &amp; Machine</span>"));
      assert.equal(card.includes("Line <A> & Machine"), false);
    }
  }
  const identities = page => [...page.root.innerHTML.matchAll(/<div class="channel-device-identity">[\s\S]*?<\/div>/g)].map(match => match[0]);
  assert.deepEqual(identities(control), identities(view));
  assert.equal(view.root.innerHTML.includes("data-active-command"), false);
  assert.equal(view.root.innerHTML.includes("data-command-output-string"), false);
});

test("browser renders independent IS and OS states", async () => {
  const { listeners, nodes, root } = createUiHarness();
  listeners["wemos-state-update"]({ detail: {
    type: "state", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", state: "ON", inputState: "OFF",
    IStr: "sensor-8", OStr: "motor-8"
  } });
  await new Promise(setImmediate);
  assert.equal(nodes.inputState.textContent, "OFF");
  assert.equal(nodes.outputState.textContent, "ON");
  assert.equal(nodes.inputString.textContent, "sensor-8");
  assert.equal(nodes.outputString.textContent, "motor-8");
  assert.ok(root.innerHTML.includes('data-command-output-string="OS8"'));
  assert.ok(root.innerHTML.includes("<span data-wemos-istr>IStr8: <code"));
  assert.ok(root.innerHTML.includes("<span data-wemos-ostr>OStr8: <code"));
  assert.ok(root.innerHTML.includes('aria-label="OStr8 ON"'));
  assert.ok(root.innerHTML.includes('aria-label="OStr8 OFF"'));
});

test("string labels use actual channel numbers for all eight and reordered channels", async () => {
  const allChannels = createUiHarness(false, [1, 2, 3, 4, 5, 6, 7, 8]);
  const reorderedChannels = createUiHarness(false, [8, 2]);
  await new Promise(setImmediate);
  for (const channel of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(allChannels.root.innerHTML.includes(`<span data-wemos-istr>IStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`<span data-wemos-ostr>OStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`aria-label="OStr${channel} ON"`));
    assert.ok(allChannels.root.innerHTML.includes(`aria-label="OStr${channel} OFF"`));
  }
  const labels = [...reorderedChannels.root.innerHTML.matchAll(/<span data-wemos-(?:istr|ostr)>([IO]Str[1-8]): <code/g)]
    .map(match => match[1]);
  assert.deepEqual(labels, ["IStr8", "OStr8", "IStr2", "OStr2"]);
});

test("channel header shows last source and IS/OS states share the signal row", async () => {
  const { root } = createUiHarness();
  await new Promise(setImmediate);
  const header = root.innerHTML.slice(root.innerHTML.indexOf('class="channel-card-head"'), root.innerHTML.indexOf('class="signal-path"'));
  assert.ok(header.includes("최근 변경"));
  assert.ok(header.includes('data-active-last-source="OS8">initial-operator'));
  assert.equal(header.includes("data-active-pin="), false);
  const signalRow = root.innerHTML.slice(root.innerHTML.indexOf('class="signal-path"'), root.innerHTML.indexOf('class="signal-strings"'));
  assert.ok(signalRow.includes('data-active-input-pin="IS8"'));
  assert.ok(signalRow.includes('data-active-pin="OS8"'));
  assert.ok(signalRow.includes('class="signal-pin">OS8</span>'));
});

test("control and view show separate IS/OS groups without arrows for every channel", async () => {
  for (const viewOnly of [false, true]) {
    const { root } = createUiHarness(viewOnly, [1, 2, 3, 4, 5, 6, 7, 8]);
    await new Promise(setImmediate);
    assert.equal([...root.innerHTML.matchAll(/class="signal-state-group"/g)].length, 16);
    assert.equal(root.innerHTML.includes("signal-arrow"), false);
    for (let channel = 1; channel <= 8; channel++) {
      assert.ok(root.innerHTML.includes(`data-active-input-pin="IS${channel}"`));
      assert.ok(root.innerHTML.includes(`data-active-pin="OS${channel}"`));
    }
  }
});

test("last change time is below source without a label and stays stable on repeated state reports", async () => {
  const browser = createUiHarness();
  await new Promise(setImmediate);
  const header = browser.root.innerHTML.slice(browser.root.innerHTML.indexOf('class="output-readout channel-last-source"'), browser.root.innerHTML.indexOf('class="signal-path"'));
  const sourcePosition = header.indexOf('data-active-last-source="OS8"');
  const timePosition = header.indexOf('data-active-last-changed-at="OS8"');
  assert.ok(timePosition > sourcePosition);
  assert.ok(header.includes('data-active-last-changed-at="OS8">'));
  assert.equal(header.includes("마지막 변경시간"), false);
  const report = {
    type: "stateChanged", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", OutputState: "ON",
    lastChangedAt: "2026-10-03T03:00:00.000Z"
  };
  browser.listeners["wemos-state-update"]({ detail: report });
  const displayedTime = browser.nodes.lastChangedAt.textContent;
  assert.ok(displayedTime.includes("12:00:00"));
  browser.listeners["wemos-state-update"]({ detail: { ...report, type: "state", changedAt: "2026-10-03T04:00:00.000Z" } });
  assert.equal(browser.nodes.lastChangedAt.textContent, displayedTime);
  browser.listeners["wemos-state-update"]({ detail: { ...report, lastChangedAt: "2026-10-03 12:00:00.000" } });
  assert.equal(browser.nodes.lastChangedAt.textContent, displayedTime);
});

test("server keeps actual last change time for unchanged output", async () => {
  const { context, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", OutputState: "OFF"
  });
  assert.equal(events[0].lastChangedAt, "2026-10-03 12:00:00.000");
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", OutputState: "ON"
  });
  assert.equal(events[1].lastChangedAt, events[1].changedAt);
});

test("initial channel API shows time without waiting for a device state event", async () => {
  const browser = createUiHarness();
  await new Promise(setImmediate);
  assert.ok(browser.root.innerHTML.includes('data-active-last-changed-at="OS8">2026-10-03 12:00:00</time>'));
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 12:00:00");
  assert.ok(browser.root.innerHTML.includes("최근 변경"));
  assert.equal(browser.root.innerHTML.includes("마지막 변경자"), false);
});

test("initial channel with no history uses creation time and missing socket time cannot erase it", async () => {
  const browser = createUiHarness(false, [8], { last_changed_at: null });
  browser.listeners["wemos-state-update"]({ detail: {
    type: "state", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", OutputState: "OFF", lastChangedAt: null
  } });
  await new Promise(setImmediate);
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 09:00:00");
  browser.listeners["wemos-state-update"]({ detail: {
    type: "wemosSnapshot", state: { device_id: "WEMOS-D1-002", channels: [{
      output_signal: "OS8", output_state: "OFF", last_changed_at: null
    }] }
  } });
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 09:00:00");
});

test("initial API preserves a newer device change received before rendering", async () => {
  const browser = createUiHarness();
  browser.listeners["wemos-state-update"]({ detail: {
    type: "stateChanged", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", OutputState: "ON",
    source: "new-operator", changedAt: "2026-10-03T04:00:00.000Z"
  } });
  await new Promise(setImmediate);
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 13:00:00");
  assert.equal(browser.nodes.lastSource.textContent, "new-operator");
  assert.equal(browser.nodes.outputState.textContent, "ON");
});

test("last source updates from device state and snapshot, not queued commands", async () => {
  const { listeners, nodes } = createUiHarness();
  await new Promise(setImmediate);
  listeners["wemos-state-update"]({ detail: {
    type: "stateChanged", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", OutputState: "ON", source: "operator-8"
  } });
  assert.equal(nodes.lastSource.textContent, "operator-8");
  listeners["wemos-state-update"]({ detail: {
    type: "commandQueued", deviceId: "WEMOS-D1-002", OutputSignal: "OS8", state: "OFF", requested_by: "pending-operator"
  } });
  assert.equal(nodes.lastSource.textContent, "operator-8");
  listeners["wemos-state-update"]({ detail: {
    type: "wemosSnapshot", state: { device_id: "WEMOS-D1-002", channels: [{
      output_signal: "OS8", input_signal: "IS8", output_state: "OFF", last_change_source: "snapshot-operator"
    }] }
  } });
  assert.equal(nodes.lastSource.textContent, "snapshot-operator");
  assert.equal(nodes.outputState.textContent, "OFF");
});

test("control sends OStr with output command; view-only has no command field", async () => {
  const { listeners, commands } = createUiHarness();
  const button = {
    dataset: { deviceId: "WEMOS-D1-002", pin: "OS8", state: "ON" },
    closest: () => ({ querySelector: () => ({ value: "MOTOR_ON" }) })
  };
  listeners.click({ target: { closest: () => button } });
  assert.equal(commands[0].OStr, "MOTOR_ON");
  assert.equal(commands[0].OutputSignal, "OS8");
  assert.equal(commands[0].severSignal, "ON");
  assert.equal(Object.hasOwn(commands[0], "state"), false);
  assert.equal(commands[0].pin, undefined);
  const view = createUiHarness(true);
  await new Promise(setImmediate);
  assert.equal(view.root.innerHTML.includes("data-command-output-string"), false);
  assert.equal(view.root.innerHTML.includes("data-active-command"), false);
});

test("each channel renders two OStr inputs and each button sends its own text", async () => {
  const { root, listeners, commands } = createUiHarness(false, [1, 2, 3, 4, 5, 6, 7, 8]);
  await new Promise(setImmediate);
  assert.equal([...root.innerHTML.matchAll(/data-command-output-string=/g)].length, 16);
  for (let channel = 1; channel <= 8; channel++) {
    for (const state of ["ON", "OFF"]) {
      assert.ok(root.innerHTML.includes(`data-command-output-string="OS${channel}" data-command-state="${state}"`));
      const fields = { ON: { value: `MOTOR_${channel}_ON` }, OFF: { value: `MOTOR_${channel}_OFF` } };
      const button = {
        dataset: { deviceId: "WEMOS-D1-002", pin: `OS${channel}`, state },
        closest: () => ({ querySelector: selector => {
          const selectedState = /data-command-state="(ON|OFF)"/.exec(selector)?.[1];
          return fields[selectedState] || null;
        } })
      };
      listeners.click({ target: { closest: () => button } });
      const command = commands.at(-1);
      assert.equal(command.OutputSignal, `OS${channel}`);
      assert.equal(command.severSignal, state);
      assert.equal(command.OStr, `MOTOR_${channel}_${state}`);
    }
  }
});

test("empty OStr command preserves the firmware's previous output string", async () => {
  const { context, sent, ws } = createHarness();
  const result = await context.queueWemosCommand(ws.deviceId, "OS8", "ON", "operator", "");
  assert.equal(result.outputString, "previous-command");
  assert.equal(sent[0].OStr, "previous-command");
});

test("firmware IP is persisted and sent to subscribed browsers", async () => {
  const { context, events, sqlCalls, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", state: "OFF", ip: "192.168.0.8"
  });
  const ipUpdate = sqlCalls.find(call => call.sql.includes("SET last_ip=?"));
  assert.deepEqual(Array.from(ipUpdate.params), ["192.168.0.8", ws.deviceId]);
  assert.equal(events[0].ip, "192.168.0.8");
});

test("old contact column names migrate without dropping data or indexes", async () => {
  const { context, sqlCalls } = createHarness();
  const columns = new Set(["input_pin", "output_pin", "input_state"]);
  await context.migrateWemosContactSignalColumns(columns);
  assert.deepEqual(sqlCalls.map(call => call.sql), [
    "ALTER TABLE wemos_channels CHANGE COLUMN input_pin input_signal VARCHAR(20) NOT NULL",
    "ALTER TABLE wemos_channels CHANGE COLUMN output_pin output_signal VARCHAR(20) NOT NULL"
  ]);
  assert.ok(columns.has("input_signal"));
  assert.ok(columns.has("output_signal"));
  assert.equal(columns.has("input_pin"), false);
  await context.migrateWemosContactSignalColumns(columns);
  assert.equal(sqlCalls.length, 2);
});

test("new contact columns require no migration", async () => {
  const { context, sqlCalls } = createHarness();
  await context.migrateWemosContactSignalColumns(new Set(["input_signal", "output_signal"]));
  assert.equal(sqlCalls.length, 0);
});

test("legacy firmware fields are accepted but broadcasts use only signal fields", async () => {
  const { context, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, pin: "OS8", inputPin: "IS8",
    state: "ON", inputState: "OFF"
  });
  assert.equal(events[0].OutputSignal, "OS8");
  assert.equal(events[0].InputSignal, "IS8");
  assert.equal(events[0].pin, undefined);
  assert.equal(events[0].inputPin, undefined);
});

test("signal-based firmware state reaches the browser through server events", async () => {
  const server = createHarness();
  const browser = createUiHarness();
  await server.context.handleWemosDeviceMessage(server.ws, {
    type: "state", deviceId: server.ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
    state: "ON", inputState: "OFF", IStr: "sensor-8", OStr: "motor-8"
  });
  for (const event of server.events) browser.listeners["wemos-state-update"]({ detail: event });
  assert.equal(browser.nodes.inputState.textContent, "OFF");
  assert.equal(browser.nodes.outputState.textContent, "ON");
  assert.equal(browser.nodes.inputString.textContent, "sensor-8");
  assert.equal(browser.nodes.outputString.textContent, "motor-8");
});

test("firmware serialization and command handling use signal fields", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "wemos", "WEMOSD1R1.ino"), "utf8");
  assert.ok(firmware.includes('document["InputSignal"]'));
  assert.ok(firmware.includes('document["OutputSignal"]'));
  assert.ok(firmware.includes('command["OutputSignal"]'));
  assert.equal(/\["(?:pin|inputPin)"\]/.test(firmware), false);
  assert.equal(/\b(?:inputName|outputName|DEVICE_PIN_NAME)\b/.test(firmware), false);
});

test("device OutputState is authoritative over legacy state", async () => {
  const { context, events, ws, sqlCalls } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
    OutputState: "ON", state: "OFF", inputState: "ON", source: "WEMOS"
  });
  assert.equal(events[0].OutputState, "ON");
  assert.equal(events[0].state, "ON");
  assert.equal(sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?")).params[0], "ON");
});

test("device ACK supports OutputState without a legacy state field", async () => {
  const { context, events, ws } = createHarness({
    command_id: "cmd-8", output_signal: "OS8", requested_output_state: "ON", output_message: "motor-8",
    requested_by: "operator", command_status: "DELIVERED"
  });
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", commandId: "cmd-8", OutputSignal: "OS8", OutputState: "ON", success: true
  });
  assert.equal(events.find(event => event.type === "stateChanged").OutputState, "ON");
  assert.equal(events.find(event => event.type === "commandAck").status, "ACKED");
});

function createFirmwareLogicHarness() {
  let time = 0;
  let pendingLine = "";
  const lines = [];
  const context = vm.createContext({
    millis: () => time,
    Serial: {
      print: value => { pendingLine += String(value ?? ""); },
      println: value => { lines.push(pendingLine + String(value ?? "")); pendingLine = ""; }
    }
  });
  const firmware = fs.readFileSync(path.join(__dirname, "..", "wemos", "WEMOSD1R1.ino"), "utf8");
  for (const name of ["printOutputStatus", "applyOutputState", "handleInputSignal"]) {
    const signature = new RegExp(`void ${name}\\([^)]*\\)\\s*\\{`).exec(firmware);
    assert.ok(signature, `${name} definition missing`);
    const end = firmware.indexOf("\n}", signature.index + signature[0].length);
    assert.ok(end > signature.index);
    const body = firmware.slice(signature.index + signature[0].length, end)
      .replace(/\/\/[^\r\n]*/g, "").replace(/\bbool\s+/g, "let ");
    const parameters = name === "applyOutputState" ? "channel, desiredState, source"
      : name === "printOutputStatus" ? "channel, source" : "channel";
    vm.runInContext(`function ${name}(${parameters}) { ${body} }`, context);
  }
  return { context, lines, setTime: value => { time = value; } };
}

test("serial status logs distinguish requested state from actual input and output", () => {
  const { context, lines } = createFirmwareLogicHarness();
  for (let channel = 1; channel <= 8; channel++) {
    context.printOutputStatus({
      inputSignal: `IS${channel}`, outputSignal: `OS${channel}`,
      inputState: true, outputState: false, severSignal: true
    }, "CLIENT");
    assert.equal(lines.at(-1), `[STATUS] IS${channel}=ON | OS${channel}=OFF | severSignal=ON | source=CLIENT`);
  }
});

test("serial string logs use IStr for input strings and OStr for received output strings", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "wemos", "WEMOSD1R1.ino"), "utf8");
  assert.match(firmware, /Serial\.print\("\[STRING TX\] IStr"\);\s*Serial\.print\(channel\.inputSignal \+ 2\);/);
  assert.match(firmware, /Serial\.print\(" \| OStr"\);\s*Serial\.print\(channel->outputSignal \+ 2\);/);
  assert.equal(firmware.includes("[STRING RX]"), false);
  assert.equal(firmware.includes("[STATE TX]"), false);
});

test("serial status lines suppress identical reports while keeping real changes", () => {
  const { context, lines } = createFirmwareLogicHarness();
  const channel = { inputSignal: "IS1", outputSignal: "OS1", inputState: false, outputState: false, severSignal: false };
  context.printOutputStatus(channel, "WEMOS");
  context.printOutputStatus(channel, "WEMOS");
  assert.equal(lines.length, 1);
  channel.inputState = true;
  context.printOutputStatus(channel, "WEMOS");
  assert.equal(lines.length, 2);
  context.applyOutputState(channel, true, "WEMOS");
  assert.equal(lines.length, 3);
  context.printOutputStatus(channel, "WEMOS");
  assert.equal(lines.length, 3);
  assert.equal(channel.stateReportPending, true);
  channel.severSignal = true;
  context.printOutputStatus(channel, "CLIENT");
  context.printOutputStatus(channel, "CLIENT");
  assert.equal(lines.length, 4);
});

test("firmware input debounce drives output and schedules reports for all eight channels", () => {
  const { context, setTime } = createFirmwareLogicHarness();
  for (let index = 1; index <= 8; index++) {
    const channel = {
      inputState: true, outputState: false, lastRawInput: false, debouncedInput: false,
      lastDebounceMs: 0, stateReportPending: false, inputSignal: `IS${index}`, outputSignal: `OS${index}`
    };
    setTime(0);
    context.handleInputSignal(channel);
    setTime(49);
    context.handleInputSignal(channel);
    assert.equal(channel.outputState, false);
    setTime(50);
    context.handleInputSignal(channel);
    assert.equal(channel.outputState, true);
    assert.equal(channel.stateReportPending, true);
    assert.equal(channel.pendingStateSource, "WEMOS");
    channel.inputState = false;
    channel.stateReportPending = false;
    setTime(100);
    context.handleInputSignal(channel);
    setTime(150);
    context.handleInputSignal(channel);
    assert.equal(channel.outputState, false);
    assert.equal(channel.stateReportPending, true);
  }
});

test("unchanged output still reports updated input or a repeated server request", () => {
  const { context, setTime } = createFirmwareLogicHarness();
  const channel = {
    inputState: true, outputState: true, lastRawInput: false, debouncedInput: false,
    lastDebounceMs: 0, stateReportPending: false
  };
  setTime(0);
  context.handleInputSignal(channel);
  setTime(50);
  context.handleInputSignal(channel);
  assert.equal(channel.stateReportPending, true);
  channel.stateReportPending = false;
  context.applyOutputState(channel, true, "CLIENT");
  assert.equal(channel.stateReportPending, true);
  assert.equal(channel.pendingStateSource, "CLIENT");
});

test("web severSignal waits for device OutputState before updating OS and button colors", async () => {
  const browser = createUiHarness();
  await new Promise(setImmediate);
  const server = createHarness();
  for (const desiredState of ["ON", "OFF"]) {
    const previousState = browser.nodes.outputState.textContent;
    const button = {
      dataset: { deviceId: server.ws.deviceId, pin: "OS8", state: desiredState },
      closest: () => ({ querySelector: () => ({ value: "motor-8" }) })
    };
    browser.listeners.click({ target: { closest: () => button } });
    const request = browser.commands.at(-1);
    assert.equal(request.severSignal, desiredState);
    await server.context.queueWemosCommand(request.deviceId, request.OutputSignal, request.severSignal, "operator", request.OStr);
    assert.equal(server.sent.at(-1).severSignal, desiredState);
    for (const event of server.events.splice(0)) browser.listeners["wemos-state-update"]({ detail: event });
    assert.equal(browser.nodes.outputState.textContent, previousState);
    await server.context.handleWemosDeviceMessage(server.ws, {
      type: "state", deviceId: server.ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
      OutputState: desiredState, inputState: "OFF", source: "CLIENT", OStr: "motor-8"
    });
    for (const event of server.events.splice(0)) browser.listeners["wemos-state-update"]({ detail: event });
    assert.equal(browser.nodes.outputState.textContent, desiredState);
    for (const outputButton of browser.buttons) {
      assert.equal(outputButton.active, outputButton.dataset.state === desiredState);
      assert.equal(outputButton.pressed, String(outputButton.dataset.state === desiredState));
    }
  }
});

test("actual browser message handler forwards severSignal and retains control permissions", async () => {
  const server = createHarness();
  const replies = [];
  let permission = 2;
  server.context.ws = { readyState: 1, factoryUser: { username: "operator" }, send: data => replies.push(JSON.parse(data)) };
  server.context.getPermissionLevel = () => permission;
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const handleBrowserMessage = async data => {");
  const end = source.indexOf('\n  ws.on("message",', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.handleBrowserMessageForTest = handleBrowserMessage;`, server.context);
  const request = {
    type: "lamp", deviceId: server.ws.deviceId, OutputSignal: "OS8", severSignal: "OFF", state: "ON", OStr: "motor-8"
  };
  await server.context.handleBrowserMessageForTest(Buffer.from(JSON.stringify(request)));
  assert.equal(server.sent[0].severSignal, "OFF");
  assert.equal(replies[0].ok, true);
  permission = 1;
  await server.context.handleBrowserMessageForTest(Buffer.from(JSON.stringify(request)));
  assert.equal(server.sent.length, 1);
  assert.equal(replies[1].ok, false);
});

test("Wemos admin device count stays beside its heading without the status bar", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "wemos-admin.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "wemos-admin.js"), "utf8");
  assert.doesNotMatch(html, /class="wemos-statusbar"/);
  assert.match(html, /<div class="admin-device-title"><h3>등록 장치<\/h3><span id="deviceCount" class="admin-device-count">0대<\/span><\/div>/);
  assert.match(script, /\$\("deviceCount"\)\.textContent = `\$\{devices\.length\}대`;/);
  assert.doesNotMatch(script, /\$\("(?:user|permission)"\)/);
});