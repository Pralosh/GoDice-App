// js/state.js
// Owns session state + roll validation rules + retry timer + reward decision.
// Does NOT touch DOM, BLE, or rendering.

export function createSessionController({
  managers,
  db, // { dbSaveSessionStart, dbSaveSessionEnd, dbSaveRoll }
  getRewardForSum, // (sum:number) => string
  isRetryModalOpen, // () => boolean
  onRetryNeeded, // ({ reason }) => void
  onReward, // ({ sum, rewardText, firstRoll, secondRoll }) => void
  nowIso = () => new Date().toISOString(),
  makeSessionId = () => "sess_" + Date.now(),
  retryRoundTimeoutMs = 1000,
} = {}) {
  if (!Array.isArray(managers)) throw new Error("managers array is required");
  if (!db?.dbSaveSessionStart || !db?.dbSaveSessionEnd || !db?.dbSaveRoll) {
    throw new Error(
      "db helpers missing (dbSaveSessionStart/dbSaveSessionEnd/dbSaveRoll)"
    );
  }
  if (typeof getRewardForSum !== "function") {
    throw new Error("getRewardForSum(sum) function is required");
  }
  if (typeof isRetryModalOpen !== "function") {
    throw new Error("isRetryModalOpen() function is required");
  }

  const state = {
    active: false,
    current: null, // { id, startedAt, tableNumber, checkNumber, managerId, managerName }
    rolls: [],
    invalidEvents: [],
    reward: null,
    gameCompleted: false,
  };

  let retryTimer = null;

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function resetInMemoryForNewSession() {
    state.rolls = [];
    state.invalidEvents = [];
    state.reward = null;
    state.gameCompleted = false;
    clearRetryTimer();
  }

  function startSession({ tableNumber, checkNumber, managerId }) {
    const table = String(tableNumber || "").trim();
    const check = String(checkNumber || "").trim();
    const mgrId = String(managerId || "").trim();

    if (!table || !check || !mgrId) {
      return {
        ok: false,
        error: "Please fill table, check, and manager to start.",
      };
    }

    const manager = managers.find((m) => m && m.id === mgrId);
    if (!manager) {
      return { ok: false, error: "Please select a valid manager." };
    }

    const sessionId = makeSessionId();
    const startedAt = nowIso();

    state.active = true;
    state.current = {
      id: sessionId,
      startedAt,
      tableNumber: table,
      checkNumber: check,
      managerId: manager.id,
      managerName: manager.name,
    };

    resetInMemoryForNewSession();

    // Persist start
    db.dbSaveSessionStart(state.current);

    return { ok: true, session: state.current };
  }

  function endSession(reason = "manual") {
    // If called as an event handler accidentally, 'reason' could be an object
    if (reason && typeof reason === "object") reason = "manual";
    if (!state.active || !state.current) return null;

    // Decide a more specific reason for manual
    let effectiveReason = reason;
    if (reason === "manual") {
      effectiveReason =
        state.rolls.length === 0 ? "ended_no_rolls" : "manual_with_rolls";
    }

    const endedAt = nowIso();

    const summary = {
      ...state.current,
      endedAt,
      rolls: [...state.rolls],
      invalidEvents: Array.isArray(state.invalidEvents)
        ? [...state.invalidEvents]
        : [],
      reward: state.reward || null,
      endedReason: effectiveReason,
    };

    // Persist end
    db.dbSaveSessionEnd(summary);

    // Reset in-memory session
    state.active = false;
    state.current = null;
    resetInMemoryForNewSession();

    return summary;
  }

  function resetForRetry() {
    // keep session active; just clear in-memory round rolls
    state.rolls = [];
    state.gameCompleted = false;
    clearRetryTimer();
  }

  function recordRoll(diceId, dieLabel, face) {
    if (!state.active || !state.current || state.gameCompleted)
      return { ok: false, ignored: true };
    if (isRetryModalOpen()) return { ok: false, ignored: true };

    const now = nowIso();
    const s = state.current;

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

    state.rolls.push(record);
    db.dbSaveRoll(s.id, record);

    // Clear any pending "one-roll" retry timer
    clearRetryTimer();

    if (state.rolls.length === 1) {
      // Start a short timer; if second roll doesn't come, offer retry
      retryTimer = setTimeout(() => {
        retryTimer = null;

        if (state.active && !state.gameCompleted && state.rolls.length === 1) {
          state.invalidEvents.push({
            reason: "single_roll_timeout",
            at: nowIso(),
            rollsSnapshot: [...state.rolls],
          });

          if (typeof onRetryNeeded === "function") {
            onRetryNeeded({ reason: "single_roll_timeout" });
          }
        }
      }, retryRoundTimeoutMs);

      return { ok: true, status: "one_roll_recorded" };
    }

    if (state.rolls.length === 2) {
      const [firstRoll, secondRoll] = state.rolls;

      // Rule: must be two different dice IDs
      if (firstRoll.dieId === secondRoll.dieId) {
        state.invalidEvents.push({
          reason: "same_die_twice",
          at: nowIso(),
          rollsSnapshot: [firstRoll, secondRoll],
        });

        if (typeof onRetryNeeded === "function") {
          onRetryNeeded({ reason: "same_die_twice" });
        }

        return { ok: true, status: "invalid_same_die" };
      }

      const sum = (firstRoll.face || 0) + (secondRoll.face || 0);
      const rewardText = getRewardForSum(sum);

      state.reward = { sum, rewardText, granted: true };

      if (typeof onReward === "function") {
        onReward({ sum, rewardText, firstRoll, secondRoll });
      }

      state.gameCompleted = true;
      return { ok: true, status: "rewarded", sum, rewardText };
    }

    // More than 2 rolls should not happen; ignore extras.
    return { ok: true, status: "ignored_extra_roll" };
  }

  function getSnapshot() {
    return {
      ...state,
      current: state.current ? { ...state.current } : null,
      rolls: [...state.rolls],
      invalidEvents: [...state.invalidEvents],
      reward: state.reward ? { ...state.reward } : null,
    };
  }

  return {
    startSession,
    endSession,
    recordRoll,
    resetForRetry,
    isActive: () => !!state.active,
    getSnapshot,
  };
}
