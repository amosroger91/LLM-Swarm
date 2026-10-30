const $ = (selector) => document.querySelector(selector);
let token = $('meta[name="swarm-token"]').content;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const short = (value, limit = 90) =>
  String(value ?? "").length > limit ? `${String(value).slice(0, limit)}…` : String(value ?? "");
const date = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const compact = (value) =>
  value == null
    ? "—"
    : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const duration = (ms) =>
  ms < 60000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const badge = (status) =>
  `<span class="badge ${escape(status)}"><i></i>${escape(status.replaceAll("_", " "))}</span>`;
const icon = (name) => ({ tasks: "▤", workers: "◈", blockers: "⚑", tokens: "⌁" })[name] ?? "·";
let state,
  detail,
  providers,
  view = location.hash === "#models" ? "models" : "mission",
  selected = location.hash === "#models" ? "" : location.hash.slice(1),
  tab = "overview",
  refreshing = false,
  chatting = false;
let toastTimer;
const submittingChats = new Set();
const acceptedChats = new Map();
async function api(url, input, renew = true) {
  const response = await fetch(url, {
    headers: { "x-swarm-token": token, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  if (response.status === 403 && renew && data.error === "Dashboard session token required") {
    const page = await (await fetch("/", { cache: "no-store" })).text();
    const match = /name="swarm-token" content="([^"]+)"/.exec(page);
    if (match) {
      token = match[1];
      return api(url, input, false);
    }
  }
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6500);
}
function jobUrl(action) {
  return `/api/jobs/${encodeURIComponent(selected)}${action ? `/${action}` : ""}`;
}
function choose(id) {
  view = "mission";
  selected = id;
  location.hash = id;
  detail = undefined;
  void refresh();
}
function renderJobs() {
  const query = $("#filter-jobs").value.toLowerCase();
  $("#job-count").textContent = state.jobs.length;
  $("#jobs").innerHTML =
    state.jobs
      .filter((job) => `${job.task} ${job.repoPath}`.toLowerCase().includes(query))
      .map((job) => {
        const total = Object.values(job.counts).reduce((sum, value) => sum + value, 0);
        const done = job.counts.done + job.counts.review;
        const project = job.repoPath.split(/[\\/]/).at(-1);
        return `<button class="job-item ${job.id === selected ? "selected" : ""}" data-job="${escape(job.id)}"><div class="job-item-top"><span class="project-icon">${escape(project.slice(0, 1).toUpperCase())}</span><span class="job-project">${escape(project)}</span><i class="job-state ${escape(job.status)}"></i></div><strong>${escape(short(job.goal ?? job.task, 73))}</strong><div class="job-item-meta"><span>${escape(job.status.replaceAll("_", " "))}</span><span>${done}/${total} tasks</span></div><progress max="${total || 1}" value="${done}"></progress>${job.blockers ? `<span class="sidebar-blocker">${job.blockers} blocker${job.blockers === 1 ? "" : "s"} recorded</span>` : ""}</button>`;
      })
      .join("") || '<p class="sidebar-empty">No matching missions.</p>';
}
function taskCards() {
  const columns = [
    ["ready", "Queued"],
    ["running", "In progress"],
    ["review", "Ready for review"],
    ["done", "Completed"],
    ["blocked", "Blocked / failed"],
  ];
  return `<div class="task-board">${columns
    .map(([status, label]) => {
      const tasks = detail.tasks.filter((task) =>
        status === "blocked"
          ? ["blocked", "failed", "cancelled"].includes(task.status)
          : status === "review"
            ? ["review", "revision"].includes(task.status)
            : task.status === status,
      );
      return `<section class="board-column"><h3><i class="column-dot ${status}"></i>${label}<span>${tasks.length}</span></h3>${tasks.map((task) => `<button class="task-card" data-task="${escape(task.id)}"><div class="task-card-id">${escape(task.stableId)} <span>${escape(task.kind)}</span></div><h4>${escape(task.title)}</h4><div class="task-files">${escape(short(task.fileAreas.join(", ") || "Integrated revision", 75))}</div><div class="task-card-bottom">${badge(task.status)}<span>↻ ${task.attemptCount}/${task.maxAttempts}</span></div></button>`).join("") || '<div class="empty-column">Nothing here yet</div>'}</section>`;
    })
    .join("")}</div>`;
}
function blockers() {
  const items = detail.status.blockers.filter((item) => item.status !== "resolved");
  const questions = detail.decisions.filter(
    (decision) => decision.status === "open" && decision.blocking,
  );
  if (!items.length && !questions.length && !detail.job.error)
    return '<div class="clear-state"><span>✓</span><div><strong>No active blockers</strong><p>The coordinator will surface repeated failures, stalled work, and questions here.</p></div></div>';
  return `<section class="blocker-section"><div class="section-title"><span class="orange-dot"></span><h2>Needs attention</h2><span>${items.length} blockers · ${questions.length} questions</span></div>${detail.job.error ? `<div class="job-error">${escape(detail.job.error)}</div>` : ""}${items.map((item) => `<article class="blocker-card"><div>${badge(item.status)}<span class="muted">${escape(item.category)} · seen ${item.occurrences}×</span></div><h3>${escape(item.summary)}</h3><p><strong>Next action</strong> ${escape(item.nextAction)}</p><details><summary>Evidence & attempted fixes</summary><pre>${escape(item.details)}\n\n${escape(item.attempts.join("\n"))}</pre></details></article>`).join("")}${questions.map((question) => `<form class="decision-form" data-decision="${escape(question.id)}"><div class="question-label">${question.ownerRole === "human" ? "YOUR ANSWER IS NEEDED" : "PLANNER QUESTION"}</div><h3>${escape(question.question)}</h3>${question.context ? `<p>${escape(question.context)}</p>` : ""}<div class="decision-inputs"><select name="option" aria-label="Decision answer">${question.options.map((option) => `<option value="${escape(option)}">${escape(option)}</option>`).join("")}</select><input name="rationale" placeholder="Give the guidance that will unblock the task…" required maxlength="4000"><button class="primary" type="submit">Send answer →</button></div></form>`).join("")}</section>`;
}
function timeline(events = detail.events.slice(-18)) {
  return `<div class="timeline">${
    [...events]
      .reverse()
      .map(
        (event) =>
          `<article><span class="timeline-dot ${event.type.includes("fail") || event.type.includes("blocker") ? "warning" : ""}"></span><time>${date(event.createdAt)}</time><div><strong>${escape(event.type.replaceAll(".", " · ").replaceAll("_", " "))}</strong><p>${escape(short(JSON.stringify(event.payload), 180))}</p></div></article>`,
      )
      .join("") || '<p class="muted">Events will appear as the mission progresses.</p>'
  }</div>`;
}
function overview() {
  const active = detail.runs.filter((run) => ["running", "queued"].includes(run.status));
  return `${blockers()}<div class="overview-grid"><section class="panel"><div class="section-title"><h2>Agent activity</h2><span>${active.length} active</span></div>${
    active.length
      ? active
          .map((run) => {
            const task = detail.tasks.find((item) => item.id === run.taskId);
            return `<div class="worker-row"><span class="worker-avatar">◈</span><div><strong>${escape(task?.stableId ?? run.role)}</strong><p>${escape(short(task?.title ?? "Working", 70))}</p></div><span class="working-indicator">Working<span> · ${duration(Date.now() - Date.parse(run.startedAt))}</span></span></div>`;
          })
          .join("")
      : '<div class="panel-empty"><span>◈</span><p>No agents executing right now.<br>Queued work starts when dependencies are ready.</p></div>'
  }<div class="supervisor-note"><span class="live-dot"></span><div><strong>${state.maintenance.enabled ? "Goal supervisor is on" : "Automatic supervision is off"}</strong><p>${state.maintenance.enabled ? `Recovery sweep every ${Math.round(state.maintenance.intervalMs / 1000)}s. Answers supported questions and resumes interrupted work.` : "Use the recovery sweep button to inspect pending work."}</p></div></div></section><section class="panel"><div class="section-title"><h2>Verification</h2><span>Evidence before approval</span></div><div class="verification-row"><span>Configured checks</span><strong>${state.checkCount ? `${state.checkCount} commands` : "None configured"}</strong></div><div class="verification-row"><span>Checks required</span><strong>${state.requireChecks ? "Yes" : "No"}</strong></div><div class="verification-row"><span>Review state</span>${badge(detail.job.reviewState ?? "pending")}</div><div class="verification-row"><span>Review rounds</span><strong>${detail.reviews.length} / ${detail.job.maxReviewRounds}</strong></div>${detail.artifacts
    .filter((item) => item.kind === "checks")
    .slice(-1)
    .map((item) => `<pre class="check-evidence">${escape(short(item.summary, 500))}</pre>`)
    .join(
      "",
    )}<p class="small-note">A planner’s answer or worker’s success does not complete the mission. Checks and independent review remain the gate.</p></section></div><section class="panel recent-panel"><div class="section-title"><h2>Recent events</h2><button class="text-button" data-tab="activity">View full activity ↗</button></div>${timeline()}</section>`;
}
function tasksView() {
  const idMap = new Map(detail.tasks.map((task) => [task.id, task]));
  return `${taskCards()}<section class="panel dependency-panel"><div class="section-title"><h2>Dependency map</h2><span>Work follows the graph</span></div>${detail.tasks.map((task) => `<div class="dependency-row"><button data-task="${escape(task.id)}">${escape(task.stableId)}</button><span>←</span><div>${(detail.dependencies[task.id] ?? []).map((id) => `<button class="dependency-chip" data-task="${escape(id)}">${escape(idMap.get(id)?.stableId ?? id)}</button>`).join("") || '<span class="muted">No prerequisites</span>'}</div>${badge(task.status)}</div>`).join("")}</section>`;
}
function artifactsView() {
  return `<section class="panel"><div class="section-title"><h2>Worktrees & commits</h2><span>${detail.worktrees.length} isolated checkouts</span></div>${detail.worktrees.map((tree) => `<article class="artifact"><div><strong>${escape(tree.branchName)}</strong>${badge(tree.cleanupState)}</div><code>${escape(tree.path)}</code><p>Base ${escape(tree.baseCommit?.slice(0, 12) ?? "—")} → Head ${escape(tree.headCommit?.slice(0, 12) ?? "pending")}</p></article>`).join("") || '<p class="muted">Worktrees appear when agents begin.</p>'}</section><section class="panel artifact-panel"><div class="section-title"><h2>Recorded evidence</h2><span>${detail.artifacts.length} artifacts</span></div>${detail.artifacts.map((item) => `<details class="artifact"><summary>${escape(item.kind)} <time>${date(item.createdAt)}</time></summary><pre>${escape(item.summary)}</pre>${item.path ? `<code>${escape(item.path)}</code>` : ""}</details>`).join("")}</section>`;
}
function activityView() {
  return `<section class="panel"><div class="section-title"><h2>Event stream</h2><span>Latest 100 events</span></div>${timeline(detail.events)}</section><section class="panel artifact-panel"><div class="section-title"><h2>Shared messages</h2><span>Agent handoffs, questions, and findings</span></div>${[
    ...detail.messages,
  ]
    .reverse()
    .map(
      (message) =>
        `<article class="chat-bubble"><div class="chat-label">${escape(message.sender)} · ${escape(message.channel)} / ${escape(message.messageType)}<time>${date(message.createdAt)}</time></div><p>${escape(message.content)}</p></article>`,
    )
    .join("")}</section>`;
}
function renderMission() {
  if (!detail) return;
  if (document.activeElement?.closest(".decision-form")) return;
  const { job, status, tasks } = detail;
  const total = tasks.length,
    done = tasks.filter((task) => task.status === "done").length,
    implemented = tasks.filter((task) =>
      ["review", "revision", "done"].includes(task.status),
    ).length;
  const metrics = status.measurements;
  $("#project-name").textContent = job.repoPath.split(/[\\/]/).at(-1);
  $("#mission").innerHTML =
    `<section class="mission-header"><div class="mission-kicker"><span class="eyebrow">MISSION ${escape(job.id.slice(0, 8).toUpperCase())}</span>${badge(job.status)}</div><div class="mission-title"><h1>${escape(short(job.goal ?? job.task, 110))}</h1><div class="mission-actions">${["failed", "interrupted", "cancelled"].includes(job.status) ? '<button class="primary" data-action="resume">↻ Resume mission</button>' : !["completed"].includes(job.status) ? '<button class="quiet-button danger" data-action="cancel">Stop mission</button>' : '<span class="complete-label">✓ Mission complete</span>'}</div></div><details class="human-goal"><summary>Human-defined goal <span>↗</span></summary><p>${escape(detail.humanGoal)}</p></details><div class="mission-meta"><span>⌘ ${escape(job.baseBranch)}</span><span>${escape(job.configProfile ?? "default")} profile</span><span>Started ${new Date(job.createdAt).toLocaleString()}</span></div></section><section class="stats"><article><span class="stat-icon purple">${icon("tasks")}</span><div><span>Task progress</span><strong>${done}<small> / ${total}</small></strong><p>${implemented} implemented · ${total - done} to finish</p></div></article><article><span class="stat-icon blue">${icon("workers")}</span><div><span>Agents working</span><strong>${status.active_workers.length}<small> / ${job.workerCount}</small></strong><p>${status.task_counts.ready} ready in queue</p></div></article><article><span class="stat-icon orange">${icon("blockers")}</span><div><span>Needs attention</span><strong>${status.blockers.filter((item) => item.status !== "resolved").length}</strong><p>${status.pending_decisions.length} unanswered questions</p></div></article><article><span class="stat-icon green">${icon("tokens")}</span><div><span>Tokens used</span><strong>${compact(metrics.totalTokens)}</strong><p>${metrics.providerCalls} model calls · ${metrics.retries} retries</p></div></article></section><section class="progress-section"><div><span>MISSION PROGRESS</span><strong>${total ? Math.round((implemented / total) * 100) : 0}% implemented</strong></div><progress value="${implemented}" max="${total || 1}"></progress></section><nav class="view-tabs" aria-label="Mission views">${[
      ["overview", "Overview"],
      ["tasks", "Task board"],
      ["activity", "Activity"],
      ["artifacts", "Artifacts"],
    ]
      .map(
        ([id, label]) =>
          `<button class="${tab === id ? "active" : ""}" data-tab="${id}">${label}${id === "tasks" ? `<span>${total}</span>` : ""}</button>`,
      )
      .join(
        "",
      )}<span class="tab-live"><i class="live-dot"></i>LIVE STATE</span></nav><div class="tab-content">${tab === "overview" ? overview() : tab === "tasks" ? tasksView() : tab === "activity" ? activityView() : artifactsView()}</div>`;
  $("#mission .stats article:last-child div>span").textContent = "Tokens reported";
  $("#mission .stats article:last-child p").textContent =
    `${metrics.callsWithUsage}/${metrics.providerCalls} calls with usage · ${metrics.retries} retries`;
  if (status.provider_routes?.length) {
    $("#mission .progress-section").insertAdjacentHTML(
      "beforebegin",
      `<section class="panel provider-routes"><div class="section-title"><h2>Models & automatic failover</h2><span>Backups tried in order · every switch recorded in Activity</span></div><div class="provider-route-grid">${status.provider_routes
        .map((route) => {
          const last = metrics.calls.filter((call) => call.role === route.role).at(-1);
          return `<article><h3>${escape(route.role)}</h3><strong>${escape(route.primary.provider)} · ${escape(route.primary.model ?? "CLI")}</strong><p class="muted">${route.fallbacks.length ? `Backups: ${route.fallbacks.map((item) => `${escape(item.provider)} (${escape(item.model ?? "CLI")})`).join(" → ")}` : "No automatic backups configured"}</p><small>${last ? `Last reported call: ${escape(last.provider)} · ${escape(last.model ?? "CLI")}${last.error ? " · failed" : ""}` : "No completed model calls yet"}</small></article>`;
        })
        .join("")}</div></section>`,
    );
  }
  if (job.dryRun && job.status === "completed") {
    $("#mission .mission-actions").innerHTML =
      '<button class="primary" data-action="launch">Launch this plan →</button>';
    $("#mission .mission-kicker .badge").outerHTML = badge("plan_ready");
  }
  if (tab === "artifacts")
    $("#mission .tab-content").insertAdjacentHTML(
      "beforeend",
      `<section class="panel artifact-panel"><div class="section-title"><h2>Model call evidence</h2><span>${metrics.providerCalls} calls · ${duration(metrics.providerDurationMs)} total provider time</span></div>${metrics.calls
        .slice(-100)
        .map(
          (call) =>
            `<article class="artifact"><div><strong>${escape(call.role)} · ${escape(call.model ?? call.provider)}</strong><span class="muted">${duration(call.duration_ms)} · ${compact(call.total_tokens)} tokens</span></div>${call.error ? `<pre>${escape(call.error)}</pre>` : ""}</article>`,
        )
        .join("")}</section>`,
    );
}
function healthBadge(state) {
  return badge(
    state === "healthy" ? "healthy" : state === "cooling" ? "cooling_down" : "unavailable",
  );
}
function renderModels() {
  if (!providers) return;
  $("#project-name").textContent = "Models & routing";
  const totals = providers.delegate.totals;
  const rows = providers.providers
    .map(
      (item) =>
        `<article class="artifact"><div><strong>${escape(item.name)}</strong> <span class="muted">${escape(item.type)} · ${escape(item.model ?? "")}</span> ${healthBadge(item.state)}</div><p>${item.calls} calls · ${item.failures} failures · ${compact(item.inputTokens + item.outputTokens)} tokens${item.availableAt ? ` · back at ${date(item.availableAt)}` : ""}${item.lastSuccessAt ? ` · last ok ${date(item.lastSuccessAt)}` : ""}</p>${item.lastFailure ? `<pre>${escape(item.lastFailure.kind)}: ${escape(short(item.lastFailure.message, 400))}</pre>` : ""}</article>`,
    )
    .join("");
  const chains = providers.agents
    .map(
      (agent) =>
        `<div class="verification-row"><span>${escape(agent.name)} <span class="muted">${escape(agent.role)}</span></span><strong>${agent.chain.map(escape).join(" → ")}</strong></div>`,
    )
    .join("");
  const delegations = providers.delegations
    .map(
      (item) =>
        `<article class="artifact"><div><strong>${escape(item.agent)} · ${escape(item.model ?? item.provider ?? "failed")}</strong><span class="muted">${date(item.createdAt)} · ${duration(item.durationMs)} · ${compact(item.contextChars)} chars read · ${compact((item.inputTokens ?? 0) + (item.outputTokens ?? 0))} tokens</span></div>${item.failover.length ? `<p class="muted">Failed over from ${item.failover.map((f) => `${escape(f.provider)} (${escape(f.kind)})`).join(", ")}</p>` : ""}${item.error ? `<pre>${escape(short(item.error, 400))}</pre>` : ""}</article>`,
    )
    .join("");
  $("#mission").innerHTML =
    `<section class="mission-header"><div class="mission-kicker"><span class="eyebrow">ROUTING</span></div><div class="mission-title"><h1>Models &amp; routing</h1></div><p class="muted">Rate-limited, exhausted, or failing models cool down automatically and the next model in each chain takes over. A task retry after a bad result starts with a different model.</p></section><section class="stats"><article><span class="stat-icon green">⌁</span><div><span>Delegations</span><strong>${compact(totals.count)}</strong><p>offloaded tasks</p></div></article><article><span class="stat-icon blue">▤</span><div><span>Context offloaded</span><strong>${compact(totals.contextChars)}</strong><p>chars read by cheap models</p></div></article><article><span class="stat-icon purple">◈</span><div><span>Delegate tokens</span><strong>${compact(totals.inputTokens + totals.outputTokens)}</strong><p>reported by providers</p></div></article><article><span class="stat-icon orange">⚑</span><div><span>Unhealthy now</span><strong>${providers.providers.filter((item) => item.state !== "healthy").length}</strong><p>of ${providers.providers.length} providers</p></div></article></section><div class="overview-grid"><section class="panel"><div class="section-title"><h2>Provider health</h2><span>this daemon's lifetime</span></div>${rows || '<p class="muted">No providers configured.</p>'}</section><section class="panel"><div class="section-title"><h2>Failover chains</h2><span>tried left to right</span></div>${chains}</section></div><section class="panel artifact-panel"><div class="section-title"><h2>Recent delegations</h2><span>latest 30</span></div>${delegations || '<p class="muted">Nothing delegated yet. Use the delegate MCP tool from Claude Code.</p>'}</section>`;
}
let chatSignature = "";
function renderChat() {
  if (!detail) return;
  const messages =
    detail.planningMessages ??
    detail.messages.filter(
      (message) =>
        message.channel === "planning" ||
        (message.role === "planner" && message.messageType !== "proposal"),
    );
  if (acceptedChats.get(selected) === detail.plannerChat?.id) acceptedChats.delete(selected);
  chatting =
    submittingChats.has(selected) ||
    acceptedChats.has(selected) ||
    detail.plannerChat?.status === "pending";
  $("#send-message").disabled = chatting;
  const pending = $("#planner-pending");
  if (pending) {
    pending.hidden = !chatting;
    pending.textContent = chatting
      ? `Planner is working… Your message is saved.${detail.plannerChat?.status === "pending" ? ` ${Math.max(0, Math.floor((Date.now() - Date.parse(detail.plannerChat.startedAt)) / 1000))}s` : ""}`
      : "";
  }
  const signature = selected + JSON.stringify([messages, detail.proposals, detail.plannerChat]);
  if (signature === chatSignature) return;
  chatSignature = signature;
  const nearBottom =
    $("#chat-messages").scrollHeight -
      $("#chat-messages").scrollTop -
      $("#chat-messages").clientHeight <
    100;
  $("#chat-messages").innerHTML =
    messages
      .map(
        (message) =>
          `<article class="chat-bubble ${message.role === "caller" ? "human" : message.role === "system" ? "chat-error" : "agent"}"><div class="chat-label">${message.role === "caller" ? "YOU" : escape(message.sender)}<time>${date(message.createdAt)}</time></div><p>${escape(message.content)}</p></article>`,
      )
      .join("") +
      detail.proposals
        .map(
          (proposal) =>
            `<article class="proposal"><div class="proposal-heading">▤ <strong>${proposal.tasks.length} proposed tasks</strong><span>${escape(proposal.status)}</span></div>${proposal.tasks.map((task) => `<div class="proposed-task"><strong>${escape(task.title)}</strong><span>${escape(task.fileAreas.join(", "))}</span></div>`).join("")}${proposal.status === "pending" ? `<button class="primary" data-proposal="${escape(proposal.id)}" ${detail.job.status === "planning" ? "disabled" : ""}>Add tasks to mission →</button>` : '<p class="muted">✓ Tasks handed to the execution queue</p>'}</article>`,
        )
        .join("") +
      (detail.plannerChat?.status === "failed"
        ? '<button type="button" class="quiet-button" data-retry-chat>Retry last message</button>'
        : "") ||
    '<div class="chat-empty"><span>✧</span><h3>A good place to think.</h3><p>Ask about this mission, describe a change, or work through what’s blocking progress.</p></div>';
  if (nearBottom || chatting) $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api("/api/state");
    if (!selected || !state.jobs.some((job) => job.id === selected))
      selected = state.jobs[0]?.id ?? "";
    renderJobs();
    if (view === "models") {
      providers = await api("/api/providers");
      if (view === "models") renderModels();
    } else if (selected) {
      const current = selected;
      const found = await api(jobUrl());
      if (selected === current) {
        detail = found;
        renderMission();
        renderChat();
      }
    }
    $("#connection-label").textContent = "Connected";
    $("#connection-dot").classList.remove("offline");
    $("#last-refresh").textContent = `SYNCED ${date(state.serverTime)}`;
    if ($("#new-profile").dataset.profiles !== state.profiles.join("|")) {
      $("#new-profile").innerHTML = state.profiles
        .map((profile) => `<option value="${escape(profile)}">${escape(profile)}</option>`)
        .join("");
      $("#new-profile").value = state.defaultProfile;
      $("#new-profile").dataset.profiles = state.profiles.join("|");
    }
    $("#checks-note").textContent =
      `${state.checkCount} verification commands configured. ${state.requireChecks ? "Passing checks are required." : "Unchecked completion is currently permitted by your configuration."}`;
  } catch (error) {
    $("#connection-label").textContent = "Connection lost";
    $("#connection-dot").classList.add("offline");
    $("#last-refresh").textContent = error.message;
  } finally {
    refreshing = false;
  }
}
function showNew() {
  $("#new-dialog").showModal();
  $("#new-form [name=task]").focus();
}
$("#new-job").addEventListener("click", showNew);
$("#first-job").addEventListener("click", showNew);
$("#filter-jobs").addEventListener("input", renderJobs);
$("#providers-view").addEventListener("click", () => {
  view = "models";
  location.hash = "models";
  void refresh();
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.classList.contains("close-dialog")) button.closest("dialog").close();
  if (button.dataset.job) choose(button.dataset.job);
  if (button.hasAttribute("data-retry-chat") && detail?.plannerChat?.status === "failed") {
    if ($("#planner-message").value.trim()) {
      toast("Send or clear your current draft before retrying.");
      $("#planner-message").focus();
      return;
    }
    $("#planner-message").value = detail.plannerChat.message;
    $("#planner-message").focus();
    $("#planner-form").requestSubmit();
  }
  if (button.dataset.tab) {
    tab = button.dataset.tab;
    renderMission();
  }
  if (button.dataset.task) {
    const task = detail.tasks.find((item) => item.id === button.dataset.task);
    if (!task) return;
    $("#task-content").innerHTML =
      `<span class="eyebrow">${escape(task.stableId)}</span><h2>${escape(task.title)}</h2>${badge(task.status)}<h3>Instructions</h3><pre>${escape(task.instructions)}</pre><h3>Acceptance criteria</h3><ul>${task.acceptanceCriteria.map((item) => `<li>${escape(item)}</li>`).join("")}</ul><h3>File ownership</h3><pre>${escape(task.fileAreas.join("\n"))}</pre>${task.error ? `<h3>Latest failure</h3><pre>${escape(task.error)}</pre>` : ""}`;
    $("#task-dialog").showModal();
  }
  if (button.dataset.action || button.dataset.proposal) {
    button.disabled = true;
    try {
      await api(
        jobUrl(button.dataset.proposal ? "apply" : button.dataset.action),
        button.dataset.proposal ? { proposalId: button.dataset.proposal } : {},
      );
      toast(
        button.dataset.proposal
          ? "Tasks added. The scheduler will follow their dependencies."
          : "Mission updated.",
      );
      await refresh();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }
});
document.addEventListener("submit", async (event) => {
  if (!event.target.matches(".decision-form")) return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api(jobUrl("resolve"), {
      decisionId: form.dataset.decision,
      option: data.get("option"),
      rationale: data.get("rationale"),
    });
    form.reset();
    document.activeElement?.blur();
    toast("Answer delivered to the coordinator.");
    await refresh();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});
