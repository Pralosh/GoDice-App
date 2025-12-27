import { INACTIVITY_MS, EXPORT_PASSWORD, MANAGERS } from "./config.js";
import {
  dbSaveSessionStart,
  dbSaveSessionEnd,
  dbSaveRoll,
  dbGetAllSessions,
  dbGetRollsForSession,
  dbCountRollsForSession,
  dbCloseAbandonedSessions,
} from "./db.js";
import { createSessionController } from "./state.js";
import { exportAllSessionsCSV, exportSelectedSessionCSV } from "./export.js";

/**********************************
 * SESSION STATE (in memory only)
 **********************************/

// Auto-retry for one-roll situations
const RETRY_ROUND_TIMEOUT_MS = 1000; // 1 second, adjust if needed
let retryModalOpen = false;

// Currently selected session in the History modal (for CSV export)
let currentHistorySessionMeta = null;

// --- Export protection (simple front-end password gate) ---
let exportUnlocked = false;
let exportPasswordResolve = null;
let exportPasswordVisible = false;

function openExportPasswordModal() {
  exportPasswordError.textContent = "";
  exportPasswordInput.value = "";
  exportPasswordInput.type = "password";
  exportPasswordVisible = false;
  exportPasswordShowBtn.textContent = "Show";

  exportPasswordBackdrop.style.display = "flex";
  setTimeout(() => exportPasswordInput.focus(), 10);
}

function closeExportPasswordModal() {
  exportPasswordBackdrop.style.display = "none";
  // If we close without explicitly resolving, treat as "cancel"
  if (exportPasswordResolve) {
    exportPasswordResolve(false);
    exportPasswordResolve = null;
  }
}

function handleExportPasswordSubmit() {
  const value = exportPasswordInput.value;
  if (!value) {
    exportPasswordError.textContent = "Please enter a password.";
    return;
  }

  if (value === EXPORT_PASSWORD) {
    exportUnlocked = true;
    exportPasswordBackdrop.style.display = "none";
    if (exportPasswordResolve) {
      exportPasswordResolve(true);
      exportPasswordResolve = null;
    }
  } else {
    exportPasswordError.textContent = "Incorrect password.";
  }
}

function handleExportPasswordCancel() {
  exportPasswordBackdrop.style.display = "none";
  if (exportPasswordResolve) {
    exportPasswordResolve(false);
    exportPasswordResolve = null;
  }
}

/**
 * Returns a Promise<boolean>:
 *  - true if password ok (or already unlocked)
 *  - false if cancelled / incorrect
 */
function requireExportPassword() {
  if (exportUnlocked) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    exportPasswordResolve = resolve;
    openExportPasswordModal();
  });
}

function getRewardForSum(sum) {
  return (
    REWARDS_BY_SUM[sum] ||
    "No configured reward for this total. Please check game rules."
  );
}

/**********************************
 * DOM ELEMENTS
 **********************************/
const startOverlay = document.getElementById("startOverlay");
const tableInput = document.getElementById("tableInput");
const checkInput = document.getElementById("checkInput");
const managerSelect = document.getElementById("managerSelect");
const startSessionBtn = document.getElementById("startSessionBtn");
const overlayError = document.getElementById("overlayError");

const guidelinesBackdrop = document.getElementById("guidelinesBackdrop");
const guidelinesBtn = document.getElementById("guidelinesBtn");
const guidelinesTopBtn = document.getElementById("guidelinesTopBtn");
const closeGuidelinesBtn = document.getElementById("closeGuidelinesBtn");

const overlayHistoryBtn = document.getElementById("overlayHistoryBtn");

const sessionInfo = document.getElementById("sessionInfo");
const endSessionBtn = document.getElementById("endSessionBtn");
const connectBtn = document.getElementById("connectBtn");
const diceList = document.getElementById("diceList");
const diceFaces = document.getElementById("diceFaces");

