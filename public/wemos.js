const $ = id => document.getElementById(id);

let ws = null;
let reconnectTimer = null;
let historyRows = [];
let commandRows = [];
let permission = 0;

const COMMAND_STATUS_RANK = {
  PENDING: 1,
  DELIVERED: 2,
  ACKED: 3,
  FAILED: 3,
  CANCELLED: 4
};

const stateElements = {};
const outputButtons = {};

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

/*
 * 기존 정적 채널 영역과 호환하기 위한 함수입니다.
 * 실제 화면은 wemos-active-devices.js가 생성한 동적 영역도 함께 갱신합니다.
 */
function setPinState(pin, state) {
  pin = String(pin || "").toUpperCase();
  if (!stateElements[pin]) return;

  const value = state === "ON" ? "ON" : "OFF";
  const indicator = stateElements[pin];

  indicator.textContent = value;
  indicator.dataset.state = value;

  const buttons = outputButtons[pin];
  if (!buttons) return;

  const [onButton, offButton] = buttons;

  if (onButton) {
    onButton.classList.toggle("is-active", value === "ON");
    onButton.setAttribute("aria-pressed", String(value === "ON"));
  }

  if (offButton) {
    offButton.classList.toggle("is-active", value === "OFF");
    offButton.setAttribute("aria-pressed", String(value === "OFF"));
  }
}

function setConnectionStatus(element, connected, label) {
  if (!element) return;

  element.textContent = label;
  element.dataset.connected = connected ? "true" : "false";
}

function setState(state = {}) {
  if (!state) return;

  if ($("device")) $("device").textContent = state.device_id || "-";

  for (const channel of state.channels || []) {
    setPinState(channel.output_pin, channel.current_state);
  }

  if ($("source")) $("source").textContent = state.last_source || "-";
  if ($("seen")) $("seen").textContent = formatDate(state.last_seen_at);
}

function renderHistory() {
  const target = $("history");
  if (!target) return;

  target.innerHTML = historyRows.map(row => `
    <tr>
      <td>${escapeHtml(formatDate(row.changed_at))}</td>
      <td>${escapeHtml(row.device_id || "-")}</td>
      <td>${escapeHtml(row.pin_name || "OS1")}</td>
      <td>${escapeHtml(row.previous_state || "-")}</td>
      <td>${escapeHtml(row.new_state)}</td>
      <td>${escapeHtml(row.source)}</td>
      <td>${escapeHtml(row.command_id || "-")}</td>
    </tr>
  `).join("");
}

function renderCommands() {
  const target = $("commands");
  if (!target) return;

  target.innerHTML = commandRows.map(row => `
    <tr>
      <td>${escapeHtml(formatDate(row.changed_at))}</td>
      <td>${escapeHtml(row.device_id || "-")}</td>
      <td>${escapeHtml(row.pin_name || row.pin || "OS1")}</td>
      <td>${escapeHtml(row.desired_state)}</td>
      <td>${escapeHtml(row.requester)}</td>
      <td>${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.command_id || "-")}</td>
    </tr>
  `).join("");
}

function mergeHistory(rows = []) {
  const merged = new Map();

  for (const row of [...historyRows, ...rows]) {
    const key =
      row.command_id ||
      `${row.changed_at}|${row.pin_name}|${row.source}|${row.new_state}`;

    merged.set(key, row);
  }

  historyRows = [...merged.values()]
    .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
    .slice(0, 50);

  renderHistory();
}

function mergeCommands(rows = []) {
  const merged = new Map();

  for (const row of [...commandRows, ...rows]) {
    const previous = merged.get(row.command_id) || {};

    const newRank = COMMAND_STATUS_RANK[row.status] || 0;
    const oldRank = COMMAND_STATUS_RANK[previous.status] || 0;

    merged.set(row.command_id, {
      ...previous,
      ...row,
      status: newRank >= oldRank ? row.status : previous.status
    });
  }

  commandRows = [...merged.values()]
    .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
    .slice(0, 50);

  renderCommands();
}

function pushHistory(row) {
  mergeHistory([row]);
}

