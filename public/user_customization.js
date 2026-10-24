function User_customizationChannelKey(channel) {
  return JSON.stringify([channel.device_id, channel.output_signal]);
}

function User_customizationItemKey(channel) {
  return JSON.stringify([channel.device_id, channel.output_signal, !channel.display_type || channel.display_type === "button" ? "switch" : channel.display_type]);
}

function User_customizationControlBlockReason(user, device, channel, connected, pending, permissions = {}) {
  if (!user || user.status === "SUSPENDED" || permissions.device_control !== true) return "디바이스 출력 제어 권한이 없습니다.";
  if (!device || !channel) return "삭제되었거나 사용할 수 없는 채널입니다.";
  if (Number(device.is_visible) !== 1 || Number(channel.is_active ?? channel.is_visible) !== 1) return "숨겨진 장치 또는 비활성 채널입니다.";
  if (Number(device.is_enabled) !== 1) return "사용 중지된 장치입니다.";
  if (Number(channel.web_control_enabled) !== 1) return "조회 전용 채널입니다.";
  if (!["ON", "OFF"].includes(channel.output_state)) return "상태 확인 중입니다.";
  const nextState = channel.output_state === "ON" ? "OFF" : "ON";
  if (Number(channel[nextState === "ON" ? "web_on_enabled" : "web_off_enabled"]) !== 1) return `${nextState} 스위치가 비활성화된 채널입니다.`;
  if (!connected) return "서버 연결을 확인하고 있습니다.";
  if (pending) return "명령 처리 중입니다.";
  return "";
}

const User_customizationElements = Object.fromEntries([
  "User_customizationGrid", "User_customizationCount", "User_customizationMessage", "User_customizationEmpty", "User_customizationSelect", "User_customizationPicker",
  "User_customizationPickerForm", "User_customizationChoices", "User_customizationDeviceFilter", "User_customizationSearch", "User_customizationSelectionCount", "User_customizationPickerMessage", "User_customizationSave", "User_customizationPickerTypes"
].map(id => [id, document.getElementById(id)]));
let User_customizationUser = null;
let User_customizationPermissions = {};
let User_customizationDevices = [];
let User_customizationSelection = [];
let User_customizationSocket;
let User_customizationReconnect;
let User_customizationRefreshing = false;
let User_customizationSaving = false;
let User_customizationRevision = 0;
let User_customizationSelectionRevision = 0;
let User_customizationDrag = null;
let User_customizationPickerType = "switch";
let User_customizationRenderedMarkup = "";
let User_customizationGraphEditingKey = null;
const User_customizationPending = new Map();
const User_customizationLive = new Map();
const User_customizationPopupWindows = new Map();

function User_customizationEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function User_customizationRequest(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (response.status === 401) location.href = "/user-login.html";
  const data = await response.json();
  if (response.status === 403 && data.code === "SUSPENDED") location.href = "/user-profile.html?pending=1";
  if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다.");
  return data;
}

function User_customizationLookup(selection) {
  const device = User_customizationDevices.find(item => item.device_id === selection.device_id);
  const channel = device?.sets.find(item => item.output_signal === selection.output_signal);
  return { device, channel };
}

function User_customizationCanDisplay(device, channel, type) {
  return Number(device?.is_visible) === 1
    && Number(channel?.is_active ?? channel?.is_visible) === 1
    && (["lamp", "graph"].includes(type) || Number(channel?.web_control_enabled) === 1);
}

function User_customizationVisibleSelection() {
  return User_customizationSelection.filter(selection => {
    const { device, channel } = User_customizationLookup(selection);
    return User_customizationCanDisplay(device, channel, selection.display_type);
  });
}

function User_customizationSwitchDesignFor(selection) {
  const legacyDesigns = { "design-13": "design-02", "design-21": "design-03", "design-22": "design-04", "design-23": "design-05", "design-24": "design-06" };
  const savedDesign = selection?.switch_design ?? selection?.button_design;
  const design = legacyDesigns[savedDesign] || savedDesign;
  return ["design-01", "design-02", "design-03", "design-04", "design-05", "design-06", "design-07", "design-08"].includes(design)
    ? design : "design-01";
}

const User_customization_SWITCH_OPTIONS = [
  ["design-01", "01 기본형"], ["design-02", "02 원형 표시"], ["design-03", "03 금속 슬라이더"],
  ["design-04", "04 레버 토글"], ["design-05", "05 사각 표시"], ["design-06", "06 회전 다이얼"],
  ["design-07", "07 금속 회전 스위치"], ["design-08", "08 회색/초록 슬라이드"]
];

const User_customization_LAMP_OPTIONS = [
  ["lamp-01", "01 입체 원형 표시등"], ["lamp-02", "02 경광등"], ["lamp-03", "03 실린더 전진/후진"],
  ["lamp-04", "04 도어 열림/닫힘"], ["lamp-05", "05 백열전구"], ["lamp-06", "06 모터"],
  ["lamp-07", "07 배관 수도꼭지"], ["lamp-08", "08 회전 팬"],
  ["lamp-09", "09 수평 컨베이어"], ["lamp-10", "10 수직 컨베이어"], ["lamp-11", "11 와이파이"],
  ["lamp-12", "12 고정형 무대 서치라이트"], ["lamp-13", "13 전기식 부저"], ["lamp-14", "14 라디에이터 히터"],
  ["lamp-15", "15 보안 카메라"],
  ["lamp-18", "18 화살표"],
  ["lamp-26", "26 좌회전"], ["lamp-27", "27 우회전"]
];

const User_customization_GRAPH_OPTIONS = [["graph-01", "01 IStr 회전 화살표"], ["graph-02", "02 원형 계기판"], ["graph-03", "03 반원 계기판"], ["graph-04", "04 수직형 온도계기판"], ["graph-05", "05 실시간 스트리밍 차트"], ["graph-06", "06 IStr 중앙 텍스트"]];

function User_customizationChannelSettings(selection) {
  const legacy = User_customizationGraphConfig.isGaugeDesign(selection.graph_design) ? selection.graph_settings : {};
  const flags = Object.fromEntries(Object.keys(User_customizationGraphConfig.channelDefaults)
    .filter(key => key.startsWith("hide_") && legacy?.[key] !== undefined).map(key => [key, legacy[key]]));
  const config = User_customizationGraphConfig.validateChannel({ ...flags, ...User_customizationGraphConfig.migrateChannel(selection.channel_settings) });
  if (config.error) throw new Error(config.error);
  return config.settings;
}

function User_customizationAppearance(selection) {
  const settings = User_customizationChannelSettings(selection);
  const attributes = Object.keys(settings).filter(key => key.startsWith("hide_"))
    .map(key => `data-${key.replaceAll("_", "-")}="${settings[key]}"`).join(" ");
  const graphButtonHeight = selection.display_type === "graph" && selection.graph_design === "graph-06" ? settings.graph_button_height : "button";
  const isSwitch = !selection.display_type || ["button", "switch"].includes(selection.display_type);
  const legacyFill = selection.display_type === "lamp" && settings.fill_lamp
    || selection.display_type === "graph" && (selection.graph_settings?.fill_graph || graphButtonHeight === "channel");
  const expandHeader = isSwitch ? settings.expand_switch && settings.hide_device_name && settings.hide_channel_name : settings.expand_header || Boolean(legacyFill);
  const expandTail = !isSwitch && (settings.expand_tail || Boolean(legacyFill));
  return `${attributes} data-expand-header="${expandHeader}" data-expand-tail="${expandTail}" data-scale-contents="${settings.scale_contents}" data-fill-lamp="${Boolean(selection.display_type === "lamp" && settings.fill_lamp)}" data-graph-button-height="${graphButtonHeight}" data-graph-button-font="${settings.graph_button_font_family}" data-arrow-direction="${settings.arrow_direction}"${selection.channel_settings ? ` style="--User_customization-on:${settings.on_color};--User_customization-off:${settings.off_color};--User_customization-graph-button-font-size:${settings.graph_button_font_size}px;--User_customization-graph-button-text-color:${settings.graph_button_text_color}"` : ""}`;
}

function User_customizationUpdateInputIndicator(element, channel, outputSignal) {
  const state = ["ON", "OFF"].includes(channel?.input_state) ? channel.input_state : "UNKNOWN";
  const signal = channel?.input_signal || `IS${outputSignal.slice(2)}`;
  const indicator = element.querySelector(".simple-input-state");
  indicator.dataset.state = state;
  indicator.title = `${signal}: ${state === "UNKNOWN" ? "상태 확인 중" : state}`;
  element.querySelector(".simple-input-signal").textContent = signal;
  element.querySelector(".simple-input-status").textContent = state === "UNKNOWN" ? "-" : state;
  return indicator.title;
}

function User_customizationRotationArrows(design) {
  if (design === "lamp-18") {
    return `<svg class="simple-arrow-tail-segments" viewBox="0 0 120 120" aria-hidden="true">${[3, 11, 19, 27, 35].map((x, index) => `<rect x="${x}" y="44" width="6" height="32" rx="1" style="--segment-index:${index}"/>`).join("")}</svg>`;
  }
  if (!["lamp-26", "lamp-27"].includes(design)) return "";
  return `<svg class="simple-rotation-segments" viewBox="0 0 120 120" aria-hidden="true">${[0, 1, 2, 3].map(index => `<use href="/images/simple-lamps/rotation-arrow.svg?v=20261021-spaced#quarter" transform="rotate(${index * 90} 60 60)" style="--segment-index:${index}"/>`).join("")}</svg>`;
}

