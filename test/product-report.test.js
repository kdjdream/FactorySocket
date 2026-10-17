const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { reportTime, reportSqlTime } = require("../device-report");
const { bucketStart, buildProductReport, loadProductReport, ensureProductHistory, createProductWorkbook } = require("../product-report");
const { parseQuantity, parseQuantityReason, validateQuantityEdit, ensureProductQuantityColumns } = require("../product-quantity");

const start = reportTime("2026-10-12 09:00:00");
const end = start + 3 * 3600000;
const product = { id: 1, product_code: "P-001", product_name: "제품 A" };
const event = (minutes, quantity) => ({ product_id: 1, quantity, changed_at: reportSqlTime(start + minutes * 60000) });

test("quantity editing isolates cumulative, work and target fields and requires a reason", () => {
  for (const [kind, column] of [["cumulative", "quantity"], ["work", "work_quantity"], ["target", "target_quantity"]]) {
    assert.deepEqual(validateQuantityEdit({ kind, quantity: 0, reason: " 작업 시작 초기화 " }), { kind, column, quantity: 0, reason: "작업 시작 초기화" });
  }
  assert.equal(validateQuantityEdit({ quantity: 10, reason: "보정" }).kind, "cumulative");
  for (const quantity of [-1, 0.5, null, "", true, 2147483648, Infinity]) assert.equal(parseQuantity(quantity), null);
  assert.equal(parseQuantity("2147483647"), 2147483647);
  assert.ok(validateQuantityEdit({ kind: "work", quantity: 10, reason: " " }).error);
  assert.ok(validateQuantityEdit({ kind: "work", quantity: 10, reason: "x".repeat(501) }).error);
  assert.ok(validateQuantityEdit({ kind: "quantity=0", quantity: 10, reason: "보정" }).error);
});

test("quantity API changes only the chosen field and trusts only the session actor", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.put("/api/products/:id/quantity",');
  const routeEnd = source.indexOf('app.put("/api/products/:id/status",', routeStart);
  let handler;
  const updates = [];
  const context = vm.createContext({
    validateQuantityEdit, parseQuantityReason, console,
    app: { put: (_route, ...handlers) => { handler = handlers.at(-1); } },
    requireLogin() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {},
    PRODUCT_FIELDS: "fields", PRODUCT_JOIN: "FROM product", broadcast() {},
    query: async (sql, params) => {
      if (sql.startsWith("UPDATE")) { updates.push({ sql, params }); return { affectedRows: 1 }; }
      return [{ id: 1, quantity: 10, work_quantity: 3, target_quantity: 100, is_enabled: 1 }];
    }
  });
  vm.runInContext(source.slice(routeStart, routeEnd), context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() {} };
  for (const [kind, column] of [["cumulative", "quantity"], ["work", "work_quantity"], ["target", "target_quantity"]]) {
    await handler({ params: { id: "1" }, body: { kind, quantity: 0, reason: "보정", username: "forged-user" }, user: { id: 12, username: "auditor" } }, response);
    const update = updates.at(-1);
    assert.ok(update.sql.startsWith(`UPDATE product SET ${column}=?`));
    assert.equal(update.params[1], "보정");
    assert.equal(update.params[2], "auditor");
    assert.equal(update.params[3], 12);
    for (const other of ["quantity", "work_quantity", "target_quantity"].filter(name => name !== column)) assert.doesNotMatch(update.sql, new RegExp(`\\b${other}=\\?`));
  }
  const count = updates.length;
  await handler({ params: { id: "1" }, body: { kind: "work", quantity: 3, reason: "" }, user: { id: 12, username: "auditor" } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(updates.length, count);
});

test("production quantity API increments cumulative and work totals atomically", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.put("/api/products/:id/quantity",');
  const routeEnd = source.indexOf('app.put("/api/products/:id/status",', routeStart);
  let handler;
  const updates = [];
  let current = { id: 1, quantity: 100, work_quantity: 40, target_quantity: 200, is_enabled: 1 };
  const context = vm.createContext({
    validateQuantityEdit, parseQuantityReason, console,
    app: { put: (_route, ...handlers) => { handler = handlers.at(-1); } },
    requireLogin() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {},
    PRODUCT_FIELDS: "fields", PRODUCT_JOIN: "FROM product", broadcast() {},
    query: async (sql, params) => {
      if (sql.startsWith("UPDATE")) {
        updates.push({ sql, params });
        if (current.quantity >= params[6] && current.work_quantity >= params[7] && current.quantity <= params[8] && current.work_quantity <= params[9]) {
          current = { ...current, quantity: current.quantity + params[0], work_quantity: current.work_quantity + params[1] };
          return { affectedRows: 1 };
        }
        return { affectedRows: 0 };
      }
      return [current];
    }
  });
  vm.runInContext(source.slice(routeStart, routeEnd), context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  const request = { params: { id: "1" }, body: { kind: "production", quantity: 7, reason: "작업 추가" }, user: { id: 12, username: "operator" } };
  await handler(request, response);
  assert.match(updates[0].sql, /quantity=quantity\+\?,work_quantity=work_quantity\+\?/);
  assert.deepEqual([updates[0].params[0], updates[0].params[1]], [7, 7]);
  assert.deepEqual([response.data.quantity, response.data.work_quantity, response.data.target_quantity], [107, 47, 200]);
  const negativeRequest = { ...request, body: { kind: "production", quantity: -10, reason: "작업 보정" } };
  await handler(negativeRequest, response);
  assert.deepEqual([updates[1].params[0], updates[1].params[1]], [-10, -10]);
  assert.deepEqual([response.data.quantity, response.data.work_quantity, response.data.target_quantity], [97, 37, 200]);
  current = { ...current, quantity: 2147483645 };
  const overflowResponse = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  await handler(request, overflowResponse);
  assert.equal(overflowResponse.statusCode, 400);
  assert.match(overflowResponse.data.error, /허용 범위/);
  current = { ...current, quantity: 5, work_quantity: 3 };
  const underflowResponse = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ ...request, body: { kind: "production", quantity: -7, reason: "작업 취소" } }, underflowResponse);
  assert.equal(underflowResponse.statusCode, 400);
  assert.match(underflowResponse.data.error, /허용 범위/);
});

test("product status API records status changes with actor and STATUS type", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.put("/api/products/:id/status",');
  const routeEnd = source.indexOf("function validateProduct(", routeStart);
  let handler;
  let update;
  const context = vm.createContext({
    console,
    app: { put: (_route, ...handlers) => { handler = handlers.at(-1); } },
    requireLogin() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {},
    PRODUCT_FIELDS: "fields", PRODUCT_JOIN: "FROM product", broadcast() {},
    query: async (sql, params) => {
      if (sql.startsWith("UPDATE")) { update = { sql, params }; return { affectedRows: 1 }; }
      return [{ id: 1, product_status: "생산중", is_enabled: 1 }];
    }
  });
  vm.runInContext(source.slice(routeStart, routeEnd), context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ params: { id: "1" }, body: { status: "생산중" }, user: { id: 12, username: "operator" } }, response);
  assert.match(update.sql, /product_status=\?,quantity_reason='상태 변경',quantity_actor=\?,quantity_change_type='STATUS'/);
  assert.deepEqual(Array.from(update.params), ["생산중", "operator", 12, 1]);
});

