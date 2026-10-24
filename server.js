// 서버 진입점: 환경 설정 -> 인증/권한 -> 업무 API -> 장치 통신 -> DB 초기화 순서로 구성합니다.
require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mariadb = require("mariadb");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const path = require("path");
const { loadDeviceReport, createReportWorkbook } = require("./device-report");
const { loadProductReport, ensureProductHistory, createProductWorkbook } = require("./product-report");
const { validateQuantityEdit, parseQuantity, parseQuantityReason } = require("./product-quantity");
const { sealDeviceToken, openDeviceToken } = require("./device-token");
const { ORGANIZATION_CODES: registrationOrganizationCodes, parseOrganizationSelection, validateOrganizationRecord, validateOrganizationNameHierarchy, validateRegisterComment, organizationProfile } = require("./registration");
const { MAX_PERMISSION_LEVEL, MAX_SITE_PERMISSION_LEVEL, MIN_PROGRAMMER_LEVEL, APPROVAL_OVERRIDE_LEVEL, FEATURES, defaultPermissionPolicy, validatePermissionPolicy, permissionLevel, userManagementLevel, canUseFeature, userPermissionSnapshot, requestPermission, legacyPermissionLevel, permissionSiteName, permissionPolicySites, policyFromSiteRows, sitePolicyRevision } = require("./level-permissions");

let permissionPolicy = defaultPermissionPolicy();
let permissionPolicySitesCache = permissionPolicySites();
let permissionPolicyRevision = sitePolicyRevision(permissionPolicySitesCache);

const app = express();
app.set("json replacer", (key, value) => typeof value === "bigint" ? value.toString() : value);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 8080);
const DB_CLIENT = String(process.env.DB_CLIENT || "mysql").toLowerCase();
const SESSION_COOKIE = "factory_session";
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const KOREA_TIME_OFFSET_MS = 9 * 60 * 60 * 1000;

function toKoreaDateTime(date = new Date()) {
  return new Date(date.getTime() + KOREA_TIME_OFFSET_MS)
    .toISOString()
    .slice(0, 23)
    .replace("T", " ");
}

async function ensureSignupOrganizationCodes() {
  for (const [column, after] of [["signup_department_code", "organization_id"], ["signup_role_code", "signup_department_code"]]) {
    const columns = await query(`SHOW COLUMNS FROM user_profile LIKE '${column}'`);
    if (!columns.length) await query(`ALTER TABLE user_profile ADD COLUMN ${column} CHAR(3) NULL AFTER ${after}`);
  }
  const indexes = await query("SELECT INDEX_NAME AS index_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_profile' AND INDEX_NAME='uq_user_profile_signup_codes'");
  if (!indexes.length) await query("ALTER TABLE user_profile ADD UNIQUE KEY uq_user_profile_signup_codes (signup_department_code,signup_role_code)");
  await query("UPDATE user_profile u LEFT JOIN company_organization o ON o.organization_id=u.organization_id SET u.signup_department_code=NULL,u.signup_role_code=NULL WHERE (o.organization_id IS NULL OR NOT (o.group_code <=> '001' AND o.company <=> '001' AND o.site <=> '001' AND o.department IS NULL AND o.job IS NULL)) AND (u.signup_department_code IS NOT NULL OR u.signup_role_code IS NOT NULL)");
  const users = await query("SELECT u.user_id FROM user_profile u JOIN company_organization o ON o.organization_id=u.organization_id WHERE o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL AND (u.signup_department_code IS NULL OR u.signup_role_code IS NULL) ORDER BY u.user_id");
  for (const user of users) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const codes = generateSignupOrganizationCodes();
      try {
        await query("UPDATE user_profile SET signup_department_code=?,signup_role_code=? WHERE user_id=? AND (signup_department_code IS NULL OR signup_role_code IS NULL)", [codes.department, codes.role, user.user_id]);
        break;
      } catch (error) {
        const duplicatePersonalCodes = error.code === "ER_DUP_ENTRY" && /uq_user_profile_signup_codes/i.test(String(error.sqlMessage || error.message));
        if (!duplicatePersonalCodes || attempt === 4) throw error;
      }
    }
  }
}

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "factory",
  connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
  dateStrings: true,
  timezone: "+09:00"
};

if (!["mysql", "mariadb"].includes(DB_CLIENT)) {
  throw new Error("DB_CLIENT는 mysql 또는 mariadb여야 합니다.");
}

const pool = DB_CLIENT === "mariadb" ? mariadb.createPool(dbConfig) : mysql.createPool(dbConfig);
const sessions = new Map();
const clients = new Set();
const INITIAL_MASTER_PASSWORD = String(process.env.MASTER_PASSWORD || "");

// 기본 장치의 인증 설정과 다중 장치 소켓을 준비합니다. 각 장치의 상태는 16채널로 관리합니다.
const DEVICE_ID = String(process.env.DEVICE_ID || process.env.DIVICE_ID || process.env.DEVICE_DEVICE_ID || process.env.WEMOS_DEVICE_ID || "DEVICE-D1-001");
const DEVICE_TOKEN = String(process.env.DEVICE_TOKEN || process.env.DEVICE_DEVICE_TOKEN || process.env.WEMOS_DEVICE_TOKEN || "");
const deviceDeviceSockets = new Map();
// 기존 단일 장치 코드와의 호환을 위해 유지합니다. 실제 다중 장치 통신은 Map을 사용합니다.
let deviceDeviceSocket = null;

app.use(express.json({ limit: "100kb" }));
// 이전 주소도 새 경로의 인증·권한·캐시 정책을 거치도록 라우팅 전에 정규화합니다.
function normalizeLegacyDeviceUrl(req, res, next) {
  const legacyPage = new RegExp(`^/${LEGACY_DEVICE_PREFIX}(?=[.-])`);
  const legacyApi = new RegExp(`^(/api/(?:admin/)?)${LEGACY_DEVICE_PREFIX}(?=/|\\?|$)`);
  const updatedUrl = req.url.replace(legacyPage, "/device").replace(legacyApi, "$1device")
    .replace(/^\/device\.(html|js)(?=\?|$)/, "/device-control.$1")
    .replace(/^\/device-active-devices\.js(?=\?|$)/, "/device-active.js");
  if (updatedUrl !== req.url) {
    if (req.method === "GET" && new RegExp(`^/device(?:-control|-view|-admin)\\.html(?:\\?|$)`).test(updatedUrl)) {
      return res.redirect(302, updatedUrl);
    }
    req.url = updatedUrl;
  }
  next();
}
app.use(normalizeLegacyDeviceUrl);
app.use(["/device-control.html", "/device-view.html", "/device-admin.html", "/device_schedule.html", "/device-schedule.js", "/device-control.js", "/device-view.js", "/device-admin.js", "/device-active.js", "/user-register.html", "/user-register.js", "/register", "/register.html"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return DB_CLIENT === "mariadb" ? result : result[0];
}

async function connectionQuery(connection, sql, params = []) {
  const result = await connection.query(sql, params);
  return DB_CLIENT === "mariadb" ? result : result[0];
}

// ---------------------------------------------------------
// 보안/입력 검증
// ---------------------------------------------------------
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^01[0-9]\d{7,8}$/.test(digits)) return null;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254) return null;
  // 일반적인 이메일 형식을 제한합니다. 실제 메일 발송/존재 여부는 별도 인증 대상입니다.
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email)) return null;
  return email;
}

function validateProfile(body, { passwordRequired = true } = {}) {
  const name = String(body.name || "").trim();
  const username = String(body.username || "").trim();
  const phoneInput = String(body.phone || "").trim();
  const addressInput = String(body.address || "").trim();
  const emailInput = String(body.email || "").trim();
  const phone = phoneInput ? normalizePhone(phoneInput) : null;
  const address = addressInput || null;
  const email = emailInput ? normalizeEmail(emailInput) : null;
  const password = String(body.password || "");

    if (!/^[A-Za-z0-9_]{4,50}$/.test(username)) return { error: "아이디는 영문, 숫자, _만 사용하여 4~50자로 입력하세요.", field: "username" };
    if (name.length > 100) return { error: "이름은 100자 이내로 입력하세요.", field: "name" };
    if (phoneInput && !phone) return { error: "전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678", field: "phone" };
    if (addressInput.length > 255) return { error: "주소는 255자 이내로 입력하세요.", field: "address" };
    if (emailInput && !email) return { error: "이메일 주소 형식이 올바르지 않습니다. 예: user@example.com", field: "email" };
    if (passwordRequired && (password.length < 4 || password.length > 100)) return { error: "비밀번호는 4~100자로 입력하세요.", field: "password" };
    if (!passwordRequired && password && (password.length < 4 || password.length > 100)) return { error: "새 비밀번호는 4~100자로 입력하세요.", field: "password" };

  return { name, username, phone, address, email, password };
}

async function hasDuplicateProfilePhone(phone, userId, run = query) {
  if (!phone) return false;
  const exclusion = userId == null ? "" : " AND user_id<>?";
  const params = userId == null ? [phone] : [phone, userId];
  const rows = await run("SELECT user_id AS id FROM user_profile WHERE phone=?" + exclusion + " LIMIT 1", params);
    return rows.length > 0;
}

  function profileUniqueViolationField(error) {
    const detail = String(error?.sqlMessage || error?.message || "");
    if (detail.includes("uq_user_profile_phone")) return "phone";
    if (detail.includes("uq_user_profile_email")) return "email";
    if (detail.includes("login_id")) return "username";
    return undefined;
  }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash).split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const storedKey = Buffer.from(parts[2], "hex");
    const derivedKey = crypto.scryptSync(password, parts[1], 64);
    return storedKey.length === derivedKey.length && crypto.timingSafeEqual(storedKey, derivedKey);
  } catch { return false; }
}

// ---------------------------------------------------------
// 세션
// ---------------------------------------------------------
function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    user: {
      id: user.id, username: user.username, name: user.name,
      role: user.role, permissionLevel: Number(user.permission_level || (user.role === "MASTER" ? MAX_PERMISSION_LEVEL : 1)), status: user.status
    },
    expiresAt: Date.now() + SESSION_MAX_AGE
  });
  return token;
}

function getCookie(req, name) {
  for (const item of (req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (key === name) return decodeURIComponent(item.slice(index + 1).trim());
  }
  return null;
}

function getSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_MAX_AGE;
  return { token, ...session };
}

function getPermissionLevel(user) {
  return Number(user?.permissionLevel || user?.permission_level || (user?.role === "MASTER" ? MAX_PERMISSION_LEVEL : 1));
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireLogin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    if (req.path.startsWith("/api/") || req.path === "/ws") return res.status(401).json({ error: "로그인이 필요합니다.", code: "LOGIN_REQUIRED" });
    return res.redirect("/user-login.html");
  }
  req.user = session.user;
  req.sessionToken = session.token;
  next();
}

function requireApproved(req, res, next) {
  if (req.user.status !== "APPROVED" && getPermissionLevel(req.user) < APPROVAL_OVERRIDE_LEVEL) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "관리자 승인 완료 후 이용할 수 있습니다.", code: "APPROVAL_REQUIRED" });
    return res.redirect("/user-profile.html?pending=1");
  }
  next();
}

// 최신 DB 상태를 확인합니다. 삭제 계정은 로그아웃하고 정지 계정은 세션을 유지한 채 회원정보로 제한합니다.
async function requireActiveAccount(req, res, next) {
  try {
    const rows = await query("SELECT user_status AS status,permission_level,role FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) {
      if (req.sessionToken) sessions.delete(req.sessionToken);
      clearSessionCookie(res);
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "회원 정보를 찾을 수 없습니다.", code: "ACCOUNT_NOT_FOUND" });
      return res.redirect("/user-login.html");
    }
    req.user.status = rows[0].status;
    req.user.permissionLevel = Number(rows[0].permission_level ?? req.user.permissionLevel ?? 1);
    if (rows[0].role) req.user.role = rows[0].role;
    if (rows[0].status === "SUSPENDED") {
      // 정지된 계정은 로그아웃시키지 않고 회원정보 화면으로만 접근을 제한합니다.
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: "사용이 정지된 계정입니다. 회원정보 화면에서만 이용할 수 있습니다.", code: "SUSPENDED", redirect: "/user-profile.html?pending=1" });
      return res.redirect("/user-profile.html?pending=1");
    }
    next();
  } catch (err) { console.error("계정 상태 확인 오류:", err); res.status(500).json({ error: "계정 상태 확인 중 오류가 발생했습니다." }); }
}

function requireAdminLevel(minimumLevel = 8) {
  return (req, res, next) => {
    const requirement = requestPermission(req.method || "GET", req.path, req.query);
    const keys = requirement ? [].concat(requirement) : [];
    const requiredLevel = keys.length ? Math.min(...keys.map(key => permissionPolicy[key])) : legacyPermissionLevel(minimumLevel);
    const allowed = keys.length ? keys.some(key => canUseFeature(req.user, key, permissionPolicy)) : getPermissionLevel(req.user) >= requiredLevel;
    if (!req.user || !allowed) {
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: `${requiredLevel}레벨 이상 권한이 필요합니다.`, code: "ADMIN_REQUIRED" });
      return res.redirect("/user-profile.html?access=denied");
    }
    next();
  };
}

function requireMaster(req, res, next) {
  if (!canUseFeature(req.user, "user_admin", permissionPolicy)) return res.status(403).json({ error: `${permissionPolicy.user_admin}레벨 이상 회원 관리 권한이 필요합니다.`, code: "ADMIN_REQUIRED" });
  next();
}

app.use((req, res, next) => {
  const requirement = requestPermission(req.method, req.path, req.query);
  if (!requirement) return next();
  return requireLogin(req, res, () => {
    if (requirement === "user_profile") return next();
    return requireActiveAccount(req, res, () => {
      const keys = [].concat(requirement);
      if (keys.some(key => canUseFeature(req.user, key, permissionPolicy))) return next();
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: "현재 레벨로 이용할 수 없는 업무입니다.", code: "ACCESS_DENIED" });
      return res.redirect("/user-profile.html?access=denied");
    });
  });
});

app.get("/user-level.html", requireLogin, requireActiveAccount, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "user-level.html"));
});

app.get("/user-company.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "user-company.html"));
});

function applyPermissionSiteRows(rows, notify = false) {
  const validated = policyFromSiteRows(rows);
  if (validated.error) throw new Error(validated.error);
  const previous = permissionPolicyRevision;
  permissionPolicy = validated.levels;
  permissionPolicySitesCache = rows;
  permissionPolicyRevision = sitePolicyRevision(rows);
  if (notify && previous !== permissionPolicyRevision) {
    for (const socket of clients) {
      socket.productionAuthorized = ["production_view", "production_input", "production_report", "product_admin", "product_channel_link"].some(key => canUseFeature(socket.factoryUser, key, permissionPolicy));
      if (!["device_view", "device_control", "User_customization", "device_schedule", "device_admin", "device_report"].some(key => canUseFeature(socket.factoryUser, key, permissionPolicy))) socket.deviceSubscriber = false;
    }
    broadcast({ type: "accessPolicyChanged" });
  }
}

app.get("/api/admin/level-permissions", requireLogin, requireActiveAccount, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!canUseFeature(req.user, "level_permissions", permissionPolicy)) return res.status(403).json({ error: "레벨 권한 페이지의 조회 권한이 없습니다." });
  try {
    const rows = await query("SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id");
    applyPermissionSiteRows(rows, true);
    res.json({ features: FEATURES.map(feature => ({ ...feature, level: rows.find(row => row.site_name === permissionSiteName(feature)).default_leble, site_name: permissionSiteName(feature) })), sites: rows, revision: permissionPolicyRevision, maxLevel: MAX_SITE_PERMISSION_LEVEL });
  } catch (error) { console.error("레벨 권한 조회 오류:", error); res.status(500).json({ error: "레벨 권한을 불러오지 못했습니다." }); }
});

app.put("/api/admin/level-permissions", requireLogin, requireActiveAccount, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!canUseFeature(req.user, "level_permissions", permissionPolicy)) return res.status(403).json({ error: "레벨 권한 페이지의 수정 권한이 없습니다." });
  const data = policyFromSiteRows(req.body?.sites);
  const revision = req.body?.revision;
  if (data.error || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) return res.status(400).json({ error: data.error || "설정 버전이 올바르지 않습니다." });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const rows = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id FOR UPDATE");
    if (sitePolicyRevision(rows) !== revision) {
      await connection.rollback();
      return res.status(409).json({ error: "다른 관리자가 변경했습니다. 다시 불러온 후 저장하세요." });
    }
    const existing = new Map(rows.map(row => [row.poicy_id, row]));
    if (rows.length !== req.body.sites.length || req.body.sites.some(site => existing.get(site.poicy_id)?.site_name !== site.site_name)) {
      await connection.rollback();
      return res.status(400).json({ error: "사이트 권한 ID가 일치하지 않습니다. 다시 불러오세요." });
    }
    for (const site of req.body.sites) {
      if (existing.get(site.poicy_id).permisson_lebel === site.permisson_lebel) continue;
      await connectionQuery(connection, "UPDATE site_permission_policy SET permisson_lebel=?,updated_by=?,updated_at=CURRENT_TIMESTAMP(6) WHERE poicy_id=? AND site_name=?", [site.permisson_lebel, req.user.id, site.poicy_id, site.site_name]);
    }
    const updated = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id");
    const validated = policyFromSiteRows(updated);
    if (validated.error) throw new Error(validated.error);
    await connection.commit();
    applyPermissionSiteRows(updated, true);
    res.json({ ok: true, sites: permissionPolicySitesCache, revision: permissionPolicyRevision });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("레벨 권한 저장 오류:", error);
    res.status(500).json({ error: "레벨 권한을 저장하지 못했습니다." });
  } finally { connection?.release(); }
});

// ---------------------------------------------------------
// 페이지
// ---------------------------------------------------------
app.get("/", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "product-view.html")));
app.get("/product-view.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "product-view.html")));
app.get("/index.html", (req, res) => res.redirect(302, `/product-view.html${req.url.slice(req.path.length)}`));
app.get("/control.html", (req, res) => res.redirect(302, `/product-control.html${req.url.slice(req.path.length)}`));
app.get("/product-control.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), (req, res) => res.sendFile(path.join(__dirname, "public", "product-control.html")));
app.get("/product-channel-link.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "product-channel-link.html")));
app.get("/product-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), (req, res) => res.sendFile(path.join(__dirname, "public", "product-admin.html")));
app.get("/product-report.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "product-report.html"));
});
app.get("/user-admin.html", requireLogin, requireActiveAccount, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "user-admin.html")));
app.get("/user-profile.html", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "user-profile.html")));
app.get("/user-setting.html", requireLogin, requireActiveAccount, (req, res) => res.sendFile(path.join(__dirname, "public", "user-setting.html")));
app.get("/device-control.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), (req, res) => res.sendFile(path.join(__dirname, "public", "device-control.html")));
app.get("/device-simple.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => {
  res.redirect(308, req.originalUrl.replace("/device-simple.html", "/user_customization.html"));
});
app.get("/user_customization.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "user_customization.html"));
});
app.get("/device-view.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "device-view.html")));
app.get("/device-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "device-admin.html")));
app.get("/device-report.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "device-report.html"));
});
app.get("/vendor/chart.umd.js", (req, res) => res.sendFile(path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.js")));
app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(path.join(__dirname, "node_modules", "jspdf", "dist", "jspdf.umd.min.js")));
app.get("/vendor/html2canvas.min.js", (req, res) => res.sendFile(path.join(__dirname, "node_modules", "html2canvas", "dist", "html2canvas.min.js")));
app.get("/device_schedule.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), (req, res) => res.sendFile(path.join(__dirname, "public", "device_schedule.html")));
app.get("/login.html", (req, res) => res.redirect(302, `/user-login.html${req.url.slice(req.path.length)}`));
app.get("/register.html", (req, res) => res.redirect(302, `/user-register.html${req.url.slice(req.path.length)}`));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "user-login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "user-register.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------------------------------------------------------
// 회원가입: 신청 상태 PENDING
// ---------------------------------------------------------
function generateSignupOrganizationCodes() {
  const code = () => crypto.randomInt(36 ** 3).toString(36).toUpperCase().padStart(3, "0");
  return { department: code(), role: code() };
}

async function findRegistrationOrganization(run, selection, lock = false) {
  const fields = ["group", "company", "site", "department", "role"];
  const where = fields.map(field => "`" + (field === "group" ? "group_code" : field === "role" ? "job" : field) + "`<=>?").join(" AND ");
  const rows = await run("SELECT organization_id,group_code AS `group`,company,site,department,job AS `role`,group_name,company_name,site_name,department_name,job_name AS role_name FROM company_organization WHERE " + where + " AND is_active=1 LIMIT 1" + (lock ? " LOCK IN SHARE MODE" : ""), fields.map(field => selection.codes[field]));
  return rows[0] || null;
}

app.post("/api/register/organization", async (req, res) => {
  const selection = parseOrganizationSelection(req.body || {});
  if (selection.error) return res.status(400).json({ error: selection.error });
  try {
    const organization = await findRegistrationOrganization(query, selection);
    if (!organization) return res.status(404).json({ error: "일치하는 활성 조직이 없습니다. 조직 코드를 확인하거나 Default 조직을 선택하세요." });
    res.setHeader("Cache-Control", "no-store");
    res.json({ organization: organizationProfile(organization) });
  } catch (error) {
    console.error("가입 조직 조회 오류:", error.code || error.message);
    res.status(500).json({ error: "조직 정보를 확인하지 못했습니다." });
  }
});

app.post("/api/register", async (req, res) => {
  const data = validateProfile(req.body, { passwordRequired: true });
  if (data.error) return res.status(400).json({ error: data.error, field: data.field });
  if (typeof req.body.passwordConfirm !== "string" || !req.body.passwordConfirm) return res.status(400).json({ error: "비밀번호 확인 값이 전달되지 않았습니다. 페이지를 새로고침한 후 다시 입력해주세요.", field: "passwordConfirm" });
  if (data.password !== req.body.passwordConfirm) return res.status(400).json({ error: "비밀번호가 서로 다릅니다." });
  const selection = parseOrganizationSelection(req.body || {});
  const application = validateRegisterComment(req.body.registerComment, true, "가입 신청 이유");
  if (selection.error || application.error) return res.status(400).json({ error: selection.error || application.error, field: selection.error ? "organization" : "registerComment" });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const organization = await findRegistrationOrganization(run, selection, true);
    if (!organization) { await connection.rollback(); return res.status(400).json({ error: "조직 코드 조합이 일치하지 않습니다. 다시 확인하거나 Default 조직으로 신청하세요.", field: "organization" }); }
    if (await hasDuplicateProfilePhone(data.phone, null, run)) { await connection.rollback(); return res.status(409).json({ error: "이미 사용 중인 전화번호입니다.", field: "phone" }); }
    const exists = await run("SELECT user_id AS id, login_id AS username, email FROM user_profile WHERE login_id = ? OR email = ? LIMIT 1", [data.username, data.email]);
    if (exists.length) {
      await connection.rollback();
      if (exists[0].username === data.username) return res.status(409).json({ error: "이미 사용 중인 아이디입니다.", field: "username" });
      return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다.", field: "email" });
    }
    let result;
    let signupCodes;
    const isPersonalOrganization = organization.group === "001" && organization.company === "001" && organization.site === "001" && organization.department == null && organization.role == null;
    const passwordHash = hashPassword(data.password);
    for (let attempt = 0; attempt < (isPersonalOrganization ? 5 : 1); attempt++) {
      signupCodes = isPersonalOrganization ? generateSignupOrganizationCodes() : null;
      try {
        result = await run(`INSERT INTO user_profile (login_id,password_hash,user_name,phone,address,email,organization_id,signup_department_code,signup_role_code,user_status,role,permission_level,user_request_at) VALUES (?,?,?,?,?,?,?,?,?,'PENDING','USER',1,NOW())`, [data.username, passwordHash, data.name, data.phone, data.address, data.email, organization.organization_id, signupCodes?.department ?? null, signupCodes?.role ?? null]);
        break;
      } catch (error) {
        const duplicatePersonalCodes = error.code === "ER_DUP_ENTRY" && /uq_user_profile_signup_codes/i.test(String(error.sqlMessage || error.message));
        if (!duplicatePersonalCodes || attempt === 4 || !isPersonalOrganization) throw error;
      }
    }
    const userId = Number(result.insertId);
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,'APPLICATION',?,?,?)", [userId, data.username, application.comment, userId, data.username]);
    await connection.commit();
    res.status(201).json({ ok: true, message: "가입 신청이 접수되었습니다. 마스터 승인 후 생산 현황을 이용할 수 있습니다.", organizationCodes: signupCodes });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("회원가입 오류:", { code: err.code, errno: err.errno, sqlState: err.sqlState, message: err.message });
    if (["ER_DUP_ENTRY", "ER_DUP_ENTRY_WITH_TRUNCATED_WRITES"].includes(err.code) && /uq_user_profile_signup_codes/i.test(String(err.sqlMessage || err.message))) return res.status(503).json({ error: "중복되지 않는 부서·직무 코드를 발급하지 못했습니다. 잠시 후 다시 신청하세요." });
    if (err.code === "ER_DUP_ENTRY" || err.code === "ER_DUP_ENTRY_WITH_TRUNCATED_WRITES") return res.status(409).json({ error: "아이디, 전화번호 또는 이메일이 이미 등록되어 있습니다.", field: profileUniqueViolationField(err) });
    if (err.code === "ER_BAD_FIELD_ERROR" || /unknown column.*permission_level/i.test(String(err.message))) return res.status(500).json({ error: "데이터베이스 구조가 현재 버전과 다릅니다. 새 DB에 schema.sql을 적용하고 DB_NAME을 확인하세요." });
    if (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_TABLE_ERROR") return res.status(500).json({ error: "회원 테이블이 없습니다. schema.sql을 실행한 뒤 다시 시도하세요." });
    if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_ROW_IS_REFERENCED_2") return res.status(500).json({ error: "회원 테이블 제약조건이 올바르지 않습니다. 데이터베이스 스키마를 확인하세요." });
    res.status(500).json({ error: "회원가입 처리 중 오류가 발생했습니다." });
  } finally { connection?.release(); }
});

// ---------------------------------------------------------
// 로그인: PENDING도 프로필 수정 목적의 제한 로그인 허용
// ---------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "아이디와 비밀번호를 입력하세요." });

  try {
    const rows = await query(`SELECT user_id AS id,login_id AS username,password_hash,user_name AS name,phone,email,role,permission_level,user_status AS status FROM user_profile WHERE login_id = ? LIMIT 1`, [username]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });

    const token = createSession(rows[0]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, permissionLevel: Number(rows[0].permission_level || (rows[0].role === "MASTER" ? 20 : 1)), status: rows[0].status }, redirect: ["PENDING", "REJECTED", "WITHDRAWAL_PENDING", "SUSPENDED"].includes(rows[0].status) ? "/user-profile.html?pending=1" : "/" });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

