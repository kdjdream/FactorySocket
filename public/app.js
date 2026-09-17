let products = [];
const DEFAULT_SETTINGS = {
  sound_type: "bell", sound_volume: 50, sound_enabled: true, theme: "light",
  display_mode: "normal", show_summary: true, show_target: true, show_rate: true,
  show_updated_at: true, show_updated_by: true, date_format: "ko-KR"
};
let userSettings = { ...DEFAULT_SETTINGS };
let soundVolume = userSettings.sound_volume / 100;
let soundType = userSettings.sound_type;
let audioContext;

function enableAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume();
}

function playQuantityNotification() {
  if (!userSettings.sound_enabled || soundVolume <= 0) return;
  try {
    enableAudio();
    const tones = {
      bell: { start: 880, end: 1320, duration: 0.18, type: "sine" },
      high: { start: 1320, end: 1760, duration: 0.14, type: "triangle" },
      beep: { start: 660, end: 660, duration: 0.1, type: "square" },
      low: { start: 440, end: 660, duration: 0.24, type: "sine" },
      soft: { start: 740, end: 900, duration: 0.22, type: "sine" },
      chime: { start: 1046, end: 1568, duration: 0.3, type: "triangle" },
      alert: { start: 520, end: 1040, duration: 0.16, type: "sawtooth" }
    };
    const tone = tones[soundType] || tones.bell;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.start, audioContext.currentTime);
    if (tone.start !== tone.end) oscillator.frequency.exponentialRampToValueAtTime(tone.end, audioContext.currentTime + tone.duration * 0.67);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16 * soundVolume, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + tone.duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + tone.duration);
  } catch (error) {
    console.warn("알림음 재생을 시작하지 못했습니다.", error);
  }
}

function updateProducts(nextProducts, notify = false) {
  const quantityChanged = notify && nextProducts.some(next => {
    const previous = products.find(product => product.id === next.id);
    return previous && Number(previous.quantity) !== Number(next.quantity);
  });
  products = nextProducts;
  render();
  if (quantityChanged) playQuantityNotification();
}

function redirectToLogin() {
  if (location.pathname !== "/login.html") {
    location.href = "/login.html";
  }
}

// 정지(SUSPENDED)된 계정은 로그아웃이 아니라 회원정보 화면으로 보냅니다.
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

async function loadProducts() {
  try {
    const res = await fetch("/api/products");

    if (await handleAuthResponse(res)) {
      return;
    }

    if (!res.ok) {
      throw new Error("제품 데이터를 가져오지 못했습니다.");
    }

    updateProducts(await res.json());
  } catch (err) {
    console.error(err);
    document.getElementById("connection").textContent =
      "○ 데이터 조회 오류";
  }
}

function render() {
  const tbody = document.getElementById("productTable");

  tbody.innerHTML = products.map(p => {
    const rate = p.target_quantity > 0
      ? Math.min(100, (p.quantity / p.target_quantity) * 100)
      : 0;

    return `
      <tr>
        <td>${escapeHtml(p.product_code)}</td>
        <td class="product-name">${escapeHtml(p.product_name)}</td>
        <td class="quantity">${Number(p.quantity).toLocaleString()}</td>
        <td>${Number(p.target_quantity).toLocaleString()}</td>
        <td>
          <div class="progress">
            <div class="progress-bar" style="width:${rate}%"></div>
          </div>
          <small>${rate.toFixed(1)}%</small>
        </td>
        <td>
          <span class="status ${statusClass(p.status)}">
            ${escapeHtml(p.status)}
          </span>
        </td>
        <td class="col-changed-by">${escapeHtml(p.updated_by_name || "-")}</td>
        <td class="col-updated-at">${formatDate(p.updated_at)}</td>
      </tr>
    `;
  }).join("");

  updateSummary();
  applyProductColumnVisibility();

  document.getElementById("lastUpdate").textContent =
    "Updated: " + formatDate(new Date());
}

function updateSummary() {
  const total = products.reduce(
    (sum, p) => sum + Number(p.quantity), 0
  );

  const target = products.reduce(
    (sum, p) => sum + Number(p.target_quantity), 0
  );

  const rate = target > 0 ? (total / target) * 100 : 0;

  document.getElementById("productCount").textContent =
    products.length;

  document.getElementById("totalQuantity").textContent =
    total.toLocaleString();

  document.getElementById("totalTarget").textContent =
    target.toLocaleString();

  document.getElementById("totalRate").textContent =
    rate.toFixed(1) + "%";

  applySummaryVisibility();
}