test("product admin validates cumulative, work and target inputs separately", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const validationStart = source.indexOf("function validateProduct(");
  const validationEnd = source.indexOf('app.post("/api/admin/products",', validationStart);
  const context = vm.createContext({ parseQuantity });
  vm.runInContext(source.slice(validationStart, validationEnd), context);
  const input = { productCode: "P-001", productName: "제품", quantity: "100", workQuantity: "7", targetQuantity: "50", reason: "수량 보정", status: "생산중" };
  const result = context.validateProduct(input);
  assert.equal(result.quantity, 100);
  assert.equal(result.workQuantity, 7);
  assert.equal(result.targetQuantity, 50);
  for (const key of ["quantity", "workQuantity", "targetQuantity"]) {
    for (const invalid of ["", null, true, -1, 0.5, 2147483648]) assert.ok(context.validateProduct({ ...input, [key]: invalid }).error);
  }
});

test("product runtime schema preserves legacy is_active values as is_enabled", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const ensureSchemaStart = source.indexOf("async function ensureSchema()");
  const productStart = source.indexOf("  await query(`CREATE TABLE IF NOT EXISTS product (", ensureSchemaStart);
  const productEnd = source.indexOf("  await query(`CREATE TABLE IF NOT EXISTS user_setting (", productStart);
  const setup = source.slice(productStart, productEnd);
  assert.ok(productStart >= 0 && productEnd > productStart);
  for (const initialColumns of [new Set(["is_active", "sort_order", "updated_by_label"]), new Set(["is_active", "is_enabled", "sort_order", "updated_by_label"])]) {
    const columns = new Set(initialColumns);
    const calls = [];
    const context = vm.createContext({ query: async sql => {
      calls.push(sql);
      const match = /^SHOW COLUMNS FROM product LIKE '([^']+)'$/.exec(sql);
      if (match) return columns.has(match[1]) ? [{ Field: match[1] }] : [];
      if (sql === "ALTER TABLE product CHANGE COLUMN is_active is_enabled TINYINT(1) NOT NULL DEFAULT 1") {
        columns.delete("is_active"); columns.add("is_enabled");
      }
      if (sql === "UPDATE product SET is_enabled=is_active") columns.add("is_enabled");
      if (sql === "ALTER TABLE product DROP COLUMN is_active") columns.delete("is_active");
      return [];
    } });
    vm.runInContext(`async function setupProduct() {\n${setup}\n}`, context);
    await context.setupProduct();
    const create = calls.find(sql => sql.includes("CREATE TABLE IF NOT EXISTS product ("));
    assert.match(create, /is_enabled TINYINT\(1\) NOT NULL DEFAULT 1/);
    assert.doesNotMatch(create, /\bis_active\b/);
    assert.equal(columns.has("is_enabled"), true);
    assert.equal(columns.has("is_active"), false);
    if (initialColumns.has("is_enabled")) {
      assert.ok(calls.includes("UPDATE product SET is_enabled=is_active"));
      assert.ok(calls.indexOf("UPDATE product SET is_enabled=is_active") < calls.indexOf("ALTER TABLE product DROP COLUMN is_active"));
    } else assert.ok(calls.includes("ALTER TABLE product CHANGE COLUMN is_active is_enabled TINYINT(1) NOT NULL DEFAULT 1"));
  }
});

test("work and target edits are audited but product report quantities remain cumulative", async () => {
  const result = buildProductReport(product, { quantity: 100 }, [
    { ...event(10, 100), work_quantity: 0, target_quantity: 100, change_reason: "작업 초기화", changed_by_user_id: 12, changed_by_username: "auditor", change_type: "MANUAL" },
    { ...event(20, 100), work_quantity: 0, target_quantity: 200, change_reason: "목표 변경", changed_by_user_id: 12, changed_by_username: "auditor", change_type: "MANUAL" },
    { ...event(30, 105), work_quantity: 5, change_reason: "", change_type: "DEVICE" }
  ], start, end);
  assert.equal(result.initialQuantity, 100);
  assert.equal(result.endQuantity, 105);
  assert.equal(result.increaseQuantity, 5);
  assert.equal(result.workQuantity, 5);
  assert.equal(result.changes[0].reason, "작업 초기화");
  assert.equal(result.changes[0].username, "auditor");
  assert.equal(result.changes[0].workQuantity, 0);
  assert.equal(result.changes[1].targetQuantity, 200);
  assert.equal(result.changes[2].reason, "");
  const workbook = new (require("exceljs").Workbook)();
  await workbook.xlsx.load(await createProductWorkbook({ start, end, products: [result] }));
  const history = workbook.getWorksheet("수량 변경 이력");
  assert.equal(history.getCell("C2").value, 100);
  assert.equal(history.getCell("D2").value, 0);
  assert.equal(history.getCell("E2").value, 0);
  assert.equal(history.getCell("F3").value, 200);
  assert.equal(history.getCell("G2").value, "작업 초기화");
  assert.equal(history.getCell("H2").value, 12);
  assert.equal(history.getCell("I2").value, "auditor");
  assert.equal(history.getCell("F1").value, "목표 수량");
  assert.ok(!history.getCell("G4").value);
  assert.equal(history.columnCount, 11);
});

test("existing work quantities are not initialized again on restart", async () => {
  const calls = [];
  await ensureProductQuantityColumns(async sql => {
    calls.push(sql);
    return ["work_quantity", "quantity_reason", "quantity_actor", "quantity_change_type"].map(Field => ({ Field }));
  });
  assert.deepEqual(calls, ["SHOW COLUMNS FROM product"]);
});

test("product totals use a baseline and separate net increase from positive work", () => {
  const result = buildProductReport(product, { quantity: 100 }, [event(10, 105), event(70, 102), event(130, 110), event(180, 999)], start, end);
  assert.equal(result.initialQuantity, 100);
  assert.equal(result.endQuantity, 110);
  assert.equal(result.increaseQuantity, 10);
  assert.equal(result.workQuantity, 13);
  assert.equal(result.points[0].value, 0);
  assert.equal(result.points.at(-1).value, 10);
  assert.deepEqual(result.buckets.hourly.map(bucket => bucket.quantity), [5, 0, 8]);
  assert.equal(result.buckets.daily[0].quantity, 13);
});

