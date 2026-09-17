const DEFAULT_SETTINGS = {
  sound_type: "bell", sound_volume: 50, sound_enabled: true, theme: "light",
  display_mode: "normal", show_summary: true, show_target: true, show_rate: true,
  show_updated_at: true, show_updated_by: true, date_format: "ko-KR"
};

function redirectToLogin() {
  if (location.pathname !== "/login.html") location.href = "/login.html";
}

// 정지(SUSPENDED)된 계정은 로그아웃이 아니라 회원정보 화면으로 이동시킵니다.
async function handleAuthResponse(res) {
  if (res.status === 401) { redirectToLogin(); return true; }
  if (res.status === 403) {
    try {
      const data = await res.clone().json();
      if (data.code === "SUSPENDED") { location.href = data.redirect || "/profile.html?pending=1"; return true; }
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
  document.getElementById("dateFormatKo").checked = settings.date_format === "ko-KR";
}

// 현재 화면(header)에도 즉시 테마를 반영합니다.
function applySettingsToPage(settings) {
  document.documentElement.setAttribute("data-theme", settings.theme);
  document.documentElement.setAttribute("data-display-mode", settings.display_mode);
}

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
    date_format: document.getElementById("dateFormatKo").checked ? "ko-KR" : "iso"
  };
}

function showMessage(text, isError) {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = `auth-message ${isError ? "error" : "success"}`;
}

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
    showMessage("설정을 불러오지 못해 기본값을 표시합니다.", true);
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
  const data = await res.json();
  document.getElementById("userInfo").textContent = `${data.user.name}님 (${data.user.username})`;
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); }
  finally { location.href = "/login.html?logged_out=1"; }
}

document.getElementById("soundVolume").addEventListener("input", (e) => {
  document.getElementById("soundVolumeValue").value = `${e.target.value}%`;
});
document.getElementById("settingsForm").addEventListener("submit", saveSettings);

loadUser();
loadSettings();
