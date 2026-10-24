const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const policy = require("../level-permissions");

test("20-level defaults preserve the old work boundaries and all page links share the same policy", () => {
  const levels = policy.defaultPermissionPolicy();
  assert.equal(levels.device_control, 8);
  assert.equal(levels.production_input, 12);
  assert.equal(levels.product_admin, 14);
  assert.equal(levels.user_admin, 16);
  for (let level = 1; level <= 20; level++) {
    const user = { status: "APPROVED", permissionLevel: level };
    const snapshot = policy.userPermissionSnapshot(user, levels);
    for (const feature of policy.FEATURES) {
      assert.equal(snapshot.permissions[feature.key], level >= feature.level);
      for (const pathname of feature.paths) assert.equal(snapshot.access[pathname], snapshot.permissions[feature.key]);
    }
  }
  for (let old = 1; old <= 10; old++) {
    const converted = policy.legacyPermissionLevel(old);
    assert.equal(converted >= levels.device_control, old >= 4);
    assert.equal(converted >= levels.production_input, old >= 6);
    assert.equal(converted >= levels.product_admin, old >= 7);
    assert.equal(converted >= levels.user_admin, old >= 8);
  }
});

test("programmer levels 21 through 25 bypass per-site thresholds while policy settings remain capped at 20", () => {
  const levels = policy.defaultPermissionPolicy();
  assert.equal(policy.MAX_PERMISSION_LEVEL, 25);
  assert.equal(policy.MAX_SITE_PERMISSION_LEVEL, 20);
  assert.equal(policy.permissionLevel({ role: "MASTER" }), 25);
  assert.equal(policy.userManagementLevel({ role: "MASTER", permission_level: 20 }), 26);
  for (let level = 21; level <= 25; level++) {
    const user = { status: "APPROVED", permissionLevel: level };
    const snapshot = policy.userPermissionSnapshot(user, levels);
    assert.equal(snapshot.maxPermissionLevel, 25);
    for (const feature of policy.FEATURES) {
      assert.equal(snapshot.permissions[feature.key], true);
      for (const pathname of feature.paths) assert.equal(snapshot.access[pathname], true);
    }
  }
  assert.equal(policy.canUseFeature({ status: "APPROVED", permissionLevel: 26 }, "production_view", levels), false);
  assert.equal(policy.canUseFeature({ status: "SUSPENDED", permissionLevel: 25 }, "production_view", levels), false);
  assert.equal(policy.canUseFeature({ status: "PENDING", permissionLevel: 21 }, "device_admin", levels), true);
  assert.ok(policy.validatePermissionPolicy({ ...levels, device_control: 21 }).error);
});

test("custom minimum levels affect server operations and links without bypassing approval or suspension", () => {
  const levels = { ...policy.defaultPermissionPolicy(), production_input: 5, device_control: 18 };
  const user = { status: "APPROVED", permissionLevel: 5 };
  assert.equal(policy.canUseFeature(user, "production_input", levels), true);
  assert.equal(policy.canUseFeature(user, "device_control", levels), false);
  assert.equal(policy.userPermissionSnapshot(user, levels).access["/product-control.html"], true);
  assert.equal(policy.canUseFeature({ ...user, status: "PENDING" }, "production_input", levels), false);
  assert.equal(policy.canUseFeature({ permissionLevel: 20, status: "SUSPENDED" }, "level_permissions", levels), false);
  assert.equal(policy.canUseFeature({ permissionLevel: 20, status: "SUSPENDED" }, "user_profile", levels), true);
  for (const value of [0, 21, 1.5, "8"]) assert.ok(policy.validatePermissionPolicy({ ...levels, device_control: value }).error);
  assert.equal(policy.validatePermissionPolicy({ ...levels, level_permissions: 1 }).levels.level_permissions, 1);
  assert.ok(policy.validatePermissionPolicy({ ...levels, user_profile: 20 }).error);
  assert.ok(policy.validatePermissionPolicy({ ...levels, unknown: 1 }).error);
  assert.ok(policy.validatePermissionPolicy(levels).levels);
});

