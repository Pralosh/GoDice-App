// js/dice.js
// Owns GoDice connection + per-die state, inactivity timers, and dice UI cards/faces.
// Does NOT own session rules (state.js) or history/export UI.

export function createDiceController({
  INACTIVITY_MS,
  connectBtn,
  diceListEl,
  diceFacesEl,

  // Callbacks provided by main.js
  isSessionActive, // () => boolean
  isRetryModalOpen, // () => boolean
  onRoll, // (diceId, dieLabel, face) => void

  // Optional knobs
  ledPulseRgb = [82, 14, 125],
  afterConnectDelayMs = 2000,
} = {}) {
  if (!connectBtn)
    throw new Error("createDiceController: connectBtn is required");
  if (!diceListEl)
    throw new Error("createDiceController: diceListEl is required");
  if (!diceFacesEl)
    throw new Error("createDiceController: diceFacesEl is required");
  if (typeof isSessionActive !== "function") {
    throw new Error(
      "createDiceController: isSessionActive() callback is required"
    );
  }
  if (typeof isRetryModalOpen !== "function") {
    throw new Error(
      "createDiceController: isRetryModalOpen() callback is required"
    );
  }
  if (typeof onRoll !== "function") {
    throw new Error(
      "createDiceController: onRoll(diceId, dieLabel, face) callback is required"
    );
  }
  if (typeof INACTIVITY_MS !== "number") {
    throw new Error("createDiceController: INACTIVITY_MS (number) is required");
  }

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

  let nextLabel = labelGen();

  function resetLabelGen() {
    nextLabel = labelGen();
  }

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

  function updateConnectButtonLabel() {
    if (!diceListEl) return;
    connectBtn.textContent =
      diceListEl.children.length === 0 ? "Connect Die" : "Connect Another Die";
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
    diceListEl.appendChild(root);

    return { root, title, status, battery, roll };
  }

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
    diceFacesEl.appendChild(root);

    return { root, valueEl, textUnder };
  }

  // diceId -> { inst, label, els, faceEls, queue, ready, batteryRequested, ledPulsed, lastActive, timer }
  const diceState = new Map();

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
        if (st.faceEls?.root?.parentNode)
          st.faceEls.root.parentNode.removeChild(st.faceEls.root);

        updateConnectButtonLabel();
      }
    });
  }

  function clearAllDiceUI() {
    diceListEl.innerHTML = "";
    diceFacesEl.innerHTML = "";
    diceState.clear();
    updateConnectButtonLabel();
  }

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
          if (st.faceEls?.root?.parentNode)
            st.faceEls.root.parentNode.removeChild(st.faceEls.root);
        }
      });
    });

    // Reset labels so next game starts at Dice A again
    resetLabelGen();
    updateConnectButtonLabel();
  }

  function resetForNewSessionUI() {
    // mirrors current main.js behavior: reset labels + clear UI
    resetLabelGen();
    clearAllDiceUI();
  }

  // --- GoDice wiring ---
  // NOTE: GoDice is expected to be available globally (as in your current setup).
  const goDice = new GoDice();

  // Suppress harmless init races
  window.addEventListener("unhandledrejection", (e) => {
    const msg = (e && e.reason && e.reason.message) || String(e.reason || "");
    if (/GATT operation already in progress/i.test(msg)) {
      e.preventDefault();
      console.debug("[suppressed] library init race:", msg);
    }
  });

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

    await sleep(afterConnectDelayMs);
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

    setDieStatus(st, "Connected", { muted: false });
    st.els.battery.textContent = `Battery: ${level}%`;
    markActive(diceId);

    if (!st.ledPulsed && st.ready) {
      st.ledPulsed = true;
      st.queue(async () => {
        await sleep(400);
        await withGattRetry(() => st.inst.pulseLed(3, 15, 15, ledPulseRgb));
      });
    }
  };

  GoDice.prototype.onStable = (diceId, value /*, acc */) => {
    const st = diceState.get(diceId);
    if (!st) return;

    setDieStatus(st, "Connected", { muted: false });

    // While retry modal is open:
    // - do NOT update UI
    // - do NOT call onRoll
    // - only mark active to avoid inactivity removal
    // While retry modal OR BT chooser is open:
    // - do NOT update UI
    // - do NOT call onRoll
    // - only mark active to avoid inactivity removal
    if (isRetryModalOpen() || pickerOpen) {
      console.log("[ROLL IGNORED UI]", {
        reason: isRetryModalOpen() ? "retry_modal" : "bt_picker_open",
        diceId,
        value,
      });
      markActive(diceId);
      return;
    }

    st.els.roll.textContent = `Last roll: ${value}`;
    markActive(diceId);

    if (st.faceEls) {
      st.faceEls.valueEl.textContent = `${value}`;
      st.faceEls.textUnder.textContent = `Last roll: ${value}`;
    }

    onRoll(diceId, st.label, value);
  };

  GoDice.prototype.onDiceDisconnected = (diceId) => {
    const st = diceState.get(diceId);
    if (!st) return;

    setDieStatus(st, "Disconnected", { muted: true });
    if (st.timer) clearTimeout(st.timer);

    console.log(`[${st.label}] disconnected`);
  };

  let connecting = false;
  let pickerOpen = false; // suppress rool UI + recording while BT chooser is open

  async function connectNewDie() {
    if (connecting) return;

    if (!isSessionActive()) {
      alert("Start a game session first.");
      return;
    }

    connecting = true;
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting…";

    try {
      pickerOpen = true;
      await goDice.requestDevice();
    } catch (e) {
      alert("Connection failed: " + ((e && e.message) || e));
      connectBtn.disabled = false;
      updateConnectButtonLabel();
    } finally {
      pickerOpen = false;
      connecting = false;
    }
  }

  // Initialize labels/buttons at creation time
  updateConnectButtonLabel();

  return {
    connectNewDie,
    disconnectAllDice,
    clearAllDiceUI,
    resetForNewSessionUI,

    // Expose for debugging if ever needed
    _diceState: diceState,
  };
}
