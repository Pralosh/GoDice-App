// js/db.js
// All IndexedDB helpers live here and are used by main.js and others.

let dbPromise = null;

function hasIndexedDB() {
  return !!window.indexedDB;
}

export function openDatabase() {
  if (!hasIndexedDB()) {
    console.warn("[DB] indexedDB not available in this browser.");
    return Promise.reject(new Error("IndexedDB not supported"));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open("GoDiceDB", 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // --- sessions store ---
      let sStore;
      if (!db.objectStoreNames.contains("sessions")) {
        sStore = db.createObjectStore("sessions", { keyPath: "id" });
      } else {
        sStore = event.target.transaction.objectStore("sessions");
      }
      // We currently only do getAll()/put() on sessions, so no indexes required.

      // --- rolls store ---
      let rStore;
      if (!db.objectStoreNames.contains("rolls")) {
        rStore = db.createObjectStore("rolls", { keyPath: "id" });
      } else {
        rStore = event.target.transaction.objectStore("rolls");
      }

      // Index by sessionId for quick lookup of rolls per session
      if (!rStore.indexNames.contains("sessionId")) {
        rStore.createIndex("sessionId", "sessionId", { unique: false });
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

// ---- Session start ----
export async function dbSaveSessionStart(session) {
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
      startedAt: session.startedAt, // ISO
      startedAtDisplay, // friendly
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

// ---- Session end ----
export async function dbSaveSessionEnd(sessionSummary) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");

    // Ensure endedAt exists
    const endedAt = sessionSummary.endedAt || new Date().toISOString();

    const startedDate = new Date(sessionSummary.startedAt);
    const endedDate = new Date(endedAt);

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

    // ✅ Normalize reward fields FIRST (supports both summary.reward and top-level fields)
    const rewardObj = sessionSummary.reward || null;

    const rewardSum =
      typeof sessionSummary.rewardSum === "number"
        ? sessionSummary.rewardSum
        : rewardObj && typeof rewardObj.sum === "number"
        ? rewardObj.sum
        : null;

    const rewardText =
      sessionSummary.rewardText != null
        ? String(sessionSummary.rewardText)
        : rewardObj && rewardObj.rewardText != null
        ? String(rewardObj.rewardText)
        : null;

    const rewardGranted =
      typeof sessionSummary.rewardGranted === "boolean"
        ? sessionSummary.rewardGranted
        : rewardObj
        ? !!rewardObj.granted
        : false;

    function isNoWinRewardText(text) {
      if (!text) return false;
      return /no discount|better luck|no win|no prize/i.test(String(text));
    }

    // ✅ Now compute status
    let status = "Ended";
    if (endedReason === "reward" && rewardGranted) {
      status = isNoWinRewardText(rewardText) ? "No Win" : "Won";
    } else if (endedReason === "invalid_cancel") {
      status = "Canceled";
    }

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

    // ✅ Sanitize winning pair snapshot for CSV rollStatus tagging
    const validRollsSnapshotRaw = Array.isArray(
      sessionSummary.validRollsSnapshot
    )
      ? sessionSummary.validRollsSnapshot
      : null;

    const validRollsSnapshot =
      validRollsSnapshotRaw && validRollsSnapshotRaw.length
        ? validRollsSnapshotRaw
            .slice(0, 2)
            .map((r) => ({
              timestamp: r?.timestamp || "",
              dieId: r?.dieId || "",
            }))
            .filter((r) => r.timestamp && r.dieId)
        : [];

    // ✅ Build record AFTER all derived fields exist
    const record = {
      id: sessionSummary.id,
      startedAt: sessionSummary.startedAt,
      startedAtDisplay,
      endedAt: endedAt,
      endedAtDisplay,

      tableNumber: sessionSummary.tableNumber,
      checkNumber: sessionSummary.checkNumber,
      managerId: sessionSummary.managerId,
      managerName: sessionSummary.managerName,

      endedReason,
      status, // Won / No Win / Canceled / Ended

      rollsCount: sessionSummary.rolls ? sessionSummary.rolls.length : 0,

      rewardSum,
      rewardText,
      rewardGranted,

      invalidEvents,
      validRollsSnapshot,
    };

    store.put(record);
    tx.oncomplete = () => console.log("[DB] session end saved", record);
    tx.onerror = () => console.error("[DB] session end save failed", tx.error);
  } catch (e) {
    console.warn("[DB] session end not saved:", e?.message || e);
  }
}

// ---- Rolls ----
function makeRollId() {
  return "roll_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

export async function dbSaveRoll(sessionId, rollRecord) {
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

// ---- Queries ----
export async function dbGetAllSessions() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const store = tx.objectStore("sessions");
    const request = store.getAll();
    request.onsuccess = () => {
      const result = request.result || [];
      // Sort by startedAt descending (most recent first)
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

export async function dbGetRollsForSession(sessionId) {
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
      // Sort by timestamp ascending
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

export async function dbCountRollsForSession(sessionId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("rolls", "readonly");
    const store = tx.objectStore("rolls");
    const index = store.index("sessionId");

    return await new Promise((resolve) => {
      const req = index.count(sessionId);
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch (e) {
    console.error("[DB] count rolls failed:", e);
    return 0;
  }
}
