const { reportTime, reportSqlTime, parseReportPeriod } = require("./device-report");
const { ensureProductQuantityColumns } = require("./product-quantity");
const { bucketStart, nextBucketStart } = require("./report-buckets");

const MINUTE = 60000;

function buildProductReport(product, baseline, events, start, end, includeMinutely = true, basis = "cumulative") {
  const valueField = basis === "work" ? "work_quantity" : "quantity";
  const readValue = row => row?.[valueField] == null ? null : Number(row[valueField]);
  let initialQuantity = readValue(baseline);
  let initialQuantityAssumed = false;
  let current = initialQuantity;
  let knownFrom = initialQuantity === null ? null : start;
  let workQuantity = 0;
  const changes = [];
  const points = [{ at: start, quantity: current, value: current === null ? null : 0 }];
  const totals = { ...(includeMinutely ? { minutely: new Map() } : {}), hourly: new Map(), daily: new Map(), weekly: new Map(), monthly: new Map(), yearly: new Map() };
  let cumulativeCurrent = baseline?.quantity == null ? null : Number(baseline.quantity);
  for (const event of events) {
    const at = reportTime(event.changed_at);
    if (at < start || at >= end) continue;
    const quantity = Number(event.quantity);
    const value = readValue(event);
    const cumulativeDelta = cumulativeCurrent === null ? 0 : quantity - cumulativeCurrent;
    cumulativeCurrent = quantity;
    const previous = current;
    if (initialQuantity === null && value !== null) {
      initialQuantity = value;
      initialQuantityAssumed = at > start;
      points[0] = { at: start, quantity: initialQuantity, value: 0 };
    }
    if (value === null) {
      changes.push({ at, quantity, delta: cumulativeDelta, analysisQuantity: null, analysisDelta: null, previousStatus: event.previous_product_status ?? null, productStatus: event.product_status ?? null, source: event.change_source || "", workQuantity: event.work_quantity ?? null, targetQuantity: event.target_quantity ?? null, reason: event.change_reason || "", userId: event.changed_by_user_id ?? null, username: event.changed_by_username || "", changeType: event.change_type || "LEGACY" });
      continue;
    }
    if (knownFrom === null) knownFrom = at;
    const delta = previous === null ? 0 : value - previous;
    workQuantity += Math.max(delta, 0);
    current = value;
    points.push({ at, quantity: value, value: initialQuantity === null ? null : value - initialQuantity });
    changes.push({ at, quantity, delta: cumulativeDelta, analysisQuantity: value, analysisDelta: delta, previousStatus: event.previous_product_status ?? null, productStatus: event.product_status ?? null, source: event.change_source || "", workQuantity: event.work_quantity ?? null, targetQuantity: event.target_quantity ?? null, reason: event.change_reason || "", userId: event.changed_by_user_id ?? null, username: event.changed_by_username || "", changeType: event.change_type || "LEGACY" });
    for (const unit of Object.keys(totals)) {
      const key = bucketStart(at, unit);
      totals[unit].set(key, (totals[unit].get(key) || 0) + Math.max(delta, 0));
    }
  }
  points.push({ at: end, quantity: current, value: initialQuantity === null || current === null ? null : current - initialQuantity });
  const buckets = {};
  for (const [unit, values] of Object.entries(totals)) {
    buckets[unit] = [];
    for (let at = bucketStart(start, unit); at < end;) {
      const next = nextBucketStart(at, unit);
      const from = Math.max(at, start);
      const until = Math.min(next, end);
      buckets[unit].push({ at, start: from, end: until, quantity: knownFrom !== null && knownFrom < until ? values.get(at) || 0 : null, complete: knownFrom !== null && knownFrom <= from });
      at = next;
    }
  }
  return {
    basis,
    productId: Number(product.id), productCode: product.product_code, productName: product.product_name,
    initialQuantity, endQuantity: current,
    increaseQuantity: initialQuantity === null || current === null ? null : current - initialQuantity,
    workQuantity, knownFrom, initialQuantityAssumed, complete: initialQuantity !== null && !initialQuantityAssumed, points, buckets, changes
  };
}

