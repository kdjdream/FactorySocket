const form = document.getElementById("registerForm");
const message = document.getElementById("message");
const registrationFields = ["group", "company", "site", "department", "role"];
const registrationCodeInputs = ["organizationGroup", "organizationCompany", "organizationSite", "organizationDepartment", "organizationRole"].map(id => document.getElementById(id));
const organizationUnknown = document.getElementById("organizationUnknown");
const organizationCheck = document.getElementById("organizationCheck");
const organizationMessage = document.getElementById("organizationMessage");
const registerSubmit = document.getElementById("registerSubmit");
let matchedOrganization = null;
let organizationRevision = 0;
let organizationChecking = false;
let registrationSubmitting = false;

function updateRegistrationControls() {
        registerSubmit.disabled = registrationSubmitting || (organizationChecking && !organizationUnknown.checked);
        organizationCheck.disabled = organizationChecking || registrationSubmitting;
        organizationUnknown.disabled = registrationSubmitting;
        for (const input of registrationCodeInputs) {
                input.disabled = organizationUnknown.checked || registrationSubmitting;
                input.required = input === registrationCodeInputs[0] && !organizationUnknown.checked;
        }
}

function invalidRegistrationCodeInput() {
        return registrationCodeInputs.find((input, index) => {
                const value = input.value.trim().normalize("NFC");
                return (index === 0 || value !== "") && !/^[\p{L}\p{N}]{3}$/u.test(value);
        });
}

function registrationOrganizationBody() {
        return { organizationUnknown: organizationUnknown.checked, organization: Object.fromEntries(registrationFields.map((field, index) => [field, registrationCodeInputs[index].value.trim() || null])) };
}

function clearRegistrationOrganization() {
        organizationRevision++;
        matchedOrganization = null;
        clearFieldValidation();
        const details = document.getElementById("organizationDetails");
        details.textContent = "";
        details.hidden = true;
        organizationMessage.textContent = "";
        updateRegistrationControls();
}

async function checkRegistrationOrganization() {
        const revision = ++organizationRevision;
        if (!organizationUnknown.checked && invalidRegistrationCodeInput()) {
                organizationMessage.textContent = "그룹 코드는 필수이며, 입력한 조직 코드는 문자 또는 숫자 3자리여야 합니다.";
                return;
        }
        matchedOrganization = null;
        organizationChecking = true;
        organizationMessage.textContent = "조직 확인 중...";
        updateRegistrationControls();
        try {
                const response = await fetch("/api/register/organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registrationOrganizationBody()) });
                const data = await response.json();
                if (revision !== organizationRevision) return;
                if (!response.ok) throw new Error(data.error || "조직을 확인하지 못했습니다.");
                matchedOrganization = data.organization;
                registrationFields.forEach((field, index) => { registrationCodeInputs[index].value = matchedOrganization.codes[field] ?? ""; });
                const organizationLabels = [
                        ["그룹", matchedOrganization.group_name],
                        ["회사", matchedOrganization.company],
                        ["사업장", matchedOrganization.region],
                        ["부서", matchedOrganization.department],
                        ["직무", matchedOrganization.position]
                ];
                const details = document.getElementById("organizationDetails");
                details.textContent = organizationLabels.map(([label, value]) => `${label}: ${value || "-"}`).join("\n");
                details.hidden = false;
                organizationMessage.textContent = organizationUnknown.checked ? "일반 개인 사용자(Default)로 신청합니다." : "조직이 확인되었습니다.";
        } catch (error) {
                if (revision === organizationRevision) organizationMessage.textContent = error.message;
        } finally {
                organizationChecking = false;
                updateRegistrationControls();
        }
}

organizationCheck.addEventListener("click", checkRegistrationOrganization);
organizationUnknown.addEventListener("change", () => {
        clearRegistrationOrganization();
        registrationCodeInputs.forEach((input, index) => { input.value = organizationUnknown.checked && index < 3 ? "001" : ""; });
        updateRegistrationControls();
        if (organizationUnknown.checked) void checkRegistrationOrganization();
});
for (const input of registrationCodeInputs) input.addEventListener("input", () => {
        input.value = input.value.normalize("NFC").toUpperCase();
        clearRegistrationOrganization();
});

form.addEventListener("submit", async event => {
        event.preventDefault();
        if (registrationSubmitting) return;
        const fieldLabels = { username: "아이디", password: "비밀번호", passwordConfirm: "비밀번호 확인", phone: "전화번호", address: "주소", email: "이메일", registerComment: "가입 신청 이유", organizationGroup: "그룹 코드", organizationCompany: "회사 코드", organizationSite: "사업장 코드", organizationDepartment: "부서 코드", organizationRole: "직무 코드" };
        const invalidFields = ["username", "password", "passwordConfirm", "phone", "address", "email", "registerComment"]
                .map(id => document.getElementById(id)).filter(field => !field.disabled);
        const invalidField = invalidFields.find(field => field.validity && !field.validity.valid);
        if (invalidField) {
                message.textContent = `${fieldLabels[invalidField.id] || "입력값"}: ${invalidField.validationMessage}`;
                message.className = "auth-message error";
                showFieldValidation(invalidField, invalidField.validationMessage);
                invalidField.focus();
                return;
        }
        if (document.getElementById("password").value !== document.getElementById("passwordConfirm").value) {
                const error = "비밀번호가 서로 다릅니다.";
                message.textContent = error; message.className = "auth-message error";
                showFieldValidation("passwordConfirm", error); return;
        }
        if (!document.getElementById("registerComment").value.trim()) {
                message.textContent = "가입 신청 이유를 입력하세요."; message.className = "auth-message error";
                showFieldValidation("registerComment", message.textContent); return;
        }
        if (!organizationUnknown.checked && (!matchedOrganization || organizationChecking)) {
                const error = "조직 정보 미확인에 체크하거나 입력한 조직 코드를 확인하세요.";
                const field = invalidRegistrationCodeInput() || registrationCodeInputs[0];
                field.disabled = false;
                message.textContent = error; message.className = "auth-message error";
                showFieldValidation(field, error); return;
        }
        const body = Object.fromEntries(["name", "username", "password", "passwordConfirm", "phone", "address", "email", "registerComment"].map(id => [id, document.getElementById(id).value]));
        Object.assign(body, registrationOrganizationBody());
        registrationSubmitting = true;
        message.textContent = "가입 신청 중..."; message.className = "auth-message";
        updateRegistrationControls();
        try {
                const response = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                const data = await response.json();
                if (!response.ok) { const error = new Error(data.error || "가입 신청에 실패했습니다."); error.field = data.field; throw error; }
                clearFieldValidation();
                const codes = data.organizationCodes;
                message.textContent = codes ? `${data.message} (부서 코드: ${codes.department}, 직무 코드: ${codes.role})` : data.message;
                message.className = "auth-message success";
                setTimeout(() => { location.href = "/user-login.html"; }, 6000);
        } catch (error) {
                message.textContent = error.message || "서버와 통신할 수 없습니다."; message.className = "auth-message error";
                const fieldIds = { username: "username", name: "name", phone: "phone", address: "address", email: "email", password: "password", passwordConfirm: "passwordConfirm", registerComment: "registerComment", organization: "organizationCheck" };
                if (error.field && fieldIds[error.field]) showFieldValidation(fieldIds[error.field], error.message);
                registrationSubmitting = false;
                updateRegistrationControls();
        }
});
void checkRegistrationOrganization();
