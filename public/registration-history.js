function registrationHistoryEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const registrationHistoryRequests = new WeakMap();
window.loadRegistrationHistory = async (container, url) => {
  const request = Symbol();
  registrationHistoryRequests.set(container, request);
  container.textContent = "신청 이력을 불러오는 중...";
  try {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (registrationHistoryRequests.get(container) !== request) return false;
    if (!response.ok) throw new Error(data.error || "신청 이력을 불러오지 못했습니다.");
    const labels = { APPLICATION: "가입 신청", REAPPLICATION: "재신청", APPROVAL: "승인", REJECTION: "반려", SUSPENSION: "정지", STATUS: "상태 변경", LEVEL_CHANGE_REQUEST: "등급변경 요청", ORGANIZATION_CHANGE_REQUEST: "조직 변경 요청", WITHDRAWAL_REQUEST: "탈퇴 신청", WITHDRAWAL_REJECTION: "탈퇴 반려", WITHDRAWAL_APPROVAL: "탈퇴 승인", DELETION: "회원 삭제" };
    const organization = data.organization;
    const summary = organization ? `<p class="registration-organization-summary">${registrationHistoryEscape([organization.group_name, organization.company, organization.region, organization.department, organization.position].join(" · "))}<br>${registrationHistoryEscape(Object.values(organization.codes).join(" / "))}</p>` : "";
    container.innerHTML = summary + (data.comments.length ? `<ol class="registration-comment-list">${data.comments.map(row => `<li><div><strong>${registrationHistoryEscape((row.request_comment_id && ["APPROVAL", "REJECTION"].includes(row.event_type) ? "요청 " : "") + (labels[row.event_type] || row.event_type))}</strong><time>${registrationHistoryEscape(row.created_at)}</time></div><p>${registrationHistoryEscape(row.comment || "(코멘트 없음)")}</p><small>작성자 ${registrationHistoryEscape(row.actor_login_id)} · 신청자 ${registrationHistoryEscape(row.login_id)}</small></li>`).join("")}</ol>` : '<p class="help-text">기록된 신청 이력이 없습니다.</p>');
    return true;
  } catch (error) { if (registrationHistoryRequests.get(container) === request) container.textContent = error.message; return false; }
};

const registrationSelfHistory = document.getElementById("registrationSelfHistory");
if (registrationSelfHistory) void window.loadRegistrationHistory(registrationSelfHistory, "/api/me/register-comments");