test("report basis independently aggregates cumulative and work quantity snapshots", () => {
  const events = [
    { ...event(10, 101), work_quantity: 42 },
    { ...event(70, 103), work_quantity: 45 },
    { ...event(130, 104), work_quantity: 43 },
    { ...event(170, 108), work_quantity: 50 }
  ];
  const baseline = { quantity: 100, work_quantity: 40 };
  const cumulative = buildProductReport(product, baseline, events, start, end);
  const work = buildProductReport(product, baseline, events, start, end, true, "work");
  assert.equal(cumulative.basis, "cumulative");
  assert.deepEqual([cumulative.initialQuantity, cumulative.endQuantity, cumulative.increaseQuantity, cumulative.workQuantity], [100, 108, 8, 8]);
  assert.deepEqual(cumulative.buckets.hourly.map(bucket => bucket.quantity), [1, 2, 5]);
  assert.equal(work.basis, "work");
  assert.deepEqual([work.initialQuantity, work.endQuantity, work.increaseQuantity, work.workQuantity], [40, 50, 10, 12]);
  assert.deepEqual(work.points.map(point => point.value), [0, 2, 5, 3, 10, 10]);
  assert.deepEqual(work.buckets.hourly.map(bucket => bucket.quantity), [2, 3, 7]);
  assert.deepEqual(work.changes.map(change => change.delta), [1, 2, 1, 4]);
  assert.deepEqual(work.changes.map(change => change.analysisDelta), [2, 3, -2, 7]);
});

test("work-basis report loads work quantity baselines and snapshots", async () => {
  const queries = [];
  const query = async (sql) => {
    queries.push(sql);
    if (sql.startsWith("SELECT product_id AS id")) return [{ ...product, id: 1 }];
    if (sql.startsWith("SELECT h.product_id")) return [{ product_id: 1, quantity: 100, work_quantity: 40 }];
    if (sql.startsWith("SELECT history_id")) return [{ product_id: 1, quantity: 105, work_quantity: 47, changed_at: reportSqlTime(start + 60000) }];
    return [];
  };
  const report = await loadProductReport(query, { products: "1", start: "2026-10-12T09:00", end: "2026-10-12T12:00", include_minutely: "0", basis: "work" });
  assert.equal(report.basis, "work");
  assert.match(queries.find(sql => sql.startsWith("SELECT h.product_id")), /h\.quantity,h\.work_quantity/);
  assert.deepEqual([report.products[0].basis, report.products[0].initialQuantity, report.products[0].endQuantity, report.products[0].increaseQuantity], ["work", 40, 47, 7]);
});

test("minute work sums positive changes in each minute and excludes end-time events", () => {
  const result = buildProductReport(product, { quantity: 100 }, [event(0.1, 103), event(0.5, 107), event(0.8, 105), event(1, 107), event(2, 999)], start, start + 120000);
  assert.deepEqual(result.buckets.minutely.map(bucket => bucket.quantity), [7, 2]);
  assert.equal(result.increaseQuantity, 7);
  assert.equal(result.workQuantity, 9);
  const partial = buildProductReport(product, { quantity: 100 }, [event(1, 102)], start + 30000, start + 90000);
  assert.deepEqual(partial.buckets.minutely.map(bucket => [bucket.start, bucket.end, bucket.quantity]), [[start + 30000, start + 60000, 0], [start + 60000, start + 90000, 2]]);
});

test("excessive minute buckets are rejected but long reports work with minute analysis disabled", async context => {
  const longEnd = reportTime("2026-04-01 00:00:00");
  context.mock.method(Date, "now", () => longEnd);
  const options = { products: "1", start: "2026-01-01T00:00", end: "2026-04-01T00:00" };
  let calls = 0;
  const query = async sql => {
    calls += 1;
    if (sql.startsWith("SELECT product_id")) return [product];
    if (sql.startsWith("SELECT h.product_id")) return [{ product_id: 1, quantity: 100 }];
    return [];
  };
  await assert.rejects(loadProductReport(query, options), /분별 구간이 100,000개/);
  assert.equal(calls, 0);
  const report = await loadProductReport(query, { ...options, include_minutely: "0" });
  assert.equal(report.products[0].buckets.minutely, undefined);
  assert.equal(report.products[0].initialQuantity, 100);
  assert.ok(report.products[0].buckets.hourly.length > 0);
});

test("missing starting history uses the first recorded quantity for cumulative and net totals", () => {
  const result = buildProductReport(product, null, [event(60, 50), event(120, 55)], start, end);
  assert.equal(result.initialQuantity, 50);
  assert.equal(result.endQuantity, 55);
  assert.equal(result.increaseQuantity, 5);
  assert.equal(result.initialQuantityAssumed, true);
  assert.equal(result.complete, false);
  assert.equal(result.workQuantity, 5);
  assert.deepEqual(result.buckets.hourly.map(bucket => bucket.quantity), [null, 0, 5]);
  assert.equal(result.buckets.daily[0].quantity, 5);
  assert.equal(result.buckets.daily[0].complete, false);
  assert.deepEqual(result.points.map(point => point.value), [0, 0, 5, 5]);
  assert.deepEqual(result.points[0], { at: start, quantity: 50, value: 0 });
  const atStart = buildProductReport(product, null, [event(0, 50)], start, end);
  assert.equal(atStart.initialQuantity, 50);
  assert.equal(atStart.initialQuantityAssumed, false);
  assert.equal(atStart.workQuantity, 0);
  const noHistory = buildProductReport(product, null, [], start, end);
  assert.equal(noHistory.initialQuantity, null);
  assert.equal(noHistory.increaseQuantity, null);
  assert.ok(noHistory.points.every(point => point.value === null));
  const zeroFirst = buildProductReport(product, null, [event(30, 0), event(60, 7)], start, end);
  assert.equal(zeroFirst.initialQuantity, 0);
  assert.equal(zeroFirst.increaseQuantity, 7);
  const changedFirst = buildProductReport(product, null, [event(30, 50), event(60, 55)], start, end);
  assert.equal(changedFirst.initialQuantity, 50);
  assert.equal(changedFirst.increaseQuantity, 5);
  assert.equal(changedFirst.workQuantity, 5);
});

