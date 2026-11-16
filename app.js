"use strict";

const EXAMPLE = {
  issues: [
    { id: "DEMO-1", title: "完善新手引导", status: "In Progress", statusType: "started" },
    { id: "DEMO-2", title: "确认导航与空白状态", status: "In Review", statusType: "started" },
    { id: "DEMO-3", title: "整理下一轮用户反馈", status: "Todo", statusType: "unstarted" },
    { id: "DEMO-4", title: "更新发布说明", status: "Done", statusType: "completed" }
  ],
  pullRequests: [
    { number: 101, title: "调整引导页面布局", state: "OPEN", isDraft: true, issueId: "DEMO-1" },
    { number: 102, title: "补齐导航校验", state: "OPEN", isDraft: false, issueId: "DEMO-2" },
    { number: 103, title: "合并发布说明", state: "MERGED", issueId: "DEMO-4" }
  ]
};

const ROUTES = [
  { title: "开发中", source: "Linear" },
  { title: "待验收", source: "Linear" },
  { title: "请求审核", source: "GitHub" },
  { title: "已结束", source: "Linear / GitHub" },
  { title: "请求草稿", source: "GitHub" },
  { title: "待处理", source: "Linear" }
];

const METRICS = [
  { title: "待处理", routes: [5] },
  { title: "进行中", routes: [0, 4] },
  { title: "待确认", routes: [1, 2] },
  { title: "已结束", routes: [3] }
];

const LINEAR_STATUS_LABELS = new Map([
  ["backlog", "待规划"], ["todo", "待处理"], ["to do", "待处理"], ["triage", "待分诊"],
  ["in progress", "进行中"], ["in review", "审核中"], ["in testing", "测试中"],
  ["ready for review", "待审核"], ["done", "已完成"], ["completed", "已完成"],
  ["canceled", "已取消"], ["cancelled", "已取消"], ["duplicate", "重复任务"], ["blocked", "受阻"]
]);

const STEP_MS = 2450;
const TRAVEL_MS = 1900;
const LIVE_TRAVEL_MS = 2050;
const AMBIENT_INTERVAL_MS = 3100;
const ACTIVE_ROUTES = [0, 1, 2, 4];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
});
const syncTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
});
const $ = (id) => document.getElementById(id);
const dialog = $("task-dialog");
const liveMode = location.protocol === "http:" &&
  document.querySelector('meta[name="dispatch-live"][content="true"]') !== null;

let tasks = [];
let sequence = [];
let elapsed = 0;
let duration = 0;
let playing = false;
let frameTime = 0;
let playbackFrame = 0;
let activeStep = -1;
let activeNode = -1;
let replayTaskKey = null;
let panelRoutes = null;
let panelSource = "all";
let detailView = null;
let timelineGeometry = null;
let lastSnapshot = null;
let liveRevision = "";
let liveChanges = [];
let ambientTasks = [];
let ambientIndex = 0;
let nextAmbientAt = 0;
let currentFlow = null;
const pendingFlows = [];
const browserTranslations = new Map();
let updateTranslator;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, listener) {
  const control = element("button", className);
  control.type = "button";
  control.addEventListener("click", listener);
  return control;
}

function displayTitle(title) {
  return title.replace(/^[a-z]+(?:\([^)]+\))?!?:\s+/i, "").replace(/\s+\([A-Z]+-\d+\)$/, "");
}

function taskTitle(task) {
  return task.titleZh || browserTranslations.get(task.title) || displayTitle(task.title);
}

function statusLabel(task) {
  return task.source === "linear"
    ? LINEAR_STATUS_LABELS.get(task.status.trim().toLowerCase()) || task.status
    : task.status;
}

function dateString(value) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? dateFormatter.format(millis) : "";
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function issueIsCompleted(issue) {
  return issue.statusType === "completed" || /^(done|completed|已完成)$/i.test(issue.status.trim());
}

