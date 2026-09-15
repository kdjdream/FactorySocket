let products = [];
let soundVolume = Number(localStorage.getItem("factorySoundVolume") || 50) / 100;
let soundType = localStorage.getItem("factorySoundType") || "bell";
let audioContext;

function enableAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume();
}

function playQuantityNotification() {
  if (soundVolume <= 0) return;
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

async function loadProducts() {
  try {
    const res = await fetch("/api/products");

    if (res.status === 401) {
      redirectToLogin();
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
        <td>${formatDate(p.updated_at)}</td>
      </tr>
    `;
  }).join("");

  updateSummary();

  document.getElementById("lastUpdate").textContent =
    "Updated: " + new Date().toLocaleString("ko-KR");
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

  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul"
  });
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

  ws.onclose = (event) => {
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

document.addEventListener("DOMContentLoaded", () => {
  const soundTypeInput = document.getElementById("soundType");
  const volumeInput = document.getElementById("soundVolume");
  const volumeValue = document.getElementById("soundVolumeValue");
  soundTypeInput.value = soundType;
  volumeInput.value = String(Math.round(soundVolume * 100));
  volumeValue.value = `${volumeInput.value}%`;
  document.addEventListener("pointerdown", enableAudio, { once: true });
  soundTypeInput.addEventListener("change", () => {
    soundType = soundTypeInput.value;
    localStorage.setItem("factorySoundType", soundType);
  });
  volumeInput.addEventListener("input", () => {
    soundVolume = Number(volumeInput.value) / 100;
    localStorage.setItem("factorySoundVolume", volumeInput.value);
    volumeValue.value = `${volumeInput.value}%`;
  });
});

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
loadProducts();
connectWebSocket();
