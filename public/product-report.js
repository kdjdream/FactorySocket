(() => {
  const element = id => document.getElementById(id);
  const form = element("productReportForm");
  const startInput = element("productReportStart");
  const endInput = element("productReportEnd");
  const results = element("reportResults");
  const submit = element("productReportSubmit");
  const pdfButton = element("productPdf");
  const excelButton = element("productExcel");
  const graphs = { cumulative: "누적 수량", minutely: "분별 작업 수량", hourly: "시간별 작업 수량", daily: "일별 작업 수량", weekly: "주간별 작업 수량", monthly: "월별 작업 수량", yearly: "연간별 작업 수량" };
  const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const weekday = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  let report = null;
  let request = null;
  let paramsSnapshot = null;
  let charts = [];
  let pdfBusy = false;

  function make(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function formatDate(value) {
    return dateFormat.format(new Date(value)).replace(" ", ` (${weekday.format(new Date(value))}) `);
  }
  function inputDate(value) { return dateFormat.format(new Date(value)).replace(" ", "T").slice(0, 16); }
  function periodText(data) {
    const seconds = Math.floor((data.end - data.start) / 1000);
    return `${formatDate(data.start)} ~ ${formatDate(data.end)} KST · 총 기간: ${Math.floor(seconds / 86400)}일 ${Math.floor(seconds % 86400 / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분 ${seconds % 60}초`;
  }
  function message(text, error = false) {
    element("productReportMessage").textContent = text;
    element("productReportMessage").dataset.error = String(error);
  }
  function boxes(id) { return [...element(id).querySelectorAll("input")]; }
  function syncSelection(optionsId, allId) {
    const options = boxes(optionsId);
    const all = element(allId);
    all.checked = options.length > 0 && options.every(box => box.checked);
    all.indeterminate = options.some(box => box.checked) && !all.checked;
    all.disabled = options.length === 0;
  }
  function updateWeekdays() {
    for (const [input, label] of [[startInput, "productStartWeekday"], [endInput, "productEndWeekday"]]) {
      const date = new Date(`${input.value}+09:00`);
      element(label).textContent = Number.isNaN(date.getTime()) ? "" : ` · ${weekday.format(date)}`;
    }
  }
  function invalidate() {
    request?.abort();
    request = null;
    report = null;
    paramsSnapshot = null;
    charts.forEach(chart => chart.destroy());
    charts = [];
    results.replaceChildren();
    element("productReportPeriod").textContent = "";
    pdfButton.disabled = excelButton.disabled = true;
    submit.disabled = boxes("productReportOptions").length === 0;
    document.querySelector(".report-results").setAttribute("aria-busy", "false");
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
      const minimum = mode === "daily" ? day : mode === "hourly" ? hour : mode === "minutely" ? minute : span < minute ? 1000 : minute;
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
        return interval >= day ? dateLabel.format(new Date(labelValue)) : [dateLabel.format(new Date(labelValue)), clockLabel.format(new Date(labelValue))];
      }
    };
  }
  function graphTitle(mode) {
    return mode === "cumulative" && report?.basis === "work" ? "작업 수량 추이" : graphs[mode];
  }
  function createChart(canvas, product, mode, printing = false) {
    const cumulative = mode === "cumulative";
    const workBasis = report?.basis === "work";
    const buckets = cumulative ? [] : product.buckets[mode];
    const colors = { cumulative: "#087a67", minutely: "#22818b", hourly: "#326d9c", daily: "#a66b10", weekly: "#b45242", monthly: "#617d37", yearly: "#64748b" };
    const quantityLabel = value => value === null ? "확인 불가" : `${value.toLocaleString("ko-KR")}개`;
    const points = cumulative ? product.points.map(point => ({ x: point.at, y: point.value })) : buckets.map(bucket => ({ x: bucket.start + (bucket.end - bucket.start) / 2, y: bucket.quantity }));
    return new Chart(canvas, {
      type: cumulative ? "line" : "bar",
      data: { datasets: [{ label: graphTitle(mode), data: points, borderColor: colors[mode], backgroundColor: cumulative ? "rgba(8,122,103,0.08)" : colors[mode], borderWidth: cumulative ? 2 : 0, pointRadius: 0, pointHitRadius: 10, stepped: cumulative ? "after" : false, fill: cumulative, spanGaps: false, barThickness: cumulative ? undefined : "flex", maxBarThickness: 48 }] },
      options: {
        responsive: !printing, maintainAspectRatio: false, animation: false,
        parsing: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: {
          filter: (item, index, items) => items.findIndex(candidate => candidate.datasetIndex === item.datasetIndex && candidate.dataIndex === item.dataIndex) === index,
          callbacks: {
            title: items => items.length ? cumulative ? `${formatDate(items[0].parsed.x)} KST` : `${formatDate(buckets[items[0].dataIndex].start)} ~ ${formatDate(buckets[items[0].dataIndex].end)} KST` : "",
            label: item => cumulative ? [`${workBasis ? "작업" : "누적"} 수량: ${quantityLabel(product.points[item.dataIndex].quantity)}`, `초기 대비: ${quantityLabel(item.parsed.y)}`] : buckets[item.dataIndex].complete ? `작업 수량: ${quantityLabel(item.parsed.y)}` : [`작업 수량: ${quantityLabel(item.parsed.y)}`, "수집 이후 기록 합계"]
          }
        } },
        scales: {
          x: {
            type: "linear", min: report.start, max: report.end,
            afterBuildTicks: axis => {
              const settings = timeAxisSettings(report.start, report.end, axis.width || axis.maxWidth || axis.chart.width, cumulative ? "" : mode);
              axis.ticks = settings.ticks;
              axis.options.ticks.callback = settings.formatLabel;
              axis.options.title.text = `기간 (KST · ${settings.intervalLabel} 간격)`;
            },
            title: { display: true, text: "기간 (KST)" },
            ticks: { autoSkip: false, maxRotation: 0, minRotation: 0 },
            grid: { color: "#c4d2cc" }
          },
          y: { beginAtZero: true, ...(cumulative ? { suggestedMin: 0, suggestedMax: 1 } : { min: 0 }), title: { display: true, text: cumulative ? `초기 대비 ${workBasis ? "작업" : "누적"} 수량 (개)` : `${workBasis ? "작업" : "누적 증가"} 수량 (개)` }, ticks: { precision: 0 }, grid: { color: context => context.tick.value === 0 ? "#718a82" : "#e5ece9", lineWidth: context => context.tick.value === 0 ? 2 : 1 } }
        }
      }
    });
  }
  function productSection(product, printing = false) {
    const section = make("article", undefined, "report-channel");
    if (printing) section.append(make("h2", "제품별 현황 리포트"), make("p", periodText(report), "report-period"));
    const heading = make("div", undefined, "report-channel-heading");
    const title = make("div");
    title.append(make("h3", product.productName), make("small", product.productCode));
    heading.append(title);
    if (!printing) {
      const button = make("button", "제품 PDF 다운로드", "link");
      button.type = "button";
      button.disabled = pdfBusy;
      button.addEventListener("click", () => downloadPdf([product]));
      heading.append(button);
    }
    section.append(heading);
    const selected = new Set(report.analysisItems);
    const basisLabel = report.basis === "work" ? "작업" : "누적";
    const statistics = make("dl", undefined, "report-statistics");
    for (const [key, label] of [["initialQuantity", `초기 ${basisLabel} 수량`], ["endQuantity", `종료 ${basisLabel} 수량`], ["increaseQuantity", `${basisLabel} 증가 수량`]]) {
      if (!selected.has(key)) continue;
      const stat = make("div");
      stat.append(make("dt", label), make("dd", product[key] === null ? "확인 불가" : `${product[key].toLocaleString("ko-KR")}개`));
      statistics.append(stat);
    }
    if (statistics.children.length) section.append(statistics);
    if (product.initialQuantityAssumed) section.append(make("p", `조회 시작 이력이 없어 조회 기간의 첫 기록 ${basisLabel} 수량을 초기 수량으로 사용했습니다.`, "report-data-warning"));
    else if (!product.complete) section.append(make("p", `조회 기간에 ${basisLabel} 수량 이력이 없어 초기 수량·증가 수량·그래프는 확인 불가입니다.`, "report-data-warning"));
    for (const [mode, label] of Object.entries(graphs)) {
      if (!selected.has(mode)) continue;
      const title = graphTitle(mode);
      section.append(make("h4", title));
      const canvas = make("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${product.productName} ${title} 그래프`);
      canvas.dataset.mode = mode;
      if (printing) {
        canvas.width = 1000;
        canvas.height = 220;
        const chart = createChart(canvas, product, mode, true);
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
    if (printing) section.append(make("p", `생성: ${formatDate(report.generatedAt)} KST · 저장된 ${basisLabel} 수량 기준`, "report-period"));
    return section;
  }
  async function downloadPdf(products) {
    if (pdfBusy || !report || !products.length) return;
    const snapshot = report;
    const target = make("div", undefined, "report-pdf-export");
    target.setAttribute("aria-hidden", "true");
    pdfBusy = true;
    pdfButton.disabled = true;
    results.querySelectorAll("button").forEach(button => { button.disabled = true; });
    message("PDF 파일을 생성하고 있습니다...");
    try {
      target.replaceChildren(...products.map(product => productSection(product, true)));
      document.body.append(target);
      await Promise.all([...target.querySelectorAll("img")].map(image => image.complete && image.naturalWidth ? Promise.resolve() : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; })));
      await document.fonts.ready;
      const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (const [index, section] of [...target.children].entries()) {
        const canvas = await window.html2canvas(section, { backgroundColor: "#ffffff", scale: 2, logging: false, windowWidth: 1200, scrollX: 0, scrollY: 0, onclone: cloned => { cloned.documentElement.dataset.theme = "light"; cloned.querySelector(".report-pdf-export").style.left = "0"; } });
        if (index) pdf.addPage();
        const width = pdf.internal.pageSize.getWidth(), height = pdf.internal.pageSize.getHeight();
        const ratio = Math.min((width - 24) / canvas.width, (height - 24) / canvas.height);
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", (width - canvas.width * ratio) / 2, 12, canvas.width * ratio, canvas.height * ratio, undefined, "FAST");
        canvas.width = canvas.height = 0;
      }
      await pdf.save(`${products.length === 1 ? products[0].productCode : "products"}-report.pdf`, { returnPromise: true });
      if (report === snapshot) message(`${products.length}개 제품 PDF 다운로드가 완료되었습니다.`);
    } catch { message("PDF 다운로드에 실패했습니다. 다시 시도하세요.", true); }
    finally {
      target.remove(); pdfBusy = false; pdfButton.disabled = !report;
      results.querySelectorAll("button").forEach(button => { button.disabled = false; });
    }
  }
  form.addEventListener("input", updateWeekdays);
  form.addEventListener("change", event => {
    if (event.target === element("productReportAll")) boxes("productReportOptions").forEach(box => { box.checked = event.target.checked; });
    if (event.target === element("productAnalysisAll")) boxes("productAnalysisOptions").forEach(box => { box.checked = event.target.checked; });
    syncSelection("productReportOptions", "productReportAll");
    syncSelection("productAnalysisOptions", "productAnalysisAll");
    invalidate();
    message("조회 조건이 변경되었습니다. 리포트를 조회하세요.");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const selected = boxes("productReportOptions").filter(box => box.checked).map(box => box.value);
    const analysisItems = boxes("productAnalysisOptions").filter(box => box.checked).map(box => box.value);
    invalidate();
    if (!selected.length || selected.length > 50) return message("제품을 1~50개 선택하세요.", true);
    if (!analysisItems.length) return message("분석 항목을 하나 이상 선택하세요.", true);
    const controller = new AbortController();
    request = controller;
    const basis = form.querySelector('input[name="quantityBasis"]:checked').value;
    const params = new URLSearchParams({ products: selected.join(","), start: startInput.value, end: endInput.value, include_minutely: analysisItems.includes("minutely") ? "1" : "0", basis });
    submit.disabled = true;
    document.querySelector(".report-results").setAttribute("aria-busy", "true");
    message("리포트를 생성하고 있습니다...");
    try {
      const response = await fetch(`/api/admin/products/report?${params}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "리포트를 생성하지 못했습니다.");
      if (controller.signal.aborted) return;
      if (data.basis !== basis) throw new Error("선택한 수량 기준과 서버 계산 기준이 다릅니다. 서버를 재시작한 뒤 다시 조회하세요.");
      report = { ...data, products: data.products.filter(product => selected.includes(String(product.productId))), analysisItems };
      paramsSnapshot = params;
      for (const product of report.products) {
        const section = productSection(product);
        results.append(section);
        section.querySelectorAll("canvas").forEach(canvas => charts.push(createChart(canvas, product, canvas.dataset.mode)));
      }
      element("productReportPeriod").textContent = periodText(report);
      pdfButton.disabled = pdfBusy || !report.products.length;
      excelButton.disabled = !report.products.length;
      message(`${report.products.length}개 제품 · 저장된 ${basis === "work" ? "작업" : "누적"} 수량 기준`);
    } catch (error) { if (error.name !== "AbortError") { invalidate(); message(error.message, true); } }
    finally { if (request === controller) { request = null; submit.disabled = false; document.querySelector(".report-results").setAttribute("aria-busy", "false"); } }
  });
  pdfButton.addEventListener("click", () => { if (report) downloadPdf(report.products); });
  excelButton.addEventListener("click", async () => {
    if (!paramsSnapshot) return;
    const params = new URLSearchParams(paramsSnapshot);
    params.set("format", "xlsx");
    excelButton.disabled = true;
    try {
      const response = await fetch(`/api/admin/products/report?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error || "Excel 다운로드에 실패했습니다.");
      const url = URL.createObjectURL(await response.blob());
      const link = make("a");
      link.href = url; link.download = "product-report.xlsx";
      document.body.append(link); link.click(); link.remove();
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
    updateWeekdays();
    try {
      const response = await fetch("/api/admin/products/report/options", { cache: "no-store" });
      if (response.status === 401) { location.href = "/user-login.html"; return; }
      const products = await response.json();
      if (!response.ok) throw new Error(products.error || "제품 목록을 불러오지 못했습니다.");
      const target = element("productReportOptions");
      for (const product of products) {
        const label = make("label");
        const checkbox = make("input");
        checkbox.type = "checkbox"; checkbox.value = String(product.id); checkbox.checked = false;
        label.append(checkbox, make("span", `${product.product_code} · ${product.product_name}${Number(product.is_enabled) === 0 ? " (사용 중지)" : ""}`));
        target.append(label);
      }
      syncSelection("productReportOptions", "productReportAll");
      submit.disabled = !products.length;
      if (!products.length) message("등록된 제품이 없습니다.");
    } catch (error) { message(error.message, true); }
  }
  initialize();
})();