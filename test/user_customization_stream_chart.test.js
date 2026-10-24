const test = require("node:test");
const assert = require("node:assert/strict");
const Config = require("../public/user_customization_graph_config");
const Chart = require("../public/user_customization_stream_chart");

test("stream chart config validates every setting and strips unknown fields", () => {
  assert.deepEqual(Config.validateChart().settings, Config.chartDefaults);
  for (const chart_type of ["line", "area", "step", "bar"]) {
    assert.equal(Config.validateChart({ chart_type }).settings.chart_type, chart_type);
  }
  for (const settings of [
    null, [], { title: 1 }, { unit: "a".repeat(41) }, { window_seconds: 0 }, { window_seconds: 86401 },
    { window_seconds: 1.5 },
    { chart_type: "pie" }, { y_mode: "unknown" }, { y_mode: "manual", y_min: 1, y_max: 1 },
    { y_mode: "manual", y_max: Infinity }, { y_mode: "manual", y_min: "0" },
    { line_color: "red" }, { background_color: "<script>" }, { line_width: 0 }, { line_width: NaN },
    { point_color: "red" }, { point_radius: 0 }, { point_radius: Infinity }, { point_width: -1 }, { point_width: 7 },
    { show_grid: 1 }, { show_axes: "true" }, { show_unit: null }
  ]) assert.ok(Config.validateChart(settings).error, JSON.stringify(settings));
  const valid = Config.validateChart({ y_mode: "manual", y_min: -2.5, y_max: 4.5, window_seconds: 86400, sample_ms: 250, extra: true });
  assert.equal(valid.settings.y_min, -2.5);
  assert.ok(!Object.hasOwn(valid.settings, "extra"));
  assert.ok(!Config.validateChart({ y_mode: "auto", y_min: NaN, y_max: NaN }).error);
});

test("stream numeric input accepts signed decimal IStr and rejects non-finite or partial values", () => {
  for (const [text, number] of [[" -2.5 ", -2.5], ["0", 0], [".5", 0.5], ["1e2", 100]]) assert.equal(Chart.numeric(text), number);
  for (const text of ["", null, "ON", "NaN", "Infinity", "1e999", "5MPa", "<script>"]) assert.equal(Chart.numeric(text), null);
});

test("stream collection retains every arrival regardless of interval and bounds retention", () => {
  const settings = { ...Config.chartDefaults, window_seconds: 2 };
  const history = [];
  Chart.sample(history, 1000, 10, settings);
  Chart.sample(history, 1500, 20, settings);
  assert.equal(history.length, 2);
  Chart.sample(history, 2000, 20, settings);
  Chart.sample(history, 2100, null, settings);
  Chart.sample(history, 2200, 30, settings);
  assert.deepEqual(history.map(point => point.value), [10, 20, 20, null, 30]);
  Chart.sample(history, 7000, 40, settings);
  assert.deepEqual(history, [{ time: 2200, value: 30 }, { time: 7000, value: 40 }]);
  Chart.sample(history, 100, 5, settings);
  assert.deepEqual(history, [{ time: 100, value: 5 }]);
  const many = [];
  for (let index = 0; index < 11000; index++) Chart.sample(many, index * 250, index, { ...settings, window_seconds: 86400, sample_ms: 250 });
  assert.equal(many.length, 10000);
});

