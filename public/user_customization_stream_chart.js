(function (root) {
  const histories = new Map();
  const maxSamples = 10000;

  function numeric(value) {
    const text = String(value ?? "").trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    const result = Number(text);
    return Number.isFinite(result) ? result : null;
  }

  function sample(history, time, value, settings) {
    const last = history.at(-1);
    if (last && time < last.time) history.length = 0;
    history.push({ time, value });
    const cutoff = time - settings.window_seconds * 1000;
    while (history.length > 1 && history[1].time < cutoff) history.shift();
    if (history.length > maxSamples) history.splice(0, history.length - maxSamples);
    return history;
  }

  function record(deviceId, pin, value, time = Date.now()) {
    const history = histories.get(JSON.stringify([deviceId, pin]));
    if (history) sample(history, time, numeric(value), { window_seconds: 86400 });
  }

  function range(history, settings, time) {
    if (settings.y_mode === "manual") return [settings.y_min, settings.y_max];
    let min = Infinity, max = -Infinity;
    for (const point of history) {
      if (point.value === null || (point.time < time - settings.window_seconds * 1000 && point !== history.at(-1))) continue;
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
    if (min === Infinity) return [0, 1];
    const padding = Math.max(Math.abs(min), Math.abs(max), 1) * 0.05;
    const lower = min - padding, upper = max + padding;
    return [Number.isFinite(lower) ? lower : min, Number.isFinite(upper) ? upper : max];
  }

  function fraction(value, min, max) {
    const scale = Math.max(Math.abs(min), Math.abs(max), 1);
    return (value / scale - min / scale) / (max / scale - min / scale);
  }

  function formatValue(value) {
    return Number(value.toPrecision(5)).toString();
  }

  function plot(history, settings, time, width, height) {
    const left = settings.show_axes ? 48 : 4, top = settings.show_axes ? 8 : 4;
    const w = Math.max(1, width - left - 8), h = Math.max(1, height - top - (settings.show_axes ? 22 : 4));
    const [min, max] = range(history, settings, time);
    const x = point => (point.time - time + settings.window_seconds * 1000) / (settings.window_seconds * 1000) * w;
    const y = value => (1 - Math.max(-1000000, Math.min(1000000, fraction(value, min, max)))) * h;
    let grid = "", labels = "";
    for (let index = 0; index <= 4; index++) {
      const f = index / 4, px = left + w * f, py = top + h * f;
      if (settings.show_grid) grid += `<path d="M${left} ${py}h${w} M${px} ${top}v${h}" fill="none" stroke="#cbd5e1" stroke-width="0.7"/>`;
      if (settings.show_axes) {
        const value = max * (1 - f) + min * f;
        const date = new Date(time - settings.window_seconds * 1000 * (1 - f));
        const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
        labels += `<text x="${left - 5}" y="${py}" text-anchor="end" dominant-baseline="middle">${formatValue(value)}</text>`;
        labels += `<text x="${px}" y="${height - 4}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}">${clock}</text>`;
      }
    }
    const segments = [];
    let segment = [];
    for (const point of history) {
      if (point.value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push([x(point), y(point.value)]);
    }
    if (segment.length) segments.push(segment);
    let data = "";
    for (const points of segments) {
      if (settings.chart_type === "bar") {
        const barWidth = Math.max(1, Math.min(24, w / Math.max(history.length, 1) * 0.8));
        const baseline = y(Math.max(min, Math.min(max, 0)));
        for (const [px, py] of points) data += `<rect x="${px - barWidth / 2}" y="${Math.min(py, baseline)}" width="${barWidth}" height="${Math.max(1, Math.abs(baseline - py))}" fill="${settings.line_color}"/>`;
      } else {
        const path = points.map(([px, py], index) => {
          if (index === 0) return `M${px} ${py}`;
          return settings.chart_type === "step" ? `H${px} V${py}` : `L${px} ${py}`;
        }).join(" ");
        if (settings.chart_type === "area") data += `<path d="${path} L${points.at(-1)[0]} ${h} L${points[0][0]} ${h} Z" fill="${settings.line_color}" fill-opacity="0.2"/>`;
        data += `<path d="${path}" fill="none" stroke="${settings.line_color}" stroke-width="${settings.line_width}" stroke-linejoin="round"/>`;
      }
      for (const [px, py] of points) data += `<circle class="simple-stream-point" cx="${px}" cy="${py}" r="${settings.point_radius}" fill="${settings.point_color}" stroke="${settings.point_color}" stroke-width="${settings.point_width}"/>`;
    }
    const latest = history.at(-1);
    if (latest && latest.value !== null && latest.time < time) {
      data += `<path class="simple-stream-hold" d="M${Math.max(0, x(latest))} ${y(latest.value)} H${w}" fill="none" stroke="${settings.line_color}" stroke-width="${settings.line_width}" stroke-opacity="0.3"/>`;
    }
    return `<rect width="${width}" height="${height}" fill="${settings.background_color}"/>${grid}<g fill="#526078" font-size="9">${labels}</g><svg x="${left}" y="${top}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${data}</svg>`;
  }

  function update(graph, channel, connected, time = Date.now()) {
    const settings = JSON.parse(graph.dataset.settings);
    const key = JSON.stringify([graph.dataset.deviceId, graph.dataset.pin]);
    let history = histories.get(key);
    if (!history) {
      history = [];
      histories.set(key, history);
      sample(history, time, connected ? numeric(channel?.input_message) : null, settings);
    }
    const value = connected ? numeric(channel?.input_message) : null;
    if (!connected && history.at(-1)?.value !== null) sample(history, time, null, settings);
    const cutoff = time - settings.window_seconds * 1000;
    const visible = history.filter((point, index) => point.time >= cutoff || history[index + 1]?.time >= cutoff || index === history.length - 1);
    const text = String(channel?.input_message ?? "");
    const readout = graph.querySelector(".simple-stream-value");
    readout.textContent = `${text}${settings.show_unit && settings.unit ? ` ${settings.unit}` : ""}`;
    readout.title = `IStr${graph.dataset.pin.slice(2)}: ${text}`;
    graph.querySelector(".simple-stream-error").textContent = !connected ? "연결 대기 중" : value === null ? "IStr: 숫자 입력 필요" : "";
    graph.setAttribute("aria-label", `${settings.title}, IStr: ${text}${settings.show_unit ? ` ${settings.unit}` : ""} (실시간 차트)`);
    const svg = graph.querySelector(".simple-stream-plot");
    const bounds = svg.getBoundingClientRect();
    const width = Math.max(120, Math.round(bounds.width)), height = Math.max(45, Math.round(bounds.height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = plot(visible, settings, time, width, height);
  }

  const api = { numeric, sample, record, range, fraction, plot, update };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.User_customizationStreamChart = api;
})(globalThis);
