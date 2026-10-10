
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
      document.getElementById("controls").innerHTML = products.map(p => `
    <div class="control-card">
      <div class="product-title">
        <b>${escapeHtml(p.product_name)}</b>
        <span>${escapeHtml(p.product_code)}</span>
      </div>

      <div class="quantity-input">
        <input id="q-${p.id}" type="number" min="0" value="${p.quantity}">
        <button onclick="saveQuantity(${p.id})">저장</button>
      </div>

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
    }

    async function saveQuantity(id) {
      const quantity = Number(document.getElementById(`q-${id}`).value);

      const res = await fetch(`/api/products/${id}/quantity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity })
      });

      if (handleUnauthorized(res)) return;
      if (await handleSuspended(res)) return;

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "수량 저장에 실패했습니다.");
        return;
      }

      const product = await res.json();
      updateLocal(product);
      render();
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

        if (data.type === "products") {
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
      if (Number(data.user.permissionLevel || data.user.permission_level || 1) >= 8) document.getElementById('adminLink').style.display = 'inline-block';
      if (Number(data.user.permissionLevel || data.user.permission_level || 1) >= 6) document.getElementById('productAdminLink').style.display = 'inline-block';
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
  