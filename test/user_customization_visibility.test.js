const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Config = require("../public/user_customization_graph_config");

const client = fs.readFileSync(path.join(__dirname, "../public/user_customization.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

function load(context, source, ...names) {
  for (const name of names) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(match, name);
    const end = source.indexOf("\n}", match.index) + 2;
    vm.runInContext(source.slice(match.index, end), context);
  }
}

function fixture() {
  const channels = [
    { output_signal: "OS1", channel_name: "Active", is_active: 1, web_control_enabled: 1 },
    { output_signal: "OS2", channel_name: "Inactive", is_active: 0, web_control_enabled: 1 },
    { output_signal: "OS3", channel_name: "Read only", is_active: 1, web_control_enabled: 0 }
  ];
  const devices = [
    { device_id: "VISIBLE", device_name: "Visible device", is_visible: 1, sets: channels },
    { device_id: "HIDDEN", device_name: "Hidden device", is_visible: 0, sets: channels }
  ];
  const selection = devices.flatMap(device => channels.flatMap(channel => ["switch", "lamp", "graph"].map(display_type => ({
    device_id: device.device_id, output_signal: channel.output_signal, display_type
  }))));
  return { devices, channels, selection };
}

function harness() {
  const data = fixture();
  const elements = Object.fromEntries([
    "User_customizationGrid", "User_customizationCount", "User_customizationEmpty", "User_customizationDeviceFilter",
    "User_customizationSearch", "User_customizationChoices", "User_customizationPickerMessage"
  ].map(key => [key, { value: "", querySelectorAll: () => [] }]));
  elements.User_customizationGrid.querySelectorAll = () => [];
  const context = vm.createContext({
    User_customizationDevices: data.devices,
    User_customizationSelection: data.selection,
    User_customizationElements: elements,
    User_customizationRenderedMarkup: "",
    User_customizationSaving: false,
    User_customizationSyncPopups() {},
    User_customizationUpdateSwitches() {},
    User_customizationGraphConfig: Config,
    User_customizationChannelSettings: () => Config.channelDefaults,
    User_customizationAppearance: () => "",
    User_customizationRotationArrows: () => "",
    User_customizationGraphMarkup: () => "<div></div>",
    User_customizationPickerType: "switch",
    User_customizationFilterChoices() {},
    User_customizationUpdateSelectionCount() {},
    User_customization_SWITCH_OPTIONS: [["design-01", "Switch"]],
    User_customization_LAMP_OPTIONS: [["lamp-01", "Lamp"]],
    User_customization_GRAPH_OPTIONS: [["graph-01", "Graph"]]
  });
  load(context, client, "User_customizationItemKey", "User_customizationLookup",
    "User_customizationCanDisplay", "User_customizationVisibleSelection",
    "User_customizationEscape", "User_customizationSwitchDesignFor");
  return { ...data, elements, context };
}

test("all display types require a visible device and active channel; switches also require web control", () => {
  const { context } = harness();
  for (const is_visible of [0, 1, "0", "1", undefined, null, 2]) {
    for (const is_active of [0, 1, "0", "1", undefined, null, 2]) {
      for (const web_control_enabled of [0, 1, "0", "1", undefined, null, 2]) {
        for (const type of ["switch", "button", undefined, "lamp", "graph"]) {
          const expected = Number(is_visible) === 1 && Number(is_active) === 1
            && (["lamp", "graph"].includes(type) || Number(web_control_enabled) === 1);
          assert.equal(context.User_customizationCanDisplay({ is_visible }, { is_active, web_control_enabled }, type), expected);
        }
      }
    }
  }
  assert.equal(context.User_customizationCanDisplay(null, null, "lamp"), false);
});

test("saved cards and counts exclude hidden selections without deleting their designs", () => {
  const { context, selection, elements, devices, channels } = harness();
  load(context, client, "User_customizationRender");
  context.User_customizationRender();
  assert.equal(elements.User_customizationCount.textContent, "5개 채널");
  assert.equal(elements.User_customizationEmpty.hidden, true);
  assert.equal((elements.User_customizationGrid.innerHTML.match(/<article /g) || []).length, 5);
  assert.doesNotMatch(elements.User_customizationGrid.innerHTML, /data-device-id="HIDDEN"|data-pin="OS2"/);
  assert.equal(selection.length, 18);
  devices[0].is_visible = 0;
  context.User_customizationRender();
  assert.equal(elements.User_customizationCount.textContent, "0개 채널");
  assert.equal(elements.User_customizationGrid.innerHTML, "");
  assert.equal(elements.User_customizationEmpty.hidden, false);
  devices[0].is_visible = 1;
  channels[1].is_active = 1;
  context.User_customizationRender();
  assert.equal(elements.User_customizationCount.textContent, "8개 채널");
});

test("device dropdown and all picker sections apply the same visibility rules", () => {
  const { context, elements, devices } = harness();
  load(context, client, "User_customizationUpdateDeviceFilter", "User_customizationRenderChoices");
  context.User_customizationRenderChoices();
  const choices = elements.User_customizationChoices.innerHTML;
  assert.match(elements.User_customizationDeviceFilter.innerHTML, /VISIBLE/);
  assert.doesNotMatch(elements.User_customizationDeviceFilter.innerHTML, /HIDDEN/);
  assert.doesNotMatch(choices, /data-device-id="HIDDEN"|data-pin="OS2"/);
  assert.equal((choices.match(/class="simple-channel-checkbox"/g) || []).length, 5);
  const sections = choices.split('<section class="simple-picker-section"').slice(1);
  assert.doesNotMatch(sections[0], /data-pin="OS3"/);
  assert.match(sections[1], /data-pin="OS3"/);
  assert.match(sections[2], /data-pin="OS3"/);
  elements.User_customizationDeviceFilter.value = "VISIBLE";
  devices[0].is_visible = 0;
  context.User_customizationUpdateDeviceFilter();
  assert.equal(elements.User_customizationDeviceFilter.value, "");
  assert.doesNotMatch(elements.User_customizationDeviceFilter.innerHTML, /VISIBLE|HIDDEN/);
});

test("an already open picker hides channels when their visibility or web control changes", () => {
  const { context, elements, devices, channels } = harness();
  const choices = ["switch", "lamp", "graph"].map(displayType => ({
    dataset: { deviceId: "VISIBLE", pin: "OS1", displayType, search: "active" }
  }));
  elements.User_customizationChoices.querySelectorAll = selector => selector === ".simple-choice" ? choices : [];
  elements.User_customizationPickerTypes = { querySelectorAll: () => [] };
  load(context, client, "User_customizationFilterChoices");
  context.User_customizationFilterChoices();
  assert.ok(choices.every(choice => !choice.hidden));
  channels[0].web_control_enabled = 0;
  context.User_customizationFilterChoices();
  assert.deepEqual(choices.map(choice => choice.hidden), [true, false, false]);
  channels[0].is_active = 0;
  context.User_customizationFilterChoices();
  assert.ok(choices.every(choice => choice.hidden));
  channels[0].is_active = 1;
  devices[0].is_visible = 0;
  context.User_customizationFilterChoices();
  assert.ok(choices.every(choice => choice.hidden));
});

test("selection count excludes checked choices that are no longer displayable", () => {
  const { context, elements, channels } = harness();
  const inputs = ["switch", "lamp", "graph"].map(displayType => ({
    dataset: { deviceId: "VISIBLE", pin: "OS1", displayType }
  }));
  elements.User_customizationSelectionCount = {};
  elements.User_customizationChoices.querySelectorAll = () => inputs;
  load(context, client, "User_customizationUpdateSelectionCount");
  context.User_customizationUpdateSelectionCount();
  assert.equal(elements.User_customizationSelectionCount.textContent, "3개 선택");
  channels[0].web_control_enabled = 0;
  context.User_customizationUpdateSelectionCount();
  assert.equal(elements.User_customizationSelectionCount.textContent, "2개 선택");
  channels[0].is_active = 0;
  context.User_customizationUpdateSelectionCount();
  assert.equal(elements.User_customizationSelectionCount.textContent, "0개 선택");
});

test("picker save preserves hidden preferences but removes unchecked visible choices", async () => {
  const { context, elements, selection } = harness();
  let submit, saved;
  elements.User_customizationPickerForm = { addEventListener: (_type, handler) => { submit = handler; } };
  elements.User_customizationPicker = { close() {} };
  context.User_customizationSaveSelection = async channels => { saved = channels; return true; };
  const start = client.indexOf('User_customizationElements.User_customizationPickerForm.addEventListener("submit"');
  const end = client.indexOf("\nfunction User_customizationHandleSettingsClick", start);
  vm.runInContext(client.slice(start, end), context);
  await submit({ preventDefault() {} });
  assert.equal(saved.length, 13);
  assert.ok(saved.every(item => !context.User_customizationVisibleSelection().includes(item)));
  assert.equal(selection.length, 18);
});

test("moving visible cards uses saved selection positions even when hidden cards precede them", async () => {
  const { context, elements, selection } = harness();
  const hidden = selection.find(item => item.device_id === "HIDDEN");
  const visible = selection.filter(item => item.device_id === "VISIBLE" && item.output_signal === "OS1");
  context.User_customizationSelection = [hidden, visible[0], selection[3], visible[1], visible[2]];
  let saved, focused = false;
  elements.User_customizationGrid.children = Array.from({ length: 3 }, () => ({
    querySelector: () => ({ focus() { focused = true; } })
  }));
  context.User_customizationSaveSelection = async channels => { saved = channels; };
  load(context, client, "User_customizationMove");
  context.User_customizationMove(0, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved[0], hidden);
  const displayed = saved.filter(item => context.User_customizationCanDisplay(
    context.User_customizationLookup(item).device, context.User_customizationLookup(item).channel, item.display_type));
  assert.deepEqual(Array.from(displayed), [visible[1], visible[0], visible[2]]);
  assert.equal(focused, true);
});

test("switch buttons enforce ON and OFF flags only for the requested transition", () => {
  const { context } = harness();
  load(context, client, "User_customizationControlBlockReason");
  const device = { is_visible: 1, is_enabled: 1 };
  const user = { status: "APPROVED" };
  for (const state of ["ON", "OFF"]) {
    for (const web_on_enabled of [0, 1]) for (const web_off_enabled of [0, 1]) {
      const channel = { is_active: 1, web_control_enabled: 1, output_state: state, web_on_enabled, web_off_enabled };
      const reason = context.User_customizationControlBlockReason(user, device, channel, true, false, { device_control: true });
      const allowed = state === "OFF" ? web_on_enabled : web_off_enabled;
      assert.equal(Boolean(reason), !allowed);
      if (!allowed) assert.match(reason, new RegExp(`${state === "OFF" ? "ON" : "OFF"} 스위치`));
    }
  }
});

test("popups close when a saved channel no longer has a visible card", () => {
  const { context, elements } = harness();
  const popups = new Map();
  const popup = { closed: false, close() { this.closed = true; } };
  popups.set('["HIDDEN","OS1","graph"]', popup);
  context.User_customizationPopupWindows = popups;
  elements.User_customizationGrid.children = [];
  load(context, client, "User_customizationSyncPopups");
  context.User_customizationSyncPopups();
  assert.equal(popup.closed, true);
  assert.equal(popups.size, 0);
});

test("customization GET filters devices and active channels and retains saved selections", async () => {
  const { devices, selection } = fixture();
  const managed = devices.map(device => ({
    ...device, sets: device.sets.map(channel => ({ ...channel, is_visible: channel.is_active }))
  }));
  let handler;
  const context = vm.createContext({
    requireLogin() {}, requireActiveAccount() {}, requireApproved() {},
    app: { get: (_urls, ...handlers) => { handler = handlers.at(-1); } },
    query: async () => [{ User_customization: JSON.stringify(selection) }],
    getManagedDeviceDevices: async () => managed,
    validateUser_customizationChannels: channels => ({ channels }),
    User_customizationGraphConfig: Config,
    console
  });
  const start = server.indexOf('app.get(["/api/me/User_customization"');
  const end = server.indexOf('app.put(["/api/me/User_customization"', start);
  vm.runInContext(server.slice(start, end), context);
  let body;
  await handler({ user: { id: 1 } }, { json(value) { body = value; }, status() { assert.fail("GET failed"); } });
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].is_visible, 1);
  assert.deepEqual(Array.from(body.devices[0].sets, channel => channel.output_signal), ["OS1", "OS3"]);
  assert.ok(body.devices[0].sets.every(channel => channel.is_active === 1));
  assert.equal(body.channels.length, 18);
});

