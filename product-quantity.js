function parseQuantity(value) {
  if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 0 && quantity <= 2147483647 ? quantity : null;
}

function parseQuantityReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length > 0 && reason.length <= 500 ? reason : null;
}

function validateQuantityEdit(body) {
  const kind = body.kind === undefined ? "cumulative" : body.kind;
  const columns = { cumulative: "quantity", work: "work_quantity", target: "target_quantity" };
  if (!Object.hasOwn(columns, kind)) return { error: "수정할 수량 종류가 올바르지 않습니다." };
  const quantity = parseQuantity(body.quantity);
  if (quantity === null) return { error: "수량은 0~2,147,483,647 사이의 정수로 입력하세요." };
  const reason = parseQuantityReason(body.reason);
  if (!reason) return { error: "수정 사유를 1~500자로 입력하세요." };
  return { kind, column: columns[kind], quantity, reason };
}

async function ensureProductQuantityColumns(query) {
  const columns = await query("SHOW COLUMNS FROM product");
  const existing = new Set(columns.map(column => column.Field || column.field));
  for (const [name, definition] of [
    ["work_quantity", "INT NOT NULL DEFAULT 0"],
    ["quantity_reason", "VARCHAR(500) NOT NULL DEFAULT ''"],
    ["quantity_actor", "VARCHAR(150) NOT NULL DEFAULT ''"],
    ["quantity_change_type", "VARCHAR(30) NOT NULL DEFAULT 'LEGACY'"]
  ]) {
    if (!existing.has(name)) await query(`ALTER TABLE product ADD COLUMN ${name} ${definition}`);
  }
  if (!existing.has("work_quantity")) await query("UPDATE product SET work_quantity=quantity,updated_at=updated_at");
}

module.exports = { parseQuantity, parseQuantityReason, validateQuantityEdit, ensureProductQuantityColumns };