function upsertCommand(row) {
  mergeCommands([row]);
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if ($("msg")) $("msg").textContent = "서버 WebSocket이 연결되지 않았습니다.";
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

window.sendWemosCommand = send;

/*
 * 서버에서 받은 Wemos WebSocket 메시지를 처리합니다.
 *
 * 중요:
 * 1. DB snapshot은 최초 화면 표시용
 * 2. state/stateChanged는 실시간 상태 변경용
 * 3. stateChanged는 현재 상태 + 최근 변경 이력을 동시에 갱신
 * 4. 모든 실시간 이벤트를 CustomEvent로 전달하여
 *    wemos-active-devices.js가 동적 DOM도 즉시 갱신할 수 있게 합니다.
 */
function handle(message) {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "wemosSnapshot":
      setState(message.state || {});
      mergeHistory(message.history || []);
      mergeCommands(message.commands || []);
      break;

    case "initialState":
      setState(message.state || {});
      break;

    case "history":
      mergeHistory(message.rows || []);
      break;

    case "commands":
      mergeCommands(message.rows || []);
      break;

    case "deviceConnection":
      setConnectionStatus(
        $("deviceConn"),
        Boolean(message.connected),
        message.connected ? "정상 작동 중" : "연결 안 됨"
      );
      break;

    case "state":
      updateRealtimeState(message);
      break;

    case "stateChanged":
      updateRealtimeState(message);

      if ($("msg")) {
        $("msg").textContent =
          `${message.pin}: ${message.previousState} → ${message.state} (${message.source})`;
      }

      pushHistory({
        device_id: message.deviceId,
        changed_at: message.changedAt,
        pin_name: message.pin,
        previous_state: message.previousState,
        new_state: message.state,
        source: message.source,
        command_id: message.commandId
      });
      break;

    case "commandQueued":
      upsertCommand({
        command_id: message.commandId,
        device_id: message.deviceId,
        pin_name: message.pin,
        desired_state: message.state,
        requester: message.requester,
        status: message.status,
        changed_at: message.createdAt || message.changedAt
      });
      break;

    case "commandAck":
      upsertCommand({
        command_id: message.commandId,
        device_id: message.deviceId,
        pin_name: message.pin,
        desired_state: message.state,
        status: message.status,
        changed_at: message.changedAt
      });
      break;

    case "lampAck":
      if ($("msg")) {
        $("msg").textContent = message.ok
          ? `${message.pin || "OS1"} ${message.state || ""} 명령 저장 완료 / ${message.commandId || ""}`
          : (message.message || "출력 명령 처리에 실패했습니다.");
      }
      break;

    case "error":
      if ($("msg")) $("msg").textContent = message.message || "Wemos 오류";
      break;
  }
}

function updateRealtimeState(message) {
  const pin = String(message.pin || "").toUpperCase();
  const state = String(message.state || "").toUpperCase();

  if (!/^OS[1-8]$/.test(pin)) return;
  if (!["ON", "OFF"].includes(state)) return;

  // 기존 정적 UI
  setPinState(pin, state);

  // 현재 화면을 생성하는 동적 Wemos UI도 즉시 갱신합니다.
  // wemos-active-devices.js가 아직 로드되지 않은 경우에는 보관했다가
  // 해당 스크립트가 로드된 후 재적용합니다.
  if (typeof window.applyWemosActiveLiveState === "function") {
    window.applyWemosActiveLiveState(message);
  } else {
    window.__pendingWemosLiveStates = window.__pendingWemosLiveStates || [];
    window.__pendingWemosLiveStates.push(message);
  }

  if ($("device")) $("device").textContent = message.deviceId || "-";
  if ($("source")) $("source").textContent = message.source || "-";
  if ($("seen")) $("seen").textContent = formatDate(message.changedAt);
}

/*
 * 브라우저가 서버에 연결되면 반드시 subscribeWemos를 보냅니다.
 * 서버는 이 플래그가 true인 브라우저에만 Wemos 상태를 broadcast합니다.
 */
function connect() {
  configureOutputControls();

  if (
    ws &&
    (ws.readyState === WebSocket.CONNECTING ||
      ws.readyState === WebSocket.OPEN)
  ) {
    if (ws.readyState === WebSocket.OPEN) {
      send({ type: "subscribeWemos" });
    }
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}`);

  ws = socket;

  socket.onopen = () => {
    setConnectionStatus($("server"), true, "정상");

    // WebSocket 연결 직후 구독 등록
    socket.send(JSON.stringify({ type: "subscribeWemos" }));
  };

  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data);

      // 동적 Wemos UI에 실시간 이벤트 전달
      window.dispatchEvent(
        new CustomEvent("wemos-state-update", {
          detail: message
        })
      );

      handle(message);
    } catch (error) {
      console.error("[Wemos WebSocket] JSON 처리 오류:", error);
    }
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;

    setConnectionStatus($("server"), false, "연결 끊김");

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  socket.onerror = error => {
    console.error("[Wemos WebSocket] 오류:", error);
    setConnectionStatus($("server"), false, "오류");
  };
}

function configureOutputControls() {
  for (const pin of Object.keys(outputButtons)) {
    const buttons = outputButtons[pin];
    const [onButton, offButton] = buttons;

    if (!onButton || !offButton) continue;

    const initialState = stateElements[pin]?.dataset.state || "OFF";
    setPinState(pin, initialState);

    onButton.disabled = permission < 2;
    offButton.disabled = permission < 2;

    onButton.onclick = () =>
      send({ type: "lamp", pin, state: "ON" });

    offButton.onclick = () =>
      send({ type: "lamp", pin, state: "OFF" });
  }
}

function resync() {
  if (document.visibilityState !== "hidden") {
    connect();
  }
}

async function loadUser() {
  const response = await fetch("/api/me");

  if (!response.ok) {
    location.href = "/login.html";
    return;
  }

  const data = await response.json();

  permission = Number(
    data.user.permissionLevel ||
    data.user.permission_level ||
    1
  );

  if ($("user")) {
    $("user").textContent =
      `${data.user.name} (${data.user.username})`;
  }

  if ($("permission")) {
    $("permission").textContent = `${permission}등급`;
  }

  if (permission < 2) {
    if ($("msg")) {
      $("msg").textContent =
        "출력 제어는 2등급 이상 회원만 사용할 수 있습니다.";
    }
  }

  // 조회 화면도 WebSocket을 통해 실시간 상태를 받을 수 있도록 연결합니다.
  connect();
}

loadUser();

document.addEventListener("visibilitychange", resync);
window.addEventListener("focus", resync);
window.addEventListener("pageshow", resync);
window.addEventListener("online", resync);
