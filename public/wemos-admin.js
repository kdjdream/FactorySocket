const $ = id => document.getElementById(id);
let devices = [];
let expandedDeviceId = "";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function setMessage(text) { $("adminMessage").textContent = text || ""; }
function findDevice(deviceId) { return devices.find(device => device.device_id === deviceId); }

async function copyDeviceToken(token) {
  if (typeof token !== "string" || !token) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(token);
      return true;
    }
  } catch {}

  const previousFocus = document.activeElement;
  const selection = document.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = token;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  document.body.appendChild(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, token.length);
    return document.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    input.remove();
    previousFocus?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}

function renderRows() {
  const rows = $("deviceRows");
  if (!devices.length) {
    rows.innerHTML = '<tr><td colspan="7" class="empty-state">등록된 Wemos 장치가 없습니다.</td></tr>';
    return;
  }
  rows.innerHTML = devices.map(device => {
    const expanded = device.device_id === expandedDeviceId;
    return `<tr class="device-row ${expanded ? "is-expanded" : ""}" draggable="true" data-device-row="${escapeHtml(device.device_id)}">
      <td><code>${escapeHtml(device.device_id)}</code></td>
      <td><strong>${escapeHtml(device.device_name)}</strong></td>
      <td><span class="device-state ${device.is_active ? "is-active" : "is-inactive"}">${device.is_active ? "활성" : "비활성"}</span></td>
      <td><button class="output-button admin-submit" type="button" data-edit-device="${escapeHtml(device.device_id)}">${expanded ? "편집 닫기" : "편집"}</button></td>
    </tr>${expanded ? renderEditor(device) : ""}`;
  }).join("");
}

function renderEditor(device) {
  const sets = device.sets || [];
  return `<tr class="device-editor-row"><td colspan="7"><div class="device-editor-panel">
    <form class="device-editor-form" data-device-form="${escapeHtml(device.device_id)}">
      <label>장치 이름<input name="deviceName" required maxlength="100" style="padding: 10px 12px; font-size: 14px;" value="${escapeHtml(device.device_name)}"></label>
      <button class="output-button admin-submit" type="submit">장치 이름 저장</button>
      <button class="output-button ${device.is_active ? "admin-danger" : "admin-submit"}" type="button" data-toggle-device="${escapeHtml(device.device_id)}">${device.is_active ? "장치 비활성화" : "장치 활성화"}</button>
      <button class="output-button admin-danger" type="button" data-delete-device="${escapeHtml(device.device_id)}">장치 삭제</button>
    </form>
    <div class="channel-editor-heading"><h3>채널 이름 및 상태</h3><p>IS는 입력 신호, OS는 출력 신호를 나타냅니다.</p></div>
    <div class="table-wrap"><table class="wemos-channel-table"><thead><tr><th>IS</th><th>OS</th><th>IStr</th><th>OStr</th><th>채널 이름</th><th>상태</th><th>저장</th></tr></thead><tbody>${sets.map(set => `<tr>
      <td><code>${escapeHtml(set.input_signal)}</code></td><td><code>${escapeHtml(set.output_signal)}</code></td>
      <td><code>${escapeHtml(set.input_message || "")}</code></td><td><code>${escapeHtml(set.output_message || "")}</code></td>
      <td><input aria-label="${escapeHtml(set.output_signal)} 채널 이름" data-channel-name="${set.id}" value="${escapeHtml(set.channel_name)}" maxlength="50" style="padding: 10px 12px; font-size: 14px;" ></td>
      <td><span class="device-state ${set.is_active ? "is-active" : "is-inactive"}">${set.is_active ? "활성" : "비활성"}</span></td>
      <td><div class="button-group"><button class="output-button ${set.is_active ? "admin-danger" : "admin-submit"}" type="button" data-toggle-channel="${set.id}" data-device-id="${escapeHtml(device.device_id)}" data-active="${set.is_active ? "false" : "true"}">${set.is_active ? "비활성화" : "활성화"}</button><button class="output-button admin-submit" type="button" data-save-channel="${set.id}" data-device-id="${escapeHtml(device.device_id)}">이름 저장</button></div></td>
    </tr>`).join("")}</tbody></table></div>
  </div></td></tr>`;
}

function render() {
  $("deviceCount").textContent = `${devices.length}대`;
  renderRows();
}

async function loadDevices() {
  const response = await fetch("/api/admin/wemos/devices");
  const data = await response.json().catch(() => []);
  if (!response.ok) { setMessage(data.error || "Wemos 장치 목록을 불러오지 못했습니다."); return; }
  devices = Array.isArray(data) ? data : [];
  render();
}

