const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const postcss = require("postcss");

test("schedule JSON responses serialize BigInt IDs without precision loss", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const express = require("express");
  const app = express();
  const setting = source.split(/\r?\n/).find(line => line.startsWith('app.set("json replacer"'));
  assert.ok(setting);
  vm.runInNewContext(setting, { app });
  const row = { schedule_id: 18446744073709551615n, device_id: "DEVICE-1", minute_value: 37, is_enabled: 1, schedule_time: null };
  const serialize = payload => JSON.parse(JSON.stringify(payload, app.get("json replacer")));
  const single = serialize(row);
  assert.equal(single.schedule_id, "18446744073709551615");
  assert.equal(single.minute_value, 37);
  assert.equal(single.is_enabled, 1);
  assert.equal(single.schedule_time, null);
  const list = serialize({ items: [row, { schedule_id: 1n }], total: 2, page: 1, limit: 500 });
  assert.equal(list.items[0].schedule_id, "18446744073709551615");
  assert.equal(list.items[1].schedule_id, "1");
  assert.equal(list.total, 2);
  assert.equal(row.schedule_id, 18446744073709551615n);
});

test("channel schedule buttons fetch their own earliest active schedule", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-active.js"), "utf8");
  const buttons = [
    { dataset: { deviceId: "DEVICE-1", pin: "OS1" } },
    { dataset: { deviceId: "DEVICE-1", pin: "OS2" } },
    { dataset: { deviceId: "DEVICE-2", pin: "OS1" } }
  ];
  const requests = [];
  const context = vm.createContext({
    URLSearchParams, console,
    document: { querySelectorAll: () => buttons },
    fetch: async (url, options) => {
      const params = new URL(url, "http://localhost").searchParams;
      requests.push(params);
      assert.equal(options.cache, "no-store");
      assert.equal(params.get("is_enabled"), "1");
      assert.equal(params.get("next_only"), "1");
      assert.equal(params.get("limit"), "1");
      assert.equal(params.get("sort_by"), "time");
      assert.equal(params.get("sort_order"), "asc");
      const empty = params.get("output_signal") === "OS2";
      const time = params.get("device_id") === "DEVICE-1" ? "2026-10-11 09:37:00" : "2026-10-12T14:15:00";
      const outputMessage = params.get("device_id") === "DEVICE-1" ? "<output>\nchannel command" : null;
      return { ok: true, json: async () => ({ items: empty ? [] : [{ next_run_at: time, action_state: "ON", repeat_type: "HOURLY", ostr_payload: outputMessage, output_message: "unrelated channel string" }] }) };
    }
  });
  vm.runInContext(source.slice(source.indexOf("  async function refreshScheduleLabels("), source.indexOf("  function ensureScheduleDialog(")), context);
  await context.refreshScheduleLabels();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(params => [params.get("device_id"), params.get("output_signal")]), buttons.map(button => [button.dataset.deviceId, button.dataset.pin]));
  assert.equal(buttons[0].textContent, "10-11 09:37 ON\n<output>\nchannel command");
  assert.equal(buttons[1].textContent, "Non scheduled");
  assert.equal(buttons[2].textContent, "10-12 14:15 ON\n");
  assert.equal(buttons[0].title, "<output>\nchannel command");
  assert.equal(buttons[0].textContent.includes("HOURLY"), false);
});

test("schedule completion event immediately refreshes only its channel label", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-active.js"), "utf8");
  const buttons = [
    { dataset: { deviceId: "DEVICE-1", pin: "OS1" }, textContent: "stale", title: "stale" },
    { dataset: { deviceId: "DEVICE-1", pin: "OS2" }, textContent: "keep OS2", title: "keep OS2" },
    { dataset: { deviceId: "DEVICE-2", pin: "OS1" }, textContent: "keep DEVICE-2", title: "keep DEVICE-2" }
  ];
  const requests = [];
  let onStateUpdate;
  const context = vm.createContext({
    URLSearchParams, console,
    window: { addEventListener: (name, listener) => { if (name === "device-state-update") onStateUpdate = listener; } },
    document: { querySelectorAll: () => buttons },
    fetch: async url => {
      requests.push(new URL(url, "http://localhost").searchParams);
      return { ok: true, json: async () => ({ items: [] }) };
    },
    applyConnectionState() {}, rememberLiveMessage() {}
  });
  const refreshStart = source.indexOf("  async function refreshScheduleLabels(");
  const refreshEnd = source.indexOf("  function ensureScheduleDialog(", refreshStart);
  const listenerStart = source.indexOf('  window.addEventListener("device-state-update", event => {');
  const listenerEnd = source.indexOf("\n  });", listenerStart) + "\n  });".length;
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart && listenerStart >= 0 && listenerEnd > listenerStart);
  vm.runInContext(source.slice(refreshStart, refreshEnd) + source.slice(listenerStart, listenerEnd), context);
  onStateUpdate({ detail: { type: "scheduleChanged", deviceId: "DEVICE-1", OutputSignal: "OS1" } });
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].get("device_id"), requests[0].get("output_signal")], ["DEVICE-1", "OS1"]);
  assert.equal(buttons[0].textContent, "Non scheduled");
  assert.equal(buttons[1].textContent, "keep OS2");
  assert.equal(buttons[2].textContent, "keep DEVICE-2");
});

test("next channel schedule API excludes completed schedules and limits earliest result", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  let handler;
  const row = { schedule_id: "601", device_id: "DEVICE-1", output_signal: "OS1", next_run_at: "2026-10-11 09:37:00", ostr_payload: "scheduled output" };
  const context = vm.createContext({
    console, requireLogin() {}, requireActiveAccount() {}, requireApproved() {},
    requireScheduleListAccess(_req, _res, next) { next(); },
    app: { get: (route, ...handlers) => { assert.equal(route, "/api/device/schedules"); handler = handlers.at(-1); } },
    query: async (sql, params) => {
      assert.doesNotMatch(sql, /c\.output_message/);
      assert.match(sql, /WHERE s\.device_id=\? AND s\.output_signal=\? AND s\.is_enabled=\? AND s\.next_run_at IS NOT NULL/);
      assert.match(sql, /ORDER BY COALESCE\(s\.next_run_at,s\.schedule_time\) ASC,s\.schedule_id DESC LIMIT 1 OFFSET 0/);
      assert.deepEqual(Array.from(params), ["DEVICE-1", "OS1", 1]);
      return [row];
    }
  });
  vm.runInContext(source.slice(source.indexOf('app.get("/api/device/schedules",'), source.indexOf('app.get("/api/device/schedules/:id",')), context);
  const response = { json(data) { this.body = data; }, status(code) { throw new Error(`Unexpected response status ${code}`); } };
  await handler({ query: { device_id: "DEVICE-1", output_signal: "OS1", is_enabled: "1", next_only: "1", limit: "1", sort_by: "time", sort_order: "asc" } }, response);
  assert.equal(response.body.items[0], row);
  assert.equal(response.body.limit, 1);
});

test("schedule output column migration preserves legacy data and skips migrated schemas", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const migration = source.slice(source.indexOf("async function migrateScheduleOutputString("), source.indexOf("function scheduleNextRun("));
  for (const originalColumn of ["istr_payload", "ostr_payload"]) {
    let columnName = originalColumn;
    const storedRow = { [originalColumn]: "existing schedule output" };
    const statements = [];
    const context = vm.createContext({ query: async sql => {
      statements.push(sql);
      if (sql.startsWith("SELECT")) {
        assert.match(sql, /TABLE_SCHEMA=DATABASE\(\) AND TABLE_NAME='device_schedule'/);
        return [{ column_name: columnName }];
      }
      assert.equal(sql, "ALTER TABLE device_schedule CHANGE COLUMN istr_payload ostr_payload TEXT NULL");
      storedRow.ostr_payload = storedRow.istr_payload;
      delete storedRow.istr_payload;
      columnName = "ostr_payload";
    } });
    vm.runInContext(migration, context);
    await context.migrateScheduleOutputString();
    await context.migrateScheduleOutputString();
    assert.equal(columnName, "ostr_payload");
    assert.equal(statements.filter(sql => sql.startsWith("ALTER")).length, originalColumn === "istr_payload" ? 1 : 0);
    assert.equal(storedRow.ostr_payload, "existing schedule output");
  }
  for (const filename of ["server.js", "schema.sql", "migrate-device-schedule.sql"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    const definition = text.slice(text.indexOf("CREATE TABLE" + (filename === "schema.sql" ? "" : " IF NOT EXISTS") + " device_schedule"));
    const table = definition.slice(0, definition.indexOf(") ENGINE=InnoDB"));
    assert.match(table, /ostr_payload TEXT NULL/);
    assert.doesNotMatch(table, /\bistr_payload\b/);
  }
});

test("schedule execution queues saved strings as OStr without an IStr override", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const queued = [];
  const scheduleEvents = [];
  const rows = [
    { schedule_id: "1", repeat_type: "ONCE", ostr_payload: "scheduled output", istr_payload: "do not send input" },
    { schedule_id: "2", repeat_type: "DAILY", istr_payload: "legacy output" },
    { schedule_id: "3", repeat_type: "ONCE", ostr_payload: "", istr_payload: "must not replace empty output" }
  ].map(row => ({ device_id: "DEVICE-1", output_signal: "OS1", action_state: "ON", ...row }));
  const context = vm.createContext({
    console, resolveScheduleSource: async source => `${source}:reservation_owner`, toKoreaDateTime: () => "2026-10-10 09:00:00", scheduleNextRun: () => "2026-10-11 09:00:00",
    query: async sql => sql.startsWith("SELECT") ? rows : { affectedRows: 1 },
    queueDeviceCommand: async (...args) => queued.push(args),
    broadcastDeviceBrowsers: event => scheduleEvents.push(event)
  });
  vm.runInContext(source.slice(source.indexOf("let scheduleTickBusy ="), source.indexOf("async function start()")), context);
  await context.runDueSchedules();
  assert.equal(queued.length, 3);
  assert.deepEqual(queued.map(args => args[4]), ["scheduled output", "legacy output", ""]);
  assert.ok(queued.every(args => args.length === 5));
  assert.equal(queued[0][3], "SCHEDULE:1:reservation_owner");
  assert.deepEqual(scheduleEvents.filter(event => event.type === "scheduleChanged").map(event => [event.deviceId, event.OutputSignal, event.scheduleId]), [
    ["DEVICE-1", "OS1", "1"], ["DEVICE-1", "OS1", "2"], ["DEVICE-1", "OS1", "3"]
  ]);
});

test("schedule repeats remain enabled across consecutive executions", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const rows = ["ONCE", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].map((repeat_type, index) => ({
    schedule_id: String(index + 1), device_id: "DEVICE-1", output_signal: "OS1", action_state: "ON",
    repeat_type, is_enabled: 1, next_run_at: "2026-10-10 09:00:00", last_execution_status: "WAITING"
  }));
  const calls = [];
  let now = "2026-10-10 09:00:00";
  const context = vm.createContext({
    console, resolveScheduleSource: async source => source, toKoreaDateTime: () => now, scheduleNextRun: () => now === "2026-10-10 09:00:00" ? "2026-10-11 09:00:00" : "2026-10-12 09:00:00",
    queueDeviceCommand: async (...args) => calls.push(args),
    broadcastDeviceBrowsers() {},
    query: async (sql, params) => {
      if (sql.startsWith("SELECT")) return rows.filter(row => row.is_enabled === 1 && row.next_run_at <= now);
      const row = rows.find(item => item.schedule_id === params.at(-1) || (sql.includes("last_execution_status='RUNNING'") && item.schedule_id === params[0]));
      assert.ok(row);
      if (sql.includes("is_enabled=0")) { row.is_enabled = 0; row.next_run_at = null; }
      else if (sql.includes("SET next_run_at=")) {
        assert.match(sql, /is_enabled=1,completed_at=NULL/);
        assert.match(sql, /WHERE schedule_id=\? AND is_enabled=1/);
        row.next_run_at = params[0];
      }
      return { affectedRows: 1 };
    }
  });
  vm.runInContext(source.slice(source.indexOf("let scheduleTickBusy ="), source.indexOf("async function start()")), context);
  await context.runDueSchedules();
  assert.equal(rows[0].is_enabled, 0);
  for (const row of rows.slice(1)) { assert.equal(row.is_enabled, 1); assert.equal(row.next_run_at, "2026-10-11 09:00:00"); }
  await context.runDueSchedules();
  assert.equal(calls.length, 6);
  now = "2026-10-11 09:00:00";
  await context.runDueSchedules();
  assert.equal(calls.length, 11);
  for (const row of rows.slice(1)) { assert.equal(row.is_enabled, 1); assert.equal(row.next_run_at, "2026-10-12 09:00:00"); }
});

test("schedule repeat execution preserves manual stops and retries after command failures", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const scenario of ["paused", "failed"]) {
    const row = { schedule_id: "1", device_id: "DEVICE-1", output_signal: "OS1", action_state: "ON", repeat_type: "HOURLY", is_enabled: 1, next_run_at: "2026-10-10 09:00:00", last_execution_status: "WAITING" };
    const context = vm.createContext({
      console, resolveScheduleSource: async source => source, toKoreaDateTime: () => "2026-10-10 09:00:00", scheduleNextRun: () => "2026-10-10 10:00:00",
      queueDeviceCommand: async () => {
        if (scenario === "failed") throw new Error("command failed");
        row.is_enabled = 0; row.next_run_at = null; row.last_execution_status = "DISABLED";
      },
      query: async (sql, params) => {
        if (sql.startsWith("SELECT")) return [{ ...row }];
        if (sql.includes("SET next_run_at=")) {
          assert.match(sql, /WHERE schedule_id=\? AND is_enabled=1/);
          if (row.is_enabled !== 1) return { affectedRows: 0 };
          row.next_run_at = params[0];
          row.last_execution_status = sql.includes("'FAILED'") ? "FAILED" : "WAITING";
        }
        return { affectedRows: 1 };
      }
    });
    vm.runInContext(source.slice(source.indexOf("let scheduleTickBusy ="), source.indexOf("async function start()")), context);
    await context.runDueSchedules();
    assert.equal(row.is_enabled, scenario === "paused" ? 0 : 1);
    assert.equal(row.next_run_at, scenario === "paused" ? null : "2026-10-10 10:00:00");
    assert.equal(row.last_execution_status, scenario === "paused" ? "DISABLED" : "FAILED");
  }
});

test("schedule stop and activation proceed without confirmation", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-schedule.js"), "utf8");
  for (const enabled of ["0", "1"]) {
    let handler, prompts = 0, requests = 0, reloads = 0;
    const context = vm.createContext({
      rowsRoot: { addEventListener: (event, callback) => { handler = callback; } },
      confirm: () => { prompts++; return false; }, alert: message => assert.fail(message),
      api: async (url, options) => { requests++; assert.equal(url, "/api/device/schedules/1/enabled"); assert.equal(options.method, "PATCH"); assert.equal(JSON.parse(options.body).is_enabled, enabled === "1"); },
      loadSchedules: async () => { reloads++; }
    });
    const start = source.indexOf('  rowsRoot.addEventListener("click"');
    vm.runInContext(source.slice(start, source.indexOf("\n  setRepeatFields();Promise.all", start)), context);
    await handler({ target: { closest: selector => selector === "[data-toggle]" ? { dataset: { toggle: "1", enabled } } : null } });
    assert.equal(requests, 1);
    assert.equal(prompts, 0);
    assert.equal(reloads, 1);
  }
});

