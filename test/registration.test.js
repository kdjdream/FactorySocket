const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const registration = require("../registration");
const policy = require("../level-permissions");

function createRegistrationHarness() {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = new Map();
  const organization = (id, codes, company) => ({ organization_id: id, ...codes, group_name: codes.group === "001" ? "Default" : "Group", company_name: company, site_name: "Factory", department_name: "Production", role_name: "Operator", is_active: 1 });
  const harnessErrors = [];
  const defaults = { group: "001", company: "001", site: "001", department: null, role: null };
  const known = { group: "GRP", company: "COM", site: "ST1", department: "D01", role: "R01" };
  let state = {
    organizations: [organization(1, defaults, "Default"), organization(2, known, "Verified company")],
    users: [{ id: 1, username: "admin", permission_level: 20, status: "APPROVED" }], comments: [], nextId: 100, failComment: false
  };
  let snapshot;
  const clone = value => JSON.parse(JSON.stringify(value));
  const connection = {
    beginTransaction: async () => { snapshot = clone(state); }, commit: async () => { snapshot = null; },
    rollback: async () => { if (snapshot) state = snapshot; snapshot = null; }, release() {}
  };
  const run = async (sql, params = []) => {
    if (sql.startsWith("SELECT user_id AS id FROM user_profile WHERE phone=?")) return state.users.filter(user => user.phone === params[0] && (params.length === 1 || user.id !== params[1])).map(user => ({ id: user.id }));
    if (sql.startsWith("SELECT user_id AS id FROM user_profile WHERE email = ? AND user_id <> ?")) return state.users.filter(user => user.email === params[0] && user.id !== params[1]).map(user => ({ id: user.id }));
    if (sql.startsWith("SELECT user_id AS id FROM user_profile WHERE email=? AND user_id<>?")) return state.users.filter(user => user.email === params[0] && user.id !== params[1]).map(user => ({ id: user.id }));
    if (sql.startsWith("SELECT login_id,role,permission_level,organization_id FROM user_profile WHERE user_id=?")) return state.users.filter(user => user.id === params[0]).map(user => ({ login_id: user.username, role: user.role, permission_level: user.permission_level, organization_id: user.organization_id }));
    if (sql.startsWith("UPDATE user_profile SET user_name=?,organization_id=?,phone=?,address=?,email=?,password_hash=?,permission_level=?,admin_memo=? WHERE user_id=?")) {
      assert.doesNotMatch(sql, /login_id\s*=/);
      const user = state.users.find(item => item.id === params[8]);
      Object.assign(user, { name: params[0], organization_id: params[1], phone: params[2], address: params[3], email: params[4], permission_level: params[6], admin_memo: params[7] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE user_profile SET user_name=?,organization_id=?,phone=?,address=?,email=?,permission_level=?,admin_memo=? WHERE user_id=?")) {
      assert.doesNotMatch(sql, /login_id\s*=/);
      const user = state.users.find(item => item.id === params[7]);
      Object.assign(user, { name: params[0], organization_id: params[1], phone: params[2], address: params[3], email: params[4], permission_level: params[5], admin_memo: params[6] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE user_profile SET user_name=?,phone=?,address=?,email=?,password_hash=?,user_request_at=")) {
      const user = state.users.find(item => item.id === params[5]);
      Object.assign(user, { name: params[0], phone: params[1], address: params[2], email: params[3] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE user_profile SET user_name=?,phone=?,address=?,email=?,user_request_at=")) {
      const user = state.users.find(item => item.id === params[4]);
      Object.assign(user, { name: params[0], phone: params[1], address: params[2], email: params[3] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT user_id AS id,login_id AS username,user_name AS name,organization_id,phone,address,email,role,permission_level,user_status AS status")) {
      return state.users.filter(user => user.id === params[0]).map(user => ({ ...user, id: user.id, username: user.username, name: user.name, organization_id: user.organization_id ?? null, phone: user.phone ?? null, address: user.address ?? null, email: user.email ?? null, status: user.status }));
    }
    if (sql.startsWith("SELECT comment_id AS request_id,event_type")) return state.comments.filter(row => String(row.id) === String(params[0]) && row.user_id === params[1]).map(row => ({ request_id: String(row.id), event_type: row.event_type }));
    if (sql.startsWith("SELECT comment_id FROM user_register_comment WHERE request_comment_id=?")) return state.comments.filter(row => String(row.request_comment_id) === String(params[0]) && ["APPROVAL", "REJECTION"].includes(row.event_type)).map(row => ({ comment_id: row.id }));
    if (sql.startsWith("SELECT CAST(c.comment_id AS CHAR) AS request_id")) return state.comments.filter(row => row.user_id !== null && ["LEVEL_CHANGE_REQUEST", "ORGANIZATION_CHANGE_REQUEST"].includes(row.event_type) && !state.comments.some(response => String(response.request_comment_id) === String(row.id) && ["APPROVAL", "REJECTION"].includes(response.event_type))).map(row => ({ request_id: String(row.id), user_id: row.user_id, event_type: row.event_type, comment: row.comment, created_at: row.created_at })).reverse();
    if (sql.includes("FROM user_profile u LEFT JOIN company_organization o") && sql.includes("organization_group_code")) {
      return state.users.map(user => {
        const organization = state.organizations.find(row => row.organization_id === user.organization_id);
        return {
          id: user.id, username: user.username, name: user.name, organization_id: user.organization_id, phone: user.phone, address: user.address, email: user.email, status: user.status, permission_level: user.permission_level,
          organization_group_code: organization?.group ?? null, organization_company_code: organization?.company ?? null,
          organization_site_code: organization?.site ?? null, organization_department_code: user.signup_department_code ?? organization?.department ?? null,
          organization_role_code: user.signup_role_code ?? organization?.role ?? null, group_name: organization?.group_name ?? null,
          company_name: organization?.company_name ?? null, site_name: organization?.site_name ?? null,
          department_name: organization?.department_name ?? null, role_name: organization?.role_name ?? null
        };
      });
    }
    if (sql.includes("FROM company_organization WHERE department IS NULL AND job IS NULL")) return state.organizations.filter(row => row.department == null && row.role == null).map(clone);
    if (sql.includes("FROM company_organization ORDER BY group_name,company_name")) return state.organizations.map(clone);
    if (sql.includes("FROM company_organization ORDER BY")) return state.organizations.map(clone);
    if (sql.startsWith("SELECT organization_id,group_code,company,site,department,job FROM company_organization WHERE organization_id=?")) return state.organizations.filter(row => row.organization_id === params[0]).map(row => ({ organization_id: row.organization_id, group_code: row.group, company: row.company, site: row.site, department: row.department, job: row.role }));
    if (sql.includes("FROM company_organization WHERE organization_id=?")) return state.organizations.filter(row => row.organization_id === params[0]).map(clone);
    if (sql.startsWith("INSERT INTO company_organization")) {
      assert.match(sql, /^INSERT INTO company_organization \(group_code,company,site,department,job,group_name,company_name,site_name,department_name,job_name,is_active\)/);
      const fields = registration.ORGANIZATION_CODES;
      if (state.organizations.some(row => fields.every((field, index) => row[field] === params[index]))) throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY" });
      const row = { organization_id: Math.max(...state.organizations.map(item => item.organization_id)) + 1, ...Object.fromEntries(fields.map((field, index) => [field, params[index]])), ...Object.fromEntries(fields.map((field, index) => [`${field}_name`, params[index + 5]])), is_active: params[10] };
      state.organizations.push(row);
      return { insertId: row.organization_id };
    }
    if (sql.startsWith("UPDATE company_organization SET group_name=?")) {
      assert.match(sql, /department_name=\?,job_name=\?,is_active=\?/);
      const row = state.organizations.find(item => item.organization_id === params[6]);
      registration.COMPANY_ORGANIZATION_CODES.forEach((field, index) => { row[`${field}_name`] = params[index]; });
      row.is_active = params[5];
      return { affectedRows: 1 };
    }
    if (sql.includes("FROM company_organization WHERE")) {
      assert.match(sql, /group_code AS `group`,company,site,department,job AS `role`/);
      assert.match(sql, /job_name AS role_name/);
      assert.match(sql, /WHERE `group_code`<=>\? AND `company`<=>\? AND `site`<=>\? AND `department`<=>\? AND `job`<=>\?/);
      return state.organizations.filter(row => row.is_active === 1 && registration.ORGANIZATION_CODES.every((field, index) => row[field] === params[index])).map(clone);
    }
    if (sql.includes("WHERE login_id = ? OR email = ?")) return state.users.filter(user => user.username === params[0] || (params[1] && user.email === params[1])).map(clone);
    if (sql.startsWith("INSERT INTO user_profile")) {
      if (params[7] != null && params[8] != null && state.users.some(user => user.signup_department_code === params[7] && user.signup_role_code === params[8])) {
        throw Object.assign(new Error("Duplicate entry for key 'uq_user_profile_signup_codes'"), { code: "ER_DUP_ENTRY", sqlMessage: "Duplicate entry for key 'uq_user_profile_signup_codes'" });
      }
      const user = { id: state.nextId++, username: params[0], name: params[2], phone: params[3], address: params[4], email: params[5], organization_id: params[6], signup_department_code: params[7], signup_role_code: params[8], status: "PENDING", role: "USER", permission_level: 1 };
      state.users.push(user);
      return { insertId: user.id };
    }
    if (sql.startsWith("INSERT INTO user_register_comment")) {
      if (state.failComment) throw new Error("synthetic comment failure");
      const values = sql.includes("'APPLICATION'") ? [params[0], params[1], "APPLICATION", params[2], params[3], params[4]]
        : sql.includes("'REAPPLICATION'") ? [params[0], params[1], "REAPPLICATION", params[2], params[3], params[4]]
        : sql.includes("'STATUS'") ? [params[0], params[1], "STATUS", params[2], params[3], params[4]] : params;
      state.comments.push({ id: state.comments.length + 1, user_id: values[0], login_id: values[1], event_type: values[2], comment: values[3], actor_user_id: values[4], actor_login_id: values[5], created_at: "2026-10-18 12:00:00.000", request_comment_id: params[6] ?? null });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT login_id AS username,user_status AS status FROM user_profile")) return state.users.filter(user => user.id === params[0]).map(user => ({ username: user.username, status: user.status }));
    if (sql === "DELETE FROM user_profile WHERE user_id=?") {
      if (state.failDelete) throw new Error("synthetic delete failure");
      state.users = state.users.filter(user => user.id !== params[0]);
      state.comments = state.comments.map(comment => comment.user_id === params[0] ? { ...comment, user_id: null } : comment);
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT login_id AS username,user_status AS status")) return state.users.filter(user => user.id === params[0]).map(user => ({ username: user.username, status: user.status }));
    if (sql.startsWith("SELECT login_id AS username")) return state.users.filter(user => user.id === params[0]).map(user => ({ username: user.username }));
    if (sql.startsWith("DELETE FROM user_profile")) {
      state.users = state.users.filter(user => user.id !== params[0]);
      state.comments = state.comments.map(comment => comment.user_id === params[0] ? { ...comment, user_id: null } : comment);
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT user_id AS id,login_id AS username")) return state.users.filter(user => user.id === params[0]).map(clone);
    if (sql.startsWith("UPDATE user_profile")) {
      const user = state.users.find(item => item.id === params.at(-1));
      assert.ok(user);
      user.status = sql.includes("user_status='APPROVED'") ? "APPROVED" : sql.includes("user_status='PENDING'") ? "PENDING" : sql.includes("user_status='WITHDRAWAL_PENDING'") ? "WITHDRAWAL_PENDING" : params[0];
      if (sql.includes("permission_level=1")) { user.permission_level = 1; user.role = "USER"; }
      return { affectedRows: 1 };
    }
    if (sql.includes("FROM user_register_comment WHERE user_id=?")) return state.comments.filter(row => row.user_id === params[0]).map(clone).reverse();
    if (sql.includes("LEFT JOIN company_organization")) {
      const user = state.users.find(item => item.id === params[0]);
      const row = state.organizations.find(item => item.organization_id === user?.organization_id);
      return row ? [clone(row)] : [];
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  };
  const context = vm.createContext({
    ...registration, registrationOrganizationCodes: registration.ORGANIZATION_CODES, ...policy, permissionPolicy: policy.defaultPermissionPolicy(), crypto: require("node:crypto"),
    console: { error(...args) { harnessErrors.push(args); } }, pool: { getConnection: async () => connection }, query: run,
    readUserOrganization: async () => null,
    connectionQuery: (_connection, sql, params) => run(sql, params),
    requireLogin() {}, requireMaster() {}, requireActiveAccount() {}, requireApproved() {}, requireAdminLevel: () => () => {}, sessions: new Map(), forceSuspendUser() {}, forceLogoutUser() {}, closeUserSockets() {}, clearSessionCookie() {},
    getPermissionLevel: policy.permissionLevel, hashPassword: () => "synthetic-hash",
    app: Object.fromEntries(["get", "put", "post", "delete"].map(method => [method, (url, ...handlers) => routes.set(`${method.toUpperCase()} ${url}`, handlers.at(-1))]))
  });
  vm.runInContext(source.slice(source.indexOf("function normalizePhone("), source.indexOf("function hashPassword(")), context);
  const registerStart = source.indexOf("function generateSignupOrganizationCodes()");
  const registerEnd = source.indexOf("// 로그인:", registerStart);
  vm.runInContext(source.slice(registerStart, registerEnd), context);
  vm.runInContext(source.slice(source.indexOf("function isDefaultCompany("), source.indexOf("async function readRegistrationHistory(")), context);
  const adminStart = source.indexOf("async function readRegistrationHistory(");
  const adminEnd = source.indexOf('app.put("/api/admin/users/:id",', adminStart);
  vm.runInContext(source.slice(adminStart, adminEnd), context);
  const profileStart = source.indexOf('app.put("/api/me",');
  const profileEnd = source.indexOf('app.post("/api/logout"', profileStart);
  vm.runInContext(source.slice(profileStart, profileEnd), context);
  const editStart = source.indexOf('app.put("/api/admin/users/:id",');
  const editEnd = source.indexOf('app.delete("/api/admin/users/:id"', editStart);
  vm.runInContext(source.slice(editStart, editEnd), context);
  const deleteStart = source.indexOf('app.delete("/api/admin/users/:id"');
  vm.runInContext(source.slice(deleteStart, source.indexOf("// 생산현황 API", deleteStart)), context);
  const reapplyStart = source.indexOf('app.post("/api/me/change-request"');
  const reapplyEnd = source.indexOf('app.post("/api/me/cancel-registration"', reapplyStart);
  if (reapplyStart >= 0 && reapplyEnd > reapplyStart) vm.runInContext(source.slice(reapplyStart, reapplyEnd), context);
  const cancelStart = source.indexOf('app.post("/api/me/cancel-registration"');
  const cancelEnd = source.indexOf('app.post("/api/me/withdraw"', cancelStart);
  if (cancelStart >= 0 && cancelEnd > cancelStart) vm.runInContext(source.slice(cancelStart, cancelEnd), context);
  const request = async (method, url, body = {}, user = { id: 1, username: "admin", status: "APPROVED", permissionLevel: 20 }, id, requestId) => {
    const result = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await routes.get(`${method} ${url}`)({ body, user, params: { id: String(id ?? ""), requestId: String(requestId ?? "") }, query: {} }, result);
    return result;
  };
  const application = overrides => ({ username: "applicant_1", name: "Applicant", password: "test-pass", passwordConfirm: "test-pass", email: "applicant@example.com", registerComment: "Production access requested", ...overrides });
  return { request, state: () => state, known, application, errors: () => harnessErrors };
}

test("administrator edits keep login IDs immutable and enforce the database email uniqueness rule", async () => {
  const harness = createRegistrationHarness();
  const users = harness.state().users;
  users[0].email = "admin@example.com";
  users.push({ id: 2, username: "member_02", name: "Member", phone: "010-1234-5678", email: "member@example.com", organization_id: null, permission_level: 4, role: "USER", status: "APPROVED" });
  users.push({ id: 3, username: "member_03", name: "Other", phone: "010-1234-5678", email: "taken@example.com", organization_id: null, permission_level: 3, role: "USER", status: "APPROVED" });
  const body = { username: "forged_login", name: "Updated Member", organizationId: 1, phone: "", email: "taken@example.com", permissionLevel: 4, adminMemo: "", password: "" };
  const duplicatePhone = await harness.request("PUT", "/api/admin/users/:id", { ...body, phone: "01012345678", email: "member@example.com" }, undefined, 2);
  assert.equal(duplicatePhone.statusCode, 409);
  assert.equal(duplicatePhone.body.field, "phone");
  assert.match(duplicatePhone.body.error, /전화번호/);
  const duplicate = await harness.request("PUT", "/api/admin/users/:id", body, undefined, 2);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.field, "email");
  assert.match(duplicate.body.error, /이메일/);
  assert.equal(users[1].username, "member_02");
  assert.equal(users[1].name, "Member");

  const updated = await harness.request("PUT", "/api/admin/users/:id", { ...body, email: "member@example.com" }, undefined, 2);
  assert.equal(updated.statusCode, 200);
  assert.equal(users[1].username, "member_02");
  assert.equal(users[1].name, "Updated Member");
  assert.equal(users[1].email, "member@example.com");
});

test("programmer levels require ZZZ, manage only lower ranks, and MASTER can bootstrap levels 21 through 25", async () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /const \{[^}]*MIN_PROGRAMMER_LEVEL[^}]*\} = require\("\.\/level-permissions"\)/);
  const harness = createRegistrationHarness();
  const zzz = { organization_id: 3, group: "ZZZ", company: "DEF", site: "DEF", department: "DEF", role: "DEF", group_name: "Programmers", company_name: "Unspecified", site_name: "Unspecified", department_name: "Unspecified", role_name: "Unspecified", is_active: 1 };
  const masterOrganization = { organization_id: 4, group: "ZZZ", company: null, site: null, department: null, role: null, group_name: "KIMS", company_name: "", site_name: "", department_name: "", role_name: "", is_active: 1 };
  harness.state().organizations.push(zzz, masterOrganization);
  Object.assign(harness.state().users[0], { role: "MASTER", permission_level: 25, organization_id: 4 });
  harness.state().users.push(
    { id: 2, username: "member_20", name: "Level 20", organization_id: 3, permission_level: 20, role: "USER", status: "APPROVED" },
    { id: 3, username: "programmer_22", name: "Level 22", organization_id: 3, permission_level: 22, role: "USER", status: "APPROVED" },
    { id: 4, username: "programmer_25", name: "Level 25", organization_id: 3, permission_level: 25, role: "USER", status: "APPROVED" },
    { id: 5, username: "member_01", name: "Level 1", organization_id: 1, permission_level: 1, role: "USER", status: "APPROVED" }
  );
  const edit = (id, permissionLevel, organizationId, actor) => harness.request("PUT", "/api/admin/users/:id", { name: "Changed", organizationId, phone: "", address: "", email: "", permissionLevel, adminMemo: "", password: "" }, actor, id);
  const programmer21 = { id: 21, username: "programmer_21", role: "USER", permissionLevel: 21, status: "APPROVED" };
  const programmer22 = { id: 22, username: "programmer_22", role: "USER", permissionLevel: 22, status: "APPROVED" };
  const master = { id: 1, username: "admin", role: "MASTER", permissionLevel: 25, status: "APPROVED" };

  const validNonProgrammerMaximum = await edit(5, 20, 1, master);
  assert.equal(validNonProgrammerMaximum.statusCode, 200);
  assert.equal(harness.state().users.find(user => user.id === 5).permission_level, 20);
  const wrongGroup = await edit(5, 21, 1, master);
  assert.equal(wrongGroup.statusCode, 400);
  assert.equal(wrongGroup.body.field, "organizationId");
  assert.equal(harness.state().users.find(user => user.id === 5).permission_level, 20);
  const wrongMasterOrganization = await edit(1, 25, 3, master);
  assert.equal(wrongMasterOrganization.statusCode, 400);
  for (const invalidCode of ["ZZZ", "null", ""]) {
    masterOrganization.company = invalidCode;
    assert.equal((await edit(1, 25, 4, master)).statusCode, 400);
  }
  masterOrganization.company = null;
  const validMasterOrganization = await edit(1, 25, 4, master);
  assert.equal(validMasterOrganization.statusCode, 200);

  const deniedHigher = await edit(3, 21, 3, programmer21);
  assert.equal(deniedHigher.statusCode, 403);
  const deniedPeerGrant = await edit(2, 21, 3, programmer21);
  assert.equal(deniedPeerGrant.statusCode, 403);
  const lowerGrant = await edit(2, 21, 3, programmer22);
  assert.equal(lowerGrant.statusCode, 200);
  assert.equal(harness.state().users.find(user => user.id === 2).permission_level, 21);

  const bootstrapped = await edit(2, 25, 3, master);
  assert.equal(bootstrapped.statusCode, 200);
  assert.equal(harness.state().users.find(user => user.id === 2).permission_level, 25);
});

test("signup and self-service profile updates reject duplicate phone numbers while NULL stays reusable", async () => {
  const signup = createRegistrationHarness();
  signup.state().users[0].phone = "010-1234-5678";
  const duplicateApplication = await signup.request("POST", "/api/register", signup.application({ username: "applicant_2", phone: "01012345678" }));
  assert.equal(duplicateApplication.statusCode, 409);
  assert.equal(duplicateApplication.body.field, "phone");
  assert.match(duplicateApplication.body.error, /전화번호/);
  assert.equal(signup.state().users.length, 1);
  const noPhoneApplication = await signup.request("POST", "/api/register", signup.application({ username: "applicant_3", phone: "" }));
  assert.equal(noPhoneApplication.statusCode, 201);
  assert.equal(signup.state().users.at(-1).phone, null);

  const profile = createRegistrationHarness();
  profile.state().users.push({ id: 2, username: "member_02", phone: "010-1234-5678", email: "taken@example.com", name: "Other", permission_level: 2, status: "APPROVED" });
  const phoneDuplicate = await profile.request("PUT", "/api/me", { name: "Admin", phone: "01012345678", email: "admin@example.com" });
  assert.equal(phoneDuplicate.statusCode, 409);
  assert.equal(phoneDuplicate.body.field, "phone");
  assert.match(phoneDuplicate.body.error, /전화번호/);
  const emailDuplicate = await profile.request("PUT", "/api/me", { name: "Admin", phone: "", email: "taken@example.com" });
  assert.equal(emailDuplicate.statusCode, 409);
  assert.equal(emailDuplicate.body.field, "email");
  assert.match(emailDuplicate.body.error, /이메일/);
});

test("administrator member edit disables the login ID field and omits it from updates", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.ok(source.includes("showFieldValidation(fieldIds[data.field], message.textContent)"));
  assert.match(source, /class="full edit-actions"><button[^>]*type="submit"[^>]*>수정 저장<\/button><button[^>]*type="button"[^>]*>수정 취소<\/button><span id="editMessage" class="auth-message" role="status" aria-live="polite"><\/span>/);
  assert.match(styles, /\.admin-edit-form \.edit-actions #editMessage\s*\{[^}]*flex:\s*1 1 0/s);
  assert.ok(source.includes("['editAddress', 'address']"));
  assert.ok(source.includes("address: editAddress.value"));
  assert.ok(source.includes("showFieldValidation(invalidField, invalidField.validationMessage)"));
  assert.ok(source.includes("showFieldValidation(fieldIds[data.field], message.textContent)"));
  assert.match(source, /selectedGroupCode !== 'ZZZ' && Number\(editPermissionLevel\.value\) > 20/);
  assert.ok(source.indexOf("selectedGroupCode !== 'ZZZ'") < source.indexOf("const body = {", source.indexOf("document.getElementById('editForm').addEventListener('submit'")));
  assert.match(source, /<input id="editUsername"[^>]*\bdisabled\b/);
  const start = source.indexOf("const body = {", source.indexOf("document.getElementById('editForm').addEventListener('submit'"));
  const end = source.indexOf("};", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /username/);
});

test("contact constraints normalize blanks, resolve phone duplicates by lowest ID and add nullable unique indexes once", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const normalizeStart = source.indexOf("function normalizePhone(");
  const normalizeEnd = source.indexOf("function hashPassword(", normalizeStart);
  const migrationStart = source.indexOf("async function ensureUserProfileContactConstraints()");
  const migrationEnd = source.indexOf("async function ensureOrganizationGroupCode()", migrationStart);
  const columns = [
    { column_name: "phone", column_type: "varchar(20)", is_nullable: "NO", column_default: "" },
    { column_name: "email", column_type: "varchar(254)", is_nullable: "YES", column_default: null }
  ];
  const indexes = [{ index_name: "uq_user_profile_email", column_name: "email", non_unique: 0, seq: 1 }];
  const users = [
    { user_id: 9, phone: "01012345678", email: "" },
    { user_id: 10, phone: "010-1234-5678", email: null },
    { user_id: 11, phone: "", email: "   " },
    { user_id: 12, phone: null, email: null }
  ];
  const calls = [];
  const context = vm.createContext({ query: async (sql, params = []) => {
    calls.push(sql);
    if (sql.startsWith("SELECT COLUMN_NAME AS column_name")) return columns.map(column => ({ ...column }));
    if (sql.startsWith("SELECT LOWER(TRIM(email)) AS normalized_email")) return [];
    if (sql.startsWith("SELECT user_id,phone FROM user_profile")) return users.filter(user => user.phone != null && user.phone.trim() !== "").map(({ user_id, phone }) => ({ user_id, phone }));
    if (sql.startsWith("UPDATE user_profile SET phone=NULL WHERE user_id IN (")) {
      for (const userId of params) users.find(user => user.user_id === userId).phone = null;
      return {};
    }
    if (sql === "UPDATE user_profile SET phone=NULL WHERE phone IS NOT NULL AND TRIM(phone)=''") {
      users.filter(user => user.phone != null && user.phone.trim() === "").forEach(user => { user.phone = null; });
      return {};
    }
    if (sql === "UPDATE user_profile SET email=NULL WHERE email IS NOT NULL AND TRIM(email)=''") {
      users.filter(user => user.email != null && user.email.trim() === "").forEach(user => { user.email = null; });
      return {};
    }
    if (sql === "UPDATE user_profile SET phone=? WHERE user_id=?") {
      Object.assign(users.find(user => user.user_id === params[1]), { phone: params[0] });
      return {};
    }
    if (sql.startsWith("SELECT INDEX_NAME AS index_name")) return indexes.map(index => ({ ...index }));
    if (sql.startsWith("ALTER TABLE user_profile ")) {
      for (const match of sql.matchAll(/MODIFY COLUMN (phone|email) ([^,]+)/g)) {
        const column = columns.find(item => item.column_name === match[1]);
        column.column_type = match[2].split(" ")[0]; column.is_nullable = "YES"; column.column_default = null;
      }
      for (const match of sql.matchAll(/ADD UNIQUE KEY (\w+) \((\w+)\)/g)) indexes.push({ index_name: match[1], column_name: match[2], non_unique: 0, seq: 1 });
      return {};
    }
    assert.fail(`Unexpected contact migration SQL: ${sql}`);
  } });
  vm.runInContext(source.slice(normalizeStart, normalizeEnd), context);
  vm.runInContext(source.slice(migrationStart, migrationEnd), context);
  await context.ensureUserProfileContactConstraints();
  assert.deepEqual(users, [
    { user_id: 9, phone: "010-1234-5678", email: null },
    { user_id: 10, phone: null, email: null },
    { user_id: 11, phone: null, email: null },
    { user_id: 12, phone: null, email: null }
  ]);
  assert.ok(indexes.some(index => index.index_name === "uq_user_profile_phone" && index.column_name === "phone"));
  assert.equal(calls.filter(sql => sql.startsWith("ALTER TABLE user_profile ")).length, 2);
  calls.length = 0;
  await context.ensureUserProfileContactConstraints();
  assert.equal(calls.some(sql => sql.startsWith("ALTER TABLE user_profile ")), false);
});

test("existing user profiles add a nullable address column once without altering stored rows", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureUserProfileAddress()");
  const end = source.indexOf("async function ensureOrganizationGroupCode()", start);
  let hasAddress = false;
  let additions = 0;
  const rows = [{ user_id: 4, phone: "010-1234-5678", email: "member@example.com" }];
  const snapshot = JSON.stringify(rows);
  const context = vm.createContext({ query: async sql => {
    if (sql === "SHOW COLUMNS FROM user_profile LIKE 'address'") return hasAddress ? [{ Field: "address", Type: "varchar(255)" }] : [];
    assert.equal(sql, "ALTER TABLE user_profile ADD COLUMN address VARCHAR(255) NULL DEFAULT NULL AFTER phone");
    hasAddress = true;
    additions++;
    return { affectedRows: 1 };
  } });
  vm.runInContext(source.slice(start, end), context);
  await context.ensureUserProfileAddress();
  await context.ensureUserProfileAddress();
  assert.equal(additions, 1);
  assert.equal(JSON.stringify(rows), snapshot);
});

test("member organization selection preserves SQL NULL descendants without accepting an unregistered partial organization", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const fields = ["group", "company", "site", "department", "role"];
  const elements = new Map(fields.map(field => [`editOrganization${field[0].toUpperCase()}${field.slice(1)}`, { value: "", innerHTML: "" }]));
  const organization = { organization_id: 55, group_code: "ZZZ", company_code: null, site_code: null, department_code: null, role_code: null, group_name: "KIMS", is_active: 1 };
  const context = vm.createContext({ memberOrganizationFields: fields, memberOrganizations: [organization], document: { getElementById: id => elements.get(id) }, h: value => String(value ?? "") });
  vm.runInContext(source.slice(source.indexOf("    function fillMemberOrganizationSelects("), source.indexOf("    function memberSortUsers(")), context);
  context.fillMemberOrganizationSelects(["ZZZ", null, null, null, null]);
  assert.equal(context.memberSelectedOrganizationId().organizationId, 55);
  assert.doesNotMatch(elements.get("editOrganizationCompany").innerHTML, /null/);
  elements.get("editOrganizationCompany").value = "AAA";
  assert.ok(context.memberSelectedOrganizationId().error);
  elements.get("editOrganizationGroup").value = "";
  elements.get("editOrganizationCompany").value = "";
  assert.match(context.memberSelectedOrganizationId().error, /그룹/);
});

test("existing MASTER accounts are promoted to level 25 and assigned the ZZZ organization with NULL descendants", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function findMasterOrganizationId()");
  const end = source.indexOf("// 예약 실행 엔진", start);
  const masters = [{ user_id: 7, permission_level: 20, organization_id: null, updated_at: "unchanged" }];
  const organization = { organization_id: 55, group_code: "ZZZ", company: null, site: null, department: null, job: null };
  const updates = [];
  const context = vm.createContext({ query: async (sql, params = []) => {
    if (sql.startsWith("SELECT organization_id FROM company_organization WHERE group_code='ZZZ'")) {
      for (const field of ["company", "site", "department", "job"]) assert.ok(sql.includes(`${field} IS NULL`));
      return [organization];
    }
    if (sql === "SELECT user_id FROM user_profile WHERE role='MASTER'") return masters.map(({ user_id }) => ({ user_id }));
    if (sql.startsWith("UPDATE user_profile SET permission_level=25,organization_id=?")) {
      assert.equal(sql, "UPDATE user_profile SET permission_level=25,organization_id=?,updated_at=updated_at WHERE role='MASTER' AND (permission_level<>25 OR organization_id IS NULL OR organization_id<>?)");
      assert.equal(params.length, 2);
      assert.equal(params[0], 55);
      assert.equal(params[1], 55);
      const changed = masters.filter(master => master.permission_level !== 25 || master.organization_id !== 55);
      for (const master of changed) Object.assign(master, { permission_level: 25, organization_id: 55 });
      updates.push(changed.length);
      return { affectedRows: changed.length };
    }
    assert.fail(`Unexpected MASTER migration SQL: ${sql}`);
  } });
  vm.runInContext(source.slice(start, end), context);
  await context.ensureExistingMasterAccounts();
  await context.ensureExistingMasterAccounts();
  assert.equal(masters[0].permission_level, 25);
  assert.equal(masters[0].organization_id, 55);
  assert.equal(masters[0].updated_at, "unchanged");
  assert.deepEqual(updates, [1, 0]);
});

test("organization group code rename preserves rows, runs once and refuses ambiguous columns", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureOrganizationGroupCode()");
  const end = source.indexOf("async function ensureOrganizationSchema()", start);
  for (const initial of [["group"], ["group_code"], ["group", "group_code"], []]) {
    const columns = new Set(initial);
    const rows = [{ organization_id: 7, group_code: "GRP" }];
    const snapshot = JSON.stringify(rows);
    let renames = 0;
    const context = vm.createContext({ query: async sql => {
      if (sql.startsWith("SELECT COLUMN_NAME AS column_name")) return [...columns].map(column_name => ({ column_name }));
      if (sql.startsWith("SELECT VERSION()")) return [{ version: "8.0.36" }];
      if (sql.startsWith("SELECT tc.CONSTRAINT_NAME")) return [];
      assert.equal(sql, "ALTER TABLE company_organization RENAME COLUMN `group` TO group_code");
      columns.delete("group"); columns.add("group_code"); renames++;
      return {};
    } });
    vm.runInContext(source.slice(start, end), context);
    if (initial.length !== 1) {
      await assert.rejects(context.ensureOrganizationGroupCode(), initial.length ? /함께/ : /없습니다/);
      assert.equal(renames, 0);
      assert.deepEqual([...columns], initial);
    } else {
      await context.ensureOrganizationGroupCode();
      await context.ensureOrganizationGroupCode();
      assert.equal(renames, initial[0] === "group" ? 1 : 0);
      assert.deepEqual([...columns], ["group_code"]);
    }
    assert.equal(JSON.stringify(rows), snapshot);
  }
});

test("organization job renames preserve rows, support partial upgrades and reject column conflicts", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureOrganizationJobColumns()");
  const end = source.indexOf("async function ensureOrganizationSchema()", start);
  for (const initial of [["role", "role_name"], ["job", "job_name"], ["job", "role_name"], ["role", "job_name"], ["role", "job", "role_name"], ["role", "role_name", "job_name"], ["role"]]) {
    const columns = new Set(initial);
    const rows = [{ organization_id: 7, job: "JOB", job_name: "Operator" }];
    const snapshot = JSON.stringify(rows);
    let alterations = 0;
    const context = vm.createContext({ query: async sql => {
      if (sql.startsWith("SELECT COLUMN_NAME AS column_name")) return [...columns].map(column_name => ({ column_name }));
      if (sql.startsWith("SELECT VERSION()")) return [{ version: "8.0.36" }];
      if (sql.startsWith("SELECT tc.CONSTRAINT_NAME")) return [];
      assert.match(sql, /^ALTER TABLE company_organization RENAME COLUMN/);
      for (const match of sql.matchAll(/RENAME COLUMN `([^`]+)` TO (\w+)/g)) { columns.delete(match[1]); columns.add(match[2]); }
      alterations++;
      return {};
    } });
    vm.runInContext(source.slice(start, end), context);
    if (initial.length !== 2) {
      await assert.rejects(context.ensureOrganizationJobColumns(), /함께|없습니다/);
      assert.equal(alterations, 0);
      assert.deepEqual([...columns], initial);
    } else {
      await context.ensureOrganizationJobColumns();
      await context.ensureOrganizationJobColumns();
      assert.equal(alterations, initial.includes("role") || initial.includes("role_name") ? 1 : 0);
      assert.deepEqual([...columns].sort(), ["job", "job_name"]);
    }
    assert.equal(JSON.stringify(rows), snapshot);
  }
});

test("organization renames restore affected checks atomically without rewriting string literals", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function renameOrganizationColumns(");
  const end = source.indexOf("async function ensureOrganizationSchema()", start);
  for (const version of ["8.0.36", "11.4.5-MariaDB"]) {
    const calls = [];
    const context = vm.createContext({ query: async sql => {
      calls.push(sql);
      if (sql.startsWith("SELECT VERSION()")) return [{ version }];
      if (sql.startsWith("SELECT tc.CONSTRAINT_NAME")) return [
        { constraint_name: "code_check", check_clause: "char_length(`group`)=3 AND char_length(role)=3 AND `role_name` <> 'role' AND `role_name` <> \"group\"" },
        { constraint_name: "active_check", check_clause: "is_active IN (0,1)" }
      ];
      return {};
    } });
    vm.runInContext(source.slice(start, end), context);
    await context.renameOrganizationColumns([["group", "group_code"], ["role", "job"], ["role_name", "job_name"]]);
    const alterations = calls.filter(sql => sql.startsWith("ALTER TABLE"));
    assert.equal(alterations.length, 1);
    assert.equal(alterations[0], "ALTER TABLE company_organization DROP " + (version.includes("MariaDB") ? "CONSTRAINT" : "CHECK") + " `code_check`, RENAME COLUMN `group` TO group_code, RENAME COLUMN `role` TO job, RENAME COLUMN `role_name` TO job_name, ADD CONSTRAINT `code_check` CHECK (char_length(`group_code`)=3 AND char_length(`job`)=3 AND `job_name` <> 'role' AND `job_name` <> \"group\")");
    assert.ok(!alterations[0].includes("active_check"));
  }
});

test("organization codes require three characters and comments enforce rejection reason limits", () => {
  const personalCodes = { group: "001", company: "001", site: "001", department: null, role: null };
  assert.deepEqual(registration.parseOrganizationSelection({}).codes, personalCodes);
  assert.deepEqual(registration.parseOrganizationSelection({ organizationUnknown: true, organization: { group: "DEF" } }).codes, personalCodes);
  const known = { organizationUnknown: false, organization: { group: "abc", company: "001", site: "공장동", department: "D01", role: "R01" } };
  assert.equal(registration.parseOrganizationSelection(known).codes.group, "ABC");
  assert.equal(registration.parseOrganizationSelection(known).codes.site, "공장동");
  assert.equal(registration.parseOrganizationSelection(known).codes.department, "D01");
  assert.equal(registration.parseOrganizationSelection(known).codes.role, "R01");
  for (const value of ["AB", "ABCD", "A B", "<x>"]) assert.ok(registration.parseOrganizationSelection({ ...known, organization: { ...known.organization, group: value } }).error);
  assert.ok(registration.validateRegisterComment(" ", true).error);
  assert.ok(registration.validateRegisterComment("x".repeat(2001)).error);
  assert.equal(registration.validateRegisterComment(" reason ").comment, "reason");
});

test("registration matches every organization code server-side and ignores forged company or privilege fields", async () => {
  const harness = createRegistrationHarness();
  const lookup = await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: harness.known });
  assert.equal(lookup.body.organization.company, "Verified company");
  const result = await harness.request("POST", "/api/register", harness.application({ organizationUnknown: false, organization: harness.known, company: "Forged", role: "MASTER", permissionLevel: 20 }));
  assert.equal(result.statusCode, 201);
  const user = harness.state().users.find(item => item.username === "applicant_1");
  assert.equal(user.organization_id, 2);
  assert.equal(Object.hasOwn(user, "company"), false);
  assert.equal(Object.hasOwn(user, "region"), false);
  assert.equal(Object.hasOwn(user, "position"), false);
  assert.equal(user.organization_id, 2);
  assert.equal(user.role, "USER");
  assert.equal(user.permission_level, 1);
  assert.equal(user.status, "PENDING");
  assert.equal(user.signup_department_code, null);
  assert.equal(user.signup_role_code, null);
  assert.equal(harness.state().comments[0].event_type, "APPLICATION");
  assert.equal(harness.state().comments[0].comment, "Production access requested");
  const memberList = await harness.request("GET", "/api/admin/users");
  const listedUser = memberList.body.find(member => member.id === user.id);
  assert.ok(listedUser, JSON.stringify(memberList.body));
  assert.equal(listedUser.organization_group_code, "GRP");
  assert.equal(listedUser.organization_company_code, "COM");
  assert.equal(listedUser.organization_department_code, "D01");
  assert.equal(listedUser.organization_role_code, "R01");
  assert.equal(listedUser.company_name, "Verified company");
  assert.equal(Object.hasOwn(listedUser, "region"), false);
  const organizationOptions = await harness.request("GET", "/api/admin/users/organizations");
  assert.equal(organizationOptions.body.organizations.length, 2);
});

test("registration and member edits require a group while matching nullable organization codes exactly", async () => {
  const harness = createRegistrationHarness();
  for (const [index, codes] of [
    { group: "GRP", company: null, site: null, department: null, role: null },
    { group: "GRP", company: "COM", site: null, department: null, role: null }
  ].entries()) {
    const organizationId = 10 + index;
    harness.state().organizations.push({ organization_id: organizationId, ...codes, group_name: "Group", is_active: 1 });
    const organization = Object.fromEntries(Object.entries(codes).map(([field, value]) => [field, value ?? " "]));
    const selection = { organizationUnknown: false, organization };
    assert.deepEqual(registration.parseOrganizationSelection(selection).codes, codes);
    const lookup = await harness.request("POST", "/api/register/organization", selection);
    assert.equal(lookup.statusCode, 200);
    assert.deepEqual(lookup.body.organization.codes, codes);
    const application = await harness.request("POST", "/api/register", harness.application({ ...selection, username: `nullable_${index}`, phone: "", email: "" }));
    assert.equal(application.statusCode, 201);
    const user = harness.state().users.at(-1);
    assert.equal(user.organization_id, organizationId);
    const body = { name: "Member", organizationId, phone: "", email: "", permissionLevel: 1, adminMemo: "", password: "" };
    const updated = await harness.request("PUT", "/api/admin/users/:id", body, undefined, user.id);
    assert.equal(updated.statusCode, 200);
    const missingGroup = await harness.request("PUT", "/api/admin/users/:id", { ...body, organizationId: null }, undefined, user.id);
    assert.equal(missingGroup.statusCode, 400);
    assert.equal(missingGroup.body.field, "organizationId");
    assert.equal(user.organization_id, organizationId);
  }
  for (const value of [null, "", " "]) assert.ok(registration.parseOrganizationSelection({ organizationUnknown: false, organization: { group: value } }).error);
  for (const value of ["AB", "A B", 123, false]) assert.ok(registration.parseOrganizationSelection({ organizationUnknown: false, organization: { group: "GRP", company: value } }).error);
  const missing = await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: { group: "OTH" } });
  assert.equal(missing.statusCode, 404);
});

test("unknown organization uses Default but invalid or deactivated known combinations cannot register", async () => {
  const harness = createRegistrationHarness();
  const lookup = await harness.request("POST", "/api/register/organization", { organizationUnknown: true });
  assert.equal(lookup.statusCode, 200);
  assert.deepEqual(lookup.body.organization.codes, { group: "001", company: "001", site: "001", department: null, role: null });
  const defaultResult = await harness.request("POST", "/api/register", harness.application({ organizationUnknown: true, company: "Forged" }));
  assert.equal(defaultResult.statusCode, 201);
  assert.equal(harness.state().users.at(-1).organization_id, 1);
  assert.equal(harness.state().users.at(-1).organization_id, 1);
  const invalid = await harness.request("POST", "/api/register", harness.application({ username: "another_1", email: "another@example.com", organizationUnknown: false, organization: { ...harness.known, group: "BAD" } }));
  assert.equal(invalid.statusCode, 400);
  harness.state().organizations[1].is_active = 0;
  const inactive = await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: harness.known });
  assert.equal(inactive.statusCode, 404);
  assert.equal(harness.state().comments.length, 1);
});

test("signup keeps the personal group, company and site fixed and assigns unique random department-role pairs", async () => {
  const harness = createRegistrationHarness();
  const registered = [];
  for (let index = 0; index < 30; index++) {
    const result = await harness.request("POST", "/api/register", harness.application({
      username: `personal_${index}`,
      email: "",
      phone: "",
      organizationUnknown: true,
      organization: { group: "BAD", company: "BAD", site: "BAD" }
    }));
    assert.equal(result.statusCode, 201);
    registered.push(harness.state().users.at(-1));
  }
  assert.ok(registered.every(user => user.organization_id === 1));
  assert.ok(registered.every(user => /^[0-9A-Z]{3}$/.test(user.signup_department_code)));
  assert.ok(registered.every(user => /^[0-9A-Z]{3}$/.test(user.signup_role_code)));
  assert.equal(new Set(registered.map(user => `${user.signup_department_code}:${user.signup_role_code}`)).size, registered.length);
  assert.deepEqual(
    Object.fromEntries(registration.ORGANIZATION_CODES.map(field => [field, harness.state().organizations[0][field]])),
    { group: "001", company: "001", site: "001", department: null, role: null }
  );
});

test("existing personal members receive unique signup codes during idempotent schema migration", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const columns = new Set();
  const members = [{ user_id: 10 }, { user_id: 11 }];
  const assigned = new Map();
  const queries = [];
  const cleanupQueries = [];
  let hasIndex = false;
  const context = vm.createContext({
    generateSignupOrganizationCodes: () => ({ department: `D${String(assigned.size + 1).padStart(2, "0")}`, role: `R${String(assigned.size + 1).padStart(2, "0")}` }),
    query: async (sql, params = []) => {
      queries.push(sql);
      const match = /^SHOW COLUMNS FROM user_profile LIKE '(.+)'$/.exec(sql);
      if (match) return columns.has(match[1]) ? [{ Field: match[1] }] : [];
      const addColumn = /^ALTER TABLE user_profile ADD COLUMN (\w+)/.exec(sql);
      if (addColumn) { columns.add(addColumn[1]); return {}; }
      if (sql.includes("information_schema.STATISTICS")) return hasIndex ? [{ index_name: "uq_user_profile_signup_codes" }] : [];
      if (sql.startsWith("ALTER TABLE user_profile ADD UNIQUE KEY")) { hasIndex = true; return {}; }
      if (sql.startsWith("UPDATE user_profile u LEFT JOIN company_organization")) {
        cleanupQueries.push(sql);
        assert.match(sql, /o\.department IS NULL AND o\.job IS NULL/);
        assert.match(sql, /u\.signup_department_code=NULL,u\.signup_role_code=NULL/);
        return {};
      }
      if (sql.startsWith("SELECT u.user_id FROM user_profile")) return members.filter(user => !assigned.has(user.user_id));
      if (sql.startsWith("UPDATE user_profile SET signup_department_code=")) {
        const [department, role, userId] = params;
        assert.equal([...assigned.values()].some(codes => codes.department === department && codes.role === role), false);
        assigned.set(userId, { department, role });
        return {};
      }
      assert.fail(`Unexpected signup-code migration SQL: ${sql}`);
    }
  });
  vm.runInContext(source.slice(source.indexOf("async function ensureSignupOrganizationCodes()"), source.indexOf("const dbConfig")), context);
  await context.ensureSignupOrganizationCodes();
  await context.ensureSignupOrganizationCodes();
  assert.deepEqual([...columns], ["signup_department_code", "signup_role_code"]);
  assert.equal(hasIndex, true);
  assert.equal(cleanupQueries.length, 2);
  assert.equal(assigned.size, 2);
  assert.equal(queries.filter(sql => sql.startsWith("ALTER TABLE user_profile ADD COLUMN")).length, 2);
  assert.equal(queries.filter(sql => sql.startsWith("ALTER TABLE user_profile ADD UNIQUE KEY")).length, 1);
});


test("application reason is mandatory and blank or missing comments create no member or history", async () => {
  const harness = createRegistrationHarness();
  for (const registerComment of [undefined, null, "", " \n\t "]) {
    const result = await harness.request("POST", "/api/register", harness.application({ registerComment }));
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /가입 신청 이유/);
    assert.equal(harness.state().users.length, 1);
    assert.equal(harness.state().comments.length, 0);
  }
  const valid = await harness.request("POST", "/api/register", harness.application({ registerComment: "  승인 요청 사유  " }));
  assert.equal(valid.statusCode, 201);
  assert.equal(harness.state().comments[0].comment, "승인 요청 사유");
});

test("reapplication requires a reason and appends REAPPLICATION history transactionally", async () => {
  const harness = createRegistrationHarness();
  const created = await harness.request("POST", "/api/register", harness.application({ username: "reapply_user" }));
  assert.equal(created.statusCode, 201);
  const applicant = harness.state().users.at(-1);
  applicant.status = "REJECTED";
  const user = { id: applicant.id, username: applicant.username, status: "REJECTED", permissionLevel: 1 };
  for (const comment of [undefined, null, "   ", "x".repeat(2001)]) {
    const missing = await harness.request("POST", "/api/me/reapply", comment === undefined ? {} : { comment }, user);
    assert.equal(missing.statusCode, 400);
    assert.match(missing.body.error, comment?.length > 2000 ? /2000자/ : /재신청 이유/);
    assert.equal(applicant.status, "REJECTED");
    assert.equal(harness.state().comments.length, 1);
  }
  harness.state().failComment = true;
  const failed = await harness.request("POST", "/api/me/reapply", { comment: "Retry reason" }, user);
  assert.equal(failed.statusCode, 500);
  assert.equal(harness.state().users.at(-1).status, "REJECTED");
  assert.equal(harness.state().comments.length, 1);
  harness.state().failComment = false;
  const result = await harness.request("POST", "/api/me/reapply", { comment: "  새로운 사유  " }, user);
  assert.equal(result.statusCode, 200);
  assert.equal(harness.state().users.at(-1).status, "PENDING");
  const history = harness.state().comments.filter(row => row.login_id === applicant.username);
  assert.equal(history.length, 2);
  assert.equal(history[1].event_type, "REAPPLICATION");
  assert.equal(history[1].comment, "새로운 사유");
  for (const status of ["PENDING", "APPROVED"]) {
    harness.state().users.at(-1).status = status;
    user.status = "REJECTED";
    const denied = await harness.request("POST", "/api/me/reapply", { comment: "Another request" }, user);
    assert.equal(denied.statusCode, 400);
    assert.match(denied.body.error, /반려된 회원만/);
    assert.equal(harness.state().users.at(-1).status, status);
    assert.equal(harness.state().comments.length, 2);
  }
});
test("approved members can request level or organization changes without mutating their profile", async () => {
  const harness = createRegistrationHarness();
  const original = JSON.stringify(harness.state().users);
  for (const [kind, eventType] of [["LEVEL", "LEVEL_CHANGE_REQUEST"], ["ORGANIZATION", "ORGANIZATION_CHANGE_REQUEST"]]) {
    const result = await harness.request("POST", "/api/me/change-request", { kind, comment: "  Requested change  ", userId: 999, permissionLevel: 20, organizationId: 999 });
    assert.equal(result.statusCode, 200);
    const row = harness.state().comments.at(-1);
    assert.equal(row.event_type, eventType);
    assert.equal(row.comment, "Requested change");
    assert.equal(row.user_id, 1);
    assert.equal(row.actor_user_id, 1);
    assert.equal(row.login_id, "admin");
  }
  assert.equal(JSON.stringify(harness.state().users), original);
  for (const body of [{}, { kind: ["LEVEL"], comment: "Reason" }, { kind: {}, comment: "Reason" }, { kind: "OTHER", comment: "Reason" }, { kind: "__proto__", comment: "Reason" }, { kind: "LEVEL" }, { kind: "LEVEL", comment: "   " }, { kind: "LEVEL", comment: "x".repeat(2001) }]) {
    assert.equal((await harness.request("POST", "/api/me/change-request", body)).statusCode, 400);
  }
  for (const status of ["PENDING", "REJECTED", "SUSPENDED", "WITHDRAWAL_PENDING"]) {
    harness.state().users[0].status = status;
    assert.equal((await harness.request("POST", "/api/me/change-request", { kind: "LEVEL", comment: "Reason" })).statusCode, 400);
  }
  harness.state().users[0].status = "APPROVED";
  harness.state().failComment = true;
  assert.equal((await harness.request("POST", "/api/me/change-request", { kind: "LEVEL", comment: "Reason" })).statusCode, 500);
  assert.equal(harness.state().comments.length, 2);
  assert.equal(JSON.stringify(harness.state().users), original);
});

test("approved level and organization requests are exposed to the administrator pending queue", async () => {
  const harness = createRegistrationHarness();
  await harness.request("POST", "/api/register", harness.application());
  const applicant = harness.state().users.at(-1);
  applicant.status = "APPROVED";
  const user = { id: applicant.id, username: applicant.username, status: "APPROVED", permissionLevel: 1 };
  for (const kind of ["LEVEL", "ORGANIZATION"]) assert.equal((await harness.request("POST", "/api/me/change-request", { kind, comment: `${kind} request` }, user)).statusCode, 200);
  const result = await harness.request("GET", "/api/admin/users");
  assert.equal(result.statusCode, 200);
  const listed = result.body.find(row => row.id === applicant.id);
  assert.equal(listed.status, "APPROVED");
  assert.equal(listed.permission_level, 1);
  assert.deepEqual(Array.from(listed.pending_requests, request => request.event_type), ["ORGANIZATION_CHANGE_REQUEST", "LEVEL_CHANGE_REQUEST"]);
  assert.equal(listed.pending_requests.length, 2);
});

test("request decisions close only the selected pending request without changing account approval", async () => {
  const harness = createRegistrationHarness();
  await harness.request("POST", "/api/register", harness.application());
  const applicant = harness.state().users.at(-1);
  applicant.status = "APPROVED";
  const user = { id: applicant.id, username: applicant.username, status: "APPROVED", permissionLevel: 1 };
  for (const kind of ["LEVEL", "ORGANIZATION"]) await harness.request("POST", "/api/me/change-request", { kind, comment: `${kind} request` }, user);
  const requests = harness.state().comments.filter(row => row.event_type.endsWith("CHANGE_REQUEST"));
  const original = JSON.stringify(requests);
  const decide = (requestId, status, comment = "Decision", actor) => harness.request("PUT", "/api/admin/users/:id/requests/:requestId", { status, comment }, actor, applicant.id, requestId);
  assert.equal((await decide(requests[0].id, "APPROVED", "Self", user)).statusCode, 403);
  assert.equal((await decide(requests[0].id, "REJECTED", "   ")).statusCode, 400);
  assert.equal((await decide("18446744073709551616", "APPROVED")).statusCode, 400);
  harness.state().users.at(-1).permission_level = 20;
  assert.equal((await decide(requests[0].id, "APPROVED")).statusCode, 403);
  harness.state().users.at(-1).permission_level = 1;
  harness.state().users.at(-1).status = "WITHDRAWAL_PENDING";
  assert.equal((await decide(requests[0].id, "APPROVED")).statusCode, 409);
  harness.state().users.at(-1).status = "APPROVED";
  assert.equal((await decide(1, "APPROVED")).statusCode, 404);
  harness.state().failComment = true;
  assert.equal((await decide(requests[0].id, "APPROVED")).statusCode, 500);
  harness.state().failComment = false;
  const pending = async () => (await harness.request("GET", "/api/admin/users")).body.find(row => row.id === applicant.id).pending_requests;
  assert.equal((await pending()).length, 2);
  assert.equal((await decide(requests[0].id, "APPROVED", "  Updated level  ")).statusCode, 200);
  assert.equal((await pending()).length, 1);
  assert.equal((await decide(requests[0].id, "APPROVED")).statusCode, 409);
  assert.equal((await decide(requests[1].id, "REJECTED", "Organization request rejected")).statusCode, 200);
  assert.equal((await pending()).length, 0);
  assert.equal(JSON.stringify(harness.state().comments.filter(row => row.event_type.endsWith("CHANGE_REQUEST"))), original);
  assert.equal(harness.state().comments.at(-1).request_comment_id, String(requests[1].id));
  assert.equal(harness.state().users.at(-1).status, "APPROVED");
  assert.equal(harness.state().users.at(-1).permission_level, 1);
});

test("member action menu preserves status and permission specific operations", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("function memberActionItems(");
  const end = source.indexOf("function closeMemberActions(", start);
  const context = vm.createContext({ currentAdminLevel: 20, currentAdminId: 1, memberManagementLevel: user => user.role === "MASTER" ? 26 : Number(user.permission_level || 1) });
  vm.runInContext(source.slice(start, end), context);
  const labels = (status, level = 1) => Array.from(context.memberActionItems({ id: 2, status, permission_level: level }), item => item.label);
  assert.deepEqual(labels("PENDING"), ["승인", "반려", "삭제", "수정", "신청 이력"]);
  assert.deepEqual(labels("WITHDRAWAL_PENDING"), ["탈퇴 반려", "탈퇴 승인", "삭제", "수정", "신청 이력"]);
  assert.deepEqual(labels("APPROVED"), ["정지", "삭제", "수정", "신청 이력"]);
  assert.deepEqual(labels("SUSPENDED"), ["재승인", "삭제", "수정", "신청 이력"]);
  assert.deepEqual(labels("APPROVED", 20), ["신청 이력"]);
  context.currentAdminLevel = 22;
  assert.deepEqual(labels("APPROVED", 25), ["신청 이력"]);
  assert.deepEqual(labels("APPROVED", 21), ["정지", "삭제", "수정", "신청 이력"]);
  const render = source.slice(source.indexOf("function renderMemberTable()"), source.indexOf("function statusText("));
  assert.ok(render.includes('class="member-action-trigger"'));
  assert.equal(render.includes("addRegisterHistoryButtons(table"), false);
});

test("pending action menus preserve the selected request and membership workflow", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("function memberActionItems(");
  const end = source.indexOf("function closeMemberActions(", start);
  const calls = [];
  const context = vm.createContext({ currentAdminLevel: 20, currentAdminId: 1, memberManagementLevel: user => user.role === "MASTER" ? 26 : Number(user.permission_level || 1), resolveRequest: (...args) => calls.push(args), showRegisterComments: (...args) => calls.push(args), changeStatus: (...args) => calls.push(args), deleteUser: (...args) => calls.push(args) });
  vm.runInContext(source.slice(start, end), context);
  const user = { id: 2, status: "APPROVED", permission_level: 8 };
  for (const requestId of ["101", "102"]) {
    const actions = context.memberActionItems(user, { pending: true, request: { request_id: requestId } });
    assert.deepEqual(Array.from(actions, item => item.label), ["요청 승인", "요청 반려", "삭제", "수정", "신청 이력"]);
    actions[0].run(); actions[1].run(); actions.at(-1).run();
    assert.deepEqual(calls.splice(0), [[2, requestId, "APPROVED"], [2, requestId, "REJECTED"], [2, requestId]]);
  }
  for (const status of ["PENDING", "REJECTED"]) assert.deepEqual(Array.from(context.memberActionItems({ ...user, status }, { pending: true }), item => item.label), ["승인", "반려", "삭제", "수정", "신청 이력"]);
  const withdrawal = context.memberActionItems({ ...user, status: "WITHDRAWAL_PENDING" }, { pending: true });
  assert.deepEqual(Array.from(withdrawal, item => item.label), ["탈퇴 반려", "탈퇴 승인", "삭제", "수정", "신청 이력"]);
  withdrawal[1].run();
  assert.deepEqual(calls[0], [2, "WITHDRAWAL_APPROVAL"]);
  assert.ok(source.includes('data-request-id="${h(request?.request_id'));
  assert.equal(source.includes('function addRegisterHistoryButtons('), false);
});

test("member action menu handles window scroll and ignores scrolling within the menu", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("window.addEventListener('scroll', event =>");
  const end = source.indexOf("\n", start);
  class FakeNode {}
  const menuChild = new FakeNode();
  let scrollHandler;
  let closes = 0;
  const context = vm.createContext({ Node: FakeNode, window: { addEventListener: (_type, handler) => { scrollHandler = handler; } }, actionMenu: { contains: target => target === menuChild }, closeMemberActions: () => { closes++; } });
  vm.runInContext(source.slice(start, end), context);
  scrollHandler({ target: {} });
  scrollHandler({ target: new FakeNode() });
  scrollHandler({ target: menuChild });
  assert.equal(closes, 2);
});

test("pending application entries include each change request and withdrawal without changing users", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("function pendingApplicationEntries(");
  const end = source.indexOf("async function loadUsers()", start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const users = [{ id: 1, status: "APPROVED", pending_requests: [{ event_type: "LEVEL_CHANGE_REQUEST" }, { event_type: "ORGANIZATION_CHANGE_REQUEST" }] }, { id: 2, status: "WITHDRAWAL_PENDING" }, { id: 3, status: "PENDING" }, { id: 4, status: "REJECTED" }, { id: 5, status: "APPROVED" }];
  const original = JSON.stringify(users);
  const entries = context.pendingApplicationEntries(users);
  assert.equal(entries.length, 5);
  assert.equal(entries.filter(entry => entry.request).length, 2);
  assert.equal(entries.filter(entry => entry.user.status === "WITHDRAWAL_PENDING").length, 1);
  assert.equal(JSON.stringify(users), original);
});

test("request comment popup stays accessible while decision restrictions remain enforced", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-admin.html"), "utf8");
  const start = source.indexOf("function requestDecisionRestriction(");
  const end = source.indexOf("function requestProcessingComment(", start);
  const context = vm.createContext({ currentAdminId: 1, currentAdminLevel: 20, memberManagementLevel: user => user.role === "MASTER" ? 26 : Number(user.permission_level || 1) });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.requestDecisionRestriction({ id: 2, status: "APPROVED", permission_level: 8 }), '');
  assert.equal(context.requestDecisionRestriction({ id: 2, status: "APPROVED", permission_level: 19 }), '');
  assert.match(context.requestDecisionRestriction({ id: 1, status: "APPROVED", permission_level: 20 }), /본인의 요청/);
  assert.match(context.requestDecisionRestriction({ id: 2, status: "APPROVED", permission_level: 20 }), /낮은 등급/);
  assert.match(context.requestDecisionRestriction({ id: 2, status: "WITHDRAWAL_PENDING", permission_level: 8 }), /승인 상태/);
  assert.equal(source.includes('<button ${disabled} onclick="resolveRequest'), false);
  assert.ok(source.includes('submit.disabled = Boolean(restriction) || !loaded'));
});

test("processing history loading reports failures and ignores stale responses", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "registration-history.js"), "utf8");
  const container = { textContent: "", innerHTML: "" };
  const responses = [];
  const context = vm.createContext({ window: {}, document: { getElementById: () => null }, fetch: () => new Promise(resolve => responses.push(resolve)) });
  vm.runInContext(source, context);
  const load = context.window.loadRegistrationHistory;
  const old = load(container, "/old");
  const current = load(container, "/current");
  responses[1]({ ok: true, json: async () => ({ comments: [{ event_type: "APPROVAL", request_comment_id: "1", comment: "<current>", login_id: "applicant", actor_login_id: "admin" }] }) });
  assert.equal(await current, true);
  responses[0]({ ok: true, json: async () => ({ comments: [] }) });
  assert.equal(await old, false);
  assert.match(container.innerHTML, /요청 승인/);
  assert.match(container.innerHTML, /&lt;current&gt;/);
  const failed = load(container, "/failed");
  responses[2]({ ok: false, json: async () => ({ error: "History unavailable" }) });
  assert.equal(await failed, false);
  assert.equal(container.textContent, "History unavailable");
});

test("administrator request form includes withdrawal and stays hidden outside approved status", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "user-profile.html"), "utf8");
  const css = require("postcss").parse(fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8"));
  assert.ok(html.includes('<label for="changeRequestKind">관리자 요청</label>'));
  assert.ok(html.includes('<option value="WITHDRAWAL">탈퇴 신청</option>'));
  assert.equal(html.includes('id="withdrawButton"'), false);
  const hidden = css.nodes.find(node => node.type === "rule" && node.selector === "body.profile-page .profile-panel #changeRequestForm[hidden]");
  assert.ok(hidden);
  assert.equal(hidden.nodes.find(node => node.prop === "display")?.value, "none");
});

test("administrator withdrawal requests require reasons and save status and history atomically", async () => {
  const harness = createRegistrationHarness();
  const user = { id: 1, username: "admin", status: "APPROVED", permissionLevel: 20 };
  for (const comment of [undefined, "   ", "x".repeat(2001)]) {
    const invalid = await harness.request("POST", "/api/me/change-request", { kind: "WITHDRAWAL", comment }, user);
    assert.equal(invalid.statusCode, 400);
    assert.equal(harness.state().users[0].status, "APPROVED");
    assert.equal(harness.state().comments.length, 0);
  }
  harness.state().failComment = true;
  assert.equal((await harness.request("POST", "/api/me/change-request", { kind: "WITHDRAWAL", comment: "Reason" }, user)).statusCode, 500);
  assert.equal(harness.state().users[0].status, "APPROVED");
  assert.equal(user.status, "APPROVED");
  harness.state().failComment = false;
  const result = await harness.request("POST", "/api/me/change-request", { kind: "WITHDRAWAL", comment: "  Leaving the company  " }, user);
  assert.equal(result.statusCode, 200);
  assert.equal(harness.state().users[0].status, "WITHDRAWAL_PENDING");
  assert.equal(user.status, "WITHDRAWAL_PENDING");
  assert.equal(harness.state().users[0].permission_level, 20);
  assert.equal(harness.state().comments.length, 1);
  assert.equal(harness.state().comments[0].event_type, "WITHDRAWAL_REQUEST");
  assert.equal(harness.state().comments[0].comment, "Leaving the company");
  user.status = "APPROVED";
  assert.equal((await harness.request("POST", "/api/me/change-request", { kind: "WITHDRAWAL", comment: "Duplicate" }, user)).statusCode, 400);
  assert.equal(harness.state().comments.length, 1);
});

test("member processing comments cover every status, withdrawal rejection, deletion and withdrawal approval", async () => {
  const harness = createRegistrationHarness();
  await harness.request("POST", "/api/register", harness.application());
  const id = harness.state().users.at(-1).id;
  for (const [status, eventType] of [["APPROVED", "APPROVAL"], ["SUSPENDED", "SUSPENSION"], ["PENDING", "STATUS"], ["REJECTED", "REJECTION"]]) {
    assert.equal((await harness.request("PUT", "/api/admin/users/:id/status", { status, comment: `  ${status} reason  ` }, undefined, id)).statusCode, 200);
    assert.equal(harness.state().comments.at(-1).event_type, eventType);
    assert.equal(harness.state().comments.at(-1).comment, `${status} reason`);
  }
  harness.state().users.at(-1).status = "WITHDRAWAL_PENDING";
  assert.equal((await harness.request("PUT", "/api/admin/users/:id/status", { status: "APPROVED", comment: "Withdrawal denied" }, undefined, id)).statusCode, 200);
  assert.equal(harness.state().comments.at(-1).event_type, "WITHDRAWAL_REJECTION");
  const before = harness.state().comments.length;
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { comment: "Self" }, undefined, 1)).statusCode, 403);
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { action: "UNKNOWN", comment: "Reason" }, undefined, id)).statusCode, 400);
  harness.state().users.at(-1).permission_level = 20;
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { comment: "Peer" }, undefined, id)).statusCode, 403);
  harness.state().users.at(-1).permission_level = 1;
  for (const flag of ["failComment", "failDelete"]) {
    harness.state()[flag] = true;
    assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { comment: "Delete reason" }, undefined, id)).statusCode, 500);
    assert.ok(harness.state().users.some(user => user.id === id));
    assert.equal(harness.state().comments.length, before);
    harness.state()[flag] = false;
  }
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { action: "WITHDRAWAL_APPROVAL", comment: "Reason" }, undefined, id)).statusCode, 409);
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { comment: "x".repeat(2001) }, undefined, id)).statusCode, 400);
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { comment: "  Delete reason  " }, undefined, id)).statusCode, 200);
  assert.equal(harness.state().comments.at(-1).event_type, "DELETION");
  assert.equal(harness.state().comments.at(-1).comment, "Delete reason");
  assert.equal(harness.state().comments.at(-1).user_id, null);
  assert.equal(harness.state().comments.at(-1).actor_login_id, "admin");
  await harness.request("POST", "/api/register", harness.application({ username: "withdrawal_user" }));
  const withdrawal = harness.state().users.at(-1);
  withdrawal.status = "WITHDRAWAL_PENDING";
  assert.equal((await harness.request("DELETE", "/api/admin/users/:id", { action: "WITHDRAWAL_APPROVAL", comment: "Withdrawal approved" }, undefined, withdrawal.id)).statusCode, 200);
  assert.equal(harness.state().comments.at(-1).event_type, "WITHDRAWAL_APPROVAL");
  assert.equal(harness.state().comments.at(-1).user_id, null);
});

test("application comment failure rolls back the new member", async () => {
  const harness = createRegistrationHarness();
  harness.state().failComment = true;
  const result = await harness.request("POST", "/api/register", harness.application());
  assert.equal(result.statusCode, 500);
  assert.equal(harness.state().users.length, 1);
  assert.equal(harness.state().comments.length, 0);
});

test("rejection comments are required, append to history, and status changes roll back when audit fails", async () => {
  const harness = createRegistrationHarness();
  await harness.request("POST", "/api/register", harness.application());
  const id = harness.state().users.at(-1).id;
  const missing = await harness.request("PUT", "/api/admin/users/:id/status", { status: "REJECTED", comment: " " }, undefined, id);
  assert.equal(missing.statusCode, 400);
  assert.equal(harness.state().users.at(-1).status, "PENDING");
  const rejected = await harness.request("PUT", "/api/admin/users/:id/status", { status: "REJECTED", comment: "Confirm department first" }, undefined, id);
  assert.equal(rejected.statusCode, 200);
  assert.equal(harness.state().comments.length, 2);
  assert.equal(harness.state().comments[1].event_type, "REJECTION");
  assert.equal(harness.state().comments[1].actor_login_id, "admin");
  const own = await harness.request("GET", "/api/me/register-comments", {}, { id });
  assert.equal(own.body.comments.length, 2);
  assert.equal(own.body.comments[0].comment, "Confirm department first");
  assert.equal(own.body.organization.company, "Default");
  harness.state().failComment = true;
  const failed = await harness.request("PUT", "/api/admin/users/:id/status", { status: "APPROVED" }, undefined, id);
  assert.equal(failed.statusCode, 500);
  assert.equal(harness.state().users.at(-1).status, "REJECTED");
  assert.equal(harness.state().comments.length, 2);
});

test("organization startup archives mismatched profile snapshots and drops legacy organization columns once", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureOrganizationGroupCode()");
  const end = source.indexOf("async function ensurePermissionPolicy()", start);
  const profileColumns = new Set(["organization_id", "region", "company", "position"]);
  let foreignKey = true;
  let archivedRows = 0;
  let droppedColumns = 0;
  let nullableCodes = false;
  let nullableUpdates = 0;
  let masterOrganizations = 0;
  const calls = [];
  const context = vm.createContext({ ensureSignupOrganizationCodes: async () => {}, query: async sql => {
    calls.push(sql);
    if (sql.includes("COLUMN_TYPE AS column_type") && sql.includes("TABLE_NAME='company_organization'")) return ["company", "site", "department", "job"].map(column_name => ({ column_name, column_type: "char(3)", is_nullable: nullableCodes ? "YES" : "NO" }));
    if (sql.startsWith("ALTER TABLE company_organization MODIFY COLUMN")) {
      for (const field of ["company", "site", "department", "job"]) assert.ok(sql.includes(`MODIFY COLUMN \`${field}\` char(3) NULL`));
      nullableCodes = true;
      nullableUpdates++;
      return {};
    }
    if (sql.startsWith("INSERT INTO company_organization (group_code,group_name) SELECT")) {
      assert.match(sql, /WHERE NOT EXISTS .*company IS NULL AND site IS NULL AND department IS NULL AND job IS NULL/);
      if (!masterOrganizations) masterOrganizations++;
      return {};
    }
    if (sql.startsWith("SELECT COLUMN_NAME AS column_name") && sql.includes("TABLE_NAME='company_organization'")) return ["group_code", "job", "job_name"].map(column_name => ({ column_name }));
    if (sql.startsWith("SHOW COLUMNS")) return profileColumns.has("organization_id") ? [{ Field: "organization_id" }] : [];
    if (sql.startsWith("SELECT CONSTRAINT_NAME")) return foreignKey ? [{ CONSTRAINT_NAME: "fk_user_profile_organization" }] : [];
    if (sql.startsWith("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS")) return ["region", "company", "position"].filter(column => profileColumns.has(column)).map(column_name => ({ column_name }));
    if (sql.startsWith("SELECT TABLE_NAME AS table_name")) return [{ table_name: "user_register_comment" }];
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS user_profile_organization_legacy")) return {};
    if (sql.startsWith("INSERT IGNORE INTO user_profile_organization_legacy")) { assert.match(sql, /LEFT JOIN company_organization/); archivedRows++; return {}; }
    if (sql.startsWith("ALTER TABLE user_profile DROP COLUMN")) { for (const [, field] of sql.matchAll(/DROP COLUMN `([^`]+)`/g)) profileColumns.delete(field); droppedColumns++; return {}; }
    if (sql.startsWith("INSERT INTO company_organization")) assert.match(sql, /ON DUPLICATE KEY UPDATE organization_id=organization_id$|WHERE NOT EXISTS/);
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS user_register_comment")) return {};
    return {};
  } });
  vm.runInContext(source.slice(start, end), context);
  for (let run = 0; run < 2; run++) { await context.ensureOrganizationSchema(); await context.ensureRegistrationSchema(); }
  assert.equal(archivedRows, 1);
  assert.equal(droppedColumns, 1);
  assert.equal(nullableUpdates, 1);
  assert.equal(masterOrganizations, 1);
  assert.deepEqual([...profileColumns], ["organization_id"]);
  assert.ok(calls.every(sql => !/UPDATE user_profile SET|DELETE FROM user_profile|DROP TABLE/.test(sql)));
  assert.ok(calls.some(sql => sql.includes("SELECT 'ZZZ','KIMS' WHERE NOT EXISTS") && sql.includes("company IS NULL AND site IS NULL AND department IS NULL AND job IS NULL")));
  const history = calls.find(sql => sql.startsWith("CREATE TABLE IF NOT EXISTS user_register_comment"));
  assert.equal((history.match(/ON DELETE SET NULL/g) || []).length, 2);
});

test("comment table rename preserves existing rows, runs once and rejects ambiguous duplicate tables", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function ensureRegistrationSchema()");
  const end = source.indexOf("async function ensurePermissionPolicy()", start);
  const scenarios = [
    ["register_comment"], ["user-register_comment"], ["user_register_comment"], [],
    ["register_comment", "user_register_comment"], ["user-register_comment", "user_register_comment"],
    ["register_comment", "user-register_comment"]
  ];
  for (const initial of scenarios) {
    const tables = new Set(initial);
    const history = [{ comment_id: 1, comment: "original application" }, { comment_id: 2, comment: "original rejection" }];
    const snapshot = JSON.stringify(history);
    let renames = 0;
    let enumUpdates = 0;
    let requestColumnUpdates = 0;
    let hasCurrentEvents = initial[0] === "user_register_comment";
    let hasRequestColumn = false;
    const context = vm.createContext({ ensureSignupOrganizationCodes: async () => {}, query: async sql => {
      if (sql === "SHOW COLUMNS FROM user_profile LIKE 'organization_id'") return [{ Field: "organization_id" }];
      if (sql.startsWith("SELECT CONSTRAINT_NAME")) return [{ CONSTRAINT_NAME: "fk_user_profile_organization" }];
      if (sql.startsWith("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS")) return [];
      if (sql.startsWith("SELECT TABLE_NAME AS table_name")) return [...tables].map(table_name => ({ table_name }));
      if (sql.startsWith("RENAME TABLE")) {
        const oldName = sql.includes("`register_comment` TO") ? "register_comment" : "user-register_comment";
        assert.equal(sql, `RENAME TABLE ${oldName === "register_comment" ? "`register_comment`" : "`user-register_comment`"} TO user_register_comment`);
        tables.delete(oldName); tables.add("user_register_comment"); renames++;
      }
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS user_register_comment")) {
        if (!tables.has("user_register_comment")) { hasCurrentEvents = true; hasRequestColumn = true; }
        tables.add("user_register_comment");
      }
      if (sql === "SHOW COLUMNS FROM user_register_comment LIKE 'event_type'") return [{ Type: hasCurrentEvents ? "enum('APPLICATION','REAPPLICATION','STATUS','LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST','WITHDRAWAL_REQUEST','WITHDRAWAL_REJECTION','WITHDRAWAL_APPROVAL','DELETION')" : initial[0] === "user_register_comment" ? "enum('APPLICATION','REAPPLICATION','STATUS','LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST','WITHDRAWAL_REQUEST')" : "enum('APPLICATION','STATUS')" }];
      if (sql.startsWith("ALTER TABLE user_register_comment MODIFY COLUMN event_type")) {
        assert.match(sql, /'WITHDRAWAL_REQUEST','WITHDRAWAL_REJECTION','WITHDRAWAL_APPROVAL','DELETION'/);
        hasCurrentEvents = true; enumUpdates++; return {};
      }
      if (sql === "SHOW COLUMNS FROM user_register_comment LIKE 'request_comment_id'") return hasRequestColumn ? [{ Field: "request_comment_id" }] : [];
      if (sql.startsWith("ALTER TABLE user_register_comment ADD COLUMN request_comment_id")) { hasRequestColumn = true; requestColumnUpdates++; return {}; }
      return {};
    } });
    vm.runInContext(source.slice(start, end), context);
    const ambiguous = initial.includes("register_comment") && initial.includes("user-register_comment")
      || initial.includes("user_register_comment") && initial.some(name => name !== "user_register_comment");
    if (ambiguous) {
      await assert.rejects(context.ensureRegistrationSchema(), /여러 개/);
      assert.equal(renames, 0);
      assert.equal(enumUpdates, 0);
      assert.equal(requestColumnUpdates, 0);
      assert.deepEqual([...tables], initial);
    } else {
      await context.ensureRegistrationSchema();
      await context.ensureRegistrationSchema();
      assert.equal(renames, initial.some(name => name === "register_comment" || name === "user-register_comment") ? 1 : 0);
      assert.deepEqual([...tables], ["user_register_comment"]);
      assert.equal(hasCurrentEvents, true);
      assert.equal(enumUpdates, initial.length && initial[0] !== "user_register_comment" ? 1 : 0);
      assert.equal(requestColumnUpdates, initial.length ? 1 : 0);
    }
    assert.equal(JSON.stringify(history), snapshot);
  }
});

test("company registration is available to signup matching and duplicate or reserved combinations are rejected", async () => {
  const harness = createRegistrationHarness();
  const duplicateSibling = registration.validateOrganizationNameHierarchy({
    codes: { group: "GRP", company: "NEW", site: "ST2", department: null, role: null },
    names: { group_name: "Group", company_name: "Verified company", site_name: "Second site", department_name: null, role_name: null }
  }, harness.state().organizations);
  assert.match(duplicateSibling.error, /같은 상위 조직의 다른 코드/);
  const mismatchedCodeName = registration.validateOrganizationNameHierarchy({
    codes: { ...harness.known, site: "ST2" },
    names: { group_name: "Forged group", company_name: "Verified company", site_name: "Second site", department_name: null, role_name: null }
  }, harness.state().organizations);
  assert.match(mismatchedCodeName.error, /이미 다른 명칭/);
  assert.deepEqual(registration.validateOrganizationNameHierarchy({
    codes: { group: "GRP", company: "NEW", site: "ST2", department: null, role: null },
    names: { group_name: "Group", company_name: "New company", site_name: "Second site", department_name: null, role_name: null }
  }, harness.state().organizations), {});
  const duplicateSiblingName = await harness.request("POST", "/api/admin/companies", {
    codes: { group: "GRP", company: "NEW", site: "ST2" },
    names: { group_name: "Group", company_name: "Verified company", site_name: "Second site" }
  });
  assert.equal(duplicateSiblingName.statusCode, 409, JSON.stringify(duplicateSiblingName.body));
  assert.equal(harness.state().organizations.length, 2);
  const mismatchedExistingName = await harness.request("POST", "/api/admin/companies", {
    codes: { ...harness.known, site: "ST2" },
    names: { group_name: "Forged group", company_name: "Verified company", site_name: "Second site", department_name: "Production", role_name: "Operator" }
  });
  assert.equal(mismatchedExistingName.statusCode, 409);
  const body = { codes: { group: "NEW", company: "CMP", site: "S02", department: "D01", role: "R01" }, names: { group_name: "New group", company_name: "New company", site_name: "New site", department_name: "Production", role_name: "Operator" } };
  const result = await harness.request("POST", "/api/admin/companies", body);
  assert.equal(result.statusCode, 201);
  const duplicate = await harness.request("POST", "/api/admin/companies", body);
  assert.equal(duplicate.statusCode, 409);
  const lookup = await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: body.codes });
  assert.equal(lookup.body.organization.company, "New company");
  assert.equal(lookup.body.organization.department, "Production");
  assert.equal(lookup.body.organization.position, "Operator");
  assert.equal((await harness.request("POST", "/api/register/organization", {
    organizationUnknown: false,
    organization: { ...body.codes, role: "R02" }
  })).statusCode, 404);
  const reserved = await harness.request("POST", "/api/admin/companies", { ...body, codes: Object.fromEntries(registration.COMPANY_ORGANIZATION_CODES.map(field => [field, "DEF"])) });
  assert.equal(reserved.statusCode, 400);
  const list = await harness.request("GET", "/api/admin/companies");
  assert.equal(list.body.organizations.length, 3);
  assert.equal(list.body.organizations[0].is_default, true);
  assert.equal(policy.requestPermission("GET", "/api/admin/companies"), "company_admin");
  assert.equal(policy.canUseFeature({ status: "APPROVED", permissionLevel: 15 }, "company_admin"), false);
  assert.equal(policy.canUseFeature({ status: "APPROVED", permissionLevel: 16 }, "company_admin"), true);
});

test("company registration stores omitted code and name pairs as NULL and requires the group", async () => {
  const expectedCodes = { group: "NEW", company: null, site: null, department: null, role: null };
  const expectedNames = { group_name: "New group", company_name: null, site_name: null, department_name: null, role_name: null };
  assert.deepEqual(registration.validateOrganizationRecord({ codes: { group: "new" }, names: { group_name: "New group" } }), { codes: expectedCodes, names: expectedNames, is_active: true });
  assert.deepEqual(registration.validateOrganizationRecord({
    codes: { group: "GRP", company: "COM" },
    names: { group_name: "Group", company_name: "Company" }
  }), {
    codes: { group: "GRP", company: "COM", site: null, department: null, role: null },
    names: { group_name: "Group", company_name: "Company", site_name: null, department_name: null, role_name: null },
    is_active: true
  });
  assert.deepEqual(registration.validateOrganizationRecord({
    codes: { group: "GRP", company: "COM", site: "DEF", department: "DEF", role: "DEF" },
    names: { group_name: "Group", company_name: "Company", site_name: "미지정", department_name: "미지정", role_name: "미지정" }
  }), {
    codes: { group: "GRP", company: "COM", site: "DEF", department: "DEF", role: "DEF" },
    names: { group_name: "Group", company_name: "Company", site_name: "미지정", department_name: "미지정", role_name: "미지정" },
    is_active: true
  });
  assert.match(registration.validateOrganizationRecord({ codes: { company: "COM" }, names: { company_name: "Company" } }).error, /그룹 코드와 그룹 이름은 필수/);
  assert.equal(registration.validateOrganizationRecord({ codes: { group: "NEW", site: "S01" }, names: { group_name: "New group", site_name: "Site" } }).error, undefined);
  assert.equal(registration.validateOrganizationRecord({
    codes: { group: "GRP", company: "COM", site: "DEF", department: "D02" },
    names: { group_name: "Group", company_name: "Company", site_name: "미지정", department_name: "Second department" }
  }).codes.department, "D02");
  assert.match(registration.validateOrganizationRecord({ codes: { group: "NEW", company: "CMP" }, names: { group_name: "New group", company_name: "미지정" } }).error, /명칭을 미지정으로 등록할 수 없습니다/);

  const harness = createRegistrationHarness();
  const partialSuffix = await harness.request("POST", "/api/admin/companies", {
    codes: { group: "PAR", company: "COM" },
    names: { group_name: "Partial group", company_name: "Partial company" }
  });
  assert.equal(partialSuffix.statusCode, 201);
  assert.deepEqual(Object.fromEntries(registration.ORGANIZATION_CODES.map(field => [field, harness.state().organizations.at(-1)[field]])), {
    group: "PAR", company: "COM", site: null, department: null, role: null
  });
  assert.deepEqual(Object.fromEntries(registration.ORGANIZATION_CODES.map(field => [`${field}_name`, harness.state().organizations.at(-1)[`${field}_name`]])), {
    group_name: "Partial group", company_name: "Partial company", site_name: null, department_name: null, role_name: null
  });
  const normalizedSuffix = await harness.request("POST", "/api/admin/companies", {
    codes: { group: "AUT", company: "CMP", site: "DEF", department: "DEF", role: "DEF" },
    names: { group_name: "Automatic group", company_name: "Automatic company", site_name: "미지정", department_name: "미지정", role_name: "미지정" }
  });
  assert.equal(normalizedSuffix.statusCode, 201);
  assert.equal(harness.state().organizations.at(-1).department, "DEF");
  assert.equal(harness.state().organizations.at(-1).role, "DEF");
  const result = await harness.request("POST", "/api/admin/companies", { codes: { group: "NEW" }, names: { group_name: "New group" } });
  assert.equal(result.statusCode, 201);
  assert.deepEqual(Object.fromEntries(registration.ORGANIZATION_CODES.map(field => [field, harness.state().organizations.at(-1)[field]])), expectedCodes);
  assert.deepEqual(Object.fromEntries(registration.ORGANIZATION_CODES.map(field => [`${field}_name`, harness.state().organizations.at(-1)[`${field}_name`]])), expectedNames);
  const organizationId = harness.state().organizations.at(-1).organization_id;
  const duplicate = await harness.request("POST", "/api/admin/companies", { codes: expectedCodes, names: expectedNames });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(harness.state().organizations.length, 5);
  const edited = await harness.request("PUT", "/api/admin/companies/:id", { codes: expectedCodes, names: { ...expectedNames, group_name: "Renamed group" }, is_active: false }, undefined, organizationId);
  assert.equal(edited.statusCode, 200);
  const saved = harness.state().organizations.at(-1);
  for (const field of ["company", "site", "department", "role"]) {
    assert.equal(saved[field], null);
    assert.equal(saved[`${field}_name`], null);
  }
  const skipped = await harness.request("POST", "/api/admin/companies", { codes: { group: "GAP", site: "S01" }, names: { group_name: "Gap group", site_name: "Site" } });
  assert.equal(skipped.statusCode, 201);
  assert.equal(harness.state().organizations.at(-1).company, null);
  for (const body of [
    { codes: { company: "COM" }, names: { company_name: "Company" } },
    { codes: { group: "NEW", company: "COM" }, names: { group_name: "New group" } },
    { codes: { group: "NEW" }, names: { group_name: "New group", company_name: "Company" } }
  ]) assert.ok(registration.validateOrganizationRecord(body).error);
});

test("company browser submits NULL code and name pairs and preserves them when toggling", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "user-company.js"), "utf8");
  const fields = registration.COMPANY_ORGANIZATION_CODES;
  const suffixes = ["Group", "Company", "Site", "Department", "Role"];
  const inputs = new Map(suffixes.flatMap(suffix => [[`companyCode${suffix}`, { value: " " }], [`companyName${suffix}`, { value: " " }]]));
  inputs.get("companyCodeGroup").value = "new";
  inputs.get("companyNameGroup").value = "New group";
  let submit;
  const requests = [];
  const messages = [];
  const context = vm.createContext({
    companyFields: fields, companySuffixes: suffixes, companyLabels: ["그룹", "회사", "사업장", "부서", "직무"],
    companyBusy: false, companyEditingId: null, companyOrganizations: [],
    document: { getElementById: id => inputs.get(id) },
    companyElements: { companyForm: { addEventListener: (event, handler) => { assert.equal(event, "submit"); submit = handler; } }, companyActive: { checked: true } },
    companyMessage: message => messages.push(message), companySetBusy() {}, companyReset() {}, companyLoad: async () => {},
    companyRequest: async (url, options) => { requests.push(JSON.parse(options.body)); }
  });
  vm.runInContext(source.slice(source.indexOf("function companyPayload("), source.indexOf('companyElements.companyRows.addEventListener("click"')), context);
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  for (const field of fields.slice(1)) {
    assert.equal(requests[0].codes[field], null);
    assert.equal(requests[0].names[`${field}_name`], null);
  }
  const row = { ...requests[0].codes, ...requests[0].names, is_active: 1 };
  const payload = context.companyPayload(row);
  for (const field of fields.slice(1)) assert.equal(payload.names[`${field}_name`], null);
  inputs.get("companyCodeSite").value = "S01";
  inputs.get("companyNameSite").value = "Site";
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].codes.company, null);
  assert.equal(requests[1].codes.site, "S01");
  inputs.get("companyCodeGroup").value = "";
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.match(messages.at(-1), /그룹/);
});

test("organization schema makes suffix names nullable once without changing data or column lengths", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const fields = ["company", "site", "department", "job", "company_name", "site_name", "department_name", "job_name"];
  const columns = fields.map(field => ({ column_name: field, column_type: field.endsWith("_name") ? "varchar(40)" : "char(3)", is_nullable: "NO" }));
  const rows = [{ group_code: "OLD", company: "DEF", company_name: "미지정" }];
  const snapshot = JSON.stringify(rows);
  const changes = [];
  const personalOrganizationMigrations = [];
  const context = vm.createContext({ ensureOrganizationGroupCode: async () => {}, ensureOrganizationJobColumns: async () => {}, query: async sql => {
    if (sql.startsWith("CREATE TABLE")) {
      for (const field of fields.filter(field => field.endsWith("_name"))) assert.match(sql, new RegExp(`${field} VARCHAR\\(\\d+\\) NULL DEFAULT NULL`));
      return {};
    }
    if (sql.startsWith("SELECT COLUMN_NAME")) {
      for (const field of fields) assert.ok(sql.includes(`'${field}'`));
      return columns;
    }
    if (sql.startsWith("ALTER TABLE")) {
      changes.push(sql);
      for (const column of columns) {
        assert.ok(sql.includes(`MODIFY COLUMN \`${column.column_name}\` ${column.column_type} NULL`));
        column.is_nullable = "YES";
      }
      return {};
    }
    if (sql.startsWith("UPDATE company_organization SET group_code='001'")) {
      personalOrganizationMigrations.push(sql);
      return {};
    }
    if (sql.startsWith("INSERT INTO company_organization")) return {};
    assert.fail(`Unexpected schema SQL: ${sql}`);
  } });
  vm.runInContext(source.slice(source.indexOf("async function ensureOrganizationSchema()"), source.indexOf("async function ensureRegistrationSchema()")), context);
  await context.ensureOrganizationSchema();
  await context.ensureOrganizationSchema();
  assert.equal(changes.length, 1);
  assert.equal(personalOrganizationMigrations.length, 2);
  assert.match(personalOrganizationMigrations[0], /department=NULL,job=NULL/);
  assert.equal(JSON.stringify(rows), snapshot);
});