async function readUserOrganization(userId) {
  const rows = await query("SELECT o.organization_id,o.group_code AS `group`,o.company,o.site,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_department_code,o.department) ELSE o.department END AS department,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_role_code,o.job) ELSE o.job END AS `role`,o.group_name,o.company_name,o.site_name,o.department_name,o.job_name AS role_name FROM user_profile u JOIN company_organization o ON o.organization_id=u.organization_id WHERE u.user_id=?", [userId]);
  return rows.length ? organizationProfile(rows[0]) : null;
}

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const rows = await query(`SELECT user_id AS id,login_id AS username,user_name AS name,organization_id,phone,address,email,role,permission_level,user_status AS status,approved_at,created_at,updated_at FROM user_profile WHERE user_id=?`, [req.user.id]);
    if (!rows.length) { clearSessionCookie(res); return res.status(401).json({ error: "회원 정보를 찾을 수 없습니다." }); }
    const u = rows[0];
    req.user.status = u.status;
    req.user.role = u.role;
    req.user.permissionLevel = Number(u.permission_level || (u.role === "MASTER" ? 20 : 1));
    res.setHeader("Cache-Control", "no-store");
    res.json({ loggedIn: true, user: u, organization: await readUserOrganization(req.user.id), ...userPermissionSnapshot(u, permissionPolicy), policyRevision: permissionPolicyRevision });
  } catch (err) { res.status(500).json({ error: "회원정보 조회 오류" }); }
});

// 회원 본인 정보 수정. 승인 전/후 모두 가능.
app.put("/api/me", requireLogin, async (req, res) => {
  const data = validateProfile({ ...req.body, username: req.user.username }, { passwordRequired: false });
  if (data.error) return res.status(400).json({ error: data.error, field: data.field });
  const currentPassword = String(req.body.currentPassword || "");
  const passwordConfirm = String(req.body.passwordConfirm || "");
  if (data.password && !currentPassword) return res.status(400).json({ error: "새 비밀번호로 변경하려면 기존 비밀번호를 입력하세요.", field: "currentPassword" });
  if (data.password && data.password !== passwordConfirm) return res.status(400).json({ error: "새 비밀번호가 서로 일치하지 않습니다." });
  try {
    if (await hasDuplicateProfilePhone(data.phone, req.user.id)) return res.status(409).json({ error: "이미 사용 중인 전화번호입니다.", field: "phone" });
    const exists = await query("SELECT user_id AS id FROM user_profile WHERE email = ? AND user_id <> ? LIMIT 1", [data.email, req.user.id]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다.", field: "email" });
    if (data.password) {
      const rows = await query("SELECT password_hash FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
      if (!rows.length || !verifyPassword(currentPassword, rows[0].password_hash)) return res.status(400).json({ error: "기존 비밀번호가 올바르지 않습니다.", field: "currentPassword" });
      await query(`UPDATE user_profile SET user_name=?,phone=?,address=?,email=?,password_hash=?,user_request_at=NOW() WHERE user_id=?`, [data.name, data.phone, data.address, data.email, hashPassword(data.password), req.user.id]);
    } else {
      await query(`UPDATE user_profile SET user_name=?,phone=?,address=?,email=?,user_request_at=NOW() WHERE user_id=?`, [data.name, data.phone, data.address, data.email, req.user.id]);
    }
    const rows = await query(`SELECT user_id AS id,login_id AS username,user_name AS name,organization_id,phone,address,email,role,permission_level,user_status AS status,approved_at,created_at,updated_at FROM user_profile WHERE user_id=?`, [req.user.id]);
    req.user.name = rows[0].name;
    res.json({ ok: true, user: rows[0], organization: await readUserOrganization(req.user.id), message: "회원정보가 수정되었습니다." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) return res.status(409).json({ error: "전화번호 또는 이메일이 이미 사용 중입니다.", field: profileUniqueViolationField(err) });
    console.error(err); res.status(500).json({ error: "회원정보 수정 오류" });
  }
});

app.post("/api/logout", (req, res) => { const token = getCookie(req, SESSION_COOKIE); if (token) sessions.delete(token); clearSessionCookie(res); res.json({ ok: true }); });

app.post("/api/me/change-request", requireLogin, async (req, res) => {
  const eventTypes = { LEVEL: "LEVEL_CHANGE_REQUEST", ORGANIZATION: "ORGANIZATION_CHANGE_REQUEST", WITHDRAWAL: "WITHDRAWAL_REQUEST" };
  const eventType = typeof req.body?.kind === "string" && Object.hasOwn(eventTypes, req.body.kind) ? eventTypes[req.body.kind] : null;
  if (!eventType) return res.status(400).json({ error: "등급변경, 조직 변경 또는 탈퇴 신청을 선택하세요." });
  const reason = validateRegisterComment(req.body?.comment, true, "관리자 요청 내용");
  if (reason.error) return res.status(400).json({ error: reason.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const rows = await run("SELECT login_id AS username,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [req.user.id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." }); }
    if (rows[0].status !== "APPROVED") { await connection.rollback(); return res.status(400).json({ error: "승인된 회원만 관리자 요청을 할 수 있습니다." }); }
    const withdrawal = req.body.kind === "WITHDRAWAL";
    if (withdrawal) await run("UPDATE user_profile SET user_status='WITHDRAWAL_PENDING',user_request_at=NOW() WHERE user_id=?", [req.user.id]);
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,?,?,?,?)", [req.user.id, rows[0].username, eventType, reason.comment, req.user.id, rows[0].username]);
    await connection.commit();
    if (withdrawal) req.user.status = "WITHDRAWAL_PENDING";
    res.json({ ok: true, message: withdrawal ? "탈퇴 신청이 접수되었습니다." : "관리자 요청이 접수되었습니다." });
  } catch (err) { if (connection) await connection.rollback(); console.error("관리자 요청 오류:", err); res.status(500).json({ error: "관리자 요청 처리 중 오류가 발생했습니다." }); }
  finally { connection?.release(); }
});

app.post("/api/me/reapply", requireLogin, async (req, res) => {
  const reason = validateRegisterComment(req.body?.comment, true, "재신청 이유");
  if (reason.error) return res.status(400).json({ error: reason.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const rows = await run("SELECT login_id AS username,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [req.user.id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." }); }
    if (rows[0].status !== "REJECTED") { await connection.rollback(); return res.status(400).json({ error: "반려된 회원만 재신청할 수 있습니다." }); }
    await run("UPDATE user_profile SET user_status='PENDING',approved_at=NULL,approved_by=NULL,user_request_at=NOW() WHERE user_id=?", [req.user.id]);
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,'REAPPLICATION',?,?,?)", [req.user.id, rows[0].username, reason.comment, req.user.id, rows[0].username]);
    await connection.commit();
    req.user.status = "PENDING";
    res.json({ ok: true, message: "가입 재신청이 접수되었습니다." });
  } catch (err) { if (connection) await connection.rollback(); console.error("재신청 오류:", err); res.status(500).json({ error: "가입 재신청 처리 중 오류가 발생했습니다." }); }
  finally { connection?.release(); }
});

app.post("/api/me/cancel-registration", requireLogin, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const rows = await run("SELECT login_id AS username,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [req.user.id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." }); }
    if (!["PENDING", "REJECTED"].includes(rows[0].status)) { await connection.rollback(); return res.status(400).json({ error: "승인 전 가입 신청만 취소할 수 있습니다." }); }
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,'STATUS',?,?,?)", [req.user.id, rows[0].username, "가입 신청자가 가입을 취소했습니다.", req.user.id, rows[0].username]);
    await run("DELETE FROM user_profile WHERE user_id=?", [req.user.id]);
    await connection.commit();
    forceLogoutUser(req.user.id);
    clearSessionCookie(res);
    res.json({ ok: true, message: "가입 신청이 취소되고 회원 정보가 삭제되었습니다." });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("가입 신청 취소 오류:", err.code || err.message);
    res.status(500).json({ error: "가입 신청 취소 중 오류가 발생했습니다." });
  } finally { connection?.release(); }
});

app.post("/api/me/withdraw", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (["PENDING", "REJECTED", "WITHDRAWAL_PENDING"].includes(rows[0].status)) return res.status(400).json({ error: "현재 상태에서는 탈퇴 신청을 할 수 없습니다." });
    await query("UPDATE user_profile SET user_status='WITHDRAWAL_PENDING',user_request_at=NOW() WHERE user_id=?", [req.user.id]);
    req.user.status = "WITHDRAWAL_PENDING";
    res.json({ ok: true, message: "탈퇴 신청이 접수되었습니다." });
  } catch (err) { console.error("탈퇴 신청 오류:", err); res.status(500).json({ error: "탈퇴 신청 처리 중 오류가 발생했습니다." }); }
});

app.post("/api/me/cancel-withdraw", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (rows[0].status !== "WITHDRAWAL_PENDING") return res.status(400).json({ error: "탈퇴 신청 상태에서만 취소할 수 있습니다." });
    await query("UPDATE user_profile SET user_status='APPROVED' WHERE user_id=?", [req.user.id]);
    req.user.status = "APPROVED";
    res.json({ ok: true, message: "탈퇴 신청이 취소되었습니다." });
  } catch (err) { console.error("탈퇴 취소 오류:", err); res.status(500).json({ error: "탈퇴 취소 처리 중 오류가 발생했습니다." }); }
});

// ---------------------------------------------------------
// 사용자별 개인 설정 (알림음/테마/화면 표시)
// ---------------------------------------------------------
const SETTINGS_DEFAULTS = {
  sound_type: "bell", sound_volume: 50, sound_enabled: true, theme: "light",
  display_mode: "normal", show_summary: true, show_target: true, show_rate: true,
  show_updated_at: true, show_updated_by: true, date_format: "ko-KR",
  show_device_istr: true, show_device_ostr: true, show_device_ostr_inputs: true
};
const SOUND_TYPES = ["bell", "high", "beep", "low", "soft", "chime", "alert"];
const THEMES = ["light", "dark"];
const DISPLAY_MODES = ["normal", "compact", "large"];
const DATE_FORMATS = ["ko-KR", "iso"];

function toBool(value) { return value ? 1 : 0; }
function rowToSettings(row) {
  return {
    sound_type: row.sound_type, sound_volume: Number(row.sound_volume),
    sound_enabled: !!row.sound_enabled, theme: row.theme, display_mode: row.display_mode,
    show_summary: !!row.show_summary, show_target: !!row.show_target, show_rate: !!row.show_rate,
    show_updated_at: !!row.show_updated_at, show_updated_by: !!row.show_updated_by,
    show_device_istr: row.show_device_istr == null ? true : !!row.show_device_istr,
    show_device_ostr: row.show_device_ostr == null ? true : !!row.show_device_ostr,
    show_device_ostr_inputs: row.show_device_ostr_inputs == null ? true : !!row.show_device_ostr_inputs,
    date_format: row.date_format
  };
}

function validateSettings(body) {
  const soundType = String(body.sound_type ?? SETTINGS_DEFAULTS.sound_type);
  const soundVolume = Number(body.sound_volume ?? SETTINGS_DEFAULTS.sound_volume);
  const soundEnabled = body.sound_enabled ?? SETTINGS_DEFAULTS.sound_enabled;
  const theme = String(body.theme ?? SETTINGS_DEFAULTS.theme);
  const displayMode = String(body.display_mode ?? SETTINGS_DEFAULTS.display_mode);
  const showSummary = body.show_summary ?? SETTINGS_DEFAULTS.show_summary;
  const showTarget = body.show_target ?? SETTINGS_DEFAULTS.show_target;
  const showRate = body.show_rate ?? SETTINGS_DEFAULTS.show_rate;
  const showUpdatedAt = body.show_updated_at ?? SETTINGS_DEFAULTS.show_updated_at;
  const showUpdatedBy = body.show_updated_by ?? SETTINGS_DEFAULTS.show_updated_by;
  const showDeviceIstr = body.show_device_istr ?? SETTINGS_DEFAULTS.show_device_istr;
  const showDeviceOstr = body.show_device_ostr ?? SETTINGS_DEFAULTS.show_device_ostr;
  const showDeviceOstrInputs = body.show_device_ostr_inputs ?? SETTINGS_DEFAULTS.show_device_ostr_inputs;
  const dateFormat = String(body.date_format ?? SETTINGS_DEFAULTS.date_format);

  if (!SOUND_TYPES.includes(soundType)) return { error: "알림음 종류가 올바르지 않습니다." };
  if (!Number.isInteger(soundVolume) || soundVolume < 0 || soundVolume > 100) return { error: "알림음 크기는 0~100 사이의 정수여야 합니다." };
  if (typeof soundEnabled !== "boolean") return { error: "알림음 사용 여부 값이 올바르지 않습니다." };
  if (!THEMES.includes(theme)) return { error: "테마 값이 올바르지 않습니다." };
  if (!DISPLAY_MODES.includes(displayMode)) return { error: "화면 표시 모드 값이 올바르지 않습니다." };
  if (typeof showSummary !== "boolean") return { error: "요약 정보 표시 값이 올바르지 않습니다." };
  if (typeof showTarget !== "boolean") return { error: "목표수량 표시 값이 올바르지 않습니다." };
  if (typeof showRate !== "boolean") return { error: "달성률 표시 값이 올바르지 않습니다." };
  if (typeof showUpdatedAt !== "boolean") return { error: "최종 변경 날짜 표시 값이 올바르지 않습니다." };
  if (typeof showUpdatedBy !== "boolean") return { error: "최종 변경자 표시 값이 올바르지 않습니다." };
  if (typeof showDeviceIstr !== "boolean" || typeof showDeviceOstr !== "boolean" || typeof showDeviceOstrInputs !== "boolean") {
    return { error: "Device 문자열 표시 값은 boolean이어야 합니다." };
  }
  if (!DATE_FORMATS.includes(dateFormat)) return { error: "날짜 형식 값이 올바르지 않습니다." };

  return {
    sound_type: soundType, sound_volume: soundVolume, sound_enabled: soundEnabled, theme,
    display_mode: displayMode, show_summary: showSummary, show_target: showTarget, show_rate: showRate,
    show_updated_at: showUpdatedAt, show_updated_by: showUpdatedBy,
    show_device_istr: showDeviceIstr, show_device_ostr: showDeviceOstr, show_device_ostr_inputs: showDeviceOstrInputs,
    date_format: dateFormat
  };
}

app.get("/api/me/settings", requireLogin, requireActiveAccount, async (req, res) => {
  try {
    const rows = await query("SELECT * FROM user_setting WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.json(SETTINGS_DEFAULTS);
    res.json(rowToSettings(rows[0]));
  } catch (err) { console.error("설정 조회 오류:", err); res.status(500).json({ error: "설정 조회 중 오류가 발생했습니다." }); }
});

app.put("/api/me/settings", requireLogin, requireActiveAccount, async (req, res) => {
  const data = validateSettings(req.body || {});
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const existing = await query("SELECT user_id FROM user_setting WHERE user_id=? LIMIT 1", [req.user.id]);
    await query(
      `INSERT INTO user_setting (user_id,sound_type,sound_volume,sound_enabled,theme,display_mode,show_summary,show_target,show_rate,show_updated_at,show_updated_by,date_format,show_device_istr,show_device_ostr,show_device_ostr_inputs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE sound_type=VALUES(sound_type),sound_volume=VALUES(sound_volume),sound_enabled=VALUES(sound_enabled),
         theme=VALUES(theme),display_mode=VALUES(display_mode),show_summary=VALUES(show_summary),show_target=VALUES(show_target),
         show_rate=VALUES(show_rate),show_updated_at=VALUES(show_updated_at),show_updated_by=VALUES(show_updated_by),date_format=VALUES(date_format),
         show_device_istr=VALUES(show_device_istr),show_device_ostr=VALUES(show_device_ostr),show_device_ostr_inputs=VALUES(show_device_ostr_inputs)`,
      [req.user.id, data.sound_type, data.sound_volume, toBool(data.sound_enabled), data.theme, data.display_mode,
      toBool(data.show_summary), toBool(data.show_target), toBool(data.show_rate),
      toBool(data.show_updated_at), toBool(data.show_updated_by), data.date_format,
      toBool(data.show_device_istr), toBool(data.show_device_ostr), toBool(data.show_device_ostr_inputs)]
    );
    res.status(existing.length ? 200 : 201).json({ ok: true, message: "설정이 저장되었습니다.", settings: data });
  } catch (err) { console.error("설정 저장 오류:", err); res.status(500).json({ error: "설정 저장 중 오류가 발생했습니다." }); }
});

const PRODUCT_SELECTION_COLUMNS = { view: "product_view_selection", control: "product_control_selection" };

app.get("/api/me/product-selection/:page", requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  const column = Object.hasOwn(PRODUCT_SELECTION_COLUMNS, req.params.page) ? PRODUCT_SELECTION_COLUMNS[req.params.page] : null;
  if (!column) return res.status(400).json({ error: "올바른 제품 선택 화면이 아닙니다." });
  res.setHeader("Cache-Control", "no-store");
  try {
    const rows = await query(`SELECT ${column} AS selection FROM user_setting WHERE user_id=? LIMIT 1`, [req.user.id]);
    res.json({ selection: rows[0]?.selection == null ? null : JSON.parse(rows[0].selection) });
  } catch (error) {
    console.error("제품 선택 조회 오류:", error);
    res.status(500).json({ error: "저장된 제품 선택을 불러오지 못했습니다." });
  }
});

app.put("/api/me/product-selection/:page", requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  const column = Object.hasOwn(PRODUCT_SELECTION_COLUMNS, req.params.page) ? PRODUCT_SELECTION_COLUMNS[req.params.page] : null;
  if (!column) return res.status(400).json({ error: "올바른 제품 선택 화면이 아닙니다." });
  const selection = req.body?.selection;
  if (selection !== "*" && (!Array.isArray(selection) || selection.some(id =>
    typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))) {
    return res.status(400).json({ error: "제품 선택 값이 올바르지 않습니다." });
  }
  const saved = selection === "*" ? "*" : [...new Set(selection)];
  try {
    await query(`INSERT INTO user_setting (user_id,${column}) VALUES (?,?)
      ON DUPLICATE KEY UPDATE ${column}=VALUES(${column})`, [req.user.id, JSON.stringify(saved)]);
    res.json({ selection: saved });
  } catch (error) {
    console.error("제품 선택 저장 오류:", error);
    res.status(500).json({ error: "제품 선택을 저장하지 못했습니다." });
  }
});

const User_customization_SWITCH_DESIGNS = new Set(["design-01", "design-02", "design-03", "design-04", "design-05", "design-06", "design-07", "design-08"]);
const User_customizationGraphConfig = require("./public/user_customization_graph_config");
const User_customization_LAMP_DESIGNS = new Set(["lamp-01", "lamp-02", "lamp-03", "lamp-04", "lamp-05", "lamp-06", "lamp-07", "lamp-08", "lamp-09", "lamp-10", "lamp-11", "lamp-12", "lamp-13", "lamp-14", "lamp-15", "lamp-18", "lamp-26", "lamp-27"]);
const User_customization_LEGACY_ARROW_DIRECTIONS = {
  "lamp-19": "right", "lamp-20": "up", "lamp-21": "down", "lamp-22": "up_right",
  "lamp-23": "down_right", "lamp-24": "up_left", "lamp-25": "down_left"
};
const User_customization_LEGACY_SWITCH_DESIGNS = new Map([
  ["design-13", "design-02"], ["design-21", "design-03"], ["design-22", "design-04"],
  ["design-23", "design-05"], ["design-24", "design-06"]
]);

function validateUser_customizationChannels(channels) {
  if (!Array.isArray(channels) || channels.length > 1024) return { error: "채널은 최대 1024개까지 선택할 수 있습니다." };
  const seen = new Set();
  const normalized = [];
  for (const savedChannel of channels) {
    const direction = savedChannel?.display_type === "lamp" && typeof savedChannel.lamp_design === "string" && Object.hasOwn(User_customization_LEGACY_ARROW_DIRECTIONS, savedChannel.lamp_design)
      ? User_customization_LEGACY_ARROW_DIRECTIONS[savedChannel.lamp_design] : null;
    if (direction && savedChannel.channel_settings !== undefined) {
      const config = User_customizationGraphConfig.validateChannel(savedChannel.channel_settings);
      if (config.error) return config;
    }
    const channel = direction ? { ...savedChannel, lamp_design: "lamp-18",
      channel_settings: { ...savedChannel.channel_settings, arrow_direction: direction } } : savedChannel;
    const deviceId = String(channel?.device_id || "");
    const outputSignal = String(channel?.output_signal || "");
    const savedDisplayType = channel?.display_type ?? "switch";
    const displayType = savedDisplayType === "button" ? "switch" : savedDisplayType;
    if (!["switch", "lamp", "graph"].includes(displayType)
      || (displayType === "lamp" && channel.lamp_design !== undefined && !User_customization_LAMP_DESIGNS.has(channel.lamp_design))) {
      return { error: "표시 유형 또는 램프 디자인이 올바르지 않습니다." };
    }
    const savedSwitchDesign = channel?.switch_design ?? channel?.button_design;
    const switchDesign = User_customization_SWITCH_DESIGNS.has(savedSwitchDesign)
      ? savedSwitchDesign : User_customization_LEGACY_SWITCH_DESIGNS.get(savedSwitchDesign) || "design-01";
    const key = JSON.stringify([deviceId, outputSignal, displayType]);
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(deviceId) || !/^OS(?:[1-9]|1[0-6])$/.test(outputSignal) || seen.has(key) || !User_customization_SWITCH_DESIGNS.has(switchDesign)) {
      return { error: "채널 선택 정보가 올바르지 않거나 중복되었습니다." };
    }
    seen.add(key);
    const selection = { device_id: deviceId, output_signal: outputSignal };
    if (channel.channel_settings !== undefined) {
      const config = User_customizationGraphConfig.validateChannel(channel.channel_settings);
      if (config.error) return config;
      selection.channel_settings = config.settings;
    }
    if (displayType === "switch") selection.switch_design = switchDesign;
    else if (displayType === "lamp") Object.assign(selection, { display_type: "lamp", lamp_design: channel.lamp_design || "lamp-01" });
    else {
      selection.display_type = "graph";
      if (channel.graph_design !== undefined && channel.graph_design !== "graph-01" && channel.graph_design !== "graph-05" && channel.graph_design !== "graph-06" && !User_customizationGraphConfig.isGaugeDesign(channel.graph_design)) {
        return { error: "그래프 디자인이 올바르지 않습니다." };
      }
      if (User_customizationGraphConfig.isGaugeDesign(channel.graph_design)) {
        const config = User_customizationGraphConfig.validate(channel.graph_settings);
        if (config.error) return config;
        Object.assign(selection, { graph_design: channel.graph_design, graph_settings: config.settings });
      }
      if (channel.graph_design === "graph-06") selection.graph_design = "graph-06";
      if (channel.graph_design === "graph-05") {
        const config = User_customizationGraphConfig.validateChart(channel.chart_settings);
        if (config.error) return config;
        Object.assign(selection, { graph_design: "graph-05", chart_settings: config.settings });
      }
    }
    normalized.push(selection);
  }
  return { channels: normalized };
}

app.get(["/api/me/User_customization", "/api/me/simple-channels"], requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  try {
    const rows = await query("SELECT User_customization FROM user_setting WHERE user_id=? LIMIT 1", [req.user.id]);
    let channels = [];
    let migratedChannels = false;
    try {
      const saved = JSON.parse(rows[0]?.User_customization || "[]");
      const retained = Array.isArray(saved)
        ? saved.filter(channel => !(channel?.display_type === "lamp" && ["lamp-16", "lamp-17"].includes(channel.lamp_design))) : saved;
      const migrated = Array.isArray(retained) ? retained.map(channel => channel?.channel_settings === undefined ? channel : {
        ...channel, channel_settings: User_customizationGraphConfig.migrateChannel(channel.channel_settings)
      }) : retained;
      const validated = validateUser_customizationChannels(migrated);
      channels = validated.channels || [];
      migratedChannels = !validated.error && Array.isArray(saved) && (retained.length !== saved.length
        || retained.some(channel => channel?.display_type === "button" || Object.hasOwn(channel, "button_design"))
        || retained.some(channel => channel?.display_type === "lamp" && Object.hasOwn(User_customization_LEGACY_ARROW_DIRECTIONS, channel.lamp_design))
        || retained.some(channel => channel?.channel_settings?.width_multiplier === 5 || channel?.channel_settings?.height_multiplier === 5));
    } catch {}
    if (migratedChannels) {
      await query("UPDATE user_setting SET User_customization=? WHERE user_id=?", [JSON.stringify(channels), req.user.id]);
    }
    const devices = await getManagedDeviceDevices();
    res.json({ channels, devices: devices.filter(device => Number(device.is_visible) === 1).map(device => ({
      device_id: device.device_id, device_name: device.device_name,
      is_visible: device.is_visible, is_enabled: device.is_enabled, deviceConnected: device.deviceConnected,
      sets: device.sets.filter(channel => Number(channel.is_visible) === 1)
        .map(channel => ({ ...channel, is_active: channel.is_visible }))
    })) });
  } catch (err) {
    console.error("사용자 디자인 채널 조회 오류:", err);
    res.status(500).json({ error: "사용자 디자인 채널을 불러오지 못했습니다." });
  }
});

app.put(["/api/me/User_customization", "/api/me/simple-channels"], requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  const data = validateUser_customizationChannels(req.body?.channels);
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const available = await query("SELECT device_id,output_signal FROM device_channel");
    const keys = new Set(available.map(channel => JSON.stringify([channel.device_id, channel.output_signal])));
    if (data.channels.some(channel => !keys.has(JSON.stringify([channel.device_id, channel.output_signal])))) {
      return res.status(400).json({ error: "존재하지 않는 채널이 포함되어 있습니다." });
    }
    await query(`INSERT INTO user_setting (user_id,User_customization) VALUES (?,?)
      ON DUPLICATE KEY UPDATE User_customization=VALUES(User_customization)`, [req.user.id, JSON.stringify(data.channels)]);
    res.json({ ok: true, channels: data.channels });
  } catch (err) {
    console.error("사용자 디자인 채널 저장 오류:", err);
    res.status(500).json({ error: "사용자 디자인 채널을 저장하지 못했습니다." });
  }
});

// ---------------------------------------------------------
// 마스터 관리
// ---------------------------------------------------------
function isDefaultCompany(row) {
  return (row.group === "001" && row.company === "001" && row.site === "001" && row.department == null && row.role == null)
    || ["DEF", "000", "001"].some(code => ["group", "company", "site", "department", "role"].every(field => row[field] === code));
}

const companyAdminMiddleware = [requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8)];

app.get("/api/admin/companies", companyAdminMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const rows = await query("SELECT organization_id,group_code AS `group`,company,site,department,job AS `role`,group_name,company_name,site_name,department_name,job_name AS role_name,is_active,created_at,updated_at FROM company_organization ORDER BY group_name,company_name,site_name,department_name,job_name,organization_id");
    res.json({ organizations: rows.map(row => ({ ...row, is_default: isDefaultCompany(row) })) });
  } catch (error) { console.error("회사 목록 조회 오류:", error.code || error.message); res.status(500).json({ error: "회사 목록을 불러오지 못했습니다." }); }
});