const historyBackdrop = document.getElementById("historyBackdrop");
const historyBtn = document.getElementById("historyBtn");
const closeHistoryBtn = document.getElementById("closeHistoryBtn");
const historyListEl = document.getElementById("historyList");
const historyDetailsEl = document.getElementById("historyDetails");

const exportAllBtn = document.getElementById("exportAllBtn");
const exportSessionBtn = document.getElementById("exportSessionBtn");

const rewardBackdrop = document.getElementById("rewardBackdrop");
const rewardSumEl = document.getElementById("rewardSum");
const rewardTextEl = document.getElementById("rewardText");
const rewardRollsEl = document.getElementById("rewardRolls");
const rewardCloseBtn = document.getElementById("rewardCloseBtn");

const retryBackdrop = document.getElementById("retryBackdrop");
const retryConfirmBtn = document.getElementById("retryConfirmBtn");
const retryCancelBtn = document.getElementById("retryCancelBtn");

const exportPasswordBackdrop = document.getElementById(
  "exportPasswordBackdrop"
);
const exportPasswordInput = document.getElementById("exportPasswordInput");
const exportPasswordError = document.getElementById("exportPasswordError");
const exportPasswordShowBtn = document.getElementById("exportPasswordShowBtn");
const exportPasswordSubmitBtn = document.getElementById(
  "exportPasswordSubmitBtn"
);
const exportPasswordCancelBtn = document.getElementById(
  "exportPasswordCancelBtn"
);

const session = createSessionController({
  managers: MANAGERS,
  db: { dbSaveSessionStart, dbSaveSessionEnd, dbSaveRoll },
  getRewardForSum,
  isRetryModalOpen: () => retryModalOpen,
  onRetryNeeded: () => openRetryModal(),
  onReward: ({ sum, rewardText, firstRoll, secondRoll }) => {
    openRewardModal(sum, rewardText, firstRoll, secondRoll);
    // Preserve your current behavior: auto-end immediately after reward modal shows.
    endSession("reward");
  },
  retryRoundTimeoutMs: RETRY_ROUND_TIMEOUT_MS,
});

function updateConnectButtonLabel() {
  if (!diceList) return;

  if (diceList.children.length === 0) {
    connectBtn.textContent = "Connect Die";
  } else {
    connectBtn.textContent = "Connect Another Die";
  }
}

/**********************************
 * INDEXEDDB HELPERS (local storage)
 **********************************/
// Split an ISO timestamp into separate date & time strings in New York time.
function formatDateTimeParts(isoString) {
  if (!isoString) {
    return { date: "", time: "" };
  }
  const d = new Date(isoString);

  const date = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/New_York",
  });

  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });

  return { date, time };
}

/**********************************
 * HISTORY VIEW LOGIC
 **********************************/
