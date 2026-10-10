// 서버 진입점: 환경 설정 -> 인증/권한 -> 업무 API -> 장치 통신 -> DB 초기화 순서로 구성합니다.
require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mariadb = require("mariadb");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const path = require("path");

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

// 기본 장치의 인증 설정과 다중 장치 소켓을 준비합니다. 각 장치의 상태는 8채널로 관리합니다.
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
  const region = String(body.region || "").trim();
  const company = String(body.company || "").trim();
  const position = String(body.position || "").trim();
  const phoneInput = String(body.phone || "").trim();
  const emailInput = String(body.email || "").trim();
  const phone = phoneInput ? normalizePhone(phoneInput) : "";
  const email = emailInput ? normalizeEmail(emailInput) : null;
  const password = String(body.password || "");

  if (!/^[A-Za-z0-9_]{4,50}$/.test(username)) return { error: "아이디는 영문, 숫자, _만 사용하여 4~50자로 입력하세요." };
  if (name.length > 100) return { error: "이름은 100자 이내로 입력하세요." };
  if (region.length > 100) return { error: "지역은 100자 이내로 입력하세요." };
  if (company.length > 150) return { error: "회사는 150자 이내로 입력하세요." };
  if (position.length > 100) return { error: "직위는 100자 이내로 입력하세요." };
  if (phoneInput && !phone) return { error: "전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678" };
  if (emailInput && !email) return { error: "이메일 주소 형식이 올바르지 않습니다. 예: user@example.com" };
  if (passwordRequired && (password.length < 4 || password.length > 100)) return { error: "비밀번호는 4~100자로 입력하세요." };
  if (!passwordRequired && password && (password.length < 4 || password.length > 100)) return { error: "새 비밀번호는 4~100자로 입력하세요." };

  return { name, username, region, company, position, phone, email, password };
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
      role: user.role, permissionLevel: Number(user.permission_level || (user.role === "MASTER" ? 10 : 1)), status: user.status
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
  return Number(user?.permissionLevel || (user?.role === "MASTER" ? 10 : 1));
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
  if (req.user.status !== "APPROVED" && getPermissionLevel(req.user) < 8) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "관리자 승인 완료 후 이용할 수 있습니다.", code: "APPROVAL_REQUIRED" });
    return res.redirect("/user-profile.html?pending=1");
  }
  next();
}

// 최신 DB 상태를 확인합니다. 삭제 계정은 로그아웃하고 정지 계정은 세션을 유지한 채 회원정보로 제한합니다.
async function requireActiveAccount(req, res, next) {
  try {
    const rows = await query("SELECT user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) {
      if (req.sessionToken) sessions.delete(req.sessionToken);
      clearSessionCookie(res);
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "회원 정보를 찾을 수 없습니다.", code: "ACCOUNT_NOT_FOUND" });
      return res.redirect("/user-login.html");
    }
    req.user.status = rows[0].status;
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
    if (!req.user || getPermissionLevel(req.user) < minimumLevel) {
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: `${minimumLevel}등급 이상 관리자 권한이 필요합니다.`, code: "ADMIN_REQUIRED" });
      return res.redirect("/user-profile.html?access=denied");
    }
    next();
  };
}

function requireMaster(req, res, next) {
  if (!req.user || getPermissionLevel(req.user) < 8) return res.status(403).json({ error: "8등급 이상 관리자 권한이 필요합니다.", code: "ADMIN_REQUIRED" });
  next();
}

// ---------------------------------------------------------
// 페이지
// ---------------------------------------------------------
app.get("/", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "product-view.html")));
app.get("/product-view.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "product-view.html")));
app.get("/index.html", (req, res) => res.redirect(302, `/product-view.html${req.url.slice(req.path.length)}`));
app.get("/control.html", (req, res) => res.redirect(302, `/product-control.html${req.url.slice(req.path.length)}`));
app.get("/product-control.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), (req, res) => res.sendFile(path.join(__dirname, "public", "product-control.html")));
app.get("/product-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), (req, res) => res.sendFile(path.join(__dirname, "public", "product-admin.html")));
app.get("/user-admin.html", requireLogin, requireActiveAccount, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "user-admin.html")));
app.get("/user-profile.html", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "user-profile.html")));
app.get("/user-setting.html", requireLogin, requireActiveAccount, (req, res) => res.sendFile(path.join(__dirname, "public", "user-setting.html")));
app.get("/device-control.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), (req, res) => res.sendFile(path.join(__dirname, "public", "device-control.html")));
app.get("/device-view.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "device-view.html")));
app.get("/device-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "device-admin.html")));
app.get("/device_schedule.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), (req, res) => res.sendFile(path.join(__dirname, "public", "device_schedule.html")));
app.get("/login.html", (req, res) => res.redirect(302, `/user-login.html${req.url.slice(req.path.length)}`));
app.get("/register.html", (req, res) => res.redirect(302, `/user-register.html${req.url.slice(req.path.length)}`));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "user-login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "user-register.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------------------------------------------------------
// 회원가입: 신청 상태 PENDING
// ---------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const data = validateProfile(req.body, { passwordRequired: true });
  if (data.error) return res.status(400).json({ error: data.error });
  if (typeof req.body.passwordConfirm !== "string" || !req.body.passwordConfirm) return res.status(400).json({ error: "비밀번호 확인 값이 전달되지 않았습니다. 페이지를 새로고침한 후 다시 입력해주세요." });
  if (data.password !== req.body.passwordConfirm) return res.status(400).json({ error: "비밀번호가 서로 다릅니다." });

  try {
    const exists = await query("SELECT user_id AS id, username, email FROM user_profile WHERE username = ? OR email = ? LIMIT 1", [data.username, data.email]);
    if (exists.length) {
      if (exists[0].username === data.username) return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
      return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다." });
    }
    const result = await query(`INSERT INTO user_profile (username,password_hash,user_name,region,company,position,phone,email,user_status,role,permission_level,user_request_at) VALUES (?,?,?,?,?,?,?,?, 'PENDING','USER',1,NOW())`, [data.username, hashPassword(data.password), data.name, data.region, data.company, data.position, data.phone, data.email]);
    //  res.status(201).json({ ok: true, message: "가입 신청이 접수되었습니다. 마스터 승인 후 생산 현황을 이용할 수 있습니다.", userId: result.insertId });
    res.status(201).json({ ok: true, message: "가입 신청이 접수되었습니다. 마스터 승인 후 생산 현황을 이용할 수 있습니다." });
  } catch (err) {
    console.error("회원가입 오류:", { code: err.code, errno: err.errno, sqlState: err.sqlState, message: err.message });
    if (err.code === "ER_DUP_ENTRY" || err.code === "ER_DUP_ENTRY_WITH_TRUNCATED_WRITES") return res.status(409).json({ error: "아이디 또는 이메일이 이미 등록되어 있습니다." });
    if (err.code === "ER_BAD_FIELD_ERROR" || /unknown column.*permission_level/i.test(String(err.message))) return res.status(500).json({ error: "데이터베이스 구조가 현재 버전과 다릅니다. 새 DB에 schema.sql을 적용하고 DB_NAME을 확인하세요." });
    if (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_TABLE_ERROR") return res.status(500).json({ error: "회원 테이블이 없습니다. schema.sql을 실행한 뒤 다시 시도하세요." });
    if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_ROW_IS_REFERENCED_2") return res.status(500).json({ error: "회원 테이블 제약조건이 올바르지 않습니다. 데이터베이스 스키마를 확인하세요." });
    res.status(500).json({ error: "회원가입 처리 중 오류가 발생했습니다." });
  }
});

// ---------------------------------------------------------
// 로그인: PENDING도 프로필 수정 목적의 제한 로그인 허용
// ---------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "아이디와 비밀번호를 입력하세요." });

  try {
    const rows = await query(`SELECT user_id AS id,username,password_hash,user_name AS name,region,company,position,phone,email,role,permission_level,user_status AS status FROM user_profile WHERE username = ? LIMIT 1`, [username]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });

    const token = createSession(rows[0]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, permissionLevel: Number(rows[0].permission_level || (rows[0].role === "MASTER" ? 10 : 1)), status: rows[0].status }, redirect: ["PENDING", "REJECTED", "WITHDRAWAL_PENDING", "SUSPENDED"].includes(rows[0].status) ? "/user-profile.html?pending=1" : "/" });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const rows = await query(`SELECT user_id AS id,username,user_name AS name,region,company,position,phone,email,role,permission_level,user_status AS status,approved_at,created_at,updated_at FROM user_profile WHERE user_id=?`, [req.user.id]);
    if (!rows.length) { clearSessionCookie(res); return res.status(401).json({ error: "회원 정보를 찾을 수 없습니다." }); }
    const u = rows[0];
    req.user.status = u.status;
    req.user.role = u.role;
    req.user.permissionLevel = Number(u.permission_level || (u.role === "MASTER" ? 10 : 1));
    res.json({ loggedIn: true, user: u });
  } catch (err) { res.status(500).json({ error: "회원정보 조회 오류" }); }
});

