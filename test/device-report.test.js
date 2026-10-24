const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { reportTime, reportSqlTime, parseReportPeriod, buildChannelReport } = require("../device-report");

const start = reportTime("2026-10-16 09:00:00");
const end = start + 3600000;
const channel = { output_signal: "OS1", channel_name: "Channel 1", created_at: "2026-10-01 00:00:00" };
const event = (minutes, previous, state) => ({ changed_at: reportSqlTime(start + minutes * 60000), previous_output_state: previous, output_state: state });

test("report uses KST and validates period boundaries", () => {
  assert.equal(start, Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(reportSqlTime(start), "2026-10-16 09:00:00.000");
  assert.deepEqual(parseReportPeriod("2026-10-16T09:00", "2026-10-16T10:00", end), { start, end });
  assert.throws(() => parseReportPeriod("invalid", "2026-10-16T10:00", end));
  assert.throws(() => parseReportPeriod("2026-10-16T10:00", "2026-10-16T09:00", end));
  assert.throws(() => parseReportPeriod("2026-10-16T09:00", "2026-10-16T10:00", start));
  assert.throws(() => parseReportPeriod("2024-01-01T00:00", "2026-10-16T10:00", end));
  assert.throws(() => parseReportPeriod("2026-02-30T00:00", "2026-03-05T00:00", end), /유효한 날짜/);
  assert.throws(() => parseReportPeriod("2026-10-15T24:00", "2026-10-16T10:00", end), /유효한 날짜/);
});

test("report dates show Korean weekdays without changing datetime input values", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const dateStart = source.indexOf("  const dateFormat =");
  const dateEnd = source.indexOf("  function make(", dateStart);
  assert.ok(dateStart >= 0 && dateEnd > dateStart);
  const labels = { reportStartWeekday: {}, reportEndWeekday: {} };
  const context = vm.createContext({
    element: id => labels[id], startInput: { value: "2026-10-16T09:00" }, endInput: { value: "2026-10-17T10:00" }
  });
  vm.runInContext(source.slice(dateStart, dateEnd) + "globalThis.dateHelpers = { formatDate, inputDate, inputWeekday };", context);
  assert.equal(context.dateHelpers.formatDate(start), "2026-10-16 (금) 09:00:00");
  assert.equal(context.dateHelpers.inputDate(start), "2026-10-16T09:00");
  assert.equal(context.dateHelpers.formatDate(Date.parse("2026-10-16T15:00:00Z")), "2026-10-17 (토) 00:00:00");
  assert.equal(context.dateHelpers.inputWeekday(""), "");
  context.updateWeekdays();
  assert.equal(labels.reportStartWeekday.textContent, " · 금");
  assert.equal(labels.reportEndWeekday.textContent, " · 토");
  context.startInput.value = "2026-10-18T09:00";
  context.endInput.value = "";
  context.updateWeekdays();
  assert.equal(labels.reportStartWeekday.textContent, " · 일");
  assert.equal(labels.reportEndWeekday.textContent, "");
});

test("total report period displays days, hours, minutes and seconds without changing ON time units", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const durationStart = source.indexOf("  function duration(");
  const durationEnd = source.indexOf("  function message(", durationStart);
  assert.ok(durationStart >= 0 && durationEnd > durationStart);
  const context = vm.createContext({});
  vm.runInContext(source.slice(durationStart, durationEnd), context);
  assert.equal(context.periodDuration(0), "0시간 0분 0초");
  assert.equal(context.periodDuration(end - start), "1시간 0분 0초");
  assert.equal(context.periodDuration(86400000), "1일 0시간 0분 0초");
  assert.equal(context.periodDuration(2 * 86400000 + 3 * 3600000 + 10 * 60000 + 5000), "2일 3시간 10분 5초");
  assert.equal(context.duration(27 * 3600000), "27시간 0분 0초");
});

test("report clips intervals, ignores duplicate states and excludes end transitions", () => {
  const result = buildChannelReport(channel, { output_state: "ON" }, [event(10, "ON", "ON"), event(20, "ON", "OFF"), event(40, "OFF", "ON"), event(60, "ON", "OFF")], start, end);
  assert.equal(result.onMs, 40 * 60000);
  assert.equal(result.offMs, 20 * 60000);
  assert.equal(result.unknownMs, 0);
  assert.equal(result.onCount, 2);
  assert.equal(result.offCount, 1);
  assert.equal(result.transitionCount, 2);
  assert.equal(result.segments.at(-1).cumulativeOnMs, result.onMs);
});

test("report never invents OFF time when historical baseline was deleted", () => {
  const result = buildChannelReport(channel, null, [event(15, "OFF", "ON"), event(30, "ON", "OFF")], start, end);
  assert.equal(result.unknownMs, 15 * 60000);
  assert.equal(result.onMs, 15 * 60000);
  assert.equal(result.offMs, 30 * 60000);
  const empty = buildChannelReport(channel, null, [], start, end);
  assert.equal(empty.unknownMs, end - start);
  assert.equal(empty.onMs + empty.offMs, 0);
});

test("report includes a transition at start without adding pre-period duration", () => {
  const result = buildChannelReport(channel, { output_state: "OFF" }, [event(0, "OFF", "ON")], start, end);
  assert.equal(result.onCount, 1);
  assert.equal(result.onMs, end - start);
  assert.equal(result.offMs, 0);
  assert.equal(result.offCount, 0);
  assert.deepEqual(result.stateOccurrences, [{ at: start, state: "ON" }]);
});