test("every business API resolves to its page permission and previews cannot bypass full schedule permissions", () => {
  for (const [method, pathname, expected] of [
    ["PUT", "/api/products/1/quantity", "production_input"],
    ["GET", "/api/admin/products/report/options", "production_report"],
    ["DELETE", "/api/admin/products/1", "product_admin"],
    ["GET", "/api/admin/product-channel-mappings/meta", "product_channel_link"],
    ["GET", "/api/admin/device/devices/DEVICE-1/token", "device_admin"],
    ["PUT", "/api/me/User_customization", "User_customization"],
    ["PUT", "/api/me/simple-channels", "User_customization"],
    ["PUT", "/api/admin/level-permissions", "level_permissions"],
    ["GET", "/api/admin/users", "user_admin"]
  ]) assert.equal(policy.requestPermission(method, pathname), expected);
  assert.equal(policy.requestPermission("GET", "/api/device/schedules", { next_only: "1" }), "device_schedule");
  assert.ok(Array.isArray(policy.requestPermission("GET", "/api/device/schedules", { next_only: "1", device_id: "DEVICE-1", output_signal: "OS1", is_enabled: "1", limit: "1" })));
});

test("User_customization retains legacy policy levels without changing page authorization", () => {
  const levels = { ...policy.defaultPermissionPolicy(), User_customization: 13 };
  const { User_customization, ...remaining } = levels;
  const legacy = { ...remaining, device_simple: User_customization };
  assert.deepEqual(policy.validatePermissionPolicy(legacy).levels, levels);
  assert.equal(policy.requestPermission("GET", "/user_customization.html"), "User_customization");
  assert.equal(policy.FEATURES.find(feature => feature.key === "User_customization").label, "사용자 디자인");
  const rows = policy.permissionPolicySites(levels);
  assert.deepEqual(policy.policyFromSiteRows(rows).levels, levels);
  for (const pathname of ["/user_customization.html", "/device-simple.html", "/api/me/User_customization", "/api/me/simple-channels"]) {
    const feature = policy.requestPermission("GET", pathname);
    assert.equal(policy.canUseFeature({ status: "APPROVED", permissionLevel: 12 }, feature, levels), false);
    assert.equal(policy.canUseFeature({ status: "APPROVED", permissionLevel: 13 }, feature, levels), true);
  }
});

test("site policy rows use the requested columns and reject duplicates or invalid levels", () => {
  const rows = policy.permissionPolicySites();
  assert.deepEqual(Object.keys(rows[0]), ["poicy_id", "site_name", "default_leble", "permisson_lebel", "updated_by", "updated_at"]);
  assert.equal(rows[0].site_name, "/product-view.html");
  assert.deepEqual(policy.policyFromSiteRows(rows).levels, policy.defaultPermissionPolicy());
  assert.ok(policy.policyFromSiteRows([...rows.slice(1), rows[1]]).error);
  assert.ok(policy.policyFromSiteRows(rows.map(row => row.site_name === "/device-control.html" ? { ...row, permisson_lebel: 21 } : row)).error);
  assert.equal(policy.policyFromSiteRows(rows.map(row => row.site_name === "/user-level.html" ? { ...row, permisson_lebel: 1 } : row)).levels.level_permissions, 1);
  assert.equal(policy.sitePolicyRevision(rows), policy.sitePolicyRevision([...rows].reverse()));
  const current = policy.permissionPolicySites({ ...policy.defaultPermissionPolicy(), device_control: 6 });
  assert.equal(current[6].default_leble, 8);
  assert.equal(current[6].permisson_lebel, 6);
  const changedDefault = current.map(row => ({ ...row, default_leble: row.poicy_id === 7 ? 11 : row.default_leble }));
  assert.notEqual(policy.sitePolicyRevision(current), policy.sitePolicyRevision(changedDefault));
  assert.ok(policy.policyFromSiteRows(current.map(row => ({ ...row, default_leble: 21 }))).error);
});