// 회원 본인 정보 수정. 승인 전/후 모두 가능.
app.put("/api/me", requireLogin, async (req, res) => {
  const data = validateProfile({ ...req.body, username: req.user.username }, { passwordRequired: false });
  if (data.error) return res.status(400).json({ error: data.error });
  const currentPassword = String(req.body.currentPassword || "");
  const passwordConfirm = String(req.body.passwordConfirm || "");
  if (data.password && !currentPassword) return res.status(400).json({ error: "새 비밀번호로 변경하려면 기존 비밀번호를 입력하세요." });
  if (data.password && data.password !== passwordConfirm) return res.status(400).json({ error: "새 비밀번호가 서로 일치하지 않습니다." });
  try {
    const exists = await query("SELECT user_id AS id FROM user_profile WHERE email = ? AND user_id <> ? LIMIT 1", [data.email, req.user.id]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다." });
    if (data.password) {
      const rows = await query("SELECT password_hash FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
      if (!rows.length || !verifyPassword(currentPassword, rows[0].password_hash)) return res.status(400).json({ error: "기존 비밀번호가 올바르지 않습니다." });
      await query(`UPDATE user_profile SET user_name=?,region=?,company=?,position=?,phone=?,email=?,password_hash=?,user_request_at=NOW() WHERE user_id=?`, [data.name, data.region, data.company, data.position, data.phone, data.email, hashPassword(data.password), req.user.id]);
    } else {
      await query(`UPDATE user_profile SET user_name=?,region=?,company=?,position=?,phone=?,email=?,user_request_at=NOW() WHERE user_id=?`, [data.name, data.region, data.company, data.position, data.phone, data.email, req.user.id]);
    }
    const rows = await query(`SELECT user_id AS id,username,user_name AS name,region,company,position,phone,email,role,permission_level,user_status AS status,approved_at,created_at,updated_at FROM user_profile WHERE user_id=?`, [req.user.id]);
    req.user.name = rows[0].name;
    res.json({ ok: true, user: rows[0], message: "회원정보가 수정되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원정보 수정 오류" }); }
});

app.post("/api/logout", (req, res) => { const token = getCookie(req, SESSION_COOKIE); if (token) sessions.delete(token); clearSessionCookie(res); res.json({ ok: true }); });

app.post("/api/me/reapply", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (rows[0].status !== "REJECTED") return res.status(400).json({ error: "반려된 회원만 재신청할 수 있습니다." });
    await query("UPDATE user_profile SET user_status='PENDING',approved_at=NULL,approved_by=NULL,user_request_at=NOW() WHERE user_id=?", [req.user.id]);
    req.user.status = "PENDING";
    res.json({ ok: true, message: "가입 재신청이 접수되었습니다." });
  } catch (err) { console.error("재신청 오류:", err); res.status(500).json({ error: "가입 재신청 처리 중 오류가 발생했습니다." }); }
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

// ---------------------------------------------------------
// 마스터 관리
// ---------------------------------------------------------
app.get("/api/admin/users", requireLogin, requireMaster, async (req, res) => {
  try {
    const rows = await query(`SELECT user_id AS id,username,user_name AS name,region,company,position,phone,email,role,permission_level,admin_memo,user_status AS status,approved_at,created_at,updated_at,user_request_at FROM user_profile ORDER BY CASE user_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 WHEN 'WITHDRAWAL_PENDING' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END, created_at DESC`);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 목록 조회 오류" }); }
});

app.put("/api/admin/users/:id/status", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "").toUpperCase();
  if (!Number.isInteger(id) || !["PENDING", "APPROVED", "REJECTED", "SUSPENDED"].includes(status)) return res.status(400).json({ error: "잘못된 요청입니다." });
  if (getPermissionLevel(req.user) < 8) return res.status(403).json({ error: "8등급 이상 관리자만 회원을 승인할 수 있습니다." });
  if (id === req.user.id) return res.status(400).json({ error: "현재 로그인한 관리자 계정은 이 화면에서 변경할 수 없습니다." });
  try {
    const exists = await query("SELECT user_id AS id,role,permission_level,user_status AS status FROM user_profile WHERE user_id=?", [id]);
    if (!exists.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    if (exists[0].permission_level >= getPermissionLevel(req.user) && id !== req.user.id) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 관리할 수 있습니다." });
    if (status === "APPROVED" && exists[0].status === "PENDING") await query("UPDATE user_profile SET user_status='APPROVED',permission_level=1,role='USER',approved_at=NOW(),approved_by=? WHERE user_id=?", [req.user.id, id]);
    else if (status === "APPROVED") await query("UPDATE user_profile SET user_status='APPROVED',approved_at=NOW(),approved_by=? WHERE user_id=?", [req.user.id, id]);
    else await query("UPDATE user_profile SET user_status=?,approved_at=NULL,approved_by=NULL WHERE user_id=?", [status, id]);
    if (status === "SUSPENDED") forceSuspendUser(id);
    res.json({ ok: true, message: status === "APPROVED" ? "승인되었습니다." : "상태가 변경되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 상태 변경 오류" }); }
});

app.put("/api/admin/users/:id", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  const data = validateProfile({ ...req.body, username: String(req.body.username || "") }, { passwordRequired: false });
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const duplicate = await query("SELECT user_id AS id FROM user_profile WHERE (username=? OR email=?) AND user_id<>? LIMIT 1", [data.username, data.email, id]);
    if (duplicate.length) return res.status(409).json({ error: "아이디 또는 이메일이 다른 회원과 중복됩니다." });
    const requestedLevel = Number(req.body.permissionLevel);
    if (!Number.isInteger(requestedLevel) || requestedLevel < 1 || requestedLevel > 10) return res.status(400).json({ error: "권한 등급은 1~10 사이로 입력하세요." });
    const adminMemo = String(req.body.adminMemo || "").trim();
    if (adminMemo.length > 5000) return res.status(400).json({ error: "관리자 메모는 5000자 이내로 입력하세요." });
    const target = await query("SELECT role,permission_level FROM user_profile WHERE user_id=?", [id]);
    if (!target.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    const adminLevel = getPermissionLevel(req.user), targetLevel = Number(target[0].permission_level);
    if (id === req.user.id && requestedLevel !== targetLevel) return res.status(403).json({ error: "자신의 권한 등급은 변경할 수 없습니다." });
    if (id !== req.user.id && targetLevel >= adminLevel) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 수정할 수 있습니다." });
    if (id !== req.user.id && requestedLevel > adminLevel) return res.status(403).json({ error: "자신의 등급보다 높은 등급은 부여할 수 없습니다." });
    if (data.password) await query(`UPDATE user_profile SET username=?,user_name=?,region=?,company=?,position=?,phone=?,email=?,password_hash=?,permission_level=?,admin_memo=? WHERE user_id=?`, [data.username, data.name, data.region, data.company, data.position, data.phone, data.email, hashPassword(data.password), requestedLevel, adminMemo, id]);
    else await query(`UPDATE user_profile SET username=?,user_name=?,region=?,company=?,position=?,phone=?,email=?,permission_level=?,admin_memo=? WHERE user_id=?`, [data.username, data.name, data.region, data.company, data.position, data.phone, data.email, requestedLevel, adminMemo, id]);
    res.json({ ok: true, message: "회원정보가 수정되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "관리자 회원정보 수정 오류" }); }
});

app.delete("/api/admin/users/:id", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  if (id === req.user.id) return res.status(403).json({ error: "현재 로그인한 관리자 계정은 삭제할 수 없습니다." });
  try {
    const rows = await query("SELECT user_id AS id,permission_level,user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [id]);
    if (!rows.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    if (Number(rows[0].permission_level || 1) >= getPermissionLevel(req.user)) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 삭제할 수 있습니다." });
    await query("DELETE FROM user_profile WHERE user_id=?", [id]);
    forceLogoutUser(id);
    res.json({ ok: true, message: "회원이 삭제되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 삭제 오류" }); }
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
const PRODUCT_FIELDS = "p.product_id AS id,p.product_code,p.product_name,p.quantity,p.target_quantity,p.product_status AS status,p.updated_at,p.updated_by,u.username AS updated_by_name";
const PRODUCT_JOIN = "FROM product p LEFT JOIN user_profile u ON u.user_id = p.updated_by";

app.get("/api/products", requireLogin, requireActiveAccount, requireApproved, async (req, res) => { try { res.json(await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_active=1 ORDER BY p.product_id`)); } catch (err) { console.error(err); res.status(500).json({ error: "DB 조회 오류" }); } });

app.put("/api/products/:id/quantity", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), quantity = Number(req.body.quantity);
  if (!Number.isInteger(id) || !Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ error: "수량이 올바르지 않습니다." });
  try { const result = await query(`UPDATE product SET quantity=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND is_active=1`, [quantity, req.user.id, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]); broadcast({ type: "quantityUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "DB 업데이트 오류" }); }
});

app.put("/api/products/:id/status", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), status = String(req.body.status || "").trim();
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return res.status(400).json({ error: "상태값이 올바르지 않습니다." });
  try { const result = await query(`UPDATE product SET product_status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND is_active=1`, [status, req.user.id, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]); broadcast({ type: "productUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "상태 업데이트 오류" }); }
});

function validateProduct(body) {
  const productCode = String(body.productCode || "").trim();
  const productName = String(body.productName || "").trim();
  const quantity = Number(body.quantity);
  const targetQuantity = Number(body.targetQuantity);
  const status = String(body.status || "대기").trim();
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(productCode)) return { error: "제품코드는 영문, 숫자, _, -만 사용하여 1~50자로 입력하세요." };
  if (productName.length < 1 || productName.length > 100) return { error: "제품명은 1~100자로 입력하세요." };
  if (!Number.isInteger(quantity) || quantity < 0) return { error: "현재수량은 0 이상의 정수로 입력하세요." };
  if (!Number.isInteger(targetQuantity) || targetQuantity < 0) return { error: "목표수량은 0 이상의 정수로 입력하세요." };
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return { error: "상태값이 올바르지 않습니다." };
  return { productCode, productName, quantity, targetQuantity, status };
}

app.post("/api/admin/products", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const data = validateProduct(req.body);
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const exists = await query("SELECT product_id AS id FROM product WHERE product_code=? LIMIT 1", [data.productCode]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("INSERT INTO product (product_code,product_name,quantity,target_quantity,product_status,updated_by) VALUES (?,?,?,?,?,?)", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status, req.user.id]);
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [result.insertId]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_active=1 ORDER BY p.product_id`) });
    res.status(201).json(rows[0]);
  } catch (err) { console.error("제품 추가 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 추가 오류" }); }
});

app.put("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  const data = validateProduct(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const duplicate = await query("SELECT product_id AS id FROM product WHERE product_code=? AND product_id<>? LIMIT 1", [data.productCode, id]);
    if (duplicate.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("UPDATE product SET product_code=?,product_name=?,quantity=?,target_quantity=?,product_status=?,updated_by=? WHERE product_id=?", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status, req.user.id, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.product_id=?`, [id]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_active=1 ORDER BY p.product_id`) });
    res.json(rows[0]);
  } catch (err) { console.error("제품 수정 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 수정 오류" }); }
});