app.post("/api/admin/companies", companyAdminMiddleware, async (req, res) => {
  const data = validateOrganizationRecord(req.body || {});
  if (data.error) return res.status(400).json({ error: data.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const organizations = await connectionQuery(connection, "SELECT organization_id,group_code AS `group`,company,site,department,job AS `role`,group_name,company_name,site_name,department_name,job_name AS role_name FROM company_organization ORDER BY organization_id FOR UPDATE");
    if (organizations.some(row => registrationOrganizationCodes.every(field => row[field] === data.codes[field]))) { await connection.rollback(); return res.status(409).json({ error: "같은 5단계 조직 코드 조합이 이미 등록되어 있습니다." }); }
    const nameValidation = validateOrganizationNameHierarchy(data, organizations);
    if (nameValidation.error) { await connection.rollback(); return res.status(409).json({ error: nameValidation.error }); }
    const result = await connectionQuery(connection, "INSERT INTO company_organization (group_code,company,site,department,job,group_name,company_name,site_name,department_name,job_name,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [data.codes.group, data.codes.company, data.codes.site, data.codes.department, data.codes.role, data.names.group_name, data.names.company_name, data.names.site_name, data.names.department_name, data.names.role_name, data.is_active ? 1 : 0]);
    await connection.commit();
    res.status(201).json({ ok: true, organization_id: Number(result.insertId) });
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "같은 조직 코드 조합이 이미 등록되어 있습니다." });
    console.error("회사 등록 오류:", error.code || error.message);
    res.status(500).json({ error: "회사를 등록하지 못했습니다." });
  } finally { connection?.release(); }
});

app.put("/api/admin/companies/:id", companyAdminMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const data = validateOrganizationRecord(req.body || {});
  if (!Number.isSafeInteger(id) || id < 1 || data.error) return res.status(400).json({ error: data.error || "잘못된 조직 ID입니다." });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const rows = await connectionQuery(connection, "SELECT organization_id,group_code AS `group`,company,site,department,job AS `role` FROM company_organization WHERE organization_id=? FOR UPDATE", [id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "등록된 회사를 찾을 수 없습니다." }); }
    if (isDefaultCompany(rows[0])) { await connection.rollback(); return res.status(403).json({ error: "Default 조직은 수정할 수 없습니다." }); }
    if (registrationOrganizationCodes.some(field => rows[0][field] !== data.codes[field])) { await connection.rollback(); return res.status(409).json({ error: "등록된 5단계 조직 코드는 변경할 수 없습니다. 새로운 코드 조합은 신규 등록하세요." }); }
    await connectionQuery(connection, "UPDATE company_organization SET group_name=?,company_name=?,site_name=?,department_name=?,job_name=?,is_active=? WHERE organization_id=?", [data.names.group_name, data.names.company_name, data.names.site_name, data.names.department_name, data.names.role_name, data.is_active ? 1 : 0, id]);
    await connection.commit();
    res.json({ ok: true });
  } catch (error) { if (connection) await connection.rollback(); console.error("회사 수정 오류:", error.code || error.message); res.status(500).json({ error: "회사를 수정하지 못했습니다." }); }
  finally { connection?.release(); }
});

async function readRegistrationHistory(userId) {
  const comments = await query("SELECT comment_id AS id,user_id,login_id,event_type,comment,actor_user_id,actor_login_id,created_at,CAST(request_comment_id AS CHAR) AS request_comment_id FROM user_register_comment WHERE user_id=? ORDER BY comment_id DESC", [userId]);
  const rows = await query("SELECT o.organization_id,o.group_code AS `group`,o.company,o.site,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_department_code,o.department) ELSE o.department END AS department,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_role_code,o.job) ELSE o.job END AS `role`,o.group_name,o.company_name,o.site_name,o.department_name,o.job_name AS role_name FROM user_profile u LEFT JOIN company_organization o ON o.organization_id=u.organization_id WHERE u.user_id=?", [userId]);
  return { comments, organization: rows[0]?.organization_id ? organizationProfile(rows[0]) : null };
}

app.get("/api/me/register-comments", requireLogin, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json(await readRegistrationHistory(req.user.id)); }
  catch (error) { console.error("신청 이력 조회 오류:", error.code || error.message); res.status(500).json({ error: "신청 이력을 불러오지 못했습니다." }); }
});

app.get("/api/admin/users/:id/register-comments", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  try {
    const rows = await query("SELECT user_id AS id,login_id AS username,user_name AS name FROM user_profile WHERE user_id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: rows[0], ...await readRegistrationHistory(id) });
  } catch (error) { console.error("회원 신청 이력 조회 오류:", error.code || error.message); res.status(500).json({ error: "회원 신청 이력을 불러오지 못했습니다." }); }
});

app.get("/api/admin/users", requireLogin, requireMaster, async (req, res) => {
  try {
    const rows = await query("SELECT u.user_id AS id,u.login_id AS username,u.user_name AS name,u.organization_id,o.group_code AS organization_group_code,o.company AS organization_company_code,o.site AS organization_site_code,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_department_code,o.department) ELSE o.department END AS organization_department_code,CASE WHEN o.group_code='001' AND o.company='001' AND o.site='001' AND o.department IS NULL AND o.job IS NULL THEN COALESCE(u.signup_role_code,o.job) ELSE o.job END AS organization_role_code,o.group_name,o.company_name,o.site_name,o.department_name,o.job_name AS role_name,u.phone,u.address,u.email,u.role,u.permission_level,u.admin_memo,u.user_status AS status,u.approved_at,u.created_at,u.updated_at,u.user_request_at FROM user_profile u LEFT JOIN company_organization o ON o.organization_id=u.organization_id ORDER BY CASE u.user_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 WHEN 'WITHDRAWAL_PENDING' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END,u.created_at DESC");
    const requests = await query("SELECT CAST(c.comment_id AS CHAR) AS request_id,c.user_id,c.event_type,c.comment,c.created_at FROM user_register_comment c WHERE c.user_id IS NOT NULL AND c.event_type IN ('LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST') AND NOT EXISTS (SELECT 1 FROM user_register_comment response WHERE response.request_comment_id=c.comment_id AND response.event_type IN ('APPROVAL','REJECTION')) ORDER BY c.comment_id DESC");
    for (const user of rows) user.pending_requests = requests.filter(request => Number(request.user_id) === Number(user.id));
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 목록 조회 오류" }); }
});

app.put("/api/admin/users/:id/requests/:requestId", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  const requestId = String(req.params.requestId || "");
  const status = String(req.body?.status || "").toUpperCase();
  if (!Number.isSafeInteger(id) || id < 1 || !/^[1-9][0-9]{0,19}$/.test(requestId) || BigInt(requestId) > 18446744073709551615n || !["APPROVED", "REJECTED"].includes(status)) return res.status(400).json({ error: "잘못된 요청입니다." });
  if (!canUseFeature(req.user, "user_admin", permissionPolicy)) return res.status(403).json({ error: "회원 요청 처리 권한이 없습니다." });
  if (id === req.user.id) return res.status(403).json({ error: "본인의 요청은 직접 처리할 수 없습니다." });
  const reason = validateRegisterComment(req.body?.comment, status === "REJECTED");
  if (reason.error) return res.status(400).json({ error: reason.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const users = await run("SELECT user_id AS id,login_id AS username,role,permission_level,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [id]);
    if (!users.length) { await connection.rollback(); return res.status(404).json({ error: "회원을 찾을 수 없습니다." }); }
    if (userManagementLevel(users[0]) >= userManagementLevel(req.user)) { await connection.rollback(); return res.status(403).json({ error: "자신보다 낮은 등급의 회원 요청만 처리할 수 있습니다." }); }
    if (users[0].status !== "APPROVED") { await connection.rollback(); return res.status(409).json({ error: "승인 상태의 회원 요청만 처리할 수 있습니다." }); }
    const requests = await run("SELECT comment_id AS request_id,event_type FROM user_register_comment WHERE comment_id=? AND user_id=? FOR UPDATE", [requestId, id]);
    if (!requests.length || !["LEVEL_CHANGE_REQUEST", "ORGANIZATION_CHANGE_REQUEST"].includes(requests[0].event_type)) { await connection.rollback(); return res.status(404).json({ error: "변경 요청을 찾을 수 없습니다." }); }
    const responses = await run("SELECT comment_id FROM user_register_comment WHERE request_comment_id=? AND event_type IN ('APPROVAL','REJECTION') LIMIT 1", [requestId]);
    if (responses.length) { await connection.rollback(); return res.status(409).json({ error: "이미 처리된 요청입니다." }); }
    const actors = await run("SELECT login_id AS username FROM user_profile WHERE user_id=?", [req.user.id]);
    if (!actors.length) { await connection.rollback(); return res.status(403).json({ error: "처리자 정보를 확인하지 못했습니다." }); }
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id,request_comment_id) VALUES (?,?,?,?,?,?,?)", [id, users[0].username, status === "APPROVED" ? "APPROVAL" : "REJECTION", reason.comment, req.user.id, actors[0].username, requestId]);
    await connection.commit();
    res.json({ ok: true, message: status === "APPROVED" ? "요청이 승인 처리되었습니다." : "요청이 반려되었습니다." });
  } catch (error) { if (connection) await connection.rollback(); console.error("회원 요청 처리 오류:", error); res.status(500).json({ error: "회원 요청 처리 오류" }); }
  finally { connection?.release(); }
});

app.get("/api/admin/users/organizations", requireLogin, requireMaster, async (req, res) => {
  try {
    const organizations = await query("SELECT organization_id,group_code,company AS company_code,site AS site_code,department AS department_code,job AS role_code,group_name,company_name,site_name,department_name,job_name AS role_name,is_active FROM company_organization ORDER BY group_name,company_name,site_name,department_name,job_name,organization_id");
    res.setHeader("Cache-Control", "no-store");
    res.json({ organizations });
  } catch (err) { console.error(err); res.status(500).json({ error: "회사 조직 목록 조회 오류" }); }
});

app.put("/api/admin/users/:id/status", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "").toUpperCase();
  if (!Number.isInteger(id) || !["PENDING", "APPROVED", "REJECTED", "SUSPENDED"].includes(status)) return res.status(400).json({ error: "잘못된 요청입니다." });
  if (!canUseFeature(req.user, "user_admin", permissionPolicy)) return res.status(403).json({ error: "회원 승인 권한이 없습니다." });
  if (id === req.user.id) return res.status(400).json({ error: "현재 로그인한 관리자 계정은 이 화면에서 변경할 수 없습니다." });
  const reason = validateRegisterComment(req.body.comment, status === "REJECTED");
  if (reason.error) return res.status(400).json({ error: reason.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const exists = await run("SELECT user_id AS id,login_id AS username,role,permission_level,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [id]);
    if (!exists.length) { await connection.rollback(); return res.status(404).json({ error: "회원을 찾을 수 없습니다." }); }
    if (userManagementLevel(exists[0]) >= userManagementLevel(req.user)) { await connection.rollback(); return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 관리할 수 있습니다." }); }
    const actors = await run("SELECT login_id AS username FROM user_profile WHERE user_id=?", [req.user.id]);
    if (!actors.length) { await connection.rollback(); return res.status(403).json({ error: "처리자 정보를 확인하지 못했습니다." }); }
    if (status === "APPROVED" && exists[0].status === "PENDING") await run("UPDATE user_profile SET user_status='APPROVED',permission_level=1,role='USER',approved_at=NOW(),approved_by=? WHERE user_id=?", [req.user.id, id]);
    else if (status === "APPROVED") await run("UPDATE user_profile SET user_status='APPROVED',approved_at=NOW(),approved_by=? WHERE user_id=?", [req.user.id, id]);
    else await run("UPDATE user_profile SET user_status=?,approved_at=NULL,approved_by=NULL WHERE user_id=?", [status, id]);
    const eventType = status === "APPROVED" && exists[0].status === "WITHDRAWAL_PENDING" ? "WITHDRAWAL_REJECTION" : { APPROVED: "APPROVAL", REJECTED: "REJECTION", SUSPENDED: "SUSPENSION" }[status] || "STATUS";
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,?,?,?,?)", [id, exists[0].username, eventType, reason.comment, req.user.id, actors[0].username]);
    await connection.commit();
    if (status === "SUSPENDED") forceSuspendUser(id);
    for (const session of sessions.values()) if (Number(session.user.id) === id) session.user.status = status;
    res.json({ ok: true, message: status === "APPROVED" ? "승인되었습니다." : "상태가 변경되었습니다." });
  } catch (err) { if (connection) await connection.rollback(); console.error(err); res.status(500).json({ error: "회원 상태 변경 오류" }); }
  finally { connection?.release(); }
});

app.put("/api/admin/users/:id", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  const hasOrganizationId = Object.hasOwn(req.body, "organizationId");
  const rawOrganizationId = req.body.organizationId;
  let organizationId = rawOrganizationId == null || String(rawOrganizationId).trim() === "" ? null : Number(rawOrganizationId);
  if (organizationId !== null && (!Number.isSafeInteger(organizationId) || organizationId < 1)) return res.status(400).json({ error: "회사 조직을 선택하세요.", field: "organizationId" });
  try {
    const target = await query("SELECT login_id,role,permission_level,organization_id FROM user_profile WHERE user_id=?", [id]);
    if (!target.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    const data = validateProfile({ ...req.body, username: target[0].login_id }, { passwordRequired: false });
    if (data.error) return res.status(400).json({ error: data.error, field: data.field });
    if (await hasDuplicateProfilePhone(data.phone, id)) return res.status(409).json({ error: "이미 사용 중인 전화번호입니다.", field: "phone" });
    const duplicate = data.email ? await query("SELECT user_id AS id FROM user_profile WHERE email=? AND user_id<>? LIMIT 1", [data.email, id]) : [];
    if (duplicate.length) return res.status(409).json({ error: "이메일이 다른 회원과 중복됩니다.", field: "email" });
    const requestedLevel = Number(req.body.permissionLevel);
    if (!Number.isInteger(requestedLevel) || requestedLevel < 1 || requestedLevel > MAX_PERMISSION_LEVEL) return res.status(400).json({ error: `권한 레벨은 1~${MAX_PERMISSION_LEVEL} 사이로 입력하세요.`, field: "permissionLevel" });
    const adminMemo = String(req.body.adminMemo || "").trim();
    if (adminMemo.length > 5000) return res.status(400).json({ error: "관리자 메모는 5000자 이내로 입력하세요.", field: "adminMemo" });
    if (!hasOrganizationId) organizationId = target[0].organization_id ?? null;
    let organizationCodes = null;
    if (organizationId !== null) {
      const organizations = await query("SELECT organization_id,group_code,company,site,department,job FROM company_organization WHERE organization_id=?", [organizationId]);
      if (!organizations.length) return res.status(400).json({ error: "선택한 회사 조직이 없습니다.", field: "organizationId" });
      organizationCodes = organizations[0];
    }
    const organizationGroupCode = String(organizationCodes?.group_code || "").toUpperCase();
    if (!organizationGroupCode) return res.status(400).json({ error: "그룹이 지정된 회사 조직을 선택하세요.", field: "organizationId" });
    if (target[0].role === "MASTER") {
      if (requestedLevel !== MAX_PERMISSION_LEVEL || organizationGroupCode !== "ZZZ" || !["company", "site", "department", "job"].every(field => organizationCodes[field] === null)) return res.status(400).json({ error: "MASTER는 25레벨과 ZZZ/NULL/NULL/NULL/NULL 조직을 유지해야 합니다.", field: "organizationId" });
    } else if (requestedLevel >= MIN_PROGRAMMER_LEVEL && organizationGroupCode !== "ZZZ") return res.status(400).json({ error: "21~25레벨 계정은 ZZZ 프로그래머 조직을 선택해야 합니다.", field: "organizationId" });
    const adminLevel = userManagementLevel(req.user), targetLevel = userManagementLevel(target[0]);
    if (id === req.user.id && requestedLevel !== Number(target[0].permission_level)) return res.status(403).json({ error: "자신의 권한 등급은 변경할 수 없습니다." });
    if (id !== req.user.id && targetLevel >= adminLevel) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 수정할 수 있습니다." });
    const maximumAssignableLevel = req.user.role === "MASTER" ? MAX_PERMISSION_LEVEL : adminLevel > MAX_SITE_PERMISSION_LEVEL ? adminLevel - 1 : adminLevel;
    if (id !== req.user.id && requestedLevel > maximumAssignableLevel) return res.status(403).json({ error: "자신보다 낮은 등급만 부여할 수 있습니다.", field: "permissionLevel" });
    if (data.password) await query(`UPDATE user_profile SET user_name=?,organization_id=?,phone=?,address=?,email=?,password_hash=?,permission_level=?,admin_memo=? WHERE user_id=?`, [data.name, organizationId, data.phone, data.address, data.email, hashPassword(data.password), requestedLevel, adminMemo, id]);
    else await query(`UPDATE user_profile SET user_name=?,organization_id=?,phone=?,address=?,email=?,permission_level=?,admin_memo=? WHERE user_id=?`, [data.name, organizationId, data.phone, data.address, data.email, requestedLevel, adminMemo, id]);
    for (const session of sessions.values()) {
      if (Number(session.user.id) === id) session.user.permissionLevel = requestedLevel;
    }
    if (id !== req.user.id) closeUserSockets(id, 4002, "권한 변경");
    res.json({ ok: true, message: "회원정보가 수정되었습니다." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) return res.status(409).json({ error: "전화번호 또는 이메일이 다른 회원과 중복됩니다.", field: profileUniqueViolationField(err) });
    console.error(err); res.status(500).json({ error: "관리자 회원정보 수정 오류" });
  }
});

app.delete("/api/admin/users/:id", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  if (id === req.user.id) return res.status(403).json({ error: "현재 로그인한 관리자 계정은 삭제할 수 없습니다." });
  const action = req.body?.action ?? "DELETE";
  if (!["DELETE", "WITHDRAWAL_APPROVAL"].includes(action)) return res.status(400).json({ error: "잘못된 삭제 처리입니다." });
  const reason = validateRegisterComment(req.body?.comment, false);
  if (reason.error) return res.status(400).json({ error: reason.error });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const run = (sql, params) => connectionQuery(connection, sql, params);
    const rows = await run("SELECT user_id AS id,login_id AS username,role,permission_level,user_status AS status FROM user_profile WHERE user_id=? FOR UPDATE", [id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "회원을 찾을 수 없습니다." }); }
    if (userManagementLevel(rows[0]) >= userManagementLevel(req.user)) { await connection.rollback(); return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 삭제할 수 있습니다." }); }
    if (action === "WITHDRAWAL_APPROVAL" && rows[0].status !== "WITHDRAWAL_PENDING") { await connection.rollback(); return res.status(409).json({ error: "탈퇴 신청 상태가 변경되었습니다. 목록을 다시 확인하세요." }); }
    const actors = await run("SELECT login_id AS username FROM user_profile WHERE user_id=?", [req.user.id]);
    if (!actors.length) { await connection.rollback(); return res.status(403).json({ error: "처리자 정보를 확인하지 못했습니다." }); }
    await run("INSERT INTO user_register_comment (user_id,login_id,event_type,comment,actor_user_id,actor_login_id) VALUES (?,?,?,?,?,?)", [id, rows[0].username, action === "WITHDRAWAL_APPROVAL" ? "WITHDRAWAL_APPROVAL" : "DELETION", reason.comment, req.user.id, actors[0].username]);
    await run("DELETE FROM user_profile WHERE user_id=?", [id]);
    await connection.commit();
    forceLogoutUser(id);
    res.json({ ok: true, message: "회원이 삭제되었습니다." });
  } catch (err) { if (connection) await connection.rollback(); console.error(err); res.status(500).json({ error: "회원 삭제 오류" }); }
  finally { connection?.release(); }
});

// ---------------------------------------------------------
// 생산현황 API
// ---------------------------------------------------------
app.get("/api/server-status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});
app.get("/api/health", async (req, res) => { try { await query("SELECT 1 AS ok"); res.json({ ok: true, database: "connected" }); } catch { res.status(500).json({ ok: false, database: "error" }); } });

// 제품 목록/단건 조회 시 최종 변경자의 로그인 아이디를 함께 가져옵니다.
const PRODUCT_FIELDS = "p.product_id AS id,p.product_code,p.product_name,p.quantity,p.quantity AS cumulative_quantity,p.work_quantity,p.target_quantity,p.product_status AS status,p.is_enabled,p.sort_order,p.updated_at,p.updated_by,COALESCE(NULLIF(p.updated_by_label,''),u.login_id) AS updated_by_name";
const PRODUCT_JOIN = "FROM product p LEFT JOIN user_profile u ON u.user_id = p.updated_by";

app.get("/api/products", requireLogin, requireActiveAccount, requireApproved, async (req, res) => { try { res.json(await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`)); } catch (err) { console.error(err); res.status(500).json({ error: "DB 조회 오류" }); } });

app.get("/api/admin/products/report", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.query.format !== undefined && !["json", "xlsx"].includes(req.query.format)) return res.status(400).json({ error: "지원하지 않는 출력 형식입니다." });
  try {
    const report = await loadProductReport(query, req.query);
    if (req.query.format === "xlsx") {
      const buffer = await createProductWorkbook(report);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="product-report.xlsx"');
      return res.send(buffer);
    }
    res.json(report);
  } catch (err) {
    if (!err.code) return res.status(400).json({ error: err.message });
    console.error("생산 리포트 오류:", err);
    res.status(500).json({ error: "생산 리포트를 생성하지 못했습니다." });
  }
});

app.get("/api/admin/products/report/options", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await query("SELECT product_id AS id,product_code,product_name,is_enabled FROM product WHERE is_enabled=1 ORDER BY sort_order,product_id"));
  } catch (err) {
    console.error("생산 리포트 선택 목록 오류:", err);
    res.status(500).json({ error: "제품 목록을 조회하지 못했습니다." });
  }
});

app.get("/api/admin/products", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try {
    res.json(await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} ORDER BY p.sort_order,p.product_id`));
  } catch (err) {
    console.error("관리자 제품 목록 조회 오류:", err);
    res.status(500).json({ error: "제품 목록을 조회하지 못했습니다." });
  }
});

app.put("/api/products/:id/quantity", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  const productionInput = req.body.kind === "production";
  let data;
  if (productionInput) {
    const rawQuantity = req.body.quantity;
    const quantity = rawQuantity === null || rawQuantity === undefined || typeof rawQuantity === "boolean" || String(rawQuantity).trim() === "" ? null : Number(rawQuantity);
    const reason = parseQuantityReason(req.body.reason);
    if (!Number.isInteger(quantity) || quantity < -2147483647 || quantity > 2147483647) return res.status(400).json({ error: "입력 수량은 -2,147,483,647~2,147,483,647 사이의 정수로 입력하세요." });
    if (!reason) return res.status(400).json({ error: "작업 내용을 1~500자로 입력하세요." });
    data = { quantity, reason };
  } else data = validateQuantityEdit(req.body);
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    let result;
    if (productionInput) {
      const minimumBeforeIncrement = Math.max(0, -data.quantity);
      const maximumBeforeIncrement = 2147483647 - Math.max(0, data.quantity);
      result = await query(`UPDATE product SET quantity=quantity+?,work_quantity=work_quantity+?,quantity_reason=?,quantity_actor=?,quantity_change_type='MANUAL',updated_by=?,updated_by_label=NULL,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND quantity>=? AND work_quantity>=? AND quantity<=? AND work_quantity<=?`, [data.quantity, data.quantity, data.reason, req.user.username, req.user.id, id, minimumBeforeIncrement, minimumBeforeIncrement, maximumBeforeIncrement, maximumBeforeIncrement]);
    } else {
      result = await query(`UPDATE product SET ${data.column}=?,quantity_reason=?,quantity_actor=?,quantity_change_type='MANUAL',updated_by=?,updated_by_label=NULL,updated_at=CURRENT_TIMESTAMP WHERE product_id=?`, [data.quantity, data.reason, req.user.username, req.user.id, id]);
    }
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    if (productionInput && result.affectedRows === 0 && data.quantity !== 0) {
      const nextQuantity = Number(rows[0].quantity) + data.quantity;
      const nextWorkQuantity = Number(rows[0].work_quantity) + data.quantity;
      if (nextQuantity < 0 || nextQuantity > 2147483647 || nextWorkQuantity < 0 || nextWorkQuantity > 2147483647) return res.status(400).json({ error: "누적 수량 또는 작업 수량이 허용 범위를 벗어납니다." });
      return res.status(409).json({ error: "수량이 변경되었습니다. 최신 값을 확인한 뒤 다시 입력하세요." });
    }
    if (!productionInput && result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    if (Number(rows[0]?.is_enabled) === 1) broadcast({ type: "quantityUpdated", product: rows[0] });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: "DB 업데이트 오류" }); }
});

app.put("/api/products/:id/status", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id), status = String(req.body.status || "").trim();
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return res.status(400).json({ error: "상태값이 올바르지 않습니다." });
  try {
    const result = await query(
      `UPDATE product SET product_status=?,quantity_reason='상태 변경',quantity_actor=?,quantity_change_type='STATUS',updated_by=?,updated_by_label=NULL,updated_at=CURRENT_TIMESTAMP WHERE product_id=?`,
      [status, req.user.username, req.user.id, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]);
    if (Number(rows[0]?.is_enabled) === 1) broadcast({ type: "productUpdated", product: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "상태 업데이트 오류" });
  }
});

function validateProduct(body) {
  const productCode = String(body.productCode || "").trim();
  const productName = String(body.productName || "").trim();
  const quantity = parseQuantity(body.quantity);
  const targetQuantity = parseQuantity(body.targetQuantity);
  const workQuantity = body.workQuantity === undefined ? null : parseQuantity(body.workQuantity);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const status = String(body.status || "대기").trim();
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(productCode)) return { error: "제품코드는 영문, 숫자, _, -만 사용하여 1~50자로 입력하세요." };
  if (productName.length < 1 || productName.length > 100) return { error: "제품명은 1~100자로 입력하세요." };
  if (quantity === null) return { error: "누적 수량은 0~2,147,483,647 사이의 정수로 입력하세요." };
  if (body.workQuantity !== undefined && workQuantity === null) return { error: "작업 수량은 0~2,147,483,647 사이의 정수로 입력하세요." };
  if (targetQuantity === null) return { error: "목표수량은 0~2,147,483,647 사이의 정수로 입력하세요." };
  if (reason.length > 500) return { error: "수정 사유는 500자 이내로 입력하세요." };
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return { error: "상태값이 올바르지 않습니다." };
  return { productCode, productName, quantity, workQuantity, targetQuantity, reason, status };
}

app.post("/api/admin/products", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  const data = validateProduct(req.body);
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const exists = await query("SELECT product_id AS id FROM product WHERE product_code=? LIMIT 1", [data.productCode]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const orderRows = await query("SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM product");
    const result = await query("INSERT INTO product (product_code,product_name,quantity,work_quantity,target_quantity,product_status,sort_order,updated_by,quantity_reason,quantity_actor,quantity_change_type) VALUES (?,?,?,?,?,?,?,?,?,?,'CREATE')", [data.productCode, data.productName, data.quantity, data.workQuantity ?? data.quantity, data.targetQuantity, data.status, Number(orderRows[0]?.next_order || 0), req.user.id, data.reason || "제품 등록", req.user.username]);
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [result.insertId]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`) });
    res.status(201).json(rows[0]);
  } catch (err) { console.error("제품 추가 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 추가 오류" }); }
});

app.put("/api/admin/products/order", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  const productIds = req.body.productIds;
  if (!Array.isArray(productIds)) return res.status(400).json({ error: "제품 순서 정보가 올바르지 않습니다." });

  const orderedIds = productIds.map(Number);
  if (orderedIds.some(id => !Number.isInteger(id) || id <= 0) || new Set(orderedIds).size !== orderedIds.length) {
    return res.status(400).json({ error: "제품 순서 정보가 올바르지 않습니다." });
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const rows = await connectionQuery(connection, "SELECT product_id FROM product ORDER BY product_id FOR UPDATE");
    const existingIds = rows.map(row => Number(row.product_id));
    if (existingIds.length !== orderedIds.length || existingIds.some(id => !orderedIds.includes(id))) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({ error: "제품 목록이 변경되었습니다. 새로고침 후 다시 정렬하세요." });
    }

    for (const [sortOrder, productId] of orderedIds.entries()) {
      await connectionQuery(connection, "UPDATE product SET sort_order=?,updated_at=updated_at WHERE product_id=?", [sortOrder, productId]);
    }
    await connection.commit();
    transactionStarted = false;
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    console.error("제품 순서 저장 오류:", err);
    return res.status(500).json({ error: "제품 순서를 저장하지 못했습니다." });
  } finally {
    connection.release();
  }

  try {
    const products = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`);
    broadcast({ type: "productsChanged", products });
    res.json({ ok: true });
  } catch (err) {
    console.error("제품 순서 반영 알림 오류:", err);
    res.status(500).json({ error: "제품 순서는 저장했지만 화면 갱신 알림을 보내지 못했습니다." });
  }
});

