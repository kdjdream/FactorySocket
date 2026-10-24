const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const deviceFixtures = [
  { device_id: "ACTIVE", device_name: "Active", is_enabled: 1, is_visible: 1 },
  { device_id: "HIDDEN", device_name: "Hidden", is_enabled: "1", is_visible: 0 },
  { device_id: "DISABLED", device_name: "Disabled", is_enabled: 0, is_visible: 1 },
  { device_id: "DISABLED-STRING", device_name: "Disabled string", is_enabled: "0" }
];

test("device report options contain enabled devices only and disable querying when none remain", async () => {
  const source = read("public\\device-report.js");
  const start = source.indexOf("  async function initialize()");
  const end = source.indexOf("  initialize();", start);
  for (const fixtures of [deviceFixtures, deviceFixtures.filter(device => Number(device.is_enabled) === 0)]) {
    const select = {
      options: [],
      replaceChildren(...options) { this.options = options; },
      append(option) { this.options.push(option); }
    };
    const elements = {};
    const context = vm.createContext({
      deviceSelect: select, devices: [],
      startInput: { addEventListener() {} }, endInput: { addEventListener() {} },
      inputDate: () => "2026-10-24T12:00", updateWeekdays() {}, renderChannelOptions() {},
      make: (_tag, textContent) => ({ textContent }),
      element: id => elements[id] ||= {},
      message: text => { elements.message = text; },
      fetch: async () => ({ ok: true, status: 200, json: async () => fixtures })
    });
    vm.runInContext(source.slice(start, end), context);
    await context.initialize();
    assert.deepEqual(select.options.map(option => option.value), fixtures === deviceFixtures ? ["ACTIVE", "HIDDEN"] : []);
    assert.equal(select.disabled, fixtures !== deviceFixtures);
    assert.equal(elements.reportSubmit.disabled, fixtures !== deviceFixtures);
    if (select.disabled) assert.match(elements.message, /사용 중인 디바이스/);
  }
});

test("schedule device and channel choices exclude disabled devices but retain enabled invisible devices", async () => {
  const source = read("public\\device-schedule.js");
  const start = source.indexOf("  function fillSelect(");
  const end = source.indexOf("  async function loadSchedules()", start);
  const elements = {
    "#scheduleDevice": { value: "", options: [] },
    "#scheduleChannel": { value: "", innerHTML: "" }
  };
  const context = vm.createContext({
    devices: [],
    $: selector => elements[selector],
    esc: String,
    api: async () => deviceFixtures.map(device => ({ ...device, sets: [{ output_signal: "OS1", channel_name: device.device_name }] }))
  });
  vm.runInContext(source.slice(start, end), context);
  await context.loadDevices();
  assert.match(elements["#scheduleDevice"].innerHTML, /value="ACTIVE"/);
  assert.match(elements["#scheduleDevice"].innerHTML, /value="HIDDEN"/);
  assert.doesNotMatch(elements["#scheduleDevice"].innerHTML, /DISABLED/);
  for (const [id, hasChannel] of [["ACTIVE", true], ["HIDDEN", true], ["DISABLED", false]]) {
    elements["#scheduleDevice"].value = id;
    context.updateChannels();
    assert.equal(elements["#scheduleChannel"].innerHTML.includes('value="OS1"'), hasChannel);
  }
});

test("mapping choices exclude disabled products and devices without filtering visibility", () => {
  const source = read("public\\product-channel-link.js");
  const start = source.indexOf("function renderMeta()");
  const end = source.indexOf("function renderMappings()", start);
  const elements = {
    productSelect: {}, deviceSelect: { value: "" }, channelSelect: {}
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    mappingMeta: {
      products: [
        { id: 1, product_code: "ACTIVE-PRODUCT", product_name: "Active", is_enabled: "1" },
        { id: 2, product_code: "DISABLED-PRODUCT", product_name: "Disabled", is_enabled: 0 }
      ],
      channels: deviceFixtures.map(device => ({
        device_id: device.device_id, device_name: device.device_name,
        device_is_enabled: device.is_enabled, device_is_visible: device.is_visible,
        output_signal: "OS1", channel_name: "Hidden channel", is_visible: 0
      }))
    },
    escapeHtml: String
  });
  vm.runInContext(source.slice(start, end), context);
  context.renderMeta();
  assert.match(elements.productSelect.innerHTML, /ACTIVE-PRODUCT/);
  assert.doesNotMatch(elements.productSelect.innerHTML, /DISABLED-PRODUCT/);
  assert.match(elements.deviceSelect.innerHTML, /value="ACTIVE"/);
  assert.match(elements.deviceSelect.innerHTML, /value="HIDDEN"/);
  assert.doesNotMatch(elements.deviceSelect.innerHTML, /DISABLED/);
  elements.deviceSelect.value = "HIDDEN";
  context.renderChannelOptions();
  assert.match(elements.channelSelect.innerHTML, /OS1/);
  elements.deviceSelect.value = "DISABLED";
  context.renderChannelOptions();
  assert.doesNotMatch(elements.channelSelect.innerHTML, /OS1/);
});

