const companyFields = ["group", "company", "site", "department", "role"];
const companySuffixes = ["Group", "Company", "Site", "Department", "Role"];
const companyLabels = ["그룹", "회사", "사업장", "부서", "직무"];
const companyFilterFields = ["id", ...companyFields, "status"];
const companyElements = Object.fromEntries(["companyForm", "companyFormTitle", "companyCancel", "companySave", "companyActive", "companyMessage", "companySearch", "companyReload", "companyRows", "companyCount"].map(id => [id, document.getElementById(id)]));
let companyOrganizations = [];
let companyEditingId = null;
let companyBusy = false;
let companySortState = null;
const companyAutoLocked = companyFields.map(() => false);
const companyColumnFilters = new Map();

function companyEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function companyMessage(text, error = false) {
  companyElements.companyMessage.textContent = text;
  companyElements.companyMessage.dataset.error = String(error);
}

function companySetBusy(busy) {
  companyBusy = busy;
  for (const input of companyElements.companyForm.querySelectorAll("input,button")) {
    const nameIndex = companyFields.findIndex((field, index) => input.id === `companyName${companySuffixes[index]}`);
    input.disabled = busy || (nameIndex !== -1 && companyEditingId === null && companyAutoLocked[nameIndex]);
  }
  companyElements.companyCancel.disabled = busy;
  companyElements.companyReload.disabled = busy;
  for (const button of companyElements.companyRows.querySelectorAll("button")) button.disabled = busy || button.dataset.protected === "true";
}

async function companyRequest(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (response.status === 401) location.href = "/user-login.html";
  if (response.status === 403) location.href = "/user-profile.html?access=denied";
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다.");
  return data;
}

function companyRender() {
  const search = companyElements.companySearch.value.trim().toLowerCase();
  const rows = companyOrganizations.filter(row => {
    const active = Number(row.is_active) === 1;
    const haystack = [row.organization_id, ...companyFields.flatMap(field => [row[field], row[`${field}_name`]]), active ? "사용" : "사용 중지"].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    return companyFilterFields.every(field => {
      const selected = companyColumnFilters.get(field);
      const value = companyFilterValue(row, field);
      return !selected || selected.has(value);
    });
  });
  companySortRows(rows);
  companyElements.companyCount.textContent = `전체 ${companyOrganizations.length}개 · 표시 ${rows.length}개`;
  companyElements.companyRows.innerHTML = rows.map(row => {
    const active = Number(row.is_active) === 1;
    const protectedRow = Boolean(row.is_default);
    const organizationCells = companyFields.map(field => `<td><strong>${companyEscape(row[`${field}_name`] || row[field])}</strong><small>${companyEscape(row[field])}</small></td>`).join("");
    return `<tr><td>${companyEscape(row.organization_id)}</td>${organizationCells}<td><span class="device-state ${active ? "is-active" : "is-inactive"}">${active ? "사용" : "사용 중지"}</span></td><td><div class="company-row-actions"><button type="button" data-company-edit="${row.organization_id}" data-protected="${protectedRow}"${protectedRow || companyBusy ? " disabled" : ""}>수정</button><button type="button" data-company-toggle="${row.organization_id}" data-protected="${protectedRow}"${protectedRow || companyBusy ? " disabled" : ""}>${active ? "사용 중지" : "사용"}</button></div></td></tr>`;
  }).join("") || '<tr><td colspan="8" class="empty-state">등록된 회사 조직이 없습니다.</td></tr>';
}

function companyFilterValue(row, field) {
  if (field === "id") return String(row.organization_id);
  if (field === "status") return Number(row.is_active) === 1 ? "active" : "inactive";
  return JSON.stringify([String(row[field]), String(row[`${field}_name`] || row[field])]);
}

function companyApplyColumnFilter(rows, field) {
  const selected = companyColumnFilters.get(field);
  return selected ? rows.filter(row => selected.has(companyFilterValue(row, field))) : rows;
}