function createPolicyStorageHarness(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensurePermissionPolicy()");
  const end = source.indexOf("async function ensureSchema()", start);
  let state = {
    legacy: Boolean(options.legacy),
    legacyRow: { scheme_version: options.scheme || 20, levels_json: JSON.stringify(options.levels || policy.defaultPermissionPolicy()), updated_by: 7, updated_at: "2026-10-17 12:34:56.123456" },
    sites: options.sites || policy.permissionPolicySites(), next: [], backup: null, users: options.users || [1, 8, 20], conversions: 0, renames: 0,
    updates: [], failInsert: Boolean(options.failInsert), defaultColumn: !options.missingDefaults,
    defaultNullable: Boolean(options.nullableDefaults), defaultsAdded: 0, defaultsFinalized: 0
  };
  if (options.missingDefaults) state.sites = state.sites.map(({ default_leble, ...row }) => row);
  let snapshot;
  const clone = value => JSON.parse(JSON.stringify(value));
  const connection = {
    beginTransaction: async () => { snapshot = clone(state); },
    commit: async () => { snapshot = null; },
    rollback: async () => { if (snapshot) state = snapshot; snapshot = null; }, release() {}
  };
  const run = async (sql, params = []) => {
    if (sql.startsWith("CREATE TABLE")) return [];
    if (sql === "SHOW COLUMNS FROM site_permission_policy") return (state.legacy ? ["policy_id", "scheme_version", "levels_json", "revision", "updated_by", "updated_at"] : ["poicy_id", "site_name", ...(state.defaultColumn ? ["default_leble"] : []), "permisson_lebel", "updated_by", "updated_at"]).map(Field => ({ Field, Null: Field === "default_leble" && state.defaultNullable ? "YES" : "NO" }));
    if (sql.startsWith("ALTER TABLE site_permission_policy ADD COLUMN default_leble")) {
      assert.match(sql, /NULL AFTER site_name$/);
      state.defaultColumn = true; state.defaultNullable = true; state.defaultsAdded++;
      state.sites = state.sites.map(site => ({ ...site, default_leble: null }));
      return [];
    }
    if (sql.startsWith("ALTER TABLE site_permission_policy MODIFY COLUMN default_leble")) {
      assert.ok(state.sites.every(site => Number.isInteger(site.default_leble)));
      assert.match(sql, /NOT NULL DEFAULT 1 AFTER site_name$/);
      state.defaultNullable = false; state.defaultsFinalized++;
      return [];
    }
    if (sql.startsWith("SHOW TABLES")) return state.backup ? [{ table_name: "site_permission_policy_legacy" }] : [];
    if (sql.startsWith("SELECT scheme_version")) return [clone(state.legacyRow)];
    if (sql.startsWith("SELECT poicy_id")) return clone(sql.includes("site_permission_policy_next") ? state.next : state.sites);
    if (sql.startsWith("INSERT INTO site_permission_policy_next")) {
      if (state.failInsert && params[0] === 3) throw new Error("synthetic insert failure");
      const row = { poicy_id: params[0], site_name: params[1], default_leble: params[2], permisson_lebel: params[3], updated_by: params[4], updated_at: params[5] };
      state.next = [...state.next.filter(item => item.poicy_id !== row.poicy_id), row];
      return { affectedRows: 1 };
    }
    if (sql.startsWith("INSERT INTO site_permission_policy")) {
      if (sql.includes("(site_name,default_leble,permisson_lebel) VALUES (?,16,16)")) {
        state.sites.push({ poicy_id: Math.max(...state.sites.map(site => site.poicy_id), 0) + 1, site_name: params[0], default_leble: 16, permisson_lebel: 16, updated_by: null, updated_at: "2026-10-18 00:00:00.000000" });
        return { affectedRows: 1 };
      }
      state.sites.push({ poicy_id: params[0], site_name: params[1], default_leble: params[2], permisson_lebel: params[3], updated_by: null, updated_at: "2026-10-18 00:00:00.000000" });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE user_profile")) { state.users = state.users.map(policy.legacyPermissionLevel); state.conversions++; return { affectedRows: state.users.length }; }
    if (sql.startsWith("UPDATE site_permission_policy SET scheme_version")) { state.legacyRow.scheme_version = 20; return { affectedRows: 1 }; }
    if (sql === "UPDATE site_permission_policy SET site_name=?,updated_at=updated_at WHERE site_name=?") {
      const row = state.sites.find(site => site.site_name === params[1]);
      if (row) {
        assert.ok(!state.sites.some(site => site.site_name === params[0]));
        row.site_name = params[0];
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE site_permission_policy SET default_leble")) {
      assert.match(sql, /updated_at=updated_at.*default_leble IS NULL$/);
      const row = state.sites.find(site => site.site_name === params[1] && site.default_leble == null);
      if (row) row.default_leble = params[0];
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE site_permission_policy SET permisson_lebel")) {
      const row = state.sites.find(item => item.poicy_id === params[2] && item.site_name === params[3]);
      assert.ok(row);
      row.permisson_lebel = params[0]; row.updated_by = params[1]; row.updated_at = `2026-10-18 12:00:00.${String(state.updates.length + 1).padStart(6, "0")}`;
      state.updates.push(row.poicy_id);
      return { affectedRows: 1 };
    }
    if (sql.startsWith("RENAME TABLE")) {
      assert.equal(sql, "RENAME TABLE site_permission_policy TO site_permission_policy_legacy, site_permission_policy_next TO site_permission_policy");
      state.backup = clone(state.legacyRow); state.sites = clone(state.next); state.next = []; state.legacy = false; state.defaultColumn = true; state.defaultNullable = false; state.renames++;
      return [];
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  };
  const context = vm.createContext({
    ...policy,
    permissionPolicy: policy.defaultPermissionPolicy(), permissionPolicySitesCache: state.sites, permissionPolicyRevision: policy.sitePolicyRevision(state.sites),
    pool: { getConnection: async () => connection },
    query: run, connectionQuery: (_connection, sql, params) => run(sql, params), clients: new Set(), broadcast() {}
  });
  const applyStart = source.indexOf("function applyPermissionSiteRows(");
  const applyEnd = source.indexOf('app.get("/api/admin/level-permissions"', applyStart);
  vm.runInContext(source.slice(applyStart, applyEnd), context);
  vm.runInContext(source.slice(start, end), context);
  return { context, state: () => state, source };
}

test("User_customization page policy migration preserves levels, IDs and audit fields across restarts", async () => {
  const sites = policy.permissionPolicySites({ ...policy.defaultPermissionPolicy(), User_customization: 13 }, 7, "2026-10-21 06:00:00.000000");
  const row = sites.find(site => site.site_name === "/user_customization.html");
  row.site_name = "/device-simple.html";
  const expected = { ...row, site_name: "/user_customization.html" };
  const harness = createPolicyStorageHarness({ sites });
  await harness.context.ensurePermissionPolicy();
  assert.deepEqual(harness.state().sites.find(site => site.site_name === "/user_customization.html"), expected);
  assert.equal(harness.context.permissionPolicy.User_customization, 13);
  await harness.context.ensurePermissionPolicy();
  assert.deepEqual(harness.state().sites.find(site => site.site_name === "/user_customization.html"), expected);
  assert.equal(harness.state().sites.length, policy.FEATURES.length);
});

test("JSON policy migration preserves custom levels and audit fields without renumbering twenty-level users", async () => {
  const custom = { ...policy.defaultPermissionPolicy(), device_control: 6 };
  const harness = createPolicyStorageHarness({ legacy: true, levels: custom });
  await harness.context.ensurePermissionPolicy();
  assert.deepEqual(harness.state().users, [1, 8, 20]);
  assert.equal(harness.state().conversions, 0);
  assert.equal(harness.state().renames, 1);
  assert.equal(harness.context.permissionPolicy.device_control, 6);
  const control = harness.state().sites.find(site => site.site_name === "/device-control.html");
  assert.equal(control.updated_by, 7);
  assert.equal(control.default_leble, 8);
  assert.equal(control.updated_at, "2026-10-17 12:34:56.123456");
  assert.equal(harness.state().backup.levels_json, JSON.stringify(custom));
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().renames, 1);
  assert.equal(harness.state().conversions, 0);
});

test("legacy ten-level marker converts once and failed row migration rolls back without losing the original", async () => {
  const harness = createPolicyStorageHarness({ legacy: true, scheme: 10, users: [1, 4, 8, 10], failInsert: true });
  await assert.rejects(harness.context.ensurePermissionPolicy(), /synthetic insert failure/);
  assert.deepEqual(harness.state().users, [1, 4, 8, 10]);
  assert.equal(harness.state().legacyRow.scheme_version, 10);
  assert.equal(harness.state().legacy, true);
  assert.equal(harness.state().backup, null);
  harness.state().failInsert = false;
  await harness.context.ensurePermissionPolicy();
  assert.deepEqual(harness.state().users, [1, 8, 16, 20]);
  assert.equal(harness.state().conversions, 1);
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().conversions, 1);
});

test("empty normalized policy seeds one row per site and keeps current user levels", async () => {
  const harness = createPolicyStorageHarness({ sites: [] });
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().sites.length, policy.FEATURES.length);
  assert.deepEqual(harness.state().users, [1, 8, 20]);
  assert.equal(harness.state().renames, 0);
  assert.ok(harness.state().sites.every(site => site.default_leble === site.permisson_lebel));
});