test("completed one-time schedule has no next execution time in the list", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-schedule.js"), "utf8");
  const start = source.indexOf("function renderTable()");
  const end = source.indexOf("  function formPayload()", start);
  const rows = [
    { schedule_id: 1, repeat_type: "ONCE", is_enabled: 0, schedule_time: "2026-10-10 09:00:00", last_execution_status: "QUEUED" },
    { schedule_id: 2, repeat_type: "ONCE", is_enabled: 1, schedule_time: "2026-10-12 09:00:00", last_execution_status: "WAITING" }
  ];
  const rowsRoot = { innerHTML: "" };
  const context = vm.createContext({
    currentRows: () => rows,
    $: () => ({ textContent: "" }),
    rowsRoot,
    esc: value => String(value ?? ""),
    formatDate: value => value ? String(value).replace("T", " ").slice(0, 16) : "-",
    repeatNames: { ONCE: "1회" }
  });
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  context.renderTable();
  assert.match(rowsRoot.innerHTML, /<td>-<\/td><td>QUEUED · 비활성/);
  assert.match(rowsRoot.innerHTML, /<td>2026-10-12 09:00<\/td><td>WAITING · 활성/);
});

test("schedule deletion uses the clicked button confirmation before deleting", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-schedule.js"), "utf8");
  for (const confirmed of [false, true]) {
    const button = { dataset: { delete: "1" } };
    const schedule = { schedule_id: "1", device_id: "DEVICE-1", output_signal: "OS1" };
    let handler, requests = 0, reloads = 0, confirmations = 0;
    const context = vm.createContext({
      rowsRoot: { addEventListener: (event, callback) => { handler = callback; } },
      allSchedules: [schedule],
      confirmScheduleDeletion: async (anchor, row) => { confirmations++; assert.equal(anchor, button); assert.equal(row, schedule); return confirmed; },
      confirm: () => assert.fail("Native browser confirmation must not be used"),
      alert: message => assert.fail(message),
      api: async (url, options) => { requests++; assert.equal(url, "/api/device/schedules/1"); assert.equal(options.method, "DELETE"); },
      loadSchedules: async () => { reloads++; }
    });
    const start = source.indexOf('  rowsRoot.addEventListener("click"');
    vm.runInContext(source.slice(start, source.indexOf("\n  setRepeatFields();Promise.all", start)), context);
    await handler({ target: { closest: selector => selector === "[data-delete]" ? button : null } });
    assert.equal(confirmations, 1);
    assert.equal(requests, confirmed ? 1 : 0);
    assert.equal(reloads, confirmed ? 1 : 0);
  }
});

test("schedule API creates and updates saved OStr strings", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const handlers = {};
  let savedRow;
  const context = scheduleContext();
  const requiredLevels = [];
  Object.assign(context, {
    console, requireLogin() {}, requireActiveAccount() {}, requireApproved() {},
    requireAdminLevel: level => { requiredLevels.push(level); return () => {}; },
    normalizeDevicePin: value => String(value).toUpperCase(), DEVICE_OUTPUT_PINS: new Set(["OS1"]),
    app: {
      post: (route, ...callbacks) => { handlers.post = callbacks.at(-1); },
      put: (route, ...callbacks) => { handlers.put = callbacks.at(-1); }
    },
    query: async (sql, params) => {
      if (sql.startsWith("SELECT d.device_id")) return [{ device_id: "DEVICE-1" }];
      if (sql.startsWith("SELECT * FROM device_schedule")) return [savedRow];
      assert.match(sql, /\bostr_payload\b/);
      assert.doesNotMatch(sql, /\bistr_payload\b/);
      if (sql.startsWith("UPDATE")) {
        assert.match(sql, /last_execution_status='WAITING'/);
        assert.match(sql, /completed_at=NULL/);
      }
      savedRow = { schedule_id: "1", device_id: params[0], output_signal: params[1], action_state: params[3], repeat_type: params[5], schedule_time: params[6], ostr_payload: params[4], is_enabled: params[14], next_run_at: params[15] };
      return { insertId: 1n, affectedRows: 1 };
    }
  });
  vm.runInContext(source.slice(source.indexOf('app.post("/api/device/schedules",'), source.indexOf('app.patch("/api/device/schedules/:id/enabled",')), context);
  assert.deepEqual(requiredLevels, [4, 4]);
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  const base = { device_id: "DEVICE-1", output_signal: "OS1", repeat_type: "DAILY", action_state: "ON", schedule_time: "2026-10-10T09:17" };
  const created = response();
  await handlers.post({ body: { ...base, ostr_payload: "new output", is_enabled: false }, user: { id: 1 } }, created);
  assert.equal(created.code, 201);
  assert.equal(created.body.ostr_payload, "new output");
  assert.equal(created.body.is_enabled, 0);
  for (const body of [{ ostr_payload: "updated output" }, { ostr_payload: "updated output", is_enabled: false }]) {
    savedRow.is_enabled = 0;
    savedRow.next_run_at = null;
    const updated = response();
    await handlers.put({ params: { id: "1" }, body, user: { id: 1 } }, updated);
    assert.equal(updated.code, 200);
    assert.equal(updated.body.ostr_payload, "updated output");
    assert.equal(updated.body.is_enabled, 1);
    assert.ok(updated.body.next_run_at);
  }
});

test("schedule validation uses OStr and accepts legacy strings without overriding new values", () => {
  const validate = scheduleContext().validateScheduleInput;
  const base = { repeat_type: "DAILY", action_state: "ON", schedule_time: "2026-10-10T09:17" };
  assert.equal(validate({ ...base, ostr_payload: "output", istr_payload: "input" }).ostr_payload, "output");
  assert.equal(validate({ ...base, istr_payload: "legacy output" }).ostr_payload, "legacy output");
  assert.equal(validate({ ...base, ostr_payload: "", istr_payload: "input" }).ostr_payload, "");
  assert.equal(validate({ ...base, ostr_payload: "a".repeat(10001) }).ostr_payload.length, 10000);
  assert.equal(validate({ ...base, ostr_payload: "output" }).istr_payload, undefined);
});

function scheduleContext() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const context = vm.createContext({ KOREA_TIME_OFFSET_MS: 32400000 });
  vm.runInContext(source.slice(source.indexOf("function toKoreaDateTime("), source.indexOf("const dbConfig =")), context);
  vm.runInContext(source.slice(source.indexOf("function scheduleNextRun("), source.indexOf("function scheduleAdmin(")), context);
  return context;
}

test("schedule recurrence uses execution datetime for every repeat mode", () => {
  const context = scheduleContext();
  const expected = { HOURLY: "2026-10-10 16:37:00", DAILY: "2026-10-11 14:37:00", WEEKLY: "2026-10-12 14:37:00", MONTHLY: "2026-11-10 14:37:00", YEARLY: "2027-10-10 14:37:00" };
  for (const [repeat, next] of Object.entries(expected)) {
    const schedule = context.validateScheduleInput({ repeat_type: repeat, action_state: "ON", schedule_time: "2026-10-10T14:37", weekdays: [1,3], hour_value: 1, minute_value: 2, day_of_month: 1, month_value: 1, day_value: 1 });
    assert.equal(schedule.schedule_time, "2026-10-10 14:37:00");
    assert.equal(schedule.hour_value, 14);
    assert.equal(schedule.minute_value, 37);
    assert.equal(context.scheduleNextRun(schedule, new Date("2026-10-10T15:40:00+09:00")), next);
    assert.equal(schedule.weekday_mask, repeat === "WEEKLY" ? 10 : null);
  }
  const weekly = context.validateScheduleInput({ repeat_type: "WEEKLY", action_state: "OFF", schedule_time: "2026-10-10T14:37", weekdays: [1,3] });
  assert.equal(context.scheduleNextRun(weekly, new Date("2026-10-12T14:37:00+09:00")), "2026-10-14 14:37:00");
});

test("schedule recurrence handles hour boundaries, month lengths and leap years", () => {
  const context = scheduleContext();
  const next = context.scheduleNextRun;
  assert.equal(next({ repeat_type: "HOURLY", minute_value: 0 }, new Date("2026-10-10T15:59:30+09:00")), "2026-10-10 16:00:00");
  assert.equal(next({ repeat_type: "DAILY", hour_value: 0, minute_value: 0 }, new Date("2026-10-10T23:59:30+09:00")), "2026-10-11 00:00:00");
  const monthly = context.validateScheduleInput({ repeat_type: "MONTHLY", action_state: "ON", schedule_time: "2026-01-31T09:17" });
  assert.equal(next(monthly, new Date("2026-01-31T09:17:00+09:00")), "2026-03-31 09:17:00");
  const monthEnd = context.validateScheduleInput({ repeat_type: "MONTHLY", action_state: "ON", schedule_time: "2026-01-31T09:17", is_month_end: true });
  assert.equal(next(monthEnd, new Date("2026-01-31T09:17:00+09:00")), "2026-02-28 09:17:00");
  const yearly = context.validateScheduleInput({ repeat_type: "YEARLY", action_state: "ON", schedule_time: "2024-02-29T09:17" });
  assert.equal(next(yearly, new Date("2026-10-10T00:00:00+09:00")), "2028-02-29 09:17:00");
  assert.equal(next(yearly, new Date("2096-02-29T09:17:00+09:00")), "2104-02-29 09:17:00");
});

test("schedule validation rejects conflicting repeats and invalid dates while preserving legacy inputs", () => {
  const context = scheduleContext();
  const validate = context.validateScheduleInput;
  const base = { repeat_type: "DAILY", action_state: "ON", schedule_time: "2026-10-10T09:17" };
  for (const schedule_time of ["2026-02-30T09:17", "2026-10-10T24:00", "not-a-date"]) assert.throws(() => validate({ ...base, schedule_time }));
  assert.throws(() => validate({ ...base, repeat_type: ["HOURLY", "DAILY"] }));
  assert.throws(() => validate({ ...base, repeat_type: "WEEKLY", weekdays: [] }));
  assert.throws(() => validate({ ...base, repeat_type: "WEEKLY", weekdays: [1,7] }));
  assert.throws(() => validate({ ...base, repeat_type: "ONCE", schedule_time: "2000-01-01T09:17" }));
  const once = validate({ ...base, repeat_type: "ONCE", schedule_time: "2099-10-10T09:17" });
  assert.equal(once.next_run_at, "2099-10-10 09:17:00.000");
  const legacy = validate({ repeat_type: "DAILY", action_state: "ON", hour_value: 9, minute_value: 17 });
  assert.equal(legacy.hour_value, 9);
  assert.equal(legacy.minute_value, 17);
});

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

test("profile validation accepts optional details and validates supplied values", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf("function normalizePhone("), source.indexOf("function hashPassword(")), context);
  const validate = context.validateProfile;
  const credentials = { username: "user_01", password: "pass1234" };
  const minimal = validate(credentials);
  assert.equal(minimal.error, undefined);
  for (const field of ["name", "region", "company", "position", "phone"]) assert.equal(minimal[field], "");
  assert.equal(minimal.email, null);
  assert.equal(validate({ ...credentials, phone: "   ", email: "   " }).email, null);
  assert.equal(validate({ username: "user_01" }, { passwordRequired: false }).error, undefined);
  assert.ok(validate({ ...credentials, username: "" }).error);
  assert.ok(validate({ ...credentials, password: "" }).error);
  assert.ok(validate({ ...credentials, phone: "invalid" }).error);
  assert.ok(validate({ ...credentials, email: "invalid" }).error);
  for (const [field, limit] of [["name", 100], ["region", 100], ["company", 150], ["position", 100]]) {
    assert.equal(validate({ ...credentials, [field]: "a".repeat(limit) }).error, undefined);
    assert.ok(validate({ ...credentials, [field]: "a".repeat(limit + 1) }).error);
  }
  const supplied = validate({ ...credentials, phone: "01012345678", email: " User@Example.com " });
  assert.equal(supplied.phone, "010-1234-5678");
  assert.equal(supplied.email, "user@example.com");
});

test("registration accepts multiple users without email and enforces credentials", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const users = [];
  let register;
  const context = vm.createContext({
    app: { post: (route, handler) => { assert.equal(route, "/api/register"); register = handler; } },
    hashPassword: () => "hashed-password",
    console,
    query: async (sql, params) => {
      if (sql.startsWith("SELECT")) return users.filter(user => user.username === params[0] || (params[1] !== null && user.email === params[1])).slice(0, 1);
      assert.ok(sql.startsWith("INSERT INTO user_profile"));
      assert.equal(params[1], "hashed-password");
      users.push({ username: params[0], name: params[2], email: params[7] });
      return { insertId: users.length };
    }
  });
  vm.runInContext(source.slice(source.indexOf("function normalizePhone("), source.indexOf("function hashPassword(")), context);
  vm.runInContext(source.slice(source.indexOf('app.post("/api/register"'), source.indexOf('app.post("/api/login"')), context);
  const submit = async body => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await register({ body }, response);
    return response;
  };
  const credentials = { password: "pass1234", passwordConfirm: "pass1234" };
  assert.equal((await submit({ ...credentials, username: "user_01" })).statusCode, 201);
  assert.equal((await submit({ ...credentials, username: "user_02", email: "" })).statusCode, 201);
  assert.equal(users[0].name, "");
  assert.equal(users[0].email, null);
  assert.equal(users[1].email, null);
  assert.equal((await submit({ ...credentials, username: "user_01" })).statusCode, 409);
  assert.equal((await submit({ ...credentials, username: "user_03", email: "user@example.com" })).statusCode, 201);
  assert.equal((await submit({ ...credentials, username: "user_04", email: "USER@example.com" })).statusCode, 409);
  assert.equal((await submit({ ...credentials, username: "user_04", passwordConfirm: "wrong" })).statusCode, 400);
  const missingConfirm = await submit({ username: "user_04", password: "pass1234" });
  assert.equal(missingConfirm.statusCode, 400);
  assert.match(missingConfirm.body.error, /새로고침/);
  assert.equal((await submit({ ...credentials, username: "" })).statusCode, 400);
  assert.equal((await submit({ ...credentials, username: "user_04", password: "" })).statusCode, 400);
  assert.equal(users.length, 3);
});

test("registration browser sends matching password confirmation without changing either value", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-register.js"), "utf8");
  const elements = new Map(["name", "username", "password", "passwordConfirm", "region", "company", "position", "phone", "email", "message"].map(id => [id, { value: "", textContent: "" }]));
  const requests = [];
  let submit;
  elements.set("registerForm", { addEventListener: (event, handler) => { assert.equal(event, "submit"); submit = handler; } });
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    fetch: async (url, options) => {
      assert.equal(url, "/api/register");
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ message: "Registered" }) };
    },
    setTimeout() {}, console
  });
  vm.runInContext(source, context);
  elements.get("username").value = "user_01";
  for (const password of ["pass1234", "  pass1234  ", "1234"]) {
    elements.get("password").value = password;
    elements.get("passwordConfirm").value = password;
    await submit({ preventDefault() {} });
    assert.equal(requests.at(-1).password, password);
    assert.equal(requests.at(-1).passwordConfirm, password);
    assert.equal(elements.get("message").className, "auth-message success");
  }
  elements.get("passwordConfirm").value = "different";
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 3);
  assert.equal(elements.get("message").className, "auth-message error");
});

test("registration pages and script disable stale browser caching", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const middleware = source.slice(source.indexOf('app.use(["/device-control.html"'), source.indexOf("async function query("));
  let paths;
  let handler;
  vm.runInNewContext(middleware, { app: { use: (registeredPaths, registeredHandler) => { paths = registeredPaths; handler = registeredHandler; } } });
  for (const route of ["/user-register.html", "/user-register.js", "/register", "/register.html"]) assert.ok(paths.includes(route));
  const headers = {};
  let continued = false;
  handler({}, { setHeader: (name, value) => { headers[name] = value; } }, () => { continued = true; });
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(continued, true);
});