async function renderHistoryList(sessions) {
  historyListEl.innerHTML = "";
  historyDetailsEl.innerHTML =
    '<p style="font-size:13px; color:#9ca3af;">Select a session to view its rolls.</p>';

  currentHistorySessionMeta = null;
  exportSessionBtn.disabled = true;

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.sessionId = s.id;

    const started = s.startedAtDisplay || s.startedAt || "";

    const rollsCount = await dbCountRollsForSession(s.id);
    const endedReason = s.endedReason || "ended";
    const rewardSum = s.rewardSum;
    const rewardText = s.rewardText;
    const invalidCount = Array.isArray(s.invalidEvents)
      ? s.invalidEvents.length
      : 0;

    // Build a human-friendly outcome label
    let outcome = "Ended (no reward)";

    const sessionStatus = deriveSessionStatus(s);

    if (sessionStatus === "Won" || sessionStatus === "No Win") {
      const shortRewardText = rewardText || "Reward";
      outcome = `${sessionStatus} • Sum ${rewardSum} – ${shortRewardText}`;
    } else if (sessionStatus === "Canceled") {
      outcome = invalidCount > 0 ? "Canceled (invalid rolls)" : "Canceled";
    } else {
      // Ended
      if (endedReason === "abandoned_reload_no_rolls") {
        outcome = "Ended (Reload - No Rolls)";
      } else if (endedReason === "abandoned_reload_incomplete") {
        outcome = "Ended (Reload - Incomplete)";
      } else if (endedReason === "ended_no_rolls" || rollsCount === 0) {
        outcome = "Ended (No Rolls)";
      } else {
        outcome = "Ended (Incomplete)";
      }
    }

    // Add info about invalid events if any
    if (invalidCount > 0 && endedReason === "reward") {
      outcome += ` • ${invalidCount} invalid before reward`;
    } else if (invalidCount > 0 && endedReason !== "reward") {
      outcome += ` • ${invalidCount} invalid`;
    }

    row.innerHTML = `
            <span>${started}</span>
            <span>${s.tableNumber || ""}</span>
            <span>${s.checkNumber || ""}</span>
            <span>${s.managerName || ""}</span>
            <span>${rollsCount}</span>
            <span>${outcome}</span>
          `;

    row.addEventListener("click", async () => {
      document
        .querySelectorAll(".history-row.selected")
        .forEach((el) => el.classList.remove("selected"));
      row.classList.add("selected");
      await renderHistoryDetails(s.id, s);
    });

    historyListEl.appendChild(row);
  }

  if (!sessions.length) {
    historyDetailsEl.innerHTML =
      '<p style="font-size:13px; color:#9ca3af;">No sessions recorded yet.</p>';
  }
}

async function renderHistoryDetails(sessionId, sessionMeta) {
  try {
    const rolls = await dbGetRollsForSession(sessionId);
    const s = sessionMeta;

    currentHistorySessionMeta = s;
    exportSessionBtn.disabled = false;

    const started = s.startedAtDisplay || s.startedAt || "";
    const ended = s.endedAtDisplay || s.endedAt || "";

    const endedReason = s.endedReason || "ended";
    const rewardSum = s.rewardSum;
    const rewardText = s.rewardText;
    const rewardGranted = !!s.rewardGranted;
    const invalidEvents = Array.isArray(s.invalidEvents) ? s.invalidEvents : [];
    const invalidCount = invalidEvents.length;

    // Human-readable ended reason
    let endedLabel = "Ended";
    const sessionStatus = deriveSessionStatus(s);

    if (sessionStatus === "Won") endedLabel = "Won";
    else if (sessionStatus === "No Win") endedLabel = "No Win";
    else if (sessionStatus === "Canceled") endedLabel = "Canceled";
    else {
      if (endedReason === "abandoned_reload_no_rolls") {
        endedLabel = "Ended (Reload - No Rolls)";
      } else if (endedReason === "abandoned_reload_incomplete") {
        endedLabel = "Ended (Reload - Incomplete)";
      } else if (endedReason === "ended_no_rolls" || rolls.length === 0) {
        endedLabel = "Ended (No Rolls)";
      } else {
        endedLabel = "Ended (Incomplete)";
      }
    }

    // Reward summary
    let rewardSummary = "None";
    if (endedReason === "reward" && rewardGranted && rewardSum != null) {
      const shortRewardText = rewardText || "Reward granted";
      rewardSummary = `Sum ${rewardSum} – ${shortRewardText}`;
    }

    const headerHtml = `
            <h4>Session Details</h4>
            <p><strong>Table:</strong> ${s.tableNumber || ""}</p>
            <p><strong>Check:</strong> ${s.checkNumber || ""}</p>
            <p><strong>Manager:</strong> ${s.managerName || ""}</p>
            <p><strong>Started:</strong> ${started}</p>
            <p><strong>Ended:</strong> ${ended || "-"}</p>
            <p><strong>Rolls:</strong> ${rolls.length}</p>
            <p><strong>Ended as:</strong> ${endedLabel}</p>
            <p><strong>Reward:</strong> ${rewardSummary}</p>
            <p><strong>Invalid events:</strong> ${invalidCount}</p>
          `;

    if (!rolls.length) {
      historyDetailsEl.innerHTML =
        headerHtml +
        '<div class="rolls-list"><p>No rolls recorded for this session.</p></div>';
      return;
    }

    const rollsHtml = rolls
      .map((r) => {
        const ts = r.timestampDisplay || r.timestamp || "";
        return `
                <div class="roll-row">
                  <span>${ts}</span>
                  <span>Die ${r.dieLabel || ""}</span>
                  <span>Face ${r.face}</span>
                </div>
              `;
      })
      .join("");

    historyDetailsEl.innerHTML =
      headerHtml + `<div class="rolls-list">${rollsHtml}</div>`;
  } catch (e) {
    console.error("[HISTORY] load rolls failed:", e);
    historyDetailsEl.innerHTML =
      '<p style="font-size:13px; color:#fca5a5;">Failed to load rolls for this session.</p>';
  }
}