function User_customizationGraphAngle(value) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const angle = Number(text);
  return Number.isSafeInteger(angle) ? angle : null;
}

function User_customizationGraphMarkup(selection, includeMetadata = true) {
  const metadata = includeMetadata ? `<span class="simple-switch-meta"><span>${User_customizationEscape(selection.device_id)}</span><span>${User_customizationEscape(selection.output_signal)}</span></span>` : "";
  if (selection.graph_design === "graph-05") {
    const config = User_customizationGraphConfig.validateChart(selection.chart_settings);
    if (config.error) throw new Error(config.error);
    const settings = config.settings;
    return `<span class="simple-graph simple-stream" data-graph-design="graph-05" data-device-id="${User_customizationEscape(selection.device_id)}" data-pin="${User_customizationEscape(selection.output_signal)}" data-settings="${User_customizationEscape(JSON.stringify(settings))}" role="img" aria-label="실시간 차트 수집 대기">
      ${metadata}
      <span class="simple-stream-header"><span ${settings.show_title ? "" : "hidden"}>${User_customizationEscape(settings.title)}</span><strong class="simple-stream-value" aria-label="IStr" ${settings.show_value ? "" : "hidden"}></strong></span>
      <svg class="simple-stream-plot" aria-hidden="true"></svg><span class="simple-stream-error" role="status"></span>
    </span>`;
  }
  if (User_customizationGraphConfig.isGaugeDesign(selection.graph_design)) return User_customizationGaugeMarkup(selection, includeMetadata);
  const ticks = Array.from({ length: 72 }, (_, index) => `<line class="simple-graph-tick-${index % 2 === 0 ? "major" : "minor"}" x1="60" y1="1" x2="60" y2="${index % 2 === 0 ? 6 : 3.5}" transform="rotate(${index * 5} 60 60)"/>`).join("");
  const labels = '<g class="simple-graph-dial-labels"><text x="60" y="0" text-anchor="middle" dominant-baseline="middle">0°</text><text x="124" y="60" text-anchor="end" dominant-baseline="middle">90°</text><text x="60" y="120" text-anchor="middle" dominant-baseline="middle">180°</text><text x="-4" y="60" text-anchor="start" dominant-baseline="middle">270°</text></g>';
  if (selection.graph_design === "graph-06") {
    return `<span class="simple-graph simple-graph-button" data-graph-design="graph-06" data-device-id="${User_customizationEscape(selection.device_id)}" data-pin="${User_customizationEscape(selection.output_signal)}" data-state="UNKNOWN" role="img" aria-label="IStr 확인 중">${metadata}<strong class="simple-graph-button-value" aria-label="IStr"></strong></span>`;
  }
  return `<span class="simple-graph" data-device-id="${User_customizationEscape(selection.device_id)}" data-pin="${User_customizationEscape(selection.output_signal)}" role="img" aria-label="IStr 각도 확인 중"><svg class="simple-graph-dial" viewBox="-26 -16 172 152" aria-hidden="true"><g class="simple-graph-dial-artwork"><circle cx="60" cy="60" r="59"/>${ticks}</g>${labels}</svg><span class="simple-graph-arrow" aria-hidden="true"><img src="/images/simple-lamps/arrow-outline.svg" alt="">${User_customizationRotationArrows("lamp-18")}</span>${metadata}<span class="simple-lamp-input-string" aria-label="IStr"></span><strong class="simple-graph-value" aria-label="각도"></strong></span>`;
}

function User_customizationGaugePoint(angle, radius) {
  const radians = angle * Math.PI / 180;
  return [60 + Math.sin(radians) * radius, 60 - Math.cos(radians) * radius];
}

function User_customizationGaugeArc(start, end, radius) {
  const a = User_customizationGaugePoint(start, radius);
  const b = User_customizationGaugePoint(end, radius);
  return `M${a.join(" ")} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.join(" ")}`;
}

function User_customizationGaugeMarkup(selection, includeMetadata = true) {
  const config = User_customizationGraphConfig.validate(selection.graph_settings);
  if (config.error) throw new Error(config.error);
  const settings = { ...config.settings, ...Object.fromEntries(Object.entries(User_customizationChannelSettings({ ...selection, graph_design: "graph-02" })).filter(([key]) => key.startsWith("hide_"))) };
  const semicircle = selection.graph_design === "graph-03";
  const thermometer = selection.graph_design === "graph-04";
  const startAngle = semicircle ? -100 : -135;
  const sweep = semicircle ? 200 : 270;
  const angleFor = value => startAngle + (value - settings.min) / (settings.max - settings.min) * sweep;
  const tickValues = User_customizationGraphConfig.ticks(settings);
  const ticks = tickValues.map(({ fraction, major }) => {
    if (thermometer) {
      const y = 94 - fraction * 82;
      return `<line data-tick="${major ? "major" : "minor"}" x1="44" y1="${y}" x2="${major ? 36 : 40}" y2="${y}" stroke-width="${major ? 1 : 0.6}"/>`;
    }
    const angle = startAngle + fraction * sweep;
    const a = User_customizationGaugePoint(angle, 49);
    const b = User_customizationGaugePoint(angle, major ? 43 : 46);
    return `<line data-tick="${major ? "major" : "minor"}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke-width="${major ? 1 : 0.6}"/>`;
  }).join("");
  const labels = tickValues.filter(tick => tick.major).map(({ fraction }) => {
    const point = thermometer ? [32, 94 - fraction * 82] : User_customizationGaugePoint(startAngle + fraction * sweep, 36);
    const value = settings.min + (settings.max - settings.min) * fraction;
    return `<text x="${point[0]}" y="${point[1]}" text-anchor="${thermometer ? "end" : "middle"}" dominant-baseline="middle">${User_customizationEscape(Number(value.toPrecision(12)))}</text>`;
  }).join("");
  return `<span class="simple-graph simple-gauge" data-graph-design="${thermometer ? "graph-04" : semicircle ? "graph-03" : "graph-02"}" data-fill-graph="${settings.fill_graph}" data-device-id="${User_customizationEscape(selection.device_id)}" data-pin="${User_customizationEscape(selection.output_signal)}" data-settings="${User_customizationEscape(JSON.stringify(settings))}" role="img" aria-label="계기판 값 확인 중">
    <svg class="simple-gauge-face" viewBox="0 0 120 120" aria-hidden="true">
      ${thermometer ? `<g class="simple-thermometer-tube" transform="translate(28 0)"><rect class="simple-gauge-rim" x="24" y="5" width="16" height="98" rx="8"/>
      <circle class="simple-gauge-rim" cx="32" cy="102" r="12"/>
      <rect class="simple-gauge-inner" x="28" y="9" width="8" height="94" rx="4"/>
      <circle class="simple-gauge-inner" cx="32" cy="102" r="8"/>
      <rect class="simple-thermometer-liquid" x="29" y="12" width="6" height="82"/>
      <rect class="simple-thermometer-bulb" x="29" y="94" width="6" height="8"/>
      <circle class="simple-thermometer-bulb" cx="32" cy="102" r="7"/></g>` : semicircle ? `<path class="simple-gauge-rim" d="${User_customizationGaugeArc(-100, 100, 58)}"/>
      <path class="simple-gauge-inner" d="${User_customizationGaugeArc(-100, 100, 53)}"/>` : `<circle class="simple-gauge-rim" cx="60" cy="60" r="58"/>
      <circle class="simple-gauge-inner" cx="60" cy="60" r="53"/>`}
      <path class="simple-gauge-normal" d="${thermometer ? `M48 ${94 - (settings.normal_min - settings.min) / (settings.max - settings.min) * 82} V${94 - (settings.normal_max - settings.min) / (settings.max - settings.min) * 82}` : User_customizationGaugeArc(angleFor(settings.normal_min), angleFor(settings.normal_max), 50)}"/>
      <g class="simple-gauge-ticks">${ticks}</g><g class="simple-gauge-numbers" ${settings.hide_scale_labels ? "hidden" : ""}>${labels}</g>
    </svg>
    ${thermometer ? "" : '<span class="simple-gauge-needle" aria-hidden="true"></span><span class="simple-gauge-hub" aria-hidden="true"></span>'}
    ${thermometer ? '<span class="simple-input-state" data-state="UNKNOWN"><span class="simple-input-signal"></span><strong class="simple-input-status">-</strong></span>' : ""}
    ${includeMetadata ? `<span class="simple-switch-meta"><span ${settings.hide_device_id ? "hidden" : ""}>${User_customizationEscape(selection.device_id)}</span><span ${settings.hide_signal ? "hidden" : ""}>${User_customizationEscape(selection.output_signal)}</span></span>` : ""}
    <span class="simple-gauge-readout" aria-label="IStr" ${settings.hide_istr ? "hidden" : ""}></span>
    <span class="simple-gauge-caption" title="${User_customizationEscape(settings.title)}"${settings.hide_measurement_type ? " hidden" : ""}>${User_customizationEscape(settings.title)}</span>
    <span class="simple-gauge-unit" title="${User_customizationEscape(settings.unit)}" ${settings.hide_unit ? "hidden" : ""}>${User_customizationEscape(settings.unit)}</span>
    <span class="simple-gauge-error" role="status"></span>
  </span>`;
}