app.put("/api/admin/products/:id/active", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  if (typeof req.body.isEnabled !== "boolean") return res.status(400).json({ error: "제품 사용 여부가 올바르지 않습니다." });

  try {
    const result = await query("UPDATE product SET is_enabled=?,updated_by=?,updated_by_label=NULL,updated_at=CURRENT_TIMESTAMP WHERE product_id=?", [req.body.isEnabled ? 1 : 0, req.user.id, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    const products = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`);
    broadcast({ type: "productsChanged", products });
    res.json({ ok: true, isEnabled: req.body.isEnabled });
  } catch (err) {
    console.error("제품 사용 상태 변경 오류:", err);
    res.status(500).json({ error: "제품 사용 상태를 변경하지 못했습니다." });
  }
});

app.put("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  const id = Number(req.params.id);
  const data = validateProduct(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  if (data.error) return res.status(400).json({ error: data.error });
  if (!data.reason) return res.status(400).json({ error: "수정 사유를 1~500자로 입력하세요." });
  try {
    const existing = await query("SELECT product_code FROM product WHERE product_id=? LIMIT 1", [id]);
    if (!existing.length) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    if (data.productCode !== existing[0].product_code) return res.status(400).json({ error: "제품 수정 시 제품코드는 변경할 수 없습니다." });
    await query("UPDATE product SET product_name=?,quantity=?,work_quantity=COALESCE(?,work_quantity),target_quantity=?,product_status=?,updated_by=?,updated_by_label=NULL,quantity_reason=?,quantity_actor=?,quantity_change_type='ADMIN' WHERE product_id=?", [data.productName, data.quantity, data.workQuantity, data.targetQuantity, data.status, req.user.id, data.reason, req.user.username, id]);
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`) });
    res.json(rows[0]);
  } catch (err) { console.error("제품 수정 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 수정 오류" }); }
});

app.delete("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  try {
    const result = await query("DELETE FROM product WHERE product_id=?", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`) });
    res.json({ ok: true, message: "제품이 삭제되었습니다." });
  } catch (err) { console.error("제품 삭제 오류:", err); res.status(500).json({ error: "제품 삭제 오류" }); }
});

// ---------------------------------------------------------
// 제품-채널 연결 API (8등급 이상)
// ---------------------------------------------------------
function parseOutputSignal(value) {
  const signal = String(value || "").trim().toUpperCase();
  return /^OS([1-9]|1[0-6])$/.test(signal) ? signal : "";
}

const productChannelAdminMiddleware = [
  requireLogin,
  requireActiveAccount,
  requireApproved,
  requireAdminLevel(8)
];

app.get("/api/admin/product-channel-mappings/meta", productChannelAdminMiddleware, async (req, res) => {
  try {
    const products = await query(
      `SELECT product_id AS id,product_code,product_name,is_enabled
       FROM product
       WHERE is_enabled=1
       ORDER BY sort_order,product_id`
    );
    const channels = await query(
      `SELECT c.device_id,c.output_signal,c.channel_name,c.is_active AS is_visible,d.device_name,d.is_visible AS device_is_visible,d.is_enabled AS device_is_enabled
       FROM device_channel c
      JOIN device d ON d.device_code=c.device_id
      WHERE d.is_enabled=1
      ORDER BY d.sort_order,d.device_id,c.sort_order,c.channel_id`
    );
    res.json({ products, channels });
  } catch (err) {
    console.error("제품-채널 메타 조회 오류:", err);
    res.status(500).json({ error: "제품/채널 목록을 조회하지 못했습니다." });
  }
});

app.get("/api/admin/product-channel-mappings", productChannelAdminMiddleware, async (req, res) => {
  try {
    const rows = await query(
            `SELECT m.mapping_id AS id,m.product_id,m.device_id,m.output_signal,m.mapping_name,m.is_active,m.created_at,m.updated_at,
              p.product_code,p.product_name,c.channel_name,c.is_active AS channel_is_visible,d.device_name,d.is_visible AS device_is_visible,d.is_enabled AS device_is_enabled,
              u.login_id AS created_by_name
       FROM product_channel_mapping m
       JOIN product p ON p.product_id=m.product_id
       JOIN device_channel c ON c.device_id=m.device_id AND c.output_signal=m.output_signal
      JOIN device d ON d.device_code=m.device_id
       LEFT JOIN user_profile u ON u.user_id=m.created_by
       ORDER BY m.mapping_id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("제품-채널 연결 목록 조회 오류:", err);
    res.status(500).json({ error: "제품-채널 연결 목록을 조회하지 못했습니다." });
  }
});

app.post("/api/admin/product-channel-mappings", productChannelAdminMiddleware, async (req, res) => {
  const productId = Number(req.body.productId);
  const deviceId = String(req.body.deviceId || "").trim();
  const outputSignal = parseOutputSignal(req.body.outputSignal);
  const mappingName = String(req.body.mappingName || "").trim();

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: "유효한 제품을 선택하세요." });
  }
  if (!deviceId) {
    return res.status(400).json({ error: "유효한 디바이스를 선택하세요." });
  }
  if (!outputSignal) {
    return res.status(400).json({ error: "유효한 채널을 선택하세요." });
  }
  if (!mappingName || mappingName.length > 100) {
    return res.status(400).json({ error: "연결 명칭은 1자 이상 100자 이하로 입력하세요." });
  }

  try {
    const products = await query("SELECT product_id FROM product WHERE product_id=? AND is_enabled=1 LIMIT 1", [productId]);
    if (!products.length) return res.status(404).json({ error: "사용 중인 제품을 선택하세요. 제품이 비활성화되었거나 삭제되었습니다." });

    const channels = await query(
      `SELECT c.channel_id
       FROM device_channel c
      JOIN device d ON d.device_code=c.device_id
        WHERE c.device_id=? AND c.output_signal=? AND d.is_enabled=1
       LIMIT 1`,
      [deviceId, outputSignal]
    );
    if (!channels.length) return res.status(404).json({ error: "사용 중인 디바이스의 채널을 선택하세요. 디바이스가 비활성화되었거나 채널이 삭제되었습니다." });

    await query(
      `INSERT INTO product_channel_mapping(product_id,device_id,output_signal,mapping_name,is_active,created_by)
       VALUES(?,?,?,?,1,?)`,
      [productId, deviceId, outputSignal, mappingName, req.user.id]
    );

    res.status(201).json({ ok: true, message: "제품-채널 연결이 등록되었습니다." });
  } catch (err) {
    console.error("제품-채널 연결 등록 오류:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "이미 등록된 제품-채널 연결입니다." });
    }
    res.status(500).json({ error: "제품-채널 연결을 등록하지 못했습니다." });
  }
});

app.put("/api/admin/product-channel-mappings/:id", productChannelAdminMiddleware, async (req, res) => {
  const mappingId = Number(req.params.id);
  const productId = Number(req.body.productId);
  const deviceId = String(req.body.deviceId || "").trim();
  const outputSignal = parseOutputSignal(req.body.outputSignal);
  const mappingName = String(req.body.mappingName || "").trim();

  if (!Number.isInteger(mappingId) || mappingId <= 0) {
    return res.status(400).json({ error: "잘못된 연결 ID입니다." });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: "유효한 제품을 선택하세요." });
  }
  if (!deviceId) {
    return res.status(400).json({ error: "유효한 디바이스를 선택하세요." });
  }
  if (!outputSignal) {
    return res.status(400).json({ error: "유효한 채널을 선택하세요." });
  }
  if (!mappingName || mappingName.length > 100) {
    return res.status(400).json({ error: "연결 명칭은 1자 이상 100자 이하로 입력하세요." });
  }

  try {
    const mappings = await query("SELECT mapping_id FROM product_channel_mapping WHERE mapping_id=? LIMIT 1", [mappingId]);
    if (!mappings.length) return res.status(404).json({ error: "연결 정보를 찾을 수 없습니다." });

    const products = await query("SELECT product_id FROM product WHERE product_id=? AND is_enabled=1 LIMIT 1", [productId]);
    if (!products.length) return res.status(404).json({ error: "사용 중인 제품을 선택하세요. 제품이 비활성화되었거나 삭제되었습니다." });

    const channels = await query(
      `SELECT c.channel_id
       FROM device_channel c
      JOIN device d ON d.device_code=c.device_id
        WHERE c.device_id=? AND c.output_signal=? AND d.is_enabled=1
       LIMIT 1`,
      [deviceId, outputSignal]
    );
    if (!channels.length) return res.status(404).json({ error: "사용 중인 디바이스의 채널을 선택하세요. 디바이스가 비활성화되었거나 채널이 삭제되었습니다." });

    await query(
      `UPDATE product_channel_mapping
       SET product_id=?,device_id=?,output_signal=?,mapping_name=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE mapping_id=?`,
      [productId, deviceId, outputSignal, mappingName, mappingId]
    );

    res.json({ ok: true, message: "제품-채널 연결이 수정되었습니다." });
  } catch (err) {
    console.error("제품-채널 연결 수정 오류:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "이미 등록된 제품-채널 연결입니다." });
    }
    res.status(500).json({ error: "제품-채널 연결을 수정하지 못했습니다." });
  }
});

app.delete("/api/admin/product-channel-mappings/:id", productChannelAdminMiddleware, async (req, res) => {
  const mappingId = Number(req.params.id);
  if (!Number.isInteger(mappingId) || mappingId <= 0) {
    return res.status(400).json({ error: "잘못된 연결 ID입니다." });
  }

  try {
    const result = await query("DELETE FROM product_channel_mapping WHERE mapping_id=?", [mappingId]);
    if (!result.affectedRows) return res.status(404).json({ error: "연결 정보를 찾을 수 없습니다." });
    res.json({ ok: true, message: "제품-채널 연결이 삭제되었습니다." });
  } catch (err) {
    console.error("제품-채널 연결 삭제 오류:", err);
    res.status(500).json({ error: "제품-채널 연결을 삭제하지 못했습니다." });
  }
});

// ---------------------------------------------------------
// Device D1 R1 통합 기능
// ---------------------------------------------------------
const DEVICE_CHANNEL_COUNT = 16;
const LEGACY_DEVICE_PREFIX = "wemos";
const DEVICE_CHANNELS = Array.from({ length: DEVICE_CHANNEL_COUNT }, (_, index) => ({
  index: index + 1,
  inputPin: `IS${index + 1}`,
  outputPin: `OS${index + 1}`
}));
const DEVICE_OUTPUT_PINS = new Set(DEVICE_CHANNELS.map(channel => channel.outputPin));