test("report calculates changes from consecutive quantity snapshots without previous-value columns", () => {
  const events = [
    { changed_at: reportSqlTime(start + 1000), quantity: 105, work_quantity: 5, target_quantity: 200 },
    { changed_at: reportSqlTime(start + 2000), quantity: 105, work_quantity: 0, target_quantity: 200 },
    { changed_at: reportSqlTime(start + 3000), quantity: 102, work_quantity: 0, target_quantity: 200 },
    { changed_at: reportSqlTime(start + 4000), quantity: 110, work_quantity: 8, target_quantity: 300 }
  ];
  const result = buildProductReport(product, { quantity: 100 }, events, start, end);
  assert.equal(result.initialQuantity, 100);
  assert.equal(result.endQuantity, 110);
  assert.equal(result.increaseQuantity, 10);
  assert.equal(result.workQuantity, 13);
  assert.deepEqual(result.changes.map(change => change.delta), [5, 0, -3, 8]);
  assert.equal(result.buckets.hourly[0].quantity, 13);
  const assumed = buildProductReport(product, null, events, start, end);
  assert.equal(assumed.initialQuantity, 105);
  assert.equal(assumed.increaseQuantity, 5);
  assert.equal(assumed.workQuantity, 8);
  assert.deepEqual(assumed.changes.map(change => change.delta), [0, 0, -3, 8]);
});

test("product buckets align to KST midnight and Monday weeks", () => {
  assert.equal(reportSqlTime(bucketStart(start + 59999, "minutely")), "2026-10-12 09:00:00.000");
  assert.equal(reportSqlTime(bucketStart(start, "hourly")), "2026-10-12 09:00:00.000");
  assert.equal(reportSqlTime(bucketStart(start, "daily")), "2026-10-12 00:00:00.000");
  assert.equal(reportSqlTime(bucketStart(reportTime("2026-10-18 23:59:00"), "weekly")), "2026-10-12 00:00:00.000");
  assert.equal(reportSqlTime(bucketStart(reportTime("2026-10-19 00:00:00"), "weekly")), "2026-10-19 00:00:00.000");
});

test("monthly work follows calendar months across leap February, partial months and year boundaries", () => {
  const periodStart = reportTime("2024-01-31 12:00:00");
  const periodEnd = reportTime("2024-04-01 00:00:00");
  const events = [
    ["2024-01-31 23:59:59.999", 102],
    ["2024-02-01 00:00:00", 105],
    ["2024-02-29 23:59:59.999", 109],
    ["2024-03-01 00:00:00", 107],
    ["2024-03-15 10:00:00", 112],
    ["2024-04-01 00:00:00", 999]
  ].map(([changed_at, quantity]) => ({ changed_at, quantity }));
  const result = buildProductReport(product, { quantity: 100 }, events, periodStart, periodEnd, false);
  assert.deepEqual(result.buckets.monthly.map(bucket => bucket.quantity), [2, 7, 5]);
  assert.equal(result.buckets.monthly[0].start, periodStart);
  assert.equal(result.buckets.monthly[1].end - result.buckets.monthly[1].start, 29 * 86400000);
  assert.equal(result.buckets.monthly.at(-1).end, periodEnd);
  assert.equal(result.endQuantity, 112);
  assert.equal(result.workQuantity, 14);
  assert.equal(reportSqlTime(bucketStart(Date.parse("2024-01-31T15:00:00Z"), "monthly")), "2024-02-01 00:00:00.000");
  const regularFebruary = buildProductReport(product, { quantity: 100 }, [], reportTime("2025-02-01 00:00:00"), reportTime("2025-03-01 00:00:00"), false);
  assert.equal(regularFebruary.buckets.monthly[0].end - regularFebruary.buckets.monthly[0].start, 28 * 86400000);
  const yearEnd = buildProductReport(product, { quantity: 100 }, [{ changed_at: "2026-01-01 00:00:00", quantity: 103 }], reportTime("2025-12-31 12:00:00"), reportTime("2026-01-02 12:00:00"), false);
  assert.deepEqual(yearEnd.buckets.monthly.map(bucket => bucket.quantity), [0, 3]);
  assert.equal(reportSqlTime(yearEnd.buckets.monthly[1].at), "2026-01-01 00:00:00.000");
  assert.equal(reportSqlTime(yearEnd.buckets.monthly[1].end), "2026-01-02 12:00:00.000");
});

test("yearly work uses KST calendar years, leap years and only the selected portion of each year", () => {
  const periodStart = reportTime("2024-12-31 12:00:00");
  const periodEnd = reportTime("2025-01-03 12:00:00");
  const events = [
    ["2024-12-31 23:59:59.999", 102],
    ["2025-01-01 00:00:00", 107],
    ["2025-01-02 09:00:00", 104],
    ["2025-01-03 12:00:00", 999]
  ].map(([changed_at, quantity]) => ({ changed_at, quantity }));
  const result = buildProductReport(product, { quantity: 100 }, events, periodStart, periodEnd, false);
  assert.deepEqual(result.buckets.yearly.map(bucket => bucket.quantity), [2, 5]);
  assert.equal(result.buckets.yearly[0].start, periodStart);
  assert.equal(reportSqlTime(result.buckets.yearly[0].end), "2025-01-01 00:00:00.000");
  assert.equal(result.buckets.yearly[1].end, periodEnd);
  assert.equal(result.endQuantity, 104);
  assert.equal(result.workQuantity, 7);
  assert.equal(reportSqlTime(bucketStart(Date.parse("2024-12-31T15:00:00Z"), "yearly")), "2025-01-01 00:00:00.000");
  for (const [year, days] of [[2024, 366], [2025, 365]]) {
    const from = reportTime(`${year}-01-01 00:00:00`);
    const until = reportTime(`${year + 1}-01-01 00:00:00`);
    const fullYear = buildProductReport(product, { quantity: 100 }, [], from, until, false);
    assert.equal(fullYear.buckets.yearly.length, 1);
    assert.equal(fullYear.buckets.yearly[0].end - fullYear.buckets.yearly[0].start, days * 86400000);
    assert.equal(fullYear.buckets.yearly[0].quantity, 0);
  }
});

test("product report queries selected products and excludes the period end", async context => {
  context.mock.method(Date, "now", () => end);
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT product_id")) return [product];
    if (sql.startsWith("SELECT h.product_id")) return [{ product_id: 1, quantity: 100 }];
    return [event(10, 105)];
  };
  const report = await loadProductReport(query, { products: "1", start: "2026-10-12T09:00", end: "2026-10-12T12:00" });
  assert.equal(report.products[0].increaseQuantity, 5);
  assert.match(calls[2].sql, /changed_at>=\? AND changed_at<\?/);
  assert.match(calls[2].sql, /previous_product_status,product_status/);
  await assert.rejects(loadProductReport(query, { products: "1 OR 1=1", start: "2026-10-12T09:00", end: "2026-10-12T12:00" }), /제품/);
});

