(() => {
  const element = id => document.getElementById(id);
  const form = element("reportForm");
  const deviceSelect = element("reportDevice");
  const startInput = element("reportStart");
  const endInput = element("reportEnd");
  const selectAll = element("reportSelectAll");
  const results = element("reportResults");
  const printAll = element("reportPrintAll");
  const excelButton = element("reportExcel");
  let devices = [];
  let report = null;
  let request = null;
  let charts = [];
  let snapshotParams = null;
  let pdfBusy = false;
  const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const weekdayFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  const formatDate = value => {
    const date = new Date(value);
    return dateFormat.format(date).replace(" ", ` (${weekdayFormat.format(date)}) `);
  };
  const inputDate = value => dateFormat.format(new Date(value)).replace(" ", "T").slice(0, 16);
  const inputWeekday = value => {
    const date = new Date(`${value}+09:00`);
    return Number.isNaN(date.getTime()) ? "" : ` · ${weekdayFormat.format(date)}`;
  };

  function updateWeekdays() {
    element("reportStartWeekday").textContent = inputWeekday(startInput.value);
    element("reportEndWeekday").textContent = inputWeekday(endInput.value);
  }

  function make(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function duration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return `${Math.floor(seconds / 3600).toLocaleString("ko-KR")}시간 ${Math.floor(seconds % 3600 / 60)}분 ${seconds % 60}초`;
  }

  function periodDuration(milliseconds) {
    const days = Math.floor(milliseconds / 86400000);
    const remainder = duration(milliseconds % 86400000);
    return days ? `${days.toLocaleString("ko-KR")}일 ${remainder}` : remainder;
  }

  function message(text, error = false) {
    element("reportMessage").textContent = text;
    element("reportMessage").dataset.error = String(error);
  }

  function clearResults() {
    charts.forEach(chart => chart.destroy());
    charts = [];
    results.replaceChildren();
    element("reportPeriod").textContent = "";
  }

  function invalidate() {
    request?.abort();
    request = null;
    report = null;
    snapshotParams = null;
    printAll.disabled = true;
    excelButton.disabled = true;
    element("reportSubmit").disabled = !deviceSelect.value;
    document.querySelector(".report-results").setAttribute("aria-busy", "false");
    clearResults();
    message("조회 조건이 변경되었습니다. 리포트를 조회하세요.");
  }

  function checkboxes() {
    return [...element("reportChannels").querySelectorAll("input")];
  }

  function analysisCheckboxes() {
    return [...element("reportAnalysisOptions").querySelectorAll("input")];
  }

  function syncAnalysis() {
    const boxes = analysisCheckboxes();
    const all = element("reportAnalysisAll");
    all.checked = boxes.every(box => box.checked);
    all.indeterminate = boxes.some(box => box.checked) && !all.checked;
  }

  function syncAll() {
    const boxes = checkboxes();
    selectAll.checked = boxes.length > 0 && boxes.every(box => box.checked);
    selectAll.indeterminate = boxes.some(box => box.checked) && !selectAll.checked;
    selectAll.disabled = boxes.length === 0;
  }

  function renderChannelOptions() {
    const options = element("reportChannels");
    options.replaceChildren();
    const device = devices.find(item => item.device_id === deviceSelect.value);
    for (const channel of device?.sets || []) {
      const label = make("label");
      const checkbox = make("input");
      checkbox.type = "checkbox";
      checkbox.value = channel.output_signal;
      checkbox.checked = false;
      label.append(checkbox, make("span", `${channel.output_signal} · ${channel.channel_name}`));
      options.append(label);
    }
    syncAll();
  }

  function chartPoints(channel, mode) {
    if (mode === "onCount") {
      let count = 0;
      const points = [{ x: report.start, y: count }];
      for (const occurrence of channel.stateOccurrences) {
        if (occurrence.state !== "ON" || occurrence.at < report.start || occurrence.at >= report.end) continue;
        points.push({ x: occurrence.at, y: count });
        count += 1;
        points.push({ x: occurrence.at, y: count });
      }
      points.push({ x: report.end, y: count });
      return points;
    }
    const cumulative = mode === "onTime";
    let total = 0;
    const points = [];
    for (const segment of channel.segments) {
      const before = total;
      total = segment.cumulativeOnMs;
      points.push({ x: segment.start, y: segment.state === null ? null : cumulative ? before / 3600000 : segment.state === "ON" ? 1 : 0 });
      points.push({ x: segment.end, y: segment.state === null ? null : cumulative ? total / 3600000 : segment.state === "ON" ? 1 : 0 });
    }
    return points;
  }

  function timeAxisSettings(start, end, width, mode = "") {
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const offset = 9 * hour;
    const span = end - start;
    const targetTicks = Math.max(2, Math.min(12, Math.floor(width / 100) + 1));
    const regularIntervals = [
      ...[1, 5, 10, 30].map(seconds => seconds * 1000),
      ...[1, 2, 5, 10, 15, 30].map(minutes => minutes * minute),
      ...[1, 2, 3, 6, 12].map(hours => hours * hour),
      ...[1, 2, 3, 7, 14, 30, 60, 90, 180, 365].map(days => days * day)
    ];
    const ticks = [];
    const labels = new Map();
    const labelTick = (value, labelValue = value) => {
      ticks.push({ value });
      labels.set(value, labelValue);
    };
    const requiredInterval = span / (targetTicks - 1);
    let interval;
    let intervalLabel;
    if (["monthly", "yearly"].includes(mode)) {
      const monthly = mode === "monthly";
      const approximateUnit = (monthly ? 30.436875 : 365.2425) * day;
      const count = 1;
      interval = count * approximateUnit;
      intervalLabel = `${count}${monthly ? "개월" : "년"}`;
      if (monthly) {
        const startDate = new Date(start + offset);
        let monthIndex = Math.floor((startDate.getUTCFullYear() * 12 + startDate.getUTCMonth()) / count) * count;
        for (; ;) {
          const year = Math.floor(monthIndex / 12);
          const month = monthIndex % 12;
          const bucketStart = Date.UTC(year, month, 1) - offset;
          const nextStart = Date.UTC(Math.floor((monthIndex + count) / 12), (monthIndex + count) % 12, 1) - offset;
          if (bucketStart >= end) break;
          const from = Math.max(start, bucketStart);
          const until = Math.min(end, nextStart);
          if (from < until) labelTick((from + until) / 2, from);
          monthIndex += count;
        }
      } else {
        const startYear = new Date(start + offset).getUTCFullYear();
        let year = Math.floor(startYear / count) * count;
        for (; ;) {
          const bucketStart = Date.UTC(year, 0, 1) - offset;
          const nextStart = Date.UTC(year + count, 0, 1) - offset;
          if (bucketStart >= end) break;
          const from = Math.max(start, bucketStart);
          const until = Math.min(end, nextStart);
          if (from < until) labelTick((from + until) / 2, from);
          year += count;
        }
      }
    } else if (mode === "weekly") {
      const count = 1;
      interval = count * 7 * day;
      intervalLabel = `${count}주 (월요일 시작)`;
      let monday = Math.ceil((start + offset + 3 * day) / (7 * day)) * 7 * day - offset - 3 * day;
      for (; monday < end; monday += interval) labelTick(monday, monday);
    } else {
      const minimum = mode === "yearly" ? day : mode === "daily" ? day : mode === "hourly" ? hour : mode === "minutely" ? minute : span < minute ? 1000 : minute;
      const intervals = regularIntervals.filter(value => value >= minimum);
      interval = intervals.find(value => value >= requiredInterval) || intervals.at(-1);
      const first = Math.ceil((start + offset) / interval) * interval - offset;
      for (let timestamp = first; timestamp <= end; timestamp += interval) labelTick(timestamp);
      intervalLabel = interval >= day ? `${interval / day}일` : interval >= hour ? `${interval / hour}시간` : interval >= minute ? `${interval / minute}분` : `${interval / 1000}초`;
    }
    if (!ticks.length) {
      const labelValue = mode === "weekly" ? Math.floor((start + offset + 3 * day) / (7 * day)) * 7 * day - offset - 3 * day : start;
      labelTick(mode === "weekly" ? (start + end) / 2 : start, labelValue);
    }
    const dateKey = timestamp => new Date(timestamp + offset).toISOString().slice(0, 10);
    const acrossDays = dateKey(start) !== dateKey(end);
    const showYear = span >= 90 * day || dateKey(start).slice(0, 4) !== dateKey(end).slice(0, 4);
    const dateLabel = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", ...(showYear ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit"
    });
    const clockLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", ...(interval < minute ? { second: "2-digit" } : {}), hour12: false
    });
    const monthLabel = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric" });
    const yearLabel = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric" });
    const weekLabel = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", weekday: "short" });
    return {
      ticks, interval, intervalLabel,
      formatLabel: value => {
        const labelValue = labels.get(value) ?? value;
        if (mode === "monthly") {
          const parts = monthLabel.formatToParts(new Date(labelValue));
          return `${parts.find(part => part.type === "year").value}년 ${parts.find(part => part.type === "month").value}월`;
        }
        if (mode === "yearly") return yearLabel.format(new Date(labelValue));
        if (mode === "weekly") return weekLabel.format(new Date(labelValue));
        if (["minutely", "hourly"].includes(mode)) return [dateLabel.format(new Date(labelValue)), clockLabel.format(new Date(labelValue))];
        return interval >= day ? dateLabel.format(new Date(labelValue)) : acrossDays ? [dateLabel.format(new Date(labelValue)), clockLabel.format(new Date(labelValue))] : clockLabel.format(new Date(labelValue));
      }
    };
  }

  function timeAxisOptions(mode = "") {
    return {
      type: "linear", min: report.start, max: report.end,
      afterBuildTicks: axis => {
        const settings = timeAxisSettings(report.start, report.end, axis.width || axis.maxWidth || axis.chart.width, mode);
        axis.ticks = settings.ticks;
        axis.options.ticks.callback = settings.formatLabel;
        axis.options.title.text = `시간 (KST · ${settings.intervalLabel} 간격)`;
      },
      ticks: { autoSkip: false, maxRotation: 0, minRotation: 0 },
      title: { display: true, text: "시간 (KST)" },
      grid: { display: true, drawOnChartArea: true, color: "#c4d2cc", lineWidth: 1 },
      border: { display: true, color: "#91a69d" }
    };
  }

  function createTransitionChart(canvas, channel, mode, printing) {
    const buckets = channel.onTransitionBuckets[mode];
    const colors = { minutely: "#22818b", hourly: "#326d9c", daily: "#a66b10", weekly: "#b45242", monthly: "#617d37", yearly: "#64748b" };
    const points = buckets.map(bucket => ({ x: bucket.start + (bucket.end - bucket.start) / 2, y: bucket.count }));
    return new Chart(canvas, {
      type: "bar",
      data: { datasets: [{ label: "ON 전환 횟수", data: points, backgroundColor: colors[mode], borderWidth: 0, barThickness: "flex", maxBarThickness: 48 }] },
      options: {
        responsive: !printing, maintainAspectRatio: false, animation: false,
        parsing: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: items => items.length ? `${formatDate(buckets[items[0].dataIndex].start)} ~ ${formatDate(buckets[items[0].dataIndex].end)} KST` : "",
          label: item => {
            const bucket = buckets[item.dataIndex];
            const value = bucket.count === null ? "확인 불가" : `${bucket.count.toLocaleString("ko-KR")}회`;
            return bucket.complete ? `ON 전환 횟수: ${value}` : [`ON 전환 횟수: ${value}`, "확인된 기록만 집계"];
          }
        } } },
        scales: {
          x: timeAxisOptions(mode),
          y: { min: 0, suggestedMax: 1, title: { display: true, text: "ON 전환 횟수 (회)" }, ticks: { precision: 0, maxTicksLimit: 5 }, grid: { color: "#e5ece9" } }
        }
      }
    });
  }

  function createChart(canvas, channel, mode, printing = false) {
    if (["minutely", "hourly", "daily", "weekly", "monthly", "yearly"].includes(mode)) return createTransitionChart(canvas, channel, mode, printing);
    const cumulative = mode === "onTime";
    const counting = mode === "onCount";
    return new Chart(canvas, {
      type: "line",
      data: { datasets: [{
        label: counting ? "ON 누적 횟수" : cumulative ? "ON 누적 시간" : "ON · OFF 상태",
        data: chartPoints(channel, mode),
        borderColor: counting ? "#a66b10" : cumulative ? "#326d9c" : "#087a67",
        backgroundColor: counting ? "rgba(166,107,16,0.08)" : cumulative ? "rgba(50,109,156,0.08)" : "rgba(8,122,103,0.10)",
        borderWidth: 2, pointRadius: 0, pointHitRadius: 10,
        spanGaps: false, fill: true, tension: 0
      }] },
      options: {
        responsive: !printing, maintainAspectRatio: false, animation: false,
        parsing: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: {
          filter: (item, index, items) => !cumulative || items.findIndex(candidate => candidate.datasetIndex === item.datasetIndex && candidate.parsed.x === item.parsed.x && candidate.parsed.y === item.parsed.y) === index,
          callbacks: {
          title: items => items.length ? `${formatDate(items[0].parsed.x)} KST` : "",
          label: item => counting ? `ON 누적 횟수: ${item.parsed.y.toLocaleString("ko-KR")}회` : cumulative ? `ON 누적 시간: ${duration(item.parsed.y * 3600000)}` : item.parsed.y === 1 ? "ON" : "OFF"
        } } },
        scales: {
          x: timeAxisOptions(mode),
          y: counting ? { min: 0, suggestedMax: Math.max(1, channel.onCount), title: { display: true, text: "횟수 (회)" }, ticks: { precision: 0, maxTicksLimit: 5 }, grid: { color: "#e5ece9" } } : cumulative ? { min: 0, title: { display: true, text: "시간" }, ticks: { maxTicksLimit: 5 }, grid: { color: "#e5ece9" } } : { min: -0.1, max: 1.1, afterBuildTicks: axis => { axis.ticks = [{ value: 0 }, { value: 1 }]; }, ticks: { callback: value => value === 1 ? "ON" : value === 0 ? "OFF" : "" }, grid: { color: "#e5ece9" } }
        }
      }
    });
  }

  function channelSection(channel, printing = false) {
    const analysis = new Set(report.analysisItems || ["onCount", "offCount", "transitionCount", "onTime", "offTime", "onPercentage", "stateGraph", "onCountGraph", "onTimeGraph", "minutelyGraph", "hourlyGraph", "dailyGraph", "weeklyGraph", "monthlyGraph", "yearlyGraph"]);
    const section = make("article", undefined, "report-channel");
    if (printing) {
      section.append(make("h2", "디바이스 채널 리포트"), make("p", `${report.device.device_name} (${report.device.device_id})`), make("p", `${formatDate(report.start)} ~ ${formatDate(report.end)} KST · 총 기간: ${periodDuration(report.end - report.start)}`, "report-period"));
    }
    const heading = make("div", undefined, "report-channel-heading");
    const title = make("div");
    title.append(make("h3", channel.channelName), make("small", channel.outputSignal));
    heading.append(title);
    if (!printing) {
      const button = make("button", "채널 PDF 다운로드", "link");
      button.type = "button";
      button.disabled = pdfBusy;
      button.addEventListener("click", () => downloadPdf([channel]));
      heading.append(button);
    }
    section.append(heading);
    const statistics = make("dl", undefined, "report-statistics");
    const onPercentage = ((channel.onMs / (report.end - report.start)) * 100).toFixed(1);
    const entries = [["onCount", "ON 횟수", `${channel.onCount.toLocaleString("ko-KR")}회`], ["offCount", "OFF 횟수", `${channel.offCount.toLocaleString("ko-KR")}회`], ["transitionCount", "총 전환 횟수", `${channel.transitionCount.toLocaleString("ko-KR")}회`], ["onTime", "ON 누적시간", duration(channel.onMs)], ["offTime", "OFF 누적 시간", duration(channel.offMs)], ["onPercentage", "ON 시간 비율", `${onPercentage}%`]];
    for (const [key, label, value] of entries) {
      if (!analysis.has(key)) continue;
      const stat = make("div");
      stat.setAttribute("data-analysis", key);
      stat.append(make("dt", label), make("dd", value));
      statistics.append(stat);
    }
    if (statistics.children.length) section.append(statistics);
    if (channel.unknownMs) section.append(make("p", "해당 기간의 일부 상태 이력이 없어 확인 불가 시간이 포함되어 있습니다.", "report-data-warning"));
    for (const [mode, graphTitle] of [["state", "ON · OFF 상태"], ["onCount", "ON 누적 횟수"], ["onTime", "ON 누적 시간"], ["minutely", "분별 ON 전환 횟수"], ["hourly", "시간별 ON 전환 횟수"], ["daily", "일별 ON 전환 횟수"], ["weekly", "주간별 ON 전환 횟수"], ["monthly", "월별 ON 전환 횟수"], ["yearly", "연간별 ON 전환 횟수"]]) {
      if (!analysis.has(`${mode}Graph`)) continue;
      section.append(make("h4", graphTitle));
      const canvas = make("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("data-chart-mode", mode);
      canvas.setAttribute("aria-label", `${channel.channelName} ${graphTitle} 그래프`);
      if (printing) {
        canvas.width = 1000;
        canvas.height = 220;
        const chart = createChart(canvas, channel, mode, true);
        const image = make("img");
        image.alt = canvas.getAttribute("aria-label");
        image.src = canvas.toDataURL("image/png");
        chart.destroy();
        section.append(image);
      } else {
        const plot = make("div", undefined, "report-plot");
        plot.append(canvas);
        section.append(plot);
      }
    }
    if (printing) section.append(make("p", `생성: ${formatDate(report.generatedAt)} KST · 저장된 출력 상태 기준`, "report-period"));
    return section;
  }

  async function downloadPdf(channels) {
    if (pdfBusy || !report || !channels.length) return;
    const snapshot = report;
    const target = make("div", undefined, "report-pdf-export");
    target.setAttribute("aria-hidden", "true");
    pdfBusy = true;
    printAll.disabled = true;
    results.querySelectorAll("button").forEach(button => { button.disabled = true; });
    message("PDF 파일을 생성하고 있습니다...");
    try {
      target.replaceChildren(...channels.map(channel => channelSection(channel, true)));
      document.body.append(target);
      await Promise.all([...target.querySelectorAll("img")].map(image => {
        if (image.complete && image.naturalWidth) return Promise.resolve();
        return new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
        });
      }));
      await document.fonts.ready;
      const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      for (const [index, section] of [...target.children].entries()) {
        const canvas = await window.html2canvas(section, {
          backgroundColor: "#ffffff", scale: 2, logging: false,
          windowWidth: 1200, scrollX: 0, scrollY: 0,
          onclone: cloned => {
            cloned.documentElement.dataset.theme = "light";
            cloned.querySelector(".report-pdf-export").style.left = "0";
          }
        });
        if (index) pdf.addPage();
        const scale = (pageWidth - 24) / canvas.width;
        const width = canvas.width * scale;
        const pagePixels = Math.max(1, Math.floor((pageHeight - 24) / scale));
        let breaks = [];
        if (canvas.height > pagePixels) {
          const bounds = section.getBoundingClientRect();
          const pixelRatio = canvas.height / bounds.height;
          breaks = [...section.querySelectorAll("h4")].map(heading => Math.round((heading.getBoundingClientRect().top - bounds.top) * pixelRatio));
        }
        for (let offset = 0; offset < canvas.height;) {
          const limit = Math.min(canvas.height, offset + pagePixels);
          const until = limit === canvas.height ? limit : breaks.filter(value => value > offset && value <= limit).at(-1) || limit;
          if (offset) pdf.addPage();
          pdf.setFontSize(8);
          pdf.text(`${snapshot.device.device_id} / ${channels[index].outputSignal}`, 12, 8);
          if (offset === 0 && until === canvas.height) {
            pdf.addImage(canvas.toDataURL("image/png"), "PNG", 12, 12, width, canvas.height * scale, undefined, "FAST");
          } else {
            const slice = make("canvas");
            slice.width = canvas.width;
            slice.height = until - offset;
            slice.getContext("2d").drawImage(canvas, 0, offset, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
            pdf.addImage(slice.toDataURL("image/png"), "PNG", 12, 12, width, slice.height * scale, undefined, "FAST");
            slice.width = slice.height = 0;
          }
          offset = until;
        }
        canvas.width = canvas.height = 0;
      }
      const channelSuffix = channels.length === 1 ? `-${channels[0].outputSignal}` : "";
      await pdf.save(`${snapshot.device.device_id}${channelSuffix}-report.pdf`, { returnPromise: true });
      if (report === snapshot) message(`${channels.length}개 채널 PDF 다운로드가 완료되었습니다.`);
    } catch {
      message("PDF 다운로드에 실패했습니다. 다시 시도하세요.", true);
    } finally {
      target.remove();
      pdfBusy = false;
      printAll.disabled = !report?.channels.length;
      results.querySelectorAll("button").forEach(button => { button.disabled = false; });
    }
  }

  form.addEventListener("change", event => {
    invalidate();
    if (event.target === deviceSelect) renderChannelOptions();
    if (event.target === selectAll) checkboxes().forEach(box => { box.checked = selectAll.checked; });
    if (event.target === element("reportAnalysisAll")) analysisCheckboxes().forEach(box => { box.checked = event.target.checked; });
    syncAll();
    syncAnalysis();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const selected = checkboxes().filter(box => box.checked).map(box => box.value);
    const analysisItems = analysisCheckboxes().filter(box => box.checked).map(box => box.value);
    invalidate();
    if (!selected.length) return message("채널을 하나 이상 선택하세요.", true);
    if (!analysisItems.length) return message("분석 항목을 하나 이상 선택하세요.", true);
    const controller = new AbortController();
    request = controller;
    const params = new URLSearchParams({ device_id: deviceSelect.value, start: startInput.value, end: endInput.value, channels: selected.join(","), include_minutely: analysisItems.includes("minutelyGraph") ? "1" : "0" });
    element("reportSubmit").disabled = true;
    document.querySelector(".report-results").setAttribute("aria-busy", "true");
    message("리포트를 생성하고 있습니다...");
    try {
      const response = await fetch(`/api/admin/device/report?${params}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "리포트를 불러오지 못했습니다.");
      if (controller.signal.aborted) return;
      report = { ...data, channels: data.channels.filter(channel => selected.includes(channel.outputSignal)), analysisItems };
      snapshotParams = params;
      for (const channel of report.channels) {
        const section = channelSection(channel);
        results.append(section);
        section.querySelectorAll("canvas").forEach(canvas => charts.push(createChart(canvas, channel, canvas.getAttribute("data-chart-mode"))));
      }
      element("reportPeriod").textContent = `${report.device.device_name} · ${formatDate(report.start)} ~ ${formatDate(report.end)} KST · 총 기간: ${periodDuration(report.end - report.start)} · 종료 시각 미포함`;
      message(`${selected.length}개 채널 · 저장된 출력 상태 기준`);
      printAll.disabled = pdfBusy || report.channels.length === 0;
      excelButton.disabled = report.channels.length === 0;
    } catch (error) {
      if (error.name !== "AbortError") {
        clearResults();
        report = null;
        message(error.message, true);
      }
    } finally {
      if (request === controller) {
        request = null;
        element("reportSubmit").disabled = false;
        document.querySelector(".report-results").setAttribute("aria-busy", "false");
      }
    }
  });

  printAll.addEventListener("click", () => { if (report) downloadPdf(report.channels); });
  excelButton.addEventListener("click", async () => {
    if (!snapshotParams) return;
    const params = new URLSearchParams(snapshotParams);
    params.set("format", "xlsx");
    excelButton.disabled = true;
    try {
      const response = await fetch(`/api/admin/device/report?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error || "Excel 다운로드에 실패했습니다.");
      const url = URL.createObjectURL(await response.blob());
      const link = make("a");
      link.href = url;
      link.download = `${params.get("device_id")}-report.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { message(error.message, true); }
    finally { excelButton.disabled = !report; }
  });

  async function initialize() {
    const now = Date.now();
    endInput.value = inputDate(now);
    startInput.value = `${inputDate(now).slice(0, 10)}T00:00`;
    if (startInput.value === endInput.value) startInput.value = inputDate(now - 86400000);
    startInput.max = endInput.max = inputDate(now);
    startInput.addEventListener("input", updateWeekdays);
    endInput.addEventListener("input", updateWeekdays);
    updateWeekdays();
    try {
      const response = await fetch("/api/admin/device/devices", { cache: "no-store" });
      if (response.status === 401) { location.href = "/user-login.html"; return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "디바이스 목록을 불러오지 못했습니다.");
      devices = data.filter(device => Number(device.is_enabled) === 1);
      deviceSelect.replaceChildren();
      for (const device of devices) {
        const option = make("option", `${device.device_name} (${device.device_id})`);
        option.value = device.device_id;
        deviceSelect.append(option);
      }
      deviceSelect.disabled = devices.length === 0;
      element("reportSubmit").disabled = devices.length === 0;
      renderChannelOptions();
      if (!devices.length) message("선택할 사용 중인 디바이스가 없습니다.");
    } catch (error) {
      deviceSelect.replaceChildren(make("option", "불러오기 실패"));
      message(error.message, true);
    }
  }
  initialize();
})();