test("stream auto axes use visible extrema including negatives, constants and extreme numbers", () => {
  const settings = { ...Config.chartDefaults, window_seconds: 1 };
  const points = [{ time: 0, value: 10000 }, { time: 1000, value: -5 }, { time: 1500, value: 20 }, { time: 1800, value: null }];
  const [min, max] = Chart.range(points, settings, 1900);
  assert.ok(min < -5 && max > 20 && max < 10000);
  assert.deepEqual(Chart.range(points, { ...settings, y_mode: "manual", y_min: -10, y_max: 10 }, 1900), [-10, 10]);
  assert.deepEqual(Chart.range([], settings, 1900), [0, 1]);
  for (const value of [0, -20, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const bounds = Chart.range([{ time: 1900, value }], settings, 1900);
    assert.ok(bounds.every(Number.isFinite));
    assert.ok(bounds[0] < bounds[1]);
    assert.ok(Number.isFinite(Chart.fraction(value, ...bounds)));
  }
});

test("stream plot renders selectable types, clipped data, time labels and display options", () => {
  const history = [{ time: 1000, value: -10 }, { time: 2000, value: 30 }, { time: 3000, value: null }, { time: 4000, value: 10 }];
  for (const chart_type of ["line", "area", "step", "bar"]) {
    const settings = { ...Config.chartDefaults, chart_type, y_mode: "manual", y_min: 0, y_max: 20 };
    const svg = Chart.plot(history, settings, 5000, 400, 180);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
    assert.match(svg, /overflow="hidden"/);
    assert.match(svg, /\d\d:\d\d:\d\d/);
    assert.equal((svg.match(/class="simple-stream-point"/g) || []).length, 3);
    assert.equal((svg.match(/r="2"/g) || []).length, 3);
    if (chart_type === "line") {
      assert.match(svg, /stroke-width="2" stroke-linejoin="round"/);
      assert.doesNotMatch(svg, /stroke-dasharray/);
    }
    const yLabels = [...svg.matchAll(/text-anchor="end" dominant-baseline="middle">([^<]+)</g)].map(match => Number(match[1]));
    assert.deepEqual(yLabels, [20, 15, 10, 5, 0]);
    if (chart_type === "area") assert.match(svg, /fill-opacity="0.2"/);
    if (chart_type === "step") assert.match(svg, /H[\d.]+ V/);
    if (chart_type === "bar") assert.match(svg, /<rect x=/);
  }
  const plain = Chart.plot(history, { ...Config.chartDefaults, show_axes: false, show_grid: false }, 5000, 400, 180);
  assert.doesNotMatch(plain, /<text|stroke="#cbd5e1"/);
});

test("stream update shares channel history between cards and popups and reports invalid or disconnected data", () => {
  function graph() {
    const fields = {
      ".simple-stream-value": {}, ".simple-stream-error": {},
      ".simple-stream-plot": { getBoundingClientRect: () => ({ width: 400, height: 180 }), setAttribute() {} }
    };
    return {
      fields, dataset: { deviceId: "STREAM-TEST", pin: "OS1", settings: JSON.stringify(Config.chartDefaults) },
      querySelector: selector => fields[selector], setAttribute() {}
    };
  }
  const card = graph(), popup = graph();
  Chart.update(card, { input_message: "10" }, true, 1000);
  Chart.record("STREAM-TEST", "OS1", "20", 2000);
  Chart.update(card, { input_message: "20" }, true, 2000);
  Chart.update(popup, { input_message: "20" }, true, 2000);
  assert.equal(card.fields[".simple-stream-plot"].innerHTML, popup.fields[".simple-stream-plot"].innerHTML);
  Chart.record("STREAM-TEST", "OS1", "21", 2001);
  Chart.record("STREAM-TEST", "OS1", "22", 2001);
  Chart.record("STREAM-TEST", "OS1", "23", 2002);
  Chart.update(card, { input_message: "23" }, true, 2002);
  const recorded = card.fields[".simple-stream-plot"].innerHTML;
  assert.ok((recorded.match(/L/g) || []).length >= 4);
  Chart.update(card, { input_message: "23" }, true, 2002);
  assert.equal(card.fields[".simple-stream-plot"].innerHTML, recorded);
  Chart.update(card, { input_message: "<script>" }, true, 3000);
  assert.equal(card.fields[".simple-stream-value"].textContent, "<script>");
  assert.match(card.fields[".simple-stream-error"].textContent, /숫자/);
  assert.doesNotMatch(card.fields[".simple-stream-plot"].innerHTML, /<script>/);
  Chart.update(card, { input_message: "20" }, false, 4000);
  assert.match(card.fields[".simple-stream-error"].textContent, /연결/);
});

test("stream timeline scrolls existing data left as wall time advances without inventing samples", () => {
  const settings = { ...Config.chartDefaults, window_seconds: 10, show_axes: false, show_grid: false };
  const history = [{ time: 1000, value: 1 }, { time: 2000, value: 2 }];
  const before = Chart.plot(history, settings, 2000, 300, 100);
  const after = Chart.plot(history, settings, 3000, 300, 100);
  const firstX = svg => Number(svg.match(/d="M([\d.]+) /)[1]);
  assert.ok(firstX(after) < firstX(before));
  assert.equal(history.length, 2);
});

test("stream hold extends the latest value faintly and is replaced by the true point-to-point slope", () => {
  const settings = { ...Config.chartDefaults, y_mode: "manual", y_min: 0, y_max: 100, window_seconds: 10,
    line_color: "#123456", line_width: 3, point_color: "#abcdef", point_radius: 4, point_width: 2 };
  const history = [{ time: 1000, value: 20 }];
  const before = Chart.plot(history, settings, 2000, 400, 180);
  assert.match(before, /class="simple-stream-hold" d="M[\d.]+ [\d.]+ H344"[^>]*stroke="#123456" stroke-width="3" stroke-opacity="0.3"/);
  assert.match(before, /class="simple-stream-point"[^>]*r="4" fill="#abcdef" stroke="#abcdef" stroke-width="2"/);
  const old = Chart.plot(history, settings, 20000, 400, 180);
  assert.match(old, /class="simple-stream-hold" d="M0 /);
  history.push({ time: 2000, value: 80 });
  const after = Chart.plot(history, settings, 2000, 400, 180);
  assert.doesNotMatch(after, /simple-stream-hold/);
  const coordinates = after.match(/d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)"/);
  assert.ok(coordinates);
  assert.ok(Number(coordinates[3]) > Number(coordinates[1]));
  assert.ok(Number(coordinates[4]) < Number(coordinates[2]));
  assert.equal(history.length, 2);
  history.push({ time: 2100, value: null });
  assert.doesNotMatch(Chart.plot(history, settings, 3000, 400, 180), /simple-stream-hold/);
});