test("report queries device-scoped history with a pre-period baseline and rejects invalid channels", async context => {
  context.mock.method(Date, "now", () => end);
  const { loadDeviceReport } = require("../device-report");
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT device_code")) return [{ device_id: "DEVICE-1", device_name: "Test" }];
    if (sql.startsWith("SELECT channel_name")) return [channel];
    if (sql.startsWith("SELECT h.output_signal")) return [{ output_signal: "OS1", output_state: "ON" }];
    return [{ ...event(30, "ON", "OFF"), output_signal: "OS1" }];
  };
  const report = await loadDeviceReport(query, { device_id: "DEVICE-1", start: "2026-10-16T09:00", end: "2026-10-16T10:00", channels: "OS1" });
  assert.equal(report.channels[0].onMs, 30 * 60000);
  assert.equal(report.channels[0].offMs, 30 * 60000);
  assert.ok(calls.every(call => call.params[0] === "DEVICE-1"));
  assert.match(calls[2].sql, /changed_at<\?/);
  assert.match(calls[3].sql, /changed_at>=\? AND changed_at<\?/);
  await assert.rejects(loadDeviceReport(query, { device_id: "DEVICE-1", start: "2026-10-16T09:00", end: "2026-10-16T10:00", channels: "OS99" }), /채널/);
});

test("Excel report round trips as real XLSX with numeric totals and Korean labels", async () => {
  const { createReportWorkbook } = require("../device-report");
  const ExcelJS = require("exceljs");
  const report = { device: { device_id: "DEVICE-1", device_name: "테스트 장치" }, start, end, generatedAt: end, channels: [buildChannelReport(channel, { output_state: "OFF" }, [event(10, "OFF", "ON")], start, end)] };
  const buffer = await createReportWorkbook(report);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 9);
  for (const label of ["분별", "시간별", "일별", "주간별", "월별", "연간별"]) assert.ok(workbook.getWorksheet(`${label} ON 전환 횟수`));
  assert.equal(workbook.getWorksheet("시간별 ON 전환 횟수").getCell("E2").value, 1);
  assert.equal(workbook.worksheets[0].getCell("B1").value, "테스트 장치");
  assert.equal(workbook.worksheets[0].getCell("F6").value, 3000);
  assert.equal(workbook.worksheets[0].getCell("F5").value, "ON 누적시간(초)");
  assert.equal(workbook.worksheets[0].getCell("G5").value, "OFF 누적 시간(초)");
  assert.equal(workbook.worksheets[0].getCell("C6").value, 1);
  assert.equal(workbook.worksheets[0].getCell("D6").value, 1);
  assert.equal(workbook.worksheets[0].getCell("E6").value, 1);
  assert.equal(workbook.worksheets[1].getCell("E2").value, "OFF");
  assert.equal(workbook.worksheets[2].getCell("E2").value, "ON");
});

test("report rejects excessive history rather than returning silently truncated totals", async context => {
  context.mock.method(Date, "now", () => end);
  const { loadDeviceReport } = require("../device-report");
  const query = async sql => {
    if (sql.startsWith("SELECT device_code")) return [{ device_id: "DEVICE-1" }];
    if (sql.startsWith("SELECT channel_name")) return [channel];
    if (sql.startsWith("SELECT h.output_signal")) return [];
    return new Array(100001);
  };
  await assert.rejects(loadDeviceReport(query, { device_id: "DEVICE-1", start: "2026-10-16T09:00", end: "2026-10-16T10:00" }), /100,000/);
});

test("report counts an initial observation as a state interval, not a transition", () => {
  const result = buildChannelReport(channel, null, [event(15, null, "OFF")], start, end);
  assert.equal(result.onCount, 0);
  assert.equal(result.offCount, 1);
  assert.equal(result.transitionCount, 0);
  assert.deepEqual(result.stateOccurrences, [{ at: start + 15 * 60000, state: "OFF" }]);
  assert.equal(result.unknownMs, 15 * 60000);
  assert.equal(result.offMs, 45 * 60000);
});