function User_customizationUpdateGauge(graph, channel) {
  const settings = JSON.parse(graph.dataset.settings);
  const state = ["ON", "OFF"].includes(channel?.output_state) ? channel.output_state : "UNKNOWN";
  graph.dataset.state = state;
  const inputTitle = graph.dataset.graphDesign === "graph-04"
    ? User_customizationUpdateInputIndicator(graph, channel, graph.dataset.pin) : "";
  const text = String(channel?.input_message ?? "");
  const readout = graph.querySelector(".simple-gauge-readout");
  readout.textContent = text;
  readout.title = `IStr${graph.dataset.pin.slice(2)}: ${text}`;
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim()) ? Number(text) : NaN;
  const error = !Number.isFinite(numeric) ? "IStr: 숫자 입력 필요"
    : numeric < settings.min || numeric > settings.max ? "IStr: 눈금 범위 초과" : "";
  graph.querySelector(".simple-gauge-error").textContent = error;
  graph.dataset.valid = String(!error);
  graph.setAttribute("aria-label", `${settings.title} ${text} ${settings.unit}, OS: ${state}${inputTitle ? `, ${inputTitle}` : ""}${error ? `, ${error}` : ""} (표시 전용)`);
  if (error) return;
  if (graph.dataset.graphDesign === "graph-04") {
    const liquid = graph.querySelector(".simple-thermometer-liquid");
    if (graph.dataset.fraction === undefined) void liquid.getBoundingClientRect();
    const fraction = (numeric - settings.min) / (settings.max - settings.min);
    liquid.style.transform = `scaleY(${fraction})`;
    graph.dataset.fraction = String(fraction);
    return;
  }
  const semicircle = graph.dataset.graphDesign === "graph-03";
  const angle = (semicircle ? -100 : -135) + (numeric - settings.min) / (settings.max - settings.min) * (semicircle ? 200 : 270);
  const needle = graph.querySelector(".simple-gauge-needle");
  if (graph.dataset.angle === undefined) void needle.offsetWidth;
  if (graph.dataset.angle !== String(angle)) {
    needle.style.transform = `rotate(${angle}deg)`;
    graph.dataset.angle = String(angle);
  }
}

function User_customizationUpdateGraph(graph, channel) {
  if (graph.dataset.graphDesign === "graph-05") {
    const { device } = User_customizationLookup({ device_id: graph.dataset.deviceId, output_signal: graph.dataset.pin });
    User_customizationStreamChart.update(graph, channel, Boolean(channel && device?.deviceConnected && Number(device.is_enabled) === 1 && User_customizationSocket?.readyState === WebSocket.OPEN));
    return;
  }
  if (graph.dataset.graphDesign === "graph-06") {
    const text = String(channel?.input_message ?? "");
    const value = graph.querySelector(".simple-graph-button-value");
    const state = ["ON", "OFF"].includes(channel?.output_state) ? channel.output_state : "UNKNOWN";
    value.textContent = text;
    value.title = `IStr${graph.dataset.pin.slice(2)}: ${text}`;
    graph.dataset.state = state;
    graph.setAttribute("aria-label", `OS: ${state}, IStr: ${text || "값 없음"} (표시 전용)`);
    return;
  }
  if (User_customizationGraphConfig.isGaugeDesign(graph.dataset.graphDesign)) {
    User_customizationUpdateGauge(graph, channel);
    return;
  }
  const inputString = graph.querySelector(".simple-lamp-input-string");
  inputString.textContent = String(channel?.input_message ?? "");
  inputString.title = `IStr${graph.dataset.pin.slice(2)}: ${inputString.textContent}`;
  const angle = User_customizationGraphAngle(channel?.input_message);
  const state = ["ON", "OFF"].includes(channel?.output_state) ? channel.output_state : "UNKNOWN";
  graph.dataset.state = state;
  const value = graph.querySelector(".simple-graph-value");
  graph.dataset.valid = String(angle !== null);
  if (angle === null) {
    value.textContent = "IStr: 정수 각도 필요";
    graph.setAttribute("aria-label", `OS: ${state}, IStr: ${channel?.input_message ?? "값 없음"} — 안전한 범위의 양수·0·음수 정수를 입력하세요.`);
    return;
  }
  const arrow = graph.querySelector(".simple-graph-arrow");
  if (graph.dataset.angle === undefined) {
    // Establish the zero-degree pose before the first target starts its transition.
    void arrow.offsetWidth;
  }
  if (graph.dataset.angle !== String(angle)) {
    arrow.style.transform = `rotate(${angle - 90}deg)`;
    graph.dataset.angle = String(angle);
  }
  value.textContent = `${angle}°`;
  graph.setAttribute("aria-label", `OS: ${state}, IStr: ${angle}도 (위쪽 0도, 시계방향 양수, 표시 전용)`);
}

function User_customizationRender() {
  const visible = User_customizationVisibleSelection();
  User_customizationElements.User_customizationCount.textContent = `${visible.length}개 채널`;
  User_customizationElements.User_customizationEmpty.hidden = visible.length !== 0;
  const markup = visible.map(selection => {
    const { device, channel } = User_customizationLookup(selection);
    const type = !selection.display_type || selection.display_type === "button" ? "switch" : selection.display_type;
    const visibility = User_customizationChannelSettings(selection);
    const deviceName = visibility.device_name_override || device?.device_name || selection.device_id;
    const channelName = visibility.channel_name_override || channel?.channel_name || selection.output_signal;
    const metadata = `<span class="simple-switch-meta${type === "switch" ? "" : " simple-body-meta"}"><span title="${User_customizationEscape(selection.device_id)}">${User_customizationEscape(selection.device_id)}</span><span>${User_customizationEscape(selection.output_signal)}</span></span>`;
    const content = type === "lamp"
      ? `<div class="simple-lamp" data-design="${User_customizationEscape(selection.lamp_design || "lamp-01")}" data-state="UNKNOWN" role="img">${User_customizationRotationArrows(selection.lamp_design)}<span class="simple-lamp-input-string" aria-label="IStr"></span><strong class="simple-lamp-state">-</strong></div>`
      : type === "graph" ? User_customizationGraphMarkup(selection, false)
      : `<button class="simple-toggle" type="button" data-design="${User_customizationSwitchDesignFor(selection)}" data-state="OFF">${metadata}<span class="simple-input-state" data-state="UNKNOWN"><span class="simple-input-signal"></span><strong class="simple-input-status">-</strong></span><span class="simple-switch-string simple-input-string" aria-label="IStr"></span><strong class="simple-state">OFF</strong><span class="simple-switch-string simple-output-string" aria-label="OStr"></span></button>`;
    return `<article class="simple-control-card" role="listitem" ${User_customizationAppearance(selection)} data-width-multiplier="${visibility.width_multiplier}" data-height-multiplier="${visibility.height_multiplier}" data-fill-graph="${Boolean(type === "graph" && User_customizationGraphConfig.isGaugeDesign(selection.graph_design) && selection.graph_settings?.fill_graph)}" data-display-type="${type}" data-device-id="${User_customizationEscape(selection.device_id)}" data-device-name="${User_customizationEscape(deviceName)}" data-channel-name="${User_customizationEscape(channelName)}" data-pin="${User_customizationEscape(selection.output_signal)}" data-design="${User_customizationSwitchDesignFor(selection)}">
      <span class="simple-offline-mark" role="status">연결안됨</span>
      <div class="simple-card-heading"><span${visibility?.hide_device_name ? " hidden" : ""}>${User_customizationEscape(deviceName)}</span><strong${visibility?.hide_channel_name ? " hidden" : ""}>${User_customizationEscape(channelName)}</strong></div>
      <div class="simple-card-body"><div class="simple-card-content"><div class="simple-card-surface">${content}</div></div>${type === "switch" ? "" : metadata}</div>
      <div class="simple-card-footer simple-card-actions"><button class="simple-drag-handle" type="button" aria-label="${User_customizationEscape(channelName)} 순서 이동" title="순서 이동">&#9776;</button><span class="simple-card-status" role="status"></span><button class="simple-channel-settings" type="button" aria-label="${User_customizationEscape(channelName)} 채널 설정" title="채널 설정">&#9881;</button></div>
    </article>`;
  }).join("");
  if (markup !== User_customizationRenderedMarkup) {
    User_customizationElements.User_customizationGrid.innerHTML = markup;
    User_customizationRenderedMarkup = markup;
    if (typeof ResizeObserver !== "undefined") {
      User_customizationSizeObserver.disconnect();
      User_customizationSizeObserver.observe(User_customizationElements.User_customizationGrid);
      for (const content of User_customizationElements.User_customizationGrid.querySelectorAll(".simple-card-heading, .simple-card-body")) {
        User_customizationSizeObserver.observe(content);
      }
    }
  }
  User_customizationSyncPopups();
  User_customizationUpdateSwitches();
  if (typeof ResizeObserver !== "undefined") User_customizationUpdateCardSizes();
}