test("company editing preserves code identity and disabling blocks future signup matching", async () => {
  const harness = createRegistrationHarness();
  const names = { group_name: "Group", company_name: "Renamed company", site_name: "Factory", department_name: "Production", role_name: "Operator" };
  const defaultEdit = await harness.request("PUT", "/api/admin/companies/:id", { codes: harness.known, names }, undefined, 1);
  assert.equal(defaultEdit.statusCode, 403);
  const wrongCodes = await harness.request("PUT", "/api/admin/companies/:id", { codes: { ...harness.known, site: "NEW" }, names }, undefined, 2);
  assert.equal(wrongCodes.statusCode, 409);
  const edited = await harness.request("PUT", "/api/admin/companies/:id", { codes: harness.known, names, is_active: false }, undefined, 2);
  assert.equal(edited.statusCode, 200);
  assert.equal(harness.state().organizations[1].company_name, "Renamed company");
  assert.equal(harness.state().organizations[1].site, "ST1");
  assert.equal((await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: harness.known })).statusCode, 404);
  assert.equal((await harness.request("PUT", "/api/admin/companies/:id", { codes: harness.known, names, is_active: true }, undefined, 2)).statusCode, 200);
  assert.equal((await harness.request("POST", "/api/register/organization", { organizationUnknown: false, organization: harness.known })).body.organization.company, "Renamed company");
});