test("period ON transition counts exclude initial ON, repeated states and end-time transitions", () => {
  const result = buildChannelReport(channel, { output_state: "ON" }, [event(5, "ON", "ON"), event(10, "ON", "OFF"), event(10.25, "OFF", "ON"), event(10.5, "ON", "OFF"), event(10.75, "OFF", "ON"), event(30, "ON", "OFF"), event(40, "OFF", "ON"), event(60, "OFF", "ON")], start, end);
  assert.equal(result.onCount, 4);
  assert.equal(result.onTransitionBuckets.minutely[10].count, 2);
  assert.equal(result.onTransitionBuckets.minutely[40].count, 1);
  for (const unit of ["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]) {
    assert.equal(result.onTransitionBuckets[unit].reduce((sum, bucket) => sum + bucket.count, 0), 3);
    assert.ok(result.onTransitionBuckets[unit].every(bucket => bucket.start >= start && bucket.end <= end));
  }
  const initialOnly = buildChannelReport(channel, { output_state: "ON" }, [], start, end);
  assert.equal(initialOnly.onCount, 1);
  assert.equal(initialOnly.onTransitionBuckets.hourly[0].count, 0);
  const unknown = buildChannelReport(channel, null, [event(15, null, "ON"), event(20, "ON", "OFF"), event(25, "OFF", "ON")], start, end);
  assert.equal(unknown.onTransitionBuckets.minutely[0].count, null);
  assert.equal(unknown.onTransitionBuckets.hourly[0].count, 1);
  assert.equal(unknown.onTransitionBuckets.hourly[0].complete, false);
});

test("ON transition calendar buckets align to Monday, month, year and leap February", () => {
  const from = reportTime("2024-02-28 12:00:00");
  const until = reportTime("2024-03-02 12:00:00");
  const events = [
    ["2024-02-29 23:59:59.999", "OFF", "ON"],
    ["2024-03-01 00:00:00", "ON", "OFF"],
    ["2024-03-01 00:00:00.001", "OFF", "ON"]
  ].map(([changed_at, previous_output_state, output_state]) => ({ changed_at, previous_output_state, output_state }));
  const result = buildChannelReport(channel, { output_state: "OFF" }, events, from, until, false);
  assert.deepEqual(result.onTransitionBuckets.monthly.map(bucket => bucket.count), [1, 1]);
  assert.equal(reportSqlTime(result.onTransitionBuckets.weekly[0].at), "2024-02-26 00:00:00.000");
  assert.equal(reportSqlTime(result.onTransitionBuckets.monthly[1].at), "2024-03-01 00:00:00.000");
  assert.equal(result.onTransitionBuckets.monthly[0].start, from);
  assert.equal(result.onTransitionBuckets.monthly[1].end, until);
  const yearStart = reportTime("2024-12-31 12:00:00");
  const yearEnd = reportTime("2025-01-02 12:00:00");
  const acrossYears = buildChannelReport(channel, { output_state: "OFF" }, [{ changed_at: "2025-01-01 00:00:00", previous_output_state: "OFF", output_state: "ON" }], yearStart, yearEnd, false);
  assert.deepEqual(acrossYears.onTransitionBuckets.yearly.map(bucket => bucket.count), [0, 1]);
});

test("device minute bucket limits are enforced across selected channels without blocking other analyses", async context => {
  context.mock.method(Date, "now", () => reportTime("2026-04-01 00:00:00"));
  const { loadDeviceReport } = require("../device-report");
  const query = async sql => {
    if (sql.startsWith("SELECT device_code")) return [{ device_id: "DEVICE-1" }];
    if (sql.startsWith("SELECT channel_name")) return [channel];
    if (sql.startsWith("SELECT h.output_signal")) return [{ output_signal: "OS1", output_state: "OFF" }];
    return [];
  };
  const options = { device_id: "DEVICE-1", channels: "OS1", start: "2026-01-01T00:00", end: "2026-04-01T00:00", include_minutely: "1" };
  await assert.rejects(loadDeviceReport(query, options), /분별 구간이 100,000개/);
  const result = await loadDeviceReport(query, { ...options, include_minutely: "0" });
  assert.equal(result.channels[0].onTransitionBuckets.minutely, undefined);
  assert.ok(result.channels[0].onTransitionBuckets.hourly.length > 0);
});

test("channel analysis and PDF show ON percentage and the same nine graphs in order", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const sectionStart = source.indexOf("  function channelSection(");
  const sectionEnd = source.indexOf("  async function downloadPdf(", sectionStart);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const pdfModes = [];
  const titles = ["ON · OFF 상태", "ON 누적 횟수", "ON 누적 시간", "분별 ON 전환 횟수", "시간별 ON 전환 횟수", "일별 ON 전환 횟수", "주간별 ON 전환 횟수", "월별 ON 전환 횟수", "연간별 ON 전환 횟수"];
  const context = vm.createContext({
    report: { start, end, generatedAt: end, device: { device_name: "Test", device_id: "DEVICE-1" } },
    pdfBusy: false,
    duration: value => String(value), periodDuration: value => String(value), formatDate: String,
    createChart: (_canvas, _channel, mode, printing) => { assert.equal(printing, true); pdfModes.push(mode); return { destroy() {} }; },
    make: (tag, text) => ({ tag, text, children: [], attributes: {}, append(...children) { this.children.push(...children); }, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; }, addEventListener() {}, toDataURL: () => "data:image/png;base64,test" })
  });
  vm.runInContext(source.slice(sectionStart, sectionEnd), context);
  for (const [onMs, expected] of [[0, "0.0%"], [15 * 60000, "25.0%"], [40 * 60000, "66.7%"], [60 * 60000, "100.0%"]]) {
    const section = context.channelSection({ channelName: "Channel 1", outputSignal: "OS1", onCount: 1, offCount: 1, transitionCount: 2, onMs, offMs: 0, unknownMs: end - start - onMs });
    const statistics = section.children.find(node => node.tag === "dl");
    const percentage = statistics.children.at(-1);
    assert.equal(percentage.children[0].text, "ON 시간 비율");
    assert.equal(percentage.children[1].text, expected);
    assert.ok(statistics.children.every(stat => stat.children[0].text !== "확인 불가"));
    assert.equal(statistics.children[0].children[0].text, "ON 횟수");
    assert.equal(statistics.children[1].children[0].text, "OFF 횟수");
    assert.equal(statistics.children[3].children[0].text, "ON 누적시간");
    assert.equal(statistics.children[4].children[0].text, "OFF 누적 시간");
    assert.deepEqual(Array.from(section.children.filter(node => node.tag === "h4"), node => node.text), titles);
  }
  const pdfSection = context.channelSection({ channelName: "Channel 1", outputSignal: "OS1", onCount: 1, offCount: 1, transitionCount: 2, onMs: 15 * 60000, offMs: 45 * 60000, unknownMs: 0 }, true);
  assert.deepEqual(pdfModes, ["state", "onCount", "onTime", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"]);
  assert.equal(pdfSection.children.filter(node => node.tag === "img").length, 9);
  const footer = pdfSection.children.find(node => node.tag === "p" && node.text.startsWith("생성:"));
  assert.equal(footer.text, `생성: ${end} KST · 저장된 출력 상태 기준`);
  assert.ok(pdfSection.children.some(node => node.tag === "p" && node.text.includes(`총 기간: ${end - start}`)));
  assert.deepEqual(Array.from(pdfSection.children.filter(node => node.tag === "h4"), node => node.text), titles);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.html"), "utf8");
  for (const [key, label] of [["stateGraph", "ON · OFF 상태 그래프"], ["onCountGraph", "ON 누적 횟수 그래프"], ["onTimeGraph", "ON 누적 시간 그래프"]]) {
    assert.ok(html.includes(`value="${key}" checked> ${label}</label>`));
  }
  context.report.analysisItems = ["offCount", "onPercentage", "onCountGraph"];
  pdfModes.length = 0;
  const selectedChannel = { channelName: "Channel 1", outputSignal: "OS1", onCount: 1, offCount: 1, transitionCount: 2, onMs: 15 * 60000, offMs: 45 * 60000, unknownMs: 0 };
  for (const printing of [false, true]) {
    const selectedSection = context.channelSection(selectedChannel, printing);
    const statistics = selectedSection.children.find(node => node.tag === "dl");
    assert.deepEqual(Array.from(statistics.children, stat => stat.children[0].text), ["OFF 횟수", "ON 시간 비율"]);
    assert.deepEqual(Array.from(selectedSection.children.filter(node => node.tag === "h4"), node => node.text), ["ON 누적 횟수"]);
  }
  assert.deepEqual(pdfModes, ["onCount"]);
  context.report.analysisItems = ["stateGraph"];
  const graphOnly = context.channelSection(selectedChannel);
  assert.equal(graphOnly.children.some(node => node.tag === "dl"), false);
  context.report.analysisItems = ["onCount"];
  const statisticsOnly = context.channelSection(selectedChannel);
  assert.equal(statisticsOnly.children.some(node => node.tag === "h4"), false);
  context.report.analysisItems = ["minutelyGraph", "yearlyGraph"];
  pdfModes.length = 0;
  for (const printing of [false, true]) {
    const selected = context.channelSection(selectedChannel, printing);
    assert.deepEqual(Array.from(selected.children.filter(node => node.tag === "h4"), node => node.text), ["분별 ON 전환 횟수", "연간별 ON 전환 횟수"]);
    assert.equal(selected.children.some(node => node.tag === "dl"), false);
  }
  assert.deepEqual(pdfModes, ["minutely", "yearly"]);
  for (const [index, unit] of ["minutely", "hourly", "daily", "weekly", "monthly"].entries()) assert.ok(html.includes(`value="${unit}Graph" checked> ${titles[index + 3]} 그래프</label>`));
  assert.doesNotMatch(html, /value="yearlyGraph"/);
});

test("period ON transition charts use bucket counts, integer axes and KST period labels", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const graphStart = source.indexOf("  function chartPoints(");
  const graphEnd = source.indexOf("  function channelSection(", graphStart);
  const context = vm.createContext({
    report: { start, end }, formatDate: String, duration: String,
    Chart: class { constructor(canvas, config) { this.config = config; } }
  });
  vm.runInContext(source.slice(graphStart, graphEnd), context);
  const result = buildChannelReport(channel, { output_state: "OFF" }, [event(10, "OFF", "ON")], start, end);
  const expectedIntervals = { minutely: "10분", hourly: "1시간", daily: "1일", weekly: "1주 (월요일 시작)", monthly: "1개월", yearly: "1년" };
  for (const printing of [false, true]) for (const unit of ["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]) {
    const config = context.createChart({ width: 1000 }, result, unit, printing).config;
    assert.equal(config.type, "bar");
    assert.deepEqual(Array.from(config.data.datasets[0].data, point => point.y), result.onTransitionBuckets[unit].map(bucket => bucket.count));
    assert.ok(config.data.datasets[0].data.every((point, index) => point.x === (result.onTransitionBuckets[unit][index].start + result.onTransitionBuckets[unit][index].end) / 2));
    assert.equal(config.options.scales.y.ticks.precision, 0);
    const index = result.onTransitionBuckets[unit].findIndex(bucket => bucket.count > 0);
    assert.equal(config.options.plugins.tooltip.callbacks.label({ dataIndex: index }), "ON 전환 횟수: 1회");
    const axis = config.options.scales.x;
    const scale = { width: 1000, options: axis, chart: { width: 1000 } };
    axis.afterBuildTicks(scale);
    assert.equal(axis.title.text, `시간 (KST · ${expectedIntervals[unit]} 간격)`);
    if (unit === "weekly") assert.match(axis.ticks.callback(scale.ticks[0].value), /월/);
    if (unit === "monthly") assert.equal(axis.ticks.callback(start), "2026년 10월");
    if (unit === "yearly") assert.equal(axis.ticks.callback(start), "2026년");
  }
});

test("cumulative ON count includes the initial ON interval and ends at the summary count", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const graphStart = source.indexOf("  function chartPoints(");
  const graphEnd = source.indexOf("  function channelSection(", graphStart);
  assert.ok(graphStart >= 0 && graphEnd > graphStart);
  const context = vm.createContext({
    report: { start, end }, formatDate: String, duration: String, timeFormat: { format: String },
    Chart: class { constructor(canvas, config) { this.config = config; } }
  });
  vm.runInContext(source.slice(graphStart, graphEnd), context);
  const result = buildChannelReport(channel, { output_state: "ON" }, [event(5, "ON", "ON"), event(10, "ON", "OFF"), event(20, "OFF", "ON"), event(25, "ON", "ON"), event(40, "ON", "OFF"), event(50, "OFF", "ON"), event(60, "ON", "OFF")], start, end);
  const graph = context.createChart({}, result, "onCount").config;
  const points = Array.from(graph.data.datasets[0].data, point => ({ x: point.x, y: point.y }));
  assert.deepEqual(points, [
    { x: start, y: 0 },
    { x: start, y: 0 }, { x: start, y: 1 },
    { x: start + 20 * 60000, y: 1 }, { x: start + 20 * 60000, y: 2 },
    { x: start + 50 * 60000, y: 2 }, { x: start + 50 * 60000, y: 3 },
    { x: end, y: result.onCount }
  ]);
  assert.equal(graph.options.scales.y.ticks.precision, 0);
  assert.equal(graph.data.datasets[0].label, "ON 누적 횟수");
  assert.equal(graph.options.plugins.tooltip.callbacks.label({ parsed: { y: 3 } }), "ON 누적 횟수: 3회");
  const noChanges = buildChannelReport(channel, { output_state: "ON" }, [], start, end);
  assert.equal(noChanges.onCount, 1);
  assert.deepEqual(Array.from(context.chartPoints(noChanges, "onCount"), point => point.y), [0, 0, 1, 1]);
  const unknown = buildChannelReport(channel, null, [], start, end);
  assert.equal(unknown.onCount, 0);
  assert.deepEqual(Array.from(context.chartPoints(unknown, "onCount"), point => point.y), [0, 0]);
  const atStart = buildChannelReport(channel, { output_state: "OFF" }, [event(0, "OFF", "ON"), event(60, "OFF", "ON")], start, end);
  assert.deepEqual(Array.from(context.chartPoints(atStart, "onCount"), point => point.y), [0, 0, 1, 1]);
});

