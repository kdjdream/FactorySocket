const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  listeners = new Map();
  inputs = [];
  checked = false;
  hidden = false;
  value = "";
  textContent = "";
  isOpen = false;
  disabled = false;
  style = {};

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    return this.listeners.get(type)?.(event);
  }

  set innerHTML(markup) {
    this.markup = markup;
    this.inputs = [...markup.matchAll(/<input type="checkbox" value="([^"]+)"( checked)?/g)]
      .map(([, value, checked]) => ({ value, checked: Boolean(checked) }));
  }

  get innerHTML() {
    return this.markup || "";
  }

  querySelectorAll(selector) {
    return selector.endsWith(":checked") ? this.inputs.filter(input => input.checked) : this.inputs;
  }

  querySelector() {
    return this.submit ||= new Element();
  }

  showModal() {
    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }
}

const products = [
  { id: 1, product_name: "First", product_code: "P-001" },
  { id: 2, product_name: "Second", product_code: "P-002" }
];

function browser(page, database, user = "tester", legacy = null) {
  const ids = [
    "productSelectButton", "productSelectionCount", "productPicker", "productPickerForm",
    "productSelectAll", "productPickerChoices", "productPickerEmpty", "productPickerCancel", "productPickerMessage"
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const requests = [];
  let failSave = false;
  let failLoad = false;
  const key = `${user}.${page}`;
  const context = vm.createContext({
    document: { getElementById: id => elements[id] ||= new Element() },
    localStorage: {
      getItem: storageKey => storageKey === `factory.product-selection.${page}.${user}` ? legacy : null
    },
    fetch: async (url, options) => {
      assert.equal(url, `/api/me/product-selection/${page}`);
      requests.push({ url, options });
      if (options.method === "PUT") {
        if (failSave) return { ok: false, status: 500, json: async () => ({ error: "Save failed" }) };
        database.set(key, JSON.parse(options.body).selection);
      } else if (failLoad) {
        return { ok: false, status: 500, json: async () => ({ error: "Load failed" }) };
      }
      return { ok: true, status: 200, json: async () => ({ selection: database.get(key) ?? null }) };
    },
    console: { error() {}, warn() {} },
    escapeHtml: value => String(value),
    Set,
    JSON
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "product-selection.js"), "utf8");
  vm.runInContext(source, context);

  const selector = context.createProductSelection(page, () => {});
  selector.setProducts(products);
  return {
    elements, selector, requests, context,
    load: () => selector.load(user),
    failSave: value => { failSave = value; },
    failLoad: value => { failLoad = value; }
  };
}

test("product selector restores database settings across browsers and keeps pages and users separate", async () => {
  const database = new Map();
  const first = browser("view", database);
  const { elements, selector } = first;
  assert.equal(elements.productSelectButton.disabled, true);
  assert.equal(selector.getVisibleProducts().length, 0);
  await first.load();
  assert.deepEqual(selector.getVisibleProducts().map(product => product.id), [1, 2]);

  await elements.productSelectButton.dispatch("click");
  elements.productPickerChoices.inputs[1].checked = false;
  elements.productPickerChoices.dispatch("change");
  await elements.productPickerForm.dispatch("submit", { preventDefault() {} });
  assert.deepEqual(selector.getVisibleProducts().map(product => product.id), [1]);
  assert.deepEqual(database.get("tester.view"), ["1"]);

  const restored = browser("view", database);
  await restored.load();
  assert.deepEqual(restored.selector.getVisibleProducts().map(product => product.id), [1]);
  for (const [page, user] of [["control", "tester"], ["view", "another"]]) {
    const separate = browser(page, database, user);
    await separate.load();
    assert.deepEqual(separate.selector.getVisibleProducts().map(product => product.id), [1, 2]);
  }
  await elements.productSelectButton.dispatch("click");
  elements.productSelectAll.checked = true;
  elements.productSelectAll.dispatch("change");
  await elements.productPickerForm.dispatch("submit", { preventDefault() {} });
  assert.equal(database.get("tester.view"), "*");
  selector.setProducts([...products, { id: 3 }]);
  assert.equal(selector.getVisibleProducts().length, 3);
});

test("empty selection persists and temporarily unavailable products do not erase saved selection", async () => {
  const database = new Map([["tester.view", ["1"]]]);
  const instance = browser("view", database);
  await instance.load();
  instance.selector.setProducts([]);
  assert.equal(instance.selector.getVisibleProducts().length, 0);
  instance.selector.setProducts(products);
  assert.deepEqual(instance.selector.getVisibleProducts().map(product => product.id), [1]);
  await instance.elements.productSelectButton.dispatch("click");
  instance.elements.productSelectAll.checked = false;
  instance.elements.productSelectAll.dispatch("change");
  await instance.elements.productPickerForm.dispatch("submit", { preventDefault() {} });
  assert.deepEqual(database.get("tester.view"), []);
  const restored = browser("view", database);
  await restored.load();
  assert.equal(restored.selector.getVisibleProducts().length, 0);
});

test("legacy browser settings migrate only when the user has no database selection", async () => {
  const database = new Map();
  const instance = browser("control", database, "tester", '["2"]');
  await instance.load();
  assert.deepEqual(database.get("tester.control"), ["2"]);
  assert.deepEqual(instance.selector.getVisibleProducts().map(product => product.id), [2]);
  const another = browser("control", database, "tester", '["1"]');
  await another.load();
  assert.deepEqual(another.selector.getVisibleProducts().map(product => product.id), [2]);
  assert.equal(another.requests.length, 1);
});

test("failed saves leave the dialog open and preserve the last successfully saved selection", async () => {
  const database = new Map([["tester.view", ["1"]]]);
  const instance = browser("view", database);
  await instance.load();
  instance.failSave(true);
  const { elements } = instance;
  await elements.productSelectButton.dispatch("click");
  elements.productSelectAll.checked = true;
  elements.productSelectAll.dispatch("change");
  await elements.productPickerForm.dispatch("submit", { preventDefault() {} });
  assert.equal(elements.productPicker.isOpen, true);
  assert.equal(elements.productPickerMessage.textContent, "Save failed");
  assert.equal(elements.productPickerForm.querySelector().disabled, false);
  assert.deepEqual(instance.selector.getVisibleProducts().map(product => product.id), [1]);
  assert.deepEqual(database.get("tester.view"), ["1"]);
  instance.failSave(false);
  await elements.productPickerForm.dispatch("submit", { preventDefault() {} });
  assert.equal(elements.productPicker.isOpen, false);
  assert.equal(database.get("tester.view"), "*");
});

test("failed loads show an error without displaying all products and can be retried", async () => {
  const instance = browser("view", new Map([["tester.view", ["2"]]]));
  instance.failLoad(true);
  await instance.load();
  assert.match(instance.elements.productSelectionCount.textContent, /Load failed/);
  assert.equal(instance.selector.getVisibleProducts().length, 0);
  instance.failLoad(false);
  await instance.elements.productSelectButton.dispatch("click");
  assert.deepEqual(instance.selector.getVisibleProducts().map(product => product.id), [2]);
  assert.equal(instance.elements.productPicker.isOpen, true);
});

test("both production pages restore selections before rendering and keep them during realtime updates", async () => {
  const database = new Map([["tester.view", ["1"]], ["tester.control", ["2"]]]);
  const liveProducts = products.map((product, index) => ({
    ...product, quantity: (index + 1) * 100, work_quantity: (index + 1) * 10,
    target_quantity: (index + 1) * 50, status: "대기"
  }));
  for (const page of ["view", "control"]) {
    const { context, elements } = browser(page, database);
    const selectionFetch = context.fetch;
    context.fetch = async (url, options) => {
      if (url.startsWith("/api/me/product-selection/")) return selectionFetch(url, options);
      const data = url === "/api/products" ? liveProducts
        : url === "/api/me/settings" ? { sound_enabled: false }
          : { user: { username: "tester", name: "Test", permissionLevel: 8 } };
      return { ok: true, status: 200, json: async () => data };
    };
    context.document.addEventListener = () => {};
    context.document.querySelectorAll = () => [];
    context.document.documentElement = { setAttribute() {} };
    context.window = { dispatchEvent() {} };
    context.location = { protocol: "http:", host: "localhost" };
    context.CustomEvent = class {};
    const sockets = [];
    context.WebSocket = class { constructor() { sockets.push(this); } };
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", `product-${page}.js`), "utf8"), context);
    await new Promise(resolve => setImmediate(resolve));
    if (page === "view") {
      assert.match(elements.productTable.innerHTML, /First/);
      assert.doesNotMatch(elements.productTable.innerHTML, /Second/);
      assert.equal(elements.productCount.textContent, 1);
      assert.equal(elements.totalQuantity.textContent, "100");
      assert.equal(elements.totalWorkQuantity.textContent, "10");
      assert.equal(elements.totalTarget.textContent, "50");
      assert.equal(elements.totalRate.textContent, "20.0%");
      sockets[0].onmessage({ data: JSON.stringify({
        type: "productsChanged", products: [{ ...liveProducts[0], quantity: 150 }, liveProducts[1]]
      }) });
      assert.equal(elements.totalQuantity.textContent, "150");
      assert.doesNotMatch(elements.productTable.innerHTML, /Second/);
    } else {
      assert.match(elements.controls.innerHTML, /Second/);
      assert.doesNotMatch(elements.controls.innerHTML, /First/);
      sockets[0].onmessage({ data: JSON.stringify({
        type: "productsChanged", products: [liveProducts[0], { ...liveProducts[1], product_name: "Updated second" }]
      }) });
      assert.match(elements.controls.innerHTML, /Updated second/);
      assert.doesNotMatch(elements.controls.innerHTML, /First/);
    }
  }
});

test("product selection APIs follow the permission of their associated production page", () => {
  const { requestPermission } = require("..\\level-permissions");
  for (const method of ["GET", "PUT"]) {
    assert.equal(requestPermission(method, "/api/me/product-selection/view"), "production_view");
    assert.equal(requestPermission(method, "/api/me/product-selection/control"), "production_input");
  }
});

function apiHarness() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const PRODUCT_SELECTION_COLUMNS");
  const end = source.indexOf("const User_customization_SWITCH_DESIGNS", start);
  const handlers = {};
  const database = new Map();
  const calls = [];
  let failure = false;
  const guard = () => {};
  const context = vm.createContext({
    requireLogin: guard, requireActiveAccount: guard, requireApproved: guard,
    console: { error() {} },
    app: Object.fromEntries(["get", "put"].map(method => [method, (route, ...middleware) => {
      assert.equal(route, "/api/me/product-selection/:page");
      assert.deepEqual(middleware.slice(0, 3), [guard, guard, guard]);
      handlers[method] = middleware.at(-1);
    }])),
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (failure) throw new Error("DB unavailable");
      const column = sql.includes("product_view_selection") ? "view" : "control";
      const key = `${params[0]}.${column}`;
      if (sql.startsWith("SELECT")) return database.has(key) ? [{ selection: database.get(key) }] : [];
      database.set(key, params[1]);
    }
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    database, calls,
    fail: () => { failure = true; },
    request: async (method, page, selection, id = 7) => {
      const response = {
        statusCode: 200, headers: {},
        status(code) { this.statusCode = code; return this; },
        setHeader(name, value) { this.headers[name] = value; },
        json(data) { this.data = data; }
      };
      await handlers[method]({ user: { id }, params: { page }, body: { selection, user_id: 99 } }, response);
      return response;
    }
  };
}

