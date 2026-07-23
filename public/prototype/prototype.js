(function () {
  "use strict";

  const STORAGE_KEY = "orRechargePrototypeRunV2";
  const SETTINGS_KEY = "orRechargePrototypeSettingsV2";

  const rows = [
    { id: "OPOM-MOCK-1001", account: "ada.chen@example.test", health: "ok", healthText: "ok", browser: "Mock 1201", adsPowerId: "a7k2m9qa", billing: "ready", card: "Card 01", ready: true },
    { id: "OPOM-MOCK-1002", account: "ben.lin@example.test", health: "ok", healthText: "ok", browser: "Mock 1202", adsPowerId: "b8n4q1tc", billing: "ready", card: "Card 02", ready: true },
    { id: "OPOM-MOCK-1003", account: "cara.wu@example.test", health: "ok", healthText: "completed", browser: "Mock 1203", adsPowerId: "c5r7x0mv", billing: "ready", card: "Card 03", ready: true },
    { id: "OPOM-MOCK-1004", account: "dan.park@example.test", health: "ok", healthText: "ok", browser: "Mock 1204", adsPowerId: "d1p8s6hk", billing: "ready", card: "Card 04", ready: true },
    { id: "OPOM-MOCK-1005", account: "erin.sato@example.test", health: "warn", healthText: "local_selector", browser: "Mock 1205", adsPowerId: "e4t2l9za", billing: "ready", card: "Card 05", ready: true },
    { id: "OPOM-MOCK-1006", account: "finn.ross@example.test", health: "ok", healthText: "ok", browser: "Mock 1206", adsPowerId: "f6m3v8ny", billing: "ready", card: "Card 06", ready: true },
    { id: "OPOM-MOCK-1007", account: "gina.hale@example.test", health: "ok", healthText: "ok", browser: "Mock 1207", adsPowerId: "g9w5c2rb", billing: "ready", card: "Card 07", ready: true },
    { id: "OPOM-MOCK-1008", account: "hugo.ma@example.test", health: "ok", healthText: "ok", browser: "Mock 1208", adsPowerId: "h3z6k4qp", billing: "ready", card: "Card 08", ready: true },
    { id: "OPOM-MOCK-1009", account: "iris.tan@example.test", health: "warn", healthText: "review", browser: "Mock 1209", adsPowerId: "i2y7d5xs", billing: "ready", card: "Card 09", ready: true },
    { id: "OPOM-MOCK-1010", account: "jules.ng@example.test", health: "bad", healthText: "missing billing", browser: "Mock 1210", adsPowerId: "j7a1n8bd", billing: "missing", card: "Card 10", blocker: "billing" },
    { id: "OPOM-MOCK-1011", account: "kai.moore@example.test", health: "bad", healthText: "no profile", browser: "Unmatched", adsPowerId: "pending", billing: "ready", card: "Card 11", blocker: "ads" },
    { id: "OPOM-MOCK-1012", account: "lena.ford@example.test", health: "ok", healthText: "ok", browser: "Mock 1212", adsPowerId: "l8q2r6we", billing: "ready", card: "Card 12", ready: true }
  ];

  const state = {
    sourceMode: "csv",
    opomLoaded: false,
    selected: new Set(rows.filter((row) => row.ready).map((row) => row.id)),
    executionWindow: null,
    lastFocus: null,
    activeLayer: null
  };

  const $ = (selector) => document.querySelector(selector);

  function numberValue(selector, fallback) {
    const value = Number($(selector)?.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function writeSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function readRun() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }

  function writeRun(run) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  }

  function runIsActive(run) {
    if (!run || !run.startedAt || !Array.isArray(run.tasks) || run.tasks.length === 0) return false;
    const elapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    return run.tasks.some((task) => elapsed < task.offsetSeconds + task.durationSeconds);
  }

  function summarizeRun(run) {
    if (!run || !run.startedAt || !Array.isArray(run.tasks) || run.tasks.length === 0) {
      return { active: false, terminal: 0, total: 0 };
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    const terminal = run.tasks.filter((task) => elapsed >= task.offsetSeconds + task.durationSeconds).length;
    return { active: terminal < run.tasks.length, terminal, total: run.tasks.length };
  }

  function statusPill(kind, text) {
    return `<span class="pill ${kind}">${text}</span>`;
  }

  function rechargeRule() {
    const threshold = numberValue("#balanceThreshold", 145);
    const lowAmount = numberValue("#balanceLowAmount", 150);
    const highAmount = numberValue("#balanceHighAmount", 20);
    return {
      threshold,
      lowAmount,
      highAmount,
      fixed: lowAmount === highAmount
    };
  }

  function rechargeAmountForBalance(balance) {
    const rule = rechargeRule();
    return balance < rule.threshold ? rule.lowAmount : rule.highAmount;
  }

  function ruleText() {
    const rule = rechargeRule();
    return `${rule.threshold}/${rule.lowAmount}/${rule.highAmount}`;
  }

  function autoTopupText() {
    if ($("#onlyAutoTopupToggle").checked) return "仅开启";
    return `${numberValue("#autoTopupThreshold", 100)} / ${numberValue("#autoTopupAmount", 150)}`;
  }

  function importedRows() {
    if (state.sourceMode !== "opom") return rows;
    if (!state.opomLoaded) return [];
    const limit = Math.max(1, Math.min(200, numberValue("#opomLimit", 50)));
    return rows.slice(0, limit);
  }

  function isRowReady(row) {
    if (row.blocker === "billing") return false;
    if (row.blocker === "ads") return $("#skipAdsMatchToggle").checked;
    return true;
  }

  function cardText(row) {
    return $("#cardFile").files?.length ? row.card : "不替换";
  }

  function matchText(row) {
    return row.blocker === "ads" && !$("#skipAdsMatchToggle").checked ? "报错" : "成功";
  }

  function renderTable() {
    const activeRows = importedRows();
    if (state.sourceMode === "opom" && !state.opomLoaded) {
      $("#tableTitle").textContent = "等待获取 OPOM 账号";
      $("#matchBody").innerHTML = '<tr><td class="table-empty" colspan="10">确认参数后获取 OPOM 模拟账号</td></tr>';
      renderCounts();
      return;
    }

    $("#tableTitle").textContent = state.sourceMode === "opom"
      ? `已获取 ${activeRows.length} 条 OPOM 模拟账号 · 上限 ${numberValue("#opomLimit", 50)}`
      : `${activeRows.length} 行 example.test 模拟账号`;

    $("#matchBody").innerHTML = activeRows.map((row) => {
      const checked = state.selected.has(row.id);
      const ready = isRowReady(row);
      const matchKind = row.blocker === "ads" && !$("#skipAdsMatchToggle").checked ? "bad" : "ok";
      const billingKind = row.billing === "ready" ? "ok" : "bad";
      const cardKind = cardText(row) === "missing" ? "bad" : "ok";
      return `
        <tr>
          <td><label class="check-hit"><input class="row-check" type="checkbox" data-row-id="${row.id}" ${checked ? "checked" : ""} ${ready ? "" : "disabled"} /><span class="sr-only">选择 ${row.id}</span></label></td>
          <td><strong>${row.account}</strong></td>
          <td>${statusPill(row.health, row.healthText)}</td>
          <td>${$("#skipAdsMatchToggle").checked && row.blocker === "ads" ? "人工确认" : row.browser}</td>
          <td>${$("#skipAdsMatchToggle").checked && row.blocker === "ads" ? "confirmed" : row.adsPowerId}</td>
          <td>${statusPill(matchKind, matchText(row))}</td>
          <td>${ruleText()}</td>
          <td>${autoTopupText()}</td>
          <td>${statusPill(billingKind, `${$("#stateSelect").value} · ${row.billing}`)}</td>
          <td>${statusPill(cardKind, cardText(row))}</td>
        </tr>
      `;
    }).join("");

    document.querySelectorAll(".row-check").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          state.selected.add(input.dataset.rowId);
        } else {
          state.selected.delete(input.dataset.rowId);
        }
        renderCounts();
      });
    });
    renderCounts();
  }

  function renderCounts() {
    const activeRows = importedRows();
    const ready = activeRows.filter(isRowReady).length;
    const selected = [...state.selected].filter((id) => {
      const row = activeRows.find((item) => item.id === id);
      return row && isRowReady(row);
    }).length;
    const blocked = activeRows.length - ready;
    $("#readyCount").textContent = String(ready);
    $("#selectedCount").textContent = String(selected);
    $("#blockedCount").textContent = String(blocked);
    $("#startButton").disabled = selected === 0;
  }

  function renderControls() {
    const onlyAutoTopup = $("#onlyAutoTopupToggle").checked;
    const skipAdsMatch = $("#skipAdsMatchToggle").checked;
    $("#opomSourceFields").hidden = state.sourceMode !== "opom";
    $("#csvSourceFields").hidden = state.sourceMode !== "csv";
    $("#autoTopupThreshold").disabled = onlyAutoTopup;
    $("#autoTopupAmount").disabled = onlyAutoTopup;
    $("#ruleSummary").textContent = ruleText();
    $("#autoTopupSummary").textContent = autoTopupText();
    $("#matchButton").disabled = skipAdsMatch;
    $("#matchButton").textContent = skipAdsMatch ? "已跳过匹配" : "匹配 AdsPower";
    renderTable();
  }

  function renderWorker() {
    const run = readRun();
    const summary = summarizeRun(run);
    $("#workerLabel").textContent = summary.active
      ? `Worker 执行中 ${summary.terminal}/${summary.total}`
      : run
        ? `Worker 已完成 ${summary.total}/${summary.total}`
        : "Worker 空闲";
    $("#workerButton").classList.toggle("is-running", summary.active);
  }

  function renderRecords() {
    const run = readRun();
    if (!run) {
      $("#recordList").innerHTML = '<article class="record-item"><strong>暂无任务</strong><span>确认开始后会生成本地模拟 run。</span></article>';
      $("#openExecutionFromDrawer").disabled = true;
      return;
    }
    const started = new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false });
    const active = runIsActive(run);
    $("#recordList").innerHTML = `
      <article class="record-item">
        <strong>${run.id}</strong>
        <span>${started}</span>
        <span>${active ? "执行中" : "已按 elapsed 推演完成"} · ${run.tasks.length} 个子任务 · 正常模式 · 原型</span>
      </article>
    `;
    $("#openExecutionFromDrawer").disabled = false;
  }

  function setSourceMode(mode) {
    state.sourceMode = mode;
    state.opomLoaded = false;
    if (mode === "opom") {
      $("#onlyAutoTopupToggle").checked = true;
      $("#skipAdsMatchToggle").checked = true;
      state.selected = new Set();
      $("#opomLoadStatus").textContent = "尚未获取";
      $("#loadOpomButton").textContent = "确认获取";
    } else {
      $("#onlyAutoTopupToggle").checked = false;
      $("#skipAdsMatchToggle").checked = false;
      state.selected = new Set(rows.filter(isRowReady).map((row) => row.id));
    }
    document.querySelectorAll("[data-source-mode]").forEach((button) => {
      const selected = button.dataset.sourceMode === mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    renderControls();
  }

  function buildRun() {
    const selectedRows = importedRows().filter((row) => isRowReady(row) && state.selected.has(row.id));
    const rule = rechargeRule();
    return {
      id: `mock-run-${Date.now()}`,
      startedAt: Date.now(),
      mode: "live",
      modeLabel: "正常模式 · 原型",
      sourceMode: state.sourceMode,
      opomGroup: $("#opomGroup").value,
      opomStatus: $("#opomStatus").value,
      opomLimit: numberValue("#opomLimit", 50),
      concurrency: Math.max(1, Math.min(10, numberValue("#taskConcurrency", 1))),
      ruleMode: "balance_threshold",
      rule,
      ruleText: ruleText(),
      autoTopup: true,
      autoTopupText: autoTopupText(),
      onlyAutoTopup: $("#onlyAutoTopupToggle").checked,
      skipAdsMatch: $("#skipAdsMatchToggle").checked,
      cardMode: $("#cardFile").files?.length ? "replace" : "keep",
      writeback: true,
      tasks: selectedRows.map((row, index) => {
        const plannedOutcome = index === selectedRows.length - 1 ? "blocked" : index === 4 ? "failed" : "completed";
        const simulatedBalance = index % 2 === 0 ? rule.threshold - 1 : rule.threshold;
        const rechargeAmount = rechargeAmountForBalance(simulatedBalance);
        return {
          opom: row.id,
          account: row.account,
          adsPowerId: row.adsPowerId,
          offsetSeconds: index * 9,
          durationSeconds: 44 + (index % 3) * 5,
          simulatedBalance,
          rechargeAmount,
          rechargeSkipped: rechargeAmount === 0,
          plannedOutcome
        };
      })
    };
  }

  function openExecution() {
    if (readRun()) {
      if (state.executionWindow && !state.executionWindow.closed) {
        state.executionWindow.focus();
        return;
      }
      state.executionWindow = window.open("./execution.html", "_blank");
      state.executionWindow?.focus();
    }
  }

  function showConfirmation() {
    const selectedReady = importedRows().filter((row) => isRowReady(row) && state.selected.has(row.id)).length;
    if (selectedReady === 0) return;
    $("#confirmMode").textContent = "正常模式 · 原型";
    $("#confirmTasks").textContent = String(selectedReady);
    $("#confirmRule").textContent = ruleText();
    openLayer($("#confirmSheet"), $("#confirmBackdrop"));
  }

  function openLayer(element, backdrop) {
    state.lastFocus = document.activeElement;
    state.activeLayer = { element, backdrop };
    element.hidden = false;
    backdrop.hidden = false;
    document.querySelector(".app-shell").inert = true;
    element.querySelector("button, input, a, [tabindex]")?.focus();
  }

  function closeLayer() {
    if (!state.activeLayer) return;
    state.activeLayer.element.hidden = true;
    state.activeLayer.backdrop.hidden = true;
    document.querySelector(".app-shell").inert = false;
    state.activeLayer = null;
    state.lastFocus?.focus();
  }

  function setContrast(enabled) {
    document.body.classList.toggle("high-contrast", enabled);
    $("#contrastButton").setAttribute("aria-pressed", String(enabled));
    writeSettings({ ...readSettings(), highContrast: enabled });
  }

  function bindRadioGroup(selector, dataKey, callback) {
    const buttons = [...document.querySelectorAll(selector)];
    buttons.forEach((button) => {
      button.addEventListener("click", () => callback(button.dataset[dataKey]));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = buttons.indexOf(button);
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
        callback(buttons[next].dataset[dataKey]);
      });
    });
  }

  function bindFileTrigger(buttonSelector, inputSelector, labelSelector, labels) {
    const button = $(buttonSelector);
    const input = $(inputSelector);
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      $(labelSelector).textContent = input.files?.length ? labels.selected : labels.empty;
      renderControls();
    });
  }

  function markOpomDirty() {
    if (state.sourceMode !== "opom") return;
    state.opomLoaded = false;
    $("#loadOpomButton").textContent = "确认获取";
    $("#opomLoadStatus").textContent = "参数已变更";
    renderControls();
  }

  bindRadioGroup("[data-source-mode]", "sourceMode", setSourceMode);
  bindFileTrigger("#accountFileButton", "#accountFile", "#accountFileLabel", { selected: "已选择", empty: "未选择" });
  bindFileTrigger("#cardFileButton", "#cardFile", "#cardFileLabel", { selected: "替换卡片", empty: "不替换卡片" });

  [
    "#balanceThreshold",
    "#balanceLowAmount",
    "#balanceHighAmount",
    "#autoTopupThreshold",
    "#autoTopupAmount",
    "#onlyAutoTopupToggle",
    "#skipAdsMatchToggle",
    "#taskConcurrency",
    "#stateSelect"
  ].forEach((selector) => {
    $(selector).addEventListener("change", renderControls);
    $(selector).addEventListener("input", renderControls);
  });

  ["#opomGroup", "#opomStatus", "#opomLimit"].forEach((selector) => {
    $(selector).addEventListener("change", markOpomDirty);
    $(selector).addEventListener("input", markOpomDirty);
  });

  $("#selectReadyButton").addEventListener("click", () => {
    state.selected = new Set(importedRows().filter(isRowReady).map((row) => row.id));
    renderTable();
  });
  $("#loadOpomButton").addEventListener("click", () => {
    const group = $("#opomGroup").value.trim();
    if (!group) {
      $("#opomLoadStatus").textContent = "请输入 Group";
      $("#opomGroup").focus();
      return;
    }
    const limit = Math.max(1, Math.min(200, numberValue("#opomLimit", 50)));
    $("#opomLimit").value = String(limit);
    state.opomLoaded = true;
    state.selected = new Set(importedRows().filter(isRowReady).map((row) => row.id));
    $("#loadOpomButton").textContent = `已获取 ${importedRows().length} 条`;
    $("#opomLoadStatus").textContent = `模拟 · 上限 ${limit}`;
    renderControls();
  });
  $("#resetButton").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    setSourceMode("csv");
    state.opomLoaded = false;
    $("#opomGroup").value = "VIP";
    $("#opomStatus").value = "card_switch&overdue";
    $("#opomLimit").value = "50";
    $("#loadOpomButton").textContent = "确认获取";
    $("#opomLoadStatus").textContent = "尚未获取";
    $("#balanceThreshold").value = "145";
    $("#balanceLowAmount").value = "150";
    $("#balanceHighAmount").value = "20";
    $("#autoTopupThreshold").value = "100";
    $("#autoTopupAmount").value = "150";
    $("#taskConcurrency").value = "1";
    $("#onlyAutoTopupToggle").checked = false;
    $("#skipAdsMatchToggle").checked = false;
    $("#accountFile").value = "";
    $("#cardFile").value = "";
    $("#accountFileLabel").textContent = "未选择";
    $("#cardFileLabel").textContent = "不替换卡片";
    renderControls();
    renderWorker();
  });
  $("#startButton").addEventListener("click", showConfirmation);
  $("#cancelStart").addEventListener("click", closeLayer);
  $("#confirmBackdrop").addEventListener("click", closeLayer);
  $("#confirmStart").addEventListener("click", () => {
    writeRun(buildRun());
    closeLayer();
    openExecution();
  });
  $("#workerButton").addEventListener("click", openExecution);
  $("#recordsButton").addEventListener("click", () => {
    renderRecords();
    openLayer($("#taskDrawer"), $("#drawerBackdrop"));
  });
  $("#closeDrawer").addEventListener("click", closeLayer);
  $("#drawerBackdrop").addEventListener("click", closeLayer);
  $("#openExecutionFromDrawer").addEventListener("click", openExecution);
  $("#matchButton").addEventListener("click", () => {
    if ($("#skipAdsMatchToggle").checked) return;
    $("#matchButton").textContent = "已匹配 11 / 12";
  });
  $("#contrastButton").addEventListener("click", () => setContrast(!document.body.classList.contains("high-contrast")));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.activeLayer) {
      closeLayer();
      return;
    }
    if (event.key !== "Tab" || !state.activeLayer) return;
    const focusable = [...state.activeLayer.element.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const settings = readSettings();
  if (settings.highContrast) setContrast(true);
  setSourceMode(state.sourceMode);
  renderWorker();
  window.setInterval(renderWorker, 1000);
  window.addEventListener("storage", renderWorker);
  document.addEventListener("visibilitychange", renderWorker);
})();