test("default column is added third without changing current levels or audit fields and is preserved on restart", async () => {
  const sites = policy.permissionPolicySites({ ...policy.defaultPermissionPolicy(), device_control: 6 }, 9, "2026-10-17 11:22:33.000000");
  const harness = createPolicyStorageHarness({ sites, missingDefaults: true });
  await harness.context.ensurePermissionPolicy();
  const control = harness.state().sites.find(site => site.site_name === "/device-control.html");
  assert.equal(harness.state().defaultsAdded, 1);
  assert.equal(harness.state().defaultsFinalized, 1);
  assert.equal(control.default_leble, 8);
  assert.equal(control.permisson_lebel, 6);
  assert.equal(control.updated_by, 9);
  assert.equal(control.updated_at, "2026-10-17 11:22:33.000000");
  control.default_leble = 11;
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().sites.find(site => site.site_name === "/device-control.html").default_leble, 11);
  assert.equal(harness.state().defaultsAdded, 1);
  assert.equal(harness.state().defaultsFinalized, 1);
});

test("partially initialized default column fills only missing values and preserves stored defaults", async () => {
  const sites = policy.permissionPolicySites({ ...policy.defaultPermissionPolicy(), device_control: 6 }, 9, "2026-10-17 11:22:33.000000")
    .map(site => ({ ...site, default_leble: site.site_name === "/device-control.html" ? 11 : null }));
  const harness = createPolicyStorageHarness({ sites, nullableDefaults: true });
  await harness.context.ensurePermissionPolicy();
  const control = harness.state().sites.find(site => site.site_name === "/device-control.html");
  assert.equal(control.default_leble, 11);
  assert.equal(control.permisson_lebel, 6);
  assert.equal(control.updated_by, 9);
  assert.equal(control.updated_at, "2026-10-17 11:22:33.000000");
  assert.ok(harness.state().sites.every(site => Number.isInteger(site.default_leble)));
  assert.equal(harness.state().defaultsAdded, 0);
  assert.equal(harness.state().defaultsFinalized, 1);
});