async function openHistory() {
  historyBackdrop.style.display = "flex";
  historyListEl.innerHTML =
    '<p style="font-size:13px; color:#9ca3af;">Loading…</p>';
  historyDetailsEl.innerHTML =
    '<p style="font-size:13px; color:#9ca3af;">Select a session to view its rolls.</p>';

  try {
    const sessions = await dbGetAllSessions();
    await renderHistoryList(sessions);
  } catch (e) {
    console.error("[HISTORY] load sessions failed:", e);
    historyListEl.innerHTML =
      '<p style="font-size:13px; color:#fca5a5;">Failed to load sessions.</p>';
  }
}

function closeHistory() {
  historyBackdrop.style.display = "none";

  // Reset export unlock when History is closed
  exportUnlocked = false;

  // If the password modal is open for some reason, cancel it too
  if (exportPasswordBackdrop.style.display === "flex") {
    handleExportPasswordCancel();
  }
}

function isNoWinRewardText(text) {
  if (!text) return false;
  return /no discount|better luck|no win|no prize/i.test(String(text));
}

function deriveSessionStatus(s) {
  const endedReason = s.endedReason || "manual";
  const rewardGranted = !!s.rewardGranted;

  if (endedReason === "reward" && rewardGranted) {
    return isNoWinRewardText(s.rewardText) ? "No Win" : "Won";
  }
  if (endedReason === "invalid_cancel") return "Canceled";
  return "Ended";
}

function deriveRewardColumn(s, rolls) {
  const endedReason = s.endedReason || "manual";
  const rewardGranted = !!s.rewardGranted;

  if (endedReason === "reward" && rewardGranted) {
    return s.rewardText || ""; // always show, even "No discount..."
  }

  if (endedReason === "invalid_cancel") return "N/A (Canceled)";

  if (endedReason === "abandoned_reload_no_rolls") {
    return "N/A (Ended - Reload - No Rolls)";
  }
  if (endedReason === "abandoned_reload_incomplete") {
    return "N/A (Ended - Reload - Incomplete)";
  }

  const rollsCount = Array.isArray(rolls) ? rolls.length : 0;
  if (endedReason === "ended_no_rolls" || rollsCount === 0) {
    return "N/A (Ended - No Rolls)";
  }

  return "N/A (Ended - Incomplete)";
}

async function handleExportAllSessions() {
  await exportAllSessionsCSV({
    filename: "godice_sessions.csv",
    requireExportPassword,
    dbGetAllSessions,
    dbGetRollsForSession,
    deriveSessionStatus,
    deriveRewardColumn,
    formatDateTimeParts,
  });
}

async function handleExportSelectedSession() {
  if (!currentHistorySessionMeta) return;

  await exportSelectedSessionCSV({
    filename: `godice_session_${currentHistorySessionMeta.id}.csv`,
    requireExportPassword,
    session: currentHistorySessionMeta,
    dbGetRollsForSession,
    deriveSessionStatus,
    deriveRewardColumn,
    formatDateTimeParts,
  });
}