test("history setup installs insert and quantity-change triggers and seeds only missing baselines", async () => {
  const calls = [];
  await ensureProductHistory(async sql => { calls.push(sql); return []; });
  assert.ok(calls.some(sql => /previous_product_status VARCHAR\(20\) NULL/.test(sql)));
  assert.ok(calls.some(sql => /product_status VARCHAR\(20\) NULL/.test(sql)));
  assert.ok(calls.some(sql => /AFTER INSERT ON product/.test(sql)));
  assert.ok(calls.some(sql => /AFTER UPDATE ON product/.test(sql) && /NOT \(NEW.quantity <=> OLD.quantity\)/.test(sql)));
  assert.ok(calls.some(sql => /AFTER UPDATE ON product/.test(sql) && /NEW.work_quantity <=> OLD.work_quantity/.test(sql) && /NEW.target_quantity <=> OLD.target_quantity/.test(sql) && /NEW.product_status <=> OLD.product_status/.test(sql)));
  assert.ok(calls.filter(sql => sql.startsWith("CREATE TRIGGER")).every(sql => /previous_product_status,product_status/.test(sql)));
  assert.ok(calls.some(sql => /changed_by_user_id,changed_by_username,change_type,changed_at/.test(sql)));
  assert.ok(calls.filter(sql => sql.startsWith("CREATE TRIGGER")).every(sql => /CASE WHEN NEW.quantity_change_type='DEVICE' THEN '' ELSE COALESCE/.test(sql)));
  assert.ok(calls.filter(sql => sql.startsWith("CREATE TRIGGER")).every(sql => /LEFT\(NEW\.quantity_actor,7\)='DEVICE:' THEN SUBSTRING\(NEW\.quantity_actor,8\)/.test(sql)));
  assert.ok(calls.some(sql => /UPDATE product SET work_quantity=quantity,updated_at=updated_at/.test(sql)));
  assert.ok(calls.some(sql => /NULL,p\.product_status,'BASELINE'/.test(sql)));
  assert.match(calls.at(-1), /WHERE NOT EXISTS/);
  assert.ok(calls.every(sql => !/^\s*(?:DELETE|TRUNCATE|DROP)\b/.test(sql)));
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  assert.match(schema, /previous_product_status,product_status/);
  assert.match(schema, /NOT \(NEW\.product_status <=> OLD\.product_status\)/);
});

test("obsolete previous-value columns are dropped after trigger replacement and migration is idempotent", async () => {
  const calls = [];
  const legacyColumns = new Set(["previous_quantity", "previous_work_quantity", "previous_target_quantity"]);
  const definitions = new Map(["product_quantity_insert", "product_quantity_update"].map(name => [name, "previous_quantity previous_work_quantity previous_target_quantity changed_by_username NEW.quantity_change_type"]));
  const query = async sql => {
    calls.push(sql);
    if (sql === "SHOW COLUMNS FROM product") return ["work_quantity", "quantity_reason", "quantity_actor", "quantity_change_type"].map(Field => ({ Field }));
    if (sql === "SHOW COLUMNS FROM product_quantity_history") return ["work_quantity", "target_quantity", "previous_product_status", "product_status", "change_reason", "changed_by_user_id", "changed_by_username", "change_type", ...legacyColumns].map(Field => ({ Field }));
    if (sql.includes("information_schema.TRIGGERS")) return [...definitions].map(([name, definition]) => ({ name, definition }));
    if (sql.startsWith("DROP TRIGGER ")) definitions.delete(sql.slice("DROP TRIGGER ".length));
    if (sql.startsWith("CREATE TRIGGER ")) definitions.set(/CREATE TRIGGER (\w+)/.exec(sql)[1], sql);
    const removed = /^ALTER TABLE product_quantity_history DROP COLUMN (\w+)$/.exec(sql);
    if (removed) {
      assert.equal(definitions.size, 2);
      assert.ok([...definitions.values()].every(definition => !/\bprevious_(?:quantity|work_quantity|target_quantity)\b/.test(definition)));
      assert.ok(legacyColumns.delete(removed[1]));
    }
    return [];
  };
  await ensureProductHistory(query);
  assert.equal(legacyColumns.size, 0);
  for (const column of ["previous_quantity", "previous_work_quantity", "previous_target_quantity"]) {
    const deletion = calls.findIndex(sql => sql.endsWith(`DROP COLUMN ${column}`));
    assert.ok(deletion > calls.findIndex(sql => sql.startsWith("CREATE TRIGGER product_quantity_insert")));
    assert.ok(deletion > calls.findIndex(sql => sql.startsWith("CREATE TRIGGER product_quantity_update")));
  }
  assert.equal(calls.filter(sql => /DROP COLUMN/.test(sql)).length, 3);
  assert.ok(calls.every(sql => !/^\s*(?:DELETE|TRUNCATE|DROP TABLE)\b/.test(sql)));
  assert.match(definitions.get("product_quantity_update"), /NEW.target_quantity <=> OLD.target_quantity/);
  calls.length = 0;
  await ensureProductHistory(query);
  assert.ok(calls.every(sql => !/^\s*(?:ALTER|DROP|CREATE TRIGGER|UPDATE product SET)\b/.test(sql)));
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  assert.doesNotMatch(schema, /\bprevious_(?:quantity|work_quantity|target_quantity)\b/);
});

test("existing snapshot triggers are upgraded to leave DEVICE reasons blank without editing past history", async () => {
  const calls = [];
  const definitions = new Map(["product_quantity_insert", "product_quantity_update"].map(name => [name, "NEW.work_quantity NEW.target_quantity changed_by_username NEW.quantity_change_type COALESCE(NEW.quantity_reason,'baseline')"]));
  const query = async sql => {
    calls.push(sql);
    if (sql === "SHOW COLUMNS FROM product") return ["work_quantity", "quantity_reason", "quantity_actor", "quantity_change_type"].map(Field => ({ Field }));
    if (sql === "SHOW COLUMNS FROM product_quantity_history") return ["work_quantity", "target_quantity", "previous_product_status", "product_status", "change_reason", "changed_by_user_id", "changed_by_username", "change_type"].map(Field => ({ Field }));
    if (sql.includes("information_schema.TRIGGERS")) return [...definitions].map(([name, definition]) => ({ name, definition }));
    if (sql.startsWith("DROP TRIGGER ")) definitions.delete(sql.slice("DROP TRIGGER ".length));
    if (sql.startsWith("CREATE TRIGGER ")) definitions.set(/CREATE TRIGGER (\w+)/.exec(sql)[1], sql);
    return [];
  };
  await ensureProductHistory(query);
  assert.equal(calls.filter(sql => sql.startsWith("CREATE TRIGGER")).length, 2);
  assert.ok([...definitions.values()].every(definition => /CASE WHEN NEW.quantity_change_type='DEVICE' THEN '' ELSE COALESCE/.test(definition)));
  assert.ok([...definitions.values()].every(definition => /LEFT\(NEW\.quantity_actor,7\)='DEVICE:' THEN SUBSTRING\(NEW\.quantity_actor,8\)/.test(definition)));
  assert.ok(calls.every(sql => !/^\s*(?:UPDATE product_quantity_history|DELETE|TRUNCATE|ALTER)\b/.test(sql)));
  calls.length = 0;
  await ensureProductHistory(query);
  assert.ok(calls.every(sql => !/^\s*(?:DROP|CREATE TRIGGER|ALTER)\b/.test(sql)));
});

