require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mariadb = require("mariadb");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const path = require("path");

const app = express();
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

// Wemos D1 R1 D9 램프 통합 설정
const WEMOS_DEVICE_ID = String(process.env.WEMOS_DEVICE_ID || "WEMOS-D1-001");
const WEMOS_DEVICE_TOKEN = String(process.env.WEMOS_DEVICE_TOKEN || "");
const wemosDeviceSockets = new Map();
// 기존 단일 장치 코드와의 호환을 위해 유지합니다. 실제 다중 장치 통신은 Map을 사용합니다.
let wemosDeviceSocket = null;

app.use(express.json({ limit: "100kb" }));
app.use(["/wemos.html", "/wemos-view.html", "/wemos-admin.html", "/wemos.js", "/wemos-view.js", "/wemos-admin.js"], (req, res, next) => {
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
  const phone = normalizePhone(body.phone);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!/^[A-Za-z0-9_]{4,50}$/.test(username)) return { error: "아이디는 영문, 숫자, _만 사용하여 4~50자로 입력하세요." };
  if (name.length < 1 || name.length > 100) return { error: "이름을 올바르게 입력하세요." };
  if (region.length < 1 || region.length > 100) return { error: "지역을 입력하세요." };
  if (company.length < 1 || company.length > 150) return { error: "회사를 입력하세요." };
  if (position.length < 1 || position.length > 100) return { error: "직위를 입력하세요." };
  if (!phone) return { error: "전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678" };
  if (!email) return { error: "이메일 주소 형식이 올바르지 않습니다. 예: user@example.com" };
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
    return res.redirect("/login.html");
  }
  req.user = session.user;
  req.sessionToken = session.token;
  next();
}

function requireApproved(req, res, next) {
  if (req.user.status !== "APPROVED" && getPermissionLevel(req.user) < 8) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "관리자 승인 완료 후 이용할 수 있습니다.", code: "APPROVAL_REQUIRED" });
    return res.redirect("/profile.html?pending=1");
  }
  next();
}

// 정지된 계정이나 삭제된 계정이 회원정보 화면 외의 페이지로 이동하면 로그아웃 후 로그인 화면으로 보냅니다.
async function requireActiveAccount(req, res, next) {
  try {
    const rows = await query("SELECT status FROM users WHERE id=? LIMIT 1", [req.user.id]);
    if (!rows.length) {
      if (req.sessionToken) sessions.delete(req.sessionToken);
      clearSessionCookie(res);
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "회원 정보를 찾을 수 없습니다.", code: "ACCOUNT_NOT_FOUND" });
      return res.redirect("/login.html");
    }
    req.user.status = rows[0].status;
    if (rows[0].status === "SUSPENDED") {
      // 정지된 계정은 로그아웃시키지 않고 회원정보 화면으로만 접근을 제한합니다.
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: "사용이 정지된 계정입니다. 회원정보 화면에서만 이용할 수 있습니다.", code: "SUSPENDED", redirect: "/profile.html?pending=1" });
      return res.redirect("/profile.html?pending=1");
    }
    next();
  } catch (err) { console.error("계정 상태 확인 오류:", err); res.status(500).json({ error: "계정 상태 확인 중 오류가 발생했습니다." }); }
}

function requireAdminLevel(minimumLevel = 8) {
  return (req, res, next) => {
    if (!req.user || getPermissionLevel(req.user) < minimumLevel) {
      if (req.path.startsWith("/api/")) return res.status(403).json({ error: `${minimumLevel}등급 이상 관리자 권한이 필요합니다.`, code: "ADMIN_REQUIRED" });
      return res.redirect("/profile.html?access=denied");
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
app.get("/", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/index.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/control.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), (req, res) => res.sendFile(path.join(__dirname, "public", "control.html")));
app.get("/product-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), (req, res) => res.sendFile(path.join(__dirname, "public", "product-admin.html")));
app.get("/admin.html", requireLogin, requireActiveAccount, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/profile.html", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));
app.get("/settings.html", requireLogin, requireActiveAccount, (req, res) => res.sendFile(path.join(__dirname, "public", "settings.html")));
app.get("/wemos.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), (req, res) => res.sendFile(path.join(__dirname, "public", "wemos.html")));
app.get("/wemos-view.html", requireLogin, requireActiveAccount, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "wemos-view.html")));
app.get("/wemos-admin.html", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), (req, res) => res.sendFile(path.join(__dirname, "public", "wemos-admin.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ---------------------------------------------------------
// 회원가입: 신청 상태 PENDING
// ---------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const data = validateProfile(req.body, { passwordRequired: true });
  if (data.error) return res.status(400).json({ error: data.error });

  try {
      const exists = await query("SELECT id, username, email FROM users WHERE username = ? OR email = ? LIMIT 1", [data.username, data.email]);
    if (exists.length) {
      if (exists[0].username === data.username) return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
      return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다." });
    }
    const result = await query(`INSERT INTO users (username,password_hash,name,region,company,position,phone,email,status,role,permission_level,user_request_at) VALUES (?,?,?,?,?,?,?,?, 'PENDING','USER',1,NOW())`, [data.username, hashPassword(data.password), data.name, data.region, data.company, data.position, data.phone, data.email]);
    //  res.status(201).json({ ok: true, message: "가입 신청이 접수되었습니다. 마스터 승인 후 생산 현황판을 이용할 수 있습니다.", userId: result.insertId });
    res.status(201).json({ ok: true, message: "가입 신청이 접수되었습니다. 마스터 승인 후 생산 현황판을 이용할 수 있습니다." });
  } catch (err) {
    console.error("회원가입 오류:", { code: err.code, errno: err.errno, sqlState: err.sqlState, message: err.message });
    if (err.code === "ER_DUP_ENTRY" || err.code === "ER_DUP_ENTRY_WITH_TRUNCATED_WRITES") return res.status(409).json({ error: "아이디 또는 이메일이 이미 등록되어 있습니다." });
    if (err.code === "ER_BAD_FIELD_ERROR" || /unknown column.*permission_level/i.test(String(err.message))) return res.status(500).json({ error: "데이터베이스에 권한 등급 컬럼이 없습니다. 서버를 최신 버전으로 재배포하거나 DB 마이그레이션을 실행하세요." });
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
    const rows = await query(`SELECT id,username,password_hash,name,region,company,position,phone,email,role,permission_level,status FROM users WHERE username = ? LIMIT 1`, [username]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });

    const token = createSession(rows[0]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, permissionLevel: Number(rows[0].permission_level || (rows[0].role === "MASTER" ? 10 : 1)), status: rows[0].status }, redirect: ["PENDING", "REJECTED", "WITHDRAWAL_PENDING", "SUSPENDED"].includes(rows[0].status) ? "/profile.html?pending=1" : "/" });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const rows = await query(`SELECT id,username,name,region,company,position,phone,email,role,permission_level,status,approved_at,created_at,updated_at FROM users WHERE id=?`, [req.user.id]);
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
    const exists = await query("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [data.email, req.user.id]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 이메일 주소입니다." });
    if (data.password) {
      const rows = await query("SELECT password_hash FROM users WHERE id=? LIMIT 1", [req.user.id]);
      if (!rows.length || !verifyPassword(currentPassword, rows[0].password_hash)) return res.status(400).json({ error: "기존 비밀번호가 올바르지 않습니다." });
      await query(`UPDATE users SET name=?,region=?,company=?,position=?,phone=?,email=?,password_hash=?,user_request_at=NOW() WHERE id=?`, [data.name, data.region, data.company, data.position, data.phone, data.email, hashPassword(data.password), req.user.id]);
    } else {
      await query(`UPDATE users SET name=?,region=?,company=?,position=?,phone=?,email=?,user_request_at=NOW() WHERE id=?`, [data.name, data.region, data.company, data.position, data.phone, data.email, req.user.id]);
    }
    const rows = await query(`SELECT id,username,name,region,company,position,phone,email,role,permission_level,status,approved_at,created_at,updated_at FROM users WHERE id=?`, [req.user.id]);
    req.user.name = rows[0].name;
    res.json({ ok: true, user: rows[0], message: "회원정보가 수정되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원정보 수정 오류" }); }
});