function normalizeDeviceState(value) {
  return String(value || "").toUpperCase() === "ON" ? "ON" : "OFF";
}
function parseDeviceState(value) {
  const state = String(value || "").toUpperCase();
  return state === "ON" || state === "OFF" ? state : null;
}
function normalizeDevicePin(value) {
  const pin = String(value || "").trim().toUpperCase();
  if (DEVICE_OUTPUT_PINS.has(pin)) return pin;

  // V0의 D8/D9/D10/D11 명령도 새 OS1~OS16 구조와 충돌하지 않도록 호환합니다.
  const legacyMap = { D8: "OS1", D9: "OS2", D10: "OS3", D11: "OS4" };
  return legacyMap[pin] || "";
}
function channelNumberFromPin(pin) {
  const match = /^OS([1-9]|1[0-6])$/.exec(String(pin || "").toUpperCase());
  return match ? Number(match[1]) : 0;
}
function stringifyWebSocketMessage(message) {
  return JSON.stringify(message, (key, value) => typeof value === "bigint" ? value.toString() : value);
}
function sendDevice(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = ws.legacyDeviceSubscriber && message.type === "deviceSnapshot"
      ? { ...message, type: `${LEGACY_DEVICE_PREFIX}Snapshot` } : message;
    ws.send(stringifyWebSocketMessage(payload));
  }
}
function broadcastDeviceBrowsers(message) {
  const data = stringifyWebSocketMessage(message);
  for (const ws of clients) {
    if (ws.deviceSubscriber === true && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
// device.device_id는 내부 숫자 키이며, 장치 식별 문자열은 device_code에 보관합니다.
async function ensureDeviceSchema() {
  await query(`CREATE TABLE IF NOT EXISTS device (
    device_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_code VARCHAR(100) NOT NULL,
    device_name VARCHAR(100) NOT NULL DEFAULT '',
    token_hash CHAR(64) NULL,
    token_ciphertext TEXT NULL,
    is_visible TINYINT(1) NOT NULL DEFAULT 1,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    last_ip VARCHAR(45) NULL,
    last_seen_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (device_id), UNIQUE KEY uq_device_device_code (device_code)
  ) ENGINE=InnoDB`);

  const deviceCodeColumns = await query("SHOW COLUMNS FROM device LIKE 'device_code'");
  const legacyDeviceIdColumns = await query("SHOW COLUMNS FROM device LIKE 'device_id'");
  if (!deviceCodeColumns.length && !legacyDeviceIdColumns.length) {
    throw new Error("device 테이블에 device_code 식별 컬럼이 없습니다.");
  }
  if (!deviceCodeColumns.length) {
    const references = await query(`SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS constraint_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='device' AND REFERENCED_COLUMN_NAME='device_id'`);
    const foreignKeys = {
      device_channel: "fk_device_channel_device",
      device_schedule: "fk_schedule_device",
      device_command: "fk_device_command_device",
      device_state_history: "fk_device_history_device"
    };
    const droppedReferences = new Set();
    for (const reference of references) {
      if (foreignKeys[reference.table_name] !== reference.constraint_name) {
        throw new Error(`device.device_id를 참조하는 알 수 없는 외래키가 있습니다 (${reference.table_name}.${reference.constraint_name}).`);
      }
      const key = `${reference.table_name}.${reference.constraint_name}`;
      if (droppedReferences.has(key)) continue;
      await query(`ALTER TABLE ${reference.table_name} DROP FOREIGN KEY ${reference.constraint_name}`);
      droppedReferences.add(key);
    }

    await query("ALTER TABLE device CHANGE COLUMN device_id device_code VARCHAR(100) NOT NULL");
    const legacyUniqueIndex = await query("SHOW INDEX FROM device WHERE Key_name='uq_device_device_id'");
    if (legacyUniqueIndex.length) await query("ALTER TABLE device DROP INDEX uq_device_device_id");
    await query("ALTER TABLE device ADD UNIQUE KEY uq_device_device_code (device_code)");

    for (const reference of references) {
      const key = `${reference.table_name}.${reference.constraint_name}`;
      if (!droppedReferences.has(key)) continue;
      await query(`ALTER TABLE ${reference.table_name} ADD CONSTRAINT ${reference.constraint_name} FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE`);
    }
  }

  const deviceRowIdColumns = await query("SHOW COLUMNS FROM device LIKE 'device_row_id'");
  const deviceIdColumns = await query("SHOW COLUMNS FROM device LIKE 'device_id'");
  if (deviceRowIdColumns.length && deviceIdColumns.length && deviceCodeColumns.length) {
    throw new Error("device 테이블에 숫자 device_id와 device_row_id가 함께 있습니다. 컬럼 상태를 확인하세요.");
  }
  if (deviceRowIdColumns.length) {
    await query("ALTER TABLE device CHANGE COLUMN device_row_id device_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT");
  } else if (!deviceIdColumns.length) {
    throw new Error("device 테이블에 숫자 device_id 기본키가 없습니다.");
  }

  const deviceTokenColumns = await query("SHOW COLUMNS FROM device LIKE 'token_ciphertext'");
  if (!deviceTokenColumns.length) await query("ALTER TABLE device ADD COLUMN token_ciphertext TEXT NULL AFTER token_hash");

  const deviceVisibleColumns = await query("SHOW COLUMNS FROM device LIKE 'is_visible'");
  const deviceActiveColumns = await query("SHOW COLUMNS FROM device LIKE 'is_active'");
  if (!deviceVisibleColumns.length && deviceActiveColumns.length) {
    await query("ALTER TABLE device CHANGE COLUMN is_active is_visible TINYINT(1) NOT NULL DEFAULT 1");
  } else if (!deviceVisibleColumns.length) {
    await query("ALTER TABLE device ADD COLUMN is_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER device_name");
  } else if (deviceActiveColumns.length) {
    await query("UPDATE device SET is_visible=is_active");
    await query("ALTER TABLE device DROP COLUMN is_active");
  }

  const deviceEnabledColumns = await query("SHOW COLUMNS FROM device LIKE 'is_enabled'");
  if (!deviceEnabledColumns.length) {
    await query("ALTER TABLE device ADD COLUMN is_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_visible");
  }

  await query(`CREATE TABLE IF NOT EXISTS device_channel (
    channel_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    channel_name VARCHAR(100) NOT NULL,
    input_signal VARCHAR(20) NOT NULL,
    output_signal VARCHAR(20) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    web_control_enabled TINYINT(1) NOT NULL DEFAULT 1,
    web_on_enabled TINYINT(1) NOT NULL DEFAULT 1,
    web_off_enabled TINYINT(1) NOT NULL DEFAULT 1,
    web_schedule_enabled TINYINT(1) NOT NULL DEFAULT 1,
    output_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    input_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    input_message TEXT NULL,
    output_message TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (channel_id),
    UNIQUE KEY uq_device_channel_input(device_id,input_signal),
    UNIQUE KEY uq_device_channel_output(device_id,output_signal),
    CONSTRAINT fk_device_channel_device FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  const controlColumns = await query("SHOW COLUMNS FROM device_channel LIKE 'web_control_enabled'");
  if (!controlColumns.length) {
    await query("ALTER TABLE device_channel ADD COLUMN web_control_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active");
  }
  for (const column of ["web_on_enabled", "web_off_enabled", "web_schedule_enabled"]) {
    const columns = await query(`SHOW COLUMNS FROM device_channel LIKE '${column}'`);
    if (!columns.length) await query(`ALTER TABLE device_channel ADD COLUMN ${column} TINYINT(1) NOT NULL DEFAULT 1`);
  }

  await query(`CREATE TABLE IF NOT EXISTS device_schedule (
    schedule_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL,
    schedule_name VARCHAR(150) NOT NULL DEFAULT '',
    action_state ENUM('ON','OFF') NOT NULL,
    ostr_payload TEXT NULL,
    repeat_type ENUM('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY','IMMEDIATE') NOT NULL DEFAULT 'ONCE',
    schedule_time DATETIME(3) NULL,
    end_time DATETIME(3) NULL,
    weekday_mask TINYINT UNSIGNED NULL,
    is_month_end TINYINT(1) NOT NULL DEFAULT 0,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    next_run_at DATETIME(3) NULL,
    last_run_at DATETIME(3) NULL,
    last_execution_status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
    last_execution_message TEXT NULL,
    created_by VARCHAR(50) NULL,
    updated_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    completed_at DATETIME(3) NULL,
    PRIMARY KEY (schedule_id),
    KEY idx_schedule_due (is_enabled,next_run_at),
    KEY idx_schedule_channel (device_id,output_signal),
    KEY idx_schedule_owner (created_by),
    CONSTRAINT fk_schedule_device FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_updater FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await migrateScheduleOutputString();
  await migrateScheduleEndTime();
  await migrateScheduleRepeatType();
  await migrateScheduleRecurrenceColumns();
  await migrateScheduleCreatedBy();

  await query(`CREATE TABLE IF NOT EXISTS device_command (
    command_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    command_id CHAR(36) NOT NULL,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
    requested_output_state ENUM('ON','OFF') NOT NULL,
    output_message TEXT NULL,
    istr_payload TEXT NULL,
    requested_by VARCHAR(100) NOT NULL DEFAULT 'CLIENT',
    schedule_id BIGINT UNSIGNED NULL,
    command_status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    status_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (command_row_id), UNIQUE KEY uq_device_command_id (command_id),
    KEY idx_device_poll (device_id,command_status,command_row_id),
    CONSTRAINT fk_device_command_device FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  try { await query("ALTER TABLE device_command ADD COLUMN istr_payload TEXT NULL AFTER output_message"); }
  catch (err) { if (!/duplicate column|already exists|Duplicate column name/i.test(String(err.message || err))) throw err; }

  await query(`CREATE TABLE IF NOT EXISTS device_state_history (
    history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
    previous_output_state ENUM('ON','OFF') NULL,
    output_state ENUM('ON','OFF') NOT NULL,
    change_source VARCHAR(100) NOT NULL,
    schedule_id BIGINT UNSIGNED NULL,
    command_id CHAR(36) NULL,
    signal_message TEXT NULL,
    changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (history_id), KEY idx_device_history (device_id,changed_at),
    CONSTRAINT fk_device_history_device FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await migrateScheduleProvenance();

  await query(`INSERT INTO device(device_code,device_name,token_hash,last_change_source)
    VALUES(?,?,?,'BOOT')
    ON DUPLICATE KEY UPDATE
      device_name=IF(device_name='',VALUES(device_name),device_name),
      token_hash=COALESCE(token_hash,VALUES(token_hash))`,
    [DEVICE_ID, DEVICE_ID, DEVICE_TOKEN ? crypto.createHash("sha256").update(DEVICE_TOKEN).digest("hex") : null]);

  await query(`UPDATE device SET sort_order=device_id WHERE sort_order=0`);

  // 재시작해도 기존 채널 설정은 유지하고, 등록된 모든 장치에 없는 채널만 추가합니다.
  const devices = await query(`SELECT device_code AS device_id FROM device`);
  for (const device of devices) {
    for (const channel of DEVICE_CHANNELS) {
      await query(`INSERT IGNORE INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order)
        VALUES(?,?,?,?,?)`,
        [device.device_id, `채널 ${String(channel.index).padStart(2, "0")}`, channel.inputPin, channel.outputPin, channel.index - 1]);
    }
  }

}

async function resolveScheduleSource(source) {
  const rawSource = String(source || "");
  if (/^\d+$/.test(rawSource)) {
    const users = await query("SELECT login_id AS username FROM user_profile WHERE user_id=? LIMIT 1", [rawSource]);
    return users[0]?.username || source;
  }
  const match = /^SCHEDULE:(\d+)(?::(.+))?$/.exec(String(source || ""));
  if (!match) return source;
  if (match[2] && !/^\d+$/.test(match[2])) return match[2];
  if (match[2]) {
    const users = await query("SELECT login_id AS username FROM user_profile WHERE user_id=? LIMIT 1", [match[2]]);
    return users[0]?.username || "";
  }
  const owners = await query("SELECT created_by AS username FROM device_schedule WHERE schedule_id=? LIMIT 1", [match[1]]);
  return owners[0]?.username || "";
}

async function getDeviceState(deviceId = null) {
  const devices = deviceId
    ? await query(`SELECT device_code AS device_id,device_name,is_visible,is_enabled,last_change_source,last_ip,last_seen_at,updated_at,
      COALESCE((SELECT h.schedule_id IS NOT NULL FROM device_state_history h WHERE h.device_id=device.device_code ORDER BY h.history_id DESC LIMIT 1),0) AS last_change_is_scheduled
       FROM device WHERE device_code=?`, [deviceId])
    : await query(`SELECT device_code AS device_id,device_name,is_visible,is_enabled,last_change_source,last_ip,last_seen_at,updated_at,
      COALESCE((SELECT h.schedule_id IS NOT NULL FROM device_state_history h WHERE h.device_id=device.device_code ORDER BY h.history_id DESC LIMIT 1),0) AS last_change_is_scheduled
      FROM device ORDER BY sort_order,device_id`);
  if (!devices.length) return null;

  const device = devices[0];
  const sets = await query(
    `SELECT channel_id AS id,channel_name,input_signal,output_signal,is_active AS is_visible,web_control_enabled,web_on_enabled,web_off_enabled,web_schedule_enabled,output_state,input_state,last_change_source,input_message,output_message,sort_order,
      COALESCE((SELECT h.changed_at FROM device_state_history h
      WHERE h.device_id=device_channel.device_id AND h.output_signal=device_channel.output_signal
          ORDER BY h.history_id DESC LIMIT 1), device_channel.created_at) AS last_changed_at,
        COALESCE((SELECT h.schedule_id IS NOT NULL FROM device_state_history h
        WHERE h.device_id=device_channel.device_id AND h.output_signal=device_channel.output_signal
          ORDER BY h.history_id DESC LIMIT 1),0) AS last_change_is_scheduled
     FROM device_channel WHERE device_id=? ORDER BY sort_order,channel_id`,
    [device.device_id]
  );

  return {
    ...device,
    last_change_source: await resolveScheduleSource(device.last_change_source),
    channels: await Promise.all(sets.map(async set => ({ ...set, last_change_source: await resolveScheduleSource(set.last_change_source) }))),
    // V0 UI 호환용 첫 번째 OS 상태
    output_state: sets.find(set => set.output_signal === "OS1")?.output_state || "OFF"
  };
}

async function getDeviceHistory(limit = 50, deviceId = null) {
  const n = Math.min(Math.max(Number(limit || 50), 1), 50);
  const fields = "history_id AS id,device_id,output_signal,previous_output_state,output_state,change_source,schedule_id,(schedule_id IS NOT NULL) AS is_scheduled,command_id,signal_message,changed_at";
  if (deviceId) return await query(
    `SELECT ${fields}
     FROM device_state_history WHERE device_id=? ORDER BY history_id DESC LIMIT ${n}`, [deviceId]);
  return await query(
    `SELECT ${fields}
     FROM device_state_history ORDER BY history_id DESC LIMIT ${n}`);
}

async function getDeviceCommands(limit = 50, deviceId = null) {
  const n = Math.min(Math.max(Number(limit || 50), 1), 50);
  const fields = `command_row_id AS id,command_id,device_id,output_signal,requested_output_state,output_message,requested_by,schedule_id,(schedule_id IS NOT NULL) AS is_scheduled,command_status,status_changed_at`;
  if (deviceId) return await query(
    `SELECT ${fields} FROM device_command WHERE device_id=? ORDER BY command_row_id DESC LIMIT ${n}`, [deviceId]);
  return await query(
    `SELECT ${fields} FROM device_command ORDER BY command_row_id DESC LIMIT ${n}`);
}

async function trimDeviceTable(tableName, maxRows = 1000, deviceId = null) {
  const idColumn = { device_command: "command_row_id", device_state_history: "history_id" }[tableName];
  if (!idColumn) throw new Error("Unsupported device retention table");
  if (deviceId) {
    await query(`DELETE FROM ${tableName} WHERE device_id=? AND ${idColumn} <= (
      SELECT ${idColumn} FROM (SELECT ${idColumn} FROM ${tableName} WHERE device_id=? ORDER BY ${idColumn} DESC LIMIT 1 OFFSET ${maxRows}) old_rows
    )`, [deviceId, deviceId]);
  } else {
    await query(`DELETE FROM ${tableName} WHERE ${idColumn} <= (
      SELECT ${idColumn} FROM (SELECT ${idColumn} FROM ${tableName} ORDER BY ${idColumn} DESC LIMIT 1 OFFSET ${maxRows}) old_rows
    )`);
  }
}

function getDeviceDeviceSocket(deviceId) {
  const ws = deviceDeviceSockets.get(String(deviceId));
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.deviceIdentified !== true) return null;
  return ws;
}
function isDeviceConnected(deviceId = DEVICE_ID) {
  return Boolean(getDeviceDeviceSocket(deviceId));
}
// 장치가 보고한 실제 상태를 저장합니다. 웹에서 요청한 값만으로 출력 상태를 확정하지 않습니다.
async function recordDeviceState(deviceId, pin, newState, source, commandId = null, recordDeviceCommand = false, message = {}, scheduleId = null) {
  pin = normalizeDevicePin(pin);
  if (!pin) return;
  const inputPin = `IS${channelNumberFromPin(pin)}`;
  const state = parseDeviceState(newState);
  if (!state) return;
  if (commandId && !recordDeviceCommand && scheduleId == null) {
    const commands = await query("SELECT requested_by,schedule_id FROM device_command WHERE command_id=? AND device_id=? LIMIT 1", [commandId, deviceId]);
    if (commands.length) {
      scheduleId = commands[0].schedule_id ?? null;
      source = String(commands[0].requested_by ?? source ?? "");
    }
  }

  const reportedInputString = message.IStr ?? message.sendString;
  const reportedOutputString = message.OStr ?? message.receiveString;
  const reportedInputState = parseDeviceState(message.inputState);
  const deviceOrigin = recordDeviceCommand || source === deviceId || source === "DEVICE";
  const connection = await pool.getConnection();
  let increasedProducts = [];

  try {
    await connection.beginTransaction();

    // 같은 채널의 동시 갱신을 직렬화하여 이전 상태와 변경 이력이 서로 어긋나지 않게 합니다.
    const rows = await connectionQuery(connection,
      `SELECT output_state,input_state,last_change_source,input_message,output_message,
         COALESCE((SELECT h.changed_at FROM device_state_history h
         WHERE h.device_id=device_channel.device_id AND h.output_signal=device_channel.output_signal
          ORDER BY h.history_id DESC LIMIT 1), device_channel.created_at) AS last_changed_at
       FROM device_channel WHERE device_id=? AND output_signal=? LIMIT 1 FOR UPDATE`,
      [deviceId, pin]);

    // ACK 등에 입력 정보가 없으면 기존 값을 유지하고, 명시적인 빈 문자열은 그대로 반영합니다.
    const inputString = String(reportedInputString ?? rows[0]?.input_message ?? "").slice(0, 10000);
    const outputString = String(reportedOutputString ?? rows[0]?.output_message ?? "").slice(0, 10000);
    const historyString = deviceOrigin ? inputString : outputString;
    const inputState = reportedInputState || rows[0]?.input_state || "OFF";
    const previousState = rows.length ? String(rows[0].output_state) : null;
    // 반복 보고는 입력·문자열·접속 시각만 갱신하며, 실제 출력 변경 때만 변경자와 이력을 갱신합니다.
    const legacySchedule = /^SCHEDULE:(\d+)(?::(.+))?$/.exec(String(source || ""));
    const provenanceScheduleId = scheduleId ?? legacySchedule?.[1] ?? null;
    const provenanceIsScheduled = provenanceScheduleId !== null;
    const requesterName = legacySchedule ? legacySchedule[2] || "" : String(source || "");
    const scheduleCompleted = Boolean(commandId) && provenanceIsScheduled && !recordDeviceCommand;
    const changed = previousState !== state || (scheduleCompleted && (rows[0]?.last_change_source !== requesterName || rows[0]?.output_message !== outputString));
    const effectiveSource = changed ? requesterName : (rows[0]?.last_change_source || requesterName);

    if (!rows.length) {
      await connectionQuery(connection,
        `INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,is_active,output_state,input_state,last_change_source,input_message,output_message,sort_order)
         VALUES(?,?,?,?,1,?,?,?,?,?,?)`,
        [deviceId, `채널 ${channelNumberFromPin(pin).toString().padStart(2, "0")}`, inputPin, pin, state, inputState, effectiveSource, inputString, outputString, channelNumberFromPin(pin) - 1]);
    } else {
      await connectionQuery(connection,
        `UPDATE device_channel
         SET output_state=?,input_state=?,last_change_source=?,input_message=?,output_message=?,updated_at=?
         WHERE device_id=? AND output_signal=?`,
        [state, inputState, effectiveSource, inputString, outputString, toKoreaDateTime(new Date()), deviceId, pin]);
    }

    const now = new Date();
    const databaseTime = toKoreaDateTime(now);
    const effectiveCommandId = changed && recordDeviceCommand ? crypto.randomUUID() : commandId;

    await connectionQuery(connection,
      `UPDATE device SET last_change_source=?,last_seen_at=?,updated_at=? WHERE device_code=?`,
      [effectiveSource, databaseTime, databaseTime, deviceId]);

    if (typeof message.ip === "string" && message.ip.length <= 45) {
      await connectionQuery(connection, `UPDATE device SET last_ip=? WHERE device_code=?`, [message.ip, deviceId]);
    }

    if (changed) {
      await connectionQuery(connection,
        `INSERT INTO device_state_history(device_id,output_signal,previous_output_state,output_state,change_source,schedule_id,command_id,signal_message,changed_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [deviceId, pin, previousState, state, effectiveSource, provenanceScheduleId, effectiveCommandId, historyString, databaseTime]);

      if (recordDeviceCommand) {
        await connectionQuery(connection,
          `INSERT INTO device_command(command_id,device_id,output_signal,requested_output_state,output_message,requested_by,command_status,status_changed_at)
           VALUES(?,?,?,?,?,?, 'ACKED',?)`,
          [effectiveCommandId, deviceId, pin, state, outputString, deviceId, databaseTime]);
      }

      // 채널이 OFF->ON으로 바뀐 경우 연결된 제품 수량을 각각 1씩 증가합니다.
      if (state === "ON") {
        const linkedProducts = await connectionQuery(connection,
          `SELECT p.product_id AS id,p.product_code,p.product_name,p.quantity,p.target_quantity,
                  p.product_status AS status,p.updated_at,p.updated_by,COALESCE(NULLIF(p.updated_by_label,''),u.login_id) AS updated_by_name
           FROM product_channel_mapping m
           JOIN product p ON p.product_id=m.product_id
           LEFT JOIN user_profile u ON u.user_id=p.updated_by
           JOIN device_channel c ON c.device_id=m.device_id AND c.output_signal=m.output_signal
           JOIN device d ON d.device_code=m.device_id
           WHERE m.device_id=? AND m.output_signal=?
             AND m.is_active=1
           FOR UPDATE`,
          [deviceId, pin]
        );

        if (Array.isArray(linkedProducts) && linkedProducts.length) {
          await connectionQuery(connection,
            `UPDATE product p
             JOIN product_channel_mapping m ON m.product_id=p.product_id
             JOIN device_channel c ON c.device_id=m.device_id AND c.output_signal=m.output_signal
             JOIN device d ON d.device_code=m.device_id
             SET p.quantity=p.quantity+1,
               p.work_quantity=p.work_quantity+1,
                 p.quantity_reason='',
               p.quantity_actor=m.device_id,
               p.quantity_change_type='DEVICE',
                 p.updated_by=NULL,
                 p.updated_by_label=m.mapping_name,
                 p.updated_at=CURRENT_TIMESTAMP
             WHERE m.device_id=? AND m.output_signal=?
               AND m.is_active=1 AND p.is_enabled=1`,
            [deviceId, pin]
          );

          const updatedProducts = await connectionQuery(connection,
            `SELECT DISTINCT ${PRODUCT_FIELDS}
             ${PRODUCT_JOIN}
             JOIN product_channel_mapping m ON m.product_id=p.product_id
             WHERE m.device_id=? AND m.output_signal=? AND m.is_active=1 AND p.is_enabled=1
             ORDER BY p.product_id`,
            [deviceId, pin]
          );

          increasedProducts = Array.isArray(updatedProducts) ? updatedProducts : [];
        }
      }
    }

    if (!changed) {
      await connectionQuery(connection,
        `INSERT INTO device_state_history(device_id,output_signal,previous_output_state,output_state,change_source,signal_message,changed_at)
         SELECT ?,?,NULL,?,?,?,? WHERE NOT EXISTS (
           SELECT 1 FROM device_state_history WHERE device_id=? AND output_signal=?
         )`, [deviceId, pin, state, effectiveSource, historyString, databaseTime, deviceId, pin]);
    }

    // DB 저장이 성공한 상태만 브라우저에 전달하여 화면과 저장 데이터의 기준을 맞춥니다.
    await connection.commit();
    connection.release();

    if (changed) {
      if (recordDeviceCommand) await trimDeviceTable("device_command", 1000, deviceId);
    }

    const event = {
      type: changed ? "stateChanged" : "state",
      deviceId,
      OutputSignal: pin,
      state,
      OutputState: state,
      source: effectiveSource,
      isScheduled: Boolean(provenanceIsScheduled),
      ...(provenanceScheduleId !== null ? { scheduleId: String(provenanceScheduleId) } : {}),
      changedAt: now.toISOString(),
      lastChangedAt: changed ? now.toISOString() : (rows[0]?.last_changed_at || null),
      deviceConnected: isDeviceConnected(deviceId),
      InputSignal: inputPin,
      inputState,
      IStr: inputString,
      OStr: outputString,
      String: historyString,
      ...(typeof message.ip === "string" && message.ip.length <= 45 ? { ip: message.ip } : {})
    };
    if (changed) {
      event.previousState = previousState;
      event.commandId = effectiveCommandId;
    }
    broadcastDeviceBrowsers(event);

    if (Array.isArray(increasedProducts)) {
      for (const product of increasedProducts) {
        broadcast({ type: "quantityUpdated", product });
      }
    }

    if (changed && recordDeviceCommand) {
      broadcastDeviceBrowsers({
        type: "commandQueued", deviceId, commandId: effectiveCommandId, OutputSignal: pin, state,
        outputString, requester: deviceId, status: "ACKED", createdAt: now.toISOString()
      });
    }
  } catch (err) {
    try { await connection.rollback(); } catch { }
    connection.release();
    throw err;
  }
}

// DELIVERED는 소켓에 명령을 전송했다는 뜻입니다. 실제 성공 여부는 장치의 ACK로 확정합니다.
async function deliverDeviceCommand(deviceId, commandId, pin, desiredState, requester, outputString = "", inputString = null) {
  const ws = getDeviceDeviceSocket(deviceId);
  if (!ws) return false;

  sendDevice(ws, {
    type: "command",
    deviceId,
    commandId,
    OutputSignal: pin,
    InputSignal: `IS${channelNumberFromPin(pin)}`,
    severSignal: desiredState,
    OStr: String(outputString || ""),
    ...(inputString !== null && inputString !== undefined ? { IStr: String(inputString).slice(0, 10000) } : {}),
    requester
  });

  const now = new Date();
  const databaseTime = toKoreaDateTime(now);
  const result = await query(
    `UPDATE device_command SET command_status='DELIVERED',status_changed_at=? WHERE command_id=? AND command_status='PENDING' AND device_id=?`,
    [databaseTime, commandId, deviceId]);

  if (result.affectedRows > 0) {
    broadcastDeviceBrowsers({
      type: "commandAck", deviceId, commandId, OutputSignal: pin, state: desiredState,
      outputString: String(outputString || ""), status: "DELIVERED", changedAt: now.toISOString()
    });
    return true;
  }
  return false;
}

// 명령을 먼저 DB에 보관합니다. 장치가 오프라인이면 같은 채널의 이전 대기 명령을 취소합니다.
async function queueDeviceCommand(deviceId, pin, desiredState, requester, outputString = null, inputString = null, scheduleId = null) {
  deviceId = String(deviceId || "").trim();
  pin = normalizeDevicePin(pin);
  const state = parseDeviceState(desiredState);

  if (!deviceId || !DEVICE_OUTPUT_PINS.has(pin) || !state) {
    throw new Error("잘못된 장치, 출력 채널 또는 출력 상태입니다.");
  }

  const deviceRows = await query(`SELECT is_enabled,is_visible FROM device WHERE device_code=? LIMIT 1`, [deviceId]);
  if (!deviceRows.length) throw new Error("등록되지 않은 Device 장치입니다.");
  const deviceEnabled = Number(deviceRows[0].is_enabled) === 1;

  const controlRows = await query("SELECT web_control_enabled,web_on_enabled,web_off_enabled,is_active FROM device_channel WHERE device_id=? AND output_signal=? LIMIT 1", [deviceId, pin]);
  if (!controlRows.length) throw new Error("등록되지 않은 출력 채널입니다.");
  if (scheduleId == null && Number(controlRows[0].web_control_enabled) !== 1) {
    throw new Error("조회 전용 채널은 웹에서 제어할 수 없습니다.");
  }
  if (scheduleId == null && Number(controlRows[0][state === "ON" ? "web_on_enabled" : "web_off_enabled"]) !== 1) {
    throw new Error(`${state} 버튼이 비활성화된 채널입니다.`);
  }
  if (scheduleId == null && (Number(deviceRows[0].is_visible) !== 1 || Number(controlRows[0].is_active) !== 1)) {
    throw new Error("숨겨진 장치 또는 비활성 채널은 웹에서 제어할 수 없습니다.");
  }

  if (outputString === null || outputString === undefined) {
    const channelRows = await query(`SELECT output_message FROM device_channel WHERE device_id=? AND output_signal=? LIMIT 1`, [deviceId, pin]);
    outputString = String(channelRows[0]?.output_message ?? "").slice(0, 10000);
  } else {
    outputString = String(outputString).slice(0, 10000);
  }

  const commandId = crypto.randomUUID(), createdAt = new Date(), databaseTime = toKoreaDateTime(createdAt);
  const requesterId = requester == null ? "" : String(requester).slice(0, 100);
  const connection = await pool.getConnection();
  const cancelledCommands = [];

  try {
    await connection.beginTransaction();
    const offlineAtQueueTime = !deviceEnabled || !isDeviceConnected(deviceId);

    if (offlineAtQueueTime) {
      const pendingRows = await connectionQuery(connection,
        `SELECT command_id,output_signal,requested_output_state,output_message,requested_by
         FROM device_command
         WHERE device_id=? AND output_signal=? AND command_status='PENDING' FOR UPDATE`,
        [deviceId, pin]);

      for (const row of pendingRows) {
        await connectionQuery(connection,
          `UPDATE device_command SET command_status='CANCELLED',status_changed_at=?
           WHERE command_id=? AND device_id=? AND command_status='PENDING'`,
          [databaseTime, row.command_id, deviceId]);
        cancelledCommands.push(row);
      }
    }

    await connectionQuery(connection,
      `INSERT INTO device_command
        (command_id,device_id,output_signal,requested_output_state,output_message,istr_payload,requested_by,schedule_id,command_status,status_changed_at)
        VALUES(?,?,?,?,?,?,?,?,'PENDING',?)`,
            [commandId, deviceId, pin, state, outputString, inputString === null || inputString === undefined ? null : String(inputString).slice(0, 10000), requesterId, scheduleId, databaseTime]);

    await connection.commit();
    connection.release();
  } catch (err) {
    try { await connection.rollback(); } catch { }
    connection.release();
    throw err;
  }

  for (const row of cancelledCommands) {
    broadcastDeviceBrowsers({
      type: "commandAck", deviceId, commandId: row.command_id, OutputSignal: row.output_signal,
      state: row.requested_output_state, outputString: row.output_message || "",
      status: "CANCELLED", changedAt: createdAt.toISOString()
    });
  }

  await trimDeviceTable("device_command", 1000, deviceId);

  broadcastDeviceBrowsers({
    type: "commandQueued", deviceId, commandId, OutputSignal: pin, state, outputString,
    requester: requesterId, isScheduled: scheduleId != null, ...(scheduleId !== null ? { scheduleId: String(scheduleId) } : {}), status: "PENDING", createdAt: createdAt.toISOString()
  });

  if (deviceEnabled) await deliverDeviceCommand(deviceId, commandId, pin, state, requesterId, outputString, inputString);
  return { commandId, deviceId, OutputSignal: pin, state, outputString };
}

// 재연결 시 채널별 최신 대기 명령만 남기고, 먼저 저장된 명령 하나부터 전송합니다.
async function flushPendingDeviceCommand(deviceId) {
  deviceId = String(deviceId || "");
  if (!deviceId || !isDeviceConnected(deviceId)) return;
  const connection = await pool.getConnection();
  const latestByPin = new Map(), cancelled = [];
  try {
    await connection.beginTransaction();
    const rows = await connectionQuery(connection, `SELECT command_row_id AS id,command_id,output_signal,requested_output_state,output_message,istr_payload,requested_by FROM device_command WHERE device_id=? AND command_status='PENDING' ORDER BY command_row_id DESC FOR UPDATE`, [deviceId]);
    for (const row of rows) {
      const pin = String(row.output_signal || "").toUpperCase();
      if (!latestByPin.has(pin)) { latestByPin.set(pin, row); continue; }
      await connectionQuery(connection, `UPDATE device_command SET command_status='CANCELLED',status_changed_at=? WHERE command_id=? AND device_id=? AND command_status='PENDING'`, [toKoreaDateTime(new Date()), row.command_id, deviceId]);
      cancelled.push(row);
    }
    await connection.commit();
  } catch (err) { try { await connection.rollback(); } catch { } throw err; } finally { connection.release(); }
  for (const row of cancelled) broadcastDeviceBrowsers({ type: "commandAck", deviceId, commandId: row.command_id, OutputSignal: row.output_signal, state: row.requested_output_state, status: "CANCELLED", changedAt: new Date().toISOString() });
  const rows = [...latestByPin.values()].sort((a, b) => Number(a.id) - Number(b.id));
  if (rows.length) {
    const row = rows[0];
    await deliverDeviceCommand(deviceId, row.command_id, row.output_signal, row.requested_output_state, row.requested_by, row.output_message || '', row.istr_payload);
  }
}
async function handleDeviceDeviceMessage(ws, message) {
  const deviceId = String(ws.deviceId || "");
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (message.deviceId !== undefined && String(message.deviceId) !== deviceId) {
    ws.close(1008, "Device ID mismatch");
    return;
  }

  if (message.type === "hello") {
    if (String(message.deviceId || "") !== deviceId) { ws.close(1008, "Device ID mismatch"); return; }

    if (deviceDeviceSockets.has(deviceId) && deviceDeviceSockets.get(deviceId) !== ws) {
      deviceDeviceSockets.get(deviceId).close(1012, "Device reconnected");
    }

    ws.OutputSignal = normalizeDevicePin(message.OutputSignal ?? message.pin ?? "OS1");
    ws.deviceIdentified = true;
    deviceDeviceSockets.set(deviceId, ws);
    if (deviceId === DEVICE_ID) deviceDeviceSocket = ws;

    const inputs = Array.isArray(message.inputs) ? message.inputs.map(String) : [];
    const outputs = Array.isArray(message.outputs) ? message.outputs.map(String) : [];

    for (let index = 0; index < DEVICE_CHANNEL_COUNT; index++) {
      const inputPin = inputs[index] || `IS${index + 1}`;
      const outputPin = outputs[index] || `OS${index + 1}`;
      if (inputPin !== `IS${index + 1}` || outputPin !== `OS${index + 1}`) continue;

      await query(
        `INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order)
         VALUES(?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           channel_name=IF(channel_name='',VALUES(channel_name),channel_name),
           output_signal=VALUES(output_signal)`,
        [deviceId, `채널 ${String(index + 1).padStart(2, "0")}`, inputPin, outputPin, index]
      );
    }

    const now = toKoreaDateTime(new Date());
    await query(`UPDATE device SET last_seen_at=?,updated_at=? WHERE device_code=?`, [now, now, deviceId]);

    broadcastDeviceBrowsers({ type: "deviceConnection", deviceId, connected: true });
    await flushPendingDeviceCommand(deviceId);
    return;
  }

  if (!ws.deviceIdentified) { ws.close(1008, "Device hello required"); return; }
  if (deviceDeviceSockets.get(deviceId) !== ws) return;

  if (message.type === "state") {
    const state = parseDeviceState(message.OutputState ?? message.state);
    if (!state) return;

    const pin = normalizeDevicePin(message.OutputSignal ?? message.pin ?? "");
    if (!pin) return;
    const inputSignal = message.InputSignal ?? message.inputPin;
    if (inputSignal !== undefined && inputSignal !== `IS${channelNumberFromPin(pin)}`) return;
    if (message.inputState !== undefined && !parseDeviceState(message.inputState)) return;

    const reportedSource = String(message.source || "");
    const deviceChange = reportedSource === "DEVICE" || reportedSource === LEGACY_DEVICE_PREFIX.toUpperCase() || reportedSource === deviceId;
    const source = (deviceChange ? deviceId : reportedSource || deviceId).slice(0, 100);

    await recordDeviceState(
      deviceId, pin, state, source,
      message.commandId ? String(message.commandId) : null,
      deviceChange,
      message
    );
    return;
  }

  if (message.type === "channelString") {
    const pin = normalizeDevicePin(message.OutputSignal ?? message.pin ?? "");
    if (!pin) return;
    const inputSignal = message.InputSignal ?? message.inputPin;
    if (inputSignal !== undefined && inputSignal !== `IS${channelNumberFromPin(pin)}`) return;
    if (message.IStr === undefined && message.sendString === undefined) return;
    const inputString = String(message.IStr ?? message.sendString ?? "").slice(0, 10000);
    const now = toKoreaDateTime(new Date());
    await query(
      `UPDATE device_channel SET input_message=?,updated_at=? WHERE device_id=? AND output_signal=?`,
      [inputString, now, deviceId, pin]
    );
    await query(`UPDATE device SET last_seen_at=? WHERE device_code=?`, [now, deviceId]);
    broadcastDeviceBrowsers({
      type: "channelString",
      deviceId, OutputSignal: pin,
      InputSignal: `IS${channelNumberFromPin(pin)}`,
      IStr: inputString,
      changedAt: new Date().toISOString()
    });
    return;
  }

  if (message.type === "ack") {
    const commandId = String(message.commandId || "");
    if (!commandId) return;

    const rows = await query(
      `SELECT command_id,output_signal,requested_output_state,output_message,requested_by,schedule_id,command_status
       FROM device_command WHERE command_id=? AND device_id=?`,
      [commandId, deviceId]
    );
    if (!rows.length) return;

    if (!["PENDING", "DELIVERED"].includes(rows[0].command_status)) return;
    const state = parseDeviceState(message.OutputState ?? message.state);
    const pin = normalizeDevicePin(message.OutputSignal ?? message.pin ?? rows[0].output_signal ?? "");
    if (pin !== normalizeDevicePin(rows[0].output_signal)) return;
    const status = message.success === true && state === rows[0].requested_output_state ? "ACKED" : "FAILED";
    const outputString = String(message.OStr ?? message.receiveString ?? message.outputString ?? rows[0].output_message ?? "").slice(0, 10000);

    if (status === "ACKED" && state === rows[0].requested_output_state) {
      const source = String(rows[0].requested_by ?? "").slice(0, 100);
      await recordDeviceState(
        deviceId, pin, state, source,
        commandId, false, { OStr: outputString }, rows[0].schedule_id ?? null
      );
    }

    const now = new Date();
    await query(
      `UPDATE device_command SET command_status=?,output_message=?,status_changed_at=?
       WHERE command_id=? AND device_id=?`,
      [status, outputString, toKoreaDateTime(now), commandId, deviceId]
    );
    const legacySchedule = /^SCHEDULE:(\d+)(?::.+)?$/.exec(String(rows[0].requested_by || ""));
    const scheduleId = rows[0].schedule_id ?? legacySchedule?.[1] ?? null;
    if (scheduleId !== null) {
      await query(`UPDATE device_schedule SET last_execution_status=?,last_execution_message=?,last_run_at=?,completed_at=CASE WHEN repeat_type IN ('ONCE','IMMEDIATE') AND ?='ACKED' THEN ? ELSE completed_at END WHERE schedule_id=?`,
        [status, status === "ACKED" ? "디바이스 ACK 확인" : "디바이스 명령 실패 또는 ACK 불일치", toKoreaDateTime(now), status, toKoreaDateTime(now), scheduleId]);
    }

    broadcastDeviceBrowsers({
      type: "commandAck", deviceId, commandId, OutputSignal: pin,
      state: state || rows[0].requested_output_state,
      outputString, status, changedAt: now.toISOString()
    });

    await flushPendingDeviceCommand(deviceId);
  }
}

// 인증 중 도착한 메시지는 기다렸다가 순서대로 처리하여 hello보다 state가 먼저 적용되지 않게 합니다.
function attachDeviceDeviceMessageHandler(ws, authorization) {
  let messageChain = Promise.resolve();
  let pendingMessages = 0;
  ws.on("message", data => {
    if (pendingMessages >= 64) { ws.close(1008, "Too many pending device messages"); return; }
    pendingMessages++;
    messageChain = messageChain.then(async () => {
      if (!await authorization || ws.readyState !== WebSocket.OPEN) return;
      await handleDeviceDeviceMessage(ws, JSON.parse(data.toString()));
    }).catch(err => {
      console.error(`[WS Device ${ws.deviceId}]`, err);
    }).finally(() => { pendingMessages--; });
  });
  return () => messageChain;
}

// ---------------------------------------------------------
// WebSocket - 승인된 회원만
// ---------------------------------------------------------
function getUserFromRequest(req) { const token = getCookie(req, SESSION_COOKIE); if (!token) return null; const session = sessions.get(token); if (!session) return null; if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; } session.expiresAt = Date.now() + SESSION_MAX_AGE; return session.user; }
wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/ws/device") {
    const deviceId = String(url.searchParams.get("deviceId") || "").trim();
    const authorization = req.headers.authorization || "";
    const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!deviceId || !providedToken) { ws.close(1008, "Device authentication failed"); return; }
    ws.role = "device-device";
    ws.deviceId = deviceId;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const deviceAuthorization = query(`SELECT device_code AS device_id,is_enabled,token_hash FROM device WHERE device_code=? LIMIT 1`, [deviceId]).then(deviceRows => {
      if (!deviceRows.length) { ws.close(1008, "Unknown device"); return false; }
      if (Number(deviceRows[0].is_enabled) !== 1) { ws.close(1008, "Device disabled"); return false; }
      const tokenHash = crypto.createHash("sha256").update(providedToken).digest("hex");
      const configuredHash = String(deviceRows[0].token_hash || "");
      if (!configuredHash || tokenHash.length !== configuredHash.length || !crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(configuredHash))) { ws.close(1008, "Device authentication failed"); return false; }
      return true;
    }).catch(err => {
      console.error(`[WS Device ${deviceId}] authentication failed:`, err);
      ws.close(1011, "Device authentication unavailable");
      return false;
    });
    attachDeviceDeviceMessageHandler(ws, deviceAuthorization);
    ws.on("close", async () => {
      if (deviceDeviceSockets.get(deviceId) === ws) {
        deviceDeviceSockets.delete(deviceId);
        if (deviceDeviceSocket === ws) deviceDeviceSocket = null;
        try {
          await query(`UPDATE device_command SET command_status='PENDING' WHERE device_id=? AND command_status='DELIVERED'`, [deviceId]);
        } catch (err) { console.error(`[WS Device ${deviceId}] DELIVERED→PENDING 복구 실패:`, err.message); }
        broadcastDeviceBrowsers({ type: "deviceConnection", deviceId, connected: false });
      }
    });
    return;
  }
  const user = getUserFromRequest(req);
  if (!user) { ws.close(1008, "로그인이 필요합니다."); return; }
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  let browserAuthorized = false;
  const pendingBrowserMessages = [];
  const handleBrowserMessage = async data => {
    try {
      const message = JSON.parse(data.toString());
      if (["lamp", "subscribeDevice", "getState", "getHistory", "getCommands", `subscribe${LEGACY_DEVICE_PREFIX[0].toUpperCase()}${LEGACY_DEVICE_PREFIX.slice(1)}`].includes(message.type)) {
        const current = await query("SELECT user_status AS status,permission_level,role,login_id AS username FROM user_profile WHERE user_id=? LIMIT 1", [ws.factoryUserId]);
        if (!current.length) { ws.close(1008, "회원 정보를 찾을 수 없습니다."); return; }
        if (current[0].status === "SUSPENDED") { ws.close(4001, "SUSPENDED"); return; }
        ws.factoryUser = { ...ws.factoryUser, ...current[0], permissionLevel: Number(current[0].permission_level ?? getPermissionLevel(ws.factoryUser)) };
        const keys = message.type === "lamp" ? ["device_control"] : ["device_view", "device_control", "User_customization", "device_schedule", "device_admin", "device_report"];
        if (!keys.some(key => canUseFeature(ws.factoryUser, key, permissionPolicy))) {
          sendDevice(ws, { type: "lampAck", ok: false, message: "현재 레벨로 이용할 수 없는 디바이스 업무입니다." });
          return;
        }
      }
      if (message.type === "lamp") {
        const pin = normalizeDevicePin(message.OutputSignal ?? message.pin ?? "OS1");
        if (!pin) { sendDevice(ws, { type: "lampAck", ok: false, message: "출력 채널은 OS1~OS16 중 하나여야 합니다." }); return; }
        const state = parseDeviceState(message.severSignal ?? message.state);
        if (!state) { sendDevice(ws, { type: "lampAck", ok: false, message: "상태는 ON 또는 OFF여야 합니다." }); return; }
        const deviceId = String(message.deviceId || "").trim();
        if (!deviceId) { sendDevice(ws, { type: "lampAck", ok: false, message: "장치를 선택해야 합니다." }); return; }
        const outputString = String(message.OStr ?? message.outputString ?? "").slice(0, 10000);
        const result = await queueDeviceCommand(deviceId, pin, state, String(ws.factoryUser.username || "CLIENT").slice(0, 100), outputString);
        sendDevice(ws, { type: "lampAck", ok: true, deviceId, deviceConnected: isDeviceConnected(deviceId), ...result }); return;
      }
      if (message.type === "subscribeDevice" || message.type === `subscribe${LEGACY_DEVICE_PREFIX[0].toUpperCase()}${LEGACY_DEVICE_PREFIX.slice(1)}`) {
        ws.legacyDeviceSubscriber = message.type !== "subscribeDevice";
        ws.deviceSubscriber = true;
        const requestedDeviceId = String(message.deviceId || "").trim();
        const [state, history, commands] = await Promise.all([getDeviceState(requestedDeviceId || null), getDeviceHistory(50, requestedDeviceId || null), getDeviceCommands(50, requestedDeviceId || null)]);
        sendDevice(ws, { type: "deviceSnapshot", state, history, commands, deviceId: requestedDeviceId || null, ...(requestedDeviceId ? { deviceConnected: isDeviceConnected(requestedDeviceId) } : {}) }); return;
      }
      if (["getState", "getHistory", "getCommands"].includes(message.type)) {
        ws.deviceSubscriber = true;
        const requestedDeviceId = String(message.deviceId || "").trim();
        if (message.type === "getState") sendDevice(ws, { type: "initialState", state: await getDeviceState(requestedDeviceId || null), ...(requestedDeviceId ? { deviceConnected: isDeviceConnected(requestedDeviceId) } : {}) });
        if (message.type === "getHistory") sendDevice(ws, { type: "history", rows: await getDeviceHistory(message.limit, requestedDeviceId || null) });
        if (message.type === "getCommands") sendDevice(ws, { type: "commands", rows: await getDeviceCommands(message.limit, requestedDeviceId || null) });
      }
    } catch (err) { console.error("[WS browser]", err); sendDevice(ws, { type: "lampAck", ok: false, message: err.message || "요청을 처리하지 못했습니다." }); }
  };
  ws.on("message", data => {
    if (browserAuthorized) {
      void handleBrowserMessage(data);
      return;
    }
    if (pendingBrowserMessages.length >= 32) {
      ws.close(1008, "Too many messages before authorization");
      return;
    }
    pendingBrowserMessages.push(data);
  });
  try {
    const rows = await query("SELECT user_status AS status,permission_level,role FROM user_profile WHERE user_id=? LIMIT 1", [user.id]);
    if (!rows.length) { ws.close(1008, "회원 정보를 찾을 수 없습니다."); return; }
    // 정지된 계정은 생산현황 데이터에 접근하지 못하도록 별도 코드로 연결을 종료하고, 클라이언트가 회원정보 화면으로 이동시킵니다.
    if (rows[0].status === "SUSPENDED") { ws.close(4001, "SUSPENDED"); return; }
    user.status = rows[0].status;
    user.permissionLevel = Number(rows[0].permission_level ?? getPermissionLevel(user));
    if (rows[0].role) user.role = rows[0].role;
    if (rows[0].status !== "APPROVED" && getPermissionLevel(user) < APPROVAL_OVERRIDE_LEVEL) { ws.close(1008, "승인된 회원만 이용할 수 있습니다."); return; }
  } catch (err) { console.error("WebSocket 계정 상태 확인 오류:", err); ws.close(1011, "계정 상태 확인 오류"); return; }
  if (ws.readyState !== WebSocket.OPEN) return;
  clients.add(ws);
  ws.factoryUserId = user.id;
  ws.factoryUser = user;
  ws.productionAuthorized = ["production_view", "production_input", "production_report", "product_admin", "product_channel_link"].some(key => canUseFeature(user, key, permissionPolicy));
  browserAuthorized = true;
  for (const data of pendingBrowserMessages.splice(0)) void handleBrowserMessage(data);
  try { if (ws.productionAuthorized) { const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_enabled=1 ORDER BY p.sort_order,p.product_id`); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "products", products: rows })); } } catch (err) { console.error(err); }
});
function broadcast(message) { const data = JSON.stringify(message); for (const ws of clients) if (ws.readyState === WebSocket.OPEN && (message.type === "accessPolicyChanged" || ws.productionAuthorized !== false)) ws.send(data); }

const websocketHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on("close", () => clearInterval(websocketHeartbeat));

// 회원 삭제/정지 시 해당 회원의 실시간 연결을 즉시 종료합니다.
function closeUserSockets(userId, code, reason) {
  for (const ws of clients) {
    if (ws.factoryUserId === userId) ws.close(code, reason);
  }
}

// 계정 삭제: 세션도 함께 무효화하여 로그인 화면으로 이동시킵니다.
function forceLogoutUser(userId) {
  for (const [token, session] of sessions) {
    if (session.user.id === userId) sessions.delete(token);
  }
  closeUserSockets(userId, 1008, "회원 정보를 찾을 수 없습니다.");
}

// 계정 정지: 세션은 유지하되(회원정보 화면 접근은 허용) 실시간 연결만 즉시 종료합니다.
function forceSuspendUser(userId) {
  closeUserSockets(userId, 4001, "SUSPENDED");
}
setInterval(() => { const now = Date.now(); for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token); }, 10 * 60 * 1000);

const DEVICE_FIXED_SETS = DEVICE_CHANNELS.map(channel => [channel.inputPin, channel.outputPin]);
function deviceAdminMiddleware(req, res, next) {
  requireLogin(req, res, () => requireActiveAccount(req, res, () => requireApproved(req, res, () => requireAdminLevel(8)(req, res, next))));
}
async function getManagedDeviceDevices() {
  const devices = await query(`SELECT CAST(device_id AS CHAR) AS id,device_code AS device_id,device_name,is_visible,is_enabled,sort_order,last_ip,last_seen_at,updated_at FROM device ORDER BY sort_order,device_id`);
  const result = [];
  for (const device of devices) {
    const deviceConnected = isDeviceConnected(device.device_id);
    try {
      const sets = await query(`SELECT channel_id AS id,channel_name,input_signal,output_signal,is_active AS is_visible,web_control_enabled,web_on_enabled,web_off_enabled,web_schedule_enabled,output_state,input_state,last_change_source,input_message,output_message,sort_order,
        COALESCE((SELECT h.changed_at FROM device_state_history h
         WHERE h.device_id=device_channel.device_id AND h.output_signal=device_channel.output_signal
         ORDER BY h.history_id DESC LIMIT 1), device_channel.created_at) AS last_changed_at
        FROM device_channel WHERE device_id=? ORDER BY sort_order,channel_id`, [device.device_id]);
      result.push({ ...device, deviceConnected, sets: await Promise.all(sets.map(async (set, index) => ({ ...set, last_change_source: await resolveScheduleSource(set.last_change_source), channel_name: set.channel_name === set.output_signal ? `채널 ${String(index + 1).padStart(2, "0")}` : set.channel_name, id: String(set.id) }))) });
    } catch (err) {
      console.error(`Device 접점 세트 조회 오류 (${device.device_id}):`, err);
      result.push({ ...device, deviceConnected, sets: [] });
    }
  }
  return result;
}
// 통합 예약 API: device-control과 device_schedule 페이지가 같은 테이블을 사용합니다.
async function migrateScheduleOutputString() {
  const columns = await query("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='device_schedule' AND COLUMN_NAME IN ('istr_payload','ostr_payload')");
  if (columns.some(column => column.column_name === "istr_payload") && !columns.some(column => column.column_name === "ostr_payload")) {
    await query("ALTER TABLE device_schedule CHANGE COLUMN istr_payload ostr_payload TEXT NULL");
  }
}
async function migrateScheduleEndTime() {
  const columns = await query("SHOW COLUMNS FROM device_schedule LIKE 'end_time'");
  if (!columns.length) await query("ALTER TABLE device_schedule ADD COLUMN end_time DATETIME(3) NULL AFTER schedule_time");
}
async function migrateScheduleRepeatType() {
  const columns = await query("SHOW COLUMNS FROM device_schedule LIKE 'repeat_type'");
  const type = String(columns[0]?.Type || columns[0]?.type || "").toLowerCase();
  if (!type.includes("'immediate'")) {
    await query("ALTER TABLE device_schedule MODIFY COLUMN repeat_type ENUM('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY','IMMEDIATE') NOT NULL DEFAULT 'ONCE'");
  }
}
async function migrateScheduleRecurrenceColumns() {
  const columns = await query("SHOW COLUMNS FROM device_schedule");
  const existing = new Set(columns.map(column => column.Field || column.field || column.COLUMN_NAME || column.column_name));
  const legacyFields = ["hour_value", "minute_value", "day_of_month", "month_value", "day_value"];
  const fieldsToDrop = legacyFields.filter(field => existing.has(field));
  if (!fieldsToDrop.length) return;

  const legacyRows = await query(`SELECT schedule_id,repeat_type,schedule_time,next_run_at,last_run_at,created_at,
    ${existing.has("hour_value") ? "hour_value" : "0 AS hour_value"},
    ${existing.has("minute_value") ? "minute_value" : "0 AS minute_value"},
    ${existing.has("day_of_month") ? "day_of_month" : "NULL AS day_of_month"},
    ${existing.has("month_value") ? "month_value" : "NULL AS month_value"},
    ${existing.has("day_value") ? "day_value" : "NULL AS day_value"},
    ${existing.has("is_month_end") ? "is_month_end" : "0 AS is_month_end"}
    FROM device_schedule WHERE schedule_time IS NULL AND repeat_type NOT IN ('ONCE','IMMEDIATE')`);

  for (const row of legacyRows) {
    const savedOccurrence = row.next_run_at || row.last_run_at;
    const source = String(savedOccurrence || row.created_at || toKoreaDateTime(new Date())).replace("T", " ");
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(source);
    const shiftedNow = new Date(Date.now() + KOREA_TIME_OFFSET_MS);
    let year = dateMatch ? Number(dateMatch[1]) : shiftedNow.getUTCFullYear();
    let month = dateMatch ? Number(dateMatch[2]) : shiftedNow.getUTCMonth() + 1;
    let day = dateMatch ? Number(dateMatch[3]) : shiftedNow.getUTCDate();
    let hour = dateMatch && savedOccurrence ? Number(dateMatch[4] || 0) : Number(row.hour_value || 0);
    let minute = dateMatch && savedOccurrence ? Number(dateMatch[5] || 0) : Number(row.minute_value || 0);

    if (!savedOccurrence && row.repeat_type === "MONTHLY") {
      if (Number(row.is_month_end)) {
        day = new Date(Date.UTC(year, month, 0)).getUTCDate();
      } else {
        day = Number(row.day_of_month || day);
        while (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
          month++;
          if (month > 12) { month = 1; year++; }
        }
      }
    } else if (!savedOccurrence && row.repeat_type === "YEARLY") {
      month = Number(row.month_value || month);
      day = Number(row.day_value || day);
      const possibleDate = new Date(Date.UTC(2000, month - 1, day));
      if (possibleDate.getUTCMonth() !== month - 1 || possibleDate.getUTCDate() !== day) {
        throw new Error(`예약 ${row.schedule_id}의 기존 연간 반복 날짜를 schedule_time으로 변환할 수 없습니다.`);
      }
      while (new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1
        || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) year++;
    }

    const scheduleTime = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
    await query("UPDATE device_schedule SET schedule_time=? WHERE schedule_id=? AND schedule_time IS NULL", [scheduleTime, row.schedule_id]);
  }

  await query(`ALTER TABLE device_schedule ${fieldsToDrop.map(field => `DROP COLUMN ${field}`).join(", ")}`);
}
async function migrateScheduleCreatedBy() {
  const constraints = await query("SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='device_schedule' AND CONSTRAINT_NAME='fk_schedule_creator'");
  if (constraints.length) await query("ALTER TABLE device_schedule DROP FOREIGN KEY fk_schedule_creator");
  const columns = await query("SHOW COLUMNS FROM device_schedule LIKE 'created_by'");
  if (columns.length && !String(columns[0].Type || columns[0].type || "").toLowerCase().startsWith("varchar")) {
    await query("ALTER TABLE device_schedule MODIFY COLUMN created_by VARCHAR(50) NULL");
  }
  await query(`UPDATE device_schedule s JOIN user_profile u ON u.user_id=CAST(s.created_by AS UNSIGNED)
    SET s.created_by=u.login_id WHERE s.created_by REGEXP '^[0-9]+$'`);
}
async function migrateScheduleProvenance() {
  for (const { table, sourceColumn, idColumn } of [
    { table: "device_command", sourceColumn: "requested_by", idColumn: "command_row_id" },
    { table: "device_state_history", sourceColumn: "change_source", idColumn: "history_id" }
  ]) {
    const columns = await query(`SHOW COLUMNS FROM ${table} LIKE 'schedule_id'`);
    if (!columns.length) await query(`ALTER TABLE ${table} ADD COLUMN schedule_id BIGINT UNSIGNED NULL AFTER ${sourceColumn}`);
    const legacyRows = await query(`SELECT ${idColumn} AS row_id,${sourceColumn} AS source_value,schedule_id FROM ${table} WHERE ${sourceColumn} LIKE 'SCHEDULE:%'`);
    for (const row of legacyRows) {
      const match = /^SCHEDULE:(\d+)(?::(.+))?$/.exec(String(row.source_value || ""));
      if (!match) continue;
      const scheduleId = row.schedule_id ?? match[1];
      const owners = await query("SELECT created_by AS username FROM device_schedule WHERE schedule_id=? LIMIT 1", [scheduleId]);
      let requesterName = owners[0]?.username ?? null;
      if (!requesterName && match[2]) {
        if (/^\d+$/.test(match[2])) {
          const users = await query("SELECT login_id AS username FROM user_profile WHERE user_id=? LIMIT 1", [match[2]]);
          requesterName = users[0]?.username ?? null;
        } else requesterName = match[2];
      }
      await query(`UPDATE ${table} SET schedule_id=?,${sourceColumn}=? WHERE ${idColumn}=?`, [scheduleId, requesterName || "", row.row_id]);
    }
    await query(`UPDATE ${table} t JOIN user_profile u ON u.user_id=CAST(t.${sourceColumn} AS UNSIGNED)
      SET t.${sourceColumn}=u.login_id
      WHERE t.${sourceColumn} REGEXP '^[0-9]+$'`);
    const scheduledColumn = await query(`SHOW COLUMNS FROM ${table} LIKE 'is_scheduled'`);
    if (scheduledColumn.length) {
      const orphanedScheduleFlags = await query(`SELECT ${idColumn} FROM ${table} WHERE is_scheduled=1 AND schedule_id IS NULL LIMIT 1`);
      if (orphanedScheduleFlags.length) throw new Error(`${table} 예약 표시를 schedule_id로 복구할 수 없습니다.`);
      await query(`ALTER TABLE ${table} DROP COLUMN is_scheduled`);
    }
  }
}

function scheduleNextRun(schedule, afterDate = new Date()) {
  const shifted = new Date(afterDate.getTime() + KOREA_TIME_OFFSET_MS);
  const afterKst = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes(), 0, 0));
  const startAt = schedule.schedule_time ? new Date(String(schedule.schedule_time).replace(" ", "T") + "+09:00") : null;
  const endAt = schedule.end_time ? new Date(String(schedule.end_time).replace(" ", "T") + "+09:00") : null;
  if (schedule.repeat_type === "IMMEDIATE") return toKoreaDateTime(afterDate);
  if (schedule.repeat_type === "ONCE") return startAt && startAt > afterDate ? toKoreaDateTime(startAt) : null;
  if (!startAt || Number.isNaN(startAt.getTime())) return null;
  if (endAt && Number.isNaN(endAt.getTime())) return null;
  const startKst = startAt ? new Date(startAt.getTime() + KOREA_TIME_OFFSET_MS) : null;
  const afterBoundary = startKst && startKst > afterKst ? new Date(startKst.getTime() - 1) : afterKst;
  const hour = startKst.getUTCHours(), minute = startKst.getUTCMinutes();
  const monthValue = startKst.getUTCMonth() + 1, dayValue = startKst.getUTCDate();
  const weekdays = Number(schedule.weekday_mask || 0);
  if (schedule.repeat_type === "HOURLY") {
    const firstHour = new Date(Date.UTC(afterBoundary.getUTCFullYear(), afterBoundary.getUTCMonth(), afterBoundary.getUTCDate(), afterBoundary.getUTCHours(), minute));
    const candidate = firstHour > afterBoundary ? firstHour : new Date(firstHour.getTime() + 60 * 60 * 1000);
    if (startKst && candidate < startKst) return null;
    if (endAt && candidate.getTime() > endAt.getTime() + KOREA_TIME_OFFSET_MS) return null;
    return candidate.toISOString().slice(0, 19).replace("T", " ");
  }
  const scanStart = startKst && startKst > afterKst ? startKst : afterKst;
  for (let dayOffset = 0; dayOffset <= 366 * 8; dayOffset++) {
    const day = new Date(Date.UTC(scanStart.getUTCFullYear(), scanStart.getUTCMonth(), scanStart.getUTCDate() + dayOffset));
    const year = day.getUTCFullYear(), month = day.getUTCMonth(), date = day.getUTCDate();
    if (schedule.repeat_type === "YEARLY" && (month + 1 !== monthValue || date !== dayValue)) continue;
    if (schedule.repeat_type === "MONTHLY") {
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      if (schedule.is_month_end ? date !== last : date !== dayValue) continue;
    }
    if (schedule.repeat_type === "WEEKLY" && !(weekdays & (1 << day.getUTCDay()))) continue;
    const candidate = new Date(Date.UTC(year, month, date, hour, minute));
    if (candidate > afterKst && (!startKst || candidate >= startKst)) {
      if (endAt && candidate.getTime() > endAt.getTime() + KOREA_TIME_OFFSET_MS) return null;
      return candidate.toISOString().slice(0, 19).replace("T", " ");
    }
  }
  return null;
}
function legacyScheduleTime(repeat, hour, minute, dayOfMonth, monthValue, dayValue, isMonthEnd) {
  const shiftedNow = new Date(Date.now() + KOREA_TIME_OFFSET_MS);
  let year = shiftedNow.getUTCFullYear(), month = shiftedNow.getUTCMonth() + 1, date = shiftedNow.getUTCDate();
  if (repeat === "MONTHLY") {
    if (isMonthEnd) {
      date = new Date(Date.UTC(year, month, 0)).getUTCDate();
    } else {
      date = dayOfMonth;
      while (date > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
        month++;
        if (month > 12) { month = 1; year++; }
      }
    }
  } else if (repeat === "YEARLY") {
    month = monthValue;
    date = dayValue;
    while (new Date(Date.UTC(year, month - 1, date)).getUTCMonth() !== month - 1
      || new Date(Date.UTC(year, month - 1, date)).getUTCDate() !== date) year++;
  }
  const selectedHour = Number.isInteger(hour) ? hour : shiftedNow.getUTCHours();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")} ${String(selectedHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}
function validateScheduleInput(body) {
  const repeat = String(body.repeat_type || "ONCE").toUpperCase();
  const action = String(body.action_state || "").toUpperCase();
  const allowed = ["IMMEDIATE", "ONCE", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
  if (!allowed.includes(repeat) || !["ON", "OFF"].includes(action)) throw new Error("반복 유형 또는 실행 동작이 올바르지 않습니다.");
  let minute = Number(body.minute_value ?? 0), hour = body.hour_value === "" || body.hour_value == null ? null : Number(body.hour_value);
  let scheduleTime = null, endTime = null;
  if (repeat === "IMMEDIATE") {
    scheduleTime = toKoreaDateTime(new Date()).slice(0, 19);
  } else if (repeat === "ONCE" || body.schedule_time) {
    const raw = String(body.schedule_time || "").trim().replace("T", " ");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)) throw new Error("실행 날짜와 시각을 입력하세요.");
    scheduleTime = raw.length === 16 ? `${raw}:00` : raw;
    const parsed = new Date(scheduleTime.replace(" ", "T") + "+09:00");
    if (Number.isNaN(parsed.getTime()) || toKoreaDateTime(parsed).slice(0, 19) !== scheduleTime) throw new Error("실행 날짜와 시각이 올바르지 않습니다.");
    if (repeat === "ONCE" && parsed <= new Date()) throw new Error("1회 예약 시각은 현재 이후여야 합니다.");
    hour = Number(raw.slice(11, 13));
    minute = Number(raw.slice(14, 16));
  }
  if (body.end_time) {
    const raw = String(body.end_time).trim().replace("T", " ");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)) throw new Error("종료 날짜와 시각을 입력하세요.");
    endTime = raw.length === 16 ? `${raw}:00` : raw;
    const parsed = new Date(endTime.replace(" ", "T") + "+09:00");
    if (Number.isNaN(parsed.getTime()) || toKoreaDateTime(parsed).slice(0, 19) !== endTime) throw new Error("종료 날짜와 시각이 올바르지 않습니다.");
    if (["ONCE", "IMMEDIATE"].includes(repeat) || (scheduleTime && parsed <= new Date(scheduleTime.replace(" ", "T") + "+09:00"))) throw new Error("종료 시각은 반복 예약의 시작 시각 이후여야 합니다.");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("분은 0~59 사이여야 합니다.");
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(repeat) && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error("시는 0~23 사이여야 합니다.");
  let weekdayMask = null;
  if (repeat === "WEEKLY") {
    const days = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [];
    if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("주간 예약은 하나 이상의 요일을 선택해야 합니다.");
    weekdayMask = days.reduce((mask, day) => mask | (1 << day), 0);
  }
  const dayOfMonth = scheduleTime && repeat === "MONTHLY" ? Number(scheduleTime.slice(8, 10)) : body.day_of_month == null || body.day_of_month === "" ? null : Number(body.day_of_month);
  const monthValue = scheduleTime && repeat === "YEARLY" ? Number(scheduleTime.slice(5, 7)) : body.month_value == null || body.month_value === "" ? null : Number(body.month_value);
  const dayValue = scheduleTime && repeat === "YEARLY" ? Number(scheduleTime.slice(8, 10)) : body.day_value == null || body.day_value === "" ? null : Number(body.day_value);
  const isMonthEnd = repeat === "MONTHLY" && !!body.is_month_end;
  if (repeat === "MONTHLY" && !isMonthEnd && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) throw new Error("월별 예약 날짜는 1~31 또는 말일이어야 합니다.");
  if (repeat === "YEARLY") {
    const calendarDate = new Date(Date.UTC(2000, monthValue - 1, dayValue));
    if (!Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12 || !Number.isInteger(dayValue) || dayValue < 1 || dayValue > 31
      || calendarDate.getUTCMonth() !== monthValue - 1 || calendarDate.getUTCDate() !== dayValue) throw new Error("연별 예약의 월과 일을 확인하세요.");
  }
  if (!scheduleTime) scheduleTime = legacyScheduleTime(repeat, hour, minute, dayOfMonth, monthValue, dayValue, isMonthEnd);
  const schedule = { repeat_type: repeat, action_state: action, schedule_time: scheduleTime, end_time: endTime, weekday_mask: weekdayMask, is_month_end: isMonthEnd };
  const next = scheduleNextRun(schedule);
  if (!next) throw new Error("유효한 다음 실행 시각을 계산할 수 없습니다.");
  return { ...schedule, next_run_at: next, schedule_name: String(body.schedule_name || "").trim().slice(0, 150), ostr_payload: String(body.ostr_payload ?? body.istr_payload ?? "").slice(0, 10000), is_enabled: body.is_enabled === false || body.is_enabled === 0 ? 0 : 1 };
}
function scheduleAdmin(req, res, next) { deviceAdminMiddleware(req, res, next); }
function requireScheduleListAccess(req, res, next) {
  const isChannelPreview = req.query.next_only === "1" && req.query.device_id && req.query.output_signal
    && req.query.is_enabled === "1" && Number(req.query.limit) === 1;
  if (isChannelPreview) return next();
  return requireAdminLevel(7)(req, res, next);
}
app.get("/api/device/schedules", requireLogin, requireActiveAccount, requireApproved, requireScheduleListAccess, async (req, res) => {
  try {
    const where = [], params = [];
    if (req.query.device_id) { where.push("s.device_id=?"); params.push(String(req.query.device_id)); }
    if (req.query.output_signal) { where.push("s.output_signal=?"); params.push(String(req.query.output_signal)); }
    if (req.query.created_by) { where.push("s.created_by=?"); params.push(String(req.query.created_by)); }
    if (req.query.action_state && ["ON", "OFF"].includes(String(req.query.action_state).toUpperCase())) { where.push("s.action_state=?"); params.push(String(req.query.action_state).toUpperCase()); }
    if (req.query.repeat_type) { where.push("s.repeat_type=?"); params.push(String(req.query.repeat_type).toUpperCase()); }
    if (req.query.is_enabled !== undefined && req.query.is_enabled !== "") { where.push("s.is_enabled=?"); params.push(req.query.is_enabled === "true" || req.query.is_enabled === "1" ? 1 : 0); }
    if (req.query.next_only === "1") { where.push("s.next_run_at IS NOT NULL"); }
    if (req.query.search) { const q = `%${String(req.query.search).slice(0, 100)}%`; where.push("(s.schedule_name LIKE ? OR s.device_id LIKE ? OR s.output_signal LIKE ? OR s.ostr_payload LIKE ? OR u.user_name LIKE ? OR u.login_id LIKE ?)"); params.push(q, q, q, q, q, q); }
    if (req.query.start_date) { where.push("COALESCE(s.next_run_at,s.schedule_time)>=?"); params.push(`${req.query.start_date} 00:00:00`); }
    if (req.query.end_date) { where.push("COALESCE(s.next_run_at,s.schedule_time)<=?"); params.push(`${req.query.end_date} 23:59:59`); }
    const now = toKoreaDateTime(new Date());
    where.push("s.completed_at IS NULL");
    where.push("(s.end_time IS NULL OR s.end_time>=?)"); params.push(now);
    where.push("(s.repeat_type NOT IN ('ONCE','IMMEDIATE') OR s.schedule_time>=?)"); params.push(now);
    const allowedSort = { schedule_id: "s.schedule_id", owner: "u.user_name", device: "s.device_id", channel: "s.output_signal", action: "s.action_state", repeat: "s.repeat_type", time: "COALESCE(s.next_run_at,s.schedule_time)", created: "s.created_at", status: "s.last_execution_status" };
    const sort = allowedSort[String(req.query.sort_by || "time")] || allowedSort.time;
    const direction = String(req.query.sort_order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500)), offset = (page - 1) * limit;
    const condition = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await query(`SELECT s.*,d.device_name,d.is_visible AS device_is_visible,d.is_enabled AS device_is_enabled,c.is_active AS channel_is_visible,u.user_name AS owner_name,s.created_by AS owner_username FROM device_schedule s LEFT JOIN device d ON d.device_code=s.device_id LEFT JOIN device_channel c ON c.device_id=s.device_id AND c.output_signal=s.output_signal LEFT JOIN user_profile u ON u.login_id=s.created_by ${condition} ORDER BY ${sort} ${direction},s.schedule_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ items: rows, total: rows.length, page, limit });
  } catch (err) { console.error("예약 조회 오류:", err); res.status(500).json({ error: "예약 목록을 조회하지 못했습니다." }); }
});
app.get("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try { const rows = await query(`SELECT s.*,d.device_name,u.user_name AS owner_name,s.created_by AS owner_username FROM device_schedule s LEFT JOIN device d ON d.device_code=s.device_id LEFT JOIN user_profile u ON u.login_id=s.created_by WHERE s.schedule_id=?`, [req.params.id]); if (!rows.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); res.json(rows[0]); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약을 조회하지 못했습니다." }); }
});
app.post("/api/device/schedules", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try {
    const deviceId = String(req.body.device_id || "").trim(), pin = normalizeDevicePin(req.body.output_signal || "");
    if (!deviceId || !DEVICE_OUTPUT_PINS.has(pin)) return res.status(400).json({ error: "디바이스와 유효한 출력 채널을 선택하세요." });
    const devices = await query("SELECT d.device_code AS device_id FROM device d JOIN device_channel c ON c.device_id=d.device_code WHERE d.device_code=? AND c.output_signal=? AND d.is_enabled=1 LIMIT 1", [deviceId, pin]);
    if (!devices.length) return res.status(400).json({ error: "사용 중인 디바이스의 유효한 출력 채널을 선택하세요." });
    const data = validateScheduleInput(req.body);
    const result = await query(`INSERT INTO device_schedule(device_id,output_signal,schedule_name,action_state,ostr_payload,repeat_type,schedule_time,end_time,weekday_mask,is_month_end,is_enabled,next_run_at,last_execution_status,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [deviceId, pin, data.schedule_name, data.action_state, data.ostr_payload, data.repeat_type, data.schedule_time, data.end_time, data.weekday_mask, data.is_month_end ? 1 : 0, data.is_enabled, data.next_run_at, "WAITING", req.user.username, req.user.id]);
    const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [result.insertId]); res.status(201).json(rows[0]);
  } catch (err) { if (err.message) return res.status(400).json({ error: err.message }); console.error(err); res.status(500).json({ error: "예약을 등록하지 못했습니다." }); }
});
app.put("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try {
    const current = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!current.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    const deviceId = String(req.body.device_id || current[0].device_id).trim(), pin = normalizeDevicePin(req.body.output_signal || current[0].output_signal);
    const devices = await query("SELECT d.device_code AS device_id FROM device d JOIN device_channel c ON c.device_id=d.device_code WHERE d.device_code=? AND c.output_signal=? AND d.is_enabled=1 LIMIT 1", [deviceId, pin]); if (!devices.length) return res.status(400).json({ error: "사용 중인 디바이스의 유효한 출력 채널을 선택하세요." });
    const data = validateScheduleInput({ ...current[0], ...req.body, device_id: deviceId, output_signal: pin, is_enabled: true });
    await query(`UPDATE device_schedule SET device_id=?,output_signal=?,schedule_name=?,action_state=?,ostr_payload=?,repeat_type=?,schedule_time=?,end_time=?,weekday_mask=?,is_month_end=?,is_enabled=?,next_run_at=?,last_execution_status='WAITING',updated_by=?,completed_at=NULL WHERE schedule_id=?`, [deviceId, pin, data.schedule_name, data.action_state, data.ostr_payload, data.repeat_type, data.schedule_time, data.end_time, data.weekday_mask, data.is_month_end ? 1 : 0, data.is_enabled, data.next_run_at, req.user.id, req.params.id]);
    const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); res.json(rows[0]);
  } catch (err) { if (err.message) return res.status(400).json({ error: err.message }); console.error(err); res.status(500).json({ error: "예약을 수정하지 못했습니다." }); }
});
app.patch("/api/device/schedules/:id/enabled", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try { const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); const enabled = req.body.is_enabled ? 1 : 0; const next = enabled ? scheduleNextRun(rows[0]) : null; if (enabled && !next) return res.status(400).json({ error: "다음 실행 시각이 종료 시각 이후이거나 유효하지 않습니다." }); await query("UPDATE device_schedule SET is_enabled=?,next_run_at=?,last_execution_status=?,updated_by=? WHERE schedule_id=?", [enabled, next, enabled ? "WAITING" : "DISABLED", req.user.id, req.params.id]); res.json({ ok: true, next_run_at: next }); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약 상태를 변경하지 못했습니다." }); }
});
app.delete("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(7), async (req, res) => {
  try { const result = await query("DELETE FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!result.affectedRows) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약을 삭제하지 못했습니다." }); }
});

