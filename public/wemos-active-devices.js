(() => {
  const escapeHtml = value =>
    String(value ?? "").replace(/[&<>'"]/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[character]);

  const liveStates = new Map();
  const connectionStates = new Map();

  function applyLiveState(message) {
    const deviceId = String(message.deviceId || "");
    const pin = String(message.pin || "").toUpperCase();
    const state = String(message.state || "").toUpperCase();

    if (!deviceId || !/^OS[1-8]$/.test(pin)) return;
    if (!["ON", "OFF"].includes(state)) return;

    /*
     * 장치 ID + 출력 핀을 함께 사용합니다.
     * 여러 Wemos가 연결되어도 다른 장치의 같은 핀이 잘못 바뀌지 않습니다.
     */
    const deviceSelector =
      `[data-device-id="${CSS.escape(deviceId)}"]`;

    document
      .querySelectorAll(`${deviceSelector} [data-active-pin="${CSS.escape(pin)}"]`)
      .forEach(indicator => {
        indicator.textContent = state;
        indicator.dataset.state = state;
      });

    document
      .querySelectorAll(
        `${deviceSelector} [data-active-command="true"][data-pin="${CSS.escape(pin)}"]`
      )
      .forEach(button => {
        const active = button.dataset.state === state;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
  }

  function applyLiveString(message) {
    const deviceId = String(message.deviceId || "");
    const pin = String(message.pin || "").toUpperCase();
    if (!deviceId || !/^OS[1-8]$/.test(pin)) return;
    const deviceSelector = `[data-device-id="${CSS.escape(deviceId)}"]`;
    document.querySelectorAll(`${deviceSelector} [data-active-input-string="${CSS.escape(message.inputPin || `IS${pin.slice(2)}`)}"]`)
      .forEach(el => el.textContent = String(message.IStr || ""));
    document.querySelectorAll(`${deviceSelector} [data-active-output-string="${CSS.escape(pin)}"]`)
      .forEach(el => el.textContent = String(message.OStr || ""));
  }

  // wemos.js에서 WebSocket 이벤트를 직접 호출할 수 있도록 공개합니다.
  window.applyWemosActiveLiveState = applyLiveState;

  function applyConnectionState(message) {
    const deviceId = String(message.deviceId || "");
    if (!deviceId) return;

    connectionStates.set(deviceId, Boolean(message.connected));

    document
      .querySelectorAll(
        `[data-device-connection="${CSS.escape(deviceId)}"]`
      )
      .forEach(indicator => {
        indicator.textContent = message.connected
          ? "연결됨"
          : "연결 안 됨";

        indicator.classList.toggle(
          "is-connected",
          Boolean(message.connected)
        );

        indicator.classList.toggle(
          "is-disconnected",
          !message.connected
        );
      });
  }

  function render(devices) {
    const legacyGrid = document.querySelector(".channel-grid");
    const root = document.getElementById("activeWemosWindows");

    if (!root) return;

    const viewOnly = location.pathname.includes("wemos-view");

    if (legacyGrid) legacyGrid.hidden = true;

    root.hidden = false;

    root.innerHTML = devices.length
      ? devices.map((device, deviceIndex) => `
        <section
          class="active-wemos-window"
          data-device-id="${escapeHtml(device.device_id)}"
          aria-labelledby="device-${escapeHtml(device.device_id)}"
        >
          <div class="active-wemos-heading">
            <div class="active-wemos-device-info">
              <span class="channel-number">장치 ${deviceIndex + 1}</span>
              <h3 id="device-${escapeHtml(device.device_id)}">
                ${escapeHtml(device.device_name || device.device_id)}
              </h3>
              <code>${escapeHtml(device.device_id)}</code>
            </div>

            <div class="active-wemos-status">
              <span
                class="device-state ${device.deviceConnected ? "is-connected" : "is-disconnected"}"
                data-device-connection="${escapeHtml(device.device_id)}"
              >
                ${device.deviceConnected ? "연결됨" : "연결 안 됨"}
              </span>
            </div>
          </div>

          <div class="active-wemos-channels">
            ${(device.sets || []).map((set, index) => {
              const state = set.current_state === "ON" ? "ON" : "OFF";

              return `
                <article class="channel-card channel-${escapeHtml(String(set.output_pin).toLowerCase())}">
                  <div class="channel-card-head">
                    <div>
                      <span class="channel-number">
                        CHANNEL ${String(index + 1).padStart(2, "0")}
                      </span>
                      <h3>${escapeHtml(set.set_name)}</h3>
                    </div>

                    <div class="output-readout">
                      <span>현재 OS 상태</span>
                      <b
                        class="pin-state"
                        data-active-pin="${escapeHtml(set.output_pin)}"
                        data-state="${state}"
                      >
                        ${state}
                      </b>
                    </div>
                  </div>

                  <div class="signal-path">
                    <span class="signal-pin">${escapeHtml(set.input_signal)}</span>
                    <span>입력 신호</span>
                    <span class="signal-arrow" aria-hidden="true">→</span>
                    <strong>${escapeHtml(set.output_signal)} 출력 신호</strong>
                  </div>
                  <div class="signal-strings">
                    <span>IStr: <code data-active-input-string="${escapeHtml(set.input_pin)}">${escapeHtml(set.input_string || "")}</code></span>
                    <span>OStr: <code data-active-output-string="${escapeHtml(set.output_pin)}">${escapeHtml(set.output_string || "")}</code></span>
                  </div>

                  ${
                    viewOnly
                      ? ""
                      : `
                        <div
                          class="channel-actions"
                          role="group"
                          aria-label="${escapeHtml(set.set_name)} 출력 조작"
                        >
                          <button
                            class="output-button${state === "ON" ? " is-active" : ""}"
                            type="button"
                            data-active-command="true"
                            data-device-id="${escapeHtml(device.device_id)}"
                            data-pin="${escapeHtml(set.output_pin)}"
                            data-state="ON"
                            aria-pressed="${state === "ON"}"
                          >
                            <span>ON</span>
                            <small>켜기</small>
                          </button>

                          <button
                            class="output-button${state === "OFF" ? " is-active" : ""}"
                            type="button"
                            data-active-command="true"
                            data-device-id="${escapeHtml(device.device_id)}"
                            data-pin="${escapeHtml(set.output_pin)}"
                            data-state="OFF"
                            aria-pressed="${state === "OFF"}"
                          >
                            <span>OFF</span>
                            <small>끄기</small>
                          </button>
                        </div>
                      `
                  }
                </article>
              `;
            }).join("") || '<p class="empty-state">활성 접점 세트가 없습니다.</p>'}
          </div>
        </section>
      `).join("")
      : '<p class="empty-state">활성 Wemos 장치가 없습니다.</p>';

    // API 조회와 WebSocket 연결 사이의 타이밍 차이를 보정합니다.
    for (const message of liveStates.values()) {
      applyLiveState(message);
    }

    for (const [deviceId, connected] of connectionStates) {
      applyConnectionState({ deviceId, connected });
    }
  }

  async function load() {
    const response = await fetch("/api/wemos/devices", {
      cache: "no-store"
    });

    if (!response.ok) return;

    const devices = await response.json();
    render(Array.isArray(devices) ? devices : []);
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-active-command]");

    if (
      button &&
      typeof window.sendWemosCommand === "function"
    ) {
      window.sendWemosCommand({
        type: "lamp",
        deviceId: button.dataset.deviceId,
        pin: button.dataset.pin,
        state: button.dataset.state
      });
    }
  });

  /*
   * wemos.js가 서버 WebSocket 이벤트를 여기로 전달합니다.
   * stateChanged / state / commandAck 등을 모두 처리할 수 있습니다.
   */
  window.addEventListener("wemos-state-update", event => {
    const message = event.detail || {};

    if (message.type === "deviceConnection") {
      applyConnectionState(message);
      return;
    }

    if (message.type === "channelString" || message.type === "state" || message.type === "stateChanged") {
      if (message.IStr !== undefined || message.OStr !== undefined) applyLiveString(message);
    }

    if (
      ["wemosSnapshot", "initialState"].includes(message.type) &&
      typeof message.deviceConnected === "boolean"
    ) {
      const deviceId = message.deviceId || message.state?.device_id;
      applyConnectionState({
        deviceId,
        connected: message.deviceConnected
      });
    }

    // 매우 중요: 웹에서 보낸 명령(commandQueued/commandAck)은
    // "요청" 또는 "명령 처리 결과"일 뿐, 이 화면의 실제 출력 상태가 아닙니다.
    // 현재 출력값과 ON/OFF 버튼은 Wemos가 실제 출력 상태를 보고한
    // state/stateChanged 이벤트에서만 변경합니다.
    if (!["state", "stateChanged"].includes(message.type)) {
      return;
    }

    if (
      !message.deviceId ||
      !message.pin ||
      !["ON", "OFF"].includes(message.state)
    ) {
      return;
    }

    const normalized = {
      ...message,
      deviceId: String(message.deviceId),
      pin: String(message.pin).toUpperCase(),
      state: String(message.state).toUpperCase()
    };

    liveStates.set(
      `${normalized.deviceId}:${normalized.pin}`,
      normalized
    );

    applyLiveState(normalized);
  });

  load().then(() => {
    const pending = Array.isArray(window.__pendingWemosLiveStates)
      ? window.__pendingWemosLiveStates.splice(0)
      : [];

    pending.forEach(message => {
      const normalized = {
        ...message,
        deviceId: String(message.deviceId || ""),
        pin: String(message.pin || "").toUpperCase(),
        state: String(message.state || "").toUpperCase()
      };
      liveStates.set(`${normalized.deviceId}:${normalized.pin}`, normalized);
      applyLiveState(normalized);
    });
  }).catch(error => {
    console.error("[Wemos UI] 장치 목록 조회 오류:", error);
  });
})();