app.post("/api/logout", (req, res) => { const token = getCookie(req, SESSION_COOKIE); if (token) sessions.delete(token); clearSessionCookie(res); res.json({ ok: true }); });

app.post("/api/me/reapply", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT status FROM users WHERE id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (rows[0].status !== "REJECTED") return res.status(400).json({ error: "반려된 회원만 재신청할 수 있습니다." });
    await query("UPDATE users SET status='PENDING',approved_at=NULL,approved_by=NULL,user_request_at=NOW() WHERE id=?", [req.user.id]);
    req.user.status = "PENDING";
    res.json({ ok: true, message: "가입 재신청이 접수되었습니다." });
  } catch (err) { console.error("재신청 오류:", err); res.status(500).json({ error: "가입 재신청 처리 중 오류가 발생했습니다." }); }
});

app.post("/api/me/withdraw", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT status FROM users WHERE id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (["PENDING", "REJECTED", "WITHDRAWAL_PENDING"].includes(rows[0].status)) return res.status(400).json({ error: "현재 상태에서는 탈퇴 신청을 할 수 없습니다." });
    await query("UPDATE users SET status='WITHDRAWAL_PENDING',user_request_at=NOW() WHERE id=?", [req.user.id]);
    req.user.status = "WITHDRAWAL_PENDING";
    res.json({ ok: true, message: "탈퇴 신청이 접수되었습니다." });
  } catch (err) { console.error("탈퇴 신청 오류:", err); res.status(500).json({ error: "탈퇴 신청 처리 중 오류가 발생했습니다." }); }
});