async function saveDeviceOrder() {
  const deviceIds = [...document.querySelectorAll("#deviceRows tr.device-row")].map(row => row.dataset.deviceRow);
  const response = await fetch("/api/admin/wemos/devices/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceIds }) });
  const data = await response.json().catch(() => ({}));
  setMessage(response.ok ? "장치 순서를 저장했습니다." : data.error || "장치 순서를 저장하지 못했습니다.");
}

async function updateDevice(deviceId, body) {
  const response = await fetch(`/api/admin/wemos/devices/${encodeURIComponent(deviceId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { setMessage(data.error || "장치를 수정하지 못했습니다."); return false; }
  return true;
}

$("deviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("deviceMessage").textContent = "";
  const deviceId = $("newDeviceId").value.trim();
  const deviceName = $("newDeviceName").value.trim();
  const response = await fetch("/api/admin/wemos/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, deviceName }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { $("deviceMessage").textContent = data.error || "Wemos 장치를 등록하지 못했습니다."; return; }
  $("deviceMessage").textContent = `${deviceId}(${deviceName})이 등록되었습니다.`;
  $("deviceForm").reset();
  const tokenResult = $("tokenResult");
  tokenResult.hidden = false;
  tokenResult.replaceChildren();
  const tokenLabel = document.createElement("span");
  tokenLabel.textContent = "장치 토큰";
  const tokenValue = document.createElement("code");
  tokenValue.textContent = data.deviceToken;
  tokenValue.style.userSelect = "all";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "output-button admin-submit";
  copyButton.textContent = "토큰 복사";
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    try {
      const copied = await copyDeviceToken(data.deviceToken);
      copyButton.textContent = copied ? "복사됨" : "복사 실패";
      if (copied) {
        $("deviceMessage").textContent = "장치 토큰이 복사되었습니다.";
      } else {
        const selection = document.getSelection?.();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(tokenValue);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        $("deviceMessage").textContent = "브라우저에서 자동 복사를 허용하지 않습니다.";
      }
    } finally {
      copyButton.disabled = false;
    }
  });
  tokenResult.append(tokenLabel, tokenValue, copyButton);
  await loadDevices();
});

$("deviceRows").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-device]");
  if (editButton) { expandedDeviceId = expandedDeviceId === editButton.dataset.editDevice ? "" : editButton.dataset.editDevice; renderRows(); return; }
  const toggleDevice = event.target.closest("[data-toggle-device]");
  if (toggleDevice) {
    const device = findDevice(toggleDevice.dataset.toggleDevice);
    if (!device || !confirm(`장치를 ${device.is_active ? "비활성화" : "활성화"}할까요?`)) return;
    if (await updateDevice(device.device_id, { deviceName: device.device_name, active: !device.is_active })) { await loadDevices(); expandedDeviceId = device.device_id; renderRows(); }
    return;
  }
  const deleteDevice = event.target.closest("[data-delete-device]");
  if (deleteDevice) {
    const device = findDevice(deleteDevice.dataset.deleteDevice);
    if (!device || !confirm(`${device.device_name} 장치와 관련된 접점·명령·이력을 모두 삭제할까요?`)) return;
    const response = await fetch(`/api/admin/wemos/devices/${encodeURIComponent(device.device_id)}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok ? "장치와 관련 데이터가 삭제되었습니다." : data.error || "장치를 삭제하지 못했습니다.");
    if (response.ok) { expandedDeviceId = ""; await loadDevices(); }
    return;
  }
  const saveChannel = event.target.closest("[data-save-channel]");
  const toggleChannel = event.target.closest("[data-toggle-channel]");
  const button = saveChannel || toggleChannel;
  if (!button) return;
  const deviceId = button.dataset.deviceId;
  const set = findDevice(deviceId)?.sets.find(item => String(item.id) === (button.dataset.saveChannel || button.dataset.toggleChannel));
  if (!set) return;
  const nameInput = document.querySelector(`[data-channel-name="${set.id}"]`);
  const body = { setName: toggleChannel ? set.channel_name : nameInput.value.trim(), active: toggleChannel ? button.dataset.active === "true" : Boolean(set.is_active) };
  const response = await fetch(`/api/admin/wemos/devices/${encodeURIComponent(deviceId)}/contact-sets/${set.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  setMessage(response.ok ? "채널 설정을 저장했습니다." : data.error || "채널 설정을 저장하지 못했습니다.");
  if (response.ok) { await loadDevices(); expandedDeviceId = deviceId; renderRows(); }
});

$("deviceRows").addEventListener("dragstart", event => {
  const row = event.target.closest("tr.device-row");
  if (!row) return;
  row.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.deviceRow);
});
$("deviceRows").addEventListener("dragend", event => {
  event.target.closest("tr.device-row")?.classList.remove("is-dragging");
});
$("deviceRows").addEventListener("dragover", event => {
  const target = event.target.closest("tr.device-row");
  if (target) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }
});
$("deviceRows").addEventListener("drop", async event => {
  const target = event.target.closest("tr.device-row");
  if (!target) return;
  event.preventDefault();
  const draggedId = event.dataTransfer.getData("text/plain");
  const dragged = document.querySelector(`tr.device-row[data-device-row="${CSS.escape(draggedId)}"]`);
  if (!dragged || dragged === target) return;
  const rect = target.getBoundingClientRect();
  target.parentNode.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
  const orderedIds = [...document.querySelectorAll("#deviceRows tr.device-row")].map(row => row.dataset.deviceRow);
  devices.sort((left, right) => orderedIds.indexOf(left.device_id) - orderedIds.indexOf(right.device_id));
  await saveDeviceOrder();
  renderRows();
});

$("deviceRows").addEventListener("submit", async event => {
  const form = event.target.closest("[data-device-form]");
  if (!form) return;
  event.preventDefault();
  const deviceId = form.dataset.deviceForm;
  const name = new FormData(form).get("deviceName");
  if (await updateDevice(deviceId, { deviceName: String(name).trim() })) { setMessage("장치 이름을 저장했습니다."); await loadDevices(); expandedDeviceId = deviceId; renderRows(); }
});

(async () => {
  const response = await fetch("/api/me");
  if (!response.ok) { location.href = "/login.html"; return; }
  const data = await response.json();
  const level = Number(data.user.permissionLevel || data.user.permission_level || 1);
  if (level < 8 || data.user.status !== "APPROVED") { location.href = "/profile.html"; return; }
  await loadDevices();
})();
