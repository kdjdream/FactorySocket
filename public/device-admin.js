// 장치 관리: 목록 조회 -> 장치/채널 편집 -> 서버 저장 -> 목록 재조회 순서로 화면을 동기화합니다.
const $ = id => document.getElementById(id);
let devices = [];
let expandedDeviceId = "";
let channelOrderSaving = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function setMessage(text) { $("adminMessage").textContent = text || ""; }
function findDevice(deviceId) { return devices.find(device => device.device_id === deviceId); }

function confirmDeviceDeletion(button, device) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "schedule-delete-dialog";
    dialog.setAttribute("aria-labelledby", "deviceDeleteTitle");
    dialog.setAttribute("aria-describedby", "deviceDeleteDescription");
    dialog.innerHTML = '<h3 id="deviceDeleteTitle">장치 삭제</h3><p id="deviceDeleteDescription"></p><div class="schedule-delete-actions"><button type="button" data-cancel-delete autofocus>취소</button><button type="button" data-confirm-delete>삭제</button></div>';
    dialog.querySelector("p").textContent = `${device.device_name} 장치와 관련된 접점·명령·이력을 모두 삭제하시겠습니까?`;

    const position = () => {
      const anchor = button.getBoundingClientRect();
      const bounds = dialog.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8));
      const top = anchor.bottom + 8 + bounds.height <= window.innerHeight - 8
        ? anchor.bottom + 8
        : Math.max(8, anchor.top - bounds.height - 8);
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    };
    const finish = confirmed => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      dialog.close();
      dialog.remove();
      if (button.isConnected) button.focus({ preventScroll: true });
      resolve(confirmed);
    };

    dialog.querySelector("[data-cancel-delete]").addEventListener("click", () => finish(false));
    dialog.querySelector("[data-confirm-delete]").addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
  });
}

// 보안 연결의 Clipboard API를 우선 사용하고, 지원되지 않는 환경에서는 선택 복사로 대체합니다.
// 임시 입력 요소를 제거한 뒤 사용자의 기존 포커스와 선택 범위를 복원합니다.
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
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const tableScrolls = [...rows.querySelectorAll(".table-wrap")].map(table => ({ left: table.scrollLeft, top: table.scrollTop }));
  if (!devices.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty-state">등록된 Device 장치가 없습니다.</td></tr>';
    return;
  }
  rows.innerHTML = devices.map(device => {
    const expanded = device.device_id === expandedDeviceId;
    const deviceVisible = Number(device.is_visible) === 1;
    const deviceEnabled = device.is_enabled == null || Number(device.is_enabled) === 1;
    return `<tr class="device-row ${expanded ? "is-expanded" : ""}" draggable="true" data-device-row="${escapeHtml(device.device_id)}">
      <td>${escapeHtml(device.id ?? "-")}</td>
      <td><code>${escapeHtml(device.device_id)}</code></td>
      <td><strong>${escapeHtml(device.device_name)}</strong></td>
      <td><div class="device-status-group"><span class="device-state ${deviceVisible ? "is-visible" : "is-invisible"}">${deviceVisible ? "Visible" : "Invisible"}</span><span class="device-state ${deviceEnabled ? "is-enabled" : "is-disabled"}">${deviceEnabled ? "Enabled" : "Disabled"}</span></div></td>
      <td><button class="output-button admin-submit" type="button" data-edit-device="${escapeHtml(device.device_id)}">${expanded ? "편집 닫기" : "편집"}</button></td>
    </tr>${expanded ? renderEditor(device) : ""}`;
  }).join("");
  rows.querySelectorAll(".table-wrap").forEach((table, index) => {
    if (tableScrolls[index]) {
      table.scrollLeft = tableScrolls[index].left;
      table.scrollTop = tableScrolls[index].top;
    }
  });
  window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
}