app.post("/api/me/cancel-withdraw", requireLogin, async (req, res) => {
  try {
    const rows = await query("SELECT status FROM users WHERE id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    if (rows[0].status !== "WITHDRAWAL_PENDING") return res.status(400).json({ error: "탈퇴 신청 상태에서만 취소할 수 있습니다." });
    await query("UPDATE users SET status='APPROVED' WHERE id=?", [req.user.id]);
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
  show_updated_at: true, show_updated_by: true, date_format: "ko-KR"
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
  if (!DATE_FORMATS.includes(dateFormat)) return { error: "날짜 형식 값이 올바르지 않습니다." };

  return {
    sound_type: soundType, sound_volume: soundVolume, sound_enabled: soundEnabled, theme,
    display_mode: displayMode, show_summary: showSummary, show_target: showTarget, show_rate: showRate,
    show_updated_at: showUpdatedAt, show_updated_by: showUpdatedBy,
    date_format: dateFormat
  };
}

app.get("/api/me/settings", requireLogin, requireActiveAccount, async (req, res) => {
  try {
    const rows = await query("SELECT * FROM user_settings WHERE user_id=? LIMIT 1", [req.user.id]);
    if (!rows.length) return res.json(SETTINGS_DEFAULTS);
    res.json(rowToSettings(rows[0]));
  } catch (err) { console.error("설정 조회 오류:", err); res.status(500).json({ error: "설정 조회 중 오류가 발생했습니다." }); }
});

app.put("/api/me/settings", requireLogin, requireActiveAccount, async (req, res) => {
  const data = validateSettings(req.body || {});
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const existing = await query("SELECT user_id FROM user_settings WHERE user_id=? LIMIT 1", [req.user.id]);
    await query(
      `INSERT INTO user_settings (user_id,sound_type,sound_volume,sound_enabled,theme,display_mode,show_summary,show_target,show_rate,show_updated_at,show_updated_by,date_format)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE sound_type=VALUES(sound_type),sound_volume=VALUES(sound_volume),sound_enabled=VALUES(sound_enabled),
         theme=VALUES(theme),display_mode=VALUES(display_mode),show_summary=VALUES(show_summary),show_target=VALUES(show_target),
         show_rate=VALUES(show_rate),show_updated_at=VALUES(show_updated_at),show_updated_by=VALUES(show_updated_by),date_format=VALUES(date_format)`,
      [req.user.id, data.sound_type, data.sound_volume, toBool(data.sound_enabled), data.theme, data.display_mode,
        toBool(data.show_summary), toBool(data.show_target), toBool(data.show_rate),
        toBool(data.show_updated_at), toBool(data.show_updated_by), data.date_format]
    );
    res.status(existing.length ? 200 : 201).json({ ok: true, message: "설정이 저장되었습니다.", settings: data });
  } catch (err) { console.error("설정 저장 오류:", err); res.status(500).json({ error: "설정 저장 중 오류가 발생했습니다." }); }
});

// ---------------------------------------------------------
// 마스터 관리
// ---------------------------------------------------------
app.get("/api/admin/users", requireLogin, requireMaster, async (req, res) => {
  try {
    const rows = await query(`SELECT id,username,name,region,company,position,phone,email,role,permission_level,admin_memo,status,approved_at,created_at,updated_at,user_request_at FROM users ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 WHEN 'WITHDRAWAL_PENDING' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END, created_at DESC`);
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
    const exists = await query("SELECT id,role,permission_level,status FROM users WHERE id=?", [id]);
    if (!exists.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    if (exists[0].permission_level >= getPermissionLevel(req.user) && id !== req.user.id) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 관리할 수 있습니다." });
    if (status === "APPROVED" && exists[0].status === "PENDING") await query("UPDATE users SET status='APPROVED',permission_level=1,role='USER',approved_at=NOW(),approved_by=? WHERE id=?", [req.user.id, id]);
    else if (status === "APPROVED") await query("UPDATE users SET status='APPROVED',approved_at=NOW(),approved_by=? WHERE id=?", [req.user.id, id]);
    else await query("UPDATE users SET status=?,approved_at=NULL,approved_by=NULL WHERE id=?", [status, id]);
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
    const duplicate = await query("SELECT id FROM users WHERE (username=? OR email=?) AND id<>? LIMIT 1", [data.username, data.email, id]);
    if (duplicate.length) return res.status(409).json({ error: "아이디 또는 이메일이 다른 회원과 중복됩니다." });
    const requestedLevel = Number(req.body.permissionLevel);
    if (!Number.isInteger(requestedLevel) || requestedLevel < 1 || requestedLevel > 10) return res.status(400).json({ error: "권한 등급은 1~10 사이로 입력하세요." });
    const adminMemo = String(req.body.adminMemo || "").trim();
    if (adminMemo.length > 5000) return res.status(400).json({ error: "관리자 메모는 5000자 이내로 입력하세요." });
    const target = await query("SELECT role,permission_level FROM users WHERE id=?", [id]);
    if (!target.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    if (target[0].permission_level >= getPermissionLevel(req.user) && id !== req.user.id) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 수정할 수 있습니다." });
    if (requestedLevel >= getPermissionLevel(req.user)) return res.status(403).json({ error: "자신보다 낮은 등급만 부여할 수 있습니다." });
    if (id === req.user.id) return res.status(403).json({ error: "자신의 권한 등급은 변경할 수 없습니다." });
    if (data.password) await query(`UPDATE users SET username=?,name=?,region=?,company=?,position=?,phone=?,email=?,password_hash=?,permission_level=?,admin_memo=? WHERE id=?`, [data.username, data.name, data.region, data.company, data.position, data.phone, data.email, hashPassword(data.password), requestedLevel, adminMemo, id]);
    else await query(`UPDATE users SET username=?,name=?,region=?,company=?,position=?,phone=?,email=?,permission_level=?,admin_memo=? WHERE id=?`, [data.username, data.name, data.region, data.company, data.position, data.phone, data.email, requestedLevel, adminMemo, id]);
    res.json({ ok: true, message: "회원정보가 수정되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "관리자 회원정보 수정 오류" }); }
});

app.delete("/api/admin/users/:id", requireLogin, requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 회원 ID입니다." });
  if (id === req.user.id) return res.status(403).json({ error: "현재 로그인한 관리자 계정은 삭제할 수 없습니다." });
  try {
    const rows = await query("SELECT id,permission_level,status FROM users WHERE id=? LIMIT 1", [id]);
    if (!rows.length) return res.status(404).json({ error: "회원을 찾을 수 없습니다." });
    if (Number(rows[0].permission_level || 1) >= getPermissionLevel(req.user)) return res.status(403).json({ error: "자신보다 낮은 등급의 회원만 삭제할 수 있습니다." });
    await query("DELETE FROM users WHERE id=?", [id]);
    forceLogoutUser(id);
    res.json({ ok: true, message: "회원이 삭제되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 삭제 오류" }); }
});

// ---------------------------------------------------------
// 생산현황 API
// ---------------------------------------------------------
app.get("/api/health", async (req, res) => { try { await query("SELECT 1 AS ok"); res.json({ ok: true, database: "connected" }); } catch { res.status(500).json({ ok: false, database: "error" }); } });

// 제품 목록/단건 조회 시 최종 변경자 이름을 함께 가져옵니다.
const PRODUCT_FIELDS = "p.id,p.product_code,p.product_name,p.quantity,p.target_quantity,p.status,p.updated_at,p.updated_by,u.name AS updated_by_name";
const PRODUCT_JOIN = "FROM products p LEFT JOIN users u ON u.id = p.updated_by";

app.get("/api/products", requireLogin, requireActiveAccount, requireApproved, async (req, res) => { try { res.json(await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.active=1 ORDER BY p.id`)); } catch (err) { console.error(err); res.status(500).json({ error: "DB 조회 오류" }); } });

app.put("/api/products/:id/quantity", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), quantity = Number(req.body.quantity);
  if (!Number.isInteger(id) || !Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ error: "수량이 올바르지 않습니다." });
  try { const result = await query(`UPDATE products SET quantity=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`, [quantity, req.user.id, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.id=?`, [id]); broadcast({ type: "quantityUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "DB 업데이트 오류" }); }
});

app.put("/api/products/:id/status", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), status = String(req.body.status || "").trim();
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return res.status(400).json({ error: "상태값이 올바르지 않습니다." });
  try { const result = await query(`UPDATE products SET status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`, [status, req.user.id, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.id=?`, [id]); broadcast({ type: "productUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "상태 업데이트 오류" }); }
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
    const exists = await query("SELECT id FROM products WHERE product_code=? LIMIT 1", [data.productCode]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("INSERT INTO products (product_code,product_name,quantity,target_quantity,status,updated_by) VALUES (?,?,?,?,?,?)", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status, req.user.id]);
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.id=?`, [result.insertId]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.active=1 ORDER BY p.id`) });
    res.status(201).json(rows[0]);
  } catch (err) { console.error("제품 추가 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 추가 오류" }); }
});

app.put("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  const data = validateProduct(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const duplicate = await query("SELECT id FROM products WHERE product_code=? AND id<>? LIMIT 1", [data.productCode, id]);
    if (duplicate.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("UPDATE products SET product_code=?,product_name=?,quantity=?,target_quantity=?,status=?,updated_by=? WHERE id=?", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status, req.user.id, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.id=?`, [id]);
    broadcast({ type: "productsChanged", products: await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.active=1 ORDER BY p.id`) });
    res.json(rows[0]);
  } catch (err) { console.error("제품 수정 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 수정 오류" }); }
});

app.delete("/api/admin/products/:id", requireLogin, requireActiveAccount, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  try {
    const result = await query("DELETE FROM products WHERE id=?", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    broadcast({ type: "productsChanged", products: await query("SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE active=1 ORDER BY id") });
    res.json({ ok: true, message: "제품이 삭제되었습니다." });
  } catch (err) { console.error("제품 삭제 오류:", err); res.status(500).json({ error: "제품 삭제 오류" }); }
});

// ---------------------------------------------------------
// Wemos D1 R1 통합 기능
// ---------------------------------------------------------
const WEMOS_CHANNEL_COUNT = 8;
const WEMOS_CHANNELS = Array.from({ length: WEMOS_CHANNEL_COUNT }, (_, index) => ({
  index: index + 1,
  inputPin: `IS${index + 1}`,
  outputPin: `OS${index + 1}`
}));
const WEMOS_OUTPUT_PINS = new Set(WEMOS_CHANNELS.map(channel => channel.outputPin));

function normalizeWemosState(value) {
  return String(value || "").toUpperCase() === "ON" ? "ON" : "OFF";
}
function parseWemosState(value) {
  const state = String(value || "").toUpperCase();
  return state === "ON" || state === "OFF" ? state : null;
}
function normalizeWemosPin(value) {
  const pin = String(value || "").trim().toUpperCase();
  if (WEMOS_OUTPUT_PINS.has(pin)) return pin;

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
function sendWemos(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(stringifyWebSocketMessage(message));
}
function broadcastWemosBrowsers(message) {
  const data = stringifyWebSocketMessage(message);
  for (const ws of clients) {
    if (ws.wemosSubscriber === true && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
async function ensureWemosSchema() {
  await query(`CREATE TABLE IF NOT EXISTS wemos_devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    current_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    d8_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    d7_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    d10_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    d11_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    last_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    d8_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    d7_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    d10_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    d11_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    last_seen_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id), UNIQUE KEY uq_wemos_device_id (device_id)
  ) ENGINE=InnoDB`);

  const deviceColumns = await query(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wemos_devices'`);
  const deviceColumnNames = new Set(deviceColumns.map(column => String(column.column_name).toLowerCase()));

  for (const [columnName, definition] of [
    ["device_name", "VARCHAR(100) NOT NULL DEFAULT ''"],
    ["token_hash", "CHAR(64) NULL"],
    ["active", "TINYINT(1) NOT NULL DEFAULT 1"],
    ["sort_order", "INT NOT NULL DEFAULT 0"],
    ["d8_state", "ENUM('ON','OFF') NOT NULL DEFAULT 'OFF'"],
    ["d7_state", "ENUM('ON','OFF') NOT NULL DEFAULT 'OFF'"],
    ["d10_state", "ENUM('ON','OFF') NOT NULL DEFAULT 'OFF'"],
    ["d11_state", "ENUM('ON','OFF') NOT NULL DEFAULT 'OFF'"],
    ["d8_source", "VARCHAR(100) NOT NULL DEFAULT 'BOOT'"],
    ["d7_source", "VARCHAR(100) NOT NULL DEFAULT 'BOOT'"],
    ["d10_source", "VARCHAR(100) NOT NULL DEFAULT 'BOOT'"],
    ["d11_source", "VARCHAR(100) NOT NULL DEFAULT 'BOOT'"]
  ]) {
    if (!deviceColumnNames.has(columnName)) {
      await query(`ALTER TABLE wemos_devices ADD COLUMN ${columnName} ${definition}`);
    }
  }

  await query(`UPDATE wemos_devices SET sort_order=id WHERE sort_order=0`);

  await query(`CREATE TABLE IF NOT EXISTS wemos_contact_sets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    set_name VARCHAR(100) NOT NULL,
    input_pin VARCHAR(20) NOT NULL,
    output_pin VARCHAR(20) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    current_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
    last_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
    input_string TEXT NULL,
    output_string TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_contact_input(device_id,input_pin),
    UNIQUE KEY uq_contact_output(device_id,output_pin),
    CONSTRAINT fk_contact_device FOREIGN KEY (device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  const contactColumns = await query(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wemos_contact_sets'`);
  const contactColumnNames = new Set(contactColumns.map(column => String(column.column_name).toLowerCase()));
  for (const [columnName, definition] of [
    ["input_string", "TEXT NULL"],
    ["output_string", "TEXT NULL"]
  ]) {
    if (!contactColumnNames.has(columnName)) {
      await query(`ALTER TABLE wemos_contact_sets ADD COLUMN ${columnName} ${definition}`);
    }
  }

  await query(`CREATE TABLE IF NOT EXISTS wemos_device_commands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    command_id CHAR(36) NOT NULL,
    device_id VARCHAR(100) NOT NULL,
    pin_name VARCHAR(20) NOT NULL DEFAULT 'OS1',
    desired_state ENUM('ON','OFF') NOT NULL,
    output_string TEXT NULL,
    requester VARCHAR(100) NOT NULL DEFAULT 'CLIENT',
    status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id), UNIQUE KEY uq_wemos_command_id (command_id),
    KEY idx_wemos_poll (device_id,status,id),
    CONSTRAINT fk_wemos_command_device FOREIGN KEY (device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  const commandColumns = await query(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wemos_device_commands'`);
  const commandColumnNames = new Set(commandColumns.map(column => String(column.column_name).toLowerCase()));
  if (!commandColumnNames.has("pin_name")) await query(`ALTER TABLE wemos_device_commands ADD COLUMN pin_name VARCHAR(20) NOT NULL DEFAULT 'OS1'`);
  if (!commandColumnNames.has("output_string")) await query(`ALTER TABLE wemos_device_commands ADD COLUMN output_string TEXT NULL`);
  if (!commandColumnNames.has("changed_at")) await query(`ALTER TABLE wemos_device_commands ADD COLUMN changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);

  const commandStatusInfo = await query(`SELECT COLUMN_TYPE AS column_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wemos_device_commands' AND COLUMN_NAME='status' LIMIT 1`);
  if (commandStatusInfo.length && !String(commandStatusInfo[0].column_type).includes("'CANCELLED'")) {
    await query(`ALTER TABLE wemos_device_commands MODIFY COLUMN status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING'`);
  }

  await query(`CREATE TABLE IF NOT EXISTS wemos_lamp_state_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    device_id VARCHAR(100) NOT NULL,
    pin_name VARCHAR(20) NOT NULL DEFAULT 'OS1',
    previous_state ENUM('ON','OFF') NULL,
    new_state ENUM('ON','OFF') NOT NULL,
    source VARCHAR(100) NOT NULL,
    command_id CHAR(36) NULL,
    changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id), KEY idx_wemos_history (device_id,changed_at),
    CONSTRAINT fk_wemos_hist_device FOREIGN KEY (device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await query(`INSERT INTO wemos_devices(device_id,device_name,token_hash,current_state,last_source)
    VALUES(?,?,?,'OFF','BOOT')
    ON DUPLICATE KEY UPDATE
      device_name=IF(device_name='',VALUES(device_name),device_name),
      token_hash=COALESCE(token_hash,VALUES(token_hash))`,
    [WEMOS_DEVICE_ID,WEMOS_DEVICE_ID,WEMOS_DEVICE_TOKEN ? crypto.createHash("sha256").update(WEMOS_DEVICE_TOKEN).digest("hex") : null]);

  // 기존 V0의 D12/D8 ~ D15/D11 4개 세트를 새 논리 IS/OS 이름으로 1회 변환합니다.
  const legacySets = await query(`SELECT id FROM wemos_contact_sets WHERE device_id=? ORDER BY sort_order,id`, [WEMOS_DEVICE_ID]);
  const logicalSets = WEMOS_CHANNELS;
  for (let index = 0; index < logicalSets.length; index++) {
    const channel = logicalSets[index];
    const existing = await query(`SELECT id FROM wemos_contact_sets WHERE device_id=? AND input_pin=? LIMIT 1`, [WEMOS_DEVICE_ID, channel.inputPin]);
    if (existing.length) continue;

    if (legacySets[index]) {
      try {
        await query(`UPDATE wemos_contact_sets SET set_name=?,input_pin=?,output_pin=?,sort_order=? WHERE id=?`,
          [`채널 ${String(index + 1).padStart(2,"0")}`,channel.inputPin,channel.outputPin,index,legacySets[index].id]);
        continue;
      } catch (err) {
        console.warn("[Wemos] 기존 접점 세트 변환 건너뜀:", err.message);
      }
    }
    await query(`INSERT IGNORE INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,sort_order)
      VALUES(?,?,?,?,?)`,
      [WEMOS_DEVICE_ID,`채널 ${String(index + 1).padStart(2,"0")}`,channel.inputPin,channel.outputPin,index]);
  }

  // 다른 장치가 이미 등록되어 있어도 새 8채널 구조를 보장합니다.
  const devices = await query(`SELECT device_id FROM wemos_devices`);
  for (const device of devices) {
    for (const channel of WEMOS_CHANNELS) {
      await query(`INSERT IGNORE INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,sort_order)
        VALUES(?,?,?,?,?)`,
        [device.device_id,`채널 ${String(channel.index).padStart(2,"0")}`,channel.inputPin,channel.outputPin,channel.index - 1]);
    }
  }

  await query(`ALTER TABLE wemos_devices MODIFY COLUMN last_source VARCHAR(100) NOT NULL DEFAULT 'BOOT'`);
  await query(`ALTER TABLE wemos_lamp_state_history MODIFY COLUMN source VARCHAR(100) NOT NULL`);
}

async function getWemosState(deviceId = null) {
  const devices = deviceId
    ? await query(`SELECT device_id,device_name,active,last_source,last_seen_at,updated_at FROM wemos_devices WHERE device_id=?`, [deviceId])
    : await query(`SELECT device_id,device_name,active,last_source,last_seen_at,updated_at FROM wemos_devices ORDER BY sort_order,id`);
  if (!devices.length) return null;

  const device = devices[0];
  const sets = await query(
    `SELECT id,set_name,input_pin,output_pin,active,current_state,last_source,input_string,output_string,sort_order
     FROM wemos_contact_sets WHERE device_id=? ORDER BY sort_order,id`,
    [device.device_id]
  );

  return {
    ...device,
    channels: sets,
    // V0 UI 호환용 첫 번째 OS 상태
    current_state: sets.find(set => set.output_pin === "OS1")?.current_state || "OFF"
  };
}

async function getWemosHistory(limit=50, deviceId=null) {
  const n=Math.min(Math.max(Number(limit||50),1),50);
  if (deviceId) return await query(
    `SELECT id,device_id,pin_name,previous_state,new_state,source,command_id,changed_at
     FROM wemos_lamp_state_history WHERE device_id=? ORDER BY id DESC LIMIT ${n}`,[deviceId]);
  return await query(
    `SELECT id,device_id,pin_name,previous_state,new_state,source,command_id,changed_at
     FROM wemos_lamp_state_history ORDER BY id DESC LIMIT ${n}`);
}

async function getWemosCommands(limit=50, deviceId=null) {
  const n=Math.min(Math.max(Number(limit||50),1),50);
  const fields=`id,command_id,device_id,pin_name,desired_state,output_string,requester,status,changed_at`;
  if (deviceId) return await query(
    `SELECT ${fields} FROM wemos_device_commands WHERE device_id=? ORDER BY id DESC LIMIT ${n}`,[deviceId]);
  return await query(
    `SELECT ${fields} FROM wemos_device_commands ORDER BY id DESC LIMIT ${n}`);
}

async function trimWemosTable(tableName,maxRows=1000,deviceId=null) {
  if (deviceId) {
    await query(`DELETE FROM ${tableName} WHERE device_id=? AND id <= (
      SELECT id FROM (SELECT id FROM ${tableName} WHERE device_id=? ORDER BY id DESC LIMIT 1 OFFSET ${maxRows}) old_rows
    )`,[deviceId,deviceId]);
  } else {
    await query(`DELETE FROM ${tableName} WHERE id <= (
      SELECT id FROM (SELECT id FROM ${tableName} ORDER BY id DESC LIMIT 1 OFFSET ${maxRows}) old_rows
    )`);
  }
}

function getWemosDeviceSocket(deviceId) {
  const ws = wemosDeviceSockets.get(String(deviceId));
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.wemosIdentified !== true) return null;
  return ws;
}
function isWemosConnected(deviceId = WEMOS_DEVICE_ID) {
  return Boolean(getWemosDeviceSocket(deviceId));
}
async function recordWemosState(deviceId,pin,newState,source,commandId=null,recordDeviceCommand=false,message={}) {
  pin=normalizeWemosPin(pin);
  if (!pin) return;
  const inputPin = `IS${channelNumberFromPin(pin)}`;
  const state = parseWemosState(newState);
  if (!state) return;

  const inputString = String(message.IStr ?? message.sendString ?? "").slice(0, 10000);
  const outputString = String(message.OStr ?? message.receiveString ?? "").slice(0, 10000);
  const connection=await pool.getConnection();

  try {
    await connection.beginTransaction();

    const rows=await connectionQuery(connection,
      `SELECT current_state,last_source FROM wemos_contact_sets WHERE device_id=? AND output_pin=? LIMIT 1`,
      [deviceId,pin]);

    if (!rows.length) {
      await connectionQuery(connection,
        `INSERT INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,active,current_state,last_source,input_string,output_string,sort_order)
         VALUES(?,?,?,?,1,?,?,?,?,?)`,
        [deviceId,`채널 ${channelNumberFromPin(pin).toString().padStart(2,"0")}`,inputPin,pin,state,source,inputString,outputString,channelNumberFromPin(pin)-1]);
    } else {
      await connectionQuery(connection,
        `UPDATE wemos_contact_sets
         SET current_state=?,last_source=?,input_string=?,output_string=?,updated_at=?
         WHERE device_id=? AND output_pin=?`,
        [state,source,inputString,outputString,toKoreaDateTime(new Date()),deviceId,pin]);
    }

    const previousState=rows.length ? String(rows[0].current_state) : null;
    const changed=previousState!==state;
    const effectiveSource=changed ? source : (rows[0]?.last_source || source);
    const now=new Date();
    const databaseTime=toKoreaDateTime(now);
    const effectiveCommandId=changed&&recordDeviceCommand?crypto.randomUUID():commandId;

    // 기존 V0의 current_state/d8_state... 컬럼도 첫 4채널에 대해서는 호환 유지합니다.
    const legacyStateColumn = ({OS1:"current_state",OS2:"d8_state",OS3:"d10_state",OS4:"d11_state"})[pin];
    const legacySourceColumn = ({OS1:"last_source",OS2:"d8_source",OS3:"d10_source",OS4:"d11_source"})[pin];
    if (legacyStateColumn) {
      await connectionQuery(connection,
        `UPDATE wemos_devices SET ${legacyStateColumn}=?,${legacySourceColumn}=?,last_seen_at=?,updated_at=? WHERE device_id=?`,
        [state,effectiveSource,databaseTime,databaseTime,deviceId]);
    } else {
      await connectionQuery(connection,
        `UPDATE wemos_devices SET last_source=?,last_seen_at=?,updated_at=? WHERE device_id=?`,
        [effectiveSource,databaseTime,databaseTime,deviceId]);
    }

    if (changed) {
      await connectionQuery(connection,
        `INSERT INTO wemos_lamp_state_history(device_id,pin_name,previous_state,new_state,source,command_id,changed_at)
         VALUES(?,?,?,?,?,?,?)`,
        [deviceId,pin,previousState,state,effectiveSource,effectiveCommandId,databaseTime]);

      if(recordDeviceCommand) {
        await connectionQuery(connection,
          `INSERT INTO wemos_device_commands(command_id,device_id,pin_name,desired_state,output_string,requester,status,changed_at)
           VALUES(?,?,?,?,?,?, 'ACKED',?)`,
          [effectiveCommandId,deviceId,pin,state,outputString,deviceId,databaseTime]);
      }
    }

    await connection.commit();
    connection.release();

    if(changed) {
      await trimWemosTable("wemos_lamp_state_history",1000,deviceId);
      if(recordDeviceCommand) await trimWemosTable("wemos_device_commands",1000,deviceId);
    }

    const event = {
      type: changed ? "stateChanged" : "state",
      deviceId,
      pin,
      state,
      source: effectiveSource,
      changedAt: now.toISOString(),
      deviceConnected: isWemosConnected(deviceId),
      inputPin,
      IStr: inputString,
      OStr: outputString
    };
    if (changed) {
      event.previousState=previousState;
      event.commandId=effectiveCommandId;
    }
    broadcastWemosBrowsers(event);

    if(changed&&recordDeviceCommand) {
      broadcastWemosBrowsers({
        type:"commandQueued",deviceId,commandId:effectiveCommandId,pin,state,
        outputString,requester:deviceId,status:"ACKED",createdAt:now.toISOString()
      });
    }
  } catch(err) {
    try{await connection.rollback();}catch{}
    connection.release();
    throw err;
  }
}

async function deliverWemosCommand(deviceId,commandId,pin,desiredState,requester,outputString="") {
  const ws = getWemosDeviceSocket(deviceId);
  if (!ws) return false;

  sendWemos(ws,{
    type:"command",
    deviceId,
    commandId,
    pin,
    state:desiredState,
    OStr:String(outputString||""),
    outputString:String(outputString||""),
    requester
  });

  const now=new Date();
  const databaseTime=toKoreaDateTime(now);
  const result = await query(
    `UPDATE wemos_device_commands SET status='DELIVERED',changed_at=? WHERE command_id=? AND status='PENDING' AND device_id=?`,
    [databaseTime,commandId,deviceId]);

  if (result.affectedRows > 0) {
    broadcastWemosBrowsers({
      type:"commandAck",deviceId,commandId,pin,state:desiredState,
      outputString:String(outputString||""),status:"DELIVERED",changedAt:now.toISOString()
    });
    return true;
  }
  return false;
}

async function queueWemosCommand(deviceId,pin,desiredState,requester,outputString="") {
  deviceId=String(deviceId||"").trim();
  pin=normalizeWemosPin(pin);
  const state=parseWemosState(desiredState);
  outputString=String(outputString||"").slice(0,10000);

  if(!deviceId || !WEMOS_OUTPUT_PINS.has(pin) || !state) {
    throw new Error("잘못된 장치, 출력 채널 또는 출력 상태입니다.");
  }

  const deviceRows=await query(`SELECT device_id,active FROM wemos_devices WHERE device_id=? LIMIT 1`,[deviceId]);
  if(!deviceRows.length || Number(deviceRows[0].active)!==1) {
    throw new Error("사용할 수 없는 Wemos 장치입니다.");
  }

  const commandId=crypto.randomUUID(), createdAt=new Date(), databaseTime=toKoreaDateTime(createdAt);
  const connection=await pool.getConnection();
  const cancelledCommands=[];

  try {
    await connection.beginTransaction();
    const offlineAtQueueTime = !isWemosConnected(deviceId);

    if (offlineAtQueueTime) {
      const pendingRows=await connectionQuery(connection,
        `SELECT command_id,pin_name,desired_state,output_string,requester
         FROM wemos_device_commands
         WHERE device_id=? AND pin_name=? AND status='PENDING' FOR UPDATE`,
        [deviceId,pin]);

      for (const row of pendingRows) {
        await connectionQuery(connection,
          `UPDATE wemos_device_commands SET status='CANCELLED',changed_at=?
           WHERE command_id=? AND device_id=? AND status='PENDING'`,
          [databaseTime,row.command_id,deviceId]);
        cancelledCommands.push(row);
      }
    }

    await connectionQuery(connection,
      `INSERT INTO wemos_device_commands
       (command_id,device_id,pin_name,desired_state,output_string,requester,status,changed_at)
       VALUES(?,?,?,?,?,?,'PENDING',?)`,
      [commandId,deviceId,pin,state,outputString,requester,databaseTime]);

    await connection.commit();
    connection.release();
  } catch(err) {
    try { await connection.rollback(); } catch {}
    connection.release();
    throw err;
  }

  for (const row of cancelledCommands) {
    broadcastWemosBrowsers({
      type:"commandAck",deviceId,commandId:row.command_id,pin:row.pin_name,
      state:row.desired_state,outputString:row.output_string||"",
      status:"CANCELLED",changedAt:createdAt.toISOString()
    });
  }

  await trimWemosTable("wemos_device_commands",1000,deviceId);

  broadcastWemosBrowsers({
    type:"commandQueued",deviceId,commandId,pin,state,outputString,
    requester,status:"PENDING",createdAt:createdAt.toISOString()
  });

  await deliverWemosCommand(deviceId,commandId,pin,state,requester,outputString);
  return {commandId,deviceId,pin,state,outputString};
}

async function flushPendingWemosCommand(deviceId) {
  deviceId=String(deviceId||"");
  if(!deviceId || !isWemosConnected(deviceId)) return;
  const connection = await pool.getConnection();
  const latestByPin = new Map(), cancelled=[];
  try {
    await connection.beginTransaction();
    const rows = await connectionQuery(connection,`SELECT id,command_id,pin_name,desired_state,output_string,requester FROM wemos_device_commands WHERE device_id=? AND status='PENDING' ORDER BY id DESC FOR UPDATE`,[deviceId]);
    for (const row of rows) {
      const pin=String(row.pin_name||"").toUpperCase();
      if(!latestByPin.has(pin)){latestByPin.set(pin,row);continue;}
      await connectionQuery(connection,`UPDATE wemos_device_commands SET status='CANCELLED',changed_at=? WHERE command_id=? AND device_id=? AND status='PENDING'`,[toKoreaDateTime(new Date()),row.command_id,deviceId]);
      cancelled.push(row);
    }
    await connection.commit();
  } catch(err){try{await connection.rollback();}catch{}throw err;} finally{connection.release();}
  for(const row of cancelled) broadcastWemosBrowsers({type:"commandAck",deviceId,commandId:row.command_id,pin:row.pin_name,state:row.desired_state,status:"CANCELLED",changedAt:new Date().toISOString()});
  const rows=[...latestByPin.values()].sort((a,b)=>Number(a.id)-Number(b.id));
  if(rows.length){
    const row=rows[0];
    await deliverWemosCommand(deviceId,row.command_id,row.pin_name,row.desired_state,row.requester,row.output_string||'');
  }
}
async function handleWemosDeviceMessage(ws,message) {
  const deviceId=String(ws.deviceId||"");

  if(message.type==="hello") {
    if(String(message.deviceId||"")!==deviceId){ws.close(1008,"Device ID mismatch");return;}

    if(wemosDeviceSockets.has(deviceId)&&wemosDeviceSockets.get(deviceId)!==ws) {
      wemosDeviceSockets.get(deviceId).close(1012,"Device reconnected");
    }

    ws.pin=String(message.pin||"OS1");
    ws.wemosIdentified=true;
    wemosDeviceSockets.set(deviceId,ws);
    if(deviceId===WEMOS_DEVICE_ID) wemosDeviceSocket=ws;

    const inputs=Array.isArray(message.inputs)?message.inputs.map(String):[];
    const outputs=Array.isArray(message.outputs)?message.outputs.map(String):[];

    for (let index=0; index<WEMOS_CHANNEL_COUNT; index++) {
      const inputPin=inputs[index] || `IS${index+1}`;
      const outputPin=outputs[index] || `OS${index+1}`;
      if (!/^IS\\d+$/.test(inputPin) || !/^OS\\d+$/.test(outputPin)) continue;

      await query(
        `INSERT INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,sort_order)
         VALUES(?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           set_name=IF(set_name='',VALUES(set_name),set_name),
           output_pin=VALUES(output_pin),
           sort_order=VALUES(sort_order)`,
        [deviceId,`채널 ${String(index+1).padStart(2,"0")}`,inputPin,outputPin,index]
      );
    }

    const now=toKoreaDateTime(new Date());
    await query(`UPDATE wemos_devices SET last_seen_at=?,updated_at=? WHERE device_id=?`,[now,now,deviceId]);

    broadcastWemosBrowsers({type:"deviceConnection",deviceId,connected:true});
    await flushPendingWemosCommand(deviceId);
    return;
  }

  if(!ws.wemosIdentified){ws.close(1008,"Device hello required");return;}

  if(message.type==="state") {
    const state=parseWemosState(message.state);
    if(!state)return;

    const pin=normalizeWemosPin(message.pin||"");
    if(!pin)return;

    const reportedSource=String(message.source||"");
    if(reportedSource==="CLIENT")return;

    const deviceChange=reportedSource==="WEMOS"||reportedSource===deviceId;
    const source=(deviceChange?deviceId:reportedSource||deviceId).slice(0,100);

    await recordWemosState(
      deviceId,pin,state,source,
      message.commandId?String(message.commandId):null,
      deviceChange,
      message
    );
    return;
  }

  if(message.type==="channelString") {
    const pin=normalizeWemosPin(message.pin||"");
    if(!pin)return;
    const inputString=String(message.IStr ?? message.sendString ?? "").slice(0,10000);
    await query(
      `UPDATE wemos_contact_sets SET input_string=?,updated_at=? WHERE device_id=? AND output_pin=?`,
      [inputString,toKoreaDateTime(new Date()),deviceId,pin]
    );
    broadcastWemosBrowsers({
      type:"channelString",
      deviceId,pin,
      inputPin:`IS${channelNumberFromPin(pin)}`,
      IStr:inputString,
      changedAt:new Date().toISOString()
    });
    return;
  }

  if(message.type==="ack") {
    const commandId=String(message.commandId||"");
    if(!commandId)return;

    const rows=await query(
      `SELECT command_id,pin_name,desired_state,output_string,requester,status
       FROM wemos_device_commands WHERE command_id=? AND device_id=?`,
      [commandId,deviceId]
    );
    if(!rows.length)return;

    const status=message.success===false?"FAILED":"ACKED";
    const state=parseWemosState(message.state);
    const pin=normalizeWemosPin(message.pin||rows[0].pin_name||"");
    const outputString=String(message.OStr ?? message.outputString ?? rows[0].output_string ?? "");

    if(status==="ACKED"&&state===rows[0].desired_state) {
      await recordWemosState(
        deviceId,pin,state,String(rows[0].requester).slice(0,100),
        commandId,false,{OStr:outputString}
      );
    }

    const now=new Date();
    await query(
      `UPDATE wemos_device_commands SET status=?,output_string=?,changed_at=?
       WHERE command_id=? AND device_id=?`,
      [status,outputString,toKoreaDateTime(now),commandId,deviceId]
    );

    broadcastWemosBrowsers({
      type:"commandAck",deviceId,commandId,pin,
      state:state||rows[0].desired_state,
      outputString,status,changedAt:now.toISOString()
    });

    await flushPendingWemosCommand(deviceId);
  }
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
    const deviceRows = await query(`SELECT device_id,active,token_hash FROM wemos_devices WHERE device_id=? LIMIT 1`, [deviceId]);
    if (!deviceRows.length || Number(deviceRows[0].active)!==1) { ws.close(1008, "Unknown or inactive device"); return; }
    const tokenHash = crypto.createHash("sha256").update(providedToken).digest("hex");
    const configuredHash = String(deviceRows[0].token_hash || "");
    if (!configuredHash || tokenHash.length !== configuredHash.length || !crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(configuredHash))) { ws.close(1008, "Device authentication failed"); return; }
    ws.role = "wemos-device";
    ws.deviceId = deviceId;
    ws.isAlive = true;
    ws.on("pong",()=>{ws.isAlive=true;});
    ws.on("message",async data=>{try{await handleWemosDeviceMessage(ws,JSON.parse(data.toString()));}catch(err){console.error(`[WS Wemos ${deviceId}]`,err);}});
    ws.on("close",async()=>{
      if(wemosDeviceSockets.get(deviceId)===ws){
        wemosDeviceSockets.delete(deviceId);
        if(wemosDeviceSocket===ws) wemosDeviceSocket=null;
        try {
          await query(`UPDATE wemos_device_commands SET status='PENDING' WHERE device_id=? AND status='DELIVERED'`,[deviceId]);
        } catch (err) { console.error(`[WS Wemos ${deviceId}] DELIVERED→PENDING 복구 실패:`, err.message); }
        broadcastWemosBrowsers({type:"deviceConnection",deviceId,connected:false});
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
      const message=JSON.parse(data.toString());
      if(message.type==="lamp"){
        if(getPermissionLevel(ws.factoryUser)<2){sendWemos(ws,{type:"lampAck",ok:false,message:"출력 제어는 2등급 이상 회원만 사용할 수 있습니다."});return;}
        const pin=normalizeWemosPin(message.pin||"OS1");
        if(!pin){sendWemos(ws,{type:"lampAck",ok:false,message:"출력 채널은 OS1~OS8 중 하나여야 합니다."});return;}
        const state=parseWemosState(message.state);
        if(!state){sendWemos(ws,{type:"lampAck",ok:false,message:"상태는 ON 또는 OFF여야 합니다."});return;}
        const deviceId=String(message.deviceId||"").trim();
        if(!deviceId){sendWemos(ws,{type:"lampAck",ok:false,message:"장치를 선택해야 합니다."});return;}
        const outputString=String(message.OStr ?? message.outputString ?? "").slice(0,10000);
        const result=await queueWemosCommand(deviceId,pin,state,String(ws.factoryUser.username||"CLIENT").slice(0,100),outputString);
        sendWemos(ws,{type:"lampAck",ok:true,deviceId,deviceConnected:isWemosConnected(deviceId),...result}); return;
      }
      if(message.type==="subscribeWemos"){
        ws.wemosSubscriber=true;
        const requestedDeviceId=String(message.deviceId||"").trim();
        const [state,history,commands]=await Promise.all([getWemosState(requestedDeviceId||null),getWemosHistory(50,requestedDeviceId||null),getWemosCommands(50,requestedDeviceId||null)]);
        sendWemos(ws,{type:"wemosSnapshot",state,history,commands,deviceId:requestedDeviceId||null,...(requestedDeviceId?{deviceConnected:isWemosConnected(requestedDeviceId)}:{})}); return;
      }
      if(["getState","getHistory","getCommands"].includes(message.type)){
        ws.wemosSubscriber=true;
        const requestedDeviceId=String(message.deviceId||"").trim();
        if(message.type==="getState") sendWemos(ws,{type:"initialState",state:await getWemosState(requestedDeviceId||null),...(requestedDeviceId?{deviceConnected:isWemosConnected(requestedDeviceId)}:{})});
        if(message.type==="getHistory") sendWemos(ws,{type:"history",rows:await getWemosHistory(message.limit,requestedDeviceId||null)});
        if(message.type==="getCommands") sendWemos(ws,{type:"commands",rows:await getWemosCommands(message.limit,requestedDeviceId||null)});
      }
    }catch(err){console.error("[WS browser]",err);}
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
    const rows = await query("SELECT status FROM users WHERE id=? LIMIT 1", [user.id]);
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
  try { const rows = await query(`SELECT ${PRODUCT_FIELDS} ${PRODUCT_JOIN} WHERE p.active=1 ORDER BY p.id`); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "products", products: rows })); } catch (err) { console.error(err); }
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

const WEMOS_FIXED_SETS = WEMOS_CHANNELS.map(channel => [channel.inputPin, channel.outputPin]);
function wemosAdminMiddleware(req,res,next) {
  requireLogin(req,res,()=>requireActiveAccount(req,res,()=>requireApproved(req,res,()=>requireAdminLevel(6)(req,res,next))));
}
async function getManagedWemosDevices() {
  const devices=await query(`SELECT device_id,device_name,active,sort_order,last_seen_at,updated_at FROM wemos_devices ORDER BY sort_order,id`);
  const result=[];
  for (const device of devices) {
    const deviceConnected=isWemosConnected(device.device_id);
    try {
      const sets=await query(`SELECT id,set_name,input_pin,output_pin,active,current_state,last_source,input_string,output_string,sort_order FROM wemos_contact_sets WHERE device_id=? ORDER BY sort_order,id`,[device.device_id]);
      result.push({...device,deviceConnected,sets:sets.map((set,index)=>({...set,set_name:set.set_name===set.output_pin?`채널 ${String(index+1).padStart(2,"0")}`:set.set_name,input_signal:set.input_pin,output_signal:set.output_pin,id:String(set.id)}))});
    } catch (err) {
      console.error(`Wemos 접점 세트 조회 오류 (${device.device_id}):`,err);
      result.push({...device,deviceConnected,sets:[]});
    }
  }
  return result;
}
app.get("/api/admin/wemos/devices",wemosAdminMiddleware,async(req,res)=>{
  try{res.json(await getManagedWemosDevices());}catch(err){console.error("Wemos 관리 목록 오류:",err);res.status(500).json({error:"Wemos 장치 목록을 불러오지 못했습니다."});}
});
app.put("/api/admin/wemos/devices/order",wemosAdminMiddleware,async(req,res)=>{
  const deviceIds=Array.isArray(req.body.deviceIds)?req.body.deviceIds.map(String):[];
  if(!deviceIds.length)return res.status(400).json({error:"장치 순서 정보가 없습니다."});
  try{
    for(const [index,deviceId] of deviceIds.entries()) await query(`UPDATE wemos_devices SET sort_order=? WHERE device_id=?`,[index+1,deviceId]);
    res.json({ok:true});
  }catch(err){console.error("Wemos 장치 순서 저장 오류:",err);res.status(500).json({error:"장치 순서를 저장하지 못했습니다."});}
});
app.get("/api/wemos/devices",requireLogin,requireActiveAccount,requireApproved,async(req,res)=>{
  try{
    const devices=(await getManagedWemosDevices()).filter(device=>Number(device.active)===1).map(device=>({...device,sets:device.sets.filter(set=>Number(set.active)===1)}));
    res.json(devices);
  }catch(err){console.error("활성 Wemos 목록 오류:",err);res.status(500).json({error:"활성 Wemos 장치 목록을 불러오지 못했습니다."});}
});
app.post("/api/admin/wemos/devices",wemosAdminMiddleware,async(req,res)=>{
  const deviceId=String(req.body.deviceId||"").trim(),deviceName=String(req.body.deviceName||"").trim();
  if(!/^[A-Za-z0-9_-]{2,100}$/.test(deviceId))return res.status(400).json({error:"장치 ID는 영문, 숫자, 밑줄, 하이픈으로 2~100자 입력하세요."});
  if(!deviceName)return res.status(400).json({error:"장치 이름을 입력하세요."});
  const token=crypto.randomBytes(32).toString("hex"),tokenHash=crypto.createHash("sha256").update(token).digest("hex");
  try{
    const exists=await query(`SELECT id FROM wemos_devices WHERE device_id=?`,[deviceId]);
    if(exists.length)return res.status(409).json({error:"장치 ID가 중복되었습니다."});
    const orderRows=await query(`SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM wemos_devices`);
    await query(`INSERT INTO wemos_devices(device_id,device_name,token_hash,active,sort_order,current_state,last_source) VALUES(?,?,?,?,?,'OFF','BOOT')`,[deviceId,deviceName,tokenHash,1,orderRows[0].next_order]);
    for(const [index,[inputPin,outputPin]] of WEMOS_FIXED_SETS.entries()) await query(`INSERT INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,sort_order) VALUES(?,?,?,?,?)`,[deviceId,outputPin,inputPin,outputPin,index]);
    res.status(201).json({device:{device_id:deviceId,device_name:deviceName,active:1,sets:WEMOS_FIXED_SETS.map(([inputPin,outputPin],index)=>({set_name:`채널 ${String(index+1).padStart(2,"0")}`,input_pin:inputPin,output_pin:outputPin,input_signal:set.input_pin,output_signal:set.output_pin,active:1,sort_order:index}))},deviceToken:token});
  }catch(err){console.error("Wemos 장치 등록 오류:",err);res.status(500).json({error:"Wemos 장치를 등록하지 못했습니다."});}
});
app.put("/api/admin/wemos/devices/:deviceId",wemosAdminMiddleware,async(req,res)=>{
  const name=String(req.body.deviceName||"").trim();
  if(!name)return res.status(400).json({error:"장치 이름을 입력하세요."});
  const active=req.body.active===undefined?null:(req.body.active?1:0);
  const result=await query(`UPDATE wemos_devices SET device_name=?,active=COALESCE(?,active),updated_at=NOW() WHERE device_id=?`,[name,active,req.params.deviceId]);
  if(!result.affectedRows)return res.status(404).json({error:"장치를 찾을 수 없습니다."});
  res.json({ok:true});
});
app.delete("/api/admin/wemos/devices/:deviceId",wemosAdminMiddleware,async(req,res)=>{
  try{
    const existing=await query(`SELECT device_id FROM wemos_devices WHERE device_id=? LIMIT 1`,[req.params.deviceId]);
    if(!existing.length)return res.status(404).json({error:"장치를 찾을 수 없습니다."});
    await query(`DELETE FROM wemos_devices WHERE device_id=?`,[req.params.deviceId]);
    const deletedSocket=wemosDeviceSockets.get(req.params.deviceId); if(deletedSocket){deletedSocket.close(1008,"Device deleted"); wemosDeviceSockets.delete(req.params.deviceId);} if(req.params.deviceId===WEMOS_DEVICE_ID) wemosDeviceSocket=null;
    res.json({ok:true});
  }catch(err){console.error("Wemos 장치 삭제 오류:",err);res.status(500).json({error:"장치를 삭제하지 못했습니다."});}
});
app.put("/api/admin/wemos/devices/:deviceId/contact-sets/:setId",wemosAdminMiddleware,async(req,res)=>{
  const name=String(req.body.setName||"").trim();
  if(!name)return res.status(400).json({error:"접점 세트 이름을 입력하세요."});
  const active=req.body.active===undefined?null:(req.body.active?1:0);
  const result=await query(`UPDATE wemos_contact_sets SET set_name=?,active=COALESCE(?,active),updated_at=NOW() WHERE id=? AND device_id=?`,[name,active,req.params.setId,req.params.deviceId]);
  if(!result.affectedRows)return res.status(404).json({error:"접점 세트를 찾을 수 없습니다."});
  res.json({ok:true});
});

// ---------------------------------------------------------
// DB 마이그레이션 + 최초 마스터 생성
// ---------------------------------------------------------
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, name VARCHAR(100) NOT NULL, region VARCHAR(100) NOT NULL DEFAULT '', company VARCHAR(150) NOT NULL DEFAULT '', position VARCHAR(100) NOT NULL DEFAULT '', phone VARCHAR(20) NOT NULL DEFAULT '', email VARCHAR(254) NOT NULL DEFAULT '', role VARCHAR(20) NOT NULL DEFAULT 'USER', permission_level TINYINT UNSIGNED NOT NULL DEFAULT 1, admin_memo TEXT NULL, user_request_at DATETIME NULL, status VARCHAR(30) NOT NULL DEFAULT 'PENDING', approved_at DATETIME NULL, approved_by INT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const columns = [
    ["region", "VARCHAR(100) NOT NULL DEFAULT ''"], ["company", "VARCHAR(150) NOT NULL DEFAULT ''"], ["position", "VARCHAR(100) NOT NULL DEFAULT ''"], ["phone", "VARCHAR(20) NOT NULL DEFAULT ''"], ["email", "VARCHAR(254) NOT NULL DEFAULT ''"], ["role", "VARCHAR(20) NOT NULL DEFAULT 'USER'"], ["permission_level", "TINYINT UNSIGNED NOT NULL DEFAULT 1"], ["admin_memo", "TEXT NULL"], ["user_request_at", "DATETIME NULL"], ["status", "VARCHAR(20) NOT NULL DEFAULT 'PENDING'"], ["approved_at", "DATETIME NULL"], ["approved_by", "INT NULL"], ["updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"]
  ];
  for (const [name, type] of columns) {
    try { await query(`ALTER TABLE users ADD COLUMN ${name} ${type}`); } catch (err) { if (!/duplicate column|already exists/i.test(String(err.message))) throw err; }
  }
  try { await query("ALTER TABLE users MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'PENDING'"); } catch (err) { console.error("회원 상태 컬럼 마이그레이션 실패:", err.message); }
  try { await query("CREATE UNIQUE INDEX uq_users_email ON users(email)"); } catch (err) { /* 기존 중복 이메일이 있다면 운영자가 정리한 후 schema.sql로 적용 */ }
  try { await query("CREATE INDEX idx_users_status ON users(status)"); } catch { }
  try { await query("CREATE INDEX idx_users_permission_level ON users(permission_level)"); } catch { }

  await query(`CREATE TABLE IF NOT EXISTS user_settings (
    user_id INT NOT NULL PRIMARY KEY,
    sound_type VARCHAR(20) NOT NULL DEFAULT 'bell',
    sound_volume TINYINT UNSIGNED NOT NULL DEFAULT 50,
    sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
    theme VARCHAR(10) NOT NULL DEFAULT 'light',
    display_mode VARCHAR(10) NOT NULL DEFAULT 'normal',
    show_summary TINYINT(1) NOT NULL DEFAULT 1,
    show_target TINYINT(1) NOT NULL DEFAULT 1,
    show_rate TINYINT(1) NOT NULL DEFAULT 1,
    date_format VARCHAR(10) NOT NULL DEFAULT 'ko-KR',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  const userSettingsColumns = [
    ["show_updated_at", "TINYINT(1) NOT NULL DEFAULT 1"], ["show_updated_by", "TINYINT(1) NOT NULL DEFAULT 1"]
  ];
  for (const [name, type] of userSettingsColumns) {
    try { await query(`ALTER TABLE user_settings ADD COLUMN ${name} ${type}`); } catch (err) { if (!/duplicate column|already exists/i.test(String(err.message))) throw err; }
  }

  try { await query("ALTER TABLE products ADD COLUMN updated_by INT NULL"); } catch (err) { if (!/duplicate column|already exists/i.test(String(err.message))) throw err; }
  await ensureWemosSchema();
  try { await query("ALTER TABLE products ADD CONSTRAINT fk_products_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL"); } catch (err) { /* 이미 존재하는 제약조건입니다 */ }

  // 기존 V1.2에서 생성된 회원은 승인 상태로 간주하지 않고 PENDING으로 둡니다.
  await query("UPDATE users SET status='PENDING' WHERE status IS NULL OR status=''");
  await query("UPDATE users SET permission_level=10 WHERE role='MASTER' OR permission_level IS NULL OR permission_level<1");

  const masterUsername = String(process.env.MASTER_USERNAME || "").trim();
  const masterPassword = INITIAL_MASTER_PASSWORD;
  const masterName = String(process.env.MASTER_NAME || "").trim();
  const masterRegion = String(process.env.MASTER_REGION || "").trim();
  const masterCompany = String(process.env.MASTER_COMPANY || "").trim();
  const masterPosition = String(process.env.MASTER_POSITION || "").trim();
  const masterPhone = normalizePhone(process.env.MASTER_PHONE || "") || "";
  const masterEmail = normalizeEmail(process.env.MASTER_EMAIL || "") || "";

  if (masterUsername && masterPassword) {
    const rows = await query("SELECT id,password_hash FROM users WHERE username=? LIMIT 1", [masterUsername]);
    if (!rows.length) {
      await query(`INSERT INTO users (username,password_hash,name,region,company,position,phone,email,role,permission_level,status,approved_at) VALUES (?,?,?,?,?,?,?,?, 'MASTER',10,'APPROVED',NOW())`, [masterUsername, hashPassword(masterPassword), masterName, masterRegion, masterCompany, masterPosition, masterPhone, masterEmail]);
      console.log(`최초 MASTER 계정 생성: ${masterUsername}`);
    } else {
      const passwordHash = rows[0].password_hash === "INITIAL_MASTER_NO_PASSWORD" ? hashPassword(masterPassword) : rows[0].password_hash;
      await query("UPDATE users SET role='MASTER',permission_level=10,status='APPROVED',approved_at=COALESCE(approved_at,NOW()),password_hash=? WHERE username=?", [passwordHash, masterUsername]);
    }
  } else {
    console.log("MASTER_USERNAME과 MASTER_PASSWORD를 .env에 설정하면 최초 MASTER 계정이 자동 생성됩니다.");
  }
}

async function start() {
  try {
    await ensureSchema();
    await query("SELECT 1");
    console.log(`${DB_CLIENT} connection OK (database: ${dbConfig.database})`);
  } catch (err) {
    console.error(`DB 초기화 실패 (database: ${dbConfig.database}):`, err.message);
    process.exitCode = 1;
    return;
  }
  server.listen(PORT, "0.0.0.0", () => console.log(`Factory Monitor Server started on port ${PORT}`));
}
start();
process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