test("product Excel exports real numeric totals and minute through monthly work data", async () => {
  const result = buildProductReport(product, { quantity: 100 }, [{ ...event(10, 105), previous_product_status: "대기", product_status: "생산중", change_reason: "생산 시작", changed_by_username: "operator", change_type: "STATUS" }], start, end);
  const buffer = await createProductWorkbook({ start, end, products: [result] });
  const workbook = new (require("exceljs").Workbook)();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 8);
  assert.equal(workbook.getWorksheet("연간별 작업 수량"), undefined);
  assert.equal(workbook.getWorksheet("월별 작업 수량").getCell("E2").value, 5);
  const statusHistory = workbook.getWorksheet("제품 상태 변경 이력");
  assert.equal(statusHistory.getCell("A2").value, "P-001");
  assert.equal(statusHistory.getCell("D2").value, "대기");
  assert.equal(statusHistory.getCell("E2").value, "생산중");
  assert.equal(statusHistory.getCell("F2").value, "STATUS");
  assert.equal(statusHistory.getCell("G2").value, "생산 시작");
  assert.equal(statusHistory.getCell("H2").value, "operator");
  assert.equal(workbook.worksheets[1].name, "분별 작업 수량");
  assert.equal(workbook.worksheets[1].getCell("E12").value, 5);
  assert.equal(workbook.worksheets[0].getCell("C4").value, 100);
  assert.equal(workbook.worksheets[0].getCell("D4").value, 105);
  assert.equal(workbook.worksheets[0].getCell("E4").value, 5);
  const assumed = buildProductReport(product, null, [event(60, 50), event(120, 55)], start, end);
  await workbook.xlsx.load(await createProductWorkbook({ start, end, products: [assumed] }));
  assert.equal(workbook.worksheets[0].getCell("C4").value, 50);
  assert.equal(workbook.worksheets[0].getCell("E4").value, 5);
  assert.equal(workbook.worksheets[0].getCell("G4").value, "첫 기록 수량 적용");
  const workReport = buildProductReport(product, { quantity: 100, work_quantity: 40 }, [{ ...event(60, 105), work_quantity: 45 }], start, end, true, "work");
  await workbook.xlsx.load(await createProductWorkbook({ start, end, basis: "work", products: [workReport] }));
  assert.equal(workbook.getWorksheet("제품 요약").getCell("C3").value, "초기 작업 수량");
  assert.equal(workbook.getWorksheet("제품 요약").getCell("C4").value, 40);
  assert.equal(workbook.getWorksheet("제품 요약").getCell("D4").value, 45);
  assert.equal(workbook.getWorksheet("제품 요약").getCell("E4").value, 5);
  assert.equal(workbook.getWorksheet("시간별 작업 수량").getCell("E3").value, 5);
  const workHistory = workbook.getWorksheet("수량 변경 이력");
  assert.equal(workHistory.getCell("C1").value, "작업 수량");
  assert.equal(workHistory.getCell("D1").value, "작업 변경량");
  assert.equal(workHistory.getCell("C2").value, 45);
  assert.equal(workHistory.getCell("D2").value, 5);
  assert.equal(workHistory.getCell("E2").value, 105);
});

test("product charts start cumulative quantity on the X axis and use each work grouping", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "product-report.js"), "utf8");
  const chartStart = source.indexOf("  function timeAxisSettings(");
  const chartEnd = source.indexOf("  function productSection(", chartStart);
  assert.ok(chartStart >= 0 && chartEnd > chartStart);
  const context = vm.createContext({
    Chart: class { constructor(canvas, config) { this.config = config; } },
    report: { start, end }, window: { innerWidth: 1000 },
    graphs: { cumulative: "누적 수량", minutely: "분별 작업 수량", hourly: "시간별 작업 수량", daily: "일별 작업 수량", weekly: "주간별 작업 수량", monthly: "월별 작업 수량", yearly: "연간별 작업 수량" },
    clock: { format: String }, dayLabel: { format: String }, monthLabel: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }), yearLabel: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric" }), formatDate: String
  });
  vm.runInContext(source.slice(chartStart, chartEnd), context);
  const result = buildProductReport(product, { quantity: 100 }, [event(10, 105), event(70, 110)], start, end);
  const cumulative = context.createChart({}, result, "cumulative").config;
  assert.equal(cumulative.type, "line");
  assert.equal(cumulative.data.datasets[0].data[0].y, 0);
  assert.equal(cumulative.data.datasets[0].stepped, "after");
  assert.equal(cumulative.options.scales.y.beginAtZero, true);
  const cumulativeAxis = cumulative.options.scales.x;
  const axes = [cumulativeAxis];
  for (const mode of ["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]) {
    const config = context.createChart({}, result, mode).config;
    assert.equal(config.type, "bar");
    assert.deepEqual(Array.from(config.data.datasets[0].data, point => point.y), result.buckets[mode].map(bucket => bucket.quantity));
    assert.ok(config.data.datasets[0].data.every((point, index) => point.x === (result.buckets[mode][index].start + result.buckets[mode][index].end) / 2));
    axes.push(config.options.scales.x);
  }
  const modes = ["cumulative", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"];
  const expectedIntervals = { cumulative: "30분", minutely: "30분", hourly: "1시간", daily: "1일", weekly: "1주 (월요일 시작)", monthly: "1개월", yearly: "1년" };
  for (const [index, axis] of axes.entries()) {
    const scale = { width: 1000, options: axis, chart: { width: 1000 } };
    axis.afterBuildTicks(scale);
    const mode = modes[index];
    assert.equal(axis.title.text, `기간 (KST · ${expectedIntervals[mode]} 간격)`);
    assert.equal(axis.ticks.autoSkip, false);
    const label = axis.ticks.callback(start);
    if (["minutely", "hourly"].includes(mode)) {
      assert.match(label[0], /10.*12/);
      assert.equal(label[1], "09:00");
    }
    if (mode === "cumulative") assert.equal(label[1], "09:00");
    if (mode === "daily") assert.match(label, /10.*12/);
    if (mode === "weekly") assert.match(label, /월/);
    if (mode === "monthly") assert.equal(label, "2026년 10월");
    if (mode === "yearly") assert.equal(label, "2026년");
    assert.ok(scale.ticks.length > 0);
  }
  const longMonthly = context.timeAxisSettings(start, start + 366 * 86400000, 1000, "monthly");
  assert.equal(longMonthly.interval, 30.436875 * 86400000);
  assert.equal(longMonthly.ticks.length, 13);
  assert.equal(longMonthly.formatLabel(longMonthly.ticks[0].value), "2026년 10월");
  const yearly = context.timeAxisSettings(start, start + 366 * 86400000, 1000, "yearly");
  assert.equal(yearly.interval, 365.2425 * 86400000);
  assert.equal(yearly.ticks.length, 2);
  assert.equal(yearly.formatLabel(yearly.ticks[0].value), "2026년");
});