function User_customizationSyncPopups() {
  for (const [key, popup] of User_customizationPopupWindows) {
    if (popup.closed) {
      User_customizationPopupWindows.delete(key);
      continue;
    }
    const source = [...User_customizationElements.User_customizationGrid.children].find(card => User_customizationItemKey({
      device_id: card.dataset.deviceId, output_signal: card.dataset.pin, display_type: card.dataset.displayType
    }) === key);
    if (!source) {
      if (User_customizationSaving) continue;
      popup.close();
      User_customizationPopupWindows.delete(key);
      continue;
    }
    if (popup.User_customizationMarkup === User_customizationRenderedMarkup) continue;
    const card = source.cloneNode(true);
    card.setAttribute("role", "group");
    if (window.factoryDesktop?.channelPopups) {
      const bar = popup.document.createElement("div");
      bar.className = "simple-popup-titlebar";
      const title = popup.document.createElement("span");
      title.textContent = source.dataset.channelName || source.dataset.pin;
      const close = popup.document.createElement("button");
      close.type = "button";
      close.className = "simple-popup-close";
      close.textContent = "\u00d7";
      close.setAttribute("aria-label", "팝업 닫기");
      close.title = "닫기";
      close.addEventListener("click", () => popup.close());
      bar.append(title, close);
      popup.document.body.replaceChildren(bar, card);
    } else popup.document.body.replaceChildren(card);
    popup.document.title = source.dataset.channelName || source.dataset.pin;
    popup.User_customizationMarkup = User_customizationRenderedMarkup;
  }
}

function User_customizationPopupCards() {
  return [...User_customizationPopupWindows.values()].filter(popup => !popup.closed)
    .flatMap(popup => [...popup.document.querySelectorAll(".simple-control-card")]);
}

function User_customizationReservePopup(key) {
  const existing = User_customizationPopupWindows.get(key);
  if (existing && !existing.closed) return { window: existing, created: false };
  if (window.factoryDesktop?.channelPopups) {
    const popup = window.open("about:blank", `factory-channel-${encodeURIComponent(key)}`, "popup=yes,width=640,height=508,resizable=yes");
    if (!popup) return null;
    popup.document.title = "채널 저장 중";
    popup.document.body.textContent = "채널 설정을 저장하고 있습니다.";
    return { window: popup, created: true };
  }
  // Document Picture-in-Picture windows have no address bar; only one can exist, so later channels use a normal popup.
  const pip = window.documentPictureInPicture;
  if (pip?.requestWindow && !pip.window) {
    try {
      return { promise: pip.requestWindow({ width: 640, height: 480, disallowReturnToOpener: true }), created: true };
    } catch {}
  }
  const popup = window.open("", "_blank", "popup=yes,width=640,height=480,resizable=yes,scrollbars=no,toolbar=no,location=no,menubar=no,status=no");
  if (!popup) return null;
  popup.document.title = "채널 저장 중";
  popup.document.body.textContent = "채널 설정을 저장하고 있습니다.";
  return { window: popup, created: true };
}

function User_customizationOpenPopup(key, reservation) {
  const reserved = reservation || User_customizationReservePopup(key);
  if (reserved?.promise) {
    return reserved.promise.then(popup => User_customizationOpenPopup(key, { window: popup, created: true }), () => {
      User_customizationElements.User_customizationMessage.textContent = "팝업을 열지 못했습니다. 브라우저의 팝업 허용 설정을 확인하세요.";
    });
  }
  if (!reserved || reserved.window.closed) {
    User_customizationElements.User_customizationMessage.textContent = "팝업을 열지 못했습니다. 브라우저의 팝업 허용 설정을 확인하세요.";
    return;
  }
  const popup = reserved.window;
  if (reserved.created) {
    popup.document.documentElement.lang = document.documentElement.lang;
    popup.document.documentElement.className = "simple-popup-root";
    Object.assign(popup.document.documentElement.dataset, document.documentElement.dataset);
    popup.document.documentElement.style.cssText = document.documentElement.style.cssText;
    popup.document.body.className = `${document.body.className} simple-popup-page`;
    popup.document.body.classList.toggle("simple-desktop-popup", Boolean(window.factoryDesktop?.channelPopups));
    for (const sheet of document.querySelectorAll('link[rel="stylesheet"]')) {
      const link = sheet.cloneNode(true);
      link.href = sheet.href;
      link.addEventListener("load", User_customizationUpdateCardSizes);
      popup.document.head.append(link);
    }
    popup.addEventListener("resize", User_customizationUpdateCardSizes);
    popup.document.body.addEventListener("click", User_customizationHandleSwitchClick);
    popup.document.body.addEventListener("click", User_customizationHandleSettingsClick);
    User_customizationPopupWindows.set(key, popup);
  }
  User_customizationSyncPopups();
  User_customizationUpdateSwitches();
  User_customizationUpdateCardSizes();
  popup.focus();
}

function User_customizationUpdateCardSizes() {
  const grid = User_customizationElements.User_customizationGrid;
  const gridStyle = getComputedStyle(grid);
  const columns = Number(gridStyle.getPropertyValue("--User_customization-columns"));
  const gap = parseFloat(gridStyle.columnGap);
  const baseWidth = (grid.clientWidth - (columns - 1) * gap) / columns;
  if (baseWidth <= 0) return;
  const updateScale = (card, getStyle) => {
    const body = card.querySelector(".simple-card-body");
    const style = getStyle(card);
    const inset = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
      .reduce((total, key) => total + parseFloat(style[key]), 0);
    const baseHeight = parseFloat(style.getPropertyValue("--User_customization-body-height"));
    const scale = card.dataset.scaleContents === "true" && body && baseHeight > 0
      ? Math.max(1, Math.min(body.clientWidth / (baseWidth - inset), body.clientHeight / baseHeight)) : 1;
    card.style.setProperty("--User_customization-content-scale", String(scale));
  };
  for (const card of grid.querySelectorAll(".simple-control-card")) updateScale(card, getComputedStyle);
  // Popup cards fill their own window, so their content scale follows the popup size.
  for (const popup of User_customizationPopupWindows.values()) {
    if (popup.closed) continue;
    const card = popup.document.querySelector(".simple-control-card");
    if (card) updateScale(card, element => popup.getComputedStyle(element));
  }
}

function User_customizationUpdateSwitches() {
  for (const card of [
    ...User_customizationElements.User_customizationGrid.querySelectorAll(".simple-control-card"),
    ...User_customizationPopupCards()
  ]) {
    const selection = { device_id: card.dataset.deviceId, output_signal: card.dataset.pin };
    const { device, channel } = User_customizationLookup(selection);
    card.dataset.offline = String(!device || !channel || !device.deviceConnected);
    const settingsButton = card.querySelector(".simple-channel-settings");
    if (settingsButton) settingsButton.disabled = User_customizationSaving;
    const status = card.querySelector(".simple-card-status");
    if (card.dataset.displayType === "lamp" || card.dataset.displayType === "graph") {
      const graph = card.querySelector(".simple-graph");
      if (graph) User_customizationUpdateGraph(graph, channel);
      const lamp = card.querySelector(".simple-lamp");
      if (lamp) {
        const state = ["ON", "OFF"].includes(channel?.output_state) ? channel.output_state : "UNKNOWN";
        lamp.dataset.state = state;
        lamp.querySelector(".simple-lamp-state").textContent = state === "UNKNOWN" ? "-" : state;
        const inputString = lamp.querySelector(".simple-lamp-input-string");
        inputString.textContent = String(channel?.input_message ?? "");
        const inputTitle = `IStr${selection.output_signal.slice(2)}: ${inputString.textContent}`;
        inputString.title = inputTitle;
        lamp.setAttribute("aria-label", `${card.dataset.deviceName || device?.device_name || selection.device_id} ${card.dataset.channelName || channel?.channel_name || selection.output_signal}: ${state === "UNKNOWN" ? "상태 확인 중" : state}, ${inputTitle} (표시 전용)`);
      }
      status.textContent = !device || !channel ? "삭제되었거나 사용할 수 없는 채널입니다."
        : Number(device.is_enabled) !== 1 ? "사용 중지된 장치입니다."
        : "";
      status.title = status.textContent;
      card.querySelector(".simple-drag-handle").disabled = User_customizationSaving;
      continue;
    }
    const switchElement = card.querySelector(".simple-toggle");
    const state = channel?.output_state;
    const inputTitle = User_customizationUpdateInputIndicator(switchElement, channel, selection.output_signal);
    const pending = User_customizationPending.has(User_customizationChannelKey(selection));
    const reason = User_customizationControlBlockReason(User_customizationUser, device, channel, User_customizationSocket?.readyState === WebSocket.OPEN, pending, User_customizationPermissions);
    const switchDesign = User_customizationSwitchDesignFor({ switch_design: card.dataset.design || switchElement.dataset.design });
    card.dataset.design = switchDesign;
    switchElement.dataset.design = switchDesign;
    switchElement.dataset.state = state === "ON" ? "ON" : "OFF";
    switchElement.querySelector(".simple-state").textContent = ["ON", "OFF"].includes(state) ? state : "-";
    for (const [selector, field, label] of [[".simple-input-string", "input_message", "IStr"], [".simple-output-string", "output_message", "OStr"]]) {
      const element = switchElement.querySelector(selector);
      element.textContent = String(channel?.[field] ?? "");
      element.title = `${label}${selection.output_signal.slice(2)}: ${element.textContent}`;
    }
    switchElement.setAttribute("aria-pressed", String(state === "ON"));
    switchElement.setAttribute("aria-label", `${card.dataset.deviceName || device?.device_name || selection.device_id} ${card.dataset.channelName || channel?.channel_name || selection.output_signal}: ${state || "상태 확인 중"}, ${inputTitle}`);
    switchElement.disabled = Boolean(reason);
    switchElement.dataset.pending = String(pending);
    switchElement.setAttribute("aria-busy", String(pending));
    switchElement.title = reason || `${state === "ON" ? "OFF" : "ON"} 전환`;
    const statusReason = ["명령 처리 중입니다.", "서버 연결을 확인하고 있습니다."].includes(reason) ? "" : reason;
    status.textContent = statusReason;
    status.title = statusReason;
    card.querySelector(".simple-drag-handle").disabled = User_customizationSaving;
  }
  for (const graph of User_customizationElements.User_customizationChoices?.querySelectorAll?.(".simple-graph") || []) {
    const { channel } = User_customizationLookup({ device_id: graph.dataset.deviceId, output_signal: graph.dataset.pin });
    User_customizationUpdateGraph(graph, channel);
  }
  User_customizationElements.User_customizationSelect.disabled = User_customizationSaving;
}

