import { INACTIVITY_MS, EXPORT_PASSWORD, MANAGERS } from "./config.js";

/**********************************
 * SESSION STATE (in memory only)
 **********************************/
const sessionState = {
  active: false,
  current: null, // { id, startedAt, tableNumber, checkNumber, managerId, managerName }
  rolls: [], // { timestamp, tableNumber, checkNumber, managerId, managerName, dieId, dieLabel, face }
  invalidEvents: [], // NEW - track invalid events during the session
  reward: null, // NEW - reward info for the session
};

// Auto-retry for one-roll situations
const RETRY_ROUND_TIMEOUT_MS = 1000; // 1 second, adjust if needed
let retryTimer = null;
let retryModalOpen = false;

// Currently selected session in the History modal (for CSV export)
let currentHistorySessionMeta = null;

// Track if this game has already been completed (2 rolls reached)
let gameCompleted = false;

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
let dbPromise = null;

function hasIndexedDB() {
  return !!window.indexedDB;
}

function openDatabase() {
  if (!hasIndexedDB()) {
    console.warn("[DB] indexedDB not available in this browser.");
    return Promise.reject(new Error("IndexedDB not supported"));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open("GoDiceDB", 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // sessions store
      if (!db.objectStoreNames.contains("sessions")) {
        const sStore = db.createObjectStore("sessions", {
          keyPath: "id",
        });
        sStore.createIndex("startedAt", "startedAt", { unique: false });
        sStore.createIndex("tableNumber", "tableNumber", {
          unique: false,
        });
        sStore.createIndex("checkNumber", "checkNumber", {
          unique: false,
        });
        sStore.createIndex("managerId", "managerId", { unique: false });
        sStore.createIndex("status", "status", { unique: false });
      }
      // rolls store
      if (!db.objectStoreNames.contains("rolls")) {
        const rStore = db.createObjectStore("rolls", { keyPath: "id" });
        rStore.createIndex("sessionId", "sessionId", { unique: false });
        rStore.createIndex("timestamp", "timestamp", { unique: false });
        rStore.createIndex("dieId", "dieId", { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      console.error("[DB] open error:", request.error);
      reject(request.error);
    };
  });

  return dbPromise;
}

async function dbSaveSessionStart(session) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");

    const startedDate = new Date(session.startedAt);
    const startedAtDisplay = startedDate.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "America/New_York",
    });

    const record = {
      id: session.id,
      startedAt: session.startedAt, // ISO (machine-friendly)
      startedAtDisplay, // human-friendly
      endedAt: null,
      endedAtDisplay: null,
      tableNumber: session.tableNumber,
      checkNumber: session.checkNumber,
      managerId: session.managerId,
      managerName: session.managerName,
      status: "active",
    };

    store.put(record);
    tx.oncomplete = () => console.log("[DB] session start saved", record);
    tx.onerror = () =>
      console.error("[DB] session start save failed", tx.error);
  } catch (e) {
    console.warn("[DB] session start not saved:", e?.message || e);
  }
}

async function dbSaveSessionEnd(sessionSummary) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");

    const startedDate = new Date(sessionSummary.startedAt);
    const endedDate = new Date(sessionSummary.endedAt);

    const startedAtDisplay = startedDate.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "America/New_York",
    });
    const endedAtDisplay = endedDate.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "America/New_York",
    });

    const endedReason = sessionSummary.endedReason || "manual";

    const status =
      endedReason === "reward"
        ? "Rewarded"
        : endedReason === "invalid_cancel"
        ? "Canceled"
        : "Ended";

    const reward = sessionSummary.reward || null;
    const rewardSum =
      reward && typeof reward.sum === "number" ? reward.sum : null;
    const rewardText = reward ? reward.rewardText || null : null;
    const rewardGranted = reward ? !!reward.granted : false;

    // Sanitize invalidEvents but keep mini snapshots for CSV tagging
    const invalidEventsRaw = Array.isArray(sessionSummary.invalidEvents)
      ? sessionSummary.invalidEvents
      : [];
    const invalidEvents = invalidEventsRaw.map((ev) => ({
      reason: ev && ev.reason ? String(ev.reason) : "",
      at: ev && ev.at ? String(ev.at) : null,
      rollsSnapshot: Array.isArray(ev.rollsSnapshot)
        ? ev.rollsSnapshot.map((r) => ({
            timestamp: r && r.timestamp ? String(r.timestamp) : null,
            dieId: r && r.dieId ? String(r.dieId) : null,
          }))
        : [],
    }));

    const record = {
      id: sessionSummary.id,
      startedAt: sessionSummary.startedAt,
      startedAtDisplay,
      endedAt: sessionSummary.endedAt,
      endedAtDisplay,

      tableNumber: sessionSummary.tableNumber,
      checkNumber: sessionSummary.checkNumber,
      managerId: sessionSummary.managerId,
      managerName: sessionSummary.managerName,

      endedReason,
      status, // Rewarded / Canceled / Ended

      rollsCount: sessionSummary.rolls ? sessionSummary.rolls.length : 0,

      rewardSum,
      rewardText,
      rewardGranted,

      invalidEvents,
    };

    store.put(record);
    tx.oncomplete = () => console.log("[DB] session end saved", record);
    tx.onerror = () => console.error("[DB] session end save failed", tx.error);
  } catch (e) {
    console.warn("[DB] session end not saved:", e?.message || e);
  }
}

