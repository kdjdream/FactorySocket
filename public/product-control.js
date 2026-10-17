
    // 생산 입력: 수량과 상태를 별도 API로 저장하고 WebSocket으로 다른 화면의 변경도 반영합니다.
    let products = [];

    function handleUnauthorized(res) {
      if (res.status === 401) {
        alert("로그인이 필요합니다.");
        location.href = "/user-login.html";
        return true;
      }
      return false;
    }

    // 정지(SUSPENDED)된 계정은 로그아웃이 아니라 회원정보 화면으로 이동시킵니다.
    async function handleSuspended(res) {
      if (res.status === 403) {
        const data = await res.clone().json().catch(() => ({}));
        if (data.code === "SUSPENDED") {
          location.href = data.redirect || "/user-profile.html?pending=1";
          return true;
        }
      }
      return false;
    }

    async function loadProducts() {
      try {
        const res = await fetch("/api/products");

        if (handleUnauthorized(res)) return;
        if (await handleSuspended(res)) return;

        if (!res.ok) {
          throw new Error("제품 데이터를 가져오지 못했습니다.");
        }

        products = await res.json();
        render();
      } catch (err) {
        console.error(err);
        document.getElementById("connection").textContent =
          "○ 데이터 조회 오류";
      }
    }

    function render() {
      const controls = document.getElementById("controls");
      const drafts = [...(controls.querySelectorAll?.("input") || [])].filter(input => input.value !== input.defaultValue).map(input => ({ id: input.id, value: input.value }));
      const focused = document.activeElement?.id;
      controls.innerHTML = products.map(p => `
    <div class="control-card">
      <div class="product-title">
        <b>${escapeHtml(p.product_name)}</b>
        <span>${escapeHtml(p.product_code)}</span>
      </div>

      <form class="product-quantity-form" onsubmit="saveQuantity(${p.id}, 'production', event); return false;">
        <label for="q-production-${p.id}">추가 작업 수량</label>
        <div class="quantity-input">
          <input id="q-production-${p.id}" type="number" min="-2147483647" max="2147483647" step="1" placeholder="추가할 수량" value="" required>
          <button type="submit">수량 추가</button>
        </div>
        <label class="quantity-reason" for="reason-production-${p.id}">작업 내용
          <input id="reason-production-${p.id}" type="text" maxlength="500" required>
        </label>
      </form>

      <div class="status-row">
        <label>상태</label>
        <select onchange="saveStatus(${p.id}, this.value)">
          ${["대기", "생산중", "수리중", "완료", "정지"].map(s =>
        `<option ${s === p.status ? "selected" : ""}>${s}</option>`
      ).join("")}
        </select>
      </div>
    </div>
  `).join("");
      for (const draft of drafts) {
        const input = document.getElementById(draft.id);
        if (input) input.value = draft.value;
      }
      if (focused) document.getElementById(focused)?.focus();
    }

    async function saveQuantity(id, kind = "production", event) {
      event?.preventDefault();
      if (kind !== "production") return;
      const input = document.getElementById(`q-${kind}-${id}`);
      const reasonInput = document.getElementById(`reason-${kind}-${id}`);
      const quantity = Number(input.value);
      const reason = reasonInput.value.trim();
      if (!input.value.trim() || !Number.isInteger(quantity) || quantity < -2147483647 || quantity > 2147483647 || !reason) {
        alert("올바른 수량과 수정 사유를 입력하세요.");
        return;
      }
      const button = event?.submitter;
      if (button) button.disabled = true;
      try {
      const res = await fetch(`/api/products/${id}/quantity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, quantity, reason })
      });

      if (handleUnauthorized(res)) return;
      if (await handleSuspended(res)) return;

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "수량 저장에 실패했습니다.");
        return;
      }

      const product = await res.json();
      const liveInput = document.getElementById(`q-${kind}-${id}`) || input;
      const liveReason = document.getElementById(`reason-${kind}-${id}`) || reasonInput;
      if (liveInput.value.trim() && Number(liveInput.value) === quantity) {
        liveInput.value = "";
        liveInput.defaultValue = "";
      }
      if (liveReason.value.trim() === reason) {
        liveReason.value = "";
        liveReason.defaultValue = "";
      }
      updateLocal(product);
      render();
      } catch (error) {
        alert("수량 저장 중 서버에 연결하지 못했습니다.");
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function saveStatus(id, status) {
      const res = await fetch(`/api/products/${id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });

      if (handleUnauthorized(res)) return;
      if (await handleSuspended(res)) return;

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "상태 저장에 실패했습니다.");
        return;
      }

      const product = await res.json();
      updateLocal(product);
      render();
    }

    function updateLocal(product) {
      const index = products.findIndex(p => p.id === product.id);
      if (index >= 0) products[index] = product;
    }

    function connectWebSocket() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}`);
      window.factoryRealtimeSocket = ws;
      window.dispatchEvent(new CustomEvent("factory-socket-created", { detail: ws }));
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
        if (event.code === 4001) {
          location.href = "/user-profile.html?pending=1";
          return;
        }

        if (event.code === 1008) {
          location.href = "/user-login.html";
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
          products = data.products;
          render();
        } else if (
          data.type === "quantityUpdated" ||
          data.type === "productUpdated"
        ) {
          updateLocal(data.product);
          render();
        }
      };
    }

    async function loadUser() {
      const res = await fetch("/api/me");

      if (handleUnauthorized(res)) return;

      const data = await res.json();
      document.getElementById("userInfo").textContent =
        `${data.user.name}사용자: ${data.user.username}`;
      const permissionLevel = Number(data.user.permissionLevel || data.user.permission_level || 1);
      if (permissionLevel >= 8) {
        const productChannelLink = document.getElementById("productChannelLink");
        if (productChannelLink) productChannelLink.style.display = "inline-block";
      }
      if (permissionLevel >= 7) document.getElementById("productAdminLink").style.display = "inline-block";
    }

    async function logout() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } finally {
        location.href = "/user-login.html?logged_out=1";
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
  