test("user forms and schema keep profile details optional", () => {
  const read = filename => fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
  const register = read("public/user-register.html");
  const requiredIds = [...register.matchAll(/<input\b[^>]*>/g)]
    .filter(match => /\brequired\b/.test(match[0]))
    .map(match => match[0].match(/\bid="([^"]+)"/)[1]);
  assert.deepEqual(requiredIds, ["username", "password", "passwordConfirm"]);
  for (const filename of ["public/user-register.html", "public/user-profile.html", "public/user-admin.html"]) {
    const html = read(filename);
    for (const field of ["name", "region", "company", "position", "phone", "email"]) {
      const id = filename.includes("user-admin") ? `edit${field[0].toUpperCase()}${field.slice(1)}` : field;
      const input = [...html.matchAll(/<input\b[^>]*>/g)].find(match => match[0].includes(`id="${id}"`));
      assert.ok(input, `${filename}: ${id}`);
      assert.equal(/\brequired\b/.test(input[0]), false, `${filename}: ${id} is optional`);
    }
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  }
  for (const filename of ["schema.sql", "server.js"]) {
    const source = read(filename);
    assert.match(source, /user_name VARCHAR\(100\) NOT NULL DEFAULT ''/);
    assert.match(source, /email VARCHAR\(254\) NULL DEFAULT NULL/);
    assert.match(source, /UNIQUE KEY uq_user_profile_email \(email\)/);
  }
  const migration = read("migrate-optional-user-profile.sql");
  assert.match(migration, /MODIFY COLUMN user_name VARCHAR\(100\) NOT NULL DEFAULT ''/);
  assert.match(migration, /MODIFY COLUMN email VARCHAR\(254\) NULL DEFAULT NULL/);
  assert.match(migration, /UPDATE user_profile SET email = NULL WHERE TRIM\(email\) = ''/);
  assert.doesNotMatch(migration, /DROP\s+(?:DATABASE|TABLE|INDEX)/i);
});

test("level-one device view subscribes and forwards live channels with the current HTML", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device-view.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-view.js"), "utf8");
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], { dataset: {}, textContent: "" }]));
  const sockets = [];
  const sent = [];
  const events = [];
  const listeners = new Map();
  class BrowserSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = BrowserSocket.CONNECTING; sockets.push(this); }
    send(payload) { sent.push(JSON.parse(payload)); }
  }
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null, addEventListener() {}, visibilityState: "visible" },
    window: { dispatchEvent: event => { if (event.type === "device-state-update") events.push(event.detail); }, addEventListener: (name, callback) => listeners.set(name, callback) },
    location: { protocol: "http:", host: "localhost:3000" },
    fetch: async () => ({ ok: true, json: async () => ({ user: { name: "Viewer", username: "viewer", permissionLevel: 1 } }) }),
    WebSocket: BrowserSocket,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context);
  await vm.runInContext("loadUser()", context);
  assert.equal(sockets.length, 1);
  assert.equal(elements.get("controlLink").hidden, true);
  const socket = sockets[0];
  socket.readyState = BrowserSocket.OPEN;
  assert.doesNotThrow(() => socket.onopen());
  assert.equal(sent[0].type, "subscribeDevice");
  const messages = [
    { type: "deviceSnapshot", state: { device_id: "DEVICE-1", channels: [] }, deviceConnected: true },
    { type: "initialState", state: { device_id: "DEVICE-1", channels: [] } },
    { type: "deviceConnection", deviceId: "DEVICE-1", connected: true },
    ...Array.from({ length: 8 }, (_, index) => ({ type: "stateChanged", deviceId: "DEVICE-1", OutputSignal: `OS${index + 1}`, OutputState: "ON", inputState: "ON", previousState: "OFF", source: "DEVICE", changedAt: "2026-10-05T01:00:00Z" })),
    { type: "channelString", deviceId: "DEVICE-1", OutputSignal: "OS8", IStr: "input", OStr: "output" },
    { type: "state", deviceId: "DEVICE-1", OutputSignal: "OS8", OutputState: "OFF" },
    { type: "scheduleChanged", deviceId: "DEVICE-1", OutputSignal: "OS8", scheduleId: "1" }
  ];
  for (const message of messages) {
    assert.doesNotThrow(() => socket.onmessage({ data: JSON.stringify(message) }));
  }
  assert.equal(JSON.stringify(events), JSON.stringify(messages));
  assert.equal(elements.get("stateD8").textContent, "ON");
  assert.equal(elements.get("source").textContent, "-");
  assert.doesNotThrow(() => listeners.get("focus")());
  assert.equal(sent.at(-1).type, "subscribeDevice");
  assert.doesNotThrow(() => socket.onerror());
});

test("server and Device browser scripts parse as complete JavaScript files", () => {
  for (const filename of ["server.js", "public/product-view.js", "public/product-control.js", "public/device-active.js", "public/device-view.js", "public/device-control.js", "public/device-admin.js", "public/user-setting.js", "public/user-login.js", "public/user-register.js", "public/user-logout.js", "public/page-settings.js"]) {
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), { filename });
  }
});

test("device settings use renamed constants and environment keys with legacy compatibility", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const declarations = source.split(/\r?\n/).filter(line => /^const DEVICE_(?:ID|TOKEN) =/.test(line)).join("\n");
  assert.equal(declarations.split("\n").length, 2);
  const settings = env => vm.runInNewContext(`${declarations}\n({ id: DEVICE_ID, token: DEVICE_TOKEN });`, { process: { env } });
  const primary = settings({ DEVICE_ID: "new-id", DIVICE_ID: "alternate-id", DEVICE_TOKEN: "new-token", DEVICE_DEVICE_ID: "old-id", DEVICE_DEVICE_TOKEN: "old-token" });
  assert.equal(primary.id, "new-id");
  assert.equal(primary.token, "new-token");
  const alternate = settings({ DIVICE_ID: "alternate-id" });
  assert.equal(alternate.id, "alternate-id");
  const previous = settings({ DEVICE_DEVICE_ID: "old-id", DEVICE_DEVICE_TOKEN: "old-token" });
  assert.equal(previous.id, "old-id");
  assert.equal(previous.token, "old-token");
  const legacy = settings({ WEMOS_DEVICE_ID: "legacy-id", WEMOS_DEVICE_TOKEN: "legacy-token" });
  assert.equal(legacy.id, "legacy-id");
  assert.equal(legacy.token, "legacy-token");
  assert.equal(settings({}).id, "DEVICE-D1-001");
  assert.equal(settings({}).token, "");
  assert.doesNotMatch(source, /\b(?:const|let|var) DEVICE_DEVICE_(?:ID|TOKEN)\b/);
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
  const menus = ["header-actions", "device-page-links", "auth-links"].map(name => {
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
        const key = { "[data-page-user-bar]": "pageUserBar", "[data-page-user-info]": "pageUserInfo", "[data-server-connection]": "serverConnection" }[selector];
        if (child.dataset && key && child.dataset[key] !== undefined) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    setAttribute(name, value) { this[name] = value; }
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
  const context = vm.createContext({ location: { pathname: "/device-view.html" }, document: {
    body,
    querySelector: selector => {
      assert.equal(selector, "body > header, body.device-page .device-header");
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
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[1].textContent, "CONNECTING");
  context.updateServerConnectionIndicator("online");
  assert.equal(bar.children[1].textContent, "ONLINE");
  assert.equal(bar.children[1].dataset.state, "online");
  context.updateServerConnectionIndicator("offline");
  assert.equal(bar.children[1].textContent, "OFFLINE");
  context.applyPageUser({ username: "operator", name: "Hong <A>" }, 8);
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[1].textContent, "OFFLINE");
  assert.equal(classes.has("has-page-user"), true);
  for (const menu of menus) {
    assert.equal(menu.children.length, 1);
    assert.equal(menu.legacy.hidden, true);
  }
  context.applyPageUser(null);
  assert.equal(header.children.length, 1);
  assert.equal(classes.has("has-page-user"), false);
  assert.ok(menus.every(menu => menu.children.length === 1));
  assert.equal(bar.children[1].dataset.connectionType, "socket");
  for (const pathname of ["/product-admin.html", "/device-admin.html", "/user-admin.html", "/user-profile.html", "/user-setting.html"]) {
    context.location.pathname = pathname;
    context.applyPageUser({ username: "operator" });
    assert.equal(header.children[1].children.length, 2);
    assert.equal(header.children[1].children[1].dataset.connectionType, "server");
    assert.equal(header.children[1].children[1].title, "서버 연결 끊김 또는 응답 시간 초과");
    context.applyPageUser(null);
  }
  for (const pathname of ["/user-login.html", "/user-register.html", "/login", "/register"]) {
    context.location.pathname = pathname;
    context.applyPageUser({ username: "operator" });
    assert.equal(header.children[1].children.length, 1);
    context.applyPageUser(null);
  }
});

test("server connection monitor follows actual sockets, reconnects and ignores stale events", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function startServerConnectionMonitor()");
  const end = source.indexOf("\nstartServerConnectionMonitor();", start);
  const monitor = source.slice(start, end);
  const states = [];
  const listeners = new Map();
  function createSocket(readyState) {
    const handlers = new Map();
    return { readyState, handlers, addEventListener: (type, callback) => handlers.set(type, callback) };
  }
  const first = createSocket(1);
  const context = vm.createContext({
    hasServerConnectionIndicator: () => true,
    usesRealtimeSocket: () => true,
    updateServerConnectionIndicator: state => states.push(state),
    WebSocket: { OPEN: 1, CONNECTING: 0 },
    window: { factoryRealtimeSocket: first, addEventListener: (name, callback) => listeners.set(name, callback) }
  });
  vm.runInContext(monitor, context);
  context.startServerConnectionMonitor();
  assert.equal(states.at(-1), "online");
  first.handlers.get("error")({ type: "error" });
  assert.equal(states.at(-1), "offline");
  first.readyState = 3;
  first.handlers.get("close")({ type: "close" });
  assert.equal(states.at(-1), "offline");
  const second = createSocket(0);
  listeners.get("factory-socket-created")({ detail: second });
  assert.equal(states.at(-1), "connecting");
  second.readyState = 1;
  second.handlers.get("open")({ type: "open" });
  assert.equal(states.at(-1), "online");
  first.handlers.get("close")({ type: "close" });
  first.handlers.get("error")({ type: "error" });
  assert.equal(states.at(-1), "online");
  const excluded = vm.createContext({ hasServerConnectionIndicator: () => false });
  vm.runInContext(monitor, excluded);
  assert.doesNotThrow(() => excluded.startServerConnectionMonitor());
  let httpStarted = 0;
  const fallback = vm.createContext({
    hasServerConnectionIndicator: () => true, usesRealtimeSocket: () => false,
    startHttpServerConnectionMonitor: () => httpStarted++
  });
  vm.runInContext(monitor, fallback);
  fallback.startServerConnectionMonitor();
  assert.equal(httpStarted, 1);
});

test("HTTP server status checks every thirty seconds with timeout, failure and recovery handling", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const monitor = source.slice(source.indexOf("function startHttpServerConnectionMonitor()"), source.indexOf("function startServerConnectionMonitor()"));
  const states = [];
  const timers = new Map();
  const listeners = new Map();
  const navigator = { onLine: true };
  let mode = "online";
  let requests = 0;
  let timerId = 0;
  const context = vm.createContext({
    updateServerConnectionIndicator: state => states.push(state),
    navigator, AbortController,
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    document: { addEventListener: (name, callback) => listeners.set(name, callback), visibilityState: "visible" },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "/api/server-status");
      assert.equal(options.cache, "no-store");
      if (mode === "error") throw new Error("connection lost");
      if (mode === "timeout") return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout"))));
      return { status: mode === "online" ? 204 : 503 };
    }
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const retry = async () => {
    const scheduled = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
    assert.ok(scheduled);
    timers.delete(scheduled[0]);
    scheduled[1].callback();
    await settle();
  };
  vm.runInContext(monitor, context);
  context.startHttpServerConnectionMonitor();
  await settle();
  assert.equal(states.at(-1), "online");
  mode = "error";
  await retry();
  assert.equal(states.at(-1), "offline");
  mode = "http-error";
  await retry();
  assert.equal(states.at(-1), "offline");
  mode = "timeout";
  await retry();
  const inFlightRequests = requests;
  listeners.get("focus")();
  assert.equal(requests, inFlightRequests);
  const timeout = [...timers.values()].find(timer => timer.delay === 5000);
  assert.ok(timeout);
  timeout.callback();
  await settle();
  assert.equal(states.at(-1), "offline");
  navigator.onLine = false;
  listeners.get("offline")();
  await retry();
  assert.equal(requests, inFlightRequests);
  navigator.onLine = true;
  mode = "online";
  listeners.get("online")();
  assert.equal(states.at(-1), "connecting");
  await settle();
  assert.equal(states.at(-1), "online");
});

test("HTTP server status endpoint responds without database access and disables caching", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf('app.get("/api/server-status",');
  const end = source.indexOf('\napp.get("/api/health",', start);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(source.slice(start, end), { app: { get: (route, callback) => { assert.equal(route, "/api/server-status"); handler = callback; } } });
  let ended = false;
  const response = {
    setHeader: (name, value) => { assert.equal(name, "Cache-Control"); assert.equal(value, "no-store"); },
    status: code => { assert.equal(code, 204); return response; },
    end: () => { ended = true; }
  };
  handler({}, response);
  assert.equal(ended, true);
});

test("socket connection display avoids HTTP polling and preserves the existing database health endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal([...source.matchAll(/app\.get\("\/api\/health"/g)].length, 1);
  assert.match(source, /app\.get\("\/api\/health", async/);
  const shared = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const socketMonitor = shared.slice(shared.indexOf("function startServerConnectionMonitor()"), shared.indexOf("\nstartServerConnectionMonitor();"));
  assert.doesNotMatch(socketMonitor, /fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(shared, /\/api\/health/);
});

test("all four realtime pages expose their existing socket before or after shared code loads", () => {
  const shared = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const monitor = shared.slice(shared.indexOf("function startServerConnectionMonitor()"), shared.indexOf("\nstartServerConnectionMonitor();"));
  for (const filename of ["product-view.js", "product-control.js", "device-view.js", "device-control.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
    const registration = source.match(/const (?:ws|socket)\s*=\s*new WebSocket\([^;]+;\s*window\.factoryRealtimeSocket\s*=\s*(?:ws|socket);\s*window\.dispatchEvent\([^;]+;/);
    assert.ok(registration, filename);
    for (const sharedFirst of [true, false]) {
      const states = [];
      const sockets = [];
      class BrowserSocket extends EventTarget {
        static OPEN = 1;
        static CONNECTING = 0;
        constructor() { super(); this.readyState = 0; sockets.push(this); }
      }
      const window = new EventTarget();
      const context = vm.createContext({
        window, WebSocket: BrowserSocket,
        CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } },
        protocol: "ws:", p: "ws:", location: { host: "localhost" },
        hasServerConnectionIndicator: () => true,
        usesRealtimeSocket: () => true,
        updateServerConnectionIndicator: state => states.push(state)
      });
      vm.runInContext(monitor, context);
      if (sharedFirst) context.startServerConnectionMonitor();
      vm.runInContext(registration[0], context);
      if (!sharedFirst) context.startServerConnectionMonitor();
      assert.equal(sockets.length, 1);
      assert.equal(states.at(-1), "connecting");
      sockets[0].readyState = 1;
      sockets[0].dispatchEvent(new Event("open"));
      assert.equal(states.at(-1), "online");
      sockets[0].readyState = 3;
      sockets[0].dispatchEvent(new Event("close"));
      assert.equal(states.at(-1), "offline");
    }
  }
});

test("login identity uses a right-aligned responsive flow rather than an overlay", () => {
  const css = readCss();
  assert.match(css, /\.page-user-bar \{[^}]*display: flex;[^}]*justify-content: flex-end;/);
  assert.match(css, /body:not\(\.device-page\)\.has-page-user > header \{[^}]*grid-template-areas:[^}]*"title user"[^}]*"title actions";/);
  assert.match(css, /body:not\(\.device-page\)\.has-page-user > header > \.page-user-bar \{[^}]*grid-area: user;[^}]*justify-self: end;/);
  assert.match(css, /body:not\(\.device-page\)\.has-page-user > header > \.header-actions \{\s*grid-area: actions;/);
  assert.match(css, /body\.device-page\.has-page-user \.device-header \{[^}]*"heading user"[^}]*"heading links";/);
  assert.match(css, /body\.device-page\.has-page-user \.device-header > \.page-user-bar \{[^}]*grid-area: user;/);
  assert.match(css, /\.page-user-info \{[^}]*text-align: right;/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.page-user-bar \{ width: calc\(100% - 24px\); \}/);
  assert.match(css, /body\.auth-body\.has-page-user \{ flex-direction: column; justify-content: flex-start; \}/);
  assert.match(css, /\.page-user-bar \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.page-server-connection \{[^}]*flex: 0 0 auto;/);
});

