// 8등급 이상 관리자 전용 제품-채널 연결 관리 화면입니다.
let mappingMeta = { products: [], channels: [] };
let mappings = [];
let editingMappingId = null;
let activeDeleteConfirmation = null;

function handleUnauthorized(res) {
  if (res.status === 401) {
    alert("로그인이 필요합니다.");
    location.href = "/user-login.html";
    return true;
  }
  return false;
}

async function handleForbidden(res) {
  if (res.status !== 403) return false;
  const data = await res.clone().json().catch(() => ({}));
  if (data.code === "SUSPENDED") {
    location.href = data.redirect || "/user-profile.html?pending=1";
    return true;
  }
  alert(data.error || "권한이 없습니다.");
  location.href = "/";
  return true;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ko-KR");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setMessage(text, isError = false) {
  const message = document.getElementById("mappingMessage");
  message.textContent = text || "";
  message.className = isError ? "mapping-message error" : "mapping-message";
}

function renderMeta() {
  const productSelect = document.getElementById("productSelect");
  const deviceSelect = document.getElementById("deviceSelect");

  productSelect.innerHTML = [
    `<option value="">제품 선택</option>`,
    ...mappingMeta.products.map((product) => {
      const inactiveLabel = Number(product.is_enabled) === 1 ? "" : " · 사용 중지";
      return `<option value="${product.id}">${escapeHtml(product.product_code)} - ${escapeHtml(product.product_name)}${inactiveLabel}</option>`;
    })
  ].join("");

  const devices = [...new Map(mappingMeta.channels.map((channel) => [
    channel.device_id,
    { device_id: channel.device_id, device_name: channel.device_name, is_visible: channel.device_is_visible, is_enabled: channel.device_is_enabled }
  ])).values()];

  deviceSelect.innerHTML = [
    `<option value="">디바이스 선택</option>`,
    ...devices.map((device) => {
      const statusLabel = [
        Number(device.is_visible) === 1 ? "" : "Invisible",
        Number(device.is_enabled) === 1 ? "" : "비활성"
      ].filter(Boolean).map(label => ` · ${label}`).join("");
      const label = `${device.device_name} (${device.device_id})${statusLabel}`;
      return `<option value="${escapeHtml(device.device_id)}">${escapeHtml(label)}</option>`;
    })
  ].join("");

  renderChannelOptions();
}

function renderChannelOptions() {
  const deviceId = document.getElementById("deviceSelect").value;
  const channelSelect = document.getElementById("channelSelect");
  const channels = mappingMeta.channels.filter((channel) => channel.device_id === deviceId);

  channelSelect.innerHTML = [
    `<option value="">채널 선택</option>`,
    ...channels.map((channel) => {
      const statusLabel = Number(channel.is_visible) === 1 ? "" : " · Invisible";
      const label = `${channel.channel_name} (${channel.output_signal})${statusLabel}`;
      return `<option value="${escapeHtml(channel.output_signal)}">${escapeHtml(label)}</option>`;
    })
  ].join("");
  channelSelect.disabled = !deviceId;
}

function renderMappings() {
  const body = document.getElementById("mappingsBody");

  if (!mappings.length) {
    body.innerHTML = `<tr><td colspan="9">등록된 제품-채널 연결이 없습니다.</td></tr>`;
    return;
  }

  body.innerHTML = mappings.map((row) => `
    <tr>
      <td>${row.id}</td>
      <td>${escapeHtml(row.product_code)}</td>
      <td>${escapeHtml(row.product_name)}</td>
      <td>${escapeHtml(row.device_name)} (${escapeHtml(row.device_id)})${Number(row.device_is_visible) === 1 ? "" : " · Invisible"}${Number(row.device_is_enabled) === 1 ? "" : " · 비활성"}</td>
      <td>${escapeHtml(row.channel_name)} (${escapeHtml(row.output_signal)})${Number(row.channel_is_visible) === 1 ? "" : " · Invisible"}</td>
      <td>${escapeHtml(row.mapping_name || "-")}</td>
      <td>${escapeHtml(row.created_by_name || "-")}</td>
      <td>${escapeHtml(formatDate(row.created_at))}</td>
      <td class="admin-actions">
        <button type="button" onclick="editMapping(${row.id})">수정</button>
        <button type="button" aria-haspopup="dialog" aria-expanded="false" onclick="removeMapping(${row.id}, this)">삭제</button>
      </td>
    </tr>
  `).join("");
}

