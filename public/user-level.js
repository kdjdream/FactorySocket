const levelElements = Object.fromEntries(["levelPolicyRows", "levelPolicyReload", "levelPolicyDefaults", "levelPolicySave", "levelPolicyMessage", "levelPolicyVersion", "levelPolicyDirty"].map(id => [id, document.getElementById(id)]));
let levelFeatures = [];
let levelSites = [];
let levelSaved = {};
let levelDraft = {};
let levelRevision = "";
let levelBusy = false;

function levelEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function levelDirtyCount() {
  return levelFeatures.filter(feature => levelDraft[feature.key] !== levelSaved[feature.key]).length;
}

function levelApplySites(data) {
  const sites = data.sites;
  if (!Array.isArray(sites)) throw new Error("사이트 권한 행을 불러오지 못했습니다.");
  const values = {};
  for (const feature of levelFeatures) {
    const site = sites.find(row => row.site_name === feature.site_name);
    if (!site || !Number.isInteger(site.permisson_lebel) || site.permisson_lebel < 1 || site.permisson_lebel > 20 || !Number.isInteger(site.default_leble) || site.default_leble < 1 || site.default_leble > 20) throw new Error("사이트 권한 정보가 올바르지 않습니다. 다시 불러오세요.");
    values[feature.key] = site.permisson_lebel;
  }
  levelSites = sites;
  levelSaved = { ...values };
  levelDraft = { ...values };
  levelRevision = data.revision;
}

function levelUpdateControls() {
  const count = levelDirtyCount();
  levelElements.levelPolicyDirty.textContent = count ? `변경 ${count}건` : "";
  levelElements.levelPolicySave.disabled = levelBusy || !count;
  levelElements.levelPolicyDefaults.disabled = levelBusy || !levelFeatures.length;
  levelElements.levelPolicyReload.disabled = levelBusy;
  for (const row of levelElements.levelPolicyRows.querySelectorAll(".level-policy-row")) {
    row.classList.toggle("is-dirty", levelDraft[row.dataset.key] !== levelSaved[row.dataset.key]);
    const locked = levelFeatures.find(feature => feature.key === row.dataset.key)?.locked;
    for (const input of row.querySelectorAll("input")) input.disabled = levelBusy || Boolean(locked);
  }
}

function levelRender() {
  levelElements.levelPolicyRows.innerHTML = levelFeatures.map(feature => `<tr class="level-policy-row" data-key="${feature.key}" data-group="${levelEscape(feature.group)}">
    <th scope="row"><span class="level-policy-label"><strong id="level-label-${feature.key}">${levelEscape(feature.label)}</strong><small>${levelEscape(feature.group)}${feature.locked ? " · 고정" : ""}</small><small class="level-policy-site">${levelEscape(feature.site_name)}</small></span></th>
    <td><div class="level-policy-track" style="--minimum-level:${levelDraft[feature.key]}"><span class="level-policy-bar" aria-hidden="true"></span><input type="range" min="1" max="20" step="1" value="${levelDraft[feature.key]}" aria-labelledby="level-label-${feature.key}" data-level-range></div></td>
    <td><input class="level-policy-number" type="number" min="1" max="20" step="1" value="${levelDraft[feature.key]}" aria-label="${levelEscape(feature.label)} 최소 레벨" data-level-number></td>
  </tr>`).join("");
  levelElements.levelPolicyVersion.textContent = `레벨 1~20 · ${levelSites.length}개 사이트`;
  levelUpdateControls();
}

async function levelRequest(options) {
  const response = await fetch("/api/admin/level-permissions", { cache: "no-store", ...options });
  if (response.status === 401) location.href = "/user-login.html";
  if (response.status === 403) location.href = "/user-profile.html?access=denied";
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "레벨 권한 요청에 실패했습니다.");
  return data;
}

async function levelLoad() {
  if (levelBusy) return;
  if (levelDirtyCount() && !confirm("저장하지 않은 변경을 버리고 다시 불러오시겠습니까?")) return;
  levelBusy = true;
  levelUpdateControls();
  try {
    const data = await levelRequest();
    levelFeatures = data.features;
    levelApplySites(data);
    levelElements.levelPolicyMessage.textContent = "";
    levelElements.levelPolicyMessage.dataset.error = "false";
    levelRender();
  } catch (error) {
    levelElements.levelPolicyMessage.textContent = error.message;
    levelElements.levelPolicyMessage.dataset.error = "true";
  } finally { levelBusy = false; levelUpdateControls(); }
}

levelElements.levelPolicyRows.addEventListener("input", event => {
  const row = event.target.closest(".level-policy-row");
  if (!row || levelBusy || levelFeatures.find(feature => feature.key === row.dataset.key)?.locked) return;
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1 || value > 20) { event.target.setCustomValidity("1~20 사이의 정수를 입력하세요."); return; }
  event.target.setCustomValidity("");
  levelDraft[row.dataset.key] = value;
  row.querySelector(".level-policy-track").style.setProperty("--minimum-level", value);
  for (const input of row.querySelectorAll("input")) {
    input.setCustomValidity("");
    if (input !== event.target) input.value = value;
  }
  levelUpdateControls();
});
levelElements.levelPolicySave.addEventListener("click", async () => {
  if (levelBusy || !levelDirtyCount()) return;
  const invalid = [...levelElements.levelPolicyRows.querySelectorAll("input")].find(input => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  levelBusy = true;
  levelUpdateControls();
  try {
    const bySite = new Map(levelFeatures.map(feature => [feature.site_name, feature.key]));
    const sites = levelSites.map(site => ({ poicy_id: site.poicy_id, site_name: site.site_name, permisson_lebel: levelDraft[bySite.get(site.site_name)] }));
    const data = await levelRequest({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sites, revision: levelRevision }) });
    levelApplySites(data);
    levelRender();
    levelElements.levelPolicyMessage.textContent = "레벨 권한이 저장되었습니다.";
    levelElements.levelPolicyMessage.dataset.error = "false";
    void window.refreshPageUser?.();
  } catch (error) {
    levelElements.levelPolicyMessage.textContent = error.message;
    levelElements.levelPolicyMessage.dataset.error = "true";
  } finally { levelBusy = false; levelUpdateControls(); }
});
levelElements.levelPolicyDefaults.addEventListener("click", () => {
  const defaults = new Map(levelSites.map(site => [site.site_name, site.default_leble]));
  levelDraft = Object.fromEntries(levelFeatures.map(feature => [feature.key, defaults.get(feature.site_name)]));
  levelRender();
});
levelElements.levelPolicyReload.addEventListener("click", levelLoad);
window.addEventListener("beforeunload", event => {
  if (!levelDirtyCount()) return;
  event.preventDefault();
  event.returnValue = "";
});
document.querySelector(".level-policy-axis").innerHTML = Array.from({ length: 20 }, (_, index) => `<span>${index + 1}</span>`).join("");
void levelLoad();