test("every page has a link container supported by the shared user display", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  for (const filename of fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    assert.match(html, /class="[^"]*\b(?:header-actions|device-page-links|auth-links)\b[^"]*"/, filename);
    assert.ok(html.includes("/page-settings.js"), filename);
  }
});

test("shared user refresh updates identity and menu access after permission changes or logout", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function refreshPageUser()");
  const end = source.indexOf("\nrefreshPageUser();", start);
  assert.ok(start >= 0 && end > start);
  let user = { username: "operator", name: "User", permission_level: 8, status: "APPROVED" };
  let unavailable = false;
  const identities = [];
  let hidden = true;
  const context = vm.createContext({
    fetch: async (_url, options) => { assert.equal(options.cache, "no-store"); if (unavailable) throw new Error("offline"); return { ok: !!user, status: user ? 200 : 401, json: async () => ({ user }) }; },
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
  unavailable = true;
  await context.refreshPageUser();
  assert.equal(identities.length, 2);
  assert.equal(identities.at(-1).current.username, "operator");
  unavailable = false;
  user = null;
  await context.refreshPageUser();
  assert.equal(identities.at(-1).current, null);
  assert.equal(hidden, true);
});

test("all page body layouts share a configurable heading style", () => {
  const css = readCss();
  const sharedRule = /body:not\(\.device-page\):not\(\.auth-body\) > header > div:first-child::before,\s*body\.device-page \.device-header > \.device-heading::before,\s*body\.auth-body \.auth-card > h1::before \{([^}]*)\}/.exec(css);
  assert.ok(sharedRule);
  const headingText = /content: "([^"]+)";/.exec(sharedRule[1]);
  assert.ok(headingText);
  assert.ok(css.includes("color: var(--site-green, var(--device-green, #087a67));"));
  assert.equal(css.includes('content: "FACTORY MONITOR"'), false);
  assert.equal(css.split(`content: "${headingText[1]}"`).length - 1, 1);
  const publicDirectory = path.join(__dirname, "..", "public");
  for (const filename of fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    if (html.includes('class="auth-body"')) {
      assert.match(html, /(?:<div class="user-heading">[\s\S]*?<h1>|<section class="auth-card"[^>]*>\s*<h1>)/, filename);
    } else if (html.includes('class="device-page"')) {
      assert.match(html, /class="device-header"[^>]*>\s*<div class="device-heading">/, filename);
    } else {
      assert.match(html, /<header[^>]*>\s*<div/, filename);
    }
  }
});

test("three Device pages share the same CSS-controlled header eyebrow", () => {
  const css = readCss();
  assert.ok(css.includes('.device-heading > .device-eyebrow::before { content: "DEVICE CONTROL"; }'));
  assert.equal(css.includes('content: "DEVICE D1 R1"'), false);
  assert.equal(css.includes(".device-heading > .device-eyebrow::after"), false);
  for (const filename of ["device-control.html", "device-view.html", "device-admin.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
    const heading = /<div class="device-heading">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(heading, filename);
    assert.ok(heading[1].includes('<p class="device-eyebrow"></p>'), filename);
    assert.equal(/DEVICE CONTROL|OUTPUT MONITOR|DEVICE ADMINISTRATION/.test(heading[1].split("<h1>")[0]), false);
  }
});

test("every page uses the device-control heading structure and title metrics", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  const parser = require("prettier/plugins/html").parsers.html;
  for (const filename of fs.readdirSync(publicDirectory).filter(filename => filename.endsWith(".html"))) {
    let heading;
    function visit(node) {
      if (node.name === "div" && node.attrs?.some(attr => attr.name === "class" && /^(device|user|product)-heading$/.test(attr.value))) heading = node;
      for (const child of node.children || []) visit(child);
    }
    visit(parser.parse(fs.readFileSync(path.join(publicDirectory, filename), "utf8")));
    assert.ok(heading, filename);
    const children = heading.children.filter(node => node.name);
    assert.equal(children[0].name, "p", filename);
    assert.equal(children[1].name, "h1", filename);
    assert.ok(children[0].attrs.some(attr => attr.name === "class" && /^(device|user|product)-eyebrow$/.test(attr.value)), filename);
  }
  const css = postcss.parse(fs.readFileSync(path.join(publicDirectory, "style.css"), "utf8"));
  const device = css.nodes.find(node => node.selector === ".device-page .device-heading h1");
  const shared = css.nodes.find(node => node.selector === "body:not(.device-page) header h1");
  for (const property of ["margin", "font-size", "line-height"]) {
    assert.equal(shared.nodes.find(node => node.prop === property).value, device.nodes.find(node => node.prop === property).value, property);
  }
  assert.doesNotMatch(readCss(), /\.(user|product)-heading > h1::before/);
});

test("Device management and control enforce their minimum permission levels", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const guardStart = source.indexOf("function requireAdminLevel(");
  const guardEnd = source.indexOf("function requireMaster(", guardStart);
  const middlewareStart = source.indexOf("function deviceAdminMiddleware(");
  const middlewareEnd = source.indexOf("async function getManagedDeviceDevices", middlewareStart);
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
    context.deviceAdminMiddleware({ path: "/api/admin/device/devices", user: { permissionLevel: level } }, response, () => { authorized = true; });
    assert.equal(authorized, level >= 8);
    if (level < 8) assert.equal(status, 403);
  }
  assert.match(source, /app\.get\("\/device-admin\.html",[^\n]*requireAdminLevel\(8\)/);
  assert.match(source, /app\.get\("\/product-admin\.html",[^\n]*requireAdminLevel\(6\)/);
  assert.match(source, /app\.get\("\/device-control\.html",[^\n]*requireAdminLevel\(4\)/);
  assert.match(source, /app\.get\("\/device_schedule\.html",[^\n]*requireAdminLevel\(4\)/);
  assert.match(source, /app\.get\("\/product-control\.html",[^\n]*requireAdminLevel\(2\)/);
  assert.match(source, /app\.post\("\/api\/device\/schedules",[^\n]*requireAdminLevel\(4\)/);
  for (const route of [
    'app.put("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4),',
    'app.patch("/api/device/schedules/:id/enabled", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4),',
    'app.delete("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4),'
  ]) assert.ok(source.includes(route), route);
  const managementRoutes = [...source.matchAll(/app\.(?:get|post|put|delete)\("\/api\/admin\/device[^\n]+/g)].map(match => match[0]);
  assert.equal(managementRoutes.length, 6);
  assert.ok(managementRoutes.every(route => route.includes("deviceAdminMiddleware")));
});

test("member editing locks the current user's level and permits assigning the admin's level", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  let handler, targetLevel = 3;
  const updates = [];
  const context = vm.createContext({
    app: { put: (_route, ...callbacks) => { handler = callbacks.at(-1); } },
    requireLogin() {}, requireMaster() {}, getPermissionLevel: user => user.permissionLevel,
    validateProfile: body => ({
      username: body.username, name: body.name || "", region: body.region || "", company: body.company || "",
      position: body.position || "", phone: body.phone || "", email: body.email || null, password: body.password || ""
    }),
    hashPassword: password => `hashed:${password}`,
    query: async (sql, params) => {
      if (sql.startsWith("SELECT user_id AS id FROM user_profile")) return [];
      if (sql.startsWith("SELECT role,permission_level")) return [{ role: "USER", permission_level: targetLevel }];
      if (sql.startsWith("UPDATE user_profile")) { updates.push({ sql, params }); return { affectedRows: 1 }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    console
  });
  const start = source.indexOf('app.put("/api/admin/users/:id"');
  const end = source.indexOf('app.delete("/api/admin/users/:id"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const save = async (id, permissionLevel) => {
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ params: { id: String(id) }, body: { username: `user_${id}`, permissionLevel }, user: { id: 8, permissionLevel: 8 } }, response);
    return response;
  };

  targetLevel = 8;
  assert.equal((await save(8, 7)).code, 403);
  assert.equal(updates.length, 0);
  assert.equal((await save(8, 8)).code, 200);
  assert.equal(updates.at(-1).params.at(-1), 8);

  targetLevel = 3;
  assert.equal((await save(7, 8)).code, 200);
  assert.equal(updates.at(-1).params[7], 8);
  assert.equal((await save(7, 9)).code, 403);
  targetLevel = 8;
  assert.equal((await save(7, 8)).code, 403);
});

test("member edit form fixes own level and caps other users at the current admin level", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("function openEdit(id)");
  const end = source.indexOf("function closeEdit()", start);
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", disabled: false, textContent: "", className: "", offsetTop: 0, classList: { remove() {} } });
    return elements.get(id);
  };
  const users = [{ id: 8, username: "admin", permission_level: 8 }, { id: 7, username: "member", permission_level: 3 }, { id: 6, username: "peer", permission_level: 8 }];
  const context = vm.createContext({ users, currentAdminLevel: 8, currentAdminId: 8, document: { getElementById: getElement }, scrollTo() {} });
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);

  context.openEdit(8);
  assert.equal(getElement("editPermissionLevel").disabled, true);
  assert.equal(getElement("editPermissionLevel").innerHTML, '<option value="8">8등급</option>');
  context.openEdit(7);
  assert.equal(getElement("editPermissionLevel").disabled, false);
  assert.equal(getElement("editPermissionLevel").innerHTML, Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}">${index + 1}등급</option>`).join(""));
  context.openEdit(6);
  assert.equal(getElement("editMessage").textContent, "자신보다 낮은 등급의 회원만 수정할 수 있습니다.");
});

test("Device management menu is visible only for approved active level-eight members", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("const protectedPageAccess =");
  const end = source.indexOf("const protectedLinks =", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  for (let level = 1; level <= 10; level++) {
    context.access = { active: true, approved: true, permissionLevel: level };
    assert.equal(vm.runInContext('protectedPageAccess["/device-admin.html"](access)', context), level >= 8);
    assert.equal(vm.runInContext('protectedPageAccess["/device-control.html"](access)', context), level >= 4);
    assert.equal(vm.runInContext('protectedPageAccess["/device_schedule.html"](access)', context), level >= 4);
    assert.equal(vm.runInContext('protectedPageAccess["/product-control.html"](access)', context), level >= 2);
  }
  for (const access of [{ active: false, approved: true, permissionLevel: 10 }, { active: true, approved: false, permissionLevel: 10 }]) {
    context.access = access;
    assert.equal(vm.runInContext('protectedPageAccess["/device-admin.html"](access)', context), false);
    assert.equal(vm.runInContext('protectedPageAccess["/device-control.html"](access)', context), false);
    assert.equal(vm.runInContext('protectedPageAccess["/device_schedule.html"](access)', context), false);
    assert.equal(vm.runInContext('protectedPageAccess["/product-control.html"](access)', context), false);
  }
  const adminScript = fs.readFileSync(path.join(__dirname, "..", "public", "device-admin.js"), "utf8");
  assert.ok(adminScript.includes('if (level < 8 || data.user.status !== "APPROVED")'));
});

test("schedule management link is present on device pages accessible from level four", () => {
  for (const filename of ["device-control.html", "device-view.html", "device-admin.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
    assert.match(html, /<a class="link" href="\/device_schedule\.html">예약 관리<\/a>/, filename);
  }
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  assert.match(source, /"\/device_schedule\.html": \(access\) => access\.active && access\.approved && access\.permissionLevel >= 4/);
});

test("full schedule lists require level four while channel previews remain readable", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("function requireScheduleListAccess(");
  const end = source.indexOf('\napp.get("/api/device/schedules"', start);
  const context = vm.createContext({
    requireAdminLevel: minimum => (req, res, next) => {
      if (req.user.permissionLevel >= minimum) return next();
      res.status(403).json({ error: "forbidden" });
    }
  });
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const check = (permissionLevel, query) => {
    let allowed = false, status;
    context.requireScheduleListAccess({ user: { permissionLevel }, query }, {
      status(code) { status = code; return this; }, json() {}
    }, () => { allowed = true; });
    return { allowed, status };
  };
  assert.deepEqual(check(3, { limit: "5000" }), { allowed: false, status: 403 });
  assert.deepEqual(check(4, { limit: "5000" }), { allowed: true, status: undefined });
  assert.deepEqual(check(1, { next_only: "1", device_id: "DEVICE-1", output_signal: "OS1", is_enabled: "1", limit: "1" }), { allowed: true, status: undefined });
  assert.deepEqual(check(1, { next_only: "1", is_enabled: "1", limit: "5000" }), { allowed: false, status: 403 });
});

test("Device ON/OFF controls activate only from permission level four", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-control.js"), "utf8");
  const start = source.indexOf("function configureOutputControls()");
  const end = source.indexOf("\nfunction resync()", start);
  const onButton = { disabled: false }, offButton = { disabled: false };
  const context = vm.createContext({
    permission: 3, outputButtons: { OS1: [onButton, offButton] },
    stateElements: { OS1: { dataset: { state: "OFF" } } },
    setPinState() {}, send() {}
  });
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  context.configureOutputControls();
  assert.equal(onButton.disabled, true);
  assert.equal(offButton.disabled, true);
  context.permission = 4;
  context.configureOutputControls();
  assert.equal(onButton.disabled, false);
  assert.equal(offButton.disabled, false);
});

test("renamed user pages preserve server routes and menu access rules", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pageSource = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const pages = [
    ["user-profile.html", "requireLogin"],
    ["user-setting.html", "requireLogin, requireActiveAccount"],
    ["user-admin.html", "requireLogin, requireActiveAccount, requireAdminLevel(8)"]
  ];
  for (const [filename, middleware] of pages) {
    assert.ok(fs.readdirSync(path.join(__dirname, "..", "public")).includes(filename));
    assert.ok(serverSource.includes(`app.get("/${filename}", ${middleware}, (req, res) => res.sendFile(path.join(__dirname, "public", "${filename}")))`));
  }
  const start = pageSource.indexOf("const protectedPageAccess =");
  const end = pageSource.indexOf("const protectedLinks =", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(pageSource.slice(start, end), context);
  for (let level = 1; level <= 10; level++) {
    for (const active of [true, false]) {
      context.access = { active, approved: true, permissionLevel: level };
      assert.equal(vm.runInContext('protectedPageAccess["/user-profile.html"](access)', context), true);
      assert.equal(vm.runInContext('protectedPageAccess["/user-setting.html"](access)', context), active);
      assert.equal(vm.runInContext('protectedPageAccess["/user-admin.html"](access)', context), active && level >= 8);
    }
  }
  assert.ok(serverSource.includes('redirect: "/user-profile.html?pending=1"'));
  assert.ok(serverSource.includes('res.redirect("/user-profile.html?access=denied")'));
});

test("page-specific scripts match their HTML names and remain linked", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  const filenames = fs.readdirSync(publicDirectory);
  for (const name of ["product-view", "product-control", "user-setting", "user-login", "user-register", "device-control", "device-view", "device-admin"]) {
    assert.ok(filenames.includes(`${name}.js`));
    const html = fs.readFileSync(path.join(publicDirectory, `${name}.html`), "utf8");
    assert.match(html, new RegExp(`<script\\b[^>]*src=["']/?${name}\\.js(?:\\?[^"']*)?["']`));
  }
  for (const filename of ["app.js", "settings.js"]) assert.equal(filenames.includes(filename), false);
});

test("product view remains the default guarded page and preserves old dashboard bookmarks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = new Map();
  const context = vm.createContext({
    app: { get: (route, ...handlers) => routes.set(route, handlers) },
    requireLogin: () => {}, requireActiveAccount: () => {}, requireApproved: () => {},
    path, __dirname: path.join(__dirname, "..")
  });
  const start = source.indexOf('app.get("/",');
  const end = source.indexOf('app.get("/control.html"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  for (const route of ["/", "/product-view.html"]) {
    const handlers = routes.get(route);
    assert.equal(handlers.length, 4);
    assert.equal(handlers[0], context.requireLogin);
    assert.equal(handlers[1], context.requireActiveAccount);
    assert.equal(handlers[2], context.requireApproved);
    let filename;
    handlers.at(-1)({}, { sendFile: value => { filename = value; } });
    assert.equal(filename, path.join(__dirname, "..", "public", "product-view.html"));
    assert.ok(fs.existsSync(filename));
  }
  let redirect;
  routes.get("/index.html")[0]({ path: "/index.html", url: "/index.html?tab=products" },
    { redirect: (status, url) => { redirect = { status, url }; } });
  assert.deepEqual(redirect, { status: 302, url: "/product-view.html?tab=products" });
  const pageSource = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const accessStart = pageSource.indexOf("const protectedPageAccess =");
  const accessEnd = pageSource.indexOf("const protectedLinks =", accessStart);
  vm.runInContext(pageSource.slice(accessStart, accessEnd), context);
  for (const active of [true, false]) {
    for (const approved of [true, false]) {
      context.access = { active, approved, permissionLevel: 1 };
      assert.equal(vm.runInContext('protectedPageAccess["/"](access)', context), active && approved);
      assert.equal(vm.runInContext('protectedPageAccess["/product-view.html"](access)', context), active && approved);
    }
  }
});