test("ON accumulated time tooltip shows identical boundary data only once", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const graphStart = source.indexOf("  function chartPoints(");
  const graphEnd = source.indexOf("  function channelSection(", graphStart);
  assert.ok(graphStart >= 0 && graphEnd > graphStart);
  const context = vm.createContext({
    report: { start, end }, formatDate: String, duration: String, timeFormat: { format: String },
    Chart: class { constructor(canvas, config) { this.config = config; } }
  });
  vm.runInContext(source.slice(graphStart, graphEnd), context);
  const result = buildChannelReport(channel, { output_state: "ON" }, [event(20, "ON", "OFF"), event(40, "OFF", "ON")], start, end);
  const config = context.createChart({}, result, "onTime").config;
  const boundary = start + 20 * 60000;
  const items = Array.from(config.data.datasets[0].data).filter(point => point.x === boundary).map(parsed => ({ datasetIndex: 0, parsed }));
  assert.equal(items.length, 2);
  const tooltip = config.options.plugins.tooltip;
  assert.equal(items.filter(tooltip.filter).length, 1);
  assert.equal(tooltip.callbacks.label(items[0]), "ON 누적 시간: 1200000");
  const distinct = [...items, { datasetIndex: 0, parsed: { x: boundary, y: 1 } }];
  assert.equal(distinct.filter(tooltip.filter).length, 2);
  const stateTooltip = context.createChart({}, result, "state").config.options.plugins.tooltip;
  assert.equal(items.filter(stateTooltip.filter).length, 2);
});