function routeForIssue(issue) {
  const status = (issue.status || "").toLowerCase();
  if (issueIsCompleted(issue) || issue.statusType === "canceled" || /^(canceled|cancelled|已取消)$/.test(status)) return 3;
  if (/review|qa|test|acceptance|审核|验收/.test(status)) return 1;
  if (issue.statusType === "started" || /in progress|进行中/.test(status)) return 0;
  return 5;
}

function prStatus(pull) {
  if (pull.state === "MERGED") return "已合并";
  if (pull.state === "CLOSED") return "已关闭";
  if (pull.isDraft) return "草稿";
  if (pull.reviewDecision === "CHANGES_REQUESTED") return "要求修改";
  if (pull.reviewDecision === "APPROVED") return "已批准";
  if (pull.reviewDecision === "REVIEW_REQUIRED") return "待审核";
  return "未合并";
}

function normalize(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.issues) || !Array.isArray(snapshot.pullRequests)) {
    throw new Error("快照需包含 issues 和 pullRequests 两个列表。");
  }
  const records = [];
  const seen = new Set();
  const append = (record) => {
    if (seen.has(record.key)) throw new Error("快照中存在重复编号。");
    seen.add(record.key);
    records.push(record);
  };
  for (const issue of snapshot.issues) {
    if (!issue || typeof issue.id !== "string" || !issue.id.trim() ||
        typeof issue.title !== "string" || !issue.title.trim() ||
        typeof issue.status !== "string" || !issue.status.trim()) {
      throw new Error("Linear 任务需包含编号、标题和状态。");
    }
    append({
      key: `linear:${issue.id}`, id: issue.id, title: issue.title,
      titleZh: typeof issue.titleZh === "string" ? issue.titleZh : "",
      source: "linear", status: issue.status, route: routeForIssue(issue), completed: issueIsCompleted(issue),
      url: safeLink(issue.url), updatedAt: issue.updatedAt, project: issue.projectZh || issue.project
    });
  }
  for (const pull of snapshot.pullRequests) {
    if (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1 ||
        typeof pull.title !== "string" || !pull.title.trim() ||
        !["OPEN", "MERGED", "CLOSED"].includes(pull.state)) {
      throw new Error("GitHub PR 需包含编号、标题和有效状态。");
    }
    const route = pull.state !== "OPEN" ? 3 : pull.isDraft ? 4 : 2;
    append({
      key: `github:${pull.number}`, id: `#${pull.number}`, title: pull.title,
      titleZh: typeof pull.titleZh === "string" ? pull.titleZh : "",
      source: "github", status: prStatus(pull), route, issueId: pull.issueId, completed: pull.state === "MERGED",
      url: safeLink(pull.url), updatedAt: pull.updatedAt || pull.createdAt
    });
  }
  return records.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

const controls = ROUTES.map((route, index) => {
  const control = button(`node node-${index}`, () => openIndex({ routes: [index], title: route.title }));
  const top = element("span", "node-top");
  top.append(element("span", "node-dot"), element("span", "node-title", route.title));
  const bottom = element("span", "node-bottom");
  const count = element("span", "node-count mono");
  bottom.append(element("span", null, route.source), count);
  control.append(top, bottom);
  $("nodes").append(control);
  return { control, count };
});

const summaries = METRICS.map((metric) => {
  const control = button("metric", () => openIndex({ routes: metric.routes, title: metric.title }));
  const top = element("span", "metric-top");
  const count = element("strong", "mono");
  top.append(element("span", null, metric.title), count);
  const detail = element("span", "metric-detail");
  control.append(top, detail);
  $("metrics").append(control);
  return { ...metric, control, count, detail };
});

function setSnapshot(snapshot, isExample) {
  tasks = normalize(snapshot);
  setPlaying(false);
  const date = dateString(snapshot.snapshotAt);
  $("snapshot-label").textContent = isExample ? "示例任务" : date ? `快照 · ${date.slice(5)}` : "本地快照";
  $("snapshot-label").title = date ? `任务快照 ${date}（北京时间）` : "";
  renderTaskCounts();
  renderPools();
  prepareSequence();
}