async function User_customizationRefresh() {
  if (User_customizationRefreshing) return;
  User_customizationRefreshing = true;
  const revision = User_customizationRevision;
  const selectionRevision = User_customizationSelectionRevision;
  try {
    const [identity, data] = await Promise.all([User_customizationRequest("/api/me"), User_customizationRequest("/api/me/User_customization")]);
    User_customizationUser = identity.user;
    User_customizationPermissions = identity.permissions || {};
    window.applyFactoryPermissions?.(identity);
    User_customizationDevices = data.devices;
    for (const device of User_customizationDevices) {
      for (const channel of device.sets) {
        const live = User_customizationLive.get(User_customizationChannelKey({ device_id: device.device_id, output_signal: channel.output_signal }));
        if (live?.revision > revision) channel.output_state = live.state;
        if (live?.inputStateRevision > revision) channel.input_state = live.inputState;
        if (live?.inputRevision > revision) channel.input_message = live.inputMessage;
        if (live?.outputRevision > revision) channel.output_message = live.outputMessage;
      }
    }
    if (!User_customizationSaving && !User_customizationDrag && selectionRevision === User_customizationSelectionRevision) {
      User_customizationSelection = data.channels;
      User_customizationRender();
    } else User_customizationUpdateSwitches();
    if (User_customizationElements.User_customizationPicker.open) {
      User_customizationUpdateDeviceFilter();
      User_customizationFilterChoices();
      User_customizationUpdateSelectionCount();
    }
  } catch (error) {
    User_customizationUser = null;
    User_customizationElements.User_customizationMessage.textContent = error.message;
    User_customizationUpdateSwitches();
  } finally {
    User_customizationRefreshing = false;
  }
}

async function User_customizationSaveSelection(channels) {
  if (User_customizationSaving) return false;
  const previous = User_customizationSelection;
  User_customizationSaving = true;
  User_customizationSelectionRevision++;
  User_customizationSelection = channels;
  User_customizationElements.User_customizationSave.disabled = true;
  User_customizationRender();
  try {
    const data = await User_customizationRequest("/api/me/User_customization", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channels })
    });
    for (const channel of channels.filter(item => item.display_type === "lamp")) {
      const saved = data.channels.find(item => User_customizationItemKey(item) === User_customizationItemKey(channel));
      if (Boolean(saved?.channel_settings?.fill_lamp) !== Boolean(channel.channel_settings?.fill_lamp)) {
        throw new Error("램프 꽉 채우기 설정이 서버에 반영되지 않았습니다. 서버를 재시작한 후 다시 저장하세요.");
      }
    }
    for (const channel of channels) {
      const saved = data.channels.find(item => User_customizationItemKey(item) === User_customizationItemKey(channel));
      for (const field of ["expand_switch", "expand_header", "expand_tail", "scale_contents", "width_multiplier", "height_multiplier"]) {
        const fallback = User_customizationGraphConfig.channelDefaults[field];
        if ((saved?.channel_settings?.[field] ?? fallback) !== (channel.channel_settings?.[field] ?? fallback)) {
          throw new Error("채널 크기 또는 확장 설정이 서버에 반영되지 않았습니다. 서버를 재시작한 후 다시 저장하세요.");
        }
      }
    }
    User_customizationSelection = data.channels;
    User_customizationElements.User_customizationMessage.textContent = "";
    return true;
  } catch (error) {
    User_customizationSelection = previous;
    User_customizationElements.User_customizationMessage.textContent = error.message;
    User_customizationElements.User_customizationPickerMessage.textContent = error.message;
    return false;
  } finally {
    User_customizationSaving = false;
    User_customizationElements.User_customizationSave.disabled = false;
    User_customizationRender();
  }
}

function User_customizationFinishPending(key) {
  clearTimeout(User_customizationPending.get(key));
  User_customizationPending.delete(key);
}

function User_customizationApplyState(deviceId, pin, state, inputState) {
  if (!deviceId || !/^OS(?:[1-9]|1[0-6])$/.test(pin)) return;
  const selection = { device_id: deviceId, output_signal: pin };
  const key = User_customizationChannelKey(selection);
  const { channel } = User_customizationLookup(selection);
  const live = { ...User_customizationLive.get(key) };
  if (["ON", "OFF"].includes(state)) {
    if (channel) channel.output_state = state;
    live.state = state;
    live.revision = ++User_customizationRevision;
    User_customizationFinishPending(key);
  }
  if (["ON", "OFF"].includes(inputState)) {
    if (channel) channel.input_state = inputState;
    live.inputState = inputState;
    live.inputStateRevision = ++User_customizationRevision;
  }
  User_customizationLive.set(key, live);
}

function User_customizationApplyStrings(deviceId, pin, inputMessage, outputMessage) {
  if (!deviceId || !/^OS(?:[1-9]|1[0-6])$/.test(pin) || (inputMessage === undefined && outputMessage === undefined)) return;
  const selection = { device_id: deviceId, output_signal: pin };
  const key = User_customizationChannelKey(selection);
  const live = { ...User_customizationLive.get(key) };
  const { channel } = User_customizationLookup(selection);
  if (inputMessage !== undefined) {
    User_customizationStreamChart.record(deviceId, pin, inputMessage);
    live.inputMessage = String(inputMessage ?? "");
    live.inputRevision = ++User_customizationRevision;
    if (channel) channel.input_message = live.inputMessage;
  }
  if (outputMessage !== undefined) {
    live.outputMessage = String(outputMessage ?? "");
    live.outputRevision = ++User_customizationRevision;
    if (channel) channel.output_message = live.outputMessage;
  }
  User_customizationLive.set(key, live);
}

function User_customizationHandleMessage(message) {
  if (["state", "stateChanged"].includes(message.type)) {
    User_customizationApplyState(message.deviceId, message.OutputSignal ?? message.pin, message.OutputState ?? message.state, message.inputState);
    User_customizationApplyStrings(message.deviceId, message.OutputSignal ?? message.pin, message.IStr, message.OStr);
  } else if (message.type === "channelString") {
    User_customizationApplyStrings(message.deviceId, message.OutputSignal ?? message.pin, message.IStr, message.OStr);
  } else if (["deviceSnapshot", "initialState"].includes(message.type)) {
    const state = message.state || {};
    for (const channel of state.channels || []) {
      User_customizationApplyState(state.device_id || message.deviceId, channel.output_signal, channel.output_state, channel.input_state);
      User_customizationApplyStrings(state.device_id || message.deviceId, channel.output_signal, channel.input_message, channel.output_message);
    }
  } else if (message.type === "deviceConnection") {
    const device = User_customizationDevices.find(item => item.device_id === message.deviceId);
    if (device) device.deviceConnected = Boolean(message.connected);
    if (!message.connected) for (const channel of device?.sets || []) {
      User_customizationStreamChart.record(message.deviceId, channel.output_signal, null);
    }
  } else if (message.type === "lampAck" || message.type === "error") {
    if (message.ok === false || message.type === "error") {
      for (const key of User_customizationPending.keys()) User_customizationFinishPending(key);
    }
    User_customizationElements.User_customizationMessage.textContent = message.type === "lampAck" && message.ok ? "" : message.message || "명령 처리에 실패했습니다.";
  }
  User_customizationUpdateSwitches();
}

function User_customizationConnect() {
  if (User_customizationSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(User_customizationSocket.readyState)) return;
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  User_customizationSocket = socket;
  window.factoryRealtimeSocket = socket;
  window.dispatchEvent(new CustomEvent("factory-socket-created", { detail: socket }));
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "subscribeDevice" }));
    User_customizationUpdateSwitches();
    void User_customizationRefresh();
  };
  socket.onmessage = event => {
    if (User_customizationSocket !== socket) return;
    try { User_customizationHandleMessage(JSON.parse(event.data)); } catch (error) { console.error(error); }
  };
  socket.onclose = event => {
    if (User_customizationSocket !== socket) return;
    if (event.code === 1008) { location.href = "/user-login.html"; return; }
    if (event.code === 4001) { location.href = "/user-profile.html?pending=1"; return; }
    for (const key of User_customizationPending.keys()) User_customizationFinishPending(key);
    User_customizationLive.clear();
    User_customizationUpdateSwitches();
    clearTimeout(User_customizationReconnect);
    User_customizationReconnect = setTimeout(User_customizationConnect, 2000);
  };
  socket.onerror = () => { User_customizationElements.User_customizationMessage.textContent = "서버 연결을 확인하고 있습니다."; };
}

