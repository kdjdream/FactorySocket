// 모든 페이지의 탭 제목·사용자 표시·메뉴 권한·개인 화면 설정을 공통 처리합니다.
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
  document.documentElement.dataset.showDeviceIstr = String(settings.show_device_istr !== false);
  document.documentElement.dataset.showDeviceOstr = String(settings.show_device_ostr !== false);
  document.documentElement.dataset.showDeviceOstrInputs = String(settings.show_device_ostr_inputs !== false);

  // 첫 화면의 깜빡임을 줄이기 위해 테마·보기 모드만 캐시합니다. 회원별 문자열 표시 값은 캐시하지 않습니다.
  try {
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ theme, display_mode: displayMode }));
  } catch { /* 저장소를 사용할 수 없어도 현재 화면에는 설정을 적용합니다. */ }
}

window.applyFactoryViewSettings = applyViewSettings;

function applyPageUser(user, permissionLevel = 1) {
  const menus = document.querySelectorAll("header .header-actions, header .device-page-links, .auth-card .auth-links");
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
    const header = document.querySelector("body > header, body.device-page .device-header");
    if (header) header.append(bar);
    else document.body.prepend(bar);
  }
  document.body.classList.add("has-page-user");
  bar.querySelector("[data-page-user-info]").textContent = `Log in : ${user.username || "-"} (${user.name || "-"}, ${permissionLevel}등급)`;
  updateServerConnectionIndicator();
}

let serverConnectionState = "connecting";

function hasServerConnectionIndicator() {
  return !["/user-login.html", "/user-register.html", "/login", "/register", "/login.html", "/register.html"].includes(location.pathname);
}

function usesRealtimeSocket() {
  return ["/", "/product-view.html", "/product-control.html", "/device-view.html", "/device-control.html", "/user_customization.html"].includes(location.pathname);
}

function updateServerConnectionIndicator(state = serverConnectionState) {
  serverConnectionState = state;
  const bar = document.body.querySelector("[data-page-user-bar]");
  if (!bar) return;
  if (!hasServerConnectionIndicator()) {
    bar.querySelector("[data-server-connection]")?.remove();
    return;
  }
  let indicator = bar.querySelector("[data-server-connection]");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "page-server-connection";
    indicator.dataset.serverConnection = "";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    bar.append(indicator);
  }
  indicator.dataset.state = state;
  indicator.dataset.connectionType = usesRealtimeSocket() ? "socket" : "server";
  indicator.textContent = { online: "ONLINE", offline: "OFFLINE", connecting: "CONNECTING" }[state];
  indicator.title = usesRealtimeSocket()
    ? { online: "실시간 소켓 연결됨", offline: "실시간 소켓 연결 끊김", connecting: "실시간 소켓 연결 중" }[state]
    : { online: "서버 응답 정상", offline: "서버 연결 끊김 또는 응답 시간 초과", connecting: "서버 연결 확인 중" }[state];
}

// 이 표는 메뉴 표시용입니다. 실제 페이지/API 접근 권한은 서버에서 다시 검사합니다.
const protectedPageAccess = Object.fromEntries([
  "/", "/product-view.html", "/product-control.html", "/product-channel-link.html", "/product-admin.html", "/product-report.html",
  "/user-admin.html", "/user-profile.html", "/user-setting.html", "/user-level.html", "/user-company.html",
  "/device-control.html", "/user_customization.html", "/device-view.html", "/device_schedule.html", "/device-report.html", "/device-admin.html"
].map(pathname => [pathname, access => access.pages?.[pathname] === true]));

const protectedLinks = [...document.querySelectorAll("a[href]")].flatMap(link => {
  if (link.getAttribute("href").startsWith("#")) return [];
  const url = new URL(link.href, window.location.href);
  const canAccess = protectedPageAccess[url.pathname];
  if (!canAccess || url.origin !== window.location.origin) return [];
  link.classList.add("page-access-hidden");
  return [{ link, canAccess }];
});

function initializeFactoryNavigation() {
  if (!hasServerConnectionIndicator()) return;
  const menu = document.querySelector("header .header-actions, header .device-page-links");
  if (!menu) return;
  const legacy = document.createElement("div");
  legacy.className = "factory-navigation-legacy";
  const logout = menu.querySelector(".logout-button");
  legacy.append(...menu.childNodes);
  menu.append(legacy);
  menu.classList.add("factory-navigation");
  menu.setAttribute("aria-label", "주 메뉴");
  menu.closest("header").classList.add("factory-navigation-header");

  const groups = [
    ["생산", [["생산 현황", "/"], ["생산 입력", "/product-control.html"], ["생산 리포트", "/product-report.html"], ["제품 관리", "/product-admin.html"], ["제품-채널 연결", "/product-channel-link.html"]]],
    ["디바이스", [["디바이스 보기", "/device-view.html"], ["디바이스 제어", "/device-control.html"], ["사용자 디자인", "/user_customization.html"], ["디바이스 예약", "/device_schedule.html"], ["디바이스 관리", "/device-admin.html"], ["디바이스 리포트", "/device-report.html"]]],
    ["회원", [["회원 정보", "/user-profile.html"], ["사용자 설정", "/user-setting.html"], ["레벨 권한", "/user-level.html"], ["회사 등록", "/user-company.html"], ["회원 관리", "/user-admin.html"]]]
  ];
  function closeMenus(except) {
    for (const group of menu.querySelectorAll("details")) {
      if (group !== except) group.open = false;
    }
  }
  for (const [label, items] of groups) {
    const group = document.createElement("details");
    group.className = "factory-navigation-group";
    const trigger = document.createElement("summary");
    trigger.textContent = label;
    const panel = document.createElement("div");
    panel.className = "factory-navigation-panel";
    panel.setAttribute("aria-label", label);
    for (const [text, href] of items) {
      const link = document.createElement("a");
      link.textContent = text;
      link.href = href;
      link.className = "page-access-hidden";
      if (location.pathname === href || (href === "/" && location.pathname === "/product-view.html")) {
        link.setAttribute("aria-current", "page");
      }
      protectedLinks.push({ link, canAccess: protectedPageAccess[href] });
      panel.append(link);
    }
    trigger.addEventListener("click", () => closeMenus(group));
    group.addEventListener("toggle", () => {
      if (group.open) closeMenus(group);
    });
    group.append(trigger, panel);
    menu.append(group);
  }
  const logoutButton = document.createElement("button");
  logoutButton.type = "button";
  logoutButton.className = "factory-navigation-logout";
  logoutButton.textContent = "로그아웃";
  logoutButton.addEventListener("click", () => logout?.click());
  menu.append(logoutButton);
  document.addEventListener("click", event => {
    if (!menu.contains(event.target)) closeMenus();
  });
  menu.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const opened = menu.querySelector("details[open]");
    closeMenus();
    opened?.querySelector("summary").focus();
  });
}