app.get("/api/admin/device/report", deviceAdminMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.query.format !== undefined && !["json", "xlsx"].includes(req.query.format)) return res.status(400).json({ error: "지원하지 않는 출력 형식입니다." });
  try {
    const report = await loadDeviceReport(query, req.query);
    if (req.query.format === "xlsx") {
      const buffer = await createReportWorkbook(report);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${report.device.device_id}-report.xlsx"`);
      return res.send(buffer);
    }
    res.json(report);
  } catch (err) {
    if (!err.code) return res.status(400).json({ error: err.message });
    console.error("Device 리포트 오류:", err);
    res.status(500).json({ error: "리포트를 생성하지 못했습니다." });
  }
});

app.get("/api/admin/device/devices", deviceAdminMiddleware, async (req, res) => {
  try { res.json(await getManagedDeviceDevices()); } catch (err) { console.error("Device 관리 목록 오류:", err); res.status(500).json({ error: "Device 장치 목록을 불러오지 못했습니다." }); }
});
app.put("/api/admin/device/devices/order", deviceAdminMiddleware, async (req, res) => {
  const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.map(String) : [];
  if (!deviceIds.length) return res.status(400).json({ error: "장치 순서 정보가 없습니다." });
  try {
    for (const [index, deviceId] of deviceIds.entries()) await query(`UPDATE device SET sort_order=? WHERE device_code=?`, [index + 1, deviceId]);
    res.json({ ok: true });
  } catch (err) { console.error("Device 장치 순서 저장 오류:", err); res.status(500).json({ error: "장치 순서를 저장하지 못했습니다." }); }
});
app.get("/api/device/devices", requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  try {
    const allDevices = await getManagedDeviceDevices();
    if (req.query.include_all === "1" || req.query.include_invisible === "1") {
      if (!["device_schedule", "device_admin", "device_report", "product_channel_link", "production_report"].some(key => canUseFeature(req.user, key, permissionPolicy))) return res.status(403).json({ error: "전체 장치 목록 조회 권한이 없습니다.", code: "ADMIN_REQUIRED" });
      return res.json(allDevices);
    }
    const devices = allDevices
      .filter(device => Number(device.is_visible) === 1 && Number(device.is_enabled) === 1)
      .map(device => ({ ...device, sets: device.sets.filter(set => Number(set.is_visible ?? set.is_active) === 1) }));
    res.json(devices);
  } catch (err) { console.error("활성 Device 목록 오류:", err); res.status(500).json({ error: "활성 Device 장치 목록을 불러오지 못했습니다." }); }
});
function deviceTokenMatches(token, hash) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(String(hash || ""))) return false;
  const actual = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

