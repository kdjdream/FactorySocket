const VIEW_SETTINGS_KEY = "factory-view-settings";

function applyViewSettings(settings) {
  const theme = settings.theme === "dark" ? "dark" : "light";
  const displayMode = ["compact", "large"].includes(settings.display_mode)
    ? settings.display_mode
    : "normal";

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.displayMode = displayMode;

  try {
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ theme, display_mode: displayMode }));
  } catch { /* 저장소를 사용할 수 없어도 현재 화면에는 설정을 적용합니다. */ }
}

window.applyFactoryViewSettings = applyViewSettings;

const protectedPageAccess = {
  "/": (access) => access.active && access.approved,
  "/index.html": (access) => access.active && access.approved,
  "/control.html": (access) => access.active && access.approved && access.permissionLevel >= 2,
  "/product-admin.html": (access) => access.active && access.approved && access.permissionLevel >= 6,
  "/admin.html": (access) => access.active && access.permissionLevel >= 8,
  "/profile.html": () => true,
  "/settings.html": (access) => access.active,
  "/wemos.html": (access) => access.active && access.approved && access.permissionLevel >= 2,
  "/wemos-view.html": (access) => access.active && access.approved,
  "/wemos-admin.html": (access) => access.active && access.approved && access.permissionLevel >= 6
};

const protectedLinks = [...document.querySelectorAll("a[href]")].flatMap(link => {
  const url = new URL(link.href, window.location.href);
  const canAccess = protectedPageAccess[url.pathname];
  if (!canAccess || url.origin !== window.location.origin) return [];
  link.classList.add("page-access-hidden");
  return [{ link, canAccess }];
});

fetch("/api/me")
  .then(response => response.ok ? response.json() : null)
  .then(data => {
    if (!data || !data.user) return;
    const user = data.user;
    const permissionLevel = Number(user.permissionLevel || user.permission_level || (user.role === "MASTER" ? 10 : 1));
    const access = {
      permissionLevel,
      active: user.status !== "SUSPENDED",
      approved: user.status === "APPROVED" || permissionLevel >= 8
    };
    for (const { link, canAccess } of protectedLinks) {
      if (canAccess(access)) link.classList.remove("page-access-hidden");
    }
  })
  .catch(() => {});

try {
  const cachedSettings = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || "null");
  if (cachedSettings) applyViewSettings(cachedSettings);
} catch { /* 손상된 캐시는 무시하고 서버 설정을 불러옵니다. */ }

fetch("/api/me/settings")
  .then(res => res.ok ? res.json() : null)
  .then(settings => { if (settings) applyViewSettings(settings); })
  .catch(() => {});