app.delete("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  try {
    const result = await query("DELETE FROM product WHERE product_id=?", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    broadcast({ type: "productsChanged", products: await query("SELECT product_id AS id,product_code,product_name,quantity,target_quantity,product_status AS status,updated_at FROM product WHERE is_active=1 ORDER BY product_id") });
    res.json({ ok: true, message: "제품이 삭제되었습니다." });
  } catch (err) { console.error("제품 삭제 오류:", err); res.status(500).json({ error: "제품 삭제 오류" }); }
});

// ---------------------------------------------------------
// Device D1 R1 통합 기능
// ---------------------------------------------------------
const DEVICE_CHANNEL_COUNT = 8;
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

  // V0의 D8/D9/D10/D11 명령도 새 OS1~OS8 구조와 충돌하지 않도록 호환합니다.
  const legacyMap = { D8: "OS1", D9: "OS2", D10: "OS3", D11: "OS4" };
  return legacyMap[pin] || "";
}
function channelNumberFromPin(pin) {
  const match = /^OS([1-8])$/.exec(String(pin || "").toUpperCase());
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
// 새 DB에는 현재 컬럼과 외래키를 처음부터 생성합니다. 기존 버전의 이름·컬럼은 이전하지 않습니다.
async function ensureDeviceSchema() {
  await query(`CREATE TABLE IF NOT EXISTS device (
    device_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    device_name VARCHAR(100) NOT NULL DEFAULT '',
    token_hash CHAR(64) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    last_ip VARCHAR(45) NULL,
    last_seen_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (device_row_id), UNIQUE KEY uq_device_device_id (device_id)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS device_channel (
    channel_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    channel_name VARCHAR(100) NOT NULL,
    input_signal VARCHAR(20) NOT NULL,
    output_signal VARCHAR(20) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
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
    CONSTRAINT fk_device_channel_device FOREIGN KEY (device_id) REFERENCES device(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS device_schedule (
    schedule_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL,
    schedule_name VARCHAR(150) NOT NULL DEFAULT '',
    action_state ENUM('ON','OFF') NOT NULL,
    ostr_payload TEXT NULL,
    repeat_type ENUM('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL DEFAULT 'ONCE',
    schedule_time DATETIME(3) NULL,
    hour_value TINYINT UNSIGNED NULL,
    minute_value TINYINT UNSIGNED NOT NULL DEFAULT 0,
    weekday_mask TINYINT UNSIGNED NULL,
    day_of_month TINYINT UNSIGNED NULL,
    month_value TINYINT UNSIGNED NULL,
    day_value TINYINT UNSIGNED NULL,
    is_month_end TINYINT(1) NOT NULL DEFAULT 0,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    next_run_at DATETIME(3) NULL,
    last_run_at DATETIME(3) NULL,
    last_execution_status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
    last_execution_message TEXT NULL,
    created_by INT NULL,
    updated_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    completed_at DATETIME(3) NULL,
    PRIMARY KEY (schedule_id),
    KEY idx_schedule_due (is_enabled,next_run_at),
    KEY idx_schedule_channel (device_id,output_signal),
    KEY idx_schedule_owner (created_by),
    CONSTRAINT fk_schedule_device FOREIGN KEY (device_id) REFERENCES device(device_id) ON DELETE CASCADE,
    CONSTRAINT fk_schedule_creator FOREIGN KEY (created_by) REFERENCES user_profile(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_schedule_updater FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await migrateScheduleOutputString();

  await query(`CREATE TABLE IF NOT EXISTS device_command (
    command_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    command_id CHAR(36) NOT NULL,
    device_id VARCHAR(100) NOT NULL,
    output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
    requested_output_state ENUM('ON','OFF') NOT NULL,
    output_message TEXT NULL,
    istr_payload TEXT NULL,
    requested_by VARCHAR(100) NOT NULL DEFAULT 'CLIENT',
    command_status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    status_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (command_row_id), UNIQUE KEY uq_device_command_id (command_id),
    KEY idx_device_poll (device_id,command_status,command_row_id),
    CONSTRAINT fk_device_command_device FOREIGN KEY (device_id) REFERENCES device(device_id) ON DELETE CASCADE
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
    command_id CHAR(36) NULL,
    signal_message TEXT NULL,
    changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (history_id), KEY idx_device_history (device_id,changed_at),
    CONSTRAINT fk_device_history_device FOREIGN KEY (device_id) REFERENCES device(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await query(`INSERT INTO device(device_id,device_name,token_hash,last_change_source)
    VALUES(?,?,?,'BOOT')
    ON DUPLICATE KEY UPDATE
      device_name=IF(device_name='',VALUES(device_name),device_name),
      token_hash=COALESCE(token_hash,VALUES(token_hash))`,
    [DEVICE_ID, DEVICE_ID, DEVICE_TOKEN ? crypto.createHash("sha256").update(DEVICE_TOKEN).digest("hex") : null]);

  await query(`UPDATE device SET sort_order=device_row_id WHERE sort_order=0`);

  // 재시작해도 기존 채널 설정은 유지하고, 등록된 모든 장치에 없는 채널만 추가합니다.
  const devices = await query(`SELECT device_id FROM device`);
  for (const device of devices) {
    for (const channel of DEVICE_CHANNELS) {
      await query(`INSERT IGNORE INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order)
        VALUES(?,?,?,?,?)`,
        [device.device_id, `채널 ${String(channel.index).padStart(2, "0")}`, channel.inputPin, channel.outputPin, channel.index - 1]);
    }
  }

}

async function resolveScheduleSource(source) {
  const match = /^SCHEDULE:(\d+)$/.exec(String(source || ""));
  if (!match) return source;
  const owners = await query("SELECT u.username FROM device_schedule s JOIN user_profile u ON u.user_id=s.created_by WHERE s.schedule_id=? LIMIT 1", [match[1]]);
  return owners[0]?.username ? `${source}:${owners[0].username}` : source;
}

async function getDeviceState(deviceId = null) {
  const devices = deviceId
    ? await query(`SELECT device_id,device_name,is_active,last_change_source,last_ip,last_seen_at,updated_at FROM device WHERE device_id=?`, [deviceId])
    : await query(`SELECT device_id,device_name,is_active,last_change_source,last_ip,last_seen_at,updated_at FROM device ORDER BY sort_order,device_row_id`);
  if (!devices.length) return null;

  const device = devices[0];
  const sets = await query(
    `SELECT channel_id AS id,channel_name,input_signal,output_signal,is_active,output_state,input_state,last_change_source,input_message,output_message,sort_order,
      COALESCE((SELECT h.changed_at FROM device_state_history h
      WHERE h.device_id=device_channel.device_id AND h.output_signal=device_channel.output_signal
          ORDER BY h.history_id DESC LIMIT 1), device_channel.created_at) AS last_changed_at
     FROM device_channel WHERE device_id=? ORDER BY sort_order,channel_id`,
    [device.device_id]
  );

  return {
    ...device,
    channels: await Promise.all(sets.map(async set => ({ ...set, last_change_source: await resolveScheduleSource(set.last_change_source) }))),
    // V0 UI 호환용 첫 번째 OS 상태
    output_state: sets.find(set => set.output_signal === "OS1")?.output_state || "OFF"
  };
}

async function getDeviceHistory(limit = 50, deviceId = null) {
  const n = Math.min(Math.max(Number(limit || 50), 1), 50);
  const fields = "history_id AS id,device_id,output_signal,previous_output_state,output_state,change_source,command_id,signal_message,changed_at";
  if (deviceId) return await query(
    `SELECT ${fields}
     FROM device_state_history WHERE device_id=? ORDER BY history_id DESC LIMIT ${n}`, [deviceId]);
  return await query(
    `SELECT ${fields}
     FROM device_state_history ORDER BY history_id DESC LIMIT ${n}`);
}

async function getDeviceCommands(limit = 50, deviceId = null) {
  const n = Math.min(Math.max(Number(limit || 50), 1), 50);
  const fields = `command_row_id AS id,command_id,device_id,output_signal,requested_output_state,output_message,requested_by,command_status,status_changed_at`;
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
async function recordDeviceState(deviceId, pin, newState, source, commandId = null, recordDeviceCommand = false, message = {}) {
  pin = normalizeDevicePin(pin);
  if (!pin) return;
  const inputPin = `IS${channelNumberFromPin(pin)}`;
  const state = parseDeviceState(newState);
  if (!state) return;

  const reportedInputString = message.IStr ?? message.sendString;
  const reportedOutputString = message.OStr ?? message.receiveString;
  const reportedInputState = parseDeviceState(message.inputState);
  const deviceOrigin = recordDeviceCommand || source === deviceId || source === "DEVICE";
  const connection = await pool.getConnection();

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
    const scheduleCompleted = Boolean(commandId) && /^SCHEDULE:\d+(?::.+)?$/.test(source) && !recordDeviceCommand;
    const changed = previousState !== state || (scheduleCompleted && (rows[0]?.last_change_source !== source || rows[0]?.output_message !== outputString));
    const effectiveSource = changed ? source : (rows[0]?.last_change_source || source);

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
      `UPDATE device SET last_change_source=?,last_seen_at=?,updated_at=? WHERE device_id=?`,
      [effectiveSource, databaseTime, databaseTime, deviceId]);

    if (typeof message.ip === "string" && message.ip.length <= 45) {
      await connectionQuery(connection, `UPDATE device SET last_ip=? WHERE device_id=?`, [message.ip, deviceId]);
    }

    if (changed) {
      await connectionQuery(connection,
        `INSERT INTO device_state_history(device_id,output_signal,previous_output_state,output_state,change_source,command_id,signal_message,changed_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [deviceId, pin, previousState, state, effectiveSource, effectiveCommandId, historyString, databaseTime]);

      if (recordDeviceCommand) {
        await connectionQuery(connection,
          `INSERT INTO device_command(command_id,device_id,output_signal,requested_output_state,output_message,requested_by,command_status,status_changed_at)
           VALUES(?,?,?,?,?,?, 'ACKED',?)`,
          [effectiveCommandId, deviceId, pin, state, outputString, deviceId, databaseTime]);
      }
    }

    // DB 저장이 성공한 상태만 브라우저에 전달하여 화면과 저장 데이터의 기준을 맞춥니다.
    await connection.commit();
    connection.release();

    if (changed) {
      await trimDeviceTable("device_state_history", 1000, deviceId);
      if (recordDeviceCommand) await trimDeviceTable("device_command", 1000, deviceId);
    }

    const event = {
      type: changed ? "stateChanged" : "state",
      deviceId,
      OutputSignal: pin,
      state,
      OutputState: state,
      source: effectiveSource,
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
async function queueDeviceCommand(deviceId, pin, desiredState, requester, outputString = null, inputString = null) {
  deviceId = String(deviceId || "").trim();
  pin = normalizeDevicePin(pin);
  const state = parseDeviceState(desiredState);

  if (!deviceId || !DEVICE_OUTPUT_PINS.has(pin) || !state) {
    throw new Error("잘못된 장치, 출력 채널 또는 출력 상태입니다.");
  }

  const deviceRows = await query(`SELECT device_id,is_active FROM device WHERE device_id=? LIMIT 1`, [deviceId]);
  if (!deviceRows.length || Number(deviceRows[0].is_active) !== 1) {
    throw new Error("사용할 수 없는 Device 장치입니다.");
  }

  if (outputString === null || outputString === undefined) {
    const channelRows = await query(`SELECT output_message FROM device_channel WHERE device_id=? AND output_signal=? LIMIT 1`, [deviceId, pin]);
    outputString = String(channelRows[0]?.output_message ?? "").slice(0, 10000);
  } else {
    outputString = String(outputString).slice(0, 10000);
  }

  const commandId = crypto.randomUUID(), createdAt = new Date(), databaseTime = toKoreaDateTime(createdAt);
  const connection = await pool.getConnection();
  const cancelledCommands = [];

  try {
    await connection.beginTransaction();
    const offlineAtQueueTime = !isDeviceConnected(deviceId);

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
       (command_id,device_id,output_signal,requested_output_state,output_message,istr_payload,requested_by,command_status,status_changed_at)
       VALUES(?,?,?,?,?,?,?,'PENDING',?)`,
      [commandId, deviceId, pin, state, outputString, inputString === null || inputString === undefined ? null : String(inputString).slice(0, 10000), requester, databaseTime]);

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
    requester, status: "PENDING", createdAt: createdAt.toISOString()
  });

  await deliverDeviceCommand(deviceId, commandId, pin, state, requester, outputString, inputString);
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
           output_signal=VALUES(output_signal),
           sort_order=VALUES(sort_order)`,
        [deviceId, `채널 ${String(index + 1).padStart(2, "0")}`, inputPin, outputPin, index]
      );
    }

    const now = toKoreaDateTime(new Date());
    await query(`UPDATE device SET last_seen_at=?,updated_at=? WHERE device_id=?`, [now, now, deviceId]);

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
    await query(`UPDATE device SET last_seen_at=? WHERE device_id=?`, [now, deviceId]);
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
      `SELECT command_id,output_signal,requested_output_state,output_message,requested_by,command_status
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
      const source = await resolveScheduleSource(String(rows[0].requested_by).slice(0, 100));
      await recordDeviceState(
        deviceId, pin, state, source,
        commandId, false, { OStr: outputString }
      );
    }

    const now = new Date();
    await query(
      `UPDATE device_command SET command_status=?,output_message=?,status_changed_at=?
       WHERE command_id=? AND device_id=?`,
      [status, outputString, toKoreaDateTime(now), commandId, deviceId]
    );
    const scheduleMatch = /^SCHEDULE:(\d+)(?::.+)?$/.exec(String(rows[0].requested_by || ""));
    if (scheduleMatch) {
      await query(`UPDATE device_schedule SET last_execution_status=?,last_execution_message=?,last_run_at=?,completed_at=CASE WHEN repeat_type='ONCE' AND ?='ACKED' THEN ? ELSE completed_at END WHERE schedule_id=?`,
        [status, status === "ACKED" ? "디바이스 ACK 확인" : "디바이스 명령 실패 또는 ACK 불일치", toKoreaDateTime(now), status, toKoreaDateTime(now), scheduleMatch[1]]);
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
    const deviceAuthorization = query(`SELECT device_id,is_active,token_hash FROM device WHERE device_id=? LIMIT 1`, [deviceId]).then(deviceRows => {
      if (!deviceRows.length || Number(deviceRows[0].is_active) !== 1) { ws.close(1008, "Unknown or inactive device"); return false; }
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
      if (message.type === "lamp") {
        if (getPermissionLevel(ws.factoryUser) < 4) { sendDevice(ws, { type: "lampAck", ok: false, message: "출력 제어는 4등급 이상 회원만 사용할 수 있습니다." }); return; }
        const pin = normalizeDevicePin(message.OutputSignal ?? message.pin ?? "OS1");
        if (!pin) { sendDevice(ws, { type: "lampAck", ok: false, message: "출력 채널은 OS1~OS8 중 하나여야 합니다." }); return; }
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
    } catch (err) { console.error("[WS browser]", err); }
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
    const rows = await query("SELECT user_status AS status FROM user_profile WHERE user_id=? LIMIT 1", [user.id]);
    if (!rows.length) { ws.close(1008, "회원 정보를 찾을 수 없습니다."); return; }
    // 정지된 계정은 생산현황 데이터에 접근하지 못하도록 별도 코드로 연결을 종료하고, 클라이언트가 회원정보 화면으로 이동시킵니다.
    if (rows[0].status === "SUSPENDED") { ws.close(4001, "SUSPENDED"); return; }
    if (rows[0].status !== "APPROVED" && getPermissionLevel(user) < 8) { ws.close(1008, "승인된 회원만 이용할 수 있습니다."); return; }
  } catch (err) { console.error("WebSocket 계정 상태 확인 오류:", err); ws.close(1011, "계정 상태 확인 오류"); return; }
  if (ws.readyState !== WebSocket.OPEN) return;
  clients.add(ws);
  ws.factoryUserId = user.id;
  ws.factoryUser = user;
  browserAuthorized = true;
  for (const data of pendingBrowserMessages.splice(0)) void handleBrowserMessage(data);
  try { const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.is_active=1 ORDER BY p.product_id`); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "products", products: rows })); } catch (err) { console.error(err); }
});
function broadcast(message) { const data = JSON.stringify(message); for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data); }

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
  const devices = await query(`SELECT device_id,device_name,is_active,sort_order,last_ip,last_seen_at,updated_at FROM device ORDER BY sort_order,device_row_id`);
  const result = [];
  for (const device of devices) {
    const deviceConnected = isDeviceConnected(device.device_id);
    try {
      const sets = await query(`SELECT channel_id AS id,channel_name,input_signal,output_signal,is_active,output_state,input_state,last_change_source,input_message,output_message,sort_order,
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

function scheduleNextRun(schedule, afterDate = new Date()) {
  const shifted = new Date(afterDate.getTime() + KOREA_TIME_OFFSET_MS);
  const afterKst = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes(), 0, 0));
  const base = schedule.repeat_type === "ONCE" && schedule.schedule_time ? new Date(String(schedule.schedule_time).replace(" ", "T") + "+09:00") : null;
  if (base) return base > afterDate ? toKoreaDateTime(base) : null;
  const minute = Number(schedule.minute_value || 0), hour = Number(schedule.hour_value || 0);
  const weekdays = Number(schedule.weekday_mask || 0);
  const start = new Date(afterKst.getTime() + 60000);
  start.setUTCSeconds(0, 0);
  if (schedule.repeat_type === "HOURLY") {
    const firstHour = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours(), minute));
    if (firstHour > afterKst) return firstHour.toISOString().slice(0, 19).replace("T", " ");
    const nextHour = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours() + 1, minute));
    return nextHour.toISOString().slice(0, 19).replace("T", " ");
  }
  for (let dayOffset = 0; dayOffset <= 366 * 8; dayOffset++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + dayOffset));
    const year = day.getUTCFullYear(), month = day.getUTCMonth(), date = day.getUTCDate();
    if (schedule.repeat_type === "YEARLY" && (month + 1 !== Number(schedule.month_value) || date !== Number(schedule.day_value))) continue;
    if (schedule.repeat_type === "MONTHLY") {
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      if (schedule.is_month_end ? date !== last : date !== Number(schedule.day_of_month)) continue;
    }
    if (schedule.repeat_type === "WEEKLY" && !(weekdays & (1 << day.getUTCDay()))) continue;
    const candidate = new Date(Date.UTC(year, month, date, hour, minute));
    if (candidate > afterKst) return candidate.toISOString().slice(0, 19).replace("T", " ");
  }
  return null;
}
function validateScheduleInput(body) {
  const repeat = String(body.repeat_type || "ONCE").toUpperCase();
  const action = String(body.action_state || "").toUpperCase();
  const allowed = ["ONCE", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
  if (!allowed.includes(repeat) || !["ON", "OFF"].includes(action)) throw new Error("반복 유형 또는 실행 동작이 올바르지 않습니다.");
  let minute = Number(body.minute_value ?? 0), hour = body.hour_value === "" || body.hour_value == null ? null : Number(body.hour_value);
  let scheduleTime = null;
  if (repeat === "ONCE" || body.schedule_time) {
    const raw = String(body.schedule_time || "").trim().replace("T", " ");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)) throw new Error("실행 날짜와 시각을 입력하세요.");
    scheduleTime = raw.length === 16 ? `${raw}:00` : raw;
    const parsed = new Date(scheduleTime.replace(" ", "T") + "+09:00");
    if (Number.isNaN(parsed.getTime()) || toKoreaDateTime(parsed).slice(0, 19) !== scheduleTime) throw new Error("실행 날짜와 시각이 올바르지 않습니다.");
    if (repeat === "ONCE" && parsed <= new Date()) throw new Error("1회 예약 시각은 현재 이후여야 합니다.");
    hour = Number(raw.slice(11, 13));
    minute = Number(raw.slice(14, 16));
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
  if (repeat === "YEARLY" && (!Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12 || !Number.isInteger(dayValue) || dayValue < 1 || dayValue > 31)) throw new Error("연별 예약의 월과 일을 확인하세요.");
  const schedule = { repeat_type: repeat, action_state: action, schedule_time: scheduleTime, minute_value: minute, hour_value: hour, weekday_mask: weekdayMask, day_of_month: dayOfMonth, month_value: monthValue, day_value: dayValue, is_month_end: isMonthEnd };
  const next = scheduleNextRun(schedule);
  if (!next) throw new Error("유효한 다음 실행 시각을 계산할 수 없습니다.");
  return { ...schedule, next_run_at: next, schedule_name: String(body.schedule_name || "").trim().slice(0, 150), ostr_payload: String(body.ostr_payload ?? body.istr_payload ?? "").slice(0, 10000), is_enabled: body.is_enabled === false || body.is_enabled === 0 ? 0 : 1 };
}
function scheduleAdmin(req, res, next) { deviceAdminMiddleware(req, res, next); }
function requireScheduleListAccess(req, res, next) {
  const isChannelPreview = req.query.next_only === "1" && req.query.device_id && req.query.output_signal
    && req.query.is_enabled === "1" && Number(req.query.limit) === 1;
  if (isChannelPreview) return next();
  return requireAdminLevel(4)(req, res, next);
}
app.get("/api/device/schedules", requireLogin, requireActiveAccount, requireApproved, requireScheduleListAccess, async (req, res) => {
  try {
    const where = [], params = [];
    if (req.query.device_id) { where.push("s.device_id=?"); params.push(String(req.query.device_id)); }
    if (req.query.output_signal) { where.push("s.output_signal=?"); params.push(String(req.query.output_signal)); }
    if (req.query.created_by) { where.push("s.created_by=?"); params.push(Number(req.query.created_by)); }
    if (req.query.action_state && ["ON", "OFF"].includes(String(req.query.action_state).toUpperCase())) { where.push("s.action_state=?"); params.push(String(req.query.action_state).toUpperCase()); }
    if (req.query.repeat_type) { where.push("s.repeat_type=?"); params.push(String(req.query.repeat_type).toUpperCase()); }
    if (req.query.is_enabled !== undefined && req.query.is_enabled !== "") { where.push("s.is_enabled=?"); params.push(req.query.is_enabled === "true" || req.query.is_enabled === "1" ? 1 : 0); }
    if (req.query.next_only === "1") { where.push("s.next_run_at IS NOT NULL"); }
    if (req.query.search) { const q = `%${String(req.query.search).slice(0, 100)}%`; where.push("(s.schedule_name LIKE ? OR s.device_id LIKE ? OR s.output_signal LIKE ? OR s.ostr_payload LIKE ? OR u.user_name LIKE ? OR u.username LIKE ?)"); params.push(q, q, q, q, q, q); }
    if (req.query.start_date) { where.push("COALESCE(s.next_run_at,s.schedule_time)>=?"); params.push(`${req.query.start_date} 00:00:00`); }
    if (req.query.end_date) { where.push("COALESCE(s.next_run_at,s.schedule_time)<=?"); params.push(`${req.query.end_date} 23:59:59`); }
    const allowedSort = { schedule_id: "s.schedule_id", owner: "u.user_name", device: "s.device_id", channel: "s.output_signal", action: "s.action_state", repeat: "s.repeat_type", time: "COALESCE(s.next_run_at,s.schedule_time)", created: "s.created_at", status: "s.last_execution_status" };
    const sort = allowedSort[String(req.query.sort_by || "time")] || allowedSort.time;
    const direction = String(req.query.sort_order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500)), offset = (page - 1) * limit;
    const condition = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await query(`SELECT s.*,d.device_name,u.user_name AS owner_name,u.username AS owner_username FROM device_schedule s LEFT JOIN device d ON d.device_id=s.device_id LEFT JOIN user_profile u ON u.user_id=s.created_by ${condition} ORDER BY ${sort} ${direction},s.schedule_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ items: rows, total: rows.length, page, limit });
  } catch (err) { console.error("예약 조회 오류:", err); res.status(500).json({ error: "예약 목록을 조회하지 못했습니다." }); }
});
app.get("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), async (req, res) => {
  try { const rows = await query(`SELECT s.*,d.device_name,u.user_name AS owner_name FROM device_schedule s LEFT JOIN device d ON d.device_id=s.device_id LEFT JOIN user_profile u ON u.user_id=s.created_by WHERE s.schedule_id=?`, [req.params.id]); if (!rows.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); res.json(rows[0]); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약을 조회하지 못했습니다." }); }
});
app.post("/api/device/schedules", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), async (req, res) => {
  try {
    const deviceId = String(req.body.device_id || "").trim(), pin = normalizeDevicePin(req.body.output_signal || "");
    if (!deviceId || !DEVICE_OUTPUT_PINS.has(pin)) return res.status(400).json({ error: "디바이스와 유효한 출력 채널을 선택하세요." });
    const devices = await query("SELECT d.device_id FROM device d JOIN device_channel c ON c.device_id=d.device_id WHERE d.device_id=? AND c.output_signal=? AND d.is_active=1 AND c.is_active=1 LIMIT 1", [deviceId, pin]);
    if (!devices.length) return res.status(400).json({ error: "선택한 디바이스의 활성 출력 채널을 찾을 수 없습니다." });
    const data = validateScheduleInput(req.body);
    const result = await query(`INSERT INTO device_schedule(device_id,output_signal,schedule_name,action_state,ostr_payload,repeat_type,schedule_time,hour_value,minute_value,weekday_mask,day_of_month,month_value,day_value,is_month_end,is_enabled,next_run_at,last_execution_status,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [deviceId, pin, data.schedule_name, data.action_state, data.ostr_payload, data.repeat_type, data.schedule_time, data.hour_value, data.minute_value, data.weekday_mask, data.day_of_month, data.month_value, data.day_value, data.is_month_end ? 1 : 0, data.is_enabled, data.next_run_at, "WAITING", req.user.id, req.user.id]);
    const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [result.insertId]); res.status(201).json(rows[0]);
  } catch (err) { if (err.message) return res.status(400).json({ error: err.message }); console.error(err); res.status(500).json({ error: "예약을 등록하지 못했습니다." }); }
});
app.put("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), async (req, res) => {
  try {
    const current = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!current.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    const deviceId = String(req.body.device_id || current[0].device_id).trim(), pin = normalizeDevicePin(req.body.output_signal || current[0].output_signal);
    const devices = await query("SELECT d.device_id FROM device d JOIN device_channel c ON c.device_id=d.device_id WHERE d.device_id=? AND c.output_signal=? AND d.is_active=1 AND c.is_active=1 LIMIT 1", [deviceId, pin]); if (!devices.length) return res.status(400).json({ error: "유효한 디바이스 출력 채널을 선택하세요." });
    const data = validateScheduleInput({ ...current[0], ...req.body, device_id: deviceId, output_signal: pin, is_enabled: true });
    await query(`UPDATE device_schedule SET device_id=?,output_signal=?,schedule_name=?,action_state=?,ostr_payload=?,repeat_type=?,schedule_time=?,hour_value=?,minute_value=?,weekday_mask=?,day_of_month=?,month_value=?,day_value=?,is_month_end=?,is_enabled=?,next_run_at=?,last_execution_status='WAITING',updated_by=?,completed_at=NULL WHERE schedule_id=?`, [deviceId, pin, data.schedule_name, data.action_state, data.ostr_payload, data.repeat_type, data.schedule_time, data.hour_value, data.minute_value, data.weekday_mask, data.day_of_month, data.month_value, data.day_value, data.is_month_end ? 1 : 0, data.is_enabled, data.next_run_at, req.user.id, req.params.id]);
    const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); res.json(rows[0]);
  } catch (err) { if (err.message) return res.status(400).json({ error: err.message }); console.error(err); res.status(500).json({ error: "예약을 수정하지 못했습니다." }); }
});
app.patch("/api/device/schedules/:id/enabled", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), async (req, res) => {
  try { const rows = await query("SELECT * FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!rows.length) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); const enabled = req.body.is_enabled ? 1 : 0; const next = enabled ? scheduleNextRun(rows[0]) : null; await query("UPDATE device_schedule SET is_enabled=?,next_run_at=?,last_execution_status=?,updated_by=? WHERE schedule_id=?", [enabled, next, enabled ? "WAITING" : "DISABLED", req.user.id, req.params.id]); res.json({ ok: true, next_run_at: next }); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약 상태를 변경하지 못했습니다." }); }
});
app.delete("/api/device/schedules/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(4), async (req, res) => {
  try { const result = await query("DELETE FROM device_schedule WHERE schedule_id=?", [req.params.id]); if (!result.affectedRows) return res.status(404).json({ error: "예약을 찾을 수 없습니다." }); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: "예약을 삭제하지 못했습니다." }); }
});

