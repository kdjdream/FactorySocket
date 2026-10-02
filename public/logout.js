async function logout() {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) throw new Error("로그아웃 실패");
    location.href = "/login.html?logged_out=1";
  } catch (error) {
    alert("로그아웃하지 못했습니다. 다시 시도해 주세요.");
  }
}