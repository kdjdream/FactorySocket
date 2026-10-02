const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("server and Wemos browser scripts parse as complete JavaScript files", () => {
  for (const filename of ["server.js", "public/wemos-active-devices.js", "public/wemos-view.js", "public/wemos.js"]) {
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), { filename });
  }
});

function createHarness(command = null) {
  const sqlCalls = [];
  const events = [];
  const sent = [];
  const channel = {
    current_state: "OFF", input_state: "ON", last_source: "operator",
    input_string: "sensor-data", output_string: "previous-command"
  };
  const query = async (sql, params = []) => {
    sqlCalls.push({ sql, params });
    if (sql.includes("SELECT current_state")) return [{ ...channel }];
    if (sql.includes("SELECT device_id,active")) return [{ device_id: "WEMOS-D1-002", active: 1 }];
    if (sql.includes("SELECT output_string")) return [{ output_string: channel.output_string }];
    if (sql.includes("SELECT command_id,pin_name")) return command ? [command] : [];
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
  const inserts = sqlCalls.filter(call => call.sql.includes("INSERT INTO wemos_contact_sets"));
  assert.equal(inserts.length, 8);
  assert.deepEqual(Array.from(inserts[7].params), [ws.deviceId, "채널 08", "IS8", "OS8", 7]);
});

test("firmware state preserves independent input, output and strings", async () => {
  const { context, sqlCalls, events, ws } = createHarness();
  await context.handleWemosDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", state: "ON",
    InputSignal: "IS8", inputState: "OFF", source: "WEMOS", IStr: "sensor-8", OStr: "motor-8"
  });
  const update = sqlCalls.find(call => call.sql.includes("SET current_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "OFF", ws.deviceId, "sensor-8", "motor-8"]);
  assert.equal(events[0].inputState, "OFF");
  assert.equal(events[0].IStr, "sensor-8");
  assert.equal(events[0].InputSignal, "IS8");
  assert.equal(events[0].OutputSignal, "OS8");
  assert.equal(events[0].pin, undefined);
  assert.equal(events[0].inputPin, undefined);
});

test("firmware ACK without telemetry does not erase input state or IStr", async () => {
  const command = {
    command_id: "cmd-1", pin_name: "OS1", desired_state: "ON",
    output_string: "MOTOR_ON", requester: "operator", status: "DELIVERED"
  };
  const { context, sqlCalls, events, ws } = createHarness(command);
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", deviceId: ws.deviceId, commandId: "cmd-1", OutputSignal: "OS1", state: "ON", success: true
  });
  const update = sqlCalls.find(call => call.sql.includes("SET current_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "ON", "operator", "sensor-data", "MOTOR_ON"]);
  assert.equal(events.find(event => event.type === "commandAck").status, "ACKED");
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
    command_id: "cmd-1", pin_name: "OS1", desired_state: "ON", status: "DELIVERED"
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
  assert.ok(sqlCalls[0].sql.includes("SET input_string=?"));
  assert.equal(sqlCalls[0].params[0], "sensor-only");
  assert.ok(sqlCalls[1].sql.includes("last_seen_at=?"));
  assert.equal(events[0].IStr, "sensor-only");
  assert.equal(events[0].OStr, undefined);
});