async function loadProductReport(query, options) {
  const { start, end } = parseReportPeriod(options.start, options.end);
  const tokens = String(options.products || "").split(",");
  if (!tokens.length || tokens.length > 50 || tokens.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("제품을 1~50개 선택하세요.");
  const ids = [...new Set(tokens.map(Number))];
  const basis = options.basis === "work" ? "work" : "cumulative";
  const includeMinutely = options.include_minutely !== "0";
  if (includeMinutely && (Math.floor((end - 1) / MINUTE) - Math.floor(start / MINUTE) + 1) * ids.length > 100000) throw new Error("분별 구간이 100,000개를 초과합니다. 기간·제품 수를 줄이거나 분별 작업 수량을 해제하세요.");
  const placeholders = ids.map(() => "?").join(",");
  const products = await query(`SELECT product_id AS id,product_code,product_name FROM product WHERE product_id IN (${placeholders}) ORDER BY sort_order,product_id`, ids);
  if (products.length !== ids.length) throw new Error("선택한 제품이 삭제되었거나 존재하지 않습니다.");
  const baselines = await query(
    `SELECT h.product_id,h.quantity,h.work_quantity FROM product_quantity_history h WHERE h.product_id IN (${placeholders})
     AND h.history_id=(SELECT b.history_id FROM product_quantity_history b WHERE b.product_id=h.product_id
       AND b.changed_at<? ORDER BY b.changed_at DESC,b.history_id DESC LIMIT 1)`, [...ids, reportSqlTime(start)]);
  const events = await query(
    `SELECT history_id,product_id,quantity,work_quantity,target_quantity,previous_product_status,product_status,change_source,change_reason,changed_by_user_id,changed_by_username,change_type,changed_at FROM product_quantity_history
     WHERE product_id IN (${placeholders}) AND changed_at>=? AND changed_at<? ORDER BY changed_at,history_id LIMIT 100001`,
    [...ids, reportSqlTime(start), reportSqlTime(end)]);
  if (events.length > 100000) throw new Error("수량 이력이 100,000건을 초과합니다. 기간 또는 제품 수를 줄여주세요.");
  return {
    start, end, generatedAt: Date.now(), timezone: "Asia/Seoul", basis,
    products: products.map(product => buildProductReport(product, baselines.find(row => Number(row.product_id) === Number(product.id)), events.filter(row => Number(row.product_id) === Number(product.id)), start, end, includeMinutely, basis))
  };
}

async function ensureProductHistory(query) {
  await ensureProductQuantityColumns(query);
  await query(`CREATE TABLE IF NOT EXISTS product_quantity_history (
    history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    work_quantity INT NULL,
    target_quantity INT NULL,
    previous_product_status VARCHAR(20) NULL,
    product_status VARCHAR(20) NULL,
    change_source VARCHAR(100) NOT NULL DEFAULT '',
    change_reason VARCHAR(500) NOT NULL DEFAULT '',
    changed_by_user_id INT NULL,
    changed_by_username VARCHAR(150) NULL,
    change_type VARCHAR(30) NOT NULL DEFAULT 'LEGACY',
    changed_at DATETIME(3) NOT NULL,
    PRIMARY KEY(history_id), KEY idx_product_quantity_history(product_id,changed_at),
    CONSTRAINT fk_product_quantity_history FOREIGN KEY(product_id) REFERENCES product(product_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  const historyColumns = await query("SHOW COLUMNS FROM product_quantity_history");
  const knownColumns = new Set(historyColumns.map(column => column.Field || column.field));
  for (const [name, definition] of [
    ["work_quantity", "INT NULL"],
    ["target_quantity", "INT NULL"],
    ["previous_product_status", "VARCHAR(20) NULL"], ["product_status", "VARCHAR(20) NULL"],
    ["change_reason", "VARCHAR(500) NOT NULL DEFAULT ''"], ["changed_by_user_id", "INT NULL"],
    ["changed_by_username", "VARCHAR(150) NULL"], ["change_type", "VARCHAR(30) NOT NULL DEFAULT 'LEGACY'"]
  ]) if (!knownColumns.has(name)) await query(`ALTER TABLE product_quantity_history ADD COLUMN ${name} ${definition}`);
  const triggers = await query("SELECT TRIGGER_NAME AS name,ACTION_STATEMENT AS definition FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='product'");
  const deviceUsername = "CASE WHEN LEFT(NEW.quantity_actor,7)='DEVICE:' THEN SUBSTRING(NEW.quantity_actor,8) ELSE NEW.quantity_actor END";
  const changedByUsername = `CASE WHEN NEW.quantity_change_type='DEVICE' THEN ${deviceUsername} ELSE COALESCE(NULLIF(NEW.quantity_actor,''),(SELECT login_id FROM user_profile WHERE user_id=NEW.updated_by LIMIT 1)) END`;
  for (const [name, event, condition] of [
    ["product_quantity_insert", "INSERT", "TRUE"],
    ["product_quantity_update", "UPDATE", "NOT (NEW.quantity <=> OLD.quantity) OR NOT (NEW.work_quantity <=> OLD.work_quantity) OR NOT (NEW.target_quantity <=> OLD.target_quantity) OR NOT (NEW.product_status <=> OLD.product_status)"]
  ]) {
    const existing = triggers.find(trigger => trigger.name === name);
    const statusHistoryReady = name === "product_quantity_insert"
      ? /NULL,NEW\.product_status/.test(existing?.definition || "")
      : /OLD\.product_status,NEW\.product_status/.test(existing?.definition || "");
    if (existing && /NEW.work_quantity/.test(existing.definition) && /NEW.target_quantity/.test(existing.definition) && statusHistoryReady && /previous_product_status,product_status/.test(existing.definition) && /changed_by_username/.test(existing.definition) && /WHEN\s+NEW\.quantity_change_type\s*=\s*'DEVICE'\s+THEN\s*''/i.test(existing.definition) && /LEFT\(NEW\.quantity_actor,7\)='DEVICE:'\s+THEN\s+SUBSTRING\(NEW\.quantity_actor,8\)/.test(existing.definition) && !/\bprevious_(?:quantity|work_quantity|target_quantity)\b/.test(existing.definition)) continue;
    if (existing) await query(`DROP TRIGGER ${name}`);
    await query(`CREATE TRIGGER ${name} AFTER ${event} ON product FOR EACH ROW
      BEGIN IF ${condition} THEN
        INSERT INTO product_quantity_history(product_id,quantity,work_quantity,target_quantity,previous_product_status,product_status,change_source,change_reason,changed_by_user_id,changed_by_username,change_type,changed_at)
        VALUES(NEW.product_id,NEW.quantity,NEW.work_quantity,NEW.target_quantity,${event === "INSERT" ? "NULL" : "OLD.product_status"},NEW.product_status,COALESCE(NULLIF(NEW.updated_by_label,''),NULLIF(NEW.quantity_actor,''),CAST(NEW.updated_by AS CHAR),'BASELINE'),CASE WHEN NEW.quantity_change_type='DEVICE' THEN '' ELSE COALESCE(NULLIF(NEW.quantity_reason,''),'기준 수량 등록') END,NEW.updated_by,${changedByUsername},NEW.quantity_change_type,UTC_TIMESTAMP(3)+INTERVAL 9 HOUR);
      END IF; END`);
  }
  for (const column of ["previous_quantity", "previous_work_quantity", "previous_target_quantity"]) {
    if (knownColumns.has(column)) await query(`ALTER TABLE product_quantity_history DROP COLUMN ${column}`);
  }
  await query(`INSERT INTO product_quantity_history(product_id,quantity,work_quantity,target_quantity,previous_product_status,product_status,change_source,change_reason,change_type,changed_at)
    SELECT p.product_id,p.quantity,p.work_quantity,p.target_quantity,NULL,p.product_status,'BASELINE','이력 수집 시작','BASELINE',UTC_TIMESTAMP(3)+INTERVAL 9 HOUR FROM product p
    WHERE NOT EXISTS (SELECT 1 FROM product_quantity_history h WHERE h.product_id=p.product_id)`);
}

async function createProductWorkbook(report) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const workBasis = report.basis === "work";
  const summary = workbook.addWorksheet("제품 요약");
  summary.addRow(["시작 (KST)", reportSqlTime(report.start)]);
  summary.addRow(["종료 (KST)", reportSqlTime(report.end)]);
  summary.addRow(["제품코드", "제품명", `초기 ${workBasis ? "작업" : "누적"} 수량`, `종료 ${workBasis ? "작업" : "누적"} 수량`, `${workBasis ? "작업" : "누적"} 증가 수량`, `${workBasis ? "작업" : "누적"} 증가분(양수 합계)`, "초기 이력 확인"]);
  for (const product of report.products) summary.addRow([product.productCode, product.productName, product.initialQuantity, product.endQuantity, product.increaseQuantity, product.workQuantity, product.initialQuantityAssumed ? "첫 기록 수량 적용" : product.complete ? "완료" : "확인 불가"]);
  for (const [unit, title] of [["minutely", "분별 작업 수량"], ["hourly", "시간별 작업 수량"], ["daily", "일별 작업 수량"], ["weekly", "주간별 작업 수량"], ["monthly", "월별 작업 수량"]]) {
    if (unit === "minutely" && !report.products.some(product => product.buckets.minutely)) continue;
    const sheet = workbook.addWorksheet(title);
    sheet.addRow(["제품코드", "제품명", "구간 시작 (KST)", "구간 종료 (KST)", "작업 수량", "구간 이력 확인"]);
    for (const product of report.products) for (const bucket of product.buckets[unit]) sheet.addRow([product.productCode, product.productName, reportSqlTime(bucket.start), reportSqlTime(bucket.end), bucket.quantity, bucket.complete ? "완료" : bucket.quantity === null ? "확인 불가" : "수집 이후 기록 합계"]);
  }
  const history = workbook.addWorksheet("수량 변경 이력");
  history.addRow(["제품코드", "수정 일시 (KST)", `${workBasis ? "작업" : "누적"} 수량`, `${workBasis ? "작업" : "누적"} 변경량`, `${workBasis ? "누적" : "작업"} 수량`, "목표 수량", "수정 사유", "수정 사용자 ID", "수정 사용자", "변경 구분", "변경 출처"]);
  for (const product of report.products) for (const change of product.changes) history.addRow([product.productCode, reportSqlTime(change.at), change.analysisQuantity, change.analysisDelta, workBasis ? change.quantity : change.workQuantity, change.targetQuantity, change.reason, change.userId, change.username, change.changeType, change.source]);
  const statusHistory = workbook.addWorksheet("제품 상태 변경 이력");
  statusHistory.addRow(["제품코드", "제품명", "변경 일시 (KST)", "변경 전 상태", "변경 후 상태", "변경 종류", "변경 사유", "수정 사용자", "변경 출처"]);
  for (const product of report.products) for (const change of product.changes) {
    if (!change.previousStatus || !change.productStatus || change.previousStatus === change.productStatus) continue;
    statusHistory.addRow([product.productCode, product.productName, reportSqlTime(change.at), change.previousStatus, change.productStatus, change.changeType, change.reason, change.username, change.source]);
  }
  for (const sheet of workbook.worksheets) {
    sheet.columns.forEach(column => { column.width = 28; });
    const header = sheet === summary ? 3 : 1;
    sheet.getRow(header).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(header).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF087A67" } };
    sheet.views = [{ state: "frozen", ySplit: header }];
  }
  return workbook.xlsx.writeBuffer();
}

module.exports = { bucketStart, buildProductReport, loadProductReport, ensureProductHistory, createProductWorkbook };