test("time axis uses readable KST-aligned minute, hour and day intervals", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const axisStart = source.indexOf("  function timeAxisSettings(");
  const axisEnd = source.indexOf("  function createChart(", axisStart);
  assert.ok(axisStart >= 0 && axisEnd > axisStart);
  const context = vm.createContext({});
  vm.runInContext(source.slice(axisStart, axisEnd), context);
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  for (const [span, interval] of [[10 * minute, minute], [hour, 10 * minute], [3 * hour, 30 * minute], [8 * hour, hour], [7 * day, day], [30 * day, 3 * day]]) {
    const axis = context.timeAxisSettings(start, start + span, 1000);
    assert.equal(axis.interval, interval);
    assert.ok(axis.ticks.length <= 12);
    assert.ok(axis.ticks.every(tick => tick.value >= start && tick.value <= start + span));
    assert.ok(axis.ticks.every(tick => (tick.value + 9 * hour) % interval === 0));
    assert.ok(axis.ticks.every((tick, index) => index === 0 || tick.value - axis.ticks[index - 1].value === interval));
  }
  const desktop = context.timeAxisSettings(start, end, 1000);
  const mobile = context.timeAxisSettings(start, end, 320);
  assert.ok(mobile.interval > desktop.interval);
  assert.equal(desktop.formatLabel(start), "09:00");
  const midnight = reportTime("2026-10-17 00:00:00");
  const overnight = context.timeAxisSettings(midnight - hour, midnight + hour, 1000);
  const label = Array.from(overnight.formatLabel(midnight));
  assert.equal(label.length, 2);
  assert.match(label[0], /10.*17/);
  assert.equal(label[1], "00:00");
  const longPeriod = context.timeAxisSettings(start, start + 366 * day, 1000);
  assert.match(longPeriod.formatLabel(longPeriod.ticks[0].value), /202[67]/);
  const hourly = context.timeAxisSettings(start, start + 8 * hour, 1000, "hourly");
  assert.equal(hourly.interval, hour);
  const daily = context.timeAxisSettings(start, start + 30 * day, 1000, "daily");
  assert.ok(daily.interval >= day);
  assert.ok(daily.ticks.every(tick => (tick.value + 9 * hour) % day === 0));
  const weekly = context.timeAxisSettings(start, start + 90 * day, 1000, "weekly");
  assert.equal(weekly.interval, 7 * day);
  assert.ok(weekly.ticks.every(tick => new Date(tick.value + 9 * hour).getUTCDay() === 1));
  assert.ok(weekly.ticks.every(tick => /월/.test(weekly.formatLabel(tick.value))));
  const monthly = context.timeAxisSettings(start, start + 366 * day, 1000, "monthly");
  assert.equal(monthly.interval, 30.436875 * day);
  assert.equal(monthly.ticks.length, 13);
  assert.equal(monthly.formatLabel(monthly.ticks[0].value), "2026년 10월");
  const yearly = context.timeAxisSettings(start, start + 366 * day, 1000, "yearly");
  assert.equal(yearly.interval, 365.2425 * day);
  assert.equal(yearly.ticks.length, 2);
  assert.equal(yearly.formatLabel(yearly.ticks[0].value), "2026년");
});