function mappingApi(disabledProduct = false, disabledDevice = false) {
  const source = read("server.js");
  const start = source.indexOf('app.get("/api/admin/product-channel-mappings/meta"');
  const end = source.indexOf('app.delete("/api/admin/product-channel-mappings/:id"', start);
  const handlers = {};
  const writes = [];
  const queries = [];
  const context = vm.createContext({
    app: Object.fromEntries(["get", "post", "put"].map(method => [method, (route, _middleware, handler) => {
      handlers[`${method} ${route}`] = handler;
    }])),
    productChannelAdminMiddleware: [],
    parseOutputSignal: value => value,
    console,
    query: async sql => {
      queries.push(sql);
      if (/^SELECT product_id/.test(sql)) {
        assert.match(sql, /is_enabled=1/);
        return disabledProduct ? [] : [{ product_id: 1 }];
      }
      if (/SELECT c.channel_id/.test(sql)) {
        assert.match(sql, /d.is_enabled=1/);
        return disabledDevice ? [] : [{ channel_id: 1 }];
      }
      if (/^INSERT|^UPDATE/.test(sql.trim())) writes.push(sql);
      return [{ mapping_id: 1 }];
    }
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    writes, queries,
    request: async (method, route) => {
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; }
      };
      await handlers[`${method} ${route}`]({
        params: { id: "1" }, user: { id: 7 },
        body: { productId: 1, deviceId: "ACTIVE", outputSignal: "OS1", mappingName: "Line" }
      }, response);
      return response;
    }
  };
}

test("mapping metadata filters enabled rows while the existing mapping list remains unfiltered", async () => {
  const api = mappingApi();
  await api.request("get", "/api/admin/product-channel-mappings/meta");
  assert.match(api.queries[0], /WHERE is_enabled=1/);
  assert.match(api.queries[1], /WHERE d.is_enabled=1/);
  await api.request("get", "/api/admin/product-channel-mappings");
  assert.doesNotMatch(api.queries[2], /WHERE.*is_enabled/);
});

test("mapping create and update reject disabled selections and accept enabled selections", async () => {
  for (const [method, route] of [["post", "/api/admin/product-channel-mappings"], ["put", "/api/admin/product-channel-mappings/:id"]]) {
    for (const [productDisabled, deviceDisabled] of [[true, false], [false, true], [false, false]]) {
      const api = mappingApi(productDisabled, deviceDisabled);
      const response = await api.request(method, route);
      assert.equal(response.statusCode, productDisabled || deviceDisabled ? 404 : method === "post" ? 201 : 200);
      assert.equal(api.writes.length, productDisabled || deviceDisabled ? 0 : 1);
    }
  }
});

test("schedule create and update reject disabled device targets before writing schedules", async () => {
  const source = read("server.js");
  const start = source.indexOf('app.post("/api/device/schedules",');
  const end = source.indexOf('app.patch("/api/device/schedules/:id/enabled"', start);
  for (const enabled of [false, true]) {
    const handlers = {};
    const writes = [];
    const context = vm.createContext({
      app: Object.fromEntries(["post", "put"].map(method => [method, (_route, ...args) => { handlers[method] = args.at(-1); }])),
      requireLogin() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {},
      normalizeDevicePin: value => value, DEVICE_OUTPUT_PINS: new Set(["OS1"]),
      validateScheduleInput: () => ({}), console,
      query: async sql => {
        if (sql.startsWith("SELECT d.device_code")) {
          assert.match(sql, /d.is_enabled=1/);
          return enabled ? [{ device_id: "ACTIVE" }] : [];
        }
        if (/^INSERT|^UPDATE/.test(sql)) writes.push(sql);
        return [{ schedule_id: 1, device_id: "ACTIVE", output_signal: "OS1" }];
      }
    });
    vm.runInContext(source.slice(start, end), context);
    for (const method of ["post", "put"]) {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; } };
      await handlers[method]({ params: { id: 1 }, user: { id: 7, username: "tester" }, body: { device_id: "ACTIVE", output_signal: "OS1" } }, response);
      assert.equal(response.statusCode, enabled ? method === "post" ? 201 : 200 : 400);
    }
    assert.equal(writes.length, enabled ? 2 : 0);
  }
});