function renderTaskCounts() {
  $("total-count").textContent = tasks.length;
  controls.forEach(({ control, count }, index) => {
    const size = tasks.filter((task) => task.route === index).length;
    count.textContent = size;
    control.classList.toggle("quiet", size === 0);
  });
  for (const metric of summaries) {
    const group = tasks.filter((task) => metric.routes.includes(task.route));
    metric.count.textContent = group.length;
    if (group.length) metric.detail.replaceChildren(element("b", "mono", group[0].id), document.createTextNode(`  ${taskTitle(group[0])}`));
    else metric.detail.textContent = "暂无任务";
  }
}

function prepareSequence(first) {
  const featured = [0, 1, 4, 2, 3, 5].map((route) => tasks.find((task) => task.route === route)).filter(Boolean);
  const entries = first ? [first, ...featured.filter((task) => task.key !== first.key)] : featured;
  sequence = entries.slice(0, 6);
  duration = sequence.length * STEP_MS;
  $("timeline").max = duration || 1;
  $("timeline").disabled = duration === 0;
  $("playback").disabled = duration === 0;
  $("restart").disabled = duration === 0;
  $("duration").textContent = clock(duration);
  activeStep = -1;
  paint(0, true);
}

function clock(millis) {
  const seconds = Math.floor(millis / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function queueRow(task) {
  const row = element("li", task.key === replayTaskKey ? "current" : null);
  const open = button("queue-entry", () => openDetail(task));
  open.dataset.taskKey = task.key;
  open.title = taskTitle(task);
  const meta = element("span", "queue-entry-meta");
  meta.append(element("span", "mono", task.id), element("small", null, statusLabel(task)));
  open.append(meta, element("strong", null, taskTitle(task)));
  row.append(open);
  return row;
}

function renderPools({ loading = false } = {}) {
  const focused = document.activeElement?.closest(".pool") && document.activeElement.dataset.taskKey;
  const sections = [
    ["queue", "queue-count", tasks.filter((task) => task.route !== 3), "暂无待处理或进行中的任务"],
    ["completed-queue", "completed-count", tasks.filter((task) => task.completed), "暂无已完成的任务"]
  ];
  for (const [listId, countId, records, empty] of sections) {
    const list = $(listId);
    const previousScroll = list.scrollTop;
    $(countId).textContent = records.length;
    list.replaceChildren(...records.map(queueRow));
    if (!records.length) list.append(element("li", "empty", loading ? "正在读取任务" : empty));
    list.scrollTop = previousScroll;
  }
  if (focused) document.querySelector(`.pool [data-task-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function highlightPoolTask(key) {
  if (replayTaskKey === key) return;
  document.querySelector(".pool .current")?.classList.remove("current");
  replayTaskKey = key;
  if (key) document.querySelector(`.pool [data-task-key="${CSS.escape(key)}"]`)?.parentElement.classList.add("current");
}

function eventRow(task, index) {
  const row = element("li");
  const open = button("event-entry", () => openDetail(task));
  open.title = taskTitle(task);
  open.append(
    element("span", "mono", clock(index * STEP_MS + TRAVEL_MS)),
    element("strong", null, `${task.id} → ${ROUTES[task.route].title}`),
    element("small", null, statusLabel(task))
  );
  row.append(open);
  return row;
}

function paint(target, force = false) {
  elapsed = Math.max(0, Math.min(duration, target));
  let step = Math.floor(elapsed / STEP_MS);
  if (elapsed === duration) step = sequence.length;
  const transit = elapsed % STEP_MS;
  const arrived = transit >= TRAVEL_MS;
  const signature = step * 2 + Number(arrived);
  $("timeline").value = elapsed;
  $("timeline").style.setProperty("--played", `${duration ? elapsed / duration * 100 : 0}%`);
  $("timeline").setAttribute("aria-valuetext", `${clock(elapsed)} / ${clock(duration)}`);
  if ($("time").value !== clock(elapsed)) $("time").value = clock(elapsed);
  if (signature === activeStep && !force) return;
  activeStep = signature;
  const showDemo = !liveMode || playing || elapsed > 0;
  const task = showDemo ? sequence[step] : null;
  activeNode = task ? task.route : -1;
  highlightPoolTask(arrived ? null : task?.key ?? null);
  if (!liveMode) {
    const delivered = sequence.slice(0, step + Number(arrived));
    $("events").replaceChildren(...delivered.map(eventRow).reverse());
    $("empty-events").hidden = delivered.length > 0;
  }
  controls.forEach(({ control }, index) => control.classList.toggle("active", arrived && index === activeNode));
  summaries.forEach((metric) => metric.control.classList.toggle("highlight", metric.routes.includes(activeNode)));
  const caption = $("stage-caption");
  if (task) {
    caption.replaceChildren(element("span", "mono", task.id), document.createTextNode(`→ ${ROUTES[task.route].title}`));
  } else if (liveMode && liveChanges.length) {
    const latest = liveChanges[0].task;
    caption.replaceChildren(element("span", "mono", latest.id), document.createTextNode(`→ ${ROUTES[latest.route].title}`));
  } else {
    caption.textContent = liveMode ? "监听任务状态" : duration ? "本轮演示结束" : "暂无任务";
  }
}

function tick(now) {
  if (!playing) return;
  if (frameTime) paint(elapsed + Math.min(now - frameTime, 80));
  frameTime = now;
  if (elapsed >= duration) setPlaying(false);
  else playbackFrame = requestAnimationFrame(tick);
}

function setPlaying(value) {
  playing = Boolean(value && duration);
  cancelAnimationFrame(playbackFrame);
  frameTime = 0;
  $("playback").setAttribute("aria-label", playing ? "暂停演示" : "播放演示");
  $("play-symbol").className = playing ? "pause-sign" : "play-sign";
  if (playing) {
    if (currentFlow?.tone === "live") pendingFlows.unshift({ task: currentFlow.task, from: currentFlow.from });
    currentFlow = null;
    if (liveMode) paint(elapsed, true);
    playbackFrame = requestAnimationFrame(tick);
  }
}

$("playback").addEventListener("click", () => {
  if (playing) return setPlaying(false);
  if (liveMode && (elapsed === 0 || elapsed >= duration)) prepareSequence();
  else if (elapsed >= duration) paint(0);
  setPlaying(true);
});
$("restart").addEventListener("click", () => {
  prepareSequence();
  setPlaying(true);
});
$("timeline").addEventListener("input", (event) => {
  setPlaying(false);
  paint(Number(event.target.value));
});

function measureNetwork() {
  const bounds = $("network").getBoundingClientRect();
  const stage = $("stage").getBoundingClientRect();
  const core = $("core").getBoundingClientRect();
  const compact = matchMedia("(max-width: 760px)").matches;
  const radius = Math.min(stage.height * (compact ? .275 : .305), stage.width * (compact ? .26 : .184));
  const center = { x: core.left + core.width / 2 - bounds.left, y: core.top + core.height / 2 - bounds.top, r: radius };
  const pool = $("active-pool").getBoundingClientRect();
  const finished = $("completed-pool").getBoundingClientRect();
  $("core").style.setProperty("--globe-caption", `${radius + core.height / 2 + 11}px`);
  timelineGeometry = {
    center,
    width: bounds.width,
    coreRadius: core.width / 2,
    nodes: controls.map(({ control }) => {
      const rect = control.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top,
        width: rect.width, height: rect.height, active: !control.classList.contains("quiet")
      };
    }),
    pool: compact ? null : { x: pool.right - bounds.left, y: center.y },
    completed: compact
      ? { x: finished.left + finished.width / 2 - bounds.left, y: finished.top - bounds.top }
      : { x: finished.left - bounds.left, y: finished.top + finished.height * .55 - bounds.top }
  };
}

function selectLiveFlow(now) {
  if (currentFlow?.tone === "ambient" && pendingFlows.length) currentFlow = null;
  if (currentFlow && now - currentFlow.startedAt >= currentFlow.duration) {
    if (currentFlow.tone === "live" && currentFlow.task.completed) {
      $("completed-pool").animate([{ borderColor: "#9dc6ad" }, { borderColor: "#33443d" }], 850);
    }
    currentFlow = null;
  }
  if (currentFlow) return currentFlow;

  const change = pendingFlows.shift();
  if (change) {
    currentFlow = { ...change, tone: "live", startedAt: now, duration: LIVE_TRAVEL_MS };
  } else if (ambientTasks.length && now >= nextAmbientAt && !dialog.open) {
    const task = ambientTasks[ambientIndex++ % ambientTasks.length];
    currentFlow = { task, from: null, tone: "ambient", startedAt: now, duration: TRAVEL_MS };
    nextAmbientAt = now + AMBIENT_INTERVAL_MS;
  }
  return currentFlow;
}

function networkLayout() {
  if (!timelineGeometry) measureNetwork();
  const now = performance.now();
  const demo = playing ? sequence[Math.floor(elapsed / STEP_MS)] : null;
  const flow = !playing && !reducedMotion.matches && liveMode ? selectLiveFlow(now) : null;
  const entry = demo || flow?.task;
  const progress = demo ? elapsed % STEP_MS / TRAVEL_MS : flow ? (now - flow.startedAt) / flow.duration : 1;
  const transfer = !reducedMotion.matches && entry && progress < 1 ? {
    id: entry.id, from: flow?.from ?? null, to: entry.route, progress, completed: entry.completed, tone: flow?.tone || "demo"
  } : null;
  return {
    ...timelineGeometry,
    activeNode: entry?.route ?? (playing ? activeNode : -1),
    playing: playing || Boolean(liveMode && (ambientTasks.length || flow)),
    transfer
  };
}

function trackPacket(position) {
  const packet = $("packet");
  const demo = playing ? sequence[Math.floor(elapsed / STEP_MS)] : null;
  const task = demo || currentFlow?.task;
  packet.hidden = !position || !task || reducedMotion.matches;
  if (packet.hidden) return;
  const title = taskTitle(task);
  if (packet.dataset.id !== task.id || packet.dataset.title !== title) {
    packet.replaceChildren(element("span", "packet-id mono", task.id), element("span", "packet-title", title));
    packet.dataset.id = task.id;
    packet.dataset.title = title;
  }
  packet.dataset.tone = position.tone || (demo ? "demo" : currentFlow.tone);
  packet.dataset.completed = String(task.completed);
  const margin = Math.min(95, timelineGeometry.width * .17);
  const x = Math.max(margin, Math.min(timelineGeometry.width - margin, position.x));
  packet.style.transform = `translate(${x}px, ${position.y - 11}px) translate(-50%, -100%)`;
}

function showDialog() {
  setPlaying(false);
  if (!dialog.open) dialog.showModal();
}

function openIndex({ routes = null, title = "全部任务", reset = true } = {}) {
  panelRoutes = routes;
  if (reset) {
    panelSource = "all";
    $("find-task").value = "";
    $("import-status").textContent = "";
  }
  $("dialog-kicker").textContent = "任务列表";
  $("dialog-title").textContent = title;
  $("task-index").hidden = false;
  $("task-detail").hidden = true;
  detailView = null;
  $("import-bar").hidden = liveMode || Boolean(routes);
  showDialog();
  renderIndex();
}

function taskRow(task) {
  const row = element("li");
  const open = button("index-row", () => openDetail(task, true));
  open.dataset.taskKey = task.key;
  open.append(
    element("span", "mono", `${task.source === "linear" ? "Linear" : "GitHub"} · ${task.id}`),
    element("small", null, statusLabel(task)),
    element("strong", null, taskTitle(task))
  );
  row.append(open);
  return row;
}

function renderIndex(preservePosition = false) {
  const query = $("find-task").value.toLowerCase().trim();
  const results = tasks.filter((task) =>
    (!panelRoutes || panelRoutes.includes(task.route)) &&
    (panelSource === "all" || panelSource === task.source) &&
    (!query || [task.title, taskTitle(task), task.id, task.issueId].some((text) => typeof text === "string" && text.toLowerCase().includes(query)))
  );
  document.querySelectorAll(".tabs button").forEach((control) => {
    control.setAttribute("aria-pressed", String(control.dataset.source === panelSource));
  });
  $("index-caption").textContent = `${results.length} 条任务`;
  const list = $("index-results");
  const scrollTop = list.scrollTop;
  const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.taskKey : null;
  list.replaceChildren(...results.map(taskRow));
  if (results.length === 0) list.append(element("li", "empty", "没有符合条件的任务"));
  list.scrollTop = preservePosition ? scrollTop : 0;
  if (preservePosition && focusKey) {
    const matching = [...list.querySelectorAll("button")].find((control) => control.dataset.taskKey === focusKey);
    (matching || $("find-task")).focus({ preventScroll: true });
  }
}

function openDetail(task, fromIndex = false) {
  const previous = fromIndex && !$("task-index").hidden
    ? { routes: panelRoutes, title: $("dialog-title").textContent, reset: false }
    : fromIndex && dialog.open ? detailView?.previous || {} : {};
  detailView = { task, previous };
  renderDetail();
  showDialog();
  $("task-detail").querySelector("button").focus();
}

function renderDetail(preservePosition = false) {
  const current = tasks.find((entry) => entry.key === detailView.task.key);
  const task = current || detailView.task;
  detailView.task = task;
  $("dialog-kicker").textContent = task.source === "linear" ? "Linear 任务" : "GitHub 合并请求";
  $("dialog-title").textContent = task.id;
  $("task-index").hidden = true;
  const detail = $("task-detail");
  detail.hidden = false;
  const scrollTop = detail.scrollTop;
  const focus = detail.contains(document.activeElement) ? document.activeElement.dataset : null;
  const back = button("button", () => openIndex(detailView.previous));
  back.dataset.action = "back";
  back.textContent = "← 返回任务列表";
  detail.replaceChildren(back, element("h3", "detail-title", taskTitle(task)));
  if (liveMode && !current) detail.append(element("p", "empty", "这条任务已离开当前同步范围。"));
  const meta = element("dl", "detail-meta");
  const fields = [
    ["当前状态", statusLabel(task)],
    ["调度节点", ROUTES[task.route].title],
    ["项目", task.project],
    ["更新时间", dateString(task.updatedAt)]
  ];
  for (const [label, value] of fields) {
    if (typeof value === "string" && value) meta.append(element("dt", null, label), element("dd", null, value));
  }
  detail.append(meta);
  const actions = element("div", "detail-actions");
  const replay = button("button", () => {
    dialog.close();
    prepareSequence(task);
    setPlaying(true);
  });
  replay.dataset.action = "replay";
  replay.textContent = "从这条开始演示";
  actions.append(replay);
  if (task.url) {
    const link = element("a", "button original", `打开 ${task.source === "linear" ? "Linear" : "GitHub"} 原始任务 ↗`);
    link.href = task.url;
    link.dataset.action = "source";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  detail.append(actions);
  if (task.titleZh || browserTranslations.has(task.title)) {
    const original = element("details", "original-title");
    original.append(element("summary", null, "查看标题原文"), element("p", null, task.title));
    detail.append(original);
  }
  const related = tasks.filter((entry) =>
    task.source === "linear" ? entry.source === "github" && entry.issueId === task.id
      : entry.source === "linear" && entry.id === task.issueId
  );
  if (related.length) {
    detail.append(element("h3", "related-title", "关联任务"));
    const list = element("ul", "related");
    list.append(...related.map(taskRow));
    detail.append(list);
  }
  detail.scrollTop = preservePosition ? scrollTop : 0;
  if (preservePosition && focus) {
    const matching = [...detail.querySelectorAll("[data-action], [data-task-key]")].find((control) =>
      focus.action ? control.dataset.action === focus.action : control.dataset.taskKey === focus.taskKey
    );
    (matching || back).focus({ preventScroll: true });
  }
}

function renderLiveHealth(connection) {
  const sources = lastSnapshot?.sources || {};
  for (const [key, name] of [["linear", "Linear"], ["github", "GitHub"]]) {
    const source = sources[key];
    const badge = $(`source-${key}`);
    const state = source?.state || "loading";
    badge.dataset.state = connection === "connected" ? state : "loading";
    const lastStatus = state === "ok" ? "已同步" : state === "error" ? "同步中断" : "待读取";
    badge.textContent = `${name} · ${lastStatus}`;
    const checked = dateString(source?.checkedAt);
    badge.title = [source?.reason, checked && `最近同步 ${checked}（北京时间）`].filter(Boolean).join("\n");
  }

  const bothReady = sources.linear?.state === "ok" && sources.github?.state === "ok";
  const hasError = sources.linear?.state === "error" || sources.github?.state === "error";
  const label = $("snapshot-label");
  label.parentElement.dataset.state = connection === "connected" ? (bothReady ? "ok" : hasError ? "error" : "loading") : "loading";
  const recentCheck = Math.max(
    Date.parse(sources.linear?.checkedAt) || 0,
    Date.parse(sources.github?.checkedAt) || 0,
    Date.parse(lastSnapshot?.snapshotAt) || 0
  );
  const time = recentCheck ? ` · ${syncTimeFormatter.format(recentCheck)}` : "";
  const message = connection === "connecting" ? "连接本地服务" : connection === "reconnecting" ? "本地服务重连中" :
    bothReady ? "本地实时" : hasError ? "同步受限" : "正在读取任务";
  label.textContent = message + time;
  const interval = lastSnapshot?.intervalSeconds;
  label.title = Number.isFinite(interval) && interval > 0 ? `每 ${interval} 秒检查一次任务状态，时间为北京时间。` : "";
}

function liveEventRow({ task, previous, status, at }) {
  task = tasks.find((entry) => entry.key === task.key) || task;
  const row = element("li");
  const open = button("event-entry", () => openDetail(task));
  open.title = taskTitle(task);
  open.append(
    element("span", "mono", syncTimeFormatter.format(at)),
    element("strong", null, `${task.id} · ${taskTitle(task)}`),
    element("small", null, `${previous} → ${status}`)
  );
  row.append(open);
  return row;
}

function updateLiveTasks(records, snapshot) {
  const revision = JSON.stringify(records);
  if (revision === liveRevision) return;
  liveRevision = revision;
  const oldTasks = new Map(tasks.map((task) => [task.key, task]));
  const changes = records.flatMap((task) => {
    const old = oldTasks.get(task.key);
    if (!old || (old.status === task.status && old.route === task.route)) return [];
    const at = Date.parse(snapshot.sources?.[task.source]?.checkedAt) || Date.parse(snapshot.snapshotAt) || Date.now();
    const sameStatus = old.status === task.status;
    const previous = sameStatus ? ROUTES[old.route].title : statusLabel(old);
    const status = sameStatus ? ROUTES[task.route].title : statusLabel(task);
    return [{ task, previous, status, at, from: old.route }];
  });
  tasks = records;
  ambientTasks = tasks.filter((task) => ACTIVE_ROUTES.includes(task.route));
  renderTaskCounts();
  renderPools();
  if (changes.length) {
    if (!reducedMotion.matches) {
      pendingFlows.push(...changes.map(({ task, from }) => ({ task, from })));
      if (pendingFlows.length > 8) pendingFlows.splice(0, pendingFlows.length - 8);
    }
    liveChanges = [...changes, ...liveChanges].slice(0, 30);
    $("events").replaceChildren(...liveChanges.map(liveEventRow));
    $("empty-events").hidden = true;
    if (!playing && (elapsed === 0 || elapsed >= duration)) {
      paint(elapsed, true);
      if (!reducedMotion.matches) {
        for (const route of new Set(changes.map(({ task }) => task.route))) {
          controls[route].control.animate([{ borderColor: "#a3ceb0" }, { borderColor: "#575757" }], 1800);
        }
      }
    }
  }
  if (!duration) prepareSequence();
  if (dialog.open && detailView) renderDetail(true);
  else if (dialog.open) renderIndex(true);
  measureNetwork();
}

function startLive() {
  $("live-sources").hidden = false;
  $("activity-kind").textContent = "本次打开";
  $("empty-events").textContent = "状态变化会自动出现在这里";
  $("import-bar").hidden = true;
  renderTaskCounts();
  renderPools({ loading: true });
  prepareSequence();
  renderLiveHealth("connecting");
  const stream = new EventSource("/api/events");
  stream.addEventListener("open", () => renderLiveHealth("connected"));
  stream.addEventListener("error", () => renderLiveHealth("reconnecting"));
  stream.addEventListener("snapshot", (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      const records = normalize(snapshot);
      lastSnapshot = snapshot;
      renderLiveHealth("connected");
      updateLiveTasks(records, snapshot);
      updateTranslator?.(records.filter((task) => !task.titleZh && /[a-z]{2,}/i.test(task.title) &&
        !/\p{Script=Han}/u.test(task.title)).map((task) => task.title));
    } catch {
      renderLiveHealth("reconnecting");
    }
  });
}

$("open-tasks").addEventListener("click", () => openIndex());
$("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close();
});
$("find-task").addEventListener("input", () => renderIndex());
document.querySelectorAll(".tabs button").forEach((control) => {
  control.addEventListener("click", () => {
    panelSource = control.dataset.source;
    renderIndex();
  });
});
$("import-snapshot").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("快照文件需小于 2 MB。");
    setSnapshot(JSON.parse(await file.text()), false);
    measureNetwork();
    openIndex();
    $("import-status").textContent = `已载入 ${tasks.length} 条任务`;
  } catch (error) {
    $("import-status").textContent = error instanceof SyntaxError ? "文件格式无效，请选择任务快照 JSON。" : error.message;
  } finally {
    event.target.value = "";
  }
});

if (liveMode) {
  updateTranslator = window.createTaskTranslator?.((translations) => {
    for (const [title, translated] of Object.entries(translations)) browserTranslations.set(title, translated);
    renderTaskCounts();
    renderPools();
    if (liveChanges.length) $("events").replaceChildren(...liveChanges.map(liveEventRow));
    if (dialog.open && detailView) renderDetail(true);
    else if (dialog.open) renderIndex(true);
  });
  startLive();
}
else {
  try {
    setSnapshot(window.DISPATCH_SNAPSHOT || EXAMPLE, !window.DISPATCH_SNAPSHOT);
  } catch {
    setSnapshot(EXAMPLE, true);
    $("snapshot-label").textContent = "快照无效 · 示例任务";
  }
}
measureNetwork();
const observer = new ResizeObserver(measureNetwork);
observer.observe($("stage"));
new window.DispatchNetwork($("network"), networkLayout, trackPacket);
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) {
    currentFlow = null;
    pendingFlows.length = 0;
    setPlaying(false);
  }
});
if (!liveMode && !reducedMotion.matches) setPlaying(true);
