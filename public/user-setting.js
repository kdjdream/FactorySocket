// 개인 설정: 서버 값으로 폼을 복원하고, 저장에 성공한 값만 현재 페이지에도 적용합니다.
const DEFAULT_SETTINGS = {
  sound_type: "bell", sound_volume: 50, sound_enabled: true, theme: "light",
  display_mode: "normal", show_summary: true, show_target: true, show_rate: true,
  show_updated_at: true, show_updated_by: true, date_format: "ko-KR",
  show_device_istr: true, show_device_ostr: true, show_device_ostr_inputs: true
};

function redirectToLogin() {
  if (location.pathname !== "/user-login.html") location.href = "/user-login.html";
}

// 정지(SUSPENDED)된 계정은 로그아웃이 아니라 회원정보 화면으로 이동시킵니다.
async function handleAuthResponse(res) {
  if (res.status === 401) { redirectToLogin(); return true; }
  if (res.status === 403) {
    try {
      const data = await res.clone().json();
      if (data.code === "SUSPENDED") { location.href = data.redirect || "/user-profile.html?pending=1"; return true; }
    } catch { /* JSON이 아닌 응답은 무시합니다. */ }
  }
  return false;
}

function applySettingsToForm(settings) {
  document.getElementById("soundEnabled").checked = !!settings.sound_enabled;
  document.getElementById("soundType").value = settings.sound_type;
  document.getElementById("soundVolume").value = settings.sound_volume;
  document.getElementById("soundVolumeValue").value = `${settings.sound_volume}%`;
  document.getElementById("theme").value = settings.theme;
  document.getElementById("displayMode").value = settings.display_mode;
  document.getElementById("showSummary").checked = !!settings.show_summary;
  document.getElementById("showTarget").checked = !!settings.show_target;
  document.getElementById("showRate").checked = !!settings.show_rate;
  document.getElementById("showUpdatedAt").checked = !!settings.show_updated_at;
  document.getElementById("showUpdatedBy").checked = !!settings.show_updated_by;
  document.getElementById("showDeviceIstr").checked = settings.show_device_istr !== false;
  document.getElementById("showDeviceOstr").checked = settings.show_device_ostr !== false;
  document.getElementById("showDeviceOstrInputs").checked = settings.show_device_ostr_inputs !== false;
  document.getElementById("dateFormatKo").checked = settings.date_format === "ko-KR";
}

// 현재 화면(header)에도 즉시 테마를 반영합니다.
function applySettingsToPage(settings) {
  if (window.applyFactoryViewSettings) {
    window.applyFactoryViewSettings(settings);
    return;
  }
  document.documentElement.setAttribute("data-theme", settings.theme);
  document.documentElement.setAttribute("data-display-mode", settings.display_mode);
}

// 체크박스는 boolean, 볼륨은 숫자로 변환하여 서버의 검증 형식에 맞춰 전송합니다.
function readSettingsFromForm() {
  return {
    sound_enabled: document.getElementById("soundEnabled").checked,
    sound_type: document.getElementById("soundType").value,
    sound_volume: Number(document.getElementById("soundVolume").value),
    theme: document.getElementById("theme").value,
    display_mode: document.getElementById("displayMode").value,
    show_summary: document.getElementById("showSummary").checked,
    show_target: document.getElementById("showTarget").checked,
    show_rate: document.getElementById("showRate").checked,
    show_updated_at: document.getElementById("showUpdatedAt").checked,
    show_updated_by: document.getElementById("showUpdatedBy").checked,
    show_device_istr: document.getElementById("showDeviceIstr").checked,
    show_device_ostr: document.getElementById("showDeviceOstr").checked,
    show_device_ostr_inputs: document.getElementById("showDeviceOstrInputs").checked,
    date_format: document.getElementById("dateFormatKo").checked ? "ko-KR" : "iso"
  };
}

function showMessage(text, isError) {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = `auth-message ${isError ? "error" : "success"}`;
}

// 조회 실패 시 폼에는 기본값을 보여 주되, 이미 적용된 화면 설정은 덮어쓰지 않습니다.
async function loadSettings() {
  try {
    const res = await fetch("/api/me/settings");
    if (await handleAuthResponse(res)) return;
    if (!res.ok) throw new Error("설정을 가져오지 못했습니다.");
    const settings = await res.json();
    applySettingsToForm(settings);
    applySettingsToPage(settings);
  } catch (err) {
    console.error(err);
    applySettingsToForm(DEFAULT_SETTINGS);
    showMessage("설정을 불러오지 못했습니다. 저장된 화면 설정은 유지됩니다.", true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const settings = readSettingsFromForm();
  try {
    const res = await fetch("/api/me/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
    if (await handleAuthResponse(res)) return;
    const data = await res.json();
    if (!res.ok) { showMessage(data.error || "설정 저장에 실패했습니다.", true); return; }
    applySettingsToPage(settings);
    showMessage("설정이 저장되었습니다.", false);
  } catch (err) {
    console.error(err);
    showMessage("네트워크 오류로 설정을 저장하지 못했습니다.", true);
  }
}

async function loadUser() {
  const res = await fetch("/api/me");
  if (await handleAuthResponse(res)) return;
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); }
  finally { location.href = "/user-login.html?logged_out=1"; }
}

document.getElementById("soundVolume").addEventListener("input", (e) => {
  document.getElementById("soundVolumeValue").value = `${e.target.value}%`;
});
document.getElementById("settingsForm").addEventListener("submit", saveSettings);

loadUser();
loadSettings();