function renderEditor(device) {
  const sets = device.sets || [];
  return `<tr class="device-editor-row"><td colspan="5"><div class="device-editor-panel">
    <form class="device-editor-form" data-device-form="${escapeHtml(device.device_id)}">
      <div class="device-editor-identity">
        <label>장치 이름<input name="deviceName" required maxlength="100" style="padding: 10px 12px; font-size: 14px;" value="${escapeHtml(device.device_name)}"></label>
        <div class="device-editor-token" data-device-token="${escapeHtml(device.device_id)}">
          <label>장치 토큰<input type="password" data-device-token-value readonly maxlength="512" autocomplete="off" spellcheck="false" aria-label="장치 토큰"></label>
          <div class="device-editor-token-actions">
            <button class="output-button" type="button" data-device-token-action="show">토큰 확인</button>
            <button class="output-button" type="button" data-device-token-action="copy" disabled>토큰 복사</button>
            <button class="output-button admin-submit" type="button" data-device-token-action="store" hidden>기존 토큰 보관</button>
          </div>
          <p data-device-token-message class="device-message" role="status"></p>
        </div>
      </div>
      <button class="output-button admin-submit" type="submit">장치 이름 저장</button>
      <button class="output-button ${device.is_visible ? "admin-danger" : "admin-submit"}" type="button" data-toggle-device="${escapeHtml(device.device_id)}">${device.is_visible ? "장치 Invisible" : "장치 Visible"}</button>
      <button class="output-button ${device.is_enabled ? "admin-danger" : "admin-submit"}" type="button" data-toggle-enabled="${escapeHtml(device.device_id)}">${device.is_enabled ? "장치 비활성화" : "장치 활성화"}</button>
      <button class="output-button admin-danger" type="button" data-delete-device="${escapeHtml(device.device_id)}">장치 삭제</button>
    </form>
    <div class="channel-editor-heading"><h3>채널 이름 및 표시 상태</h3><p>IS는 입력 신호, OS는 출력 신호를 나타냅니다.</p></div>
    <div class="table-wrap"><table class="device-channel-table"><thead><tr><th>IS</th><th>OS</th><th>IStr</th><th>OStr</th><th>채널 이름</th><th>표시 상태</th><th>버튼 활성화</th><th>저장</th></tr></thead><tbody>${sets.map(set => `<tr draggable="true" data-channel-row="${set.id}" data-device-id="${escapeHtml(device.device_id)}">
      <td><code>${escapeHtml(set.input_signal)}</code></td><td><code>${escapeHtml(set.output_signal)}</code></td>
      <td><code>${escapeHtml(set.input_message || "")}</code></td><td><code>${escapeHtml(set.output_message || "")}</code></td>
      <td><input aria-label="${escapeHtml(set.output_signal)} 채널 이름" data-channel-name="${set.id}" value="${escapeHtml(set.channel_name)}" maxlength="50" style="padding: 10px 12px; font-size: 14px;" ></td>
      <td><span class="device-state ${set.is_visible ? "is-visible" : "is-invisible"}">${set.is_visible ? "Visible" : "Invisible"}</span></td>
      <td><fieldset class="device-channel-button-options" aria-label="${escapeHtml(set.output_signal)} 버튼 활성화">
        <label><input type="checkbox" data-channel-action="webOnEnabled" data-device-id="${escapeHtml(device.device_id)}" data-channel-action-id="${set.id}"${Number(set.web_on_enabled ?? 1) !== 0 ? " checked" : ""}><span>ON</span></label>
        <label><input type="checkbox" data-channel-action="webOffEnabled" data-device-id="${escapeHtml(device.device_id)}" data-channel-action-id="${set.id}"${Number(set.web_off_enabled ?? 1) !== 0 ? " checked" : ""}><span>OFF</span></label>
        <label><input type="checkbox" data-channel-action="webScheduleEnabled" data-device-id="${escapeHtml(device.device_id)}" data-channel-action-id="${set.id}"${Number(set.web_schedule_enabled ?? 1) !== 0 ? " checked" : ""}><span>예약</span></label>
      </fieldset></td>
      <td><div class="button-group"><button class="output-button ${set.is_visible ? "admin-danger" : "admin-submit"}" type="button" data-toggle-channel="${set.id}" data-device-id="${escapeHtml(device.device_id)}" data-visible="${set.is_visible ? "false" : "true"}">${set.is_visible ? "Invisible" : "Visible"}</button><button class="output-button admin-submit" type="button" data-save-channel="${set.id}" data-device-id="${escapeHtml(device.device_id)}">이름 저장</button><select data-channel-layout="${set.id}" data-device-id="${escapeHtml(device.device_id)}" aria-label="${escapeHtml(set.output_signal)} 채널 양식"><option value="control"${Number(set.web_control_enabled ?? 1) !== 0 ? " selected" : ""}>제어 양식</option><option value="readonly"${Number(set.web_control_enabled ?? 1) === 0 ? " selected" : ""}>조회 양식</option></select></div></td>
    </tr>`).join("")}</tbody></table></div>
  </div></td></tr>`;
}

function render() {
  $("deviceCount").textContent = `${devices.length}대`;
  renderRows();
}

async function loadDevices() {
  const response = await fetch("/api/admin/device/devices");
  const data = await response.json().catch(() => []);
  if (!response.ok) { setMessage(data.error || "Device 장치 목록을 불러오지 못했습니다."); return; }
  devices = Array.isArray(data) ? data : [];
  render();
}