function populateManagerDropdown() {
  MANAGERS.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    managerSelect.appendChild(opt);
  });
}

/**********************************
 * GUIDELINES MODAL LOGIC
 **********************************/
function openGuidelines() {
  guidelinesBackdrop.style.display = "flex";
}
function closeGuidelines() {
  guidelinesBackdrop.style.display = "none";
}
guidelinesBtn.addEventListener("click", openGuidelines);
guidelinesTopBtn.addEventListener("click", openGuidelines);
closeGuidelinesBtn.addEventListener("click", closeGuidelines);
guidelinesBackdrop.addEventListener("click", (e) => {
  if (e.target === guidelinesBackdrop) closeGuidelines();
});

/**********************************
 * HISTORY MODAL EVENTS
 **********************************/
overlayHistoryBtn.addEventListener("click", openHistory);
historyBtn.addEventListener("click", openHistory);
closeHistoryBtn.addEventListener("click", closeHistory);
historyBackdrop.addEventListener("click", (e) => {
  if (e.target === historyBackdrop) closeHistory();
});

exportAllBtn.addEventListener("click", handleExportAllSessions);
exportSessionBtn.addEventListener("click", handleExportSelectedSession);

/**********************************
 * REWARD MODAL LOGIC
 **********************************/
function openRewardModal(sum, rewardText, firstRoll, secondRoll) {
  rewardSumEl.textContent = sum;
  rewardTextEl.textContent = rewardText;

  if (firstRoll && secondRoll) {
    rewardRollsEl.innerHTML = `
            <div>Roll 1 - Die ${firstRoll.dieLabel || ""}: face ${
      firstRoll.face
    }</div>
            <div>Roll 2 - Die ${secondRoll.dieLabel || ""}: face ${
      secondRoll.face
    }</div>
          `;
  } else {
    rewardRollsEl.textContent = "";
  }

  rewardBackdrop.style.display = "flex";
}

// Close reward modal and automatically end the game
function closeRewardModal() {
  rewardBackdrop.style.display = "none";
}

rewardCloseBtn.addEventListener("click", closeRewardModal);
rewardBackdrop.addEventListener("click", (e) => {
  if (e.target === rewardBackdrop) {
    closeRewardModal();
  }
});

/**********************************
 * EXPORT PASSWORD MODAL EVENTS
 **********************************/
exportPasswordShowBtn.addEventListener("click", () => {
  exportPasswordVisible = !exportPasswordVisible;
  exportPasswordInput.type = exportPasswordVisible ? "text" : "password";
  exportPasswordShowBtn.textContent = exportPasswordVisible ? "Hide" : "Show";
});

exportPasswordSubmitBtn.addEventListener("click", handleExportPasswordSubmit);
exportPasswordCancelBtn.addEventListener("click", handleExportPasswordCancel);

exportPasswordBackdrop.addEventListener("click", (e) => {
  if (e.target === exportPasswordBackdrop) {
    handleExportPasswordCancel();
  }
});

// Allow Enter key to submit password
exportPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleExportPasswordSubmit();
  }
});

/**********************************
 * SESSION HELPERS
 **********************************/
function formatSessionInfo(session) {
  return `Table ${session.tableNumber} • Check ${session.checkNumber} • Manager ${session.managerName}`;
}

function startSession() {
  const table = tableInput.value.trim();
  const check = checkInput.value.trim();
  const managerId = managerSelect.value;

  const result = session.startSession({
    tableNumber: table,
    checkNumber: check,
    managerId,
  });

  if (!result.ok) {
    overlayError.textContent = result.error;
    return;
  }

  overlayError.textContent = "";

  // Reset labels and dice UI at the start of each game
  resetLabelGen();
  clearAllDiceUI();

  // Update UI
  sessionInfo.textContent = formatSessionInfo(result.session);
  startOverlay.style.display = "none";
  connectBtn.disabled = false;
  endSessionBtn.disabled = false;
}