test("unapproved applicants can cancel and delete their profile while retaining append-only history", async () => {
  const harness = createRegistrationHarness();
  for (const [username, status, expectedStatus] of [["cancel_pending", "PENDING", 200], ["cancel_rejected", "REJECTED", 200], ["cancel_approved", "APPROVED", 400]]) {
    const created = await harness.request("POST", "/api/register", harness.application({ username }));
    assert.equal(created.statusCode, 201);
    const applicant = harness.state().users.at(-1);
    applicant.status = status;
    const response = await harness.request("POST", "/api/me/cancel-registration", {}, { id: applicant.id, username, status });
    assert.equal(response.statusCode, expectedStatus);
    if (expectedStatus === 200) {
      assert.equal(harness.state().users.some(user => user.id === applicant.id), false);
      const history = harness.state().comments.filter(comment => comment.login_id === username);
      assert.equal(history.length, 2);
      assert.equal(history[1].event_type, "STATUS");
      assert.equal(history[1].user_id, null);
    } else assert.equal(harness.state().users.some(user => user.id === applicant.id), true);
  }
});

test("address persists through signup, self profile edits and administrator edits", async () => {
  const address = "서울시 중구 테스트로 1";
  const signup = createRegistrationHarness();
  const application = await signup.request("POST", "/api/register", signup.application({ username: "address_user", address }));
  assert.equal(application.statusCode, 201);
  assert.equal(signup.state().users.at(-1).address, address);

  const profile = createRegistrationHarness();
  const profileSave = await profile.request("PUT", "/api/me", { name: "Admin", phone: "", address, email: "" });
  assert.equal(profileSave.statusCode, 200, JSON.stringify({ body: profileSave.body, errors: profile.errors().map(args => args.map(value => String(value?.stack || value))) }));
  assert.equal(profile.state().users[0].address, address);
  assert.equal(profileSave.body.user.address, address);

  const admin = createRegistrationHarness();
  admin.state().users.push({ id: 2, username: "member_02", name: "Member", phone: null, address, email: null, organization_id: null, permission_level: 4, role: "USER", status: "APPROVED" });
  const listed = await admin.request("GET", "/api/admin/users");
  assert.equal(listed.body.find(user => user.id === 2).address, address);
  const adminSave = await admin.request("PUT", "/api/admin/users/:id", { name: "Member", organizationId: 1, phone: "", address, email: "", permissionLevel: 4, adminMemo: "", password: "" }, undefined, 2);
  assert.equal(adminSave.statusCode, 200);
  assert.equal(admin.state().users[1].address, address);
});