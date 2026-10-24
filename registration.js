const ORGANIZATION_CODES = ["group", "company", "site", "department", "role"];
const COMPANY_ORGANIZATION_CODES = ORGANIZATION_CODES;
const DEFAULT_ORGANIZATION_CODE = "DEF";

function parseOrganizationSelection(body = {}) {
  if (body.organizationUnknown !== undefined && typeof body.organizationUnknown !== "boolean") return { error: "조직 정보 확인 여부가 올바르지 않습니다." };
  const useDefault = body.organizationUnknown !== false;
  const supplied = body.organization;
  if (!useDefault && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) return { error: "그룹 코드를 입력하세요." };
  const codes = Object.fromEntries(COMPANY_ORGANIZATION_CODES.map(field => [field, null]));
  for (const field of COMPANY_ORGANIZATION_CODES) {
    const rawValue = useDefault
      ? (field === "group" || field === "company" || field === "site" ? "001" : null)
      : supplied[field];
    if (field !== "group" && (rawValue == null || (typeof rawValue === "string" && !rawValue.trim()))) {
      codes[field] = null;
      continue;
    }
    const value = typeof rawValue === "string" ? rawValue.trim().normalize("NFC").toUpperCase() : "";
    if (!/^[\p{L}\p{N}]{3}$/u.test(value)) return { error: "각 조직 코드는 문자 또는 숫자 3자리로 입력하세요." };
    codes[field] = value;
  }
  return { codes, useDefault };
}

function validateOrganizationRecord(body = {}) {
  const codes = {};
  const names = {};
  for (const [index, field] of COMPANY_ORGANIZATION_CODES.entries()) {
    const suppliedCode = typeof body.codes?.[field] === "string" ? body.codes[field].trim().normalize("NFC").toUpperCase() : "";
    const name = `${field}_name`;
    const suppliedName = typeof body.names?.[name] === "string" ? body.names[name].trim() : "";
    const maximum = field === "company" ? 150 : 100;
    if (index === 0 && (!suppliedCode || !suppliedName)) return { error: "그룹 코드와 그룹 이름은 필수입니다." };
    if (!suppliedCode && !suppliedName) {
      codes[field] = null;
      names[name] = null;
      continue;
    }
    if (!/^[\p{L}\p{N}]{3}$/u.test(suppliedCode)) return { error: `${field} 코드는 문자 또는 숫자 3자리로 입력하세요.` };
    if (suppliedName === "미지정" && suppliedCode !== DEFAULT_ORGANIZATION_CODE) return { error: `${field} 코드가 지정된 경우 명칭을 미지정으로 등록할 수 없습니다.` };
    if (!suppliedName || suppliedName.length > maximum) return { error: `${field} 이름은 1~${maximum}자로 입력하세요.` };
    codes[field] = suppliedCode;
    names[name] = suppliedName;
  }
  if (COMPANY_ORGANIZATION_CODES.slice(0, 3).every(field => codes[field] === DEFAULT_ORGANIZATION_CODE)) return { error: "DEF 기본 조직은 신규 등록하거나 변경할 수 없습니다." };
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") return { error: "조직 사용 여부가 올바르지 않습니다." };
  return { codes, names, is_active: body.is_active !== false };
}

function validateOrganizationNameHierarchy(record, organizations = []) {
  const labels = { group: "그룹", company: "회사", site: "사업장", department: "부서", role: "직무" };
  for (const [index, field] of COMPANY_ORGANIZATION_CODES.entries()) {
    const code = record.codes[field];
    const name = record.names[`${field}_name`];
    if (index > 0 && code === null && name === null) continue;
    const parentCodes = ORGANIZATION_CODES.slice(0, index);
    const siblings = organizations.filter(row => parentCodes.every(parent => row[parent] === record.codes[parent]));
    const sameCodeNames = siblings.filter(row => row[field] === code).map(row => row[`${field}_name`] || row[field]);
    if (sameCodeNames.some(existingName => existingName !== name)) return { error: `${labels[field]} 코드 ${code}는 이미 다른 명칭으로 등록되어 있습니다.` };
    if (siblings.some(row => row[field] !== code && (row[`${field}_name`] || row[field]) === name)) return { error: `${labels[field]} 명칭은 같은 상위 조직의 다른 코드에서 이미 사용 중입니다.` };
  }
  return {};
}

function validateRegisterComment(value, required = false, label = "반려 사유") {
  if (value != null && typeof value !== "string") return { error: "신청·반려 사유는 문자열로 입력하세요." };
  const comment = String(value ?? "").trim();
  if (comment.length > 2000) return { error: "신청·반려 사유는 2000자 이내로 입력하세요." };
  if (required && !comment) return { error: `${label}를 입력하세요.` };
  return { comment };
}

function organizationProfile(row) {
  return {
    organization_id: Number(row.organization_id),
    codes: Object.fromEntries(ORGANIZATION_CODES.map(field => [field, row[field]])),
    group_name: row.group_name || row.group,
    company: row.company_name || row.company,
    region: row.site_name || row.site,
    department: row.department_name || row.department,
    position: row.role_name || row.role
  };
}

module.exports = { ORGANIZATION_CODES, COMPANY_ORGANIZATION_CODES, DEFAULT_ORGANIZATION_CODE, parseOrganizationSelection, validateOrganizationRecord, validateOrganizationNameHierarchy, validateRegisterComment, organizationProfile };