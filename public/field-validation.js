(() => {
  let nextBubbleId = 0;

  function clearField(field) {
    if (!field) return;
    const bubble = field.nextElementSibling;
    if (bubble?.classList.contains("field-validation-bubble")) bubble.remove();
    field.classList.remove("field-validation-invalid");
    field.removeAttribute("aria-invalid");
    const describedBy = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const remaining = describedBy.filter(id => id !== field.dataset.validationBubbleId);
    if (remaining.length) field.setAttribute("aria-describedby", remaining.join(" "));
    else field.removeAttribute("aria-describedby");
    delete field.dataset.validationBubbleId;
  }

  function clearAllFields() {
    document.querySelectorAll(".field-validation-invalid").forEach(clearField);
  }

  window.clearFieldValidation = clearAllFields;
  window.showFieldValidation = (fieldOrId, message) => {
    const field = typeof fieldOrId === "string" ? document.getElementById(fieldOrId) : fieldOrId;
    if (!field) return false;
    clearAllFields();
    field.classList.add("field-validation-invalid");
    field.setAttribute("aria-invalid", "true");
    const bubble = document.createElement("span");
    const bubbleId = `field-validation-${++nextBubbleId}`;
    bubble.id = bubbleId;
    bubble.className = "field-validation-bubble";
    bubble.setAttribute("role", "alert");
    bubble.textContent = String(message || "입력 내용을 확인하세요.");
    field.insertAdjacentElement("afterend", bubble);
    field.dataset.validationBubbleId = bubbleId;
    const describedBy = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    field.setAttribute("aria-describedby", [...describedBy, bubbleId].join(" "));
    field.focus({ preventScroll: true });
    field.scrollIntoView?.({ behavior: "smooth", block: "center" });
    return true;
  };

  for (const eventName of ["input", "change"]) {
    document.addEventListener(eventName, event => {
      if (event.target?.classList.contains("field-validation-invalid")) clearField(event.target);
    }, true);
  }
})();