// 화면의 행 순서를 장치 ID 목록으로 저장하므로 편집 행이나 채널 행은 순서 계산에서 제외합니다.
async function saveDeviceOrder() {
  const deviceIds = [...document.querySelectorAll("#deviceRows tr.device-row")].map(row => row.dataset.deviceRow);
  const response = await fetch("/api/admin/device/devices/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceIds }) });
  const data = await response.json().catch(() => ({}));
  setMessage(response.ok ? "장치 순서를 저장했습니다." : data.error || "장치 순서를 저장하지 못했습니다.");
}

async function updateDevice(deviceId, body) {
  const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(deviceId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { setMessage(data.error || "장치를 수정하지 못했습니다."); return false; }
  return true;
}

$("deviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("deviceMessage").textContent = "";
  const deviceId = $("newDeviceId").value.trim();
  const deviceName = $("newDeviceName").value.trim();
  const response = await fetch("/api/admin/device/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, deviceName }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { $("deviceMessage").textContent = data.error || "Device 장치를 등록하지 못했습니다."; return; }
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

async function handleDeviceTokenAction(button) {
  const panel = button.closest("[data-device-token]");
  const input = panel.querySelector("[data-device-token-value]");
  const message = panel.querySelector("[data-device-token-message]");
  const showButton = panel.querySelector('[data-device-token-action="show"]');
  const copyButton = panel.querySelector('[data-device-token-action="copy"]');
  const storeButton = panel.querySelector('[data-device-token-action="store"]');
  const action = button.dataset.deviceTokenAction;
  message.textContent = "";
  if (action === "show" && input.dataset.loaded === "true") {
    input.type = input.type === "password" ? "text" : "password";
    showButton.textContent = input.type === "password" ? "토큰 확인" : "토큰 숨김";
    return;
  }
  button.disabled = true;
  try {
    if (action === "copy") {
      const copied = await copyDeviceToken(input.value);
      message.textContent = copied ? "토큰을 복사했습니다." : "복사하지 못했습니다. 토큰을 선택해 복사하세요.";
      if (!copied) { input.type = "text"; input.focus(); input.select(); showButton.textContent = "토큰 숨김"; }
      return;
    }
    const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(panel.dataset.deviceToken)}/token`, action === "store" ? {
      method: "PUT", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ deviceToken: input.value })
    } : { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "장치 토큰 요청에 실패했습니다.");
    if (action === "store") {
      input.readOnly = true;
      input.dataset.loaded = "true";
      input.type = "password";
      showButton.textContent = "토큰 확인";
      storeButton.hidden = true;
      copyButton.disabled = false;
      message.textContent = "기존 토큰을 보관했습니다. 장치 인증 토큰은 변경되지 않았습니다.";
    } else if (data.tokenAvailable) {
      input.value = data.deviceToken;
      input.readOnly = true;
      input.dataset.loaded = "true";
      input.type = "text";
      showButton.textContent = "토큰 숨김";
      storeButton.hidden = true;
      copyButton.disabled = false;
    } else {
      input.readOnly = false;
      input.placeholder = "장치에 설정된 기존 토큰";
      storeButton.hidden = false;
      message.textContent = data.message;
    }
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$("deviceRows").addEventListener("click", async event => {
  const tokenButton = event.target.closest("[data-device-token-action]");
  if (tokenButton) { await handleDeviceTokenAction(tokenButton); return; }
  const editButton = event.target.closest("[data-edit-device]");
  if (editButton) { expandedDeviceId = expandedDeviceId === editButton.dataset.editDevice ? "" : editButton.dataset.editDevice; renderRows(); return; }
  const toggleDevice = event.target.closest("[data-toggle-device]");
  if (toggleDevice) {
    const device = findDevice(toggleDevice.dataset.toggleDevice);
    if (!device) return;
    if (await updateDevice(device.device_id, { deviceName: device.device_name, visible: !device.is_visible })) { expandedDeviceId = device.device_id; await loadDevices(); }
    return;
  }
  const toggleEnabled = event.target.closest("[data-toggle-enabled]");
  if (toggleEnabled) {
    const device = findDevice(toggleEnabled.dataset.toggleEnabled);
    if (!device) return;
    if (await updateDevice(device.device_id, { deviceName: device.device_name, enabled: !device.is_enabled })) { expandedDeviceId = device.device_id; await loadDevices(); }
    return;
  }
  const deleteDevice = event.target.closest("[data-delete-device]");
  if (deleteDevice) {
    const device = findDevice(deleteDevice.dataset.deleteDevice);
    if (!device || !(await confirmDeviceDeletion(deleteDevice, device))) return;
    const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(device.device_id)}`, { method: "DELETE" });
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
  const body = { setName: toggleChannel ? set.channel_name : nameInput.value.trim(), visible: toggleChannel ? button.dataset.visible === "true" : Boolean(set.is_visible) };
  const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(deviceId)}/contact-sets/${set.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  setMessage(response.ok ? "채널 설정을 저장했습니다." : data.error || "채널 설정을 저장하지 못했습니다.");
  if (response.ok) { expandedDeviceId = deviceId; await loadDevices(); }
});

$("deviceRows").addEventListener("change", async event => {
  const select = event.target.closest("[data-channel-layout]");
  const checkbox = event.target.closest("[data-channel-action]");
  if (!select && !checkbox) return;
  const control = select || checkbox;
  const deviceId = control.dataset.deviceId;
  const setId = select ? select.dataset.channelLayout : checkbox.dataset.channelActionId;
  const set = findDevice(deviceId)?.sets.find(item => String(item.id) === setId);
  if (!set) return;
  control.disabled = true;
  try {
    const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(deviceId)}/contact-sets/${set.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(select
        ? { setName: set.channel_name, webControlEnabled: select.value === "control" }
        : { setName: set.channel_name, [checkbox.dataset.channelAction]: checkbox.checked })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "채널 양식을 저장하지 못했습니다.");
    setMessage(select ? "채널 양식을 저장했습니다." : "채널 버튼 설정을 저장했습니다.");
    expandedDeviceId = deviceId;
    await loadDevices();
  } catch (err) {
    if (select) select.value = Number(set.web_control_enabled ?? 1) === 0 ? "readonly" : "control";
    else checkbox.checked = Number(set[checkbox.dataset.channelAction.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] ?? 1) !== 0;
    setMessage(err.message || "채널 설정을 저장하지 못했습니다.");
  } finally {
    control.disabled = false;
  }
});

$("deviceRows").addEventListener("dragstart", event => {
  const channel = event.target.closest("[data-channel-row]");
  if (channel) {
    if (channelOrderSaving || event.target.closest("input, select, button")) { event.preventDefault(); return; }
    channel.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-factory-channel", JSON.stringify({ deviceId: channel.dataset.deviceId, channelId: channel.dataset.channelRow }));
    return;
  }
  const row = event.target.closest("tr.device-row");
  if (!row) return;
  row.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.deviceRow);
});
$("deviceRows").addEventListener("dragend", event => {
  event.target.closest("[data-channel-row]")?.classList.remove("is-dragging");
  event.target.closest("tr.device-row")?.classList.remove("is-dragging");
});
$("deviceRows").addEventListener("dragover", event => {
  if (event.dataTransfer.types.includes("application/x-factory-channel")) {
    if (!channelOrderSaving && event.target.closest("[data-channel-row]")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }
    return;
  }
  const target = event.target.closest("tr.device-row");
  if (target) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }
});
$("deviceRows").addEventListener("drop", async event => {
  const channelData = event.dataTransfer.getData("application/x-factory-channel");
  if (channelData) {
    event.preventDefault();
    const target = event.target.closest("[data-channel-row]");
    if (!target || channelOrderSaving) return;
    let dragged;
    try { dragged = JSON.parse(channelData); } catch { return; }
    const device = findDevice(target.dataset.deviceId);
    if (!device || dragged.deviceId !== device.device_id || dragged.channelId === target.dataset.channelRow) return;
    const sets = [...device.sets];
    const sourceIndex = sets.findIndex(set => String(set.id) === dragged.channelId);
    if (sourceIndex < 0) return;
    const [moved] = sets.splice(sourceIndex, 1);
    const targetIndex = sets.findIndex(set => String(set.id) === target.dataset.channelRow);
    if (targetIndex < 0) return;
    const rect = target.getBoundingClientRect();
    sets.splice(targetIndex + (event.clientY < rect.top + rect.height / 2 ? 0 : 1), 0, moved);
    channelOrderSaving = true;
    try {
      const response = await fetch(`/api/admin/device/devices/${encodeURIComponent(device.device_id)}/contact-sets/order`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelIds: sets.map(set => String(set.id)) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "채널 순서를 저장하지 못했습니다.");
      device.sets = sets;
      setMessage("채널 순서를 저장했습니다.");
    } catch (err) {
      setMessage(err.message || "채널 순서를 저장하지 못했습니다.");
    } finally {
      channelOrderSaving = false;
      renderRows();
    }
    return;
  }
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
  if (await updateDevice(deviceId, { deviceName: String(name).trim() })) { setMessage("장치 이름을 저장했습니다."); expandedDeviceId = deviceId; await loadDevices(); }
});

(async () => {
  const response = await fetch("/api/me");
  if (!response.ok) { location.href = "/user-login.html"; return; }
  const data = await response.json();
  const level = Number(data.user.permissionLevel || data.user.permission_level || 1);
  if (data.permissions?.device_admin !== true) { location.href = "/user-profile.html?access=denied"; return; }
  await loadDevices();
})();
