function createProductSelection(page, onChange) {
  const button = document.getElementById("productSelectButton");
  const count = document.getElementById("productSelectionCount");
  const dialog = document.getElementById("productPicker");
  const form = document.getElementById("productPickerForm");
  const selectAll = document.getElementById("productSelectAll");
  const choices = document.getElementById("productPickerChoices");
  const empty = document.getElementById("productPickerEmpty");
  const cancel = document.getElementById("productPickerCancel");
  const message = document.getElementById("productPickerMessage");
  const submit = form.querySelector('button[type="submit"]');
  let products = [];
  let selectedIds = null;
  let loaded = false;
  let saving = false;
  let userKey = "";
  button.disabled = true;

  function validateSelection(selection) {
    if (selection !== "*" && (!Array.isArray(selection) || selection.some(id =>
      typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))) {
      throw new Error("저장된 제품 선택 설정의 형식이 올바르지 않습니다.");
    }
    return selection;
  }

  async function requestSelection(options = {}) {
    const response = await fetch(`/api/me/product-selection/${page}`, { cache: "no-store", ...options });
    const data = await response.json();
    if (response.status === 401) location.href = "/user-login.html";
    if (response.status === 403 && data.code === "SUSPENDED") location.href = data.redirect || "/user-profile.html?pending=1";
    if (!response.ok) throw new Error(data.error || "제품 선택 설정을 처리하지 못했습니다.");
    return data.selection;
  }

  function saveSelection(selection) {
    return requestSelection({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection })
    });
  }

  function renderCount() {
    if (!loaded) return;
    const selectedCount = selectedIds === null
      ? products.length
      : products.filter(product => selectedIds.has(String(product.id))).length;
    count.textContent = `${selectedCount}개 제품 표시`;
  }

  function renderChoices() {
    message.textContent = "";
    const allSelected = selectedIds === null || (products.length > 0 && products.every(product => selectedIds.has(String(product.id))));
    selectAll.checked = allSelected;
    choices.innerHTML = products.map(product => {
      const id = String(product.id);
      const checked = selectedIds === null || selectedIds.has(id);
      return `<label class="product-picker-option">
        <input type="checkbox" value="${escapeHtml(id)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(product.product_name)} <small>${escapeHtml(product.product_code)}</small></span>
      </label>`;
    }).join("");
    empty.hidden = products.length > 0;
  }

  function openPicker() {
    renderChoices();
    dialog.showModal();
  }

  button.addEventListener("click", async () => {
    if (!loaded) await load(userKey);
    if (loaded) openPicker();
  });
  cancel.addEventListener("click", () => dialog.close());
  selectAll.addEventListener("change", () => {
    choices.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = selectAll.checked; });
  });
  choices.addEventListener("change", () => {
    const checkboxes = [...choices.querySelectorAll('input[type="checkbox"]')];
    selectAll.checked = checkboxes.length > 0 && checkboxes.every(input => input.checked);
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!loaded || saving) return;
    const checkedIds = [...choices.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
    const selection = selectAll.checked ? "*" : checkedIds;
    saving = true;
    submit.disabled = cancel.disabled = true;
    message.textContent = "제품 선택을 저장하고 있습니다...";
    try {
      const saved = validateSelection(await saveSelection(selection));
      selectedIds = saved === "*" ? null : new Set(saved);
      renderCount();
      dialog.close();
      onChange();
    } catch (error) {
      console.error("제품 선택 저장 오류:", error);
      message.textContent = error.message;
    } finally {
      saving = false;
      submit.disabled = cancel.disabled = false;
    }
  });
  dialog.addEventListener("cancel", event => {
    if (saving) event.preventDefault();
  });

  async function load(username) {
    userKey = username;
    button.disabled = true;
    count.textContent = "제품 선택을 불러오는 중...";
    try {
      let saved = await requestSelection();
      if (saved === null) {
        let legacy = null;
        try {
          legacy = localStorage.getItem(`factory.product-selection.${page}.${userKey}`);
        } catch (error) {
          console.warn("이전 브라우저 제품 선택을 읽지 못했습니다.", error);
        }
        saved = legacy === null ? "*" : validateSelection(JSON.parse(legacy));
        if (legacy !== null) {
          saved = await saveSelection(saved);
        }
      }
      validateSelection(saved);
      selectedIds = saved === "*" ? null : new Set(saved);
      loaded = true;
      renderCount();
      onChange();
    } catch (error) {
      console.error("제품 선택 조회 오류:", error);
      count.textContent = `${error.message} 제품 선택 버튼을 눌러 다시 시도하세요.`;
    } finally {
      button.disabled = false;
    }
  }

  return {
    load,
    setProducts(nextProducts) {
      products = nextProducts;
      renderCount();
    },
    getVisibleProducts() {
      if (!loaded) return [];
      return selectedIds === null
        ? products
        : products.filter(product => selectedIds.has(String(product.id)));
    }
  };
}