function makeRollId() {
  return "roll_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

async function dbSaveRoll(sessionId, rollRecord) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("rolls", "readwrite");
    const store = tx.objectStore("rolls");

    const tsDate = new Date(rollRecord.timestamp);
    const timestampDisplay = tsDate.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "America/New_York",
    });

    const record = {
      id: makeRollId(),
      sessionId,
      timestamp: rollRecord.timestamp, // ISO
      timestampDisplay, // human-readable
      tableNumber: rollRecord.tableNumber,
      checkNumber: rollRecord.checkNumber,
      managerId: rollRecord.managerId,
      managerName: rollRecord.managerName,
      dieId: rollRecord.dieId,
      dieLabel: rollRecord.dieLabel,
      face: rollRecord.face,
    };

    store.put(record);
    tx.oncomplete = () => console.log("[DB] roll saved", record);
    tx.onerror = () => console.error("[DB] roll save failed", tx.error);
  } catch (e) {
    console.warn("[DB] roll not saved:", e?.message || e);
  }
}

async function dbGetAllSessions() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const store = tx.objectStore("sessions");
    const request = store.getAll();
    request.onsuccess = () => {
      const result = request.result || [];
      // sort by startedAt descending
      result.sort((a, b) => {
        if (!a.startedAt && !b.startedAt) return 0;
        if (!a.startedAt) return 1;
        if (!b.startedAt) return -1;
        return a.startedAt < b.startedAt ? 1 : -1;
      });
      resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbGetRollsForSession(sessionId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("rolls", "readonly");
    const store = tx.objectStore("rolls");
    let request;

    if (store.indexNames.contains("sessionId")) {
      const idx = store.index("sessionId");
      request = idx.getAll(IDBKeyRange.only(sessionId));
    } else {
      // Fallback: get all and filter
      request = store.getAll();
    }

    request.onsuccess = () => {
      let rows = request.result || [];
      if (!store.indexNames.contains("sessionId")) {
        rows = rows.filter((r) => r.sessionId === sessionId);
      }
      // sort rolls by timestamp ascending
      rows.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return -1;
        if (!b.timestamp) return 1;
        return a.timestamp < b.timestamp ? -1 : 1;
      });
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCSV(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**********************************
 * HISTORY VIEW LOGIC
 **********************************/
function renderHistoryList(sessions) {
  historyListEl.innerHTML = "";
  historyDetailsEl.innerHTML =
    '<p style="font-size:13px; color:#9ca3af;">Select a session to view its rolls.</p>';

  currentHistorySessionMeta = null;
  exportSessionBtn.disabled = true;

  sessions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.sessionId = s.id;

    const started = s.startedAtDisplay || s.startedAt || "";

    const rollsCount = s.rollsCount != null ? s.rollsCount : "-";
    const endedReason = s.endedReason || "ended";
    const rewardSum = s.rewardSum;
    const rewardText = s.rewardText;
    const rewardGranted = !!s.rewardGranted;
    const invalidCount = Array.isArray(s.invalidEvents)
      ? s.invalidEvents.length
      : 0;

    // Build a human-friendly outcome label
    let outcome = "Ended (no reward)";

    if (endedReason === "reward" && rewardGranted && rewardSum != null) {
      const shortRewardText = rewardText || "Reward granted";
      outcome = `Reward ${rewardSum} - ${shortRewardText}`;
    } else if (endedReason === "invalid_cancel") {
      outcome =
        invalidCount > 0
          ? `Cancelled (invalid rolls)`
          : `Cancelled (no reward)`;
    } else if (endedReason === "manual") {
      outcome = "Ended manually";
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
  });

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
    let endedLabel = "Ended (no reward)";
    if (endedReason === "reward" && rewardGranted) {
      endedLabel = "Rewarded";
    } else if (endedReason === "invalid_cancel") {
      endedLabel = "Cancelled (invalid rolls)";
    } else if (endedReason === "manual") {
      endedLabel = "Ended manually";
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
    renderHistoryList(sessions);
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

async function handleExportAllSessions() {
  const ok = await requireExportPassword();
  if (!ok) return;

  try {
    exportAllBtn.disabled = true;
    exportAllBtn.textContent = "Exporting…";

    const sessions = await dbGetAllSessions();
    if (!sessions.length) {
      alert("No sessions to export yet.");
      return;
    }

    // For each session, fetch rolls
    const rollsPerSession = await Promise.all(
      sessions.map((s) => dbGetRollsForSession(s.id))
    );

    const header = [
      "sessionId",
      "tableNumber",
      "checkNumber",
      "managerName",
      "status", // now roll-level status
      "sessionStarted",
      "sessionEnded",
      "rollTimestamp",
      "dieLabel",
      "dieId",
      "face",
    ];
    const rows = [header];

    sessions.forEach((s, idx) => {
      const rolls = rollsPerSession[idx];
      const sessionStarted = s.startedAtDisplay || s.startedAt || "";
      const sessionEnded = s.endedAtDisplay || s.endedAt || "";
      const sessionStatus = s.status || "ended";

      // Build a lookup of invalid rolls for this session
      const invalidSet = new Set();
      if (Array.isArray(s.invalidEvents)) {
        s.invalidEvents.forEach((ev) => {
          if (Array.isArray(ev.rollsSnapshot)) {
            ev.rollsSnapshot.forEach((rSnap) => {
              if (rSnap && rSnap.timestamp && rSnap.dieId) {
                invalidSet.add(`${rSnap.timestamp}__${rSnap.dieId}`);
              }
            });
          }
        });
      }

      if (!rolls.length) {
        // Include a row even if there are no rolls
        rows.push([
          s.id,
          s.tableNumber || "",
          s.checkNumber || "",
          s.managerName || "",
          sessionStatus, // no rolls, so just show the session status
          sessionStarted,
          sessionEnded,
          "", // rollTimestamp
          "", // dieLabel
          "", // dieId
          "", // face
        ]);
      } else {
        rolls.forEach((r) => {
          const ts = r.timestampDisplay || r.timestamp || "";
          const key =
            r.timestamp && r.dieId ? `${r.timestamp}__${r.dieId}` : null;
          const isInvalid = key && invalidSet.has(key);
          const rollStatus = isInvalid ? "Invalid Roll" : sessionStatus;

          rows.push([
            s.id,
            s.tableNumber || "",
            s.checkNumber || "",
            s.managerName || "",
            rollStatus, // 👈 per-roll status
            sessionStarted,
            sessionEnded,
            ts,
            r.dieLabel || "",
            r.dieId || "",
            r.face,
          ]);
        });
      }
    });

    const now = new Date();
    const dateTag = now.toISOString().slice(0, 10); // e.g. 2025-11-21
    downloadCSV(`godice_history_${dateTag}.csv`, rows);
  } catch (e) {
    console.error("[HISTORY] export all failed:", e);
    alert("Failed to export history.");
  } finally {
    exportAllBtn.disabled = false;
    exportAllBtn.textContent = "Export All (CSV)";
  }
}

async function handleExportSelectedSession() {
  if (!currentHistorySessionMeta) {
    alert("Please select a session first.");
    return;
  }

  const ok = await requireExportPassword();
  if (!ok) return;

  try {
    exportSessionBtn.disabled = true;
    exportSessionBtn.textContent = "Exporting…";

    const s = currentHistorySessionMeta;
    const rolls = await dbGetRollsForSession(s.id);

    const header = [
      "sessionId",
      "tableNumber",
      "checkNumber",
      "managerName",
      "status", // roll-level
      "sessionStarted",
      "sessionEnded",
      "rollTimestamp",
      "dieLabel",
      "dieId",
      "face",
    ];
    const rows = [header];

    const sessionStarted = s.startedAtDisplay || s.startedAt || "";
    const sessionEnded = s.endedAtDisplay || s.endedAt || "";
    const sessionStatus = s.status || "ended";

    // Build invalid set for this single session
    const invalidSet = new Set();
    if (Array.isArray(s.invalidEvents)) {
      s.invalidEvents.forEach((ev) => {
        if (Array.isArray(ev.rollsSnapshot)) {
          ev.rollsSnapshot.forEach((rSnap) => {
            if (rSnap && rSnap.timestamp && rSnap.dieId) {
              invalidSet.add(`${rSnap.timestamp}__${rSnap.dieId}`);
            }
          });
        }
      });
    }

    if (!rolls.length) {
      rows.push([
        s.id,
        s.tableNumber || "",
        s.checkNumber || "",
        s.managerName || "",
        sessionStatus,
        sessionStarted,
        sessionEnded,
        "",
        "",
        "",
        "",
      ]);
    } else {
      rolls.forEach((r) => {
        const ts = r.timestampDisplay || r.timestamp || "";
        const key =
          r.timestamp && r.dieId ? `${r.timestamp}__${r.dieId}` : null;
        const isInvalid = key && invalidSet.has(key);
        const rollStatus = isInvalid ? "Invalid Roll" : sessionStatus;

        rows.push([
          s.id,
          s.tableNumber || "",
          s.checkNumber || "",
          s.managerName || "",
          rollStatus,
          sessionStarted,
          sessionEnded,
          ts,
          r.dieLabel || "",
          r.dieId || "",
          r.face,
        ]);
      });
    }

    const safeTable = (s.tableNumber || "table").replace(/[^a-z0-9]+/gi, "_");
    const safeCheck = (s.checkNumber || "check").replace(/[^a-z0-9]+/gi, "_");
    downloadCSV(`godice_session_${safeTable}_${safeCheck}.csv`, rows);
  } catch (e) {
    console.error("[HISTORY] export session failed:", e);
    alert("Failed to export this session.");
  } finally {
    exportSessionBtn.disabled = false;
    exportSessionBtn.textContent = "Export Session (CSV)";
  }
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

  if (!table || !check || !managerId) {
    overlayError.textContent =
      "Please fill table, check, and manager to start.";
    return;
  }

  const manager = MANAGERS.find((m) => m.id === managerId);
  if (!manager) {
    overlayError.textContent = "Please select a valid manager.";
    return;
  }

  overlayError.textContent = "";

  const sessionId = "sess_" + Date.now();
  const startedAt = new Date().toISOString();

  sessionState.active = true;
  sessionState.current = {
    id: sessionId,
    startedAt,
    tableNumber: table,
    checkNumber: check,
    managerId: manager.id,
    managerName: manager.name,
  };
  sessionState.rolls = []; // reset in-memory rolls
  sessionState.invalidEvents = []; // NEW - reset invalid events
  sessionState.reward = null; // NEW - reset reward info
  gameCompleted = false; // ✅ reset at start of each game

  console.log("[SESSION STARTED]", sessionState.current);
  dbSaveSessionStart(sessionState.current);

  // Reset labels and dice UI at the start of each game
  resetLabelGen();
  clearAllDiceUI();

  // Update UI
  sessionInfo.textContent = formatSessionInfo(sessionState.current);
  startOverlay.style.display = "none";
  connectBtn.disabled = false;
  endSessionBtn.disabled = false;
}

function endSession(reason = "manual") {
  // If called directly as an event handler, 'reason' will be an event object.
  if (reason && typeof reason === "object") {
    reason = "manual";
  }

  if (!sessionState.active || !sessionState.current) return;

  // Decide a more specific reason for manual
  let effectiveReason = reason;
  if (reason === "manual") {
    effectiveReason =
      sessionState.rolls.length === 0 ? "ended_no_rolls" : "manual_with_rolls";
  }

  const endedAt = new Date().toISOString();
  const summary = {
    ...sessionState.current,
    endedAt,
    rolls: [...sessionState.rolls],
    invalidEvents: sessionState.invalidEvents
      ? [...sessionState.invalidEvents]
      : [],
    reward: sessionState.reward || null,
    endedReason: effectiveReason,
  };

  console.log("[SESSION ENDED]", summary);
  dbSaveSessionEnd(summary);

  // Disconnect all dice at end of game
  disconnectAllDice();

  // Reset session state
  sessionState.active = false;
  sessionState.current = null;
  sessionState.rolls = [];
  sessionState.invalidEvents = [];
  sessionState.reward = null;

  // Clear retry state
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryModalOpen = false;
  if (retryBackdrop) {
    retryBackdrop.style.display = "none";
  }

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

  gameCompleted = false;
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

function getRewardForSum(sum) {
  return (
    REWARDS_BY_SUM[sum] ||
    "No configured reward for this total. Please check game rules."
  );
}

/**********************************
 * ROLL RECORDING
 **********************************/
function recordRoll(diceId, dieLabel, face) {
  if (!sessionState.active || !sessionState.current || gameCompleted) {
    console.log("[ROLL IGNORED] No active session or game already completed", {
      diceId,
      dieLabel,
      face,
    });
    return;
  }

  // If a retry modal is open, ignore incoming rolls until user decides
  if (retryModalOpen) {
    console.log("[ROLL IGNORED] retry modal open", { diceId, dieLabel, face });
    return;
  }

  const now = new Date().toISOString();
  const s = sessionState.current;

  const record = {
    timestamp: now,
    tableNumber: s.tableNumber,
    checkNumber: s.checkNumber,
    managerId: s.managerId,
    managerName: s.managerName,
    dieId: diceId,
    dieLabel,
    face: Number(face) || 0,
  };

  sessionState.rolls.push(record);
  console.log("[ROLL RECORDED]", record);
  dbSaveRoll(s.id, record);

  // Clear any pending "one-roll" retry timer
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  const rollsThisRound = sessionState.rolls;

  if (rollsThisRound.length === 1) {
    // First roll of this round – start a short timer to see if second roll arrives
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (
        sessionState.active &&
        !gameCompleted &&
        sessionState.rolls.length === 1
      ) {
        console.log(
          "[RETRY] Only one roll recorded after timeout – offering retry."
        );

        // Log invalid event for DB
        sessionState.invalidEvents.push({
          reason: "single_roll_timeout",
          at: new Date().toISOString(),
          rollsSnapshot: [...sessionState.rolls],
        });

        openRetryModal();
      }
    }, RETRY_ROUND_TIMEOUT_MS);
  } else if (rollsThisRound.length === 2) {
    const [firstRoll, secondRoll] = rollsThisRound;

    // ✅ Rule: second roll must come from a different die
    if (firstRoll.dieId === secondRoll.dieId) {
      console.log(
        "[RETRY] Two rolls came from the same die – offering retry.",
        { firstRoll, secondRoll }
      );

      // Log invalid event
      sessionState.invalidEvents.push({
        reason: "same_die_twice",
        at: new Date().toISOString(),
        rollsSnapshot: [firstRoll, secondRoll],
      });

      openRetryModal();
      return;
    }

    // Valid: two different dice → store reward, auto-end game
    const sum = (firstRoll.face || 0) + (secondRoll.face || 0);
    const rewardText = getRewardForSum(sum);

    sessionState.reward = {
      sum,
      rewardText,
      granted: true,
    };

    console.log("[REWARD] total:", sum, "reward:", rewardText);
    openRewardModal(sum, rewardText, firstRoll, secondRoll);

    gameCompleted = true;
    endSession("reward"); // 🔥 game ends automatically, reward modal is just visual now
  } else {
    // More than 2 rolls in a single round – not expected, just log & ignore
    console.warn(
      "[ROLL] More than 2 rolls recorded in one game round – ignoring extra.",
      rollsThisRound
    );
  }
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
  // Clear in-memory rolls, but keep the session active
  sessionState.rolls = [];
  gameCompleted = false;

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
    st.els.status.textContent = "Status: Disconnected";
    st.els.root.classList.add("muted");
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
    st.els.status.textContent = "Status: Reconnected";
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
  st.els.battery.textContent = `Battery: ${level}%`;
  markActive(diceId);

  if (!st.ledPulsed && st.ready) {
    st.ledPulsed = true;
    st.queue(async () => {
      await sleep(400);
      await withGattRetry(() => st.inst.pulseLed(3, 15, 15, [0, 128, 155]));
    });
  }
};

GoDice.prototype.onStable = (diceId, value /*, acc */) => {
  const st = diceState.get(diceId);
  if (!st) return;

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
  st.els.status.textContent = "Status: Disconnected";
  if (st.timer) clearTimeout(st.timer);
  console.log(`[${st.label}] disconnected`);
};

let connecting = false;
connectBtn.addEventListener("click", async () => {
  if (connecting) return;
  if (!sessionState.active) {
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