async function loadMeta() {
  const res = await fetch("/api/admin/product-channel-mappings/meta", { cache: "no-store" });
  if (handleUnauthorized(res)) return false;
  if (await handleForbidden(res)) return false;
  if (!res.ok) throw new Error("메타 데이터 조회 실패");

  mappingMeta = await res.json();
  renderMeta();
  return true;
}

async function loadMappings() {
  const res = await fetch("/api/admin/product-channel-mappings", { cache: "no-store" });
  if (handleUnauthorized(res)) return false;
  if (await handleForbidden(res)) return false;
  if (!res.ok) throw new Error("목록 조회 실패");

  mappings = await res.json();
  renderMappings();
  return true;
}

async function createMapping(event) {
  event.preventDefault();
  const productId = Number(document.getElementById("productSelect").value);
  const deviceId = document.getElementById("deviceSelect").value;
  const outputSignal = document.getElementById("channelSelect").value;
  const mappingName = document.getElementById("mappingName").value.trim();

  if (!Number.isInteger(productId) || !deviceId || !outputSignal || !mappingName) {
    setMessage("제품, 디바이스, 채널과 연결 명칭을 모두 입력하세요.", true);
    return;
  }

  setMessage("");

  const isEditing = editingMappingId !== null;
  const endpoint = isEditing
    ? `/api/admin/product-channel-mappings/${editingMappingId}`
    : "/api/admin/product-channel-mappings";
  const res = await fetch(endpoint, {
    method: isEditing ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, deviceId, outputSignal, mappingName })
  });

  if (handleUnauthorized(res)) return;
  if (await handleForbidden(res)) return;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setMessage(data.error || "연결 등록에 실패했습니다.", true);
    setMessage(data.error || (isEditing ? "연결 수정에 실패했습니다." : "연결 등록에 실패했습니다."), true);
    return;
  }

  setMessage(data.message || "연결이 등록되었습니다.");
  clearEditMode();
  await loadMappings();
}

function editMapping(id) {
  const mapping = mappings.find((row) => Number(row.id) === Number(id));
  if (!mapping) return;

  editingMappingId = Number(mapping.id);
  document.getElementById("productSelect").value = String(mapping.product_id);
  document.getElementById("deviceSelect").value = mapping.device_id;
  renderChannelOptions();
  document.getElementById("channelSelect").value = mapping.output_signal;
  document.getElementById("mappingName").value = mapping.mapping_name || "";
  document.getElementById("mappingTitle").textContent = "연결 수정";
  document.getElementById("mappingSubmitButton").textContent = "수정 저장";
  document.getElementById("cancelEditButton").hidden = false;
  setMessage("목록에서 선택한 연결을 수정 중입니다.");
  document.getElementById("mappingForm").scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearEditMode() {
  editingMappingId = null;
  document.getElementById("mappingForm").reset();
  document.getElementById("mappingTitle").textContent = "연결 등록";
  document.getElementById("mappingSubmitButton").textContent = "연결 등록";
  document.getElementById("cancelEditButton").hidden = true;
  renderChannelOptions();
}

function closeDeleteConfirmation(restoreFocus = false) {
  const confirmation = activeDeleteConfirmation;
  if (!confirmation) return;

  activeDeleteConfirmation = null;
  document.removeEventListener("pointerdown", confirmation.onOutsidePointerDown, true);
  document.removeEventListener("keydown", confirmation.onKeyDown);
  window.removeEventListener("resize", confirmation.onViewportChange);
  window.removeEventListener("scroll", confirmation.onViewportChange, true);
  confirmation.popover.remove();
  confirmation.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) confirmation.trigger.focus();
}