test("product control page keeps its protected route and redirects old bookmarks", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = new Map();
  const context = vm.createContext({
    app: { get: (route, ...handlers) => routes.set(route, handlers) },
    requireLogin: () => {}, requireActiveAccount: () => {}, requireApproved: () => {},
    requireAdminLevel: minimum => { assert.equal(minimum, 2); return () => {}; },
    path, __dirname: path.join(__dirname, "..")
  });
  const start = source.indexOf('app.get("/control.html"');
  const end = source.indexOf('app.get("/product-admin.html"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  let redirected;
  routes.get("/control.html")[0]({ path: "/control.html", url: "/control.html?tab=quantity" },
    { redirect: (status, url) => { redirected = { status, url }; } });
  assert.deepEqual(redirected, { status: 302, url: "/product-control.html?tab=quantity" });
  const handlers = routes.get("/product-control.html");
  assert.equal(handlers.length, 5);
  assert.equal(handlers[0], context.requireLogin);
  assert.equal(handlers[1], context.requireActiveAccount);
  assert.equal(handlers[2], context.requireApproved);
  let filename;
  handlers.at(-1)({}, { sendFile: value => { filename = value; } });
  assert.equal(filename, path.join(__dirname, "..", "public", "product-control.html"));
});

test("extracted product control script preserves saves and realtime updates", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "product-control.js"), "utf8");
  const elements = { "q-1": { value: "7" } };
  const requests = [];
  const sockets = [];
  let product = { id: 1, product_name: "Motor", product_code: "P-001", quantity: 2, status: "대기" };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] ||= {} },
    location: { protocol: "http:", host: "localhost:8081" },
    window: { dispatchEvent() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console, alert: message => assert.fail(message),
    WebSocket: class { constructor() { sockets.push(this); } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === "PUT") product = { ...product, ...JSON.parse(options.body) };
      const data = url === "/api/me" ? { user: { name: "Test", username: "tester", permissionLevel: 2 } }
        : url === "/api/products" ? [product] : product;
      return { ok: true, status: 200, json: async () => data };
    }
  });
  vm.runInContext(source, context);
  await context.loadProducts();
  await context.loadUser();
  await context.saveQuantity(1);
  await context.saveStatus(1, "생산중");
  const saves = requests.filter(request => request.options.method === "PUT");
  assert.deepEqual(saves.map(request => request.url), ["/api/products/1/quantity", "/api/products/1/status"]);
  assert.deepEqual(JSON.parse(saves[0].options.body), { quantity: 7 });
  assert.deepEqual(JSON.parse(saves[1].options.body), { status: "생산중" });
  assert.equal(vm.runInContext("products[0].quantity", context), 7);
  assert.equal(vm.runInContext("products[0].status", context), "생산중");
  sockets[0].onmessage({ data: JSON.stringify({ type: "quantityUpdated", product: { ...product, quantity: 9 } }) });
  assert.equal(vm.runInContext("products[0].quantity", context), 9);
  assert.ok(elements.controls.innerHTML.includes('value="9"'));
});

test("renamed authentication pages preserve old bookmarks and query strings", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = new Map();
  const context = vm.createContext({
    app: { get: (route, handler) => routes.set(route, handler) },
    path, __dirname: path.join(__dirname, "..")
  });
  const start = source.indexOf('app.get("/login.html"');
  const end = source.indexOf("app.use(express.static", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  for (const name of ["login", "register"]) {
    let redirect;
    routes.get(`/${name}.html`)({ path: `/${name}.html`, url: `/${name}.html?logged_out=1` },
      { redirect: (status, url) => { redirect = { status, url }; } });
    assert.deepEqual(redirect, { status: 302, url: `/user-${name}.html?logged_out=1` });
    let filename;
    routes.get(`/${name}`)({}, { sendFile: value => { filename = value; } });
    assert.equal(filename, path.join(__dirname, "..", "public", `user-${name}.html`));
  }
});

test("extracted login script preserves submission redirects and logout field reset", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-login.js"), "utf8");
  const elements = { username: { value: "tester" }, password: { value: "test-password" }, message: {} };
  const requests = [];
  const events = {};
  let submit;
  let resets = 0;
  elements.loginForm = { reset: () => { resets++; }, addEventListener: (event, handler) => { assert.equal(event, "submit"); submit = handler; } };
  const location = { search: "", href: "" };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] }, location, URLSearchParams,
    window: { addEventListener: (event, handler) => { events[event] = handler; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ redirect: "/user-profile.html?pending=1" }) };
    }
  });
  vm.runInContext(source, context);
  await submit({ preventDefault() {} });
  assert.equal(requests[0].url, "/api/login");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), { username: "tester", password: "test-password" });
  assert.equal(location.href, "/user-profile.html?pending=1");
  location.search = "?logged_out=1";
  events.pageshow();
  assert.equal(resets, 1);
  assert.equal(elements.username.value, "");
  assert.equal(elements.password.value, "");
});

test("extracted register script checks passwords and returns to the renamed login page", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-register.js"), "utf8");
  const elements = Object.fromEntries(["name", "username", "password", "region", "company", "position", "phone", "email"].map(id => [id, { value: id }]));
  elements.passwordConfirm = { value: "different" };
  elements.message = {};
  let submit;
  elements.registerForm = { addEventListener: (_event, handler) => { submit = handler; } };
  const requests = [];
  const timers = [];
  const location = { href: "" };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] }, location, console,
    setTimeout: (handler, delay) => { assert.equal(delay, 1800); timers.push(handler); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ message: "Registered" }) };
    }
  });
  vm.runInContext(source, context);
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.equal(elements.message.className, "auth-message error");
  elements.passwordConfirm.value = elements.password.value;
  await submit({ preventDefault() {} });
  assert.equal(requests[0].url, "/api/register");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(JSON.parse(requests[0].options.body).username, "username");
  assert.equal(elements.message.className, "auth-message success");
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(location.href, "/user-login.html");
});

test("renamed shared logout script preserves successful logout and failure handling", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-logout.js"), "utf8");
  for (const ok of [true, false]) {
    const location = { href: "" };
    const alerts = [];
    const context = vm.createContext({
      location, alert: message => alerts.push(message),
      fetch: async (url, options) => {
        assert.equal(url, "/api/logout");
        assert.equal(options.method, "POST");
        return { ok };
      }
    });
    vm.runInContext(source, context);
    await context.logout();
    assert.equal(location.href, ok ? "/user-login.html?logged_out=1" : "");
    assert.equal(alerts.length, ok ? 0 : 1);
  }
  for (const name of ["device-control", "device-view", "device-admin"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", `${name}.html`), "utf8");
    assert.ok(html.includes('/user-logout.js?v='));
  }
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

test("Device visibility settings default to shown and accept per-user hidden values", () => {
  const context = createSettingsHarness();
  const defaults = context.validateSettings({});
  for (const name of ["show_device_istr", "show_device_ostr", "show_device_ostr_inputs"]) {
    assert.equal(defaults[name], true);
    assert.equal(context.validateSettings({ [name]: false })[name], false);
    assert.ok(context.validateSettings({ [name]: "false" }).error);
  }
});

test("stored Device visibility values restore as booleans", () => {
  const context = createSettingsHarness();
  const settings = context.rowToSettings({ show_device_istr: 0, show_device_ostr: 1, show_device_ostr_inputs: 0 });
  assert.equal(settings.show_device_istr, false);
  assert.equal(settings.show_device_ostr, true);
  assert.equal(settings.show_device_ostr_inputs, false);
  assert.equal(context.rowToSettings({}).show_device_istr, true);
});

test("settings page omits left login identity while preserving authentication checks", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-setting.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "user-setting.html"), "utf8");
  assert.doesNotMatch(html, /id=["']userInfo["']/);
  assert.ok(html.includes("/page-settings.js"));
  assert.ok(source.includes("loadUser();"));
  const authStart = source.indexOf("function redirectToLogin()");
  const authEnd = source.indexOf("function applySettingsToForm(", authStart);
  const userStart = source.indexOf("async function loadUser()");
  const userEnd = source.indexOf("async function logout()", userStart);
  assert.ok(authStart >= 0 && authEnd > authStart && userStart >= 0 && userEnd > userStart);
  for (const [status, expected] of [[200, ""], [401, "/user-login.html"], [403, "/user-profile.html?pending=1"]]) {
    const location = { pathname: "/user-setting.html", href: "" };
    const context = vm.createContext({
      location,
      fetch: async url => {
        assert.equal(url, "/api/me");
        return { status, clone: () => ({ json: async () => ({ code: "SUSPENDED" }) }) };
      },
      document: { getElementById: () => assert.fail("Login validation must not access the removed label") }
    });
    vm.runInContext(source.slice(authStart, authEnd) + source.slice(userStart, userEnd), context);
    await context.loadUser();
    assert.equal(location.href, expected);
  }
});

test("settings form restores and submits all three Device visibility options", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-setting.js"), "utf8");
  const start = source.indexOf("function applySettingsToForm(");
  const end = source.indexOf("function showMessage(", start);
  assert.ok(start >= 0 && end > start);
  const elements = {};
  const context = vm.createContext({ document: { getElementById: id => elements[id] ||= {} } });
  vm.runInContext(source.slice(start, end), context);
  context.applySettingsToForm({ show_device_istr: false, show_device_ostr: true, show_device_ostr_inputs: false });
  const settings = context.readSettingsFromForm();
  assert.equal(settings.show_device_istr, false);
  assert.equal(settings.show_device_ostr, true);
  assert.equal(settings.show_device_ostr_inputs, false);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "user-setting.html"), "utf8");
  for (const id of ["showDeviceIstr", "showDeviceOstr", "showDeviceOstrInputs"]) assert.ok(html.includes(`type="checkbox" id="${id}"`));
});

test("settings API stores Device options only for the authenticated member", async () => {
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
    user_id: 999, show_device_istr: false, show_device_ostr: true, show_device_ostr_inputs: false
  } }, response);
  const insert = calls.find(call => call.sql.includes("INSERT INTO user_setting"));
  assert.equal(insert.params[0], 101);
  assert.equal(insert.params.length, 15);
  assert.deepEqual(Array.from(insert.params).slice(12), [0, 1, 0]);
});

test("shared page settings independently apply all Device visibility flags without caching them across accounts", () => {
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
  context.applyViewSettings({ show_device_istr: false, show_device_ostr: true, show_device_ostr_inputs: false });
  assert.equal(dataset.showDeviceIstr, "false");
  assert.equal(dataset.showDeviceOstr, "true");
  assert.equal(dataset.showDeviceOstrInputs, "false");
  assert.equal(Object.hasOwn(cached, "show_device_istr"), false);
  context.applyViewSettings({});
  assert.equal(dataset.showDeviceIstr, "true");
  assert.equal(dataset.showDeviceOstrInputs, "true");
});

test("Device page restores visibility settings when returning from cache or regaining focus", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "page-settings.js"), "utf8");
  const start = source.indexOf("function refreshViewSettings()");
  assert.ok(start >= 0);
  const listeners = {};
  let loads = 0;
  let settingsApplied = 0;
  const context = vm.createContext({
    fetch: async (_url, options) => { assert.equal(options.cache, "no-store"); loads++; return { ok: true, json: async () => ({ show_device_istr: false }) }; },
    applyViewSettings: settings => { assert.equal(settings.show_device_istr, false); settingsApplied++; },
    location: { pathname: "/device-view.html" },
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

test("both Device pages render visibility targets for every channel while view stays read-only", async () => {
  const css = readCss();
  for (const name of ["istr", "ostr", "ostr-inputs"]) {
    assert.ok(css.includes(`html[data-show-device-${name}="false"] .device-page [data-device-${name}]`));
  }
  for (const viewOnly of [false, true]) {
    const { root } = createUiHarness(viewOnly, [1, 2, 3, 4, 5, 6, 7, 8]);
    await new Promise(setImmediate);
    assert.equal([...root.innerHTML.matchAll(/data-device-istr>/g)].length, 8);
    assert.equal([...root.innerHTML.matchAll(/data-device-ostr>/g)].length, 8);
    assert.equal([...root.innerHTML.matchAll(/data-device-ostr-inputs>/g)].length, viewOnly ? 0 : 8);
  }
});

function createTokenCopyHarness(clipboard, fallbackResult = true) {
  const writes = [];
  const inputs = [];
  const commands = [];
  let restoredFocus = false;
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-admin.js"), "utf8");
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
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-admin.js"), "utf8");
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
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device-control.html"), "utf8");
  const historyHeader = html.slice(html.indexOf('aria-labelledby="history-title"'), html.indexOf('<tbody id="history"'));
  assert.equal([...historyHeader.matchAll(/<th>/g)].length, 6);
  assert.equal(html.includes("Command ID"), false);
  assert.equal(html.includes('id="commands"'), false);
  assert.equal(html.includes("최근 명령"), false);
  assert.equal(historyHeader.includes("<th>이전</th>"), false);
  assert.ok(historyHeader.includes("<th>현재</th>\n\t\t\t\t\t\t\t<th>문자열</th>"));
  const target = { innerHTML: "" };
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-control.js"), "utf8");
  const start = source.indexOf("function renderHistory()");
  const end = source.indexOf("function renderCommands()", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    $: id => id === "history" ? target : null,
    historyRows: [{ changed_at: "2026-10-03", device_id: "DEVICE-D1-001", output_signal: "OS1",
      previous_output_state: "OFF", output_state: "ON", change_source: "operator", command_id: "hidden-command-id",
      signal_message: "MOTOR_ON" }],
    formatDate: value => value, escapeHtml: value => String(value)
  });
  const helperStart = source.indexOf("function formatChangeSource(");
  const helperEnd = source.indexOf("\n}", helperStart) + 2;
  vm.runInContext(source.slice(helperStart, helperEnd) + source.slice(start, end), context);
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
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device-control.html"), "utf8");
  const css = readCss();
  assert.ok(html.includes('class="device-table device-history-table"'));
  assert.match(css, /\.device-page \.device-history-table \{ table-layout: auto; \}/);
  assert.match(css, /\.device-history-table td:nth-child\(2\) \{ width: 22%; min-width: 180px; white-space: nowrap; \}/);
});