test("all report graphs use matching time ticks, labels and vertical grid lines", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const graphStart = source.indexOf("  function chartPoints(");
  const graphEnd = source.indexOf("  function channelSection(", graphStart);
  const context = vm.createContext({
    report: { start, end }, formatDate: String, duration: String,
    Chart: class { constructor(canvas, config) { this.config = config; } }
  });
  vm.runInContext(source.slice(graphStart, graphEnd), context);
  const result = buildChannelReport(channel, { output_state: "ON" }, [], start, end);
  for (const printing of [false, true]) {
    for (const mode of ["state", "onCount", "onTime", "minutely", "hourly", "daily", "weekly", "monthly", "yearly"]) {
      const config = context.createChart({}, result, mode, printing).config;
      const axis = config.options.scales.x;
      const scale = { width: 1000, options: axis };
      axis.afterBuildTicks(scale);
      assert.equal(axis.ticks.autoSkip, false);
      assert.equal(axis.grid.drawOnChartArea, true);
      const interval = { state: "10분", onCount: "10분", onTime: "10분", minutely: "10분", hourly: "1시간", daily: "1일", weekly: "1주 (월요일 시작)", monthly: "1개월", yearly: "1년" }[mode];
      assert.equal(axis.title.text, `시간 (KST · ${interval} 간격)`);
      assert.ok(scale.ticks.length > 0);
      if (["minutely", "hourly"].includes(mode)) {
        const label = axis.ticks.callback(start);
        assert.match(label[0], /10.*16/);
        assert.equal(label[1], "09:00");
      }
    }
  }
  for (const mode of ["minutely", "hourly"]) {
    const axis = context.timeAxisSettings(start, start + 30 * 86400000, 1000, mode);
    const label = axis.formatLabel(axis.ticks[0].value);
    assert.match(label[0], /10\.\s*\d{1,2}/);
    assert.ok(label[1]);
  }
});

test("channel selection starts empty and resets when switching devices", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const selectionStart = source.indexOf("  function checkboxes(");
  const selectionEnd = source.indexOf("  function chartPoints(", selectionStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  const options = {
    children: [], replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); },
    querySelectorAll() { return this.children.map(label => label.children[0]); }
  };
  const context = vm.createContext({
    devices: [
      { device_id: "DEVICE-1", sets: [{ output_signal: "OS1", channel_name: "First" }, { output_signal: "OS2", channel_name: "Second" }] },
      { device_id: "DEVICE-2", sets: [{ output_signal: "OS3", channel_name: "Third" }] }
    ],
    deviceSelect: { value: "DEVICE-1" }, selectAll: { checked: true, indeterminate: true },
    element: () => options,
    make: () => ({ children: [], append(...children) { this.children.push(...children); } })
  });
  vm.runInContext(source.slice(selectionStart, selectionEnd), context);
  context.renderChannelOptions();
  assert.equal(context.checkboxes().length, 2);
  assert.ok(context.checkboxes().every(checkbox => checkbox.checked === false));
  assert.equal(context.selectAll.checked, false);
  assert.equal(context.selectAll.indeterminate, false);
  assert.equal(context.selectAll.disabled, false);
  context.checkboxes().forEach(checkbox => { checkbox.checked = true; });
  context.syncAll();
  assert.equal(context.selectAll.checked, true);
  context.deviceSelect.value = "DEVICE-2";
  context.renderChannelOptions();
  assert.equal(context.checkboxes().length, 1);
  assert.equal(context.checkboxes()[0].checked, false);
  assert.equal(context.selectAll.checked, false);
  assert.equal(context.selectAll.indeterminate, false);
});