test("server rejects hidden, inactive, read-only and disallowed-direction web commands before queueing", async () => {
  for (const state of ["ON", "OFF"]) for (const flags of [
    { is_visible: 0 }, { is_active: 0 }, { web_control_enabled: 0 },
    { [state === "ON" ? "web_on_enabled" : "web_off_enabled"]: 0 },
    { is_active: null }, { web_control_enabled: 2 }
  ]) {
    let reachedQueue = false;
    const context = vm.createContext({
      normalizeDevicePin: pin => pin,
      parseDeviceState: state => state,
      DEVICE_OUTPUT_PINS: new Set(["OS1"]),
      query: async sql => sql.startsWith("SELECT is_enabled")
        ? [{ is_enabled: 1, is_visible: 1, ...flags }]
        : [{ is_active: 1, web_control_enabled: 1, web_on_enabled: 1, web_off_enabled: 1, ...flags }],
      pool: { getConnection() { reachedQueue = true; throw new Error("Reached queue"); } }
    });
    load(context, server, "queueDeviceCommand");
    await assert.rejects(context.queueDeviceCommand("DEVICE", "OS1", state, "user", ""), /숨겨진|조회 전용|비활성화/);
    assert.equal(reachedQueue, false);
  }
});

test("scheduled commands retain their existing visibility and web-control exceptions", async () => {
  const context = vm.createContext({
    normalizeDevicePin: pin => pin,
    parseDeviceState: state => state,
    DEVICE_OUTPUT_PINS: new Set(["OS1"]),
    query: async sql => sql.startsWith("SELECT is_enabled")
      ? [{ is_enabled: 1, is_visible: 0 }]
      : [{ is_active: 0, web_control_enabled: 0, web_on_enabled: 0, web_off_enabled: 0 }],
    crypto: { randomUUID() { throw new Error("Schedule passed control validation"); } }
  });
  load(context, server, "queueDeviceCommand");
  for (const state of ["ON", "OFF"]) {
    await assert.rejects(context.queueDeviceCommand("DEVICE", "OS1", state, "scheduler", "", null, 1),
      /Schedule passed control validation/);
  }
});
