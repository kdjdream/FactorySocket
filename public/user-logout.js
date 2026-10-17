// 로그아웃 요청이 실패해도 로그인 화면으로 이동합니다. 세션 제거 처리는 서버가 담당합니다.
async function logout() {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) throw new Error("로그아웃 실패");
    location.href = "/user-login.html?logged_out=1";
  } catch (error) {
    alert("로그아웃하지 못했습니다. 다시 시도해 주세요.");
  }
}