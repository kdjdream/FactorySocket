const crypto = require("node:crypto");
const MAX_PERMISSION_LEVEL = 25;
const MAX_SITE_PERMISSION_LEVEL = 20;
const MIN_PROGRAMMER_LEVEL = 21;
const SYSTEM_MASTER_HIERARCHY_LEVEL = 26;
const APPROVAL_OVERRIDE_LEVEL = 16;
const FEATURES = [
  { key: "production_view", label: "생산 현황", group: "생산", level: 1, paths: ["/", "/product-view.html"] },
  { key: "production_input", label: "생산 입력", group: "생산", level: 12, paths: ["/product-control.html"] },
  { key: "production_report", label: "생산 리포트", group: "생산", level: 12, paths: ["/product-report.html"] },
  { key: "product_admin", label: "제품 관리", group: "생산", level: 14, paths: ["/product-admin.html"] },
  { key: "product_channel_link", label: "제품-채널 연결", group: "생산", level: 16, paths: ["/product-channel-link.html"] },
  { key: "device_view", label: "디바이스 보기", group: "디바이스", level: 1, paths: ["/device-view.html"] },
  { key: "device_control", label: "디바이스 제어", group: "디바이스", level: 8, paths: ["/device-control.html"] },
  { key: "User_customization", label: "사용자 디자인", group: "디바이스", level: 1, paths: ["/user_customization.html"] },
  { key: "device_schedule", label: "디바이스 예약", group: "디바이스", level: 14, paths: ["/device_schedule.html"] },
  { key: "device_admin", label: "디바이스 관리", group: "디바이스", level: 16, paths: ["/device-admin.html"] },
  { key: "device_report", label: "디바이스 리포트", group: "디바이스", level: 16, paths: ["/device-report.html"] },
  { key: "user_profile", label: "회원 정보", group: "회원", level: 1, locked: true, paths: ["/user-profile.html"] },
  { key: "user_settings", label: "사용자 설정", group: "회원", level: 1, paths: ["/user-setting.html"] },
  { key: "level_permissions", label: "레벨 권한", group: "회원", level: 20, paths: ["/user-level.html"] },
  { key: "user_admin", label: "회원 관리", group: "회원", level: 16, paths: ["/user-admin.html"] },
  { key: "company_admin", label: "회사 등록", group: "회원", level: 16, paths: ["/user-company.html"] }
];

function defaultPermissionPolicy() {
  return Object.fromEntries(FEATURES.map(feature => [feature.key, feature.level]));
}

function validatePermissionPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== FEATURES.length) return { error: "모든 업무의 최소 레벨을 지정하세요." };
  if (Object.hasOwn(value, "device_simple") && !Object.hasOwn(value, "User_customization")) {
    const { device_simple, ...levels } = value;
    value = { ...levels, User_customization: device_simple };
  }
  const levels = {};
  for (const feature of FEATURES) {
    const level = value[feature.key];
    if (!Number.isInteger(level) || level < 1 || level > MAX_SITE_PERMISSION_LEVEL || (feature.locked && level !== feature.level)) {
      return { error: `${feature.label}의 레벨이 올바르지 않습니다.` };
    }
    levels[feature.key] = level;
  }
  return { levels };
}

function permissionSiteName(feature) {
  return feature.paths.find(pathname => pathname !== "/") || feature.paths[0];
}

function permissionPolicySites(levels = defaultPermissionPolicy(), updatedBy = null, updatedAt = null) {
  return FEATURES.map((feature, index) => ({
    poicy_id: index + 1, site_name: permissionSiteName(feature), default_leble: feature.level, permisson_lebel: levels[feature.key],
    updated_by: updatedBy, updated_at: updatedAt
  }));
}

function policyFromSiteRows(rows) {
  if (!Array.isArray(rows) || rows.length !== FEATURES.length) return { error: "전체 사이트의 권한 행이 필요합니다." };
  const sites = new Map();
  const ids = new Set();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.poicy_id) || row.poicy_id < 1 || ids.has(row.poicy_id) || sites.has(row.site_name)) return { error: "사이트 권한 ID 또는 이름이 중복되거나 올바르지 않습니다." };
    if (Object.hasOwn(row, "default_leble") && (!Number.isInteger(row.default_leble) || row.default_leble < 1 || row.default_leble > MAX_SITE_PERMISSION_LEVEL)) return { error: "사이트 기본 레벨은 1~20 사이의 정수여야 합니다." };
    sites.set(row.site_name, row.permisson_lebel);
    ids.add(row.poicy_id);
  }
  return validatePermissionPolicy(Object.fromEntries(FEATURES.map(feature => [feature.key, sites.get(permissionSiteName(feature))])));
}