test("product analysis selection filters screen and PDF while retaining product identity", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "product-report.js"), "utf8");
  const graphTitleStart = source.indexOf("  function graphTitle(");
  const graphTitleEnd = source.indexOf("  function createChart(", graphTitleStart);
  const sectionStart = source.indexOf("  function productSection(");
  const sectionEnd = source.indexOf("  async function downloadPdf(", sectionStart);
  const graphModes = [];
  const context = vm.createContext({
    report: { analysisItems: ["initialQuantity", "weekly"], generatedAt: end, basis: "cumulative" }, pdfBusy: false,
    graphs: { cumulative: "누적 수량", minutely: "분별 작업 수량", hourly: "시간별 작업 수량", daily: "일별 작업 수량", weekly: "주간별 작업 수량", monthly: "월별 작업 수량", yearly: "연간별 작업 수량" },
    periodText: () => "period", formatDate: String,
    createChart: (_canvas, _product, mode) => { graphModes.push(mode); return { destroy() {} }; },
    make: (tag, text) => ({ tag, text, dataset: {}, attributes: {}, children: [], append(...children) { this.children.push(...children); }, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; }, addEventListener() {}, toDataURL: () => "data:image/png;base64,test" })
  });
  vm.runInContext(`${source.slice(graphTitleStart, graphTitleEnd)}\n${source.slice(sectionStart, sectionEnd)}`, context);
  const result = buildProductReport(product, { quantity: 100 }, [], start, end);
  for (const printing of [false, true]) {
    const section = context.productSection(result, printing);
    assert.deepEqual(Array.from(section.children.find(node => node.tag === "dl").children, node => node.children[0].text), ["초기 누적 수량"]);
    assert.deepEqual(Array.from(section.children.filter(node => node.tag === "h4"), node => node.text), ["주간별 작업 수량"]);
  }
  assert.deepEqual(graphModes, ["weekly"]);
  context.report.analysisItems = ["cumulative", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"];
  const allGraphs = context.productSection(result, true);
  assert.equal(allGraphs.children.filter(node => node.tag === "img").length, 7);
  assert.deepEqual(graphModes.slice(-7), ["cumulative", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"]);
  assert.equal(allGraphs.children.some(node => node.tag === "dl"), false);
  context.report.analysisItems = ["monthly"];
  for (const printing of [false, true]) {
    const monthlyOnly = context.productSection(result, printing);
    assert.deepEqual(Array.from(monthlyOnly.children.filter(node => node.tag === "h4"), node => node.text), ["월별 작업 수량"]);
    assert.equal(monthlyOnly.children.some(node => node.tag === "dl"), false);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "product-report.html"), "utf8");
  assert.match(html, /product-report\.js\?v=9/);
  assert.match(html, /name="quantityBasis" value="cumulative" checked/);
  assert.match(html, /name="quantityBasis" value="work"/);
  assert.ok(html.includes('value="monthly" checked> 월별 작업 수량 그래프</label>'));
  assert.doesNotMatch(html, /value="yearly"/);
  context.report.analysisItems = ["yearly"];
  for (const printing of [false, true]) {
    const yearlyOnly = context.productSection(result, printing);
    assert.deepEqual(Array.from(yearlyOnly.children.filter(node => node.tag === "h4"), node => node.text), ["연간별 작업 수량"]);
    assert.equal(yearlyOnly.children.some(node => node.tag === "dl"), false);
  }
  context.report.analysisItems = ["initialQuantity", "increaseQuantity", "cumulative"];
  const assumed = buildProductReport(product, null, [event(60, 50), event(120, 55)], start, end);
  for (const printing of [false, true]) {
    const section = context.productSection(assumed, printing);
    const statistics = section.children.find(node => node.tag === "dl");
    assert.deepEqual(Array.from(statistics.children, node => node.children[1].text), ["50개", "5개"]);
    assert.ok(section.children.some(node => node.tag === "p" && node.text.includes("첫 기록 누적 수량을 초기 수량으로")));
  }
  context.report.basis = "work";
  context.report.analysisItems = ["initialQuantity", "endQuantity", "increaseQuantity", "cumulative"];
  const workResult = buildProductReport(product, { quantity: 100, work_quantity: 40 }, [{ ...event(60, 105), work_quantity: 45 }], start, end, true, "work");
  const workSection = context.productSection(workResult, true);
  assert.deepEqual(Array.from(workSection.children.find(node => node.tag === "dl").children, node => node.children[0].text), ["초기 작업 수량", "종료 작업 수량", "작업 증가 수량"]);
  assert.equal(workSection.children.find(node => node.tag === "h4").text, "작업 수량 추이");
  assert.ok(workSection.children.some(node => node.tag === "p" && node.text.includes("저장된 작업 수량 기준")));
});

test("product report keeps level-six access and follows the production edit link", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /app\.get\("\/product-report\.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel\(6\)/);
  assert.match(server, /app\.get\("\/api\/admin\/products\/report", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel\(6\)/);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "product-admin.html"), "utf8");
  assert.match(html, /href="\/product-control.html">생산 입력<\/a>\s*<a class="link" href="\/product-report.html">제품 리포트<\/a>/);
});