test("product selection API persists by session user and page, including all and empty selections", async () => {
  const api = apiHarness();
  const initial = await api.request("get", "view");
  assert.equal(initial.data.selection, null);
  assert.equal(initial.headers["Cache-Control"], "no-store");
  await api.request("put", "view", ["1", "1", "2"]);
  assert.equal(api.database.get("7.view"), '["1","2"]');
  await api.request("put", "control", []);
  assert.equal(api.database.get("7.control"), "[]");
  assert.equal(JSON.stringify((await api.request("get", "view")).data.selection), '["1","2"]');
  assert.equal((await api.request("get", "view", undefined, 8)).data.selection, null);
  await api.request("put", "control", "*");
  assert.equal((await api.request("get", "control")).data.selection, "*");
  assert.ok(api.calls.filter(call => call.sql.startsWith("INSERT")).every(call => /ON DUPLICATE KEY UPDATE/.test(call.sql)));
});

test("product selection API rejects invalid pages and selections and surfaces database errors", async () => {
  const api = apiHarness();
  for (const page of ["other", "__proto__", "constructor", "view; DROP TABLE user_setting"]) {
    assert.equal((await api.request("get", page)).statusCode, 400);
    assert.equal((await api.request("put", page, "*")).statusCode, 400);
  }
  for (const value of [null, undefined, {}, 1, ["0"], ["-1"], ["1.5"], ["9007199254740992"], [1], ["1 OR 1=1"]]) {
    assert.equal((await api.request("put", "view", value)).statusCode, 400);
  }
  assert.equal(api.calls.length, 0);
  api.fail();
  assert.equal((await api.request("get", "view")).statusCode, 500);
  assert.equal((await api.request("put", "view", "*")).statusCode, 500);
});

test("existing user setting schema adds missing selection columns without replacing existing data", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = source.indexOf("  for (const column of Object.values(PRODUCT_SELECTION_COLUMNS))");
  const end = source.indexOf("  const User_customizationChannelColumns", start);
  const columns = { view: "product_view_selection", control: "product_control_selection" };
  for (const column of Object.values(columns)) {
    assert.ok(source.includes(`${column} LONGTEXT NULL`));
    assert.ok(schema.includes(`${column} LONGTEXT NULL`));
  }
  const present = new Set(["product_view_selection"]);
  const changes = [];
  const context = vm.createContext({
    PRODUCT_SELECTION_COLUMNS: columns,
    query: async sql => {
      if (sql.startsWith("SHOW COLUMNS")) return present.has(sql.match(/'([^']+)'/)[1]) ? [{}] : [];
      changes.push(sql);
      present.add(sql.match(/ADD COLUMN (\w+)/)[1]);
    }
  });
  await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
  await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
  assert.deepEqual(changes, ["ALTER TABLE user_setting ADD COLUMN product_control_selection LONGTEXT NULL"]);
});