test("report query and export snapshot contain only the selected channels", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const handlerStart = source.indexOf('  form.addEventListener("submit",');
  const handlerEnd = source.indexOf('  printAll.addEventListener(', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  let submit;
  const requests = [];
  const rendered = [];
  const notices = [];
  const elements = { reportSubmit: {}, reportPeriod: {} };
  const context = vm.createContext({
    URLSearchParams, AbortController,
    form: { addEventListener: (_event, handler) => { submit = handler; } },
    checkboxes: () => [{ value: "OS1", checked: true }, { value: "OS2", checked: false }, { value: "OS3", checked: true }],
    analysisCheckboxes: () => [{ value: "offCount", checked: true }, { value: "stateGraph", checked: false }, { value: "onCountGraph", checked: true }, { value: "minutelyGraph", checked: true }],
    invalidate() {}, message: (text, error) => notices.push({ text, error }), clearResults() {},
    deviceSelect: { value: "DEVICE-1" }, startInput: { value: "2026-10-16T09:00" }, endInput: { value: "2026-10-16T10:00" },
    element: id => elements[id], document: { querySelector: () => ({ setAttribute() {} }) },
    fetch: async url => {
      requests.push(new URL(url, "http://localhost").searchParams);
      return { ok: true, json: async () => ({ device: { device_name: "Test" }, start, end, channels: ["OS1", "OS2", "OS3"].map(outputSignal => ({ outputSignal })) }) };
    },
    channelSection: channel => { rendered.push(channel.outputSignal); return { querySelectorAll: () => [] }; },
    results: { append() {} }, formatDate: String, periodDuration: String, charts: [], printAll: {}, excelButton: {}, request: null, report: null, snapshotParams: null, pdfBusy: false
  });
  vm.runInContext(source.slice(handlerStart, handlerEnd), context);
  await submit({ preventDefault() {} });
  assert.equal(requests[0].get("channels"), "OS1,OS3");
  assert.equal(context.snapshotParams.get("channels"), "OS1,OS3");
  assert.ok(elements.reportPeriod.textContent.includes(`총 기간: ${end - start}`));
  assert.equal(context.snapshotParams.get("include_minutely"), "1");
  assert.deepEqual(Array.from(context.report.analysisItems), ["offCount", "onCountGraph", "minutelyGraph"]);
  assert.deepEqual(Array.from(context.report.channels, item => item.outputSignal), ["OS1", "OS3"]);
  assert.deepEqual(rendered, ["OS1", "OS3"]);
  assert.equal(context.printAll.disabled, false);
  assert.equal(context.excelButton.disabled, false);
  context.analysisCheckboxes = () => [];
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.deepEqual(notices.at(-1), { text: "분석 항목을 하나 이상 선택하세요.", error: true });
});

test("analysis selection supports all, partial and empty selection without changing channels", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const selectionStart = source.indexOf("  function analysisCheckboxes(");
  const selectionEnd = source.indexOf("  function syncAll(", selectionStart);
  const listenerStart = source.indexOf('  form.addEventListener("change",');
  const listenerEnd = source.indexOf('  form.addEventListener("submit",', listenerStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart && listenerStart >= 0 && listenerEnd > listenerStart);
  const boxes = [{ value: "onCount", checked: true }, { value: "onCountGraph", checked: true }];
  const all = { checked: true, indeterminate: false };
  const channelBoxes = [{ checked: false }];
  let change;
  const context = vm.createContext({
    element: id => id === "reportAnalysisAll" ? all : { querySelectorAll: () => boxes },
    form: { addEventListener: (_event, listener) => { change = listener; } },
    invalidate() {}, deviceSelect: {}, selectAll: {}, syncAll() {}, renderChannelOptions() {}, checkboxes: () => channelBoxes
  });
  vm.runInContext(source.slice(selectionStart, selectionEnd) + source.slice(listenerStart, listenerEnd), context);
  context.syncAnalysis();
  assert.equal(all.checked, true);
  boxes[0].checked = false;
  change({ target: boxes[0] });
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  all.checked = true;
  change({ target: all });
  assert.ok(boxes.every(box => box.checked));
  assert.equal(all.indeterminate, false);
  all.checked = false;
  change({ target: all });
  assert.ok(boxes.every(box => !box.checked));
  assert.equal(all.indeterminate, false);
  assert.equal(channelBoxes[0].checked, false);
});