function removeMapping(id, trigger) {
  closeDeleteConfirmation();

  const popover = document.createElement("div");
  popover.className = "mapping-confirm-popover";
  popover.setAttribute("role", "alertdialog");
  popover.setAttribute("aria-label", "연결 삭제 확인");
  popover.innerHTML = `
    <p>이 연결을 삭제하시겠습니까?</p>
    <div class="mapping-confirm-actions">
      <button type="button" class="mapping-confirm-cancel">취소</button>
      <button type="button" class="mapping-confirm-delete">삭제</button>
    </div>
  `;

  document.body.append(popover);
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(
    Math.max(margin, triggerRect.right - popoverRect.width),
    window.innerWidth - popoverRect.width - margin
  );
  const above = triggerRect.top - popoverRect.height - margin;
  const top = above >= margin
    ? above
    : Math.min(triggerRect.bottom + margin, window.innerHeight - popoverRect.height - margin);

  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
  trigger.setAttribute("aria-expanded", "true");

  const confirmation = {
    popover,
    trigger,
    onOutsidePointerDown: (event) => {
      if (!popover.contains(event.target) && event.target !== trigger) closeDeleteConfirmation();
    },
    onKeyDown: (event) => {
      if (event.key === "Escape") closeDeleteConfirmation(true);
    },
    onViewportChange: () => closeDeleteConfirmation()
  };
  activeDeleteConfirmation = confirmation;

  popover.querySelector(".mapping-confirm-cancel").addEventListener("click", () => closeDeleteConfirmation(true));
  popover.querySelector(".mapping-confirm-delete").addEventListener("click", () => {
    closeDeleteConfirmation();
    void confirmRemoveMapping(id);
  });
  document.addEventListener("pointerdown", confirmation.onOutsidePointerDown, true);
  document.addEventListener("keydown", confirmation.onKeyDown);
  window.addEventListener("resize", confirmation.onViewportChange);
  window.addEventListener("scroll", confirmation.onViewportChange, true);
  popover.querySelector(".mapping-confirm-cancel").focus();
}

async function confirmRemoveMapping(id) {

  const res = await fetch(`/api/admin/product-channel-mappings/${id}`, {
    method: "DELETE"
  });

  if (handleUnauthorized(res)) return;
  if (await handleForbidden(res)) return;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setMessage(data.error || "연결 삭제에 실패했습니다.", true);
    return;
  }

  setMessage(data.message || "연결이 삭제되었습니다.");
  if (editingMappingId === Number(id)) clearEditMode();
  await loadMappings();
}

async function loadUser() {
  const res = await fetch("/api/me", { cache: "no-store" });
  if (handleUnauthorized(res)) return false;

  const data = await res.json();
  const permissionLevel = Number(data.user.permissionLevel || data.user.permission_level || 1);
  if (permissionLevel < 8) {
    alert("8등급 이상만 접근할 수 있습니다.");
    location.href = "/";
    return false;
  }

  document.getElementById("userInfo").textContent = `${data.user.name}사용자: ${data.user.username}`;
  return true;
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    location.href = "/user-login.html?logged_out=1";
  }
}

window.removeMapping = removeMapping;
window.editMapping = editMapping;

async function init() {
  try {
    const loadedUser = await loadUser();
    if (!loadedUser) return;

    const metaOk = await loadMeta();
    if (!metaOk) return;

    await loadMappings();
    document.getElementById("deviceSelect").addEventListener("change", renderChannelOptions);
    document.getElementById("cancelEditButton").addEventListener("click", () => {
      clearEditMode();
      setMessage("수정이 취소되었습니다.");
    });
    document.getElementById("mappingForm").addEventListener("submit", createMapping);
  } catch (err) {
    console.error(err);
    setMessage("페이지를 불러오지 못했습니다.", true);
  }
}

init();
