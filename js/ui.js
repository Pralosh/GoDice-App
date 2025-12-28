// js/ui.js
// Small, generic DOM helpers. Keep this file UI-only (no session rules, no BLE, no DB).

export function showEl(el, display = "flex") {
  if (!el) return;
  el.style.display = display;
}

export function hideEl(el) {
  if (!el) return;
  el.style.display = "none";
}

export function setText(el, text) {
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

export function setHtml(el, html) {
  if (!el) return;
  el.innerHTML = html == null ? "" : String(html);
}

export function setValue(el, value) {
  if (!el) return;
  el.value = value == null ? "" : String(value);
}

export function focusSoon(el, delayMs = 10) {
  if (!el) return;
  setTimeout(() => el.focus(), delayMs);
}

/**
 * Backdrop click-to-dismiss:
 * Calls onClose() only when clicking the backdrop itself (not modal content).
 */
export function bindBackdropDismiss(backdropEl, onClose) {
  if (!backdropEl || typeof onClose !== "function") return;
  backdropEl.addEventListener("click", (e) => {
    if (e.target === backdropEl) onClose();
  });
}

// Export Password Modal (UI-only controller)
export function createPasswordModal({
  backdropEl,
  inputEl,
  errorEl,
  showBtn,
  submitBtn,
  cancelBtn,
  display = "flex",
}) {
  let visible = false;

  function setVisible(next) {
    visible = !!next;
    if (inputEl) inputEl.type = visible ? "text" : "password";
    if (showBtn) showBtn.textContent = visible ? "Hide" : "Show";
  }

  function open() {
    setText(errorEl, "");
    if (inputEl) inputEl.value = "";
    setVisible(false);
    showEl(backdropEl, display);
    focusSoon(inputEl, 10);
  }

  function close() {
    hideEl(backdropEl);
  }

  function getValue() {
    return inputEl ? inputEl.value : "";
  }

  function setError(msg) {
    setText(errorEl, msg);
  }

  function bind({ onSubmit, onCancel }) {
    if (showBtn) {
      showBtn.addEventListener("click", () => setVisible(!visible));
    }

    if (submitBtn && typeof onSubmit === "function") {
      submitBtn.addEventListener("click", onSubmit);
    }

    if (cancelBtn && typeof onCancel === "function") {
      cancelBtn.addEventListener("click", onCancel);
    }

    if (backdropEl && typeof onCancel === "function") {
      bindBackdropDismiss(backdropEl, onCancel);
    }

    // Enter key submits
    if (inputEl && typeof onSubmit === "function") {
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      });
    }
  }

  return { open, close, getValue, setError, bind };
}

// Reward Modal (UI-only controller)
export function createRewardModal({
  backdropEl,
  sumEl,
  textEl,
  rollsEl,
  closeBtn,
  display = "flex",
}) {
  function open(sum, rewardText, firstRoll, secondRoll) {
    setText(sumEl, sum);
    setText(textEl, rewardText);

    if (firstRoll && secondRoll) {
      const r1Label = firstRoll.dieLabel || "";
      const r2Label = secondRoll.dieLabel || "";
      setHtml(
        rollsEl,
        `<div>Roll 1 - Die ${r1Label}: face ${firstRoll.face}</div>
         <div>Roll 2 - Die ${r2Label}: face ${secondRoll.face}</div>`
      );
    } else {
      setText(rollsEl, "");
    }

    showEl(backdropEl, display);
  }

  function close() {
    hideEl(backdropEl);
  }

  function bind() {
    if (closeBtn) closeBtn.addEventListener("click", close);
    bindBackdropDismiss(backdropEl, close);
  }

  return { open, close, bind };
}

// History Modal (UI-only controller)
export function createHistoryModal({ backdropEl, closeBtn, display = "flex" }) {
  function open() {
    showEl(backdropEl, display);
  }

  function close() {
    hideEl(backdropEl);
  }

  function bind() {
    if (closeBtn) closeBtn.addEventListener("click", close);
    bindBackdropDismiss(backdropEl, close);
  }

  return { open, close, bind };
}