function applySummaryVisibility() {
  const summaryCard = document.getElementById("summaryCard");
  const summaryQuantityCard = document.getElementById("summaryQuantityCard");
  const targetCard = document.getElementById("targetCard");
  const rateCard = document.getElementById("rateCard");
  if (summaryCard) summaryCard.style.display = userSettings.show_summary ? "" : "none";
  if (summaryQuantityCard) summaryQuantityCard.style.display = userSettings.show_summary ? "" : "none";
  if (targetCard) targetCard.style.display = userSettings.show_target ? "" : "none";
  if (rateCard) rateCard.style.display = userSettings.show_rate ? "" : "none";
}

// 테이블의 최종 변경자/날짜 열은 사용자별 표시 설정을 따릅니다.
function applyProductColumnVisibility() {
  const changedByHeader = document.getElementById("changedByHeader");
  const updatedAtHeader = document.getElementById("updatedAtHeader");
  if (changedByHeader) changedByHeader.style.display = userSettings.show_updated_by ? "" : "none";
  if (updatedAtHeader) updatedAtHeader.style.display = userSettings.show_updated_at ? "" : "none";
  document.querySelectorAll(".col-changed-by").forEach(cell => { cell.style.display = userSettings.show_updated_by ? "" : "none"; });
  document.querySelectorAll(".col-updated-at").forEach(cell => { cell.style.display = userSettings.show_updated_at ? "" : "none"; });
}

function statusClass(status) {
  if (status === "생산중") return "running";
  if (status === "수리중") return "repairing";
  if (status === "완료") return "done";
  if (status === "정지") return "stop";
  return "waiting";
}

function formatDate(value) {
  if (!value) return "-";

  const date = value instanceof Date
    ? value
    : typeof value === "string" &&
      !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
      ? new Date(value.replace(" ", "T") + "+09:00")
      : new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  if (userSettings.date_format === "iso") return date.toISOString().slice(0, 19).replace("T", " ");

  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul"
  });
}

// DB에 저장된 사용자 설정을 화면(테마/표시모드/알림음)에 적용합니다.
function applyUserSettings(settings) {
  userSettings = { ...DEFAULT_SETTINGS, ...settings };
  soundType = userSettings.sound_type;
  soundVolume = Number(userSettings.sound_volume) / 100;

  document.documentElement.setAttribute("data-theme", userSettings.theme);
  document.documentElement.setAttribute("data-display-mode", userSettings.display_mode);

  applySummaryVisibility();
  applyProductColumnVisibility();
}

async function loadUserSettings() {
  try {
    const res = await fetch("/api/me/settings");
    if (await handleAuthResponse(res)) return;
    if (!res.ok) throw new Error("설정을 가져오지 못했습니다.");
    applyUserSettings(await res.json());
  } catch (err) {
    console.error(err);
    applyUserSettings(DEFAULT_SETTINGS);
  }
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}`);
  let reconnectStarted = false;

  function reconnectImmediately() {
    if (reconnectStarted) return;
    reconnectStarted = true;
    connectWebSocket();
  }

  ws.onopen = () => {
    document.getElementById("connection").textContent =
      "● 실시간 연결되었습니다.";
  };

  ws.onclose = (event) => {    if (event.code === 4001) {
      location.href = "/profile.html?pending=1";
      return;
    }
    if (event.code === 1008) {
      redirectToLogin();
      return;
    }

    document.getElementById("connection").textContent =
      "○ 연결 끊김 - 즉시 재연결 중";
    reconnectImmediately();
  };

  ws.onerror = () => reconnectImmediately();

  ws.onmessage = event => {
    const data = JSON.parse(event.data);

    if (data.type === "products" || data.type === "productsChanged") {
      updateProducts(data.products, data.type === "productsChanged");
    } else if (
      data.type === "quantityUpdated" ||
      data.type === "productUpdated"
    ) {
      const index = products.findIndex(
        p => p.id === data.product.id
      );

      const quantityChanged = index >= 0 && Number(products[index].quantity) !== Number(data.product.quantity);
      if (index >= 0) {
        products[index] = data.product;
      } else {
        products.push(data.product);
      }

      render();
      if (quantityChanged) playQuantityNotification();
    }
  };
}

document.addEventListener("pointerdown", enableAudio, { once: true });

async function loadUser() {
  const res = await fetch("/api/me");

  if (res.status === 401) {
    redirectToLogin();
    return;
  }

  const data = await res.json();

  document.getElementById("userInfo").textContent =
    `${data.user.name}님 (${data.user.username})`;
  if (Number(data.user.permissionLevel || data.user.permission_level || 1) >= 2) document.getElementById("controlLink").style.display = "inline-block";
  if (Number(data.user.permissionLevel || data.user.permission_level || 1) >= 6) document.getElementById("productAdminLink").style.display = "inline-block";
  if (Number(data.user.permissionLevel || data.user.permission_level || 1) >= 8) document.getElementById("adminLink").style.display = "inline-block";
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    location.href = "/login.html?logged_out=1";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadUser();
loadUserSettings();
loadProducts();
connectWebSocket();