function endSession(reason = "manual") {
  // If called directly as an event handler, 'reason' will be an event object.
  if (reason && typeof reason === "object") {
    reason = "manual";
  }

  // Let state.js persist + reset session data
  const summary = session.endSession(reason);
  if (!summary) return;

  // Disconnect all dice at end of game (existing behavior)
  disconnectAllDice();

  retryModalOpen = false;
  if (retryBackdrop) retryBackdrop.style.display = "none";

  // Update UI
  sessionInfo.textContent = "No active game session";
  connectBtn.disabled = true;
  endSessionBtn.disabled = true;

  // Show overlay again for next table
  startOverlay.style.display = "flex";
  tableInput.value = "";
  checkInput.value = "";
  managerSelect.value = "";
  overlayError.textContent = "";
}

endSessionBtn.addEventListener("click", () => endSession("manual"));
startSessionBtn.addEventListener("click", startSession);

// Simple reward configuration by sum of the two dice
const REWARDS_BY_SUM = {
  2: "On the house (100% off the check)",
  3: "75% off the check",
  4: "50% off the check",
  5: "40% off the check",
  6: "30% off the check",
  7: "No discount (better luck next time!)",
  8: "10% off the check",
  9: "15% off the check",
  10: "20% off the check",
  11: "25% off the check",
  12: "On the house (jackpot!)",
};

/**********************************
 * ROLL RECORDING
 **********************************/
function recordRoll(diceId, dieLabel, face) {
  session.recordRoll(diceId, dieLabel, face);
}

/**********************************
 * DICE CONNECTION LOGIC
 **********************************/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function shortId(id) {
  return (id || "").slice(0, 6) + "…";
}

// LABEL GENERATOR (reset to A/B each game)
function* labelGen() {
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let n = 0;
  while (true) {
    let x = n++,
      s = "";
    do {
      s = L[x % 26] + s;
      x = Math.floor(x / 26) - 1;
    } while (x >= 0);
    yield s;
  }
}
let nextLabel;
function resetLabelGen() {
  nextLabel = labelGen();
}
resetLabelGen(); // initial

function makeQueue() {
  let p = Promise.resolve();
  return (fn) =>
    (p = p.then(fn).catch((e) => {
      console.warn("[queue] op failed:", e?.message || e);
    }));
}

async function withGattRetry(fn, { retries = 6, delay = 250 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (!/GATT operation already in progress/i.test(msg)) throw e;
      last = e;
      await sleep(delay * (i + 1));
    }
  }
  throw last;
}

function makeDieCard(diceId, label) {
  const root = document.createElement("div");
  root.className = "card";
  const title = document.createElement("h3");
  title.textContent = `Die ${label} (${shortId(diceId)})`;
  const status = document.createElement("div");
  status.className = "line";
  status.textContent = "Status: Connected";
  const battery = document.createElement("div");
  battery.className = "line";
  battery.textContent = "Battery: —";
  const roll = document.createElement("div");
  roll.className = "line";
  roll.textContent = "Last roll: —";
  root.append(title, status, battery, roll);
  diceList.appendChild(root);
  return { root, title, status, battery, roll };
}

// NEW: create visual dice face box
function makeFaceCard(label) {
  const root = document.createElement("div");
  root.className = "dice-face";
  const lbl = document.createElement("div");
  lbl.className = "dice-face-label";
  lbl.textContent = `Dice ${label}`;
  const square = document.createElement("div");
  square.className = "dice-square";
  const valueEl = document.createElement("div");
  valueEl.className = "dice-square-value";
  valueEl.textContent = "-";
  square.appendChild(valueEl);
  const textUnder = document.createElement("div");
  textUnder.className = "dice-face-value";
  textUnder.textContent = "Last roll: -";
  root.append(lbl, square, textUnder);
  diceFaces.appendChild(root);
  return { root, valueEl, textUnder };
}

const diceState = new Map(); // diceId -> { inst, label, els, faceEls, queue, ready, batteryRequested, ledPulsed, lastActive, timer }