test("control and view channels share strong four-sided borders and clear spacing", async () => {
  const css = readCss();
  assert.match(css, /\.active-device-channels \{[^}]*gap: 12px; padding: 12px;/);
  assert.match(css, /\.active-device-channels \.channel-card \{ box-sizing: border-box; border: 2px solid var\(--device-green\); \}/);
  assert.match(css, /@media \(max-width: 980px\) \{\s*\.active-device-channels \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  for (const viewOnly of [false, true]) {
    const { root } = createUiHarness(viewOnly, [1, 2, 3, 4, 5, 6, 7, 8]);
    await new Promise(setImmediate);
    assert.ok(root.innerHTML.includes('class="active-device-channels"'));
    assert.equal([...root.innerHTML.matchAll(/class="channel-card channel-/g)].length, 8);
  }
});

test("browser ACK events use canonical command metadata without changing socket fields", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-control.js"), "utf8");
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
  context.query = async sql => sql.includes("FROM device_channel")
    ? [{ id: 1, channel_name: "Channel 8", input_signal: "IS8", output_signal: "OS8", is_active: 1, output_state: "ON" }]
    : [{ device_id: "DEVICE-D1-002", device_name: "Machine", is_active: 1 }];
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function getManagedDeviceDevices()");
  const end = source.indexOf("// 통합 예약 API", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const devices = await context.getManagedDeviceDevices();
  assert.equal(devices[0].is_active, 1);
  assert.equal(devices[0].sets[0].channel_name, "Channel 8");
  assert.equal(devices[0].sets[0].input_signal, "IS8");
  assert.equal(devices[0].sets[0].output_state, "ON");
});

test("renamed database queries preserve response IDs and use the correct retention keys", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const calls = [];
  const context = vm.createContext({ query: async (sql, params) => { calls.push({ sql, params }); return []; } });
  const start = source.indexOf("async function getDeviceHistory(");
  const end = source.indexOf("function getDeviceDeviceSocket(", start);
  vm.runInContext(source.slice(start, end), context);
  await context.getDeviceHistory(10, "DEVICE-D1-001");
  await context.getDeviceCommands(10, "DEVICE-D1-001");
  assert.match(calls[0].sql, /SELECT history_id AS id,[\s\S]*ORDER BY history_id DESC/);
  assert.match(calls[1].sql, /SELECT command_row_id AS id,[\s\S]*ORDER BY command_row_id DESC/);
  await context.trimDeviceTable("device_state_history", 100, "DEVICE-D1-001");
  await context.trimDeviceTable("device_command", 100);
  assert.match(calls[2].sql, /WHERE device_id=\? AND history_id <=/);
  assert.match(calls[3].sql, /WHERE command_row_id <=/);
  await assert.rejects(context.trimDeviceTable("user_profile"), /Unsupported/);
  assert.equal(calls.length, 4);
  assert.ok(source.includes("p.product_id AS id"));
  assert.ok(source.includes("p.product_status AS status"));
  assert.ok(source.includes("u.username AS updated_by_name"));
  assert.ok(source.includes("SELECT user_id AS id,username,password_hash,user_name AS name"));
  assert.ok(source.includes("user_status AS status FROM user_profile"));
});

test("schema naming preflight accepts new databases and blocks old or partially migrated names", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  let rows = [];
  const context = vm.createContext({ query: async () => rows });
  const start = source.indexOf("async function verifySchemaNames()");
  const end = source.indexOf("async function ensureSchema()", start);
  vm.runInContext(source.slice(start, end), context);
  await context.verifySchemaNames();
  rows = [{ table_name: "users", column_name: "id" }];
  await assert.rejects(context.verifySchemaNames(), /migrate-schema-names/);
  rows = [{ table_name: "device_state_history", column_name: "id" }];
  await assert.rejects(context.verifySchemaNames(), /device_state_history/);
  rows = [{ table_name: "device_state_history", column_name: "history_id" }];
  await context.verifySchemaNames();
  assert.ok(source.indexOf("await verifySchemaNames();") < source.indexOf("await ensureSchema();"));
});

test("fresh database initialization creates complete tables with safe compatibility checks", async () => {
  const { context } = createHarness();
  const calls = [];
  context.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === "SELECT device_id FROM device") return [{ device_id: "DEVICE-D1-002" }];
    return [];
  };
  context.process = { env: {} };
  context.migrateScheduleOutputString = async () => {};
  context.INITIAL_MASTER_PASSWORD = "";
  context.normalizePhone = () => null;
  context.normalizeEmail = () => null;
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureSchema()");
  const end = source.indexOf("async function start()", start);
  vm.runInContext(source.slice(start, end), context);
  await context.ensureSchema();
  const creates = calls.filter(call => call.sql.startsWith("CREATE TABLE"));
  assert.deepEqual(creates.map(call => /EXISTS (\w+)/.exec(call.sql)[1]),
    ["user_profile", "product", "user_setting", "device", "device_channel", "device_schedule", "device_command", "device_state_history"]);
  assert.equal(calls.some(call => /RENAME TABLE|DROP TABLE|information_schema/.test(call.sql)), false);
  assert.ok(calls.some(call => call.sql === "ALTER TABLE device_command ADD COLUMN istr_payload TEXT NULL AFTER output_message"));
  assert.ok(creates.find(call => call.sql.includes("EXISTS product")).sql.includes("fk_product_updated_by"));
  const settings = creates.find(call => call.sql.includes("EXISTS user_setting")).sql;
  for (const column of ["show_updated_at", "show_updated_by", "show_device_istr", "show_device_ostr", "show_device_ostr_inputs"]) assert.ok(settings.includes(column));
  const devices = creates.find(call => call.sql.includes("EXISTS device (")).sql;
  assert.ok(devices.includes("token_hash"));
  assert.equal(/os[1-4]_state|legacy_d7/.test(devices), false);
  const channels = calls.filter(call => call.sql.startsWith("INSERT IGNORE INTO device_channel"));
  assert.equal(channels.length, 8);
  assert.deepEqual(Array.from(channels[7].params), ["DEVICE-D1-002", "채널 08", "IS8", "OS8", 7]);
  const seed = calls.find(call => call.sql.startsWith("INSERT INTO device("));
  assert.ok(seed.sql.includes("token_hash=COALESCE(token_hash,VALUES(token_hash))"));
  calls.length = 0;
  await context.ensureSchema();
  assert.equal(calls.filter(call => call.sql.startsWith("CREATE TABLE IF NOT EXISTS")).length, 8);
  assert.equal(calls.some(call => /DELETE FROM|UPDATE device_channel|RENAME TABLE/.test(call.sql)), false);
  assert.ok(calls.some(call => call.sql === "ALTER TABLE device_command ADD COLUMN istr_payload TEXT NULL AFTER output_message"));
});

test("fresh initialization creates the master once and preserves its password on restart", async () => {
  const { context } = createHarness();
  const calls = [];
  let master = null;
  let passwordHashes = 0;
  context.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === "SELECT device_id FROM device") return [];
    if (sql.startsWith("SELECT user_id AS id,password_hash FROM user_profile")) return master ? [master] : [];
    if (sql.startsWith("INSERT INTO user_profile")) master = { id: 1, password_hash: params[1] };
    return [];
  };
  context.process = { env: { MASTER_USERNAME: "master", MASTER_NAME: "Admin" } };
  context.migrateScheduleOutputString = async () => {};
  context.INITIAL_MASTER_PASSWORD = "test-password";
  context.normalizePhone = () => null;
  context.normalizeEmail = () => null;
  context.hashPassword = () => { passwordHashes++; return "scrypt:test-salt:test-hash"; };
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureSchema()");
  const end = source.indexOf("async function start()", start);
  vm.runInContext(source.slice(start, end), context);
  await context.ensureSchema();
  const insert = calls.find(call => call.sql.startsWith("INSERT INTO user_profile"));
  assert.equal(insert.params[0], "master");
  assert.ok(insert.sql.includes("'MASTER',10,'APPROVED'"));
  calls.length = 0;
  await context.ensureSchema();
  assert.equal(calls.some(call => call.sql.startsWith("INSERT INTO user_profile")), false);
  const update = calls.find(call => call.sql.startsWith("UPDATE user_profile SET role='MASTER'"));
  assert.equal(update.params[0], master.password_hash);
  assert.equal(passwordHashes, 1);
});

test("fresh initialization stops when a required table cannot be created", async () => {
  const { context } = createHarness();
  const calls = [];
  context.query = async sql => {
    calls.push(sql);
    if (sql.includes("CREATE TABLE IF NOT EXISTS product")) throw new Error("CREATE denied");
    return [];
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureSchema()");
  const end = source.indexOf("async function start()", start);
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(context.ensureSchema(), /CREATE denied/);
  assert.equal(calls.length, 2);
});

test("manual naming migration preserves prior schema column definitions and foreign keys", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrate-schema-names.sql"), "utf8");
  const sql = migration.replace(/^--.*$/gm, "");
  const names = {
    users: "user_profile", products: "product", user_settings: "user_setting",
    devices: "device", device_channels: "device_channel", device_commands: "device_command",
    device_state_history: "device_state_history"
  };
  assert.doesNotMatch(sql, /DROP\s+(TABLE|DATABASE)|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|FOREIGN_KEY_CHECKS/i);
  assert.equal([...sql.matchAll(/DROP FOREIGN KEY/g)].length, 6);
  for (const [before, after] of Object.entries(names)) {
    if (before !== after) assert.ok(sql.includes(`${before} TO ${after}`));
  }
  const definitions = new Map([...schema.matchAll(/CREATE TABLE (\w+)\s*\(([\s\S]*?)\) ENGINE=InnoDB/g)]
    .map(match => [match[1], match[2]]));
  let changedColumns = 0;
  const normalize = definition => definition.replace(/PRIMARY KEY|NOT NULL/g, "").replace(/\s+/g, "");
  for (const statement of sql.split(";")) {
    const table = /^\s*ALTER TABLE (\w+)/.exec(statement)?.[1];
    for (const change of statement.matchAll(/CHANGE COLUMN (\w+) (\w+) ([^,\n;]+)/g)) {
      const definition = new RegExp(`\\b${change[2]}\\s+([^,\\n]+)`).exec(definitions.get(names[table]));
      assert.ok(definition, `${table}.${change[2]}`);
      assert.equal(normalize(change[3]), normalize(definition[1]), `${table}.${change[2]}`);
      changedColumns++;
    }
  }
  assert.equal(changedColumns, 10);
  const foreignKeys = text => [...text.matchAll(/CONSTRAINT (\w+) FOREIGN KEY\s*\((\w+)\)\s+REFERENCES (\w+)\((\w+)\) ON DELETE (CASCADE|SET NULL)/g)]
    .map(match => match.slice(1).join(":")).sort();
  const priorSchemaForeignKeys = foreignKeys(schema).filter(key => !key.startsWith("fk_schedule_"));
  assert.equal(foreignKeys(sql).length, 6);
  assert.deepEqual(foreignKeys(sql), priorSchemaForeignKeys);
});

test("fresh SQL and server definitions agree for every table", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const definitions = text => new Map([...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*(\([\s\S]*?\) ENGINE=InnoDB)/g)]
    .map(match => [match[1], match[2].replace(/\s+/g, "")]));
  const serverTables = definitions(source);
  const sqlTables = definitions(schema);
  assert.equal(serverTables.size, 8);
  assert.equal(sqlTables.size, 8);
  for (const [name, definition] of serverTables) assert.equal(sqlTables.get(name), definition, name);
  assert.doesNotMatch(source, /RENAME TABLE|migrateDevice|legacy_d7/);
  assert.doesNotMatch(schema, /ALTER TABLE|RENAME TABLE|legacy_d7/);
});

test("device schema and runtime queries use device consistently", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const oldTable = "device_" + "devices";
  assert.match(schema, /CREATE TABLE device\s*\(/);
  assert.equal([...schema.matchAll(/REFERENCES device\(device_id\)/g)].length, 4);
  assert.equal(schema.includes(oldTable), false);
  assert.equal(serverSource.includes(oldTable), false);
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS device\s*\(/);
  assert.equal([...serverSource.matchAll(/REFERENCES device\(device_id\)/g)].length, 4);
});

test("legacy firmware source still records input strings as device changes", async () => {
  const { context, sqlCalls, ws } = createHarness();
  const source = vm.runInContext("LEGACY_DEVICE_PREFIX.toUpperCase()", context);
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", OutputSignal: "OS1", OutputState: "ON", source,
    IStr: "legacy-sensor", OStr: "motor"
  });
  const history = sqlCalls.find(call => call.sql.includes("INSERT INTO device_state_history"));
  assert.equal(history.params[4], ws.deviceId);
  assert.equal(history.params[6], "legacy-sensor");
});

test("legacy URLs reach renamed routes without bypassing authorization", () => {
  const { context } = createHarness();
  const prefix = vm.runInContext("LEGACY_DEVICE_PREFIX", context);
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("function normalizeLegacyDeviceUrl(");
  const end = source.indexOf("app.use(normalizeLegacyDeviceUrl)", start);
  vm.runInContext(source.slice(start, end), context);
  for (const name of ["", "-view", "-admin"]) {
    let redirect;
    context.normalizeLegacyDeviceUrl({ method: "GET", url: `/${prefix}${name}.html?tab=1` },
      { redirect: (status, url) => { redirect = { status, url }; } }, () => assert.fail("Must redirect"));
    assert.deepEqual(redirect, { status: 302, url: `/device${name || "-control"}.html?tab=1` });
  }
  let controlRedirect;
  context.normalizeLegacyDeviceUrl({ method: "GET", url: "/device.html?tab=1" },
    { redirect: (status, url) => { controlRedirect = { status, url }; } }, () => assert.fail("Must redirect"));
  assert.deepEqual(controlRedirect, { status: 302, url: "/device-control.html?tab=1" });
  for (const name of ["device", prefix]) {
    const request = { method: "GET", url: `/${name}.js?v=old` };
    let continued = false;
    context.normalizeLegacyDeviceUrl(request, {}, () => { continued = true; });
    assert.equal(request.url, "/device-control.js?v=old");
    assert.equal(continued, true);
  }
  for (const url of [`/api/admin/${prefix}/devices`, `/api/${prefix}/devices?active=1`, `/${prefix}-admin.js`]) {
    const request = { method: "PUT", url };
    let continued = false;
    context.normalizeLegacyDeviceUrl(request, {}, () => { continued = true; });
    assert.equal(request.url, url.replace(prefix, "device"));
    assert.equal(continued, true);
  }
  for (const name of ["device", prefix]) {
    const request = { method: "GET", url: `/${name}-active-devices.js?v=old` };
    let continued = false;
    context.normalizeLegacyDeviceUrl(request, {}, () => { continued = true; });
    assert.equal(request.url, "/device-active.js?v=old");
    assert.equal(continued, true);
  }
});

test("control and view pages load the renamed active device script", () => {
  const publicDirectory = path.join(__dirname, "..", "public");
  assert.equal(fs.existsSync(path.join(publicDirectory, "device-active.js")), true);
  assert.equal(fs.existsSync(path.join(publicDirectory, "device-active-devices.js")), false);
  for (const filename of ["device-control.html", "device-view.html"]) {
    const html = fs.readFileSync(path.join(publicDirectory, filename), "utf8");
    assert.match(html, /<script src="\/device-active\.js\?v=[^"]+"><\/script>/);
    assert.equal(html.includes("device-active-devices"), false);
  }
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const cacheStart = source.indexOf('app.use(["/device-control.html"');
  const cacheEnd = source.indexOf("async function query", cacheStart);
  assert.ok(source.slice(cacheStart, cacheEnd).includes('"/device-active.js"'));
});

