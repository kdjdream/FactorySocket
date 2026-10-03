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

  function formatChangedAt(value) {
    if (!value) return "-";
    const normalized = typeof value === "string" && /^\d{4}-\d{2}-\d{2} /.test(value)
      ? `${value.replace(" ", "T")}+09:00` : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return "-";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function applyLiveState(message) {
    const deviceId = String(message.deviceId || "");
    const pin = String(message.OutputSignal ?? message.pin ?? "").toUpperCase();
    const state = String(message.OutputState ?? message.state ?? "").toUpperCase();

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

    if (message.source !== undefined) {
      document.querySelectorAll(`${deviceSelector} [data-active-last-source="${CSS.escape(pin)}"]`)
        .forEach(element => element.textContent = String(message.source || "-"));
    }

    const changedAt = message.lastChangedAt !== undefined ? message.lastChangedAt
      : message.type === "stateChanged" ? message.changedAt : undefined;
    if (changedAt) {
      document.querySelectorAll(`${deviceSelector} [data-active-last-changed-at="${CSS.escape(pin)}"]`)
        .forEach(element => element.textContent = formatChangedAt(changedAt));
    }

    if (["ON", "OFF"].includes(message.inputState)) {
      document.querySelectorAll(`${deviceSelector} [data-active-input-pin="${CSS.escape(`IS${pin.slice(2)}`)}"]`)
        .forEach(indicator => {
          indicator.textContent = message.inputState;
          indicator.dataset.state = message.inputState;
        });
    }
    applyLiveString(message);

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
    const pin = String(message.OutputSignal ?? message.pin ?? "").toUpperCase();
    if (!deviceId || !/^OS[1-8]$/.test(pin)) return;
    const deviceSelector = `[data-device-id="${CSS.escape(deviceId)}"]`;
    if (message.IStr !== undefined) {
      document.querySelectorAll(`${deviceSelector} [data-active-input-string="${CSS.escape(`IS${pin.slice(2)}`)}"]`)
        .forEach(element => element.textContent = String(message.IStr ?? ""));
    }
    if (message.OStr !== undefined) {
      document.querySelectorAll(`${deviceSelector} [data-active-output-string="${CSS.escape(pin)}"]`)
        .forEach(element => element.textContent = String(message.OStr ?? ""));
    }
  }

  function rememberLiveMessage(message) {
    const deviceId = String(message.deviceId || "");
    const pin = String(message.OutputSignal ?? message.pin ?? "").toUpperCase();
    if (!deviceId || !/^OS[1-8]$/.test(pin)) return;
    const key = `${deviceId}:${pin}`;
    const normalized = { ...liveStates.get(key), ...message, deviceId, OutputSignal: pin };
    normalized.lastChangedAt = message.lastChangedAt
      ?? (message.type === "stateChanged" ? message.changedAt : undefined)
      ?? liveStates.get(key)?.lastChangedAt;
    if (message.OutputState !== undefined || message.state !== undefined) {
      normalized.OutputState = message.OutputState ?? message.state;
    }
    liveStates.set(key, normalized);
    applyLiveString(normalized);
    applyLiveState(normalized);
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
              const state = set.output_state === "ON" ? "ON" : "OFF";
              const inputState = set.input_state === "ON" ? "ON" : "OFF";
              const inputStringName = String(set.input_signal).replace(/^IS([1-8])$/, "IStr$1");
              const outputStringName = String(set.output_signal).replace(/^OS([1-8])$/, "OStr$1");

              return `
                <article class="channel-card channel-${escapeHtml(String(set.output_signal).toLowerCase())}">
                  <div class="channel-card-head">
                    <div>
                      <div class="channel-device-identity">
                        <code>${escapeHtml(device.device_id)}</code>
                        <span>${escapeHtml(device.device_name || device.device_id)}</span>
                      </div>
                      <span class="channel-number">
                        CHANNEL ${String(index + 1).padStart(2, "0")}
                      </span>
                      <h3>${escapeHtml(set.channel_name)}</h3>
                    </div>

                    <div class="output-readout channel-last-source">
                      <span>최근 변경</span>
                      <strong data-active-last-source="${escapeHtml(set.output_signal)}">${escapeHtml(set.last_change_source || "-")}</strong>
                      <time data-active-last-changed-at="${escapeHtml(set.output_signal)}">${escapeHtml(formatChangedAt(set.last_changed_at ?? set.created_at))}</time>
                    </div>
                  </div>

                  <div class="signal-path">
                    <span class="signal-state-group">
                      <span class="signal-pin">${escapeHtml(set.input_signal)}</span>
                      <b class="pin-state" data-active-input-pin="${escapeHtml(set.input_signal)}" data-state="${inputState}">${inputState}</b>
                    </span>
                    <span class="signal-state-group">
                      <span class="signal-pin">${escapeHtml(set.output_signal)}</span>
                      <b
                        class="pin-state"
                        data-active-pin="${escapeHtml(set.output_signal)}"
                        data-state="${state}"
                      >
                        ${state}
                      </b>
                    </span>
                  </div>
                  <div class="signal-strings">
                    <span data-wemos-istr>${escapeHtml(inputStringName)}: <code data-active-input-string="${escapeHtml(set.input_signal)}">${escapeHtml(set.input_message || "")}</code></span>
                    <span data-wemos-ostr>${escapeHtml(outputStringName)}: <code data-active-output-string="${escapeHtml(set.output_signal)}">${escapeHtml(set.output_message || "")}</code></span>
                  </div>

                  ${
                    viewOnly
                      ? ""
                      : `
                        <div class="wemos-output-strings" data-wemos-ostr-inputs>
                          <label class="wemos-output-string">
                            <span>${escapeHtml(outputStringName)} ON</span>
                            <input type="text" data-command-output-string="${escapeHtml(set.output_signal)}" data-command-state="ON"
                              value="${escapeHtml(set.output_message || "")}" maxlength="10000" autocomplete="off"
                              aria-label="${escapeHtml(outputStringName)} ON">
                          </label>
                          <label class="wemos-output-string">
                            <span>${escapeHtml(outputStringName)} OFF</span>
                            <input type="text" data-command-output-string="${escapeHtml(set.output_signal)}" data-command-state="OFF"
                              value="${escapeHtml(set.output_message || "")}" maxlength="10000" autocomplete="off"
                              aria-label="${escapeHtml(outputStringName)} OFF">
                          </label>
                        </div>
                        <div
                          class="channel-actions"
                          role="group"
                          aria-label="${escapeHtml(set.channel_name)} 출력 조작"
                        >
                          <button
                            class="output-button${state === "ON" ? " is-active" : ""}"
                            type="button"
                            data-active-command="true"
                            data-device-id="${escapeHtml(device.device_id)}"
                            data-pin="${escapeHtml(set.output_signal)}"
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
                            data-pin="${escapeHtml(set.output_signal)}"
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
    for (const device of devices) {
      for (const channel of device.sets || []) {
        const cached = liveStates.get(`${device.device_id}:${channel.output_signal}`);
        rememberLiveMessage({
          deviceId: device.device_id, OutputSignal: channel.output_signal,
          OutputState: channel.output_state, inputState: channel.input_state,
          source: channel.last_change_source, IStr: channel.input_message, OStr: channel.output_message,
          ...cached,
          lastChangedAt: cached?.lastChangedAt ?? channel.last_changed_at ?? channel.created_at
        });
      }
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
        OutputSignal: button.dataset.pin,
        severSignal: button.dataset.state,
        OStr: button.closest(".channel-card")?.querySelector(`[data-command-output-string][data-command-state="${CSS.escape(button.dataset.state)}"]`)?.value ?? ""
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
      rememberLiveMessage(message);
      return;
    }

    if (["wemosSnapshot", "initialState"].includes(message.type) && message.state) {
      for (const channel of message.state.channels || []) {
        rememberLiveMessage({
          deviceId: message.state.device_id, OutputSignal: channel.output_signal,
          InputSignal: channel.input_signal,
          OutputState: channel.output_state, inputState: channel.input_state,
          source: channel.last_change_source,
          lastChangedAt: channel.last_changed_at ?? channel.created_at,
          IStr: channel.input_message, OStr: channel.output_message
        });
      }
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

  });

  load().then(() => {
    const pending = Array.isArray(window.__pendingWemosLiveStates)
      ? window.__pendingWemosLiveStates.splice(0)
      : [];

    pending.forEach(rememberLiveMessage);
  }).catch(error => {
    console.error("[Wemos UI] 장치 목록 조회 오류:", error);
  });
})();