function User_customizationHandleSwitchClick(event) {
  const switchElement = event.target.closest(".simple-toggle");
  if (!switchElement) return;
  const card = switchElement.closest(".simple-control-card");
  const selection = { device_id: card.dataset.deviceId, output_signal: card.dataset.pin };
  const { device, channel } = User_customizationLookup(selection);
  const key = User_customizationChannelKey(selection);
  const reason = User_customizationControlBlockReason(User_customizationUser, device, channel, User_customizationSocket?.readyState === WebSocket.OPEN, User_customizationPending.has(key), User_customizationPermissions);
  if (reason) { User_customizationElements.User_customizationMessage.textContent = reason; return; }
  const state = channel.output_state === "ON" ? "OFF" : "ON";
  try {
    User_customizationSocket.send(JSON.stringify({ type: "lamp", deviceId: selection.device_id, OutputSignal: selection.output_signal, severSignal: state }));
    User_customizationPending.set(key, setTimeout(() => {
      User_customizationFinishPending(key);
      User_customizationElements.User_customizationMessage.textContent = "상태 응답이 지연되고 있습니다.";
      void User_customizationRefresh();
      User_customizationUpdateSwitches();
    }, 30000));
    User_customizationElements.User_customizationMessage.textContent = "";
  } catch (error) { User_customizationElements.User_customizationMessage.textContent = error.message; }
  User_customizationUpdateSwitches();
}
User_customizationElements.User_customizationGrid.addEventListener("click", User_customizationHandleSwitchClick);

function User_customizationUpdateSelectionCount() {
  const selected = [...User_customizationElements.User_customizationChoices.querySelectorAll(".simple-channel-checkbox:checked")].filter(input => {
    const { device, channel } = User_customizationLookup({ device_id: input.dataset.deviceId, output_signal: input.dataset.pin });
    return User_customizationCanDisplay(device, channel, input.dataset.displayType);
  });
  User_customizationElements.User_customizationSelectionCount.textContent = `${selected.length}개 선택`;
}