test("fresh SQL seeds the initial permission in both default_leble and permisson_lebel", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const seed = /INSERT INTO site_permission_policy \(poicy_id,site_name,default_leble,permisson_lebel\) VALUES([\s\S]*?);/.exec(sql);
  assert.ok(seed);
  const rows = [...seed[1].matchAll(/\((\d+),'([^']+)',(\d+),(\d+)\)/g)];
  assert.equal(rows.length, policy.FEATURES.length);
  for (const row of rows) {
    const feature = policy.FEATURES.find(item => policy.permissionSiteName(item) === row[2]);
    assert.ok(feature);
    assert.equal(Number(row[3]), feature.level);
    assert.equal(Number(row[4]), feature.level);
  }
});

test("company page policy is appended without resetting existing site levels, defaults or audit data", async () => {
  const sites = policy.permissionPolicySites({ ...policy.defaultPermissionPolicy(), device_control: 6 }, 9, "2026-10-17 11:22:33.000000").filter(site => site.site_name !== "/user-company.html");
  const original = JSON.stringify(sites);
  const harness = createPolicyStorageHarness({ sites });
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().sites.length, 16);
  assert.equal(JSON.stringify(harness.state().sites.filter(site => site.site_name !== "/user-company.html")), original);
  const company = harness.state().sites.find(site => site.site_name === "/user-company.html");
  assert.equal(company.permisson_lebel, 16);
  assert.equal(company.default_leble, 16);
  await harness.context.ensurePermissionPolicy();
  assert.equal(harness.state().sites.length, 16);
});

