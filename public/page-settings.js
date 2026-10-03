const PAGE_TITLE = "KIMS SMART FACTORY";
document.title = PAGE_TITLE;

const VIEW_SETTINGS_KEY = "factory-view-settings";

function applyViewSettings(settings) {
  const theme = settings.theme === "dark" ? "dark" : "light";
  const displayMode = ["compact", "large"].includes(settings.display_mode)
    ? settings.display_mode
    : "normal";

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.displayMode = displayMode;
  document.documentElement.dataset.showWemosIstr = String(settings.show_wemos_istr !== false);
  document.documentElement.dataset.showWemosOstr = String(settings.show_wemos_ostr !== false);
  document.documentElement.dataset.showWemosOstrInputs = String(settings.show_wemos_ostr_inputs !== false);

  try {
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ theme, display_mode: displayMode }));
  } catch { /* 저장소를 사용할 수 없어도 현재 화면에는 설정을 적용합니다. */ }
}

window.applyFactoryViewSettings = applyViewSettings;

function applyPageUser(user, permissionLevel = 1) {
  const menus = document.querySelectorAll("header .header-actions, header .wemos-page-links, .auth-card .auth-links");
  for (const menu of menus) {
    menu.querySelector("[data-page-user-info]")?.remove();
    const legacy = menu.querySelector("#userInfo");
    if (legacy && user) {
      legacy.hidden = true;
      legacy.dataset.pageUserLegacy = "";
    }
  }
  let bar = document.body.querySelector("[data-page-user-bar]");
  if (!user) {
    bar?.remove();
    document.body.classList.remove("has-page-user");
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "page-user-bar";
    bar.dataset.pageUserBar = "";
    const label = document.createElement("span");
    label.className = "page-user-info";
    label.dataset.pageUserInfo = "";
    bar.append(label);
    const header = document.querySelector("body:not(.auth-body) > header, body.wemos-page .wemos-header");
    if (header) header.append(bar);
    else document.body.prepend(bar);
  }
  document.body.classList.add("has-page-user");
  bar.querySelector("[data-page-user-info]").textContent = `Log in : ${user.username || "-"} (${user.name || "-"}, ${permissionLevel}등급)`;
}

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
  "/wemos-admin.html": (access) => access.active && access.approved && access.permissionLevel >= 8
};

const protectedLinks = [...document.querySelectorAll("a[href]")].flatMap(link => {
  const url = new URL(link.href, window.location.href);
  const canAccess = protectedPageAccess[url.pathname];
  if (!canAccess || url.origin !== window.location.origin) return [];
  link.classList.add("page-access-hidden");
  return [{ link, canAccess }];
});

function refreshPageUser() {
  return fetch("/api/me", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .catch(() => null)
    .then(data => {
      if (!data || !data.user) {
        applyPageUser(null);
        for (const { link } of protectedLinks) link.classList.add("page-access-hidden");
        return;
      }
      const user = data.user;
      const permissionLevel = Number(user.permissionLevel || user.permission_level || (user.role === "MASTER" ? 10 : 1));
      applyPageUser(user, permissionLevel);
      const access = {
        permissionLevel,
        active: user.status !== "SUSPENDED",
        approved: user.status === "APPROVED" || permissionLevel >= 8
      };
      for (const { link, canAccess } of protectedLinks) {
        link.classList.toggle("page-access-hidden", !canAccess(access));
      }
    })
    .catch(() => {});
}

refreshPageUser();
window.addEventListener("focus", refreshPageUser);
window.addEventListener("pageshow", event => {
  if (event.persisted) refreshPageUser();
});

try {
  const cachedSettings = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || "null");
  if (cachedSettings) applyViewSettings(cachedSettings);
} catch { /* 손상된 캐시는 무시하고 서버 설정을 불러옵니다. */ }

function refreshViewSettings() {
  return fetch("/api/me/settings", { cache: "no-store" })
    .then(res => res.ok ? res.json() : null)
    .then(settings => { if (settings) applyViewSettings(settings); })
    .catch(() => {});
}

refreshViewSettings();
if (["/wemos.html", "/wemos-view.html"].includes(location.pathname)) {
  window.addEventListener("focus", refreshViewSettings);
  window.addEventListener("pageshow", event => {
    if (event.persisted) refreshViewSettings();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") refreshViewSettings();
  });
}