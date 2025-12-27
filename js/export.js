// js/export.js
// Owns CSV generation + rollStatus logic. Does NOT touch DOM except via downloadCSV.

function csvEscape(val) {
  const s = val == null ? "" : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function rollKey(ts, dieId) {
  return ts && dieId ? `${ts}__${dieId}` : "";
}

function buildInvalidSet(session) {
  const invalidSet = new Set();
  (session?.invalidEvents || []).forEach((ev) => {
    (ev?.rollsSnapshot || []).forEach((r) => {
      const k = rollKey(r?.timestamp, r?.dieId);
      if (k) invalidSet.add(k);
    });
  });
  return invalidSet;
}

function buildValidSet(session) {
  const validSet = new Set();
  if (Array.isArray(session?.validRollsSnapshot)) {
    session.validRollsSnapshot.forEach((r) => {
      const k = rollKey(r?.timestamp, r?.dieId);
      if (k) validSet.add(k);
    });
  }
  return validSet;
}

// Fallback for older sessions that don't have validRollsSnapshot persisted
function applyValidFallbackIfNeeded({ session, rolls, validSet }) {
  const sessionIsRewarded =
    session?.endedReason === "reward" && !!session?.rewardGranted;
  if (!sessionIsRewarded) return;

  if (validSet.size > 0) return;
  if (!Array.isArray(rolls) || rolls.length < 2) return;

  const sorted = [...rolls].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  let second = null;
  let first = null;

  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!second) {
      second = sorted[i];
      continue;
    }
    if (sorted[i].dieId && second.dieId && sorted[i].dieId !== second.dieId) {
      first = sorted[i];
      break;
    }
  }

  if (first && second) {
    validSet.add(rollKey(first.timestamp, first.dieId));
    validSet.add(rollKey(second.timestamp, second.dieId));
  }
}

function computeRollStatus({ session, roll, invalidSet, validSet }) {
  const key = rollKey(roll?.timestamp, roll?.dieId);

  const sessionIsRewarded =
    session?.endedReason === "reward" && !!session?.rewardGranted;

  if (invalidSet.has(key)) return "Invalid Roll";
  if (!sessionIsRewarded) return "Invalid Roll"; // ended/canceled/abandoned => all rolls invalid attempts
  return validSet.has(key) ? "Valid Roll" : "Invalid Roll";
}

function buildHeader() {
  return [
    "sessionId",
    "tableNumber",
    "checkNumber",
    "managerName",
    "sessionStatus",
    "reward",
    "rollStatus",
    "sessionStartDate",
    "sessionStartTime",
    "sessionEndDate",
    "sessionEndTime",
    "rollDate",
    "rollTime",
    "dieLabel",
    "dieId",
    "face",
  ];
}

// formatDateTimeParts is owned by main.js right now; we pass it in.
function buildRowsForSession({
  session,
  rolls,
  deriveSessionStatus,
  deriveRewardColumn,
  formatDateTimeParts,
}) {
  const rows = [];

  const sessionStatus = deriveSessionStatus(session);
  const rewardCol = deriveRewardColumn(session, rolls);

  const startParts = formatDateTimeParts(session.startedAt);
  const endParts = formatDateTimeParts(session.endedAt);

  const invalidSet = buildInvalidSet(session);
  const validSet = buildValidSet(session);
  applyValidFallbackIfNeeded({ session, rolls, validSet });

  // If no rolls, write a summary row
  if (!Array.isArray(rolls) || rolls.length === 0) {
    rows.push([
      session.id,
      session.tableNumber || "",
      session.checkNumber || "",
      session.managerName || "",
      sessionStatus,
      rewardCol,
      "", // rollStatus
      startParts.date,
      startParts.time,
      endParts.date,
      endParts.time,
      "",
      "",
      "",
      "",
      "",
    ]);
    return rows;
  }

  // Roll rows
  for (const r of rolls) {
    const rollParts = formatDateTimeParts(r.timestamp);
    const rollStatus = computeRollStatus({
      session,
      roll: r,
      invalidSet,
      validSet,
    });

    rows.push([
      session.id,
      session.tableNumber || "",
      session.checkNumber || "",
      session.managerName || "",
      sessionStatus,
      rewardCol,
      rollStatus,
      startParts.date,
      startParts.time,
      endParts.date,
      endParts.time,
      rollParts.date,
      rollParts.time,
      r.dieLabel || "",
      r.dieId || "",
      r.face ?? "",
    ]);
  }

  return rows;
}

export async function exportAllSessionsCSV({
  filename = "godice_sessions.csv",
  requireExportPassword, // () => Promise<boolean>
  dbGetAllSessions, // () => Promise<Session[]>
  dbGetRollsForSession, // (id) => Promise<Roll[]>
  deriveSessionStatus,
  deriveRewardColumn,
  formatDateTimeParts,
}) {
  const ok = await requireExportPassword();
  if (!ok) return;

  const sessions = await dbGetAllSessions();
  const rows = [buildHeader()];

  for (const s of sessions || []) {
    const rolls = await dbGetRollsForSession(s.id);
    rows.push(
      ...buildRowsForSession({
        session: s,
        rolls,
        deriveSessionStatus,
        deriveRewardColumn,
        formatDateTimeParts,
      })
    );
  }

  downloadCSV(filename, rows);
}

export async function exportSelectedSessionCSV({
  filename = "godice_session.csv",
  requireExportPassword, // () => Promise<boolean>
  session, // selected session object
  dbGetRollsForSession,
  deriveSessionStatus,
  deriveRewardColumn,
  formatDateTimeParts,
}) {
  const ok = await requireExportPassword();
  if (!ok) return;
  if (!session?.id) return;

  const rolls = await dbGetRollsForSession(session.id);
  const rows = [buildHeader()];

  rows.push(
    ...buildRowsForSession({
      session,
      rolls,
      deriveSessionStatus,
      deriveRewardColumn,
      formatDateTimeParts,
    })
  );

  downloadCSV(filename, rows);
}