test("production editing page and both mutation APIs allow only level six and above", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const guardStart = source.indexOf("function requireAdminLevel(");
  const guardEnd = source.indexOf("function requireMaster(", guardStart);
  const quantityStart = source.indexOf('app.put("/api/products/:id/quantity",');
  const statusStart = source.indexOf('app.put("/api/products/:id/status",', quantityStart);
  const statusEnd = source.indexOf("function validateProduct(", statusStart);
  const pageRoute = source.split(/\r?\n/).find(line => line.startsWith('app.get("/product-control.html",'));
  const routes = [];
  const pass = (_request, _response, next) => next();
  const context = vm.createContext({
    getPermissionLevel: user => user.permissionLevel,
    requireLogin: pass, requireActiveAccount: pass, requireApproved: pass,
    app: { get: (route, ...handlers) => routes.push({ route, handlers }), put: (route, ...handlers) => routes.push({ route, handlers }) }
  });
  vm.runInContext(source.slice(guardStart, guardEnd) + pageRoute + source.slice(quantityStart, statusEnd), context);
  assert.equal(routes.length, 3);
  for (const { route, handlers } of routes) {
    for (let level = 1; level <= 10; level++) {
      let allowed = false;
      const response = { statusCode: null, status(code) { this.statusCode = code; return this; }, json() {}, redirect() { this.statusCode = 302; } };
      const request = { path: route, user: { permissionLevel: level } };
      const middleware = handlers.slice(0, -1);
      function next(index = 0) {
        if (index === middleware.length) { allowed = true; return; }
        middleware[index](request, response, () => next(index + 1));
      }
      next();
      assert.equal(allowed, level >= 6, `${route}: level ${level}`);
      if (level < 6) assert.equal(response.statusCode, route.startsWith("/api/") ? 403 : 302);
    }
  }
});

test("production edit title and every incoming page link use the new name", () => {
  const directory = path.join(__dirname, "..", "public");
  assert.ok(fs.readFileSync(path.join(directory, "product-control.html"), "utf8").includes("<h1>생산 입력</h1>"));
  for (const filename of ["index.html", "product-view.html", "product-admin.html", "product-report.html", "product-channel-link.html"]) {
    assert.match(fs.readFileSync(path.join(directory, filename), "utf8"), /href="\/product-control\.html"[^>]*>생산 입력<\/a>/, filename);
  }
});

test("product management requires level seven while production edit and reports retain level six", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = [...source.matchAll(/app\.(get|post|put|delete)\("([^"]+)",[^\n]*requireAdminLevel\((\d+)\)/g)];
  const management = routes.filter(route => route[2] === "/product-admin.html" || route[2].startsWith("/api/admin/products") && !route[2].startsWith("/api/admin/products/report"));
  assert.equal(management.length, 7);
  const reporting = routes.filter(route => ["/product-report.html", "/api/admin/products/report", "/api/admin/products/report/options"].includes(route[2]));
  assert.equal(reporting.length, 3);
  const guardStart = source.indexOf("function requireAdminLevel(");
  const guardEnd = source.indexOf("function requireMaster(", guardStart);
  const context = vm.createContext({ getPermissionLevel: user => user.permissionLevel });
  vm.runInContext(source.slice(guardStart, guardEnd), context);
  for (const [group, minimum] of [[management, 7], [reporting, 6]]) {
    for (const route of group) {
      assert.equal(Number(route[3]), minimum, route[2]);
      for (let level = 1; level <= 10; level++) {
        let allowed = false;
        const response = { statusCode: null, status(code) { this.statusCode = code; return this; }, json() {}, redirect() { this.statusCode = 302; } };
        context.requireAdminLevel(Number(route[3]))({ path: route[2], user: { permissionLevel: level } }, response, () => { allowed = true; });
        assert.equal(allowed, level >= minimum, `${route[2]} level ${level}`);
        if (level < minimum) assert.equal(response.statusCode, route[2].startsWith("/api/") ? 403 : 302);
      }
    }
  }
});

test("report product options use the level-six read endpoint without depending on admin listing", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.get("/api/admin/products/report/options",');
  const routeEnd = source.indexOf('app.get("/api/admin/products",', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  let handler;
  const items = [{ id: 1, product_code: "P-001", product_name: "제품", is_enabled: 0 }];
  const context = vm.createContext({
    console, requireLogin() {}, requireActiveAccount() {}, requireApproved() {},
    requireAdminLevel: minimum => { assert.equal(minimum, 6); return () => {}; },
    app: { get: (_route, ...handlers) => { handler = handlers.at(-1); } },
    query: async sql => { assert.doesNotMatch(sql, /WHERE.*is_enabled\s*=\s*1/); return items; }
  });
  vm.runInContext(source.slice(routeStart, routeEnd), context);
  let payload;
  await handler({}, { setHeader() {}, json(data) { payload = data; } });
  assert.equal(payload, items);
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "product-report.js"), "utf8");
  assert.ok(script.includes('fetch("/api/admin/products/report/options",'));
  assert.equal(script.includes('fetch("/api/admin/products",'), false);
  for (const filename of ["product-view.html", "product-control.html"]) {
    assert.ok(fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8").includes('href="/product-report.html"'));
  }
});

test("product enabled API updates the is_enabled column using isEnabled payloads", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.put("/api/admin/products/:id/active",');
  const routeEnd = source.indexOf('app.put("/api/admin/products/:id",', routeStart);
  let handler;
  const calls = [];
  const context = vm.createContext({
    console,
    app: { put: (_route, ...handlers) => { handler = handlers.at(-1); } },
    requireLogin() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {},
    PRODUCT_FIELDS: "fields", PRODUCT_JOIN: "FROM product", broadcast() {},
    query: async (sql, params) => { calls.push({ sql, params }); return sql.startsWith("UPDATE") ? { affectedRows: 1 } : []; }
  });
  vm.runInContext(source.slice(routeStart, routeEnd), context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; } };
  await handler({ params: { id: "4" }, body: { isEnabled: false }, user: { id: 12 } }, response);
  assert.match(calls[0].sql, /UPDATE product SET is_enabled=/);
  assert.deepEqual(Array.from(calls[0].params), [0, 12, 4]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), { ok: true, isEnabled: false });
  const adminHtml = fs.readFileSync(path.join(__dirname, "..", "public", "product-admin.html"), "utf8");
  assert.match(adminHtml, /product\.is_enabled/);
  assert.match(adminHtml, /JSON\.stringify\(\{ isEnabled \}\)/);
  assert.doesNotMatch(adminHtml, /product\.is_active|JSON\.stringify\(\{ isActive \}\)/);
  const mappingScript = fs.readFileSync(path.join(__dirname, "..", "public", "product-channel-link.js"), "utf8");
  assert.match(mappingScript, /product\.is_enabled/);
});