test("legacy browser subscriptions retain their snapshot message type", () => {
  const { context, ws, sent } = createHarness();
  const prefix = vm.runInContext("LEGACY_DEVICE_PREFIX", context);
  ws.legacyDeviceSubscriber = true;
  context.sendDevice(ws, { type: "deviceSnapshot", state: [] });
  assert.equal(sent[0].type, `${prefix}Snapshot`);
  ws.legacyDeviceSubscriber = false;
  context.sendDevice(ws, { type: "deviceSnapshot", state: [] });
  assert.equal(sent[1].type, "deviceSnapshot");
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
    if (sql.includes("SELECT u.username FROM device_schedule")) return [{ username: "scheduler_01" }];
    if (sql.includes("SELECT output_state")) return [{ ...channel }];
    if (sql.includes("SELECT device_id,is_active")) return [{ device_id: "DEVICE-D1-002", is_active: 1 }];
    if (sql.includes("SELECT output_message")) return [{ output_message: channel.output_message }];
    if (sql.includes("SELECT command_id,output_signal")) return command ? [command] : [];
    if (sql.includes("SELECT command_row_id AS id,command_id")) return [];
    return { affectedRows: 1 };
  };
  const connection = {
    beginTransaction: async () => {}, commit: async () => {},
    rollback: async () => {}, release: () => {}
  };
  const sockets = new Map();
  const browser = { readyState: 1, deviceSubscriber: true, send: data => events.push(JSON.parse(data)) };
  const ws = {
    deviceId: "DEVICE-D1-002", deviceIdentified: true, readyState: 1,
    send: data => sent.push(JSON.parse(data)), close: () => {}
  };
  sockets.set(ws.deviceId, ws);
  const context = vm.createContext({
    query, connectionQuery: (_connection, sql, params) => query(sql, params),
    pool: { getConnection: async () => connection },
    crypto: require("node:crypto"), WebSocket: { OPEN: 1 },
    clients: new Set([browser]), deviceDeviceSockets: sockets,
    DEVICE_ID: ws.deviceId, DEVICE_TOKEN: "test-token",
    deviceDeviceSocket: null, toKoreaDateTime: date => date.toISOString(), console
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const DEVICE_CHANNEL_COUNT =");
  const end = source.indexOf("function getUserFromRequest", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { context, sqlCalls, events, sent, ws };
}

test("hello registers all eight firmware channels", async () => {
  const { context, sqlCalls, ws } = createHarness();
  ws.deviceIdentified = false;
  await context.handleDeviceDeviceMessage(ws, {
    type: "hello", deviceId: ws.deviceId, OutputSignal: "OS1",
    inputs: Array.from({ length: 8 }, (_, index) => `IS${index + 1}`),
    outputs: Array.from({ length: 8 }, (_, index) => `OS${index + 1}`)
  });
  const inserts = sqlCalls.filter(call => call.sql.includes("INSERT INTO device_channel"));
  assert.equal(inserts.length, 8);
  assert.deepEqual(Array.from(inserts[7].params), [ws.deviceId, "채널 08", "IS8", "OS8", 7]);
});

test("firmware state preserves independent input, output and strings", async () => {
  const { context, sqlCalls, events, ws } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", state: "ON",
    InputSignal: "IS8", inputState: "OFF", source: "DEVICE", IStr: "sensor-8", OStr: "motor-8"
  });
  const update = sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "OFF", ws.deviceId, "sensor-8", "motor-8"]);
  assert.equal(events[0].inputState, "OFF");
  assert.equal(events[0].IStr, "sensor-8");
  assert.equal(events[0].InputSignal, "IS8");
  assert.equal(events[0].OutputSignal, "OS8");
  assert.equal(events[0].pin, undefined);
  assert.equal(events[0].inputPin, undefined);
  const history = sqlCalls.find(call => call.sql.includes("INSERT INTO device_state_history"));
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
  await context.handleDeviceDeviceMessage(ws, {
    type: "ack", deviceId: ws.deviceId, commandId: "cmd-1", OutputSignal: "OS1", state: "ON", success: true
  });
  const update = sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?"));
  assert.deepEqual(Array.from(update.params).slice(0, 5), ["ON", "ON", "operator", "sensor-data", "MOTOR_ON"]);
  assert.equal(events.find(event => event.type === "commandAck").status, "ACKED");
  const history = sqlCalls.find(call => call.sql.includes("INSERT INTO device_state_history"));
  assert.equal(history.params[6], "MOTOR_ON");
  assert.equal(events.find(event => event.type === "stateChanged").stringType, undefined);
  assert.equal(events.find(event => event.type === "stateChanged").String, "MOTOR_ON");
});

test("CLIENT state reports retain telemetry and empty strings", async () => {
  const { context, events, ws } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
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
  await context.handleDeviceDeviceMessage(ws, {
    type: "ack", commandId: "cmd-1", OutputSignal: "OS1", state: "OFF", success: true
  });
  assert.equal(events[0].status, "FAILED");
});

test("server commands send only OStr for the device output string", async () => {
  const { context, ws, sent } = createHarness();
  await context.deliverDeviceCommand(ws.deviceId, "cmd-8", "OS8", "ON", "operator", "MOTOR_ON");
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
  await context.handleDeviceDeviceMessage(ws, {
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
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", OutputSignal: "OS8", InputSignal: "IS1", state: "ON"
  });
  assert.equal(sqlCalls.length, 0);
  await context.handleDeviceDeviceMessage(ws, {
    type: "ack", commandId: "cmd-1", OutputSignal: "OS8", state: "ON", success: true
  });
  assert.equal(events.length, 0);
  assert.equal(sqlCalls.length, 1);
});

test("duplicate ACK cannot reapply a finished command", async () => {
  const { context, events, sqlCalls, ws } = createHarness({
    command_id: "cmd-1", output_signal: "OS1", requested_output_state: "ON", command_status: "ACKED"
  });
  await context.handleDeviceDeviceMessage(ws, {
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
  ws.deviceIdentified = false;
  ws.on = (_event, handler) => { onMessage = handler; };
  const waitForMessages = context.attachDeviceDeviceMessageHandler(ws, authorization);
  onMessage(Buffer.from(JSON.stringify({ type: "hello", deviceId: ws.deviceId })));
  for (let index = 1; index <= 8; index++) {
    onMessage(Buffer.from(JSON.stringify({
      type: "state", deviceId: ws.deviceId, OutputSignal: `OS${index}`,
      InputSignal: `IS${index}`, state: "OFF", inputState: "ON", source: "DEVICE"
    })));
  }
  assert.equal(sqlCalls.length, 0);
  finishAuthorization(true);
  await waitForMessages();
  assert.equal(ws.deviceIdentified, true);
  assert.deepEqual(events.filter(event => event.type === "state").map(event => event.OutputSignal),
    Array.from({ length: 8 }, (_, index) => `OS${index + 1}`));
});

test("unauthenticated queued messages cannot change device data", async () => {
  const { context, sqlCalls, ws } = createHarness();
  let onMessage;
  ws.on = (_event, handler) => { onMessage = handler; };
  const waitForMessages = context.attachDeviceDeviceMessageHandler(ws, Promise.resolve(false));
  onMessage(Buffer.from(JSON.stringify({ type: "state", OutputSignal: "OS1", state: "ON" })));
  await waitForMessages();
  assert.equal(sqlCalls.length, 0);
});

function createUiHarness(viewOnly = false, channels = [8], channelOverrides = {}, deviceOverrides = {}) {
  const listeners = {};
  const nodes = {
    inputString: { textContent: "sensor" }, outputString: { textContent: "MOTOR_ON" },
    inputState: { textContent: "OFF", dataset: {} }, outputState: { textContent: "OFF", dataset: {} },
    lastSource: { textContent: "initial-operator", dataset: {} }, lastChangedAt: { textContent: "initial-time" }
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
      sendDeviceCommand: message => commands.push(message)
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
    location: { pathname: viewOnly ? "/device-view.html" : "/device-control.html" },
    CSS: { escape: value => value }, console,
    fetch: async () => ({ ok: true, json: async () => [{
      device_id: "DEVICE-D1-002", ...deviceOverrides, sets: channels.map(channel => ({
        input_signal: `IS${channel}`, output_signal: `OS${channel}`, input_signal: `IS${channel}`, output_signal: `OS${channel}`,
        output_state: "OFF", input_state: "ON", input_message: "sensor", output_message: "MOTOR_ON", last_change_source: "initial-operator",
        last_changed_at: "2026-10-03 12:00:00.000", created_at: "2026-10-03 09:00:00.000", ...channelOverrides
      }))
    }] })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "device-active.js"), "utf8"), context);
  return { listeners, nodes, root, commands, buttons };
}