app.get("/api/admin/device/devices", deviceAdminMiddleware, async (req, res) => {
  try { res.json(await getManagedDeviceDevices()); } catch (err) { console.error("Device 관리 목록 오류:", err); res.status(500).json({ error: "Device 장치 목록을 불러오지 못했습니다." }); }
});
app.put("/api/admin/device/devices/order", deviceAdminMiddleware, async (req, res) => {
  const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.map(String) : [];
  if (!deviceIds.length) return res.status(400).json({ error: "장치 순서 정보가 없습니다." });
  try {
    for (const [index, deviceId] of deviceIds.entries()) await query(`UPDATE device SET sort_order=? WHERE device_id=?`, [index + 1, deviceId]);
    res.json({ ok: true });
  } catch (err) { console.error("Device 장치 순서 저장 오류:", err); res.status(500).json({ error: "장치 순서를 저장하지 못했습니다." }); }
});
app.get("/api/device/devices", requireLogin, requireActiveAccount, requireApproved, async (req, res) => {
  try {
    const devices = (await getManagedDeviceDevices()).filter(device => Number(device.is_active) === 1).map(device => ({ ...device, sets: device.sets.filter(set => Number(set.is_active) === 1) }));
    res.json(devices);
  } catch (err) { console.error("활성 Device 목록 오류:", err); res.status(500).json({ error: "활성 Device 장치 목록을 불러오지 못했습니다." }); }
});
app.post("/api/admin/device/devices", deviceAdminMiddleware, async (req, res) => {
  const deviceId = String(req.body.deviceId || "").trim(), deviceName = String(req.body.deviceName || "").trim();
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(deviceId)) return res.status(400).json({ error: "장치 ID는 영문, 숫자, 밑줄, 하이픈으로 2~100자 입력하세요." });
  if (!deviceName) return res.status(400).json({ error: "장치 이름을 입력하세요." });
  const token = crypto.randomBytes(32).toString("hex"), tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const exists = await query(`SELECT device_row_id AS id FROM device WHERE device_id=?`, [deviceId]);
    if (exists.length) return res.status(409).json({ error: "장치 ID가 중복되었습니다." });
    const orderRows = await query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM device`);
    await query(`INSERT INTO device(device_id,device_name,token_hash,is_active,sort_order,last_change_source) VALUES(?,?,?,?,?,'BOOT')`, [deviceId, deviceName, tokenHash, 1, orderRows[0].next_order]);
    for (const [index, [inputPin, outputPin]] of DEVICE_FIXED_SETS.entries()) await query(`INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order) VALUES(?,?,?,?,?)`, [deviceId, outputPin, inputPin, outputPin, index]);
    res.status(201).json({ device: { device_id: deviceId, device_name: deviceName, is_active: 1, sets: DEVICE_FIXED_SETS.map(([inputPin, outputPin], index) => ({ channel_name: `채널 ${String(index + 1).padStart(2, "0")}`, input_signal: inputPin, output_signal: outputPin, output_state: "OFF", input_state: "OFF", is_active: 1, sort_order: index })) }, deviceToken: token });
  } catch (err) { console.error("Device 장치 등록 오류:", err); res.status(500).json({ error: "Device 장치를 등록하지 못했습니다." }); }
});
app.put("/api/admin/device/devices/:deviceId", deviceAdminMiddleware, async (req, res) => {
  const name = String(req.body.deviceName || "").trim();
  if (!name) return res.status(400).json({ error: "장치 이름을 입력하세요." });
  const is_active = req.body.active === undefined ? null : (req.body.active ? 1 : 0);
  const result = await query(`UPDATE device SET device_name=?,is_active=COALESCE(?,is_active),updated_at=NOW() WHERE device_id=?`, [name, is_active, req.params.deviceId]);
  if (!result.affectedRows) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
  res.json({ ok: true });
});
app.delete("/api/admin/device/devices/:deviceId", deviceAdminMiddleware, async (req, res) => {
  try {
    const existing = await query(`SELECT device_id FROM device WHERE device_id=? LIMIT 1`, [req.params.deviceId]);
    if (!existing.length) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
    await query(`DELETE FROM device WHERE device_id=?`, [req.params.deviceId]);
    const deletedSocket = deviceDeviceSockets.get(req.params.deviceId); if (deletedSocket) { deletedSocket.close(1008, "Device deleted"); deviceDeviceSockets.delete(req.params.deviceId); } if (req.params.deviceId === DEVICE_ID) deviceDeviceSocket = null;
    res.json({ ok: true });
  } catch (err) { console.error("Device 장치 삭제 오류:", err); res.status(500).json({ error: "장치를 삭제하지 못했습니다." }); }
});
app.put("/api/admin/device/devices/:deviceId/contact-sets/:setId", deviceAdminMiddleware, async (req, res) => {
  const name = String(req.body.setName || "").trim();
  if (!name) return res.status(400).json({ error: "접점 세트 이름을 입력하세요." });
  const is_active = req.body.active === undefined ? null : (req.body.active ? 1 : 0);
  const result = await query(`UPDATE device_channel SET channel_name=?,is_active=COALESCE(?,is_active),updated_at=NOW() WHERE channel_id=? AND device_id=?`, [name, is_active, req.params.setId, req.params.deviceId]);
  if (!result.affectedRows) return res.status(404).json({ error: "접점 세트를 찾을 수 없습니다." });
  res.json({ ok: true });
});

// ---------------------------------------------------------
// 신규 DB 테이블 준비 + 최초 마스터 생성
// ---------------------------------------------------------
// 현재 구조를 직접 생성하며 기존 버전 DB에 대한 ALTER·RENAME은 수행하지 않습니다.
async function verifySchemaNames() {
  const requiredColumns = {
    user_profile: ["user_id", "user_name", "user_status"],
    product: ["product_id", "product_status", "is_active"],
    user_setting: ["user_id"],
    device: ["device_row_id", "device_id"],
    device_channel: ["channel_id"],
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
}

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS user_profile (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    user_name VARCHAR(100) NOT NULL DEFAULT '',
    region VARCHAR(100) NOT NULL DEFAULT '',
    company VARCHAR(150) NOT NULL DEFAULT '',
    position VARCHAR(100) NOT NULL DEFAULT '',
    phone VARCHAR(20) NOT NULL DEFAULT '',
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
    UNIQUE KEY uq_user_profile_email (email),
    KEY idx_user_profile_status (user_status),
    KEY idx_user_profile_permission_level (permission_level),
    KEY idx_user_profile_created_at (created_at)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS product (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_code VARCHAR(50) NOT NULL UNIQUE,
    product_name VARCHAR(100) NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    target_quantity INT NOT NULL DEFAULT 100,
    product_status VARCHAR(20) NOT NULL DEFAULT '대기',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    updated_by INT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_product_updated_by FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_setting_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await ensureDeviceSchema();

  const masterUsername = String(process.env.MASTER_USERNAME || "").trim();
  const masterPassword = INITIAL_MASTER_PASSWORD;
  const masterName = String(process.env.MASTER_NAME || "").trim();
  const masterRegion = String(process.env.MASTER_REGION || "").trim();
  const masterCompany = String(process.env.MASTER_COMPANY || "").trim();
  const masterPosition = String(process.env.MASTER_POSITION || "").trim();
  const masterPhone = normalizePhone(process.env.MASTER_PHONE || "") || "";
  const masterEmail = normalizeEmail(process.env.MASTER_EMAIL || "") || "";

  if (masterUsername && masterPassword) {
    const rows = await query("SELECT user_id AS id,password_hash FROM user_profile WHERE username=? LIMIT 1", [masterUsername]);
    if (!rows.length) {
      await query(`INSERT INTO user_profile (username,password_hash,user_name,region,company,position,phone,email,role,permission_level,user_status,approved_at) VALUES (?,?,?,?,?,?,?,?, 'MASTER',10,'APPROVED',NOW())`, [masterUsername, hashPassword(masterPassword), masterName, masterRegion, masterCompany, masterPosition, masterPhone, masterEmail]);
      console.log(`최초 MASTER 계정 생성: ${masterUsername}`);
    } else {
      const passwordHash = rows[0].password_hash === "INITIAL_MASTER_NO_PASSWORD" ? hashPassword(masterPassword) : rows[0].password_hash;
      await query("UPDATE user_profile SET role='MASTER',permission_level=10,user_status='APPROVED',approved_at=COALESCE(approved_at,NOW()),password_hash=? WHERE username=?", [passwordHash, masterUsername]);
    }
  } else {
    console.log("MASTER_USERNAME과 MASTER_PASSWORD를 .env에 설정하면 최초 MASTER 계정이 자동 생성됩니다.");
  }
}

// 예약 실행 엔진: 실제 전달은 기존 queueDeviceCommand/OStr(출력 문자열) 체계를 재사용합니다.
let scheduleTickBusy = false;
async function runDueSchedules() {
  if (scheduleTickBusy) return;
  scheduleTickBusy = true;
  try {
    const now = toKoreaDateTime(new Date());
    const due = await query("SELECT * FROM device_schedule WHERE is_enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? AND last_execution_status NOT IN ('RUNNING') ORDER BY next_run_at,schedule_id LIMIT 50", [now]);
    for (const row of due) {
      const claim = await query("UPDATE device_schedule SET last_execution_status='RUNNING',last_execution_message='예약 실행 처리 중' WHERE schedule_id=? AND is_enabled=1 AND next_run_at=? AND last_execution_status<>'RUNNING'", [row.schedule_id, row.next_run_at]);
      if (!claim.affectedRows) continue;
      try {
        const requester = await resolveScheduleSource(`SCHEDULE:${row.schedule_id}`);
        await queueDeviceCommand(row.device_id, row.output_signal, row.action_state, requester, String(row.ostr_payload ?? row.istr_payload ?? ""));
        const runAt = toKoreaDateTime(new Date());
        if (row.repeat_type === "ONCE") {
          await query("UPDATE device_schedule SET is_enabled=0,next_run_at=NULL,last_run_at=?,last_execution_status='QUEUED',last_execution_message='명령이 기존 명령 큐에 등록되었습니다.',completed_at=NULL WHERE schedule_id=?", [runAt, row.schedule_id]);
        } else {
          const next = scheduleNextRun(row, new Date());
          await query("UPDATE device_schedule SET next_run_at=?,last_run_at=?,is_enabled=1,completed_at=NULL,last_execution_status='WAITING',last_execution_message='명령이 기존 명령 큐에 등록되었습니다.' WHERE schedule_id=? AND is_enabled=1", [next, runAt, row.schedule_id]);
        }
        broadcastDeviceBrowsers({ type: "scheduleChanged", deviceId: row.device_id, OutputSignal: row.output_signal, scheduleId: String(row.schedule_id) });
      } catch (err) {
        const retry = row.repeat_type === "ONCE" ? null : scheduleNextRun(row, new Date(Date.now() + 60000));
        await query("UPDATE device_schedule SET next_run_at=?,last_run_at=?,last_execution_status='FAILED',last_execution_message=? WHERE schedule_id=? AND is_enabled=1", [retry, toKoreaDateTime(new Date()), String(err.message || err).slice(0, 2000), row.schedule_id]);
      }
    }
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