function companySortRows(rows) {
  if (!companySortState) return rows;
  const { field, direction } = companySortState;
  const multiplier = direction === "desc" ? -1 : 1;
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  return rows.sort((left, right) => {
    let comparison;
    if (field === "id") {
      comparison = Number(left.organization_id) - Number(right.organization_id);
    } else if (field === "status") {
      const leftStatus = Number(left.is_active) === 1 ? "사용" : "사용 중지";
      const rightStatus = Number(right.is_active) === 1 ? "사용" : "사용 중지";
      comparison = collator.compare(leftStatus, rightStatus);
    } else {
      const leftName = String(left[`${field}_name`] || left[field]);
      const rightName = String(right[`${field}_name`] || right[field]);
      comparison = collator.compare(leftName, rightName) || collator.compare(String(left[field]), String(right[field]));
    }
    return (comparison || Number(left.organization_id) - Number(right.organization_id)) * multiplier;
  });
}

function companyRenderFilters(startIndex = 0) {
  const search = companyElements.companySearch.value.trim().toLowerCase();
  let availableRows = companyOrganizations.filter(row => {
    const active = Number(row.is_active) === 1;
    const haystack = [row.organization_id, ...companyFields.flatMap(field => [row[field], row[`${field}_name`]]), active ? "사용" : "사용 중지"].join(" ").toLowerCase();
    return !search || haystack.includes(search);
  });
  for (const [index, field] of companyFilterFields.entries()) {
    if (index < startIndex) {
      availableRows = companyApplyColumnFilter(availableRows, field);
      continue;
    }
    const container = document.getElementById(`companyFilter${field[0].toUpperCase()}${field.slice(1)}`);
    const values = new Map();
    for (const row of availableRows) {
      const code = String(row[field] ?? "");
      const name = String(row[`${field}_name`] || code);
      const value = companyFilterValue(row, field);
      const label = field === "id" ? value : field === "status" ? (value === "active" ? "사용" : "사용 중지") : `${name} (${code})`;
      values.set(value, label);
    }
    let selected = companyColumnFilters.get(field);
    if (selected) {
      const availableValues = new Set(values.keys());
      const retained = new Set([...selected].filter(value => availableValues.has(value)));
      if (retained.size !== selected.size) {
        if (selected.size > 0 && retained.size === 0) companyColumnFilters.delete(field);
        else companyColumnFilters.set(field, retained);
        selected = companyColumnFilters.get(field);
      }
    }
    const allSelected = !selected || (values.size > 0 && selected.size === values.size);
    const options = [...values].sort((left, right) => left[1].localeCompare(right[1], "ko")).map(([value, label]) => `<label class="company-filter-option" data-filter-label="${companyEscape(label.toLowerCase())}"><input type="checkbox" data-column-filter="${field}" value="${companyEscape(value)}"${allSelected || selected.has(value) ? " checked" : ""}><span>${companyEscape(label)}</span></label>`).join("");
    const label = field === "id" ? "id" : field === "status" ? "상태" : companyLabels[companyFields.indexOf(field)];
    const applied = Boolean(selected && (selected.size !== values.size || selected.size === 0));
    const sortButtons = ["asc", "desc"].map(direction => `<button type="button" data-company-sort="${field}" data-sort-direction="${direction}" aria-pressed="${companySortState?.field === field && companySortState.direction === direction}">${direction === "asc" ? "오름차순" : "내림차순"}</button>`).join("");
    container.innerHTML = `<button type="button" class="company-filter-trigger${applied ? " is-filtered" : ""}" data-filter-toggle="${field}" aria-label="${label} 값 필터" aria-expanded="false" title="${label} 값 필터"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14l-5.5 6.3v4.2l-3 1.5v-5.7L3 4Z"/></svg></button><div class="company-filter-menu" hidden><div class="company-filter-sort-actions">${sortButtons}</div><input type="search" class="company-filter-search" data-filter-search="${field}" placeholder="값 검색" aria-label="필터 값 검색"><label class="company-filter-option company-filter-all"><input type="checkbox" data-filter-all="${field}"${allSelected ? " checked" : ""}><span>모든 값</span></label><div class="company-filter-options">${options}</div></div>`;
    availableRows = companyApplyColumnFilter(availableRows, field);
  }
}