app.get("/api/admin/device/devices/:deviceId/token", deviceAdminMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const rows = await query("SELECT token_hash,token_ciphertext FROM device WHERE device_code=? LIMIT 1", [req.params.deviceId]);
    if (!rows.length) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
    const row = rows[0];
    const token = row.token_ciphertext ? openDeviceToken(req.params.deviceId, row.token_ciphertext)
      : req.params.deviceId === DEVICE_ID && deviceTokenMatches(DEVICE_TOKEN, row.token_hash) ? DEVICE_TOKEN : null;
    if (!token) return res.json({ tokenAvailable: false, message: "기존 토큰 원문이 보관되어 있지 않습니다. 장치에 설정된 원래 토큰을 입력해 보관할 수 있습니다." });
    if (!deviceTokenMatches(token, row.token_hash)) throw new Error("장치 토큰 보관 값이 현재 인증 정보와 일치하지 않습니다.");
    res.json({ tokenAvailable: true, deviceToken: token });
  } catch (err) {
    console.error("장치 토큰 조회 실패:", err.message);
    res.status(500).json({ error: "장치 토큰을 복원하지 못했습니다. 서버의 토큰 보관 키를 확인하세요." });
  }
});

app.put("/api/admin/device/devices/:deviceId/token", deviceAdminMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const token = req.body?.deviceToken;
  if (typeof token !== "string" || !token || token.length > 512) return res.status(400).json({ error: "기존 장치 토큰을 입력하세요." });
  try {
    const rows = await query("SELECT token_hash FROM device WHERE device_code=? LIMIT 1", [req.params.deviceId]);
    if (!rows.length) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
    if (!deviceTokenMatches(token, rows[0].token_hash)) return res.status(409).json({ error: "현재 장치 토큰과 일치하지 않습니다. 기존 토큰은 변경되지 않았습니다." });
    const result = await query("UPDATE device SET token_ciphertext=? WHERE device_code=? AND token_hash=?", [sealDeviceToken(req.params.deviceId, token), req.params.deviceId, rows[0].token_hash]);
    if (!result.affectedRows) return res.status(409).json({ error: "인증 정보가 변경되었습니다. 장치를 다시 조회하세요." });
    res.json({ ok: true });
  } catch (err) {
    console.error("장치 토큰 보관 실패:", err.message);
    res.status(500).json({ error: "장치 토큰을 보관하지 못했습니다." });
  }
});

app.post("/api/admin/device/devices", deviceAdminMiddleware, async (req, res) => {
  const deviceId = String(req.body.deviceId || "").trim(), deviceName = String(req.body.deviceName || "").trim();
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(deviceId)) return res.status(400).json({ error: "장치 ID는 영문, 숫자, 밑줄, 하이픈으로 2~100자 입력하세요." });
  if (!deviceName) return res.status(400).json({ error: "장치 이름을 입력하세요." });
  const token = crypto.randomBytes(32).toString("hex"), tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const exists = await query(`SELECT device_id AS id FROM device WHERE device_code=?`, [deviceId]);
    if (exists.length) return res.status(409).json({ error: "장치 ID가 중복되었습니다." });
    const orderRows = await query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM device`);
    await query(`INSERT INTO device(device_code,device_name,token_hash,token_ciphertext,is_visible,is_enabled,sort_order,last_change_source) VALUES(?,?,?,?,?,?,?,'BOOT')`, [deviceId, deviceName, tokenHash, sealDeviceToken(deviceId, token), 1, 1, orderRows[0].next_order]);
    res.setHeader("Cache-Control", "no-store");
    for (const [index, [inputPin, outputPin]] of DEVICE_FIXED_SETS.entries()) await query(`INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order) VALUES(?,?,?,?,?)`, [deviceId, outputPin, inputPin, outputPin, index]);
    res.status(201).json({ device: { device_id: deviceId, device_name: deviceName, is_visible: 1, is_enabled: 1, sets: DEVICE_FIXED_SETS.map(([inputPin, outputPin], index) => ({ channel_name: `채널 ${String(index + 1).padStart(2, "0")}`, input_signal: inputPin, output_signal: outputPin, output_state: "OFF", input_state: "OFF", is_visible: 1, sort_order: index })) }, deviceToken: token });
  } catch (err) { console.error("Device 장치 등록 오류:", err); res.status(500).json({ error: "Device 장치를 등록하지 못했습니다." }); }
});
app.put("/api/admin/device/devices/:deviceId", deviceAdminMiddleware, async (req, res) => {
  const name = String(req.body.deviceName || "").trim();
  if (!name) return res.status(400).json({ error: "장치 이름을 입력하세요." });
  const visibleValue = req.body.enabled ?? req.body.visible ?? req.body.active;
  const is_visible = visibleValue === undefined ? null : (visibleValue ? 1 : 0);
  const is_enabled = req.body.enabled === undefined ? null : (req.body.enabled ? 1 : 0);
  const result = await query(`UPDATE device SET device_name=?,is_visible=COALESCE(?,is_visible),is_enabled=COALESCE(?,is_enabled),updated_at=NOW() WHERE device_code=?`, [name, is_visible, is_enabled, req.params.deviceId]);
  if (!result.affectedRows) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
  if (is_enabled === 0) deviceDeviceSockets.get(req.params.deviceId)?.close(1008, "Device disabled");
  if (is_enabled !== null) broadcastDeviceBrowsers({ type: "deviceEnabledChanged", deviceId: req.params.deviceId, enabled: is_enabled === 1 });
  res.json({ ok: true });
});
app.delete("/api/admin/device/devices/:deviceId", deviceAdminMiddleware, async (req, res) => {
  try {
    const existing = await query(`SELECT device_code FROM device WHERE device_code=? LIMIT 1`, [req.params.deviceId]);
    if (!existing.length) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
    await query(`DELETE FROM device WHERE device_code=?`, [req.params.deviceId]);
    const deletedSocket = deviceDeviceSockets.get(req.params.deviceId); if (deletedSocket) { deletedSocket.close(1008, "Device deleted"); deviceDeviceSockets.delete(req.params.deviceId); } if (req.params.deviceId === DEVICE_ID) deviceDeviceSocket = null;
    res.json({ ok: true });
  } catch (err) { console.error("Device 장치 삭제 오류:", err); res.status(500).json({ error: "장치를 삭제하지 못했습니다." }); }
});
app.put("/api/admin/device/devices/:deviceId/contact-sets/order", deviceAdminMiddleware, async (req, res) => {
  const channelIds = Array.isArray(req.body.channelIds) ? req.body.channelIds.map(String) : [];
  if (!channelIds.length || new Set(channelIds).size !== channelIds.length) return res.status(400).json({ error: "올바른 채널 순서를 지정하세요." });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const channels = await connectionQuery(connection, "SELECT channel_id FROM device_channel WHERE device_id=? FOR UPDATE", [req.params.deviceId]);
    const storedIds = new Set(channels.map(channel => String(channel.channel_id)));
    if (storedIds.size !== channelIds.length || channelIds.some(id => !storedIds.has(id))) {
      await connection.rollback();
      return res.status(400).json({ error: "해당 장치의 모든 채널을 한 번씩 지정하세요." });
    }
    for (const [index, channelId] of channelIds.entries()) {
      await connectionQuery(connection, "UPDATE device_channel SET sort_order=?,updated_at=NOW() WHERE channel_id=? AND device_id=?", [index, channelId, req.params.deviceId]);
    }
    await connection.commit();
    res.json({ ok: true });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("채널 순서 저장 오류:", err);
    res.status(500).json({ error: "채널 순서를 저장하지 못했습니다." });
  } finally {
    connection?.release();
  }
});
app.put("/api/admin/device/devices/:deviceId/contact-sets/:setId", deviceAdminMiddleware, async (req, res) => {
  const name = String(req.body.setName || "").trim();
  if (!name) return res.status(400).json({ error: "접점 세트 이름을 입력하세요." });
  const visibleValue = req.body.visible ?? req.body.active;
  const is_visible = visibleValue === undefined ? null : (visibleValue ? 1 : 0);
  const enabledFields = ["webControlEnabled", "webOnEnabled", "webOffEnabled", "webScheduleEnabled"];
  if (enabledFields.some(field => req.body[field] !== undefined && typeof req.body[field] !== "boolean")) return res.status(400).json({ error: "채널 제어 설정을 올바르게 선택하세요." });
  const webControlEnabled = req.body.webControlEnabled === undefined ? null : (req.body.webControlEnabled ? 1 : 0);
  const webOnEnabled = req.body.webOnEnabled === undefined ? null : (req.body.webOnEnabled ? 1 : 0);
  const webOffEnabled = req.body.webOffEnabled === undefined ? null : (req.body.webOffEnabled ? 1 : 0);
  const webScheduleEnabled = req.body.webScheduleEnabled === undefined ? null : (req.body.webScheduleEnabled ? 1 : 0);
  const result = await query(`UPDATE device_channel SET channel_name=?,is_active=COALESCE(?,is_active),web_control_enabled=COALESCE(?,web_control_enabled),web_on_enabled=COALESCE(?,web_on_enabled),web_off_enabled=COALESCE(?,web_off_enabled),web_schedule_enabled=COALESCE(?,web_schedule_enabled),updated_at=NOW() WHERE channel_id=? AND device_id=?`, [name, is_visible, webControlEnabled, webOnEnabled, webOffEnabled, webScheduleEnabled, req.params.setId, req.params.deviceId]);
  if (!result.affectedRows) return res.status(404).json({ error: "접점 세트를 찾을 수 없습니다." });
  res.json({ ok: true });
});

// ---------------------------------------------------------
// 신규 DB 테이블 준비 + 최초 마스터 생성
// ---------------------------------------------------------
// 현재 구조를 생성하고, 기존 DB에서는 Device 식별 컬럼과 해당 외래키만 안전하게 이전합니다.
async function verifySchemaNames() {
  const requiredColumns = {
    user_profile: ["user_id", "user_name", "user_status"],
    product: ["product_id", "product_status"],
    user_setting: ["user_id"],
    device_channel: ["channel_id"],
    product_channel_mapping: ["mapping_id"],
    device_command: ["command_row_id"],
    device_state_history: ["history_id"]
  };
  const oldTables = new Set(["users", "products", "user_settings", "devices", "device_channels", "device_commands"]);
  const rows = await query("SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE()");
  const columnsByTable = new Map();
  for (const row of rows) {
    if (oldTables.has(row.table_name)) throw new Error("기존 DB 이름이 발견되었습니다. 백업 후 migrate-schema-names.sql을 수동 적용하세요.");
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const existing = columnsByTable.get(table);
    if (existing && columns.some(column => !existing.has(column))) {
      throw new Error(`DB 컬럼 이름이 현재 버전과 다릅니다 (${table}). 백업과 수동 마이그레이션 상태를 확인하세요.`);
    }
  }
  const productColumns = columnsByTable.get("product");
  if (productColumns && !productColumns.has("is_enabled") && !productColumns.has("is_active")) {
    throw new Error("product 테이블에 is_enabled 컬럼이 없습니다. 기존 스키마를 확인하세요.");
  }
}

async function ensureUserProfileLoginId() {
  const loginIdColumns = await query("SHOW COLUMNS FROM user_profile LIKE 'login_id'");
  const legacyUsernameColumns = await query("SHOW COLUMNS FROM user_profile LIKE 'username'");
  if (loginIdColumns.length && legacyUsernameColumns.length) {
    throw new Error("user_profile 테이블에 login_id와 username 컬럼이 함께 있습니다. 컬럼 상태를 확인하세요.");
  }
  if (!loginIdColumns.length && legacyUsernameColumns.length) {
    await query("ALTER TABLE user_profile CHANGE COLUMN username login_id VARCHAR(50) NOT NULL");
  } else if (!loginIdColumns.length) {
    throw new Error("user_profile 테이블에 login_id 컬럼이 없습니다.");
  }
}

async function ensureUserProfileContactConstraints() {
  const columns = await query("SELECT COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_profile' AND COLUMN_NAME IN ('phone','email')");
  const columnByName = new Map(columns.map(column => [column.column_name, column]));
  for (const field of ["phone", "email"]) if (!columnByName.has(field)) throw new Error(`user_profile에 ${field} 컬럼이 없습니다.`);

  const duplicateEmails = await query("SELECT LOWER(TRIM(email)) AS normalized_email FROM user_profile WHERE email IS NOT NULL AND TRIM(email)<>'' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*)>1 LIMIT 1");
  if (duplicateEmails.length) throw new Error("user_profile에 중복 이메일이 있어 UNIQUE 제약을 적용할 수 없습니다. 기존 데이터를 확인하세요.");

  const nullableChanges = [];
  for (const field of ["phone", "email"]) {
    const column = columnByName.get(field);
    if (column.is_nullable !== "YES" || column.column_default != null) nullableChanges.push(`MODIFY COLUMN ${field} ${column.column_type} NULL DEFAULT NULL`);
  }
  if (nullableChanges.length) await query(`ALTER TABLE user_profile ${nullableChanges.join(", ")}`);

  const phoneRows = await query("SELECT user_id,phone FROM user_profile WHERE phone IS NOT NULL AND TRIM(phone)<>'' ORDER BY user_id");
  const phoneGroups = new Map();
  for (const row of phoneRows) {
    const normalized = normalizePhone(row.phone);
    const key = normalized || String(row.phone).trim().toLowerCase();
    if (!phoneGroups.has(key)) phoneGroups.set(key, []);
    phoneGroups.get(key).push({ userId: row.user_id, phone: row.phone, normalized });
  }
  for (const group of phoneGroups.values()) {
    group.sort((left, right) => Number(left.userId) - Number(right.userId));
    if (group.length > 1) {
      const duplicateIds = group.slice(1).map(row => row.userId);
      await query(`UPDATE user_profile SET phone=NULL WHERE user_id IN (${duplicateIds.map(() => "?").join(",")})`, duplicateIds);
    }
    const retained = group[0];
    if (retained.normalized && retained.phone !== retained.normalized) await query("UPDATE user_profile SET phone=? WHERE user_id=?", [retained.normalized, retained.userId]);
  }

  await query("UPDATE user_profile SET phone=NULL WHERE phone IS NOT NULL AND TRIM(phone)=''");
  await query("UPDATE user_profile SET email=NULL WHERE email IS NOT NULL AND TRIM(email)=''");

  const indexes = await query("SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,NON_UNIQUE AS non_unique,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_profile' ORDER BY INDEX_NAME,SEQ_IN_INDEX");
  const groupedIndexes = new Map();
  for (const index of indexes) {
    if (!groupedIndexes.has(index.index_name)) groupedIndexes.set(index.index_name, []);
    groupedIndexes.get(index.index_name).push(index);
  }
  const hasUniqueSingleColumn = field => [...groupedIndexes.values()].some(parts => parts.length === 1 && parts[0].column_name === field && Number(parts[0].non_unique) === 0);
  const changes = [];
  for (const field of ["phone", "email"]) {
    const indexName = `uq_user_profile_${field}`;
    if (!hasUniqueSingleColumn(field)) {
      if (groupedIndexes.has(indexName)) throw new Error(`user_profile의 ${indexName} 인덱스 정의를 확인하세요.`);
      changes.push(`ADD UNIQUE KEY ${indexName} (${field})`);
    }
  }
  if (changes.length) await query(`ALTER TABLE user_profile ${changes.join(", ")}`);
}

async function ensureUserProfileAddress() {
  const columns = await query("SHOW COLUMNS FROM user_profile LIKE 'address'");
  if (!columns.length) await query("ALTER TABLE user_profile ADD COLUMN address VARCHAR(255) NULL DEFAULT NULL AFTER phone");
}

async function ensureOrganizationGroupCode() {
  const columns = await query("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='company_organization' AND COLUMN_NAME IN ('group','group_code')");
  const names = new Set(columns.map(column => column.column_name));
  if (names.has("group") && names.has("group_code")) throw new Error("company_organization에 group과 group_code 컬럼이 함께 있습니다. 기존 데이터를 확인하세요.");
  if (names.has("group")) await renameOrganizationColumns([["group", "group_code"]]);
  else if (!names.has("group_code")) throw new Error("company_organization에 group_code 컬럼이 없습니다.");
}

async function ensureOrganizationJobColumns() {
  const columns = await query("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='company_organization' AND COLUMN_NAME IN ('role','job','role_name','job_name')");
  const names = new Set(columns.map(column => column.column_name));
  const pairs = [["role", "job"], ["role_name", "job_name"]];
  for (const [oldName, newName] of pairs) {
    if (names.has(oldName) && names.has(newName)) throw new Error(`company_organization에 ${oldName}과 ${newName} 컬럼이 함께 있습니다. 기존 데이터를 확인하세요.`);
    if (!names.has(oldName) && !names.has(newName)) throw new Error(`company_organization에 ${newName} 컬럼이 없습니다.`);
  }
  const changes = pairs.filter(([oldName]) => names.has(oldName));
  if (changes.length) await renameOrganizationColumns(changes);
}

async function renameOrganizationColumns(pairs) {
  const versions = await query("SELECT VERSION() AS version");
  const mariaDB = /mariadb/i.test(versions[0].version);
  const checks = await query("SELECT tc.CONSTRAINT_NAME AS constraint_name,cc.CHECK_CLAUSE AS check_clause FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME" + (mariaDB ? " AND cc.TABLE_NAME=tc.TABLE_NAME" : "") + " WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='company_organization' AND tc.CONSTRAINT_TYPE='CHECK'");
  const quote = name => "`" + name.replace(/`/g, "``") + "`";
  const replacements = new Map(pairs);
  const affected = checks.map(check => ({ ...check, updated_clause: check.check_clause.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`|[A-Za-z_][A-Za-z0-9_$]*/g, token => {
    if (token.startsWith("'") || token.startsWith('"')) return token;
    const name = token.startsWith("`") ? token.slice(1, -1).replace(/``/g, "`") : token;
    return replacements.has(name) ? quote(replacements.get(name)) : token;
  }) })).filter(check => check.updated_clause !== check.check_clause);
  const changes = [
    ...affected.map(check => `DROP ${mariaDB ? "CONSTRAINT" : "CHECK"} ${quote(check.constraint_name)}`),
    ...pairs.map(([oldName, newName]) => `RENAME COLUMN ${quote(oldName)} TO ${newName}`),
    ...affected.map(check => `ADD CONSTRAINT ${quote(check.constraint_name)} CHECK (${check.updated_clause})`)
  ];
  await query(`ALTER TABLE company_organization ${changes.join(", ")}`);
}

