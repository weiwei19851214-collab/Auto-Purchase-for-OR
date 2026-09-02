(function () {
  "use strict";

  const STORAGE_KEY = "orRechargePrototypeRunV2";
  const SETTINGS_KEY = "orRechargePrototypeSettingsV2";

  const phases = [
    { ratio: 0.14, name: "打开 AdsPower", message: "模拟连接浏览器资料" },
    { ratio: 0.28, name: "身份校验", message: "模拟核对 OpenRouter 账号" },
    { ratio: 0.44, name: "Billing", message: "模拟确认美国地址" },
    { ratio: 0.6, name: "Card", message: "模拟检查卡片分配" },
    { ratio: 0.76, name: "Purchase Credits", message: "正常模式原型，不提交付款" },
    { ratio: 0.9, name: "Auto top-up", message: "模拟回读 100 / 150" },
    { ratio: 1, name: "OPOM 写回", message: "模拟写入本地结果记录" }
  ];

  const $ = (selector) => document.querySelector(selector);

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

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest}s`;
  }

  function deriveTask(task, run, now) {
    const elapsed = Math.max(0, Math.floor((now - run.startedAt) / 1000));
    const relative = elapsed - task.offsetSeconds;
    if (relative < 0) {
      return {
        status: "queued",
        statusText: "排队",
        stage: "等待调度",
        elapsed: 0,
        message: "等待前序子任务完成",
        progress: 0
      };
    }
    if (relative < task.durationSeconds) {
      const ratio = relative / task.durationSeconds;
      const phase = phases.find((item) => ratio <= item.ratio) || phases[phases.length - 1];
      const modeMessage = phase.name === "Purchase Credits"
        ? "正常模式原型，不提交付款"
        : phase.message;
      return {
        status: "running",
        statusText: "执行中",
        stage: phase.name,
        elapsed: relative,
        message: modeMessage,
        progress: Math.max(0, Math.min(1, ratio))
      };
    }
    if (task.plannedOutcome === "blocked") {
      return {
        status: "blocked",
        statusText: "人工阻断",
        stage: "保留现场",
        elapsed: task.durationSeconds,
        message: "模拟安全阻断，等待人工确认",
        progress: 1
      };
    }
    if (task.plannedOutcome === "failed") {
      return {
        status: "failed",
        statusText: "失败",
        stage: "结果校验",
        elapsed: task.durationSeconds,
        message: "模拟响应判断失败，可从本行继续",
        progress: 1
      };
    }
    return {
      status: "done",
      statusText: "完成",
      stage: "闭环完成",
      elapsed: task.durationSeconds,
      message: "模拟完成并写入本地结果",
      progress: 1
    };
  }

  function statusPill(status, text) {
    const kind = status === "done" ? "done" : status === "running" ? "running" : status === "queued" ? "queued" : status;
    return `<span class="pill ${kind}">${text}</span>`;
  }

  function renderEmpty() {
    $("#runCaption").textContent = "模拟 run";
    $("#runTitle").textContent = "没有可显示的 run";
    $("#executionBody").innerHTML = `
      <tr>
        <td colspan="7">返回准备页确认后，会在这里显示所有子任务状态。</td>
      </tr>
    `;
    $("#summaryDone").textContent = "0";
    $("#summaryRunning").textContent = "0";
    $("#summaryBlocked").textContent = "0";
    $("#summaryElapsed").textContent = "0s";
    $("#progressFill").style.width = "0%";
    $("#progressLabel").textContent = "整体进度 0%";
  }

  function render() {
    const run = readRun();
    if (!run || !Array.isArray(run.tasks)) {
      renderEmpty();
      return;
    }

    const now = Date.now();
    const elapsed = Math.max(0, Math.floor((now - run.startedAt) / 1000));
    const derived = run.tasks.map((task) => ({ task, view: deriveTask(task, run, now) }));
    const done = derived.filter((item) => item.view.status === "done").length;
    const running = derived.filter((item) => item.view.status === "running").length;
    const blocked = derived.filter((item) => ["blocked", "failed"].includes(item.view.status)).length;
    const progress = run.tasks.length
      ? Math.round((derived.reduce((sum, item) => sum + item.view.progress, 0) / run.tasks.length) * 100)
      : 0;

    $("#runCaption").textContent = "正常模式 · 原型";
    $("#runTitle").textContent = `${run.id} · ${run.tasks.length} 个子任务`;
    $("#summaryDone").textContent = String(done);
    $("#summaryRunning").textContent = String(running);
    $("#summaryBlocked").textContent = String(blocked);
    $("#summaryElapsed").textContent = formatDuration(elapsed);
    $("#progressFill").style.width = `${progress}%`;
    $("#progressLabel").textContent = `整体进度 ${progress}%`;

    $("#executionBody").innerHTML = derived.map(({ task, view }) => `
      <tr>
        <td>${statusPill(view.status, view.statusText)}</td>
        <td>${task.opom}</td>
        <td><span class="account-cell"><strong>${task.account}</strong><small>${task.adsPowerId}</small></span></td>
        <td>${view.stage}</td>
        <td>${formatDuration(view.elapsed)}</td>
        <td>${view.message}</td>
        <td>正常模式 · 原型</td>
      </tr>
    `).join("");
  }

  function restartRun() {
    const run = readRun();
    if (!run) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...run, id: `mock-run-${Date.now()}`, startedAt: Date.now() }));
    render();
  }

  function setContrast(enabled) {
    document.body.classList.toggle("high-contrast", enabled);
    $("#contrastButton").setAttribute("aria-pressed", String(enabled));
    writeSettings({ ...readSettings(), highContrast: enabled });
  }

  $("#refreshButton").addEventListener("click", render);
  $("#restartButton").addEventListener("click", restartRun);
  $("#contrastButton").addEventListener("click", () => setContrast(!document.body.classList.contains("high-contrast")));

  const settings = readSettings();
  if (settings.highContrast) setContrast(true);
  render();
  window.setInterval(render, 1000);
})();
