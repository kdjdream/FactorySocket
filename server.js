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

app.use(express.json({ limit: "100kb" }));

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
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
  if (passwordRequired && (password.length < 8 || password.length > 100)) return { error: "비밀번호는 8~100자로 입력하세요." };
  if (!passwordRequired && password && (password.length < 8 || password.length > 100)) return { error: "새 비밀번호는 8~100자로 입력하세요." };

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

function requireAdminLevel(minimumLevel = 8) {
  return (req, res, next) => {
    if (!req.user || getPermissionLevel(req.user) < minimumLevel) return res.status(403).json({ error: `${minimumLevel}등급 이상 관리자 권한이 필요합니다.`, code: "ADMIN_REQUIRED" });
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
app.get("/", requireLogin, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/index.html", requireLogin, requireApproved, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/control.html", requireLogin, requireApproved, requireAdminLevel(2), (req, res) => res.sendFile(path.join(__dirname, "public", "control.html")));
app.get("/product-admin.html", requireLogin, requireApproved, requireAdminLevel(6), (req, res) => res.sendFile(path.join(__dirname, "public", "product-admin.html")));
app.get("/admin.html", requireLogin, requireAdminLevel(8), (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/profile.html", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));
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
    if (rows[0].status === "SUSPENDED") return res.status(403).json({ error: "사용이 정지된 계정입니다. 관리자에게 문의하세요." });

    const token = createSession(rows[0]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: rows[0].id, username: rows[0].username, name: rows[0].name, role: rows[0].role, permissionLevel: Number(rows[0].permission_level || (rows[0].role === "MASTER" ? 10 : 1)), status: rows[0].status }, redirect: ["PENDING", "REJECTED", "WITHDRAWAL_PENDING"].includes(rows[0].status) ? "/profile.html?pending=1" : "/" });
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
    res.json({ ok: true, message: "회원이 삭제되었습니다." });
  } catch (err) { console.error(err); res.status(500).json({ error: "회원 삭제 오류" }); }
});

// ---------------------------------------------------------
// 생산현황 API
// ---------------------------------------------------------
app.get("/api/health", async (req, res) => { try { await query("SELECT 1 AS ok"); res.json({ ok: true, database: "connected" }); } catch { res.status(500).json({ ok: false, database: "error" }); } });

app.get("/api/products", requireLogin, requireApproved, async (req, res) => { try { res.json(await query(`SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE active=1 ORDER BY id`)); } catch (err) { console.error(err); res.status(500).json({ error: "DB 조회 오류" }); } });