async function ensureOrganizationSchema() {
  await query(`CREATE TABLE IF NOT EXISTS company_organization (
    organization_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    group_code CHAR(3) NOT NULL,
    company CHAR(3) NULL,
    site CHAR(3) NULL,
    department CHAR(3) NULL,
    job CHAR(3) NULL,
    group_name VARCHAR(100) NOT NULL DEFAULT '',
    company_name VARCHAR(150) NULL DEFAULT NULL,
    site_name VARCHAR(100) NULL DEFAULT NULL,
    department_name VARCHAR(100) NULL DEFAULT NULL,
    job_name VARCHAR(100) NULL DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_organization_codes (group_code,company,site,department,job),
    CONSTRAINT chk_organization_code_lengths CHECK (CHAR_LENGTH(group_code)=3 AND CHAR_LENGTH(company)=3 AND CHAR_LENGTH(site)=3 AND CHAR_LENGTH(department)=3 AND CHAR_LENGTH(job)=3)
  ) ENGINE=InnoDB`);
  await ensureOrganizationGroupCode();
  await ensureOrganizationJobColumns();
  const codeColumns = await query("SELECT COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='company_organization' AND COLUMN_NAME IN ('company','site','department','job','company_name','site_name','department_name','job_name')");
  const nullableChanges = codeColumns.filter(column => column.is_nullable === "NO").map(column => `MODIFY COLUMN \`${column.column_name}\` ${column.column_type} NULL`);
  if (nullableChanges.length) await query(`ALTER TABLE company_organization ${nullableChanges.join(", ")}`);
  await query("INSERT INTO company_organization (group_code,group_name) SELECT 'ZZZ','KIMS' WHERE NOT EXISTS (SELECT 1 FROM company_organization WHERE group_code='ZZZ' AND company IS NULL AND site IS NULL AND department IS NULL AND job IS NULL)");
  await query("INSERT INTO company_organization (group_code,company,site,department,job,group_name,company_name,site_name,department_name,job_name) VALUES ('ZZZ','AAA','AAA','AAA','AAA','KIMS','V0 관리자','V0 개발자','KOREA','개발자') ON DUPLICATE KEY UPDATE organization_id=organization_id");
  await query("UPDATE company_organization SET group_code='001',company='001',site='001',department=NULL,job=NULL,group_name='개인L5',company_name='개인L4',site_name='개인L3',department_name=NULL,job_name=NULL WHERE group_code IN ('000','001') AND company=group_code AND site=group_code AND department=group_code AND job=group_code");
  await query("INSERT INTO company_organization (group_code,company,site,group_name,company_name,site_name) SELECT '001','001','001','개인L5','개인L4','개인L3' WHERE NOT EXISTS (SELECT 1 FROM company_organization WHERE group_code='001' AND company='001' AND site='001' AND department IS NULL AND job IS NULL)");
}

async function ensureRegistrationSchema() {
  const columns = await query("SHOW COLUMNS FROM user_profile LIKE 'organization_id'");
  if (!columns.length) await query("ALTER TABLE user_profile ADD COLUMN organization_id INT UNSIGNED NULL AFTER user_name");
  const keys = await query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_profile' AND COLUMN_NAME='organization_id' AND REFERENCED_TABLE_NAME='company_organization'");
  if (!keys.length) await query("ALTER TABLE user_profile ADD CONSTRAINT fk_user_profile_organization FOREIGN KEY (organization_id) REFERENCES company_organization(organization_id) ON DELETE SET NULL");
  await ensureSignupOrganizationCodes();
  const legacyColumns = await query("SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_profile' AND COLUMN_NAME IN ('region','company','position')");
  const legacy = new Set(legacyColumns.map(column => column.column_name));
  if (legacy.size) {
    await query(`CREATE TABLE IF NOT EXISTS user_profile_organization_legacy (
      user_id INT NOT NULL PRIMARY KEY,
      region VARCHAR(100) NOT NULL DEFAULT '',
      company VARCHAR(150) NOT NULL DEFAULT '',
      \`position\` VARCHAR(100) NOT NULL DEFAULT '',
      archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_user_profile_org_legacy_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    const columnName = { region: "`region`", company: "`company`", position: "`position`" };
    const expression = field => legacy.has(field) ? `COALESCE(u.${columnName[field]},'')` : "''";
    const nonempty = [...legacy].map(field => `${expression(field)}<>''`).join(" OR ");
    const mismatch = [
      legacy.has("region") ? "NOT (u.`region` <=> o.site_name)" : "",
      legacy.has("company") ? "NOT (u.`company` <=> o.company_name)" : "",
      legacy.has("position") ? "NOT (u.`position` <=> o.job_name)" : ""
    ].filter(Boolean).join(" OR ") || "FALSE";
    await query(`INSERT IGNORE INTO user_profile_organization_legacy (user_id,region,company,\`position\`)
      SELECT u.user_id,${expression("region")},${expression("company")},${expression("position")}
      FROM user_profile u LEFT JOIN company_organization o ON o.organization_id=u.organization_id
      WHERE (${nonempty}) AND (o.organization_id IS NULL OR ${mismatch})`);
    await query(`ALTER TABLE user_profile ${[...legacy].map(field => `DROP COLUMN ${columnName[field]}`).join(", ")}`);
  }
  const commentTables = await query("SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('register_comment','user-register_comment','user_register_comment')");
  const commentNames = new Set(commentTables.map(row => row.table_name));
  const commentSources = ["register_comment", "user-register_comment"].filter(name => commentNames.has(name));
  if ((commentNames.has("user_register_comment") && commentSources.length) || commentSources.length > 1) throw new Error("가입 이력 테이블 이름이 여러 개 존재합니다. 기존 이력 보존 상태를 확인하세요.");
  if (commentSources.length === 1) await query(`RENAME TABLE ${commentSources[0] === "register_comment" ? "`register_comment`" : "`user-register_comment`"} TO user_register_comment`);
  await query(`CREATE TABLE IF NOT EXISTS user_register_comment (
    comment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    login_id VARCHAR(50) NOT NULL,
    event_type ENUM('APPLICATION','REAPPLICATION','APPROVAL','REJECTION','SUSPENSION','STATUS','LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST','WITHDRAWAL_REQUEST','WITHDRAWAL_REJECTION','WITHDRAWAL_APPROVAL','DELETION') NOT NULL,
    comment TEXT NOT NULL,
    actor_user_id INT NULL,
    actor_login_id VARCHAR(50) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    request_comment_id BIGINT UNSIGNED NULL,
    KEY idx_register_comment_user (user_id,created_at,comment_id),
    KEY idx_register_comment_login (login_id,created_at),
    KEY idx_register_comment_request (request_comment_id,event_type),
    CONSTRAINT fk_register_comment_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_register_comment_actor FOREIGN KEY (actor_user_id) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  const eventTypeColumn = await query("SHOW COLUMNS FROM user_register_comment LIKE 'event_type'");
  if (eventTypeColumn.length && ["REAPPLICATION", "LEVEL_CHANGE_REQUEST", "ORGANIZATION_CHANGE_REQUEST", "WITHDRAWAL_REQUEST", "WITHDRAWAL_REJECTION", "WITHDRAWAL_APPROVAL", "DELETION"].some(event => !String(eventTypeColumn[0].Type).includes(event))) await query("ALTER TABLE user_register_comment MODIFY COLUMN event_type ENUM('APPLICATION','REAPPLICATION','APPROVAL','REJECTION','SUSPENSION','STATUS','LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST','WITHDRAWAL_REQUEST','WITHDRAWAL_REJECTION','WITHDRAWAL_APPROVAL','DELETION') NOT NULL");
  const requestColumn = await query("SHOW COLUMNS FROM user_register_comment LIKE 'request_comment_id'");
  if (!requestColumn.length) await query("ALTER TABLE user_register_comment ADD COLUMN request_comment_id BIGINT UNSIGNED NULL, ADD KEY idx_register_comment_request (request_comment_id,event_type)");
}

async function ensurePermissionPolicy() {
  const definition = `CREATE TABLE IF NOT EXISTS site_permission_policy (
    poicy_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_name VARCHAR(100) NOT NULL,
    default_leble TINYINT UNSIGNED NOT NULL DEFAULT 1,
    permisson_lebel TINYINT UNSIGNED NOT NULL DEFAULT 1,
    updated_by INT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_permission_site (site_name),
    CONSTRAINT chk_permission_level CHECK (permisson_lebel BETWEEN 1 AND 20)
  ) ENGINE=InnoDB`;
  await query(definition);
  const columns = await query("SHOW COLUMNS FROM site_permission_policy");
  const names = new Set(columns.map(column => column.Field || column.column_name));
  const legacy = names.has("levels_json");
  let finalizeDefaults = false;
  if (!legacy) {
    const expected = names.has("default_leble") ? 6 : 5;
    if (names.size !== expected || !["poicy_id", "site_name", "permisson_lebel", "updated_by", "updated_at"].every(name => names.has(name))) throw new Error("site_permission_policy 컬럼 구성을 확인하세요.");
    if (!names.has("default_leble")) {
      await query("ALTER TABLE site_permission_policy ADD COLUMN default_leble TINYINT UNSIGNED NULL AFTER site_name");
      finalizeDefaults = true;
    } else {
      const position = columns.findIndex(column => (column.Field || column.column_name) === "default_leble");
      finalizeDefaults = position !== 2 || columns[position].Null === "YES";
    }
  }
  if (legacy) {
    const backups = await query("SHOW TABLES LIKE 'site_permission_policy_legacy'");
    if (backups.length) throw new Error("기존 권한 백업 테이블이 이미 있습니다. 이전 상태를 확인하세요.");
    await query(definition.replace("site_permission_policy (", "site_permission_policy_next ("));
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let sites;
    if (legacy) {
      const rows = await connectionQuery(connection, "SELECT scheme_version,levels_json,updated_by,updated_at FROM site_permission_policy WHERE policy_id=1 FOR UPDATE");
      const row = rows[0];
      if (!row) throw new Error("기존 레벨 권한 설정이 없습니다.");
      const originalLevels = JSON.parse(row.levels_json);
      if (!Object.hasOwn(originalLevels, "company_admin")) originalLevels.company_admin = 16;
      const validated = validatePermissionPolicy(originalLevels);
      if (validated.error) throw new Error(validated.error);
      if (Number(row.scheme_version) === 10) {
        await connectionQuery(connection, "UPDATE user_profile SET permission_level=CASE WHEN permission_level<=1 THEN 1 WHEN permission_level<=10 THEN permission_level*2 ELSE permission_level END");
        await connectionQuery(connection, "UPDATE site_permission_policy SET scheme_version=20 WHERE policy_id=1");
      } else if (Number(row.scheme_version) !== 20) throw new Error("지원하지 않는 권한 레벨 형식입니다.");
      for (const site of permissionPolicySites(validated.levels, row.updated_by, row.updated_at)) {
        await connectionQuery(connection, `INSERT INTO site_permission_policy_next (poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at) VALUES (?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP(6)))
          ON DUPLICATE KEY UPDATE site_name=VALUES(site_name),default_leble=VALUES(default_leble),permisson_lebel=VALUES(permisson_lebel),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`, [site.poicy_id, site.site_name, site.default_leble, site.permisson_lebel, site.updated_by, site.updated_at]);
      }
      sites = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy_next ORDER BY poicy_id");
    } else {
      await connectionQuery(connection, "UPDATE site_permission_policy SET site_name=?,updated_at=updated_at WHERE site_name=?", ["/user_customization.html", "/device-simple.html"]);
      if (finalizeDefaults) {
        for (const site of permissionPolicySites()) await connectionQuery(connection, "UPDATE site_permission_policy SET default_leble=?,updated_at=updated_at WHERE site_name=? AND default_leble IS NULL", [site.default_leble, site.site_name]);
      }
      sites = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id FOR UPDATE");
      if (!sites.length) {
        for (const site of permissionPolicySites()) await connectionQuery(connection, "INSERT INTO site_permission_policy (poicy_id,site_name,default_leble,permisson_lebel) VALUES (?,?,?,?)", [site.poicy_id, site.site_name, site.default_leble, site.permisson_lebel]);
        sites = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id");
      } else if (!sites.some(site => site.site_name === "/user-company.html") && sites.length === FEATURES.length - 1 && FEATURES.filter(feature => feature.key !== "company_admin").every(feature => sites.some(site => site.site_name === permissionSiteName(feature)))) {
        await connectionQuery(connection, "INSERT INTO site_permission_policy (site_name,default_leble,permisson_lebel) VALUES (?,16,16)", ["/user-company.html"]);
        sites = await connectionQuery(connection, "SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id");
      }
    }
    const validated = policyFromSiteRows(sites);
    if (validated.error) throw new Error(validated.error);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  if (legacy) await query("RENAME TABLE site_permission_policy TO site_permission_policy_legacy, site_permission_policy_next TO site_permission_policy");
  if (finalizeDefaults) await query("ALTER TABLE site_permission_policy MODIFY COLUMN default_leble TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER site_name");
  applyPermissionSiteRows(await query("SELECT poicy_id,site_name,default_leble,permisson_lebel,updated_by,updated_at FROM site_permission_policy ORDER BY poicy_id"));
}

async function ensureSchema() {
  await ensureOrganizationSchema();
  await query(`CREATE TABLE IF NOT EXISTS user_profile (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    login_id VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    user_name VARCHAR(100) NOT NULL DEFAULT '',
    organization_id INT UNSIGNED NULL,
    signup_department_code CHAR(3) NULL,
    signup_role_code CHAR(3) NULL,
    phone VARCHAR(20) NULL DEFAULT NULL,
    address VARCHAR(255) NULL DEFAULT NULL,
    email VARCHAR(254) NULL DEFAULT NULL,
    role ENUM('USER','MASTER') NOT NULL DEFAULT 'USER',
    permission_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
    admin_memo TEXT NULL,
    user_request_at DATETIME NULL,
    user_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    approved_at DATETIME NULL,
    approved_by INT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_profile_approved_by FOREIGN KEY (approved_by) REFERENCES user_profile(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_user_profile_organization FOREIGN KEY (organization_id) REFERENCES company_organization(organization_id) ON DELETE SET NULL,
    UNIQUE KEY uq_user_profile_email (email),
    UNIQUE KEY uq_user_profile_phone (phone),
    UNIQUE KEY uq_user_profile_signup_codes (signup_department_code,signup_role_code),
    KEY idx_user_profile_status (user_status),
    KEY idx_user_profile_permission_level (permission_level),
    KEY idx_user_profile_created_at (created_at)
  ) ENGINE=InnoDB`);

  await ensureUserProfileLoginId();
  await ensureUserProfileContactConstraints();
  await ensureUserProfileAddress();
  await ensureRegistrationSchema();
  await ensurePermissionPolicy();

  await query(`CREATE TABLE IF NOT EXISTS product (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_code VARCHAR(50) NOT NULL UNIQUE,
    product_name VARCHAR(100) NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    work_quantity INT NOT NULL DEFAULT 0,
    target_quantity INT NOT NULL DEFAULT 100,
    quantity_reason VARCHAR(500) NOT NULL DEFAULT '',
    quantity_actor VARCHAR(150) NOT NULL DEFAULT '',
    quantity_change_type VARCHAR(30) NOT NULL DEFAULT 'LEGACY',
    product_status VARCHAR(20) NOT NULL DEFAULT '대기',
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    updated_by INT NULL,
    updated_by_label VARCHAR(100) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_product_updated_by FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  const productEnabledColumns = await query("SHOW COLUMNS FROM product LIKE 'is_enabled'");
  const productActiveColumns = await query("SHOW COLUMNS FROM product LIKE 'is_active'");
  if (!productEnabledColumns.length && productActiveColumns.length) {
    await query("ALTER TABLE product CHANGE COLUMN is_active is_enabled TINYINT(1) NOT NULL DEFAULT 1");
  } else if (!productEnabledColumns.length) {
    await query("ALTER TABLE product ADD COLUMN is_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER product_status");
  } else if (productActiveColumns.length) {
    await query("UPDATE product SET is_enabled=is_active");
    await query("ALTER TABLE product DROP COLUMN is_active");
  }

  const productSortOrderColumns = await query("SHOW COLUMNS FROM product LIKE 'sort_order'");
  if (!productSortOrderColumns.length) {
    await query("ALTER TABLE product ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER is_enabled");
    await query("UPDATE product SET sort_order=product_id");
  }
  const productUpdatedByLabelColumns = await query("SHOW COLUMNS FROM product LIKE 'updated_by_label'");
  if (!productUpdatedByLabelColumns.length) {
    await query("ALTER TABLE product ADD COLUMN updated_by_label VARCHAR(100) NULL AFTER updated_by");
  }

  await query(`CREATE TABLE IF NOT EXISTS user_setting (
    user_id INT NOT NULL PRIMARY KEY,
    sound_type VARCHAR(20) NOT NULL DEFAULT 'bell',
    sound_volume TINYINT UNSIGNED NOT NULL DEFAULT 50,
    sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
    theme VARCHAR(10) NOT NULL DEFAULT 'light',
    display_mode VARCHAR(10) NOT NULL DEFAULT 'normal',
    show_summary TINYINT(1) NOT NULL DEFAULT 1,
    show_target TINYINT(1) NOT NULL DEFAULT 1,
    show_rate TINYINT(1) NOT NULL DEFAULT 1,
    show_updated_at TINYINT(1) NOT NULL DEFAULT 1,
    show_updated_by TINYINT(1) NOT NULL DEFAULT 1,
    show_device_istr TINYINT(1) NOT NULL DEFAULT 1,
    show_device_ostr TINYINT(1) NOT NULL DEFAULT 1,
    show_device_ostr_inputs TINYINT(1) NOT NULL DEFAULT 1,
    date_format VARCHAR(10) NOT NULL DEFAULT 'ko-KR',
    User_customization LONGTEXT NULL,
    product_view_selection LONGTEXT NULL,
    product_control_selection LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_setting_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  for (const column of Object.values(PRODUCT_SELECTION_COLUMNS)) {
    const columns = await query(`SHOW COLUMNS FROM user_setting LIKE '${column}'`);
    if (!columns.length) await query(`ALTER TABLE user_setting ADD COLUMN ${column} LONGTEXT NULL`);
  }

  const User_customizationChannelColumns = await query("SHOW COLUMNS FROM user_setting LIKE 'User_customization'");
  const User_customizationLegacyColumns = await query("SHOW COLUMNS FROM user_setting LIKE 'simple_channels'");
  if (!User_customizationChannelColumns.length) {
    await query(User_customizationLegacyColumns.length
      ? "ALTER TABLE user_setting CHANGE COLUMN simple_channels User_customization LONGTEXT NULL"
      : "ALTER TABLE user_setting ADD COLUMN User_customization LONGTEXT NULL");
  } else if (User_customizationLegacyColumns.length) {
    await query("UPDATE user_setting SET User_customization=simple_channels,updated_at=updated_at WHERE User_customization IS NULL AND simple_channels IS NOT NULL");
  }

  await ensureDeviceSchema();
  await ensureProductHistory(query);

  await query(`CREATE TABLE IF NOT EXISTS product_channel_mapping (
    mapping_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id INT NOT NULL,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL,
    mapping_name VARCHAR(100) NOT NULL DEFAULT '',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (mapping_id),
    UNIQUE KEY uq_product_channel_mapping (product_id,device_id,output_signal),
    KEY idx_product_channel_device (device_id,output_signal),
    CONSTRAINT fk_pcm_product FOREIGN KEY (product_id) REFERENCES product(product_id) ON DELETE CASCADE,
    CONSTRAINT fk_pcm_device_channel FOREIGN KEY (device_id,output_signal) REFERENCES device_channel(device_id,output_signal) ON DELETE CASCADE,
    CONSTRAINT fk_pcm_created_by FOREIGN KEY (created_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  const mappingNameColumns = await query("SHOW COLUMNS FROM product_channel_mapping LIKE 'mapping_name'");
  if (!mappingNameColumns.length) {
    await query("ALTER TABLE product_channel_mapping ADD COLUMN mapping_name VARCHAR(100) NOT NULL DEFAULT '' AFTER output_signal");
  }

  await ensureExistingMasterAccounts();
  const masterUsername = String(process.env.MASTER_USERNAME || "").trim();
  const masterPassword = INITIAL_MASTER_PASSWORD;
  const masterName = String(process.env.MASTER_NAME || "").trim();
  const masterPhone = normalizePhone(process.env.MASTER_PHONE || "") || "";
  const masterEmail = normalizeEmail(process.env.MASTER_EMAIL || "") || "";

  if (masterUsername && masterPassword) {
    const masterOrganizationId = await findMasterOrganizationId();
    const rows = await query("SELECT user_id AS id,password_hash FROM user_profile WHERE login_id=? LIMIT 1", [masterUsername]);
    if (!rows.length) {
      await query(`INSERT INTO user_profile (login_id,password_hash,user_name,organization_id,phone,email,role,permission_level,user_status,approved_at) VALUES (?,?,?,?,?,?,'MASTER',25,'APPROVED',NOW())`, [masterUsername, hashPassword(masterPassword), masterName, masterOrganizationId, masterPhone, masterEmail]);
      console.log(`최초 MASTER 계정 생성: ${masterUsername}`);
    } else {
      const passwordHash = rows[0].password_hash === "INITIAL_MASTER_NO_PASSWORD" ? hashPassword(masterPassword) : rows[0].password_hash;
      await query("UPDATE user_profile SET role='MASTER',permission_level=25,organization_id=?,user_status='APPROVED',approved_at=COALESCE(approved_at,NOW()),password_hash=? WHERE login_id=?", [masterOrganizationId, passwordHash, masterUsername]);
    }
  } else {
    console.log("MASTER_USERNAME과 MASTER_PASSWORD를 .env에 설정하면 최초 MASTER 계정이 자동 생성됩니다.");
  }
}

async function findMasterOrganizationId() {
  const rows = await query("SELECT organization_id FROM company_organization WHERE group_code='ZZZ' AND company IS NULL AND site IS NULL AND department IS NULL AND job IS NULL AND is_active=1 ORDER BY organization_id LIMIT 1");
  if (!rows.length) throw new Error("MASTER 조직 ZZZ/NULL/NULL/NULL/NULL이 없습니다.");
  return rows[0].organization_id;
}

async function ensureExistingMasterAccounts() {
  const masters = await query("SELECT user_id FROM user_profile WHERE role='MASTER'");
  if (!masters.length) return;
  const organizationId = await findMasterOrganizationId();
  await query("UPDATE user_profile SET permission_level=25,organization_id=?,updated_at=updated_at WHERE role='MASTER' AND (permission_level<>25 OR organization_id IS NULL OR organization_id<>?)", [organizationId, organizationId]);
}

// 예약 실행 엔진: 실제 전달은 기존 queueDeviceCommand/OStr(출력 문자열) 체계를 재사용합니다.
let scheduleTickBusy = false;
async function runDueSchedules() {
  if (scheduleTickBusy) return;
  scheduleTickBusy = true;
  try {
    const now = toKoreaDateTime(new Date());
    const due = await query("SELECT * FROM device_schedule WHERE is_enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? AND (end_time IS NULL OR end_time>=?) AND last_execution_status NOT IN ('RUNNING') ORDER BY next_run_at,schedule_id LIMIT 50", [now, now]);
    for (const row of due) {
      const claim = await query("UPDATE device_schedule SET last_execution_status='RUNNING',last_execution_message='예약 실행 처리 중' WHERE schedule_id=? AND is_enabled=1 AND next_run_at=? AND last_execution_status<>'RUNNING'", [row.schedule_id, row.next_run_at]);
      if (!claim.affectedRows) continue;
      try {
        const requester = await resolveScheduleSource(`SCHEDULE:${row.schedule_id}`);
        await queueDeviceCommand(row.device_id, row.output_signal, row.action_state, requester, String(row.ostr_payload ?? row.istr_payload ?? ""), null, row.schedule_id);
        const runAt = toKoreaDateTime(new Date());
        if (["ONCE", "IMMEDIATE"].includes(row.repeat_type)) {
          await query("UPDATE device_schedule SET is_enabled=0,next_run_at=NULL,last_run_at=?,completed_at=?,last_execution_status='QUEUED',last_execution_message='명령이 기존 명령 큐에 등록되었습니다.' WHERE schedule_id=?", [runAt, runAt, row.schedule_id]);
        } else {
          const next = scheduleNextRun(row, new Date());
          if (next) {
            await query("UPDATE device_schedule SET next_run_at=?,last_run_at=?,is_enabled=1,completed_at=NULL,last_execution_status='WAITING',last_execution_message='명령이 기존 명령 큐에 등록되었습니다.' WHERE schedule_id=? AND is_enabled=1", [next, runAt, row.schedule_id]);
          } else {
            await query("UPDATE device_schedule SET is_enabled=0,next_run_at=NULL,last_run_at=?,completed_at=?,last_execution_status='QUEUED',last_execution_message='반복 기간이 종료되었습니다.' WHERE schedule_id=? AND is_enabled=1", [runAt, runAt, row.schedule_id]);
          }
        }
        broadcastDeviceBrowsers({ type: "scheduleChanged", deviceId: row.device_id, OutputSignal: row.output_signal, scheduleId: String(row.schedule_id) });
      } catch (err) {
        const retry = ["ONCE", "IMMEDIATE"].includes(row.repeat_type) ? null : scheduleNextRun(row, new Date(Date.now() + 60000));
        if (retry) {
          await query("UPDATE device_schedule SET next_run_at=?,last_run_at=?,last_execution_status='FAILED',last_execution_message=? WHERE schedule_id=? AND is_enabled=1", [retry, toKoreaDateTime(new Date()), String(err.message || err).slice(0, 2000), row.schedule_id]);
        } else {
          const failedAt = toKoreaDateTime(new Date());
          await query("UPDATE device_schedule SET is_enabled=0,next_run_at=NULL,last_run_at=?,completed_at=?,last_execution_status='FAILED',last_execution_message=? WHERE schedule_id=?", [failedAt, failedAt, String(err.message || err).slice(0, 2000), row.schedule_id]);
        }
      }
    }
    await query(`UPDATE device_schedule SET is_enabled=0,next_run_at=NULL,completed_at=COALESCE(completed_at,?),last_execution_status='EXPIRED',last_execution_message='예약 종료 시각이 지났습니다.'
      WHERE ((end_time IS NOT NULL AND end_time<?) OR (repeat_type IN ('ONCE','IMMEDIATE') AND schedule_time<? AND completed_at IS NULL))
        AND last_execution_status<>'RUNNING'`, [now, now, now]);
  } catch (err) { console.error("예약 스케줄러 오류:", err); }
  finally { scheduleTickBusy = false; }
}

async function start() {
  try {
    await verifySchemaNames();
    await ensureSchema();
    await query("SELECT 1");
    console.log(`${DB_CLIENT} connection OK (database: ${dbConfig.database})`);
  } catch (err) {
    console.error(`DB 초기화 실패 (database: ${dbConfig.database}):`, err.message);
    process.exitCode = 1;
    return;
  }
  server.listen(PORT, "0.0.0.0", () => console.log(`Factory Monitor Server started on port ${PORT}`));
  setInterval(runDueSchedules, 5000);
  runDueSchedules().catch(err => console.error("예약 초기 실행 오류:", err));
}
start();
process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