function sitePolicyRevision(rows) {
  const values = [...rows].sort((first, second) => first.site_name.localeCompare(second.site_name))
    .map(row => [row.poicy_id, row.site_name, row.default_leble ?? null, row.permisson_lebel, row.updated_by ?? null, row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? "")]);
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function permissionLevel(user) {
  return Number(user?.permissionLevel || user?.permission_level || (user?.role === "MASTER" ? MAX_PERMISSION_LEVEL : 1));
}

function userManagementLevel(user) {
  return user?.role === "MASTER" ? SYSTEM_MASTER_HIERARCHY_LEVEL : permissionLevel(user);
}

function canUseFeature(user, key, levels = defaultPermissionPolicy()) {
  if (!user || !FEATURES.some(feature => feature.key === key)) return false;
  if (key === "user_profile") return true;
  if (user.status === "SUSPENDED") return false;
  const level = permissionLevel(user);
  if (!Number.isInteger(level) || level < 1 || level > MAX_PERMISSION_LEVEL) return false;
  if (key !== "user_settings" && user.status !== "APPROVED" && level < APPROVAL_OVERRIDE_LEVEL) return false;
  if (level >= MIN_PROGRAMMER_LEVEL) return true;
  return level >= levels[key];
}

function userPermissionSnapshot(user, levels) {
  const permissions = Object.fromEntries(FEATURES.map(feature => [feature.key, canUseFeature(user, feature.key, levels)]));
  const access = Object.fromEntries(FEATURES.flatMap(feature => feature.paths.map(path => [path, permissions[feature.key]])));
  return { permissions, access, permissionLevels: levels, maxPermissionLevel: MAX_PERMISSION_LEVEL };
}

function requestPermission(method, pathname, query = {}) {
  if (typeof pathname !== "string") return null;
  if (pathname === "/device-simple.html") return "User_customization";
  const page = FEATURES.find(feature => feature.paths.includes(pathname));
  if (page) return page.key;
  if (pathname === "/api/admin/level-permissions") return "level_permissions";
  if (pathname.startsWith("/api/admin/companies")) return "company_admin";
  if (pathname.startsWith("/api/admin/users")) return "user_admin";
  if (pathname.startsWith("/api/me/User_customization") || pathname.startsWith("/api/me/simple-channels")) return "User_customization";
  if (pathname.startsWith("/api/me/settings")) return "user_settings";
  if (pathname === "/api/me/product-selection/view") return "production_view";
  if (pathname === "/api/me/product-selection/control") return "production_input";
  if (pathname.startsWith("/api/admin/products/report")) return "production_report";
  if (pathname.startsWith("/api/admin/products")) return "product_admin";
  if (/^\/api\/products\/[^/]+\/(quantity|status)$/.test(pathname)) return "production_input";
  if (pathname.startsWith("/api/admin/product-channel")) return "product_channel_link";
  if (pathname.startsWith("/api/admin/device/report")) return "device_report";
  if (pathname.startsWith("/api/admin/device/")) return "device_admin";
  if (pathname.startsWith("/api/device/schedules")) {
    if (method === "GET" && query.next_only === "1" && query.device_id && query.output_signal && query.is_enabled === "1" && Number(query.limit) === 1) return ["device_view", "device_control", "User_customization", "device_schedule"];
    return "device_schedule";
  }
  if (pathname === "/api/products") return ["production_view", "production_input", "production_report", "product_admin", "product_channel_link"];
  if (pathname.startsWith("/api/device/")) return ["device_view", "device_control", "User_customization", "device_schedule", "device_admin", "device_report", "product_channel_link"];
  return null;
}

function legacyPermissionLevel(level) {
  return level === 1 ? 1 : Math.min(MAX_SITE_PERMISSION_LEVEL, level * 2);
}

module.exports = { MAX_PERMISSION_LEVEL, MAX_SITE_PERMISSION_LEVEL, MIN_PROGRAMMER_LEVEL, SYSTEM_MASTER_HIERARCHY_LEVEL, APPROVAL_OVERRIDE_LEVEL, FEATURES, defaultPermissionPolicy, validatePermissionPolicy, permissionLevel, userManagementLevel, canUseFeature, userPermissionSnapshot, requestPermission, legacyPermissionLevel, permissionSiteName, permissionPolicySites, policyFromSiteRows, sitePolicyRevision };