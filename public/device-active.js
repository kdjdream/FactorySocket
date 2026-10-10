// 제어·조회 공용 채널 화면: 활성 장치를 조회하고 장치 ID와 채널별로 실시간 상태를 관리합니다.
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
     * 여러 Device가 연결되어도 다른 장치의 같은 핀이 잘못 바뀌지 않습니다.
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
        .forEach(element => {
          const scheduled = /^SCHEDULE:\d+(?::(.+))?$/.exec(String(message.source || ""));
          element.textContent = scheduled ? scheduled[1] || "예약자 ID 없음" : String(message.source || "-");
          element.dataset.scheduleSource = String(Boolean(scheduled));
        });
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

  // API보다 먼저 받은 이벤트도 보관하여 초기 렌더링이 최신 상태를 이전 값으로 덮어쓰지 않게 합니다.
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

  // device-control.js에서 WebSocket 이벤트를 직접 호출할 수 있도록 공개합니다.
  window.applyDeviceActiveLiveState = applyLiveState;

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

  // 조회 전용 페이지에서는 제어 버튼과 OStr 입력을 만들지 않습니다. 서버 권한 검사도 별도로 적용됩니다.
  function render(devices) {
    const legacyGrid = document.querySelector(".channel-grid");
    const root = document.getElementById("activeDeviceWindows");

    if (!root) return;

    const viewOnly = location.pathname.includes("device-view");

    if (legacyGrid) legacyGrid.hidden = true;

    root.hidden = false;

    root.innerHTML = devices.length
      ? devices.map((device, deviceIndex) => `
        <section
          class="active-device-window"
          data-device-id="${escapeHtml(device.device_id)}"
          aria-labelledby="device-${escapeHtml(device.device_id)}"
        >
          <div class="active-device-heading">
            <div class="active-device-device-info">
              <span class="channel-number">장치 ${deviceIndex + 1}</span>
              <h3 id="device-${escapeHtml(device.device_id)}">
                ${escapeHtml(device.device_name || device.device_id)}
              </h3>
              <code>${escapeHtml(device.device_id)}</code>
            </div>

            <div class="active-device-status">
              <span
                class="device-state ${device.deviceConnected ? "is-connected" : "is-disconnected"}"
                data-device-connection="${escapeHtml(device.device_id)}"
              >
                ${device.deviceConnected ? "연결됨" : "연결 안 됨"}
              </span>
            </div>
          </div>

          <div class="active-device-channels">
            ${(device.sets || []).map((set, index) => {
              const state = set.output_state === "ON" ? "ON" : "OFF";
              const inputState = set.input_state === "ON" ? "ON" : "OFF";
              const inputStringName = String(set.input_signal).replace(/^IS([1-8])$/, "IStr$1");
              const outputStringName = String(set.output_signal).replace(/^OS([1-8])$/, "OStr$1");
              const scheduledSource = /^SCHEDULE:\d+(?::(.+))?$/.exec(String(set.last_change_source || ""));

              return `
                <article class="channel-card channel-${escapeHtml(String(set.output_signal).toLowerCase())}" data-schedule-device="${escapeHtml(device.device_id)}" data-schedule-pin="${escapeHtml(set.output_signal)}">
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
                      <strong data-active-last-source="${escapeHtml(set.output_signal)}" data-schedule-source="${Boolean(scheduledSource)}">${escapeHtml(scheduledSource ? scheduledSource[1] || "예약자 ID 없음" : set.last_change_source || "-")}</strong>
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
                    <span data-device-istr>${escapeHtml(inputStringName)}: <code data-active-input-string="${escapeHtml(set.input_signal)}">${escapeHtml(set.input_message || "")}</code></span>
                    <span data-device-ostr>${escapeHtml(outputStringName)}: <code data-active-output-string="${escapeHtml(set.output_signal)}">${escapeHtml(set.output_message || "")}</code></span>
                  </div>

                  ${
                    viewOnly
                      ? ""
                      : `
                        <div class="device-output-strings" data-device-ostr-inputs>
                          <label class="device-output-string">
                            <span>${escapeHtml(outputStringName)} ON</span>
                            <input type="text" data-command-output-string="${escapeHtml(set.output_signal)}" data-command-state="ON"
                              value="${escapeHtml(set.output_message || "")}" maxlength="10000" autocomplete="off"
                              aria-label="${escapeHtml(outputStringName)} ON">
                          </label>
                          <label class="device-output-string">
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
                        <button class="channel-schedule-button" type="button" data-open-schedule="true"
                          data-device-id="${escapeHtml(device.device_id)}" data-pin="${escapeHtml(set.output_signal)}">
                          Non scheduled
                        </button>
                      `
                  }
                </article>
              `;
            }).join("") || '<p class="empty-state">활성 접점 세트가 없습니다.</p>'}
          </div>
        </section>
      `).join("")
      : '<p class="empty-state">활성 Device 장치가 없습니다.</p>';

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
    const response = await fetch("/api/device/devices", {
      cache: "no-store"
    });

    if (!response.ok) return;

    const devices = await response.json();
    render(Array.isArray(devices) ? devices : []);
  }

  async function refreshScheduleLabels(deviceId = null, outputSignal = null) {
    const cards = [...document.querySelectorAll("[data-open-schedule]")]
      .filter(button => (!deviceId || button.dataset.deviceId === deviceId) && (!outputSignal || button.dataset.pin === outputSignal));
    if (!cards.length) return;
    await Promise.all(cards.map(async button => {
      try {
        const params = new URLSearchParams({ device_id:button.dataset.deviceId, output_signal:button.dataset.pin, is_enabled:"1", next_only:"1", limit:"1", sort_by:"time", sort_order:"asc" });
        const response = await fetch(`/api/device/schedules?${params}`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        const data = await response.json();
        const next = Array.isArray(data.items) ? data.items[0] : null;
        const outputText = next ? String(next.ostr_payload ?? "") : "";
        button.textContent = next ? `${String(next.next_run_at).replace("T", " ").slice(5,16)} ${next.action_state}\n${outputText}` : "Non scheduled";
        button.title = next ? outputText : "예약이 없습니다. 클릭하여 예약을 추가하세요.";
      } catch (error) { console.warn("예약 표시 갱신 오류", error); }
    }));
  }
  function ensureScheduleDialog() {
    let dialog = document.getElementById("channelScheduleDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog"); dialog.id = "channelScheduleDialog"; dialog.className = "schedule-dialog";
    dialog.innerHTML = `<form id="channelScheduleForm" class="schedule-form">
      <div class="schedule-dialog-heading"><h2>채널 예약 등록</h2><button type="button" data-close-schedule aria-label="닫기">×</button></div>
      <input type="hidden" name="device_id"><input type="hidden" name="output_signal">
      <label>예약 이름<input name="schedule_name" maxlength="150"></label>
      <label>실행 동작<select name="action_state"><option value="ON">ON</option><option value="OFF">OFF</option></select></label>
      <label>반복 유형<select name="repeat_type"><option value="ONCE">1회</option><option value="HOURLY">매시간</option><option value="DAILY">매일</option><option value="WEEKLY">반복 요일</option><option value="MONTHLY">매월</option><option value="YEARLY">매년</option></select></label>
      <label data-field="schedule_time">실행 시각<input name="schedule_time" type="datetime-local" required></label>
      <fieldset data-field="weekdays" hidden><legend>반복 요일</legend>${["일","월","화","수","목","금","토"].map((d,i)=>`<label class="weekday-option"><input type="checkbox" name="weekdays" value="${i}">${d}</label>`).join("")}</fieldset>
      <label data-field="is_month_end" hidden><input name="is_month_end" type="checkbox"> 매월 말일</label>
      <label>OStr 전송 문자열<textarea name="ostr_payload" rows="3" maxlength="10000"></textarea></label>
      <p class="schedule-message" role="status"></p><div class="schedule-form-actions"><button type="button" data-close-schedule>취소</button><button type="submit">예약 등록</button><a href="/device_schedule.html">전체 예약 관리</a></div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector("form");
    form.elements.repeat_type.addEventListener("change", () => {
      const type = form.elements.repeat_type.value;
      const show = { weekdays:type==="WEEKLY", is_month_end:type==="MONTHLY" };
      Object.entries(show).forEach(([key,visible]) => { const el=form.querySelector(`[data-field="${key}"]`); if(el) el.hidden=!visible; });
      if(type!=="WEEKLY") form.querySelectorAll('input[name="weekdays"]').forEach(el=>el.checked=false);
      if(type!=="MONTHLY") form.elements.is_month_end.checked=false;
    });
    dialog.querySelectorAll("[data-close-schedule]").forEach(btn=>btn.addEventListener("click",()=>dialog.close()));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const f = new FormData(form), type=f.get("repeat_type");
      const payload={device_id:f.get("device_id"),output_signal:f.get("output_signal"),schedule_name:f.get("schedule_name"),action_state:f.get("action_state"),repeat_type:type,schedule_time:f.get("schedule_time"),ostr_payload:f.get("ostr_payload"),is_enabled:true};
      if(type==="WEEKLY") payload.weekdays=f.getAll("weekdays");
      if(type==="MONTHLY") payload.is_month_end=form.elements.is_month_end.checked;
      const message=form.querySelector(".schedule-message");
      try { const response=await fetch("/api/device/schedules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||"예약 등록 실패");dialog.close();form.reset();await refreshScheduleLabels(); }
      catch(err){message.textContent=err.message;}
    });
    return dialog;
  }

  document.addEventListener("click", event => {
    const scheduleButton = event.target.closest("[data-open-schedule]");
    if (scheduleButton) {
      const dialog=ensureScheduleDialog(), form=dialog.querySelector("form");
      form.reset(); form.elements.device_id.value=scheduleButton.dataset.deviceId; form.elements.output_signal.value=scheduleButton.dataset.pin;
      form.querySelector(".schedule-message").textContent="";
      form.elements.repeat_type.dispatchEvent(new Event("change"));
      dialog.showModal(); return;
    }
  });

  // 동적으로 생성된 버튼도 한 번의 이벤트 등록으로 처리하며, 누른 ON/OFF 버튼의 문자열만 전송합니다.
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-active-command]");

    if (
      button &&
      typeof window.sendDeviceCommand === "function"
    ) {
      window.sendDeviceCommand({
        type: "lamp",
        deviceId: button.dataset.deviceId,
        OutputSignal: button.dataset.pin,
        severSignal: button.dataset.state,
        OStr: button.closest(".channel-card")?.querySelector(`[data-command-output-string][data-command-state="${CSS.escape(button.dataset.state)}"]`)?.value ?? ""
      });
    }
  });

  /*
  * device-control.js가 서버 WebSocket 이벤트를 여기로 전달합니다.
    * 실제 상태·문자열·연결 이벤트를 반영합니다. 명령 전달 알림만으로는 출력 표시를 변경하지 않습니다.
   */
  window.addEventListener("device-state-update", event => {
    const message = event.detail || {};

    if (message.type === "scheduleChanged") {
      void refreshScheduleLabels(message.deviceId, message.OutputSignal);
      return;
    }

    if (message.type === "deviceConnection") {
      applyConnectionState(message);
      return;
    }

    if (message.type === "channelString" || message.type === "state" || message.type === "stateChanged") {
      rememberLiveMessage(message);
      return;
    }

    if (["deviceSnapshot", "initialState"].includes(message.type) && message.state) {
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
      ["deviceSnapshot", "initialState"].includes(message.type) &&
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
    refreshScheduleLabels();
    setInterval(refreshScheduleLabels, 30000);
    const pending = Array.isArray(window.__pendingDeviceLiveStates)
      ? window.__pendingDeviceLiveStates.splice(0)
      : [];

    pending.forEach(rememberLiveMessage);
  }).catch(error => {
    console.error("[Device UI] 장치 목록 조회 오류:", error);
  });
})();