test("defaults button reads database default_leble instead of feature constants and does not save automatically", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-level.js"), "utf8");
  const start = source.indexOf('levelElements.levelPolicyDefaults.addEventListener("click",');
  const end = source.indexOf("levelElements.levelPolicyReload.addEventListener", start);
  let click;
  let renders = 0;
  const context = vm.createContext({
    levelFeatures: [{ key: "device_control", site_name: "/device-control.html", level: 8 }],
    levelSites: [{ site_name: "/device-control.html", default_leble: 11, permisson_lebel: 6 }],
    levelSaved: { device_control: 6 }, levelDraft: { device_control: 6 },
    levelElements: { levelPolicyDefaults: { addEventListener: (_event, handler) => { click = handler; } } },
    levelRender: () => { renders++; }, fetch: () => assert.fail("Defaults must not save without confirmation")
  });
  vm.runInContext(source.slice(start, end), context);
  click();
  assert.equal(context.levelDraft.device_control, 11);
  assert.equal(context.levelSaved.device_control, 6);
  assert.equal(renders, 1);
});

function policyServerHarness() {
  const storage = createPolicyStorageHarness();
  const { source, context } = storage;
  const routes = new Map();
  let gate;
  const notifications = [];
  Object.assign(context, {
    clients: new Set(), broadcast: value => notifications.push(value), console,
    requireLogin: (req, res, next) => req.user ? next() : res.status(401).json({ error: "login" }),
    requireActiveAccount: (_req, _res, next) => next(),
    getPermissionLevel: policy.permissionLevel,
    app: {
      use: handler => { gate = handler; },
      get: (url, ...handlers) => routes.set(`GET ${url}`, handlers.at(-1)),
      put: (url, ...handlers) => routes.set(`PUT ${url}`, handlers.at(-1))
    }
  });
  const gateStart = source.indexOf('app.use((req, res, next) => {\n  const requirement = requestPermission(');
  const gateEnd = source.indexOf('app.get("/user-level.html"', gateStart);
  vm.runInContext(source.slice(gateStart, gateEnd), context);
  const guardStart = source.indexOf("function requireAdminLevel(");
  const guardEnd = source.indexOf("function requireMaster(", guardStart);
  vm.runInContext(source.slice(guardStart, guardEnd), context);
  const apiStart = source.indexOf('app.get("/api/admin/level-permissions"');
  const apiEnd = source.indexOf("// ---------------------------------------------------------", apiStart);
  vm.runInContext(source.slice(apiStart, apiEnd), context);
  const response = () => ({ statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, redirect(url) { this.statusCode = 302; this.redirectUrl = url; return this; } });
  return { context, routes, gate: (...args) => gate(...args), response, notifications, state: storage.state };
}