const goDice = new GoDice();

/**********************************
 * RETRY ROLL LOGIC
 **********************************/
function openRetryModal() {
  retryModalOpen = true;
  retryBackdrop.style.display = "flex";
}

function closeRetryModal() {
  retryModalOpen = false;
  retryBackdrop.style.display = "none";
}

function performRetryRoll() {
  session.resetForRetry(); // <-- NEW

  // Reset dice UI: "Last roll" text + little dice boxes
  diceState.forEach((st) => {
    if (st.els && st.els.roll) {
      st.els.roll.textContent = "Last roll: —";
    }
    if (st.faceEls) {
      st.faceEls.valueEl.textContent = "-";
      st.faceEls.textUnder.textContent = "Last roll: -";
    }
  });
}

// Retry modal events
retryConfirmBtn.addEventListener("click", () => {
  closeRetryModal();
  performRetryRoll();
});

retryCancelBtn.addEventListener("click", () => {
  closeRetryModal();
  endSession("invalid_cancel"); // NEW - session ended mid-way, no reward
});

retryBackdrop.addEventListener("click", (e) => {
  if (e.target === retryBackdrop) {
    closeRetryModal();
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const msg = (e && e.reason && e.reason.message) || String(e.reason || "");
  if (/GATT operation already in progress/i.test(msg)) {
    e.preventDefault();
    console.debug("[suppressed] library init race:", msg);
  }
});

function setDieStatus(st, statusText, { muted = false } = {}) {
  if (!st?.els?.status || !st?.els?.root) return;

  st.els.status.textContent = `Status: ${statusText}`;
  if (muted) st.els.root.classList.add("muted");
  else st.els.root.classList.remove("muted");
}

function markActive(diceId) {
  const st = diceState.get(diceId);
  if (!st) return;
  st.lastActive = Date.now();
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => handleInactivity(diceId), INACTIVITY_MS);
}

async function handleInactivity(diceId) {
  const st = diceState.get(diceId);
  if (!st) return;
  const idleFor = Date.now() - (st.lastActive || 0);
  if (idleFor < INACTIVITY_MS - 100) {
    markActive(diceId);
    return;
  }
  st.els.status.textContent = "Status: Removed due to inactivity";
  st.els.root.classList.add("muted");
  st.queue(async () => {
    try {
      await withGattRetry(() => st.inst.disconnect?.());
    } catch (e) {
      console.warn(
        `[${st.label}] disconnect on inactivity failed:`,
        e?.message || e
      );
    } finally {
      if (st.timer) clearTimeout(st.timer);
      diceState.delete(diceId);
      if (st.els.root.parentNode)
        st.els.root.parentNode.removeChild(st.els.root);
      if (st.faceEls?.root && st.faceEls.root.parentNode)
        st.faceEls.root.parentNode.removeChild(st.faceEls.root);
      updateConnectButtonLabel();
    }
  });
}

// NEW: clear all dice UI elements (cards + faces)
function clearAllDiceUI() {
  diceList.innerHTML = "";
  diceFaces.innerHTML = "";
  diceState.clear();
  updateConnectButtonLabel();
}

// NEW: disconnect all dice at end of session
function disconnectAllDice() {
  const entries = Array.from(diceState.entries());
  entries.forEach(([diceId, st]) => {
    if (st.timer) clearTimeout(st.timer);
    setDieStatus(st, "Disconnecting…", { muted: true });
    st.queue(async () => {
      try {
        await withGattRetry(() => st.inst.disconnect?.());
      } catch (e) {
        console.warn(
          `[${st.label}] disconnect on endSession failed:`,
          e?.message || e
        );
      } finally {
        diceState.delete(diceId);
        if (st.els.root.parentNode)
          st.els.root.parentNode.removeChild(st.els.root);
        if (st.faceEls?.root && st.faceEls.root.parentNode)
          st.faceEls.root.parentNode.removeChild(st.faceEls.root);
      }
    });
  });
  // also reset labels so next game starts at Dice A again
  resetLabelGen();
  updateConnectButtonLabel();
}