test("channelString in browser leaves OStr unchanged", () => {
  const { listeners, nodes } = createUiHarness();
  listeners["device-state-update"]({ detail: {
    type: "channelString", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", IStr: "new-sensor"
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
  listeners["device-state-update"]({ detail: {
    type: "state", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", state: "ON", inputState: "OFF",
    IStr: "sensor-8", OStr: "motor-8"
  } });
  await new Promise(setImmediate);
  assert.equal(nodes.inputState.textContent, "OFF");
  assert.equal(nodes.outputState.textContent, "ON");
  assert.equal(nodes.inputString.textContent, "sensor-8");
  assert.equal(nodes.outputString.textContent, "motor-8");
  assert.ok(root.innerHTML.includes('data-command-output-string="OS8"'));
  assert.ok(root.innerHTML.includes("<span data-device-istr>IStr8: <code"));
  assert.ok(root.innerHTML.includes("<span data-device-ostr>OStr8: <code"));
  assert.ok(root.innerHTML.includes('aria-label="OStr8 ON"'));
  assert.ok(root.innerHTML.includes('aria-label="OStr8 OFF"'));
});

test("string labels use actual channel numbers for all eight and reordered channels", async () => {
  const allChannels = createUiHarness(false, [1, 2, 3, 4, 5, 6, 7, 8]);
  const reorderedChannels = createUiHarness(false, [8, 2]);
  await new Promise(setImmediate);
  for (const channel of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(allChannels.root.innerHTML.includes(`<span data-device-istr>IStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`<span data-device-ostr>OStr${channel}: <code`));
    assert.ok(allChannels.root.innerHTML.includes(`aria-label="OStr${channel} ON"`));
    assert.ok(allChannels.root.innerHTML.includes(`aria-label="OStr${channel} OFF"`));
  }
  const labels = [...reorderedChannels.root.innerHTML.matchAll(/<span data-device-(?:istr|ostr)>([IO]Str[1-8]): <code/g)]
    .map(match => match[1]);
  assert.deepEqual(labels, ["IStr8", "OStr8", "IStr2", "OStr2"]);
});

test("channel header shows last source and IS/OS states share the signal row", async () => {
  const { root } = createUiHarness();
  await new Promise(setImmediate);
  const header = root.innerHTML.slice(root.innerHTML.indexOf('class="channel-card-head"'), root.innerHTML.indexOf('class="signal-path"'));
  assert.ok(header.includes("최근 변경"));
  assert.match(header, /data-active-last-source="OS8"[^>]*>initial-operator/);
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
    type: "stateChanged", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", OutputState: "ON",
    lastChangedAt: "2026-10-03T03:00:00.000Z"
  };
  browser.listeners["device-state-update"]({ detail: report });
  const displayedTime = browser.nodes.lastChangedAt.textContent;
  assert.ok(displayedTime.includes("12:00:00"));
  browser.listeners["device-state-update"]({ detail: { ...report, type: "state", changedAt: "2026-10-03T04:00:00.000Z" } });
  assert.equal(browser.nodes.lastChangedAt.textContent, displayedTime);
  browser.listeners["device-state-update"]({ detail: { ...report, lastChangedAt: "2026-10-03 12:00:00.000" } });
  assert.equal(browser.nodes.lastChangedAt.textContent, displayedTime);
});

test("server keeps actual last change time for unchanged output", async () => {
  const { context, events, ws } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", OutputState: "OFF"
  });
  assert.equal(events[0].lastChangedAt, "2026-10-03 12:00:00.000");
  await context.handleDeviceDeviceMessage(ws, {
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
  browser.listeners["device-state-update"]({ detail: {
    type: "state", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", OutputState: "OFF", lastChangedAt: null
  } });
  await new Promise(setImmediate);
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 09:00:00");
  browser.listeners["device-state-update"]({ detail: {
    type: "deviceSnapshot", state: { device_id: "DEVICE-D1-002", channels: [{
      output_signal: "OS8", output_state: "OFF", last_changed_at: null
    }] }
  } });
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 09:00:00");
});

test("initial API preserves a newer device change received before rendering", async () => {
  const browser = createUiHarness();
  browser.listeners["device-state-update"]({ detail: {
    type: "stateChanged", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", OutputState: "ON",
    source: "new-operator", changedAt: "2026-10-03T04:00:00.000Z"
  } });
  await new Promise(setImmediate);
  assert.equal(browser.nodes.lastChangedAt.textContent, "2026-10-03 13:00:00");
  assert.equal(browser.nodes.lastSource.textContent, "new-operator");
  assert.equal(browser.nodes.outputState.textContent, "ON");
});

test("completed schedules update channel OStr and show scheduled author in live and initial views", async () => {
  for (const state of ["ON", "OFF"]) {
    const server = createHarness({ command_id: "scheduled-command", output_signal: "OS8", requested_output_state: state, output_message: "scheduled OStr", requested_by: state === "ON" ? "SCHEDULE:16" : "SCHEDULE:16:scheduler_01", command_status: "DELIVERED" });
    const browser = createUiHarness();
    await new Promise(setImmediate);
    await server.context.handleDeviceDeviceMessage(server.ws, { type: "ack", commandId: "scheduled-command", OutputSignal: "OS8", OutputState: state, success: true });
    for (const event of server.events) browser.listeners["device-state-update"]({ detail: event });
    assert.equal(browser.nodes.outputString.textContent, "scheduled OStr");
    assert.equal(browser.nodes.lastSource.textContent, "scheduler_01");
    assert.equal(browser.nodes.lastSource.dataset.scheduleSource, "true");
    const update = server.sqlCalls.find(call => call.sql.includes("SET output_state=?,input_state=?"));
    assert.equal(update.params[2], "SCHEDULE:16:scheduler_01");
    assert.equal(update.params[4], "scheduled OStr");
    const completion = server.sqlCalls.find(call => call.sql.includes("UPDATE device_schedule SET last_execution_status="));
    assert.ok(completion);
    assert.equal(completion.params[0], "ACKED");
    assert.equal(completion.params.at(-1), "16");
    browser.listeners["device-state-update"]({ detail: { type: "stateChanged", deviceId: server.ws.deviceId, OutputSignal: "OS8", OutputState: "ON", source: "operator" } });
    assert.equal(browser.nodes.lastSource.textContent, "operator");
    assert.equal(browser.nodes.lastSource.dataset.scheduleSource, "false");
  }
  const initial = createUiHarness(false, [8], { last_change_source: "SCHEDULE:16:scheduler_01", output_message: "saved scheduled OStr" });
  await new Promise(setImmediate);
  assert.match(initial.root.innerHTML, /data-schedule-source="true">scheduler_01<\/strong>/);
  assert.equal(initial.nodes.outputString.textContent, "saved scheduled OStr");
  const failed = createHarness({ command_id: "failed-schedule", output_signal: "OS8", requested_output_state: "ON", output_message: "not applied", requested_by: "SCHEDULE:17", command_status: "DELIVERED" });
  await failed.context.handleDeviceDeviceMessage(failed.ws, { type: "ack", commandId: "failed-schedule", OutputSignal: "OS8", OutputState: "OFF", success: false });
  assert.equal(failed.events.some(event => event.type === "stateChanged"), false);
  const browser = createUiHarness();
  await new Promise(setImmediate);
  const previousOutput = browser.nodes.outputString.textContent;
  browser.listeners["device-state-update"]({ detail: { type: "commandQueued", deviceId: failed.ws.deviceId, OutputSignal: "OS8", state: "ON", requester: "SCHEDULE:17", outputString: "not applied" } });
  assert.equal(browser.nodes.outputString.textContent, previousOutput);
  assert.notEqual(browser.nodes.lastSource.textContent, "예약자");
  const css = postcss.parse(fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8"));
  const scheduledSourceRule = css.nodes.find(node => node.selector === '.channel-last-source strong[data-schedule-source="true"]');
  assert.ok(scheduledSourceRule);
  assert.ok(scheduledSourceRule.nodes.some(node => node.prop === "color" && node.value === "blue"));
});

test("last source updates from device state and snapshot, not queued commands", async () => {
  const { listeners, nodes } = createUiHarness();
  await new Promise(setImmediate);
  listeners["device-state-update"]({ detail: {
    type: "stateChanged", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", OutputState: "ON", source: "operator-8"
  } });
  assert.equal(nodes.lastSource.textContent, "operator-8");
  listeners["device-state-update"]({ detail: {
    type: "commandQueued", deviceId: "DEVICE-D1-002", OutputSignal: "OS8", state: "OFF", requested_by: "pending-operator"
  } });
  assert.equal(nodes.lastSource.textContent, "operator-8");
  listeners["device-state-update"]({ detail: {
    type: "deviceSnapshot", state: { device_id: "DEVICE-D1-002", channels: [{
      output_signal: "OS8", input_signal: "IS8", output_state: "OFF", last_change_source: "snapshot-operator"
    }] }
  } });
  assert.equal(nodes.lastSource.textContent, "snapshot-operator");
  assert.equal(nodes.outputState.textContent, "OFF");
});

test("control sends OStr with output command; view-only has no command field", async () => {
  const { listeners, commands } = createUiHarness();
  const button = {
    dataset: { deviceId: "DEVICE-D1-002", pin: "OS8", state: "ON" },
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
        dataset: { deviceId: "DEVICE-D1-002", pin: `OS${channel}`, state },
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
  const emptyInputButton = {
    dataset: { deviceId: "DEVICE-D1-002", pin: "OS1", state: "ON" },
    closest: () => ({ querySelector: () => ({ value: "" }) })
  };
  listeners.click({ target: { closest: () => emptyInputButton } });
  assert.equal(commands.at(-1).OStr, "");
});

test("explicitly empty OStr is sent empty while omitted OStr uses the saved channel value", async () => {
  const { context, sent, ws, sqlCalls } = createHarness();
  const result = await context.queueDeviceCommand(ws.deviceId, "OS8", "ON", "operator", "");
  assert.equal(result.outputString, "");
  assert.equal(sent[0].OStr, "");
  assert.equal(sqlCalls.some(call => call.sql.includes("SELECT output_message FROM device_channel")), false);
  const legacyResult = await context.queueDeviceCommand(ws.deviceId, "OS8", "OFF", "operator");
  assert.equal(legacyResult.outputString, "previous-command");
  assert.equal(sent[1].OStr, "previous-command");
});

test("firmware IP is persisted and sent to subscribed browsers", async () => {
  const { context, events, sqlCalls, ws } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", state: "OFF", ip: "192.168.0.8"
  });
  const ipUpdate = sqlCalls.find(call => call.sql.includes("SET last_ip=?"));
  assert.deepEqual(Array.from(ipUpdate.params), ["192.168.0.8", ws.deviceId]);
  assert.equal(events[0].ip, "192.168.0.8");
});

test("legacy firmware fields are accepted but broadcasts use only signal fields", async () => {
  const { context, events, ws } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
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
  await server.context.handleDeviceDeviceMessage(server.ws, {
    type: "state", deviceId: server.ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
    state: "ON", inputState: "OFF", IStr: "sensor-8", OStr: "motor-8"
  });
  for (const event of server.events) browser.listeners["device-state-update"]({ detail: event });
  assert.equal(browser.nodes.inputState.textContent, "OFF");
  assert.equal(browser.nodes.outputState.textContent, "ON");
  assert.equal(browser.nodes.inputString.textContent, "sensor-8");
  assert.equal(browser.nodes.outputString.textContent, "motor-8");
  await server.context.handleDeviceDeviceMessage(server.ws, {
    type: "state", deviceId: server.ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
    state: "ON", inputState: "OFF", IStr: "sensor-8", OStr: ""
  });
  for (const event of server.events.splice(0)) browser.listeners["device-state-update"]({ detail: event });
  assert.equal(browser.nodes.outputString.textContent, "");
});

test("firmware serialization and command handling use signal fields", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  assert.ok(firmware.includes('document["InputSignal"]'));
  assert.ok(firmware.includes('document["OutputSignal"]'));
  assert.ok(firmware.includes('command["OutputSignal"]'));
  assert.equal(/\["(?:pin|inputPin)"\]/.test(firmware), false);
  assert.equal(/\b(?:inputName|outputName|DEVICE_PIN_NAME)\b/.test(firmware), false);
});

test("firmware clears its displayed OStr when a command explicitly sends an empty string", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  const start = firmware.indexOf("const bool hasOutputString =");
  const end = firmware.indexOf("String requestedState =", start);
  assert.ok(start >= 0 && end > start);
  const stringHandling = firmware.slice(start, end);
  assert.ok(stringHandling.includes('command["OStr"].is<const char*>()'));
  assert.ok(stringHandling.includes('command["receiveString"].is<const char*>()'));
  assert.equal((stringHandling.match(/channel->outputString = receivedString;/g) || []).length, 2);
  assert.doesNotMatch(stringHandling, /receivedString\.length\(\)/);
});

test("device OutputState is authoritative over legacy state", async () => {
  const { context, events, ws, sqlCalls } = createHarness();
  await context.handleDeviceDeviceMessage(ws, {
    type: "state", deviceId: ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
    OutputState: "ON", state: "OFF", inputState: "ON", source: "DEVICE"
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
  await context.handleDeviceDeviceMessage(ws, {
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
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
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
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  assert.match(firmware, /Serial\.print\("\[STRING TX\] IStr"\);\s*Serial\.print\(channel\.inputSignal \+ 2\);/);
  assert.match(firmware, /Serial\.print\(" \| OStr"\);\s*Serial\.print\(channel->outputSignal \+ 2\);/);
  assert.equal(firmware.includes("[STRING RX]"), false);
  assert.equal(firmware.includes("[STATE TX]"), false);
});

test("serial status lines suppress identical reports while keeping real changes", () => {
  const { context, lines } = createFirmwareLogicHarness();
  const channel = { inputSignal: "IS1", outputSignal: "OS1", inputState: false, outputState: false, severSignal: false };
  context.printOutputStatus(channel, "DEVICE");
  context.printOutputStatus(channel, "DEVICE");
  assert.equal(lines.length, 1);
  channel.inputState = true;
  context.printOutputStatus(channel, "DEVICE");
  assert.equal(lines.length, 2);
  context.applyOutputState(channel, true, "DEVICE");
  assert.equal(lines.length, 3);
  context.printOutputStatus(channel, "DEVICE");
  assert.equal(lines.length, 3);
  assert.equal(channel.stateReportPending, true);
  channel.severSignal = true;
  context.printOutputStatus(channel, "CLIENT");
  context.printOutputStatus(channel, "CLIENT");
  assert.equal(lines.length, 4);
});

test("firmware inputs immediately drive outputs and schedule reports for all eight channels", () => {
  const { context, setTime } = createFirmwareLogicHarness();
  for (let index = 1; index <= 8; index++) {
    const channel = {
      inputState: true, outputState: false, lastRawInput: false, debouncedInput: false,
      lastDebounceMs: 0, stateReportPending: false, inputSignal: `IS${index}`, outputSignal: `OS${index}`
    };
    setTime(0);
    context.handleInputSignal(channel);
    assert.equal(channel.outputState, true);
    assert.equal(channel.stateReportPending, true);
    assert.equal(channel.pendingStateSource, "DEVICE");
    channel.inputState = false;
    channel.stateReportPending = false;
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
  assert.equal(channel.stateReportPending, true);
  channel.stateReportPending = false;
  context.applyOutputState(channel, true, "CLIENT");
  assert.equal(channel.stateReportPending, true);
  assert.equal(channel.pendingStateSource, "CLIENT");
});

function loadButtonDebounceFunctions(context) {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  for (const [name, parameters] of [["updateButtonDebounce", "button, rawInput, now, holdMs=50"]]) {
    const signature = new RegExp(`bool ${name}\\([^)]*\\)\\s*\\{`).exec(firmware);
    assert.ok(signature);
    const body = firmware.slice(signature.index + signature[0].length, firmware.indexOf("\n}", signature.index))
      .replace(/\bbool\s+/g, "let ").replace(/now - button\.changedAtMs/g, "((now - button.changedAtMs) >>> 0)");
    vm.runInContext(`function ${name}(${parameters}) { ${body} }`, context);
  }
}

test("firmware button debounce requires 50ms stable input and isolates multiple buttons", () => {
  const context = vm.createContext({});
  loadButtonDebounceFunctions(context);
  const state = () => ({ initialized: false, lastRawInput: false, stableInput: false, changedAtMs: 0 });
  const first = state(), second = state();
  const update = context.updateButtonDebounce;
  assert.equal(update(first, true, 0), false);
  assert.equal(update(first, true, 49), false);
  assert.equal(update(first, true, 50), true);
  assert.equal(update(first, true, 51), false);
  assert.equal(update(first, false, 60), false);
  assert.equal(update(first, true, 70), false);
  assert.equal(update(first, false, 80), false);
  assert.equal(update(first, false, 129), false);
  assert.equal(update(first, false, 130), true);
  assert.equal(update(second, true, 100), false);
  assert.equal(update(second, true, 149), false);
  assert.equal(update(second, true, 150), true);
  assert.equal(first.stableInput, false);
  const wrapping = state();
  assert.equal(update(wrapping, true, 0xfffffff0), false);
  assert.equal(update(wrapping, true, 33), false);
  assert.equal(update(wrapping, true, 34), true);
  const custom = state();
  assert.equal(update(custom, true, 0, 80), false);
  assert.equal(update(custom, true, 79, 80), false);
  assert.equal(update(custom, true, 80, 80), true);
});

test("firmware debounce keeps independent state for every tracked button", () => {
  const context = vm.createContext({});
  loadButtonDebounceFunctions(context);
  const update = context.updateButtonDebounce;
  const tracked = Array.from({ length: 17 }, () => ({ initialized: false, lastRawInput: false, stableInput: false, changedAtMs: 0 }));
  for (const button of tracked) assert.equal(update(button, true, 0), false);
  assert.equal(update(tracked[16], true, 49), false);
  assert.equal(update(tracked[16], true, 50), true);
  assert.equal(tracked[16].stableInput, true);
  assert.equal(tracked[0].stableInput, false);
});

test("firmware sketch applies only debounced button edges to IS1", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  const sketch = fs.readFileSync(path.join(__dirname, "..", "device", "Wemos-D1-001.ino"), "utf8");
  const context = vm.createContext({});
  loadButtonDebounceFunctions(context);
  const button = { initialized: true, lastRawInput: true, stableInput: true, changedAtMs: 0 };
  const update = context.updateButtonDebounce;
  assert.equal(update(button, true, 0), false);
  assert.equal(update(button, false, 10), false);
  assert.equal(update(button, false, 59), false);
  assert.equal(update(button, false, 60), true);
  assert.equal(button.stableInput, false);
  assert.equal(update(button, true, 70), false);
  assert.equal(update(button, true, 120), true);
  assert.equal(button.stableInput, true);
  assert.match(firmware, /bool pinStateChanged\(int rawState, bool &pinState\)/);
  assert.match(firmware, /updateButtonDebounce\(buttons\[slot\], rawInput, now\)/);
  assert.match(sketch, /if \(pinStateChanged\(digitalRead\(buttonPin\), buttonPinState\)\)\s*\{\s*IS1 = \(buttonPinState == LOW\);/);
  const loop = sketch.slice(sketch.indexOf("void loop()"));
  assert.ok(loop.indexOf("deviceLoop();") < loop.indexOf("if (pinStateChanged("));
});

test("firmware retains disconnected and failed state reports until successful transmission", () => {
  const firmware = fs.readFileSync(path.join(__dirname, "..", "device", "WemosDevice.h"), "utf8");
  const signature = /void handleStateReport\([^)]*\)\s*\{/.exec(firmware);
  const body = firmware.slice(signature.index + signature[0].length, firmware.indexOf("\n}", signature.index)).replace(/\bbool\s+/g, "let ");
  const sent = [];
  const context = vm.createContext({ wsConnected: false, succeeds: false, sendStateReport: (channel, source) => { sent.push({ output: channel.outputState, source }); return context.succeeds; } });
  vm.runInContext(`function handleStateReport(channel) { ${body} }`, context);
  const channel = { outputState: false, stateReportPending: true, pendingStateSource: "DEVICE" };
  context.handleStateReport(channel);
  assert.equal(sent.length, 0);
  assert.equal(channel.stateReportPending, true);
  channel.outputState = true;
  context.wsConnected = true;
  context.handleStateReport(channel);
  assert.equal(channel.stateReportPending, true);
  context.succeeds = true;
  context.handleStateReport(channel);
  assert.equal(channel.stateReportPending, false);
  assert.deepEqual(sent.at(-1), { output: true, source: "DEVICE" });
  const connected = firmware.slice(firmware.indexOf("case WStype_CONNECTED:"), firmware.indexOf("case WStype_TEXT:"));
  assert.match(connected, /channel\.stateReportPending\s*=\s*true/);
  assert.ok(connected.indexOf("localInputHandler();") < connected.indexOf("sendHello();"));
  const reportSignature = /bool sendStateReport\([^)]*\)\s*\{/.exec(firmware);
  assert.ok(reportSignature);
  const report = firmware.slice(reportSignature.index, firmware.indexOf("\n}", reportSignature.index));
  assert.ok(report.indexOf("localInputHandler();") < report.indexOf('document["OutputState"]'));
  const loopSignature = /void deviceLoop\(\)\s*\{/.exec(firmware);
  assert.ok(loopSignature);
  const loop = firmware.slice(loopSignature.index);
  assert.ok(loop.indexOf("handleWiFi();") < loop.indexOf("handleInputSignal("));
  assert.ok(loop.indexOf("handleInputSignal(") < loop.indexOf("handleStateReport("));
  assert.match(loop, /if \(wsStarted\)\s*\{\s*webSocket\.loop\(\);/);
  assert.match(loop, /if \(WiFi\.status\(\) ==\s*WL_CONNECTED\)/);
  assert.match(firmware, /bool sent = webSocket\.sendTXT\(payload\)/);
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
    await server.context.queueDeviceCommand(request.deviceId, request.OutputSignal, request.severSignal, "operator", request.OStr);
    assert.equal(server.sent.at(-1).severSignal, desiredState);
    for (const event of server.events.splice(0)) browser.listeners["device-state-update"]({ detail: event });
    assert.equal(browser.nodes.outputState.textContent, previousState);
    await server.context.handleDeviceDeviceMessage(server.ws, {
      type: "state", deviceId: server.ws.deviceId, OutputSignal: "OS8", InputSignal: "IS8",
      OutputState: desiredState, inputState: "OFF", source: "CLIENT", OStr: "motor-8"
    });
    for (const event of server.events.splice(0)) browser.listeners["device-state-update"]({ detail: event });
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
  let permission = 4;
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
  permission = 3;
  await server.context.handleBrowserMessageForTest(Buffer.from(JSON.stringify(request)));
  assert.equal(server.sent.length, 1);
  assert.equal(replies[1].ok, false);
});

test("Device admin device count stays beside its heading without the status bar", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device-admin.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "device-admin.js"), "utf8");
  assert.doesNotMatch(html, /class="device-statusbar"/);
  assert.match(html, /<div class="admin-device-title"><h3>등록 장치<\/h3><span id="deviceCount" class="admin-device-count">0대<\/span><\/div>/);
  assert.match(script, /\$\("deviceCount"\)\.textContent = `\$\{devices\.length\}대`;/);
  assert.doesNotMatch(script, /\$\("(?:user|permission)"\)/);
});