
        // 로그인 결과의 이동 경로를 따릅니다. 승인 전·정지 계정의 제한은 서버의 최신 회원 상태가 기준입니다.
        const loginForm = document.getElementById('loginForm');
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        function clearLoginFields() { loginForm.reset(); usernameInput.value = ''; passwordInput.value = ''; }
        if (new URLSearchParams(location.search).get('logged_out') === '1') clearLoginFields();
        window.addEventListener('pageshow', () => { if (new URLSearchParams(location.search).get('logged_out') === '1') clearLoginFields(); });
        loginForm.addEventListener('submit', async e => { e.preventDefault(); const m = document.getElementById('message'); m.textContent = '로그인 중...'; try { const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }) }); const data = await res.json(); if (!res.ok) { m.textContent = data.error || '로그인에 실패했습니다.'; m.className = 'auth-message error'; return; } location.href = data.redirect || '/'; } catch (err) { m.textContent = '서버와 통신할 수 없습니다.'; m.className = 'auth-message error'; } });
    