function User_customizationFilterChoices() {
  const search = User_customizationElements.User_customizationSearch.value.trim().toLowerCase();
  const deviceId = User_customizationElements.User_customizationDeviceFilter.value;
  for (const choice of User_customizationElements.User_customizationChoices.querySelectorAll(".simple-choice")) {
    const { device, channel } = User_customizationLookup({
      device_id: choice.dataset.deviceId, output_signal: choice.dataset.pin
    });
    choice.hidden = !User_customizationCanDisplay(device, channel, choice.dataset.displayType)
      || Boolean(deviceId) && choice.dataset.deviceId !== deviceId || !choice.dataset.search.includes(search);
  }
  for (const group of User_customizationElements.User_customizationChoices.querySelectorAll("fieldset")) group.hidden = !group.querySelector(".simple-choice:not([hidden])");
  for (const section of User_customizationElements.User_customizationChoices.querySelectorAll(".simple-picker-section")) section.hidden = section.dataset.displayType !== User_customizationPickerType;
  for (const link of User_customizationElements.User_customizationPickerTypes.querySelectorAll("a")) {
    if (link.dataset.displayType === User_customizationPickerType) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
}

function User_customizationUpdateDeviceFilter() {
  const filter = User_customizationElements.User_customizationDeviceFilter;
  const selected = filter.value;
  const devices = User_customizationDevices.filter(device => Number(device.is_visible) === 1);
  filter.innerHTML = `<option value="">전체 디바이스</option>${devices.map(device =>
    `<option value="${User_customizationEscape(device.device_id)}">${User_customizationEscape(device.device_name || device.device_id)} (${User_customizationEscape(device.device_id)})</option>`).join("")}`;
  filter.value = devices.some(device => device.device_id === selected) ? selected : "";
}

User_customizationElements.User_customizationPickerTypes.addEventListener("click", event => {
  const link = event.target.closest("a[data-display-type]");
  if (!link) return;
  event.preventDefault();
  User_customizationPickerType = link.dataset.displayType;
  User_customizationFilterChoices();
  User_customizationElements.User_customizationChoices.scrollTop = 0;
});

function User_customizationRenderChoices() {
  const selected = new Map(User_customizationSelection.map(channel => [User_customizationItemKey(channel), channel]));
  User_customizationElements.User_customizationChoices.innerHTML = [["switch", "스위치"], ["lamp", "램프"], ["graph", "그래프"]].map(([type, label]) =>
    `<section class="simple-picker-section" data-display-type="${type}" aria-label="${label}"><h3>${label}</h3>${type === "lamp" ? "<p>OS 상태 표시 전용 · ON 빨강 / OFF 회색</p>" : type === "graph" ? "<p>01 IStr 회전 화살표 · 02 원형 계기판 · 03 반원 계기판 · 04 수직형 온도계기판 · 05 실시간 스트리밍 차트 (카드의 설정에서 변수 변경)</p>" : ""}${User_customizationDevices.filter(device => Number(device.is_visible) === 1).map(device => `<fieldset><legend>${User_customizationEscape(device.device_name || device.device_id)} <small>${User_customizationEscape(device.device_id)}</small></legend>${device.sets.filter(channel => User_customizationCanDisplay(device, channel, type)).map(channel => {
    const selection = { device_id: device.device_id, output_signal: channel.output_signal, display_type: type };
    const selectedChannel = selected.get(User_customizationItemKey(selection));
    const checked = Boolean(selectedChannel);
    const design = type === "lamp" ? selectedChannel?.lamp_design || "lamp-01" : type === "graph" ? selectedChannel?.graph_design || "graph-01" : User_customizationSwitchDesignFor(selectedChannel);
    if (type === "graph") {
      selection.graph_design = design;
      selection.graph_settings = selectedChannel?.graph_settings;
      selection.chart_settings = selectedChannel?.chart_settings;
    }
    const options = type === "lamp" ? User_customization_LAMP_OPTIONS : type === "graph" ? User_customization_GRAPH_OPTIONS : User_customization_SWITCH_OPTIONS;
    selection.channel_settings = selectedChannel?.channel_settings;
    const state = type === "graph" ? "UNKNOWN" : type === "lamp" && !["ON", "OFF"].includes(channel.output_state) ? "UNKNOWN" : channel.output_state === "ON" ? "ON" : "OFF";
    return `<div class="simple-choice" data-display-type="${type}" data-device-id="${User_customizationEscape(device.device_id)}" data-pin="${User_customizationEscape(channel.output_signal)}" data-search="${User_customizationEscape(`${device.device_name} ${device.device_id} ${channel.channel_name} ${channel.output_signal}`.toLowerCase())}">
      <label class="simple-choice-main"><input class="simple-channel-checkbox" type="checkbox" data-display-type="${type}" data-device-id="${User_customizationEscape(device.device_id)}" data-pin="${User_customizationEscape(channel.output_signal)}" ${checked ? "checked" : ""}><span>${User_customizationEscape(channel.channel_name)}</span><code>${User_customizationEscape(channel.output_signal)}</code></label>
      <label class="simple-choice-design">디자인<select class="simple-channel-design" aria-label="${User_customizationEscape(channel.channel_name || channel.output_signal)} ${label} 디자인" ${checked ? "" : "disabled"}>${options.map(([value, label]) => `<option value="${value}" ${design === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <span class="simple-design-preview" ${User_customizationAppearance(selection)} data-display-type="${type}" data-design="${design}" data-state="${state}">${type === "graph" ? User_customizationGraphMarkup(selection) : `${User_customizationRotationArrows(design)}<strong>${state === "UNKNOWN" ? "-" : state}</strong>`}</span>
    </div>`;
  }).join("")}</fieldset>`).join("") || '<p class="empty-state">등록된 채널이 없습니다.</p>'}</section>`).join("");
  User_customizationElements.User_customizationPickerMessage.textContent = "";
  User_customizationUpdateDeviceFilter();
  User_customizationElements.User_customizationDeviceFilter.value = "";
  User_customizationElements.User_customizationSearch.value = "";
  User_customizationFilterChoices();
  User_customizationUpdateSelectionCount();
}

User_customizationElements.User_customizationSelect.addEventListener("click", () => {
  User_customizationRenderChoices();
  User_customizationElements.User_customizationPicker.showModal();
  User_customizationUpdateSwitches();
});
User_customizationElements.User_customizationChoices.addEventListener("change", event => {
  const checkbox = event.target.closest(".simple-channel-checkbox");
  if (checkbox) {
    checkbox.closest(".simple-choice").querySelector(".simple-channel-design").disabled = !checkbox.checked;
    User_customizationUpdateSelectionCount();
    return;
  }
  const design = event.target.closest(".simple-channel-design");
  if (design) {
    const choice = design.closest(".simple-choice");
    const checkbox = choice.querySelector(".simple-channel-checkbox");
    if (checkbox.dataset.displayType === "graph") {
      const saved = User_customizationSelection.find(item => User_customizationItemKey(item) === User_customizationItemKey({ device_id: checkbox.dataset.deviceId, output_signal: checkbox.dataset.pin, display_type: "graph" }));
      const preview = choice.querySelector(".simple-design-preview");
      preview.dataset.design = design.value;
      preview.innerHTML = User_customizationGraphMarkup({ device_id: checkbox.dataset.deviceId, output_signal: checkbox.dataset.pin, graph_design: design.value, graph_settings: saved?.graph_settings, chart_settings: saved?.chart_settings, channel_settings: saved?.channel_settings });
      User_customizationUpdateSwitches();
      return;
    }
    const { channel } = User_customizationLookup({ device_id: choice.querySelector(".simple-channel-checkbox").dataset.deviceId, output_signal: choice.querySelector(".simple-channel-checkbox").dataset.pin });
    const state = choice.querySelector(".simple-channel-checkbox").dataset.displayType === "lamp" && !["ON", "OFF"].includes(channel?.output_state) ? "UNKNOWN" : channel?.output_state === "ON" ? "ON" : "OFF";
    const preview = choice.querySelector(".simple-design-preview");
    preview.dataset.design = design.value;
    preview.dataset.state = state;
    preview.querySelector(".simple-rotation-segments, .simple-arrow-tail-segments")?.remove();
    preview.insertAdjacentHTML("afterbegin", User_customizationRotationArrows(design.value));
    preview.querySelector("strong").textContent = state === "UNKNOWN" ? "-" : state;
  }
});
User_customizationElements.User_customizationSearch.addEventListener("input", User_customizationFilterChoices);
User_customizationElements.User_customizationDeviceFilter.addEventListener("change", User_customizationFilterChoices);
for (const [id, checked] of [["User_customizationSelectAll", true], ["User_customizationClearAll", false]]) {
  document.getElementById(id).addEventListener("click", () => {
    for (const input of User_customizationElements.User_customizationChoices.querySelectorAll(".simple-picker-section:not([hidden]) .simple-choice:not([hidden]) .simple-channel-checkbox")) {
      input.checked = checked;
      input.closest(".simple-choice").querySelector(".simple-channel-design").disabled = !checked;
    }
    User_customizationUpdateSelectionCount();
  });
}
document.getElementById("User_customizationCancel").addEventListener("click", () => User_customizationElements.User_customizationPicker.close());
User_customizationElements.User_customizationPickerForm.addEventListener("submit", async event => {
  event.preventDefault();
  const checked = [...User_customizationElements.User_customizationChoices.querySelectorAll(".simple-channel-checkbox:checked")].filter(input => {
    const { device, channel } = User_customizationLookup({ device_id: input.dataset.deviceId, output_signal: input.dataset.pin });
    return User_customizationCanDisplay(device, channel, input.dataset.displayType);
  }).map(input => ({
    device_id: input.dataset.deviceId,
    output_signal: input.dataset.pin,
    ...(input.dataset.displayType === "lamp" ? {
      display_type: "lamp", lamp_design: input.closest(".simple-choice").querySelector(".simple-channel-design").value
    } : input.dataset.displayType === "graph" ? {
      display_type: "graph",
      graph_design: input.closest(".simple-choice").querySelector(".simple-channel-design").value,
      ...(User_customizationGraphConfig.isGaugeDesign(input.closest(".simple-choice").querySelector(".simple-channel-design").value) ? {
        graph_settings: JSON.parse(input.closest(".simple-choice").querySelector(".simple-gauge").dataset.settings)
      } : {}),
      ...(input.closest(".simple-choice").querySelector(".simple-channel-design").value === "graph-05" ? {
        chart_settings: JSON.parse(input.closest(".simple-choice").querySelector(".simple-stream").dataset.settings)
      } : {})
    } : {
      switch_design: input.closest(".simple-choice").querySelector(".simple-channel-design").value
    })
  }));
  const keys = new Set(checked.map(User_customizationItemKey));
  const selectedByKey = new Map(checked.map(channel => [User_customizationItemKey(channel), channel]));
  const retained = User_customizationSelection.filter(channel => {
    const { device, channel: current } = User_customizationLookup(channel);
    return !User_customizationCanDisplay(device, current, channel.display_type) || keys.has(User_customizationItemKey(channel));
  })
    .map(channel => ({ ...channel, ...selectedByKey.get(User_customizationItemKey(channel)) }));
  const retainedKeys = new Set(retained.map(User_customizationItemKey));
  const channels = [...retained, ...checked.filter(channel => !retainedKeys.has(User_customizationItemKey(channel)))];
  if (await User_customizationSaveSelection(channels)) User_customizationElements.User_customizationPicker.close();
});

function User_customizationHandleSettingsClick(event) {
  const button = event.target.closest(".simple-channel-settings");
  if (!button || User_customizationSaving) return;
  const card = button.closest(".simple-control-card");
  const selection = User_customizationSelection.find(item => User_customizationItemKey(item) === User_customizationItemKey({
    device_id: card.dataset.deviceId, output_signal: card.dataset.pin, display_type: card.dataset.displayType
  }));
  if (!selection) return;
  User_customizationGraphEditingKey = User_customizationItemKey(selection);
  const form = document.getElementById("User_customizationGraphSettingsForm");
  form.elements.namedItem("remove_channel").checked = false;
  form.elements.namedItem("popup_channel").checked = false;
  document.getElementById("User_customizationGraphSettingsSave").formNoValidate = false;
  const config = User_customizationGraphConfig.validate(selection.graph_settings);
  if (config.error) {
    User_customizationElements.User_customizationMessage.textContent = config.error;
    return;
  }
  for (const [key, value] of Object.entries(config.settings)) {
    const input = form.elements.namedItem(key);
    if (typeof value === "boolean") input.checked = value;
    else input.value = value;
  }
  for (const [key, value] of Object.entries(User_customizationChannelSettings(selection))) {
    const input = form.elements.namedItem(key);
    if (typeof value === "boolean") input.checked = value;
    else input.value = value;
  }
  const chartConfig = User_customizationGraphConfig.validateChart(selection.chart_settings);
  if (chartConfig.error) {
    User_customizationElements.User_customizationMessage.textContent = chartConfig.error;
    return;
  }
  for (const [key, value] of Object.entries(chartConfig.settings)) {
    const input = form.elements.namedItem(`chart_${key}`);
    if (typeof value === "boolean") input.checked = value;
    else input.value = value;
  }
  const type = selection.display_type || "switch";
  const designs = type === "lamp" ? User_customization_LAMP_OPTIONS : type === "graph" ? User_customization_GRAPH_OPTIONS : User_customization_SWITCH_OPTIONS;
  const design = type === "lamp" ? selection.lamp_design || "lamp-01" : type === "graph" ? selection.graph_design || "graph-01" : User_customizationSwitchDesignFor(selection);
  form.elements.namedItem("channel_design").innerHTML = designs.map(([value, label]) => `<option value="${value}" ${value === design ? "selected" : ""}>${label}</option>`).join("");
  User_customizationSettingsDesignChanged();
  document.getElementById("User_customizationGraphSettingsChannel").textContent = `${selection.device_id} · ${selection.output_signal}`;
  document.getElementById("User_customizationGraphSettingsMessage").textContent = "";
  document.getElementById("User_customizationGraphSettings").showModal();
  window.focus();
}
User_customizationElements.User_customizationGrid.addEventListener("click", User_customizationHandleSettingsClick);
function User_customizationSettingsDesignChanged() {
  const design = document.getElementById("User_customizationSettingsDesign").value;
  const lamp = document.getElementById("User_customizationLampSettingsFields");
  lamp.hidden = !design.startsWith("lamp-");
  lamp.disabled = lamp.hidden;
  const gauge = document.getElementById("User_customizationGaugeSettingsFields");
  gauge.hidden = !User_customizationGraphConfig.isGaugeDesign(design);
  gauge.disabled = gauge.hidden;
  const chart = document.getElementById("User_customizationChartSettingsFields");
  chart.hidden = design !== "graph-05";
  chart.disabled = chart.hidden;
  const form = document.getElementById("User_customizationGraphSettingsForm");
  if (form) for (const key of ["y_min", "y_max"]) {
    form.elements.namedItem(`chart_${key}`).disabled = form.elements.namedItem("chart_y_mode").value !== "manual";
  }
  document.getElementById("User_customizationAngleSettingsInfo").hidden = design !== "graph-01";
  const arrow = document.getElementById("User_customizationArrowSettingsFields");
  arrow.hidden = design !== "lamp-18";
  arrow.disabled = arrow.hidden;
  const graphButton = document.getElementById("User_customizationGraphButtonSettingsFields");
  graphButton.hidden = design !== "graph-06";
  graphButton.disabled = graphButton.hidden;
  const isSwitch = design.startsWith("design-");
  document.getElementById("User_customizationSwitchExpansion").hidden = !isSwitch;
  document.getElementById("User_customizationSwitchExpansionHelp").hidden = !isSwitch;
  const expandSwitch = form.elements.namedItem("expand_switch");
  expandSwitch.disabled = !isSwitch || !form.elements.namedItem("hide_device_name").checked || !form.elements.namedItem("hide_channel_name").checked;
  if (expandSwitch.disabled) expandSwitch.checked = false;
  const displayExpansion = document.getElementById("User_customizationDisplayExpansion");
  displayExpansion.hidden = isSwitch;
  displayExpansion.disabled = isSwitch;
  const label = design.startsWith("lamp-") ? "램프" : "그래프";
  document.getElementById("User_customizationExpandHeaderLabel").textContent = `${label} 확장(Header)`;
  document.getElementById("User_customizationExpandTailLabel").textContent = `${label} 확장(Tail)`;
}
document.getElementById("User_customizationSettingsDesign").addEventListener("change", User_customizationSettingsDesignChanged);
document.getElementById("User_customizationGraphSettingsForm").elements.namedItem("chart_y_mode").addEventListener("change", User_customizationSettingsDesignChanged);
for (const key of ["hide_device_name", "hide_channel_name"]) {
  document.getElementById("User_customizationGraphSettingsForm").elements.namedItem(key).addEventListener("change", User_customizationSettingsDesignChanged);
}
for (const [id, field] of [["User_customizationOnColorDefault", "on_color"], ["User_customizationOffColorDefault", "off_color"]]) {
  document.getElementById(id).addEventListener("click", () => {
    document.getElementById("User_customizationGraphSettingsForm").elements.namedItem(field).value = User_customizationGraphConfig.channelDefaults[field];
  });
}
document.getElementById("User_customizationGraphSettingsCancel").addEventListener("click", () => document.getElementById("User_customizationGraphSettings").close());
document.getElementById("User_customizationGraphSettingsForm").elements.namedItem("remove_channel").addEventListener("change", event => {
  document.getElementById("User_customizationGraphSettingsSave").formNoValidate = event.target.checked;
});
document.getElementById("User_customizationGraphSettingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (User_customizationSaving) return;
  if (form.elements.namedItem("remove_channel").checked) {
    const saveButton = document.getElementById("User_customizationGraphSettingsSave");
    const message = document.getElementById("User_customizationGraphSettingsMessage");
    if (!User_customizationSelection.some(item => User_customizationItemKey(item) === User_customizationGraphEditingKey)) {
      message.textContent = "설정할 채널이 삭제되었습니다. 창을 닫고 다시 선택하세요.";
      return;
    }
    saveButton.disabled = true;
    try {
      const channels = User_customizationSelection.filter(item => User_customizationItemKey(item) !== User_customizationGraphEditingKey);
      if (await User_customizationSaveSelection(channels)) document.getElementById("User_customizationGraphSettings").close();
      else message.textContent = User_customizationElements.User_customizationMessage.textContent;
    } finally {
      saveButton.disabled = false;
    }
    return;
  }
  const settings = Object.fromEntries(Object.entries(User_customizationGraphConfig.defaults).map(([key, value]) => {
    const input = form.elements.namedItem(key);
    return [key, typeof value === "boolean" ? input.checked : typeof value === "number" ? input.valueAsNumber : input.value];
  }));
  const design = form.elements.namedItem("channel_design").value;
  const config = User_customizationGraphConfig.validate(settings);
  const message = document.getElementById("User_customizationGraphSettingsMessage");
  if (User_customizationGraphConfig.isGaugeDesign(design) && config.error) {
    message.textContent = config.error;
    return;
  }
  const chartConfig = design === "graph-05" ? User_customizationGraphConfig.validateChart(Object.fromEntries(Object.entries(User_customizationGraphConfig.chartDefaults).map(([key, value]) => {
    const input = form.elements.namedItem(`chart_${key}`);
    return [key, typeof value === "boolean" ? input.checked : typeof value === "number" ? input.valueAsNumber : input.value];
  }))) : null;
  if (chartConfig?.error) {
    message.textContent = chartConfig.error;
    return;
  }
  const common = User_customizationGraphConfig.validateChannel(Object.fromEntries(Object.entries(User_customizationGraphConfig.channelDefaults).map(([key, value]) => {
    const input = form.elements.namedItem(key);
    return [key, typeof value === "boolean" ? input.checked : typeof value === "number" ? key === "graph_button_font_size" ? Number(input.value) : input.valueAsNumber : input.value];
  })));
  if (common.error) {
    message.textContent = common.error;
    return;
  }
  if (!User_customizationSelection.some(item => User_customizationItemKey(item) === User_customizationGraphEditingKey)) {
    message.textContent = "설정할 채널이 삭제되었습니다. 창을 닫고 다시 선택하세요.";
    return;
  }
  const button = document.getElementById("User_customizationGraphSettingsSave");
  button.disabled = true;
  let reservation = null;
  try {
    const current = User_customizationSelection.find(item => User_customizationItemKey(item) === User_customizationGraphEditingKey);
    const type = current.display_type || "switch";
    const options = type === "lamp" ? User_customization_LAMP_OPTIONS : type === "graph" ? User_customization_GRAPH_OPTIONS : User_customization_SWITCH_OPTIONS;
    if (!options.some(([value]) => value === design)) {
      message.textContent = "현재 유형에 해당하는 디자인을 선택하세요.";
      return;
    }
    if (type === "switch" && !(common.settings.hide_device_name && common.settings.hide_channel_name)) common.settings.expand_switch = false;
    if (form.elements.namedItem("popup_channel").checked) {
      reservation = User_customizationReservePopup(User_customizationGraphEditingKey);
      if (!reservation) {
        message.textContent = "팝업이 차단되었습니다. 브라우저에서 팝업을 허용한 뒤 다시 저장하세요.";
        return;
      }
    }
    const channels = User_customizationSelection.map(item => {
      if (User_customizationItemKey(item) !== User_customizationGraphEditingKey) return item;
      const next = { ...item, channel_settings: common.settings };
      if (type === "switch") next.switch_design = design;
      else if (type === "lamp") next.lamp_design = design;
      else {
        next.graph_design = design;
        if (User_customizationGraphConfig.isGaugeDesign(design)) next.graph_settings = config.settings;
        if (design === "graph-05") next.chart_settings = chartConfig.settings;
      }
      return next;
    });
    if (await User_customizationSaveSelection(channels)) {
      document.getElementById("User_customizationGraphSettings").close();
      if (reservation) {
        User_customizationOpenPopup(User_customizationGraphEditingKey, reservation);
        reservation = null;
      }
    }
    else message.textContent = User_customizationElements.User_customizationMessage.textContent;
  } finally {
    if (reservation?.promise) reservation.promise.then(popup => popup.close(), () => {});
    else if (reservation?.created && !reservation.window.closed) reservation.window.close();
    button.disabled = false;
  }
});

function User_customizationMove(from, to) {
  const visible = User_customizationVisibleSelection();
  if (User_customizationSaving || from === to || to < 0 || to >= visible.length) return;
  const fromIndex = User_customizationSelection.indexOf(visible[from]);
  const toIndex = User_customizationSelection.indexOf(visible[to]);
  const next = [...User_customizationSelection];
  const [channel] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, channel);
  void User_customizationSaveSelection(next).then(() => User_customizationElements.User_customizationGrid.children[to]?.querySelector(".simple-drag-handle").focus());
}

User_customizationElements.User_customizationGrid.addEventListener("keydown", event => {
  if (!event.target.closest(".simple-drag-handle")) return;
  const moves = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const index = [...User_customizationElements.User_customizationGrid.children].indexOf(event.target.closest(".simple-control-card"));
  User_customizationMove(index, index + moves[event.key]);
});
User_customizationElements.User_customizationGrid.addEventListener("pointerdown", event => {
  const handle = event.target.closest(".simple-drag-handle");
  if (!handle || User_customizationSaving || User_customizationDrag || event.button !== 0) return;
  const card = handle.closest(".simple-control-card");
  User_customizationDrag = { card, from: [...User_customizationElements.User_customizationGrid.children].indexOf(card), to: -1, x: event.clientX, y: event.clientY, moved: false };
  handle.setPointerCapture(event.pointerId);
});
User_customizationElements.User_customizationGrid.addEventListener("pointermove", event => {
  if (!User_customizationDrag) return;
  if (Math.hypot(event.clientX - User_customizationDrag.x, event.clientY - User_customizationDrag.y) < 6) return;
  User_customizationDrag.moved = true;
  User_customizationDrag.card.classList.add("is-dragging");
  for (const card of User_customizationElements.User_customizationGrid.children) card.classList.remove("is-drop-target");
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".simple-control-card");
  User_customizationDrag.to = [...User_customizationElements.User_customizationGrid.children].indexOf(target);
  target?.classList.add("is-drop-target");
});
for (const type of ["pointerup", "pointercancel"]) {
  User_customizationElements.User_customizationGrid.addEventListener(type, () => {
    if (!User_customizationDrag) return;
    const drag = User_customizationDrag;
    User_customizationDrag = null;
    for (const card of User_customizationElements.User_customizationGrid.children) card.classList.remove("is-dragging", "is-drop-target");
    if (type === "pointerup" && drag.moved) User_customizationMove(drag.from, drag.to);
  });
}

window.addEventListener("factory-permissions-changed", event => {
  User_customizationPermissions = event.detail.permissions || {};
  User_customizationUpdateSwitches();
});
const User_customizationSizeObserver = new ResizeObserver(User_customizationUpdateCardSizes);
User_customizationSizeObserver.observe(User_customizationElements.User_customizationGrid);
window.addEventListener("focus", () => { User_customizationConnect(); void User_customizationRefresh(); });
window.addEventListener("online", User_customizationConnect);
window.addEventListener("pageshow", event => { if (event.persisted) { User_customizationConnect(); void User_customizationRefresh(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "hidden") { User_customizationConnect(); void User_customizationRefresh(); } });
setInterval(() => { if (document.visibilityState !== "hidden") void User_customizationRefresh(); }, 30000);
setInterval(() => {
  if (document.visibilityState === "hidden") return;
  for (const container of [User_customizationElements.User_customizationGrid, ...User_customizationPopupCards(), User_customizationElements.User_customizationChoices]) {
    for (const graph of container.querySelectorAll(".simple-stream")) {
      const { channel } = User_customizationLookup({ device_id: graph.dataset.deviceId, output_signal: graph.dataset.pin });
      User_customizationUpdateGraph(graph, channel);
    }
  }
}, 250);
window.addEventListener("pagehide", () => {
  for (const popup of User_customizationPopupWindows.values()) if (!popup.closed) popup.close();
  User_customizationPopupWindows.clear();
});
void User_customizationRefresh().then(User_customizationConnect);