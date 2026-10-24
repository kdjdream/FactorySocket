(function (root) {
  const arrowDirections = Object.freeze({ left: 180, right: 0, up: -90, down: 90, up_right: -45, down_right: 45, up_left: -135, down_left: 135 });
  const channelDefaults = Object.freeze({
    device_name_override: "", channel_name_override: "",
    width_multiplier: 1, height_multiplier: 1, hide_is_state: false, fill_lamp: false,
    expand_switch: false, expand_header: false, expand_tail: false, scale_contents: false,
    hide_device_name: false, hide_device_id: false, hide_channel_name: false,
    hide_signal: false, hide_istr: false, on_color: "#b42318", off_color: "#525b66", arrow_direction: "left",
    graph_button_height: "button", graph_button_font_size: 20, graph_button_text_color: "#ffffff",
    graph_button_font_family: "default"
  });

  function validateChannel(settings = {}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { error: "채널 기본 옵션이 올바르지 않습니다." };
    const value = { ...channelDefaults, ...settings };
    for (const field of ["width_multiplier", "height_multiplier"]) {
      if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 4) {
        return { error: "채널 가로·세로 배율은 각각 1~4 사이의 정수로 입력하세요." };
      }
    }
    for (const field of ["device_name_override", "channel_name_override"]) {
      if (value[field] === null) value[field] = "";
      if (typeof value[field] !== "string" || value[field].length > 100) {
        return { error: "변경할 이름은 100자 이내의 문자열로 입력하세요." };
      }
      value[field] = value[field].trim();
    }
    if (typeof value.arrow_direction !== "string" || !Object.hasOwn(arrowDirections, value.arrow_direction)) return { error: "화살표 방향이 올바르지 않습니다." };
    if (!["button", "bottom", "channel"].includes(value.graph_button_height)) {
      return { error: "텍스트 박스 높이 설정이 올바르지 않습니다." };
    }
    if (!["default", "sans-serif", "serif", "monospace", "malgun-gothic", "gulim"].includes(value.graph_button_font_family)) {
      return { error: "텍스트 폰트 설정이 올바르지 않습니다." };
    }
    for (const field of Object.keys(channelDefaults)) {
      if (field === "arrow_direction" || field.endsWith("_name_override") || field.endsWith("_multiplier") || field === "graph_button_font_size" || field === "graph_button_height" || field === "graph_button_font_family") continue;
      if (typeof channelDefaults[field] === "boolean" ? typeof value[field] !== "boolean" : typeof value[field] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[field])) {
        return { error: "채널 숨김 옵션 또는 색상(#RRGGBB)이 올바르지 않습니다." };
      }
    }
    if (!Number.isInteger(value.graph_button_font_size) || value.graph_button_font_size < 12 || value.graph_button_font_size > 144) {
      return { error: "그래프 버튼 문자 크기는 12~144px 사이의 정수로 입력하세요." };
    }
    return { settings: Object.fromEntries(Object.keys(channelDefaults).map(key => [key, value[key]])) };
  }

  function migrateChannel(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
    const migrated = { ...settings };
    for (const field of ["width_multiplier", "height_multiplier"]) {
      if (migrated[field] === 5) migrated[field] = 4;
    }
    return migrated;
  }

  const defaults = Object.freeze({
    title: "Pressure", unit: "MPa", min: 0, max: 100, normal_min: 20, normal_max: 80,
    major_interval: 10, minor_interval: 2, fill_graph: false,
    hide_device_id: false, hide_signal: false,
    hide_istr: false, hide_device_name: false, hide_channel_name: false,
    hide_measurement_type: false, hide_unit: false, hide_scale_labels: false
  });

  function validate(settings = {}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { error: "계기판 설정이 올바르지 않습니다." };
    const value = { ...defaults, ...settings };
    for (const field of ["title", "unit"]) {
      if (typeof value[field] !== "string" || value[field].length > 40) return { error: "제목과 단위는 각각 40자 이내로 입력하세요." };
    }
    for (const field of ["min", "max", "normal_min", "normal_max"]) {
      if (typeof value[field] !== "number" || !Number.isFinite(value[field])) return { error: "눈금과 정상 범위는 유한한 숫자로 입력하세요." };
    }
    if (value.min >= value.max || !Number.isFinite(value.max - value.min)) return { error: "눈금 상한은 하한보다 커야 합니다." };
    for (const field of ["major_interval", "minor_interval"]) {
      if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] <= 0) {
        return { error: "주 눈금·보조 눈금 간격은 0보다 큰 유한한 숫자로 입력하세요." };
      }
    }
    if ((value.max - value.min) / value.major_interval + (value.max - value.min) / value.minor_interval > 1000) {
      return { error: "눈금이 너무 많습니다. 주 눈금·보조 눈금 간격을 늘려 합계 1000개 이하로 지정하세요." };
    }
    if (value.normal_min < value.min || value.normal_max > value.max || value.normal_min >= value.normal_max) {
      return { error: "정상 범위는 눈금 범위 안에서 하한보다 상한이 커야 합니다." };
    }
    for (const field of Object.keys(defaults).filter(key => key.startsWith("hide_"))) {
      if (typeof value[field] !== "boolean") return { error: "레이블 숨김 설정이 올바르지 않습니다." };
    }
    if (typeof value.fill_graph !== "boolean") return { error: "그래프 꽉 채우기 설정이 올바르지 않습니다." };
    return { settings: Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]])) };
  }

  function ticks(settings) {
    const range = settings.max - settings.min;
    const result = [{ fraction: 0, major: true }, { fraction: 1, major: true }];
    for (const [interval, major] of [[settings.major_interval, true], [settings.minor_interval, false]]) {
      const count = Math.floor(range / interval);
      for (let index = 1; index <= count; index++) {
        result.push({ fraction: index * interval / range, major });
      }
    }
    result.sort((a, b) => a.fraction - b.fraction);
    return result.reduce((merged, tick) => {
      const previous = merged[merged.length - 1];
      if (previous && Math.abs(previous.fraction - tick.fraction) < 1e-10) previous.major ||= tick.major;
      else merged.push(tick);
      return merged;
    }, []);
  }

  function isGaugeDesign(design) {
    return design === "graph-02" || design === "graph-03" || design === "graph-04";
  }

  const chartDefaults = Object.freeze({
    title: "실시간 차트", unit: "", window_seconds: 60,
    y_mode: "auto", y_min: 0, y_max: 100, chart_type: "line",
    line_color: "#ec4899", background_color: "#f5f7ff", line_width: 2,
    point_color: "#ec4899", point_radius: 2, point_width: 1,
    show_grid: true, show_axes: true, show_value: true, show_title: true, show_unit: true
  });

  function validateChart(settings = {}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { error: "차트 설정이 올바르지 않습니다." };
    const value = { ...chartDefaults, ...settings };
    for (const field of ["title", "unit"]) {
      if (typeof value[field] !== "string" || value[field].length > 40) return { error: "차트 제목과 단위는 각각 40자 이내로 입력하세요." };
    }
    if (!Number.isInteger(value.window_seconds) || value.window_seconds < 1 || value.window_seconds > 86400) return { error: "표시 시간은 1~86400초 사이의 정수로 입력하세요." };
    if (!["auto", "manual"].includes(value.y_mode)) return { error: "Y축 범위 방식을 선택하세요." };
    if (![value.y_min, value.y_max].every(number => typeof number === "number" && Number.isFinite(number))
      || value.y_min >= value.y_max || !Number.isFinite(value.y_max - value.y_min)) {
      if (value.y_mode === "manual") return { error: "Y축 상한은 하한보다 큰 유한한 숫자로 입력하세요." };
      value.y_min = chartDefaults.y_min;
      value.y_max = chartDefaults.y_max;
    }
    if (!["line", "area", "step", "bar"].includes(value.chart_type)) return { error: "차트 종류가 올바르지 않습니다." };
    for (const field of ["line_color", "background_color", "point_color"]) {
      if (typeof value[field] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[field])) return { error: "차트 색상은 #RRGGBB 형식으로 지정하세요." };
    }
    if (typeof value.line_width !== "number" || !Number.isFinite(value.line_width) || value.line_width < 1 || value.line_width > 6) return { error: "선 두께는 1~6 사이로 입력하세요." };
    if (typeof value.point_radius !== "number" || !Number.isFinite(value.point_radius) || value.point_radius < 1 || value.point_radius > 8) return { error: "데이터 원 반지름은 1~8 사이로 입력하세요." };
    if (typeof value.point_width !== "number" || !Number.isFinite(value.point_width) || value.point_width < 0 || value.point_width > 6) return { error: "데이터 원 테두리 두께는 0~6 사이로 입력하세요." };
    for (const field of Object.keys(chartDefaults).filter(key => key.startsWith("show_"))) {
      if (typeof value[field] !== "boolean") return { error: "차트 표시 옵션이 올바르지 않습니다." };
    }
    return { settings: Object.fromEntries(Object.keys(chartDefaults).map(key => [key, value[key]])) };
  }

  const api = { defaults, validate, ticks, channelDefaults, validateChannel, migrateChannel, arrowDirections, isGaugeDesign, chartDefaults, validateChart };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.User_customizationGraphConfig = api;
})(globalThis);
