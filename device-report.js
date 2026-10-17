const { bucketStart, nextBucketStart } = require("./report-buckets");

const KOREA_OFFSET = 9 * 60 * 60 * 1000;

function reportTime(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || "").replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}+09:00`);
}

function reportSqlTime(value) {
  return new Date(value + KOREA_OFFSET).toISOString().slice(0, 23).replace("T", " ");
}

function parseReportPeriod(startValue, endValue, now = Date.now()) {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
  if (!pattern.test(String(startValue)) || !pattern.test(String(endValue))) throw new Error("시작과 종료 일시를 입력하세요. (한국 시간)");
  const start = reportTime(startValue);
  const end = reportTime(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("종료 일시는 시작 일시보다 늦어야 합니다.");
  for (const [input, timestamp] of [[startValue, start], [endValue, end]]) {
    const withSeconds = input.length === 16 ? `${input}:00` : input;
    const normalized = withSeconds.includes(".") ? withSeconds.padEnd(23, "0") : `${withSeconds}.000`;
    if (reportSqlTime(timestamp).replace(" ", "T") !== normalized) throw new Error("유효한 날짜와 시간을 입력하세요.");
  }
  if (end > now) throw new Error("미래 기간은 조회할 수 없습니다.");
  if (end - start > 366 * 86400000) throw new Error("한 번에 최대 366일까지 조회할 수 있습니다.");
  return { start, end };
}

function buildOnTransitionBuckets(transitions, knownFrom, start, end, includeMinutely) {
  const counts = { ...(includeMinutely ? { minutely: new Map() } : {}), hourly: new Map(), daily: new Map(), weekly: new Map(), monthly: new Map(), yearly: new Map() };
  for (const transition of transitions) {
    if (transition.previous !== "OFF" || transition.state !== "ON") continue;
    for (const [unit, values] of Object.entries(counts)) {
      const key = bucketStart(transition.at, unit);
      values.set(key, (values.get(key) || 0) + 1);
    }
  }
  const buckets = {};
  for (const [unit, values] of Object.entries(counts)) {
    buckets[unit] = [];
    for (let at = bucketStart(start, unit); at < end;) {
      const next = nextBucketStart(at, unit);
      const from = Math.max(at, start);
      const until = Math.min(next, end);
      buckets[unit].push({ at, start: from, end: until, count: knownFrom !== null && knownFrom < until ? values.get(at) || 0 : null, complete: knownFrom !== null && knownFrom <= from });
      at = next;
    }
  }
  return buckets;
}

function buildChannelReport(channel, baseline, events, start, end, includeMinutely = true) {
  const created = reportTime(channel.created_at);
  let state = baseline?.output_state || null;
  let cursor = start;
  let onMs = 0;
  let offMs = 0;
  let unknownMs = 0;
  let onCount = 0;
  let offCount = 0;
  const segments = [];
  const transitions = [];
  const stateOccurrences = [];
  function append(until) {
    if (until <= cursor) return;
    if ((state === "ON" || state === "OFF") && stateOccurrences.at(-1)?.state !== state) {
      stateOccurrences.push({ at: cursor, state });
      if (state === "ON") onCount += 1;
      else offCount += 1;
    }
    const duration = until - cursor;
    if (state === "ON") onMs += duration;
    else if (state === "OFF") offMs += duration;
    else unknownMs += duration;
    segments.push({ start: cursor, end: until, state, cumulativeOnMs: onMs });
    cursor = until;
  }
  for (const event of events) {
    const at = reportTime(event.changed_at);
    if (at < start || at >= end) continue;
    append(at);
    const previous = event.previous_output_state;
    if (previous && previous !== event.output_state) {
      transitions.push({ at, previous, state: event.output_state, source: event.change_source || "" });
    }
    state = event.output_state;
  }
  append(end);
  const knownFrom = segments.find(segment => segment.state !== null)?.start ?? null;
  return {
    outputSignal: channel.output_signal, channelName: channel.channel_name,
    onCount, offCount, transitionCount: transitions.length,
    onMs, offMs, unknownMs, segments, transitions, stateOccurrences,
    onTransitionBuckets: buildOnTransitionBuckets(transitions, knownFrom, start, end, includeMinutely),
    createdAt: Number.isFinite(created) ? created : null
  };
}

async function loadDeviceReport(query, options) {
  const { start, end } = parseReportPeriod(options.start, options.end);
  const deviceId = String(options.device_id || "");
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(deviceId)) throw new Error("디바이스를 선택하세요.");
  const devices = await query("SELECT device_code AS device_id,device_name FROM device WHERE device_code=?", [deviceId]);
  if (!devices.length) throw new Error("디바이스를 찾을 수 없습니다.");
  const channels = await query(
    `SELECT channel_name,output_signal,created_at FROM device_channel WHERE device_id=? ORDER BY sort_order,channel_id`, [deviceId]);
  const selected = options.channels === undefined ? channels.map(channel => channel.output_signal) : String(options.channels).split(",");
  if (!selected.length || selected.some(pin => !channels.some(channel => channel.output_signal === pin))) throw new Error("유효한 채널을 하나 이상 선택하세요.");
  const pins = [...new Set(selected)];
  const includeMinutely = options.include_minutely === "1";
  if (includeMinutely && (Math.floor((end - 1) / 60000) - Math.floor(start / 60000) + 1) * pins.length > 100000) throw new Error("분별 구간이 100,000개를 초과합니다. 기간·채널 수를 줄이거나 분별 ON 전환 횟수를 해제하세요.");
  const placeholders = pins.map(() => "?").join(",");
  const baselines = await query(
    `SELECT h.output_signal,h.output_state FROM device_state_history h
     WHERE h.device_id=? AND h.output_signal IN (${placeholders}) AND h.history_id=(
       SELECT b.history_id FROM device_state_history b WHERE b.device_id=h.device_id
       AND b.output_signal=h.output_signal AND b.changed_at<? ORDER BY b.changed_at DESC,b.history_id DESC LIMIT 1)`,
    [deviceId, ...pins, reportSqlTime(start)]);
  const events = await query(
    `SELECT history_id,output_signal,previous_output_state,output_state,change_source,changed_at
     FROM device_state_history WHERE device_id=? AND output_signal IN (${placeholders}) AND changed_at>=? AND changed_at<?
     ORDER BY changed_at,history_id LIMIT 100001`, [deviceId, ...pins, reportSqlTime(start), reportSqlTime(end)]);
  if (events.length > 100000) throw new Error("변경 이력이 100,000건을 초과합니다. 조회 기간을 줄여주세요.");
  return {
    device: devices[0], start, end, timezone: "Asia/Seoul", generatedAt: Date.now(),
    channels: channels.filter(channel => pins.includes(channel.output_signal)).map(channel => buildChannelReport(
      channel, baselines.find(row => row.output_signal === channel.output_signal),
      events.filter(row => row.output_signal === channel.output_signal), start, end, includeMinutely))
  };
}

async function createReportWorkbook(report) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KIMS SMART FACTORY";
  const summary = workbook.addWorksheet("채널 요약");
  summary.addRow(["디바이스", report.device.device_name, report.device.device_id]);
  summary.addRow(["시작 (KST, 포함)", reportSqlTime(report.start)]);
  summary.addRow(["종료 (KST, 미포함)", reportSqlTime(report.end)]);
  summary.addRow(["생성 (KST)", reportSqlTime(report.generatedAt)]);
  summary.addRow(["채널", "이름", "ON 횟수", "OFF 횟수", "총 전환 횟수", "ON 누적시간(초)", "OFF 누적 시간(초)", "확인 불가(초)"]);
  const intervals = workbook.addWorksheet("상태 구간");
  intervals.addRow(["채널", "이름", "시작 (KST)", "종료 (KST)", "상태", "시간(초)", "누적 ON(초)"]);
  const transitions = workbook.addWorksheet("상태 변경 이력");
  transitions.addRow(["채널", "이름", "변경 일시 (KST)", "이전 상태", "변경 상태", "변경자"]);
  for (const channel of report.channels) {
    summary.addRow([channel.outputSignal, channel.channelName, channel.onCount, channel.offCount, channel.transitionCount, channel.onMs / 1000, channel.offMs / 1000, channel.unknownMs / 1000]);
    for (const segment of channel.segments) intervals.addRow([channel.outputSignal, channel.channelName, reportSqlTime(segment.start), reportSqlTime(segment.end), segment.state || "확인 불가", (segment.end - segment.start) / 1000, segment.cumulativeOnMs / 1000]);
    for (const transition of channel.transitions) transitions.addRow([channel.outputSignal, channel.channelName, reportSqlTime(transition.at), transition.previous, transition.state, transition.source]);
  }
  for (const [unit, label] of [["minutely", "분별"], ["hourly", "시간별"], ["daily", "일별"], ["weekly", "주간별"], ["monthly", "월별"], ["yearly", "연간별"]]) {
    if (!report.channels.some(channel => channel.onTransitionBuckets?.[unit])) continue;
    const sheet = workbook.addWorksheet(`${label} ON 전환 횟수`);
    sheet.addRow(["채널", "이름", "구간 시작 (KST)", "구간 종료 (KST)", "ON 전환 횟수", "구간 이력 확인"]);
    for (const channel of report.channels) for (const bucket of channel.onTransitionBuckets?.[unit] || []) {
      sheet.addRow([channel.outputSignal, channel.channelName, reportSqlTime(bucket.start), reportSqlTime(bucket.end), bucket.count, bucket.complete ? "완료" : bucket.count === null ? "확인 불가" : "확인된 기록 합계"]);
    }
  }
  for (const sheet of workbook.worksheets) {
    sheet.columns.forEach((column, index) => { column.width = index < 2 ? 24 : 28; });
    const headerRow = sheet === summary ? 5 : 1;
    sheet.getRow(headerRow).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF087A67" } };
    sheet.views = [{ state: "frozen", ySplit: headerRow }];
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: sheet.columnCount } };
  }
  return workbook.xlsx.writeBuffer();
}

module.exports = { reportTime, reportSqlTime, parseReportPeriod, buildChannelReport, loadDeviceReport, createReportWorkbook };