$("#planner-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected || chatting) {
    if (!selected) toast("Create or select a mission first.");
    return;
  }
  const message = $("#planner-message").value.trim();
  if (!message) return;
  const chatJob = selected;
  submittingChats.add(chatJob);
  chatting = true;
  $("#send-message").disabled = true;
  if ($("#planner-pending")) {
    $("#planner-pending").hidden = false;
    $("#planner-pending").textContent = "Sending your message…";
  }
  $("#planner-message").value = "";
  try {
    const accepted = await api(`/api/jobs/${encodeURIComponent(chatJob)}/chat`, {
      message,
      background: true,
    });
    acceptedChats.set(chatJob, accepted.requestId);
    submittingChats.delete(chatJob);
    await refresh();
  } catch (error) {
    toast(error.message);
    if (selected === chatJob && !$("#planner-message").value) $("#planner-message").value = message;
  } finally {
    submittingChats.delete(chatJob);
    renderChat();
  }
});
$("#planner-message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#planner-form").requestSubmit();
  }
});
$("#new-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const button = $("#start-mission");
  button.disabled = true;
  try {
    const created = await api("/api/jobs", {
      task: data.get("task"),
      repoPath: data.get("repoPath"),
      baseBranch: data.get("baseBranch") || undefined,
      workerCount: Number(data.get("workerCount")),
      configProfile: data.get("configProfile"),
      dryRun: data.get("dryRun") === "on",
    });
    $("#new-dialog").close();
    choose(created.job_id);
    toast("Mission created. Planning is underway.");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#sweep").addEventListener("click", async () => {
  $("#sweep").disabled = true;
  try {
    const result = await api("/api/maintenance", {});
    toast(
      `Recovery sweep complete. ${result.resumed?.length ?? 0} resumed; ${result.answered?.length ?? 0} missions with answered questions.`,
    );
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    $("#sweep").disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  if (location.hash === "#models") return;
  if (location.hash.slice(1) !== selected || view !== "mission") choose(location.hash.slice(1));
});
document.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "n" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !$("#new-dialog").open
  )
    showNew();
});
void refresh();
setInterval(() => void refresh(), 2000);