GoDice.prototype.onDiceConnected = async (diceId, inst) => {
  let st = diceState.get(diceId);
  if (!st) {
    const label = nextLabel.next().value;
    const els = makeDieCard(diceId, label);
    const faceEls = makeFaceCard(label);
    const queue = makeQueue();
    st = {
      inst,
      label,
      els,
      faceEls,
      queue,
      ready: false,
      batteryRequested: false,
      ledPulsed: false,
      lastActive: Date.now(),
      timer: null,
    };
    diceState.set(diceId, st);
    console.log(`[${label}] connected id=${diceId}`);
  } else {
    st.inst = inst;
    setDieStatus(st, "Connected", { muted: false });
    st.lastActive = Date.now();
    console.log(`[${st.label}] reconnected`);
  }

  markActive(diceId);
  await sleep(2000);
  st.ready = true;

  if (!st.batteryRequested) {
    st.batteryRequested = true;
    st.queue(async () => {
      await withGattRetry(() => st.inst.getBatteryLevel());
    });
  }

  connectBtn.disabled = false;
  updateConnectButtonLabel();
};

GoDice.prototype.onBatteryLevel = async (diceId, level) => {
  const st = diceState.get(diceId);
  if (!st) return;
  // If we’re receiving data, the die is effectively connected
  setDieStatus(st, "Connected", { muted: false });

  st.els.battery.textContent = `Battery: ${level}%`;
  markActive(diceId);

  if (!st.ledPulsed && st.ready) {
    st.ledPulsed = true;
    st.queue(async () => {
      await sleep(400);
      await withGattRetry(() => st.inst.pulseLed(3, 15, 15, [82, 14, 125]));
    });
  }
};

GoDice.prototype.onStable = (diceId, value /*, acc */) => {
  const st = diceState.get(diceId);
  if (!st) return;
  // If we’re receiving rolls, the die is connected regardless of previous UI state
  setDieStatus(st, "Connected", { muted: false });

  // 👉 While retry modal is open:
  // - DO NOT update UI
  // - DO NOT call recordRoll
  // - ONLY mark the die as active so inactivity timer doesn't fire
  if (retryModalOpen) {
    console.log("[ROLL IGNORED UI] retry modal open, not updating dice face", {
      diceId,
      value,
    });
    markActive(diceId);
    return;
  }

  // Normal flow: update UI
  st.els.roll.textContent = `Last roll: ${value}`;
  markActive(diceId);

  if (st.faceEls) {
    st.faceEls.valueEl.textContent = `${value}`;
    st.faceEls.textUnder.textContent = `Last roll: ${value}`;
  }

  // Then record the roll into the session
  recordRoll(diceId, st.label, value);
};

GoDice.prototype.onDiceDisconnected = (diceId) => {
  const st = diceState.get(diceId);
  if (!st) return;
  setDieStatus(st, "Disconnected", { muted: true });
  if (st.timer) clearTimeout(st.timer);
  console.log(`[${st.label}] disconnected`);
};

let connecting = false;
connectBtn.addEventListener("click", async () => {
  if (connecting) return;
  if (!session.isActive()) {
    alert("Start a game session first.");
    return;
  }
  connecting = true;
  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";
  try {
    await goDice.requestDevice();
  } catch (e) {
    alert("Connection failed: " + ((e && e.message) || e));
    connectBtn.disabled = false;
    updateConnectButtonLabel();
  } finally {
    connecting = false;
  }
});

/**********************************
 * INIT
 **********************************/
populateManagerDropdown();
updateConnectButtonLabel();
(async () => {
  const closed = await dbCloseAbandonedSessions();
  if (closed > 0) {
    console.info(
      `[Startup] Closed ${closed} abandoned session(s) after reload/close.`
    );
  }
})();