test("central page and API gates honor a changed minimum instead of the historical numeric guard", () => {
  const harness = policyServerHarness();
  harness.context.permissionPolicy.production_input = 3;
  for (const pathname of ["/product-control.html", "/api/products/1/quantity"]) {
    const request = { method: pathname.startsWith("/api/") ? "PUT" : "GET", path: pathname, query: {}, user: { status: "APPROVED", permissionLevel: 3 } };
    let allowed = false;
    harness.gate(request, harness.response(), () => harness.context.requireAdminLevel(6)(request, harness.response(), () => { allowed = true; }));
    assert.equal(allowed, true);
    request.user.permissionLevel = 2;
    const denied = harness.response();
    harness.gate(request, denied, () => assert.fail("Below-minimum request passed"));
    assert.equal(denied.statusCode, pathname.startsWith("/api/") ? 403 : 302);
  }
  const suspended = harness.response();
  harness.gate({ method: "GET", path: "/device-control.html", query: {}, user: { status: "SUSPENDED", permissionLevel: 20 } }, suspended, () => assert.fail("Suspended account passed"));
  assert.equal(suspended.statusCode, 302);
});

test("policy administration defaults to twenty and concurrent saves return conflict", async () => {
  const harness = policyServerHarness();
  const pathname = "/api/admin/level-permissions";
  for (let level = 1; level <= 20; level++) {
    let allowed = false;
    harness.gate({ method: "PUT", path: pathname, query: {}, user: { status: "APPROVED", permissionLevel: level } }, harness.response(), () => { allowed = true; });
    assert.equal(allowed, level === 20);
  }
  const sites = harness.state().sites.map(site => ({ ...site, permisson_lebel: site.site_name === "/device-control.html" ? 5 : site.permisson_lebel }));
  const previousRevision = policy.sitePolicyRevision(harness.state().sites);
  const request = { user: { id: 1, status: "APPROVED", permissionLevel: 20 }, body: { sites, revision: previousRevision } };
  const saved = harness.response();
  await harness.routes.get(`PUT ${pathname}`)(request, saved);
  assert.match(saved.body.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(saved.body.revision, previousRevision);
  assert.equal(harness.context.permissionPolicy.device_control, 5);
  assert.deepEqual(harness.state().updates, [7]);
  assert.equal(harness.state().sites[6].updated_by, 1);
  assert.equal(harness.notifications[0].type, "accessPolicyChanged");
  const stale = harness.response();
  await harness.routes.get(`PUT ${pathname}`)(request, stale);
  assert.equal(stale.statusCode, 409);
  const invalid = harness.response();
  await harness.routes.get(`PUT ${pathname}`)({ ...request, body: { sites: sites.map(site => site.site_name === "/user-level.html" ? { ...site, permisson_lebel: 21 } : site), revision: saved.body.revision } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(harness.context.permissionPolicy.level_permissions, 20);
  const forbidden = harness.response();
  await harness.routes.get(`PUT ${pathname}`)({ ...request, user: { id: 2, status: "APPROVED", permissionLevel: 19 } }, forbidden);
  assert.equal(forbidden.statusCode, 403);
  const fetched = harness.response();
  await harness.routes.get(`GET ${pathname}`)({ user: request.user }, fetched);
  assert.deepEqual(Object.keys(fetched.body.sites[0]), ["poicy_id", "site_name", "default_leble", "permisson_lebel", "updated_by", "updated_at"]);
  assert.equal(fetched.body.features[0].site_name, "/product-view.html");
  assert.equal(fetched.body.sites[6].default_leble, 8);
  assert.equal(fetched.body.features[6].level, 8);
  assert.equal(fetched.body.sites[6].permisson_lebel, 5);
  assert.equal(fetched.body.maxLevel, 20);
  const levelUi = fs.readFileSync(path.join(__dirname, "..", "public", "user-level.js"), "utf8");
  const levelHtml = fs.readFileSync(path.join(__dirname, "..", "public", "user-level.html"), "utf8");
  assert.match(levelUi, /input type="range" min="1" max="20"/);
  assert.match(levelUi, /input class="level-policy-number" type="number" min="1" max="20"/);
  assert.match(levelUi, /Array\.from\(\{ length: 20 \}/);
  assert.match(levelHtml, /레벨 1~20/);
});

test("an authorized visitor can change this page minimum and its links and APIs follow the saved level", async () => {
  const harness = policyServerHarness();
  const endpoint = "/api/admin/level-permissions";
  assert.notEqual(policy.FEATURES.find(feature => feature.key === "level_permissions").locked, true);
  const save = async (userLevel, minimum) => {
    const sites = harness.state().sites.map(site => site.site_name === "/user-level.html" ? { ...site, permisson_lebel: minimum } : { ...site });
    const response = harness.response();
    await harness.routes.get(`PUT ${endpoint}`)({ user: { id: userLevel, status: "APPROVED", permissionLevel: userLevel }, body: { sites, revision: policy.sitePolicyRevision(harness.state().sites) } }, response);
    return response;
  };
  assert.equal((await save(20, 8)).statusCode, 200);
  for (const [level, expected] of [[7, false], [8, true], [19, true], [20, true]]) {
    const user = { id: level, status: "APPROVED", permissionLevel: level };
    let pageAllowed = false;
    harness.gate({ method: "GET", path: "/user-level.html", query: {}, user }, harness.response(), () => { pageAllowed = true; });
    assert.equal(pageAllowed, expected);
    assert.equal(policy.userPermissionSnapshot(user, harness.context.permissionPolicy).access["/user-level.html"], expected);
    const fetched = harness.response();
    await harness.routes.get(`GET ${endpoint}`)({ user }, fetched);
    assert.equal(fetched.statusCode, expected ? 200 : 403);
  }
  assert.equal((await save(7, 1)).statusCode, 403);
  assert.equal((await save(8, 12)).statusCode, 200);
  assert.equal(harness.context.permissionPolicy.level_permissions, 12);
  assert.equal((await save(8, 1)).statusCode, 403);
  assert.equal((await save(12, 6)).statusCode, 200);
  assert.equal(harness.context.permissionPolicy.level_permissions, 6);
});

test("site permission save rolls back every row and keeps active permissions when any update fails", async () => {
  const harness = policyServerHarness();
  const original = JSON.parse(JSON.stringify(harness.state().sites));
  const sites = original.map(site => ({ ...site, permisson_lebel: ["/product-control.html", "/device-control.html"].includes(site.site_name) ? 5 : site.permisson_lebel }));
  const originalQuery = harness.context.connectionQuery;
  harness.context.connectionQuery = async (connection, sql, params) => {
    if (sql.startsWith("UPDATE site_permission_policy SET permisson_lebel") && params[2] === 7) throw new Error("synthetic update failure");
    return originalQuery(connection, sql, params);
  };
  harness.context.console = { error() {} };
  const result = harness.response();
  await harness.routes.get("PUT /api/admin/level-permissions")({ user: { id: 1, status: "APPROVED", permissionLevel: 20 }, body: { sites, revision: policy.sitePolicyRevision(original) } }, result);
  assert.equal(result.statusCode, 500);
  assert.deepEqual(harness.state().sites, original);
  assert.equal(harness.context.permissionPolicy.production_input, 12);
  assert.equal(harness.context.permissionPolicy.device_control, 8);
  assert.equal(harness.notifications.length, 0);
});