test("short PDF download saves one page per requested channel without opening print", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const handlerStart = source.indexOf("  async function downloadPdf(");
  const handlerEnd = source.indexOf('  form.addEventListener("change",', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const captures = [];
  const saved = [];
  const pageImages = [];
  let pages = 1;
  let removed = false;
  const target = {
    children: [], setAttribute() {},
    replaceChildren(...children) { this.children = children; },
    querySelectorAll: () => [], remove() { removed = true; }
  };
  const context = vm.createContext({
    report: { device: { device_id: "DEVICE-1" }, channels: [{ outputSignal: "OS1" }, { outputSignal: "OS3" }] },
    pdfBusy: false, printAll: { disabled: false }, results: { querySelectorAll: () => [] }, message() {},
    make: () => target, channelSection: channel => ({ pin: channel.outputSignal }),
    document: { body: { append() {} }, fonts: { ready: Promise.resolve() } },
    window: {
      print() { assert.fail("PDF download must not open print"); },
      html2canvas: async section => { captures.push(section.pin); return { width: 2000, height: 2500, toDataURL: () => "data:image/png;base64,test" }; },
      jspdf: { jsPDF: class {
        constructor() { this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } }; }
        addPage() { pages += 1; }
        setFontSize() {}
        text() {}
        addImage(...args) { pageImages.push(args); }
        async save(filename) { saved.push(filename); }
      } }
    }
  });
  vm.runInContext(source.slice(handlerStart, handlerEnd), context);
  await context.downloadPdf(context.report.channels);
  assert.deepEqual(captures, ["OS1", "OS3"]);
  assert.equal(pages, 2);
  assert.equal(pageImages.length, 2);
  assert.deepEqual(saved, ["DEVICE-1-report.pdf"]);
  assert.equal(removed, true);
  assert.equal(context.pdfBusy, false);
  assert.equal(context.printAll.disabled, false);
  captures.length = 0;
  await context.downloadPdf([context.report.channels[1]]);
  assert.deepEqual(captures, ["OS3"]);
  assert.equal(saved.at(-1), "DEVICE-1-OS3-report.pdf");
});

test("tall channel PDFs paginate at graph headings rather than shrinking every graph onto one page", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const downloadStart = source.indexOf("  async function downloadPdf(");
  const downloadEnd = source.indexOf('  form.addEventListener("change",', downloadStart);
  const crops = [];
  const images = [];
  let pages = 1;
  let saved;
  const section = {
    getBoundingClientRect: () => ({ top: 0, height: 4000 }),
    querySelectorAll: () => [300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500].map(top => ({ getBoundingClientRect: () => ({ top }) }))
  };
  const target = { children: [], setAttribute() {}, replaceChildren(...children) { this.children = children; }, querySelectorAll: () => [], remove() {} };
  const context = vm.createContext({
    report: { device: { device_id: "DEVICE-1" }, channels: [{ outputSignal: "OS1" }] }, pdfBusy: false, printAll: {}, results: { querySelectorAll: () => [] }, message() {},
    channelSection: () => section,
    make: tag => tag === "div" ? target : { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => crops.push({ start: args[2], height: args[4] }) }), toDataURL: () => "data:image/png;base64,test" },
    document: { body: { append() {} }, fonts: { ready: Promise.resolve() } },
    window: {
      html2canvas: async () => ({ width: 1000, height: 4000, toDataURL: () => "data:image/png;base64,test" }),
      jspdf: { jsPDF: class {
        constructor() { this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } }; }
        addPage() { pages += 1; }
        setFontSize() {}
        text() {}
        addImage(...args) { images.push(args); }
        async save(filename) { saved = filename; }
      } }
    }
  });
  vm.runInContext(source.slice(downloadStart, downloadEnd), context);
  await context.downloadPdf(context.report.channels);
  assert.equal(pages, 4);
  assert.deepEqual(crops, [{ start: 0, height: 1100 }, { start: 1100, height: 1200 }, { start: 2300, height: 1200 }, { start: 3500, height: 500 }]);
  assert.ok(images.every(args => args[4] === 186 && args[5] <= 273));
  assert.equal(saved, "DEVICE-1-OS1-report.pdf");
});

test("Excel download preserves selected channels in its XLSX request", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "device-report.js"), "utf8");
  const handlerStart = source.indexOf('  excelButton.addEventListener("click",');
  const handlerEnd = source.indexOf("  async function initialize(", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  let download;
  let requestParams;
  let savedFilename;
  const snapshotParams = new URLSearchParams({ device_id: "DEVICE-1", start: "2026-10-16T09:00", end: "2026-10-16T10:00", channels: "OS1,OS3", include_minutely: "1" });
  const context = vm.createContext({
    URLSearchParams, URL, snapshotParams, report: {}, message() {},
    excelButton: { addEventListener: (_event, handler) => { download = handler; } },
    fetch: async url => {
      requestParams = new URL(url, "http://localhost").searchParams;
      return { ok: true, blob: async () => new Blob(["xlsx"]) };
    },
    make: () => ({ click() { savedFilename = this.download; }, remove() {} }),
    document: { body: { append() {} } }, setTimeout: callback => callback()
  });
  vm.runInContext(source.slice(handlerStart, handlerEnd), context);
  await download();
  assert.equal(requestParams.get("format"), "xlsx");
  assert.equal(requestParams.get("channels"), "OS1,OS3");
  assert.equal(requestParams.get("include_minutely"), "1");
  assert.equal(snapshotParams.has("format"), false);
  assert.equal(savedFilename, "DEVICE-1-report.xlsx");
  assert.equal(context.excelButton.disabled, false);
});