test("invalid input pairing and ACK for another channel are ignored", async () => {
  const { context, sqlCalls, events, ws } = createHarness({
    command_id: "cmd-1", pin_name: "OS1", desired_state: "ON", status: "DELIVERED"
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
    command_id: "cmd-1", pin_name: "OS1", desired_state: "ON", status: "ACKED"
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

function createUiHarness(viewOnly = false, channels = [8]) {
  const listeners = {};
  const nodes = {
    inputString: { textContent: "sensor" }, outputString: { textContent: "MOTOR_ON" },
    inputState: { textContent: "OFF", dataset: {} }, outputState: { textContent: "OFF", dataset: {} }
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
        return [];
      },
      getElementById: () => root,
      addEventListener: (event, handler) => { listeners[event] = handler; }
    },
    location: { pathname: viewOnly ? "/wemos-view.html" : "/wemos.html" },
    CSS: { escape: value => value }, console,
    fetch: async () => ({ ok: true, json: async () => [{
      device_id: "WEMOS-D1-002", sets: channels.map(channel => ({
        Digital_input: `IS${channel}`, Degital_output: `OS${channel}`, input_signal: `IS${channel}`, output_signal: `OS${channel}`,
        current_state: "OFF", input_state: "ON", input_string: "sensor", output_string: "MOTOR_ON"
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
  assert.ok(root.innerHTML.includes("<span>IStr8: <code"));
  assert.ok(root.innerHTML.includes("<span>OStr8: <code"));
  assert.ok(root.innerHTML.includes('aria-label="OStr8"'));
});

test("string labels use actual channel numbers for all eight and reordered channels", async () => {
  const allChannels = createUiHarness(false, [1, 2, 3, 4, 5, 6, 7, 8]);
  const reorderedChannels = createUiHarness(false, [8, 2]);
  await new Promise(setImmediate);
  for (const channel of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(allChannels.root.innerHTML.includes(`<span>IStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`<span>OStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`aria-label="OStr${channel}"`));
  }
  const labels = [...reorderedChannels.root.innerHTML.matchAll(/<span>([IO]Str[1-8]): <code/g)]
    .map(match => match[1]);
  assert.deepEqual(labels, ["IStr8", "OStr8", "IStr2", "OStr2"]);
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
    "ALTER TABLE wemos_contact_sets CHANGE COLUMN input_pin Digital_input VARCHAR(20) NOT NULL",
    "ALTER TABLE wemos_contact_sets CHANGE COLUMN output_pin Degital_output VARCHAR(20) NOT NULL"
  ]);
  assert.ok(columns.has("digital_input"));
  assert.ok(columns.has("degital_output"));
  assert.equal(columns.has("input_pin"), false);
  await context.migrateWemosContactSignalColumns(columns);
  assert.equal(sqlCalls.length, 2);
});

test("new contact columns require no migration", async () => {
  const { context, sqlCalls } = createHarness();
  await context.migrateWemosContactSignalColumns(new Set(["digital_input", "degital_output"]));
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
  assert.equal(sqlCalls.find(call => call.sql.includes("SET current_state=?,input_state=?")).params[0], "ON");
});

test("device ACK supports OutputState without a legacy state field", async () => {
  const { context, events, ws } = createHarness({
    command_id: "cmd-8", pin_name: "OS8", desired_state: "ON", output_string: "motor-8",
    requester: "operator", status: "DELIVERED"
  });
  await context.handleWemosDeviceMessage(ws, {
    type: "ack", commandId: "cmd-8", OutputSignal: "OS8", OutputState: "ON", success: true
  });
  assert.equal(events.find(event => event.type === "stateChanged").OutputState, "ON");
  assert.equal(events.find(event => event.type === "commandAck").status, "ACKED");
});

function createFirmwareLogicHarness() {
  let time = 0;
  const context = vm.createContext({
    millis: () => time,
    Serial: { print: () => {}, println: () => {} },
    printOutputStatus: () => {}
  });
  const firmware = fs.readFileSync(path.join(__dirname, "..", "wemos", "WEMOSD1R1.ino"), "utf8");
  for (const name of ["applyOutputState", "handleInputSignal"]) {
    const signature = new RegExp(`void ${name}\\([^)]*\\)\\s*\\{`).exec(firmware);
    assert.ok(signature, `${name} definition missing`);
    const end = firmware.indexOf("\n}", signature.index + signature[0].length);
    assert.ok(end > signature.index);
    const body = firmware.slice(signature.index + signature[0].length, end)
      .replace(/\/\/[^\r\n]*/g, "").replace(/\bbool\s+/g, "let ");
    const parameters = name === "applyOutputState" ? "channel, desiredState, source" : "channel";
    vm.runInContext(`function ${name}(${parameters}) { ${body} }`, context);
  }
  return { context, setTime: value => { time = value; } };
}

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