function companyCloseFilters() {
  for (const menu of document.querySelectorAll(".company-filter-menu:not([hidden])")) {
    menu.hidden = true;
    menu.parentElement.querySelector("[data-filter-toggle]").setAttribute("aria-expanded", "false");
  }
}

function companyPositionFilterMenu(trigger, menu) {
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  const bounds = trigger.getBoundingClientRect();
  const left = Math.max(8, Math.min(bounds.left, innerWidth - Math.min(menu.offsetWidth, 260) - 8));
  const top = Math.min(bounds.bottom, innerHeight - Math.min(menu.offsetHeight, 340) - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function companyUpdateFilterTrigger(field, selected, optionCount) {
  const trigger = document.querySelector(`[data-filter-toggle="${field}"]`);
  if (!trigger) return;
  const applied = Boolean(selected && (selected.size !== optionCount || selected.size === 0));
  const label = field === "id" ? "id" : field === "status" ? "상태" : companyLabels[companyFields.indexOf(field)];
  trigger.classList.toggle("is-filtered", applied);
  trigger.title = applied ? `${label} 필터 적용 중 (${selected.size}/${optionCount})` : `${label} 값 필터`;
  trigger.setAttribute("aria-label", trigger.title);
}

function companyApplyAutomaticNames(resetFrom = -1) {
  if (companyEditingId !== null) {
    companyAutoLocked.fill(false);
    companyFields.forEach((field, index) => { document.getElementById(`companyName${companySuffixes[index]}`).disabled = companyBusy; });
    return;
  }
  if (resetFrom >= 0) {
    for (let index = resetFrom; index < companyFields.length; index++) document.getElementById(`companyName${companySuffixes[index]}`).value = "";
  }
  const codes = Object.fromEntries(companyFields.map((field, index) => [field, document.getElementById(`companyCode${companySuffixes[index]}`).value.trim().normalize("NFC").toUpperCase()]));
  for (let index = 0; index < companyFields.length; index++) {
    const field = companyFields[index];
    const prefixIsComplete = Boolean(codes.group) && companyFields.slice(0, index + 1).every(prefix => !codes[prefix] || /^[\p{L}\p{N}]{3}$/u.test(codes[prefix]));
    const match = codes[field] && prefixIsComplete && companyOrganizations.find(row => companyFields.slice(0, index + 1).every(prefix => (row[prefix] ?? "") === codes[prefix]));
    const name = document.getElementById(`companyName${companySuffixes[index]}`);
    const defaultPlaceholder = name.dataset.defaultPlaceholder ?? name.placeholder;
    name.dataset.defaultPlaceholder = defaultPlaceholder;
    const parentsAreSpecified = prefixIsComplete;
    const currentCodeIsSpecified = /^[\p{L}\p{N}]{3}$/u.test(codes[field]);
    name.placeholder = parentsAreSpecified && currentCodeIsSpecified && !match ? "새로운 명칭 입력" : defaultPlaceholder;
    companyAutoLocked[index] = Boolean(match);
    if (match) name.value = match[`${field}_name`] || match[field];
    name.disabled = companyBusy || companyAutoLocked[index];
  }
}

async function companyLoad() {
  if (companyBusy) return;
  companySetBusy(true);
  try {
    const data = await companyRequest("/api/admin/companies");
    companyOrganizations = data.organizations;
    companyRenderFilters();
    companyRender();
  } catch (error) { companyMessage(error.message, true); }
  finally { companySetBusy(false); companyApplyAutomaticNames(); }
}

function companyReset(clearMessage = true) {
  companyEditingId = null;
  companyElements.companyForm.reset();
  for (const suffix of companySuffixes) document.getElementById(`companyCode${suffix}`).readOnly = false;
  companyAutoLocked.fill(false);
  companyApplyAutomaticNames();
  companyElements.companyFormTitle.textContent = "신규 회사 조직";
  companyElements.companySave.textContent = "등록";
  companyElements.companyCancel.hidden = true;
  if (clearMessage) companyMessage("");
}

function companyPayload(row) {
  return {
    codes: Object.fromEntries(companyFields.map(field => [field, row[field]])),
    names: Object.fromEntries(companyFields.map(field => [`${field}_name`, row[field] == null ? null : row[`${field}_name`] || row[field]])),
    is_active: Number(row.is_active) === 1
  };
}

function companyNameHierarchyError(codes, names) {
  for (const [index, field] of companyFields.entries()) {
    if (index > 0 && codes[field] === null && names[`${field}_name`] === null) continue;
    const parents = companyFields.slice(0, index);
    const siblings = companyOrganizations.filter(row => parents.every(parent => row[parent] === codes[parent]));
    const name = names[`${field}_name`];
    const sameCodeNames = siblings.filter(row => row[field] === codes[field]).map(row => row[`${field}_name`] || row[field]);
    if (sameCodeNames.some(existingName => existingName !== name)) return `${companyLabels[index]} 코드 ${codes[field]}는 이미 다른 명칭으로 등록되어 있습니다.`;
    if (siblings.some(row => row[field] !== codes[field] && (row[`${field}_name`] || row[field]) === name)) return `${companyLabels[index]} 명칭은 같은 상위 조직의 다른 코드에서 이미 사용 중입니다.`;
  }
  return "";
}

companyElements.companyForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (companyBusy) return;
  const codes = {};
  const names = {};
  for (const [index, field] of companyFields.entries()) {
    const code = document.getElementById(`companyCode${companySuffixes[index]}`).value.trim().normalize("NFC").toUpperCase();
    const name = document.getElementById(`companyName${companySuffixes[index]}`).value.trim();
    if (index === 0 && (!code || !name)) { companyMessage("그룹 코드와 그룹 이름은 필수입니다.", true); return; }
    if (!code && !name) {
      codes[field] = null; names[`${field}_name`] = null;
      continue;
    }
    if (!/^[\p{L}\p{N}]{3}$/u.test(code)) { companyMessage(`${companyLabels[index]} 코드는 문자 또는 숫자 3자리로 입력하세요.`, true); return; }
    if (name === "미지정" && code !== "DEF") { companyMessage(`${companyLabels[index]} 코드가 지정된 경우 명칭을 미지정으로 등록할 수 없습니다.`, true); return; }
    if (!name) { companyMessage(`${companyLabels[index]} 이름을 입력하세요.`, true); return; }
    codes[field] = code;
    names[`${field}_name`] = name;
  }
  const nameError = companyNameHierarchyError(codes, names);
  if (nameError) { companyMessage(nameError, true); return; }
  const body = { codes, names, is_active: companyElements.companyActive.checked };
  const editing = companyEditingId !== null;
  companySetBusy(true);
  try {
    await companyRequest(editing ? `/api/admin/companies/${companyEditingId}` : "/api/admin/companies", { method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    companyMessage(editing ? "회사 조직을 저장했습니다." : "회사 조직을 등록했습니다.");
    companyReset(false);
  } catch (error) { companyMessage(error.message, true); return; }
  finally { companySetBusy(false); }
  await companyLoad();
});

companyElements.companyRows.addEventListener("click", async event => {
  const edit = event.target.closest("[data-company-edit]");
  const toggle = event.target.closest("[data-company-toggle]");
  if (companyBusy || (!edit && !toggle)) return;
  const row = companyOrganizations.find(item => Number(item.organization_id) === Number(edit?.dataset.companyEdit || toggle?.dataset.companyToggle));
  if (!row || row.is_default) return;
  if (edit) {
    companyEditingId = row.organization_id;
    companyFields.forEach((field, index) => {
      const code = document.getElementById(`companyCode${companySuffixes[index]}`);
      code.value = row[field] ?? ""; code.readOnly = true;
      document.getElementById(`companyName${companySuffixes[index]}`).value = row[`${field}_name`] ?? row[field] ?? "";
    });
    companyElements.companyActive.checked = Number(row.is_active) === 1;
    companyFields.forEach((field, index) => { document.getElementById(`companyName${companySuffixes[index]}`).disabled = false; companyAutoLocked[index] = false; });
    companyElements.companyFormTitle.textContent = "회사 조직 수정";
    companyElements.companySave.textContent = "변경 저장";
    companyElements.companyCancel.hidden = false;
    companyMessage("");
    document.getElementById("companyNameCompany").focus();
    return;
  }
  const body = companyPayload(row);
  body.is_active = !body.is_active;
  companySetBusy(true);
  try {
    await companyRequest(`/api/admin/companies/${row.organization_id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    companyMessage(body.is_active ? "회사 조직을 사용하도록 변경했습니다." : "회사 조직을 사용 중지했습니다.");
  } catch (error) { companyMessage(error.message, true); return; }
  finally { companySetBusy(false); }
  await companyLoad();
});

for (const [index, suffix] of companySuffixes.entries()) document.getElementById(`companyCode${suffix}`).addEventListener("input", event => {
  event.target.value = event.target.value.normalize("NFC").toUpperCase();
  companyApplyAutomaticNames(index);
});
companyElements.companyCancel.addEventListener("click", () => companyReset());
companyElements.companySearch.addEventListener("input", () => { companyRenderFilters(); companyRender(); });
companyElements.companyReload.addEventListener("click", companyLoad);
document.querySelector(".company-table thead").addEventListener("change", event => {
  const field = event.target.dataset.columnFilter;
  const selectAllField = event.target.dataset.filterAll;
  if (selectAllField) {
    const options = [...document.querySelectorAll(`[data-column-filter="${selectAllField}"]`)];
    if (event.target.checked) {
      companyColumnFilters.delete(selectAllField);
      options.forEach(input => { input.checked = true; });
    } else {
      companyColumnFilters.set(selectAllField, new Set());
      options.forEach(input => { input.checked = false; });
    }
    companyUpdateFilterTrigger(selectAllField, companyColumnFilters.get(selectAllField), options.length);
    companyRenderFilters(companyFilterFields.indexOf(selectAllField) + 1);
    companyRender();
    return;
  }
  if (!field) return;
  const selected = new Set([...document.querySelectorAll(`[data-column-filter="${field}"]:checked`)].map(input => input.value));
  const optionCount = document.querySelectorAll(`[data-column-filter="${field}"]`).length;
  if (selected.size === optionCount) companyColumnFilters.delete(field);
  else companyColumnFilters.set(field, selected);
  const menu = event.target.closest(".company-filter-menu");
  menu.querySelector("[data-filter-all]").checked = selected.size === optionCount;
  companyUpdateFilterTrigger(field, companyColumnFilters.get(field), optionCount);
  companyRenderFilters(companyFilterFields.indexOf(field) + 1);
  companyRender();
});
document.querySelector(".company-table thead").addEventListener("input", event => {
  const field = event.target.dataset.filterSearch;
  if (!field) return;
  const search = event.target.value.trim().toLowerCase();
  for (const option of document.querySelectorAll(`#companyFilter${field[0].toUpperCase()}${field.slice(1)} .company-filter-option[data-filter-label]`)) option.hidden = !option.dataset.filterLabel.includes(search);
});
document.querySelector(".company-table thead").addEventListener("click", event => {
  const sortButton = event.target.closest("[data-company-sort]");
  if (sortButton) {
    companySortState = { field: sortButton.dataset.companySort, direction: sortButton.dataset.sortDirection };
    companyCloseFilters();
    companyRenderFilters();
    companyRender();
    return;
  }
  const trigger = event.target.closest("[data-filter-toggle]");
  if (!trigger) return;
  const menu = trigger.parentElement.querySelector(".company-filter-menu");
  const wasOpen = !menu.hidden;
  companyCloseFilters();
  if (!wasOpen) companyPositionFilterMenu(trigger, menu);
});
document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".company-column-filter")) companyCloseFilters();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") companyCloseFilters(); });
window.addEventListener("scroll", companyCloseFilters, true);
window.addEventListener("resize", companyCloseFilters);
void companyLoad();