app.put("/api/products/:id/quantity", requireLogin, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), quantity = Number(req.body.quantity);
  if (!Number.isInteger(id) || !Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ error: "수량이 올바르지 않습니다." });
  try { const result = await query(`UPDATE products SET quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`, [quantity, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE id=?`, [id]); broadcast({ type: "quantityUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "DB 업데이트 오류" }); }
});

app.put("/api/products/:id/status", requireLogin, requireApproved, requireAdminLevel(2), async (req, res) => {
  const id = Number(req.params.id), status = String(req.body.status || "").trim();
  if (!["대기", "생산중", "수리중", "완료", "정지"].includes(status)) return res.status(400).json({ error: "상태값이 올바르지 않습니다." });
  try { const result = await query(`UPDATE products SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1`, [status, id]); if (result.affectedRows === 0) return res.status(404).json({ error: "제품을 찾을 수 없습니다." }); const rows = await query(`SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE id=?`, [id]); broadcast({ type: "productUpdated", product: rows[0] }); res.json(rows[0]); } catch (err) { console.error(err); res.status(500).json({ error: "상태 업데이트 오류" }); }
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

app.post("/api/admin/products", requireLogin, requireApproved, requireAdminLevel(6), async (req, res) => {
  const data = validateProduct(req.body);
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const exists = await query("SELECT id FROM products WHERE product_code=? LIMIT 1", [data.productCode]);
    if (exists.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("INSERT INTO products (product_code,product_name,quantity,target_quantity,status) VALUES (?,?,?,?,?)", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status]);
    const rows = await query("SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE id=?", [result.insertId]);
    broadcast({ type: "productsChanged", products: await query("SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE active=1 ORDER BY id") });
    res.status(201).json(rows[0]);
  } catch (err) { console.error("제품 추가 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 추가 오류" }); }
});

app.put("/api/admin/products/:id", requireLogin, requireApproved, requireAdminLevel(6), async (req, res) => {
  const id = Number(req.params.id);
  const data = validateProduct(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "잘못된 제품 ID입니다." });
  if (data.error) return res.status(400).json({ error: data.error });
  try {
    const duplicate = await query("SELECT id FROM products WHERE product_code=? AND id<>? LIMIT 1", [data.productCode, id]);
    if (duplicate.length) return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." });
    const result = await query("UPDATE products SET product_code=?,product_name=?,quantity=?,target_quantity=?,status=? WHERE id=?", [data.productCode, data.productName, data.quantity, data.targetQuantity, data.status, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "제품을 찾을 수 없습니다." });
    const rows = await query("SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE id=?", [id]);
    broadcast({ type: "productsChanged", products: await query("SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE active=1 ORDER BY id") });
    res.json(rows[0]);
  } catch (err) { console.error("제품 수정 오류:", err); if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 사용 중인 제품코드입니다." }); res.status(500).json({ error: "제품 수정 오류" }); }
});

app.delete("/api/admin/products/:id", requireLogin, requireApproved, requireAdminLevel(6), async (req, res) => {
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
// WebSocket - 승인된 회원만
// ---------------------------------------------------------
function getUserFromRequest(req) { const token = getCookie(req, SESSION_COOKIE); if (!token) return null; const session = sessions.get(token); if (!session) return null; if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; } session.expiresAt = Date.now() + SESSION_MAX_AGE; return session.user; }
wss.on("connection", async (ws, req) => {
  const user = getUserFromRequest(req);
  if (!user || (user.status !== "APPROVED" && getPermissionLevel(user) < 8)) { ws.close(1008, "승인된 회원만 이용할 수 있습니다."); return; }
  clients.add(ws);
  try { const rows = await query(`SELECT id,product_code,product_name,quantity,target_quantity,status,updated_at FROM products WHERE active=1 ORDER BY id`); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "products", products: rows })); } catch (err) { console.error(err); }
  ws.on("close", () => clients.delete(ws)); ws.on("error", () => clients.delete(ws));
});
function broadcast(message) { const data = JSON.stringify(message); for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data); }
setInterval(() => { const now = Date.now(); for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token); }, 10 * 60 * 1000);

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

  // 기존 V1.2에서 생성된 회원은 승인 상태로 간주하지 않고 PENDING으로 둡니다.
  await query("UPDATE users SET status='PENDING' WHERE status IS NULL OR status=''");
  await query("UPDATE users SET permission_level=10 WHERE role='MASTER' OR permission_level IS NULL OR permission_level<1");

  const masterUsername = String(process.env.MASTER_USERNAME || "").trim();
  const masterPassword = String(process.env.MASTER_PASSWORD || "");
  const masterName = String(process.env.MASTER_NAME || "마스터 관리자").trim();
  const masterRegion = String(process.env.MASTER_REGION || "대한민국").trim();
  const masterCompany = String(process.env.MASTER_COMPANY || "관리자").trim();
  const masterPosition = String(process.env.MASTER_POSITION || "마스터 관리자").trim();
  const masterPhone = normalizePhone(process.env.MASTER_PHONE || "");
  const masterEmail = normalizeEmail(process.env.MASTER_EMAIL || "");

  if (masterUsername && masterPassword && masterPhone && masterEmail) {
    const rows = await query("SELECT id FROM users WHERE username=? LIMIT 1", [masterUsername]);
    if (!rows.length) {
      await query(`INSERT INTO users (username,password_hash,name,region,company,position,phone,email,role,permission_level,status,approved_at) VALUES (?,?,?,?,?,?,?,?, 'MASTER',10,'APPROVED',NOW())`, [masterUsername, hashPassword(masterPassword), masterName, masterRegion, masterCompany, masterPosition, masterPhone, masterEmail]);
      console.log(`최초 MASTER 계정 생성: ${masterUsername}`);
    } else {
      await query("UPDATE users SET role='MASTER',permission_level=10,status='APPROVED',approved_at=COALESCE(approved_at,NOW()) WHERE username=?", [masterUsername]);
    }
  } else {
    console.log("MASTER_USERNAME / MASTER_PASSWORD / MASTER_PHONE / MASTER_EMAIL을 .env에 설정하면 최초 마스터 계정이 자동 생성됩니다.");
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