initializeFactoryNavigation();

window.applyFactoryPermissions = data => {
  window.factoryPermissions = data?.permissions || {};
  window.factoryPermissionLevels = data?.permissionLevels || {};
  window.dispatchEvent(new CustomEvent("factory-permissions-changed", { detail: data || {} }));
};
window.hasFactoryPermission = key => window.factoryPermissions?.[key] === true;

function refreshPageUser() {
  return fetch("/api/me", { cache: "no-store" })
    .then(response => response.ok ? response.json() : response.status === 401 ? null : undefined)
    .catch(() => undefined)
    .then(data => {
      if (data === undefined) return;
      if (!data || !data.user) {
        window.applyFactoryPermissions?.(null);
        applyPageUser(null);
        for (const { link } of protectedLinks) link.classList.add("page-access-hidden");
        return;
      }
      const user = data.user;
      const permissionLevel = Number(user.permissionLevel || user.permission_level || (user.role === "MASTER" ? 20 : 1));
      applyPageUser(user, permissionLevel);
      window.applyFactoryPermissions?.(data);
      const access = {
        permissionLevel,
        active: user.status !== "SUSPENDED",
        approved: user.status === "APPROVED" || permissionLevel >= 16,
        pages: data.access || {}
      };
      for (const { link, canAccess } of protectedLinks) {
        link.classList.toggle("page-access-hidden", !canAccess(access));
      }
      if (Object.hasOwn(data.access || {}, location.pathname) && data.access[location.pathname] === false) {
        location.replace("/user-profile.html?access=denied");
      }
    })
    .catch(() => {});
}

refreshPageUser();
if (hasServerConnectionIndicator()) setInterval(refreshPageUser, 15000);
window.addEventListener("focus", refreshPageUser);
window.addEventListener("pageshow", event => {
  if (event.persisted) refreshPageUser();
});

function startHttpServerConnectionMonitor() {
  let checking = false;
  let timer;
  async function check() {
    if (checking) return;
    clearTimeout(timer);
    if (navigator.onLine === false) {
      updateServerConnectionIndicator("offline");
      return;
    }
    checking = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/server-status", { cache: "no-store", signal: controller.signal });
      updateServerConnectionIndicator(navigator.onLine !== false && response.status === 204 ? "online" : "offline");
    } catch {
      updateServerConnectionIndicator("offline");
    } finally {
      clearTimeout(timeout);
      checking = false;
      timer = setTimeout(check, 30000);
    }
  }
  window.addEventListener("offline", () => updateServerConnectionIndicator("offline"));
  window.addEventListener("online", () => {
    updateServerConnectionIndicator("connecting");
    void check();
  });
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") void check();
  });
  void check();
}

function startServerConnectionMonitor() {
  if (!hasServerConnectionIndicator()) return;
  if (!usesRealtimeSocket()) {
    startHttpServerConnectionMonitor();
    return;
  }
  let activeSocket;
  function track(socket) {
    if (!socket || socket === activeSocket) return;
    activeSocket = socket;
    socket.addEventListener("message", event => {
      if (socket !== activeSocket) return;
      try { if (JSON.parse(event.data).type === "accessPolicyChanged") void refreshPageUser(); } catch {}
    });
    const update = event => {
      if (socket !== activeSocket) return;
      const state = event?.type === "error" ? "offline"
        : socket.readyState === WebSocket.OPEN ? "online"
        : socket.readyState === WebSocket.CONNECTING ? "connecting" : "offline";
      updateServerConnectionIndicator(state);
    };
    for (const type of ["open", "close", "error"]) socket.addEventListener(type, update);
    update();
  }
  window.addEventListener("factory-socket-created", event => track(event.detail));
  track(window.factoryRealtimeSocket);
}

startServerConnectionMonitor();

try {
  const cachedSettings = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || "null");
  if (cachedSettings) applyViewSettings(cachedSettings);
} catch { /* 손상된 캐시는 무시하고 서버 설정을 불러옵니다. */ }

// 화면으로 돌아올 때 다른 탭에서 변경한 설정을 다시 읽어 DB의 회원별 값과 맞춥니다.
function refreshViewSettings() {
  return fetch("/api/me/settings", { cache: "no-store" })
    .then(res => res.ok ? res.json() : null)
    .then(settings => { if (settings) applyViewSettings(settings); })
    .catch(() => {});
}

refreshViewSettings();
if (["/device-control.html", "/device-view.html"].includes(location.pathname)) {
  window.addEventListener("focus", refreshViewSettings);
  window.addEventListener("pageshow", event => {
    if (event.persisted) refreshViewSettings();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") refreshViewSettings();
  });
}