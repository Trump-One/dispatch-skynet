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
  { title: "PR 审核", source: "GitHub" },
  { title: "已结束", source: "Linear / GitHub" },
  { title: "PR 草稿", source: "GitHub" },
  { title: "待处理", source: "Linear" }
];

const METRICS = [
  { title: "待处理", routes: [5] },
  { title: "进行中", routes: [0, 4] },
  { title: "待确认", routes: [1, 2] },
  { title: "已结束", routes: [3] }
];

const STEP_MS = 2450;
const TRAVEL_MS = 1900;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
});
const $ = (id) => document.getElementById(id);
const dialog = $("task-dialog");

let tasks = [];
let example = false;
let sequence = [];
let elapsed = 0;
let duration = 0;
let playing = false;
let frameTime = 0;
let playbackFrame = 0;
let activeStep = -1;
let activeNode = -1;
let panelRoutes = null;
let panelSource = "all";
let timelineGeometry = null;

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

function routeForIssue(issue) {
  const status = (issue.status || "").toLowerCase();
  if (["completed", "canceled"].includes(issue.statusType) || /^(done|completed|canceled|cancelled|已完成|已取消)$/.test(status)) return 3;
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
      source: "linear", status: issue.status, route: routeForIssue(issue),
      url: safeLink(issue.url), updatedAt: issue.updatedAt, project: issue.project
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
      source: "github", status: prStatus(pull), route, issueId: pull.issueId,
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
  const records = normalize(snapshot);
  setPlaying(false);
  tasks = records;
  example = isExample;
  const date = dateString(snapshot.snapshotAt);
  $("snapshot-label").textContent = example ? "示例任务" : date ? `快照 · ${date.slice(5)}` : "本地快照";
  $("snapshot-label").title = date ? `任务快照 ${date}（北京时间）` : "";
  $("total-count").textContent = records.length;
  controls.forEach(({ control, count }, index) => {
    const size = records.filter((task) => task.route === index).length;
    count.textContent = size;
    control.classList.toggle("quiet", size === 0);
  });
  for (const metric of summaries) {
    const group = records.filter((task) => metric.routes.includes(task.route));
    metric.count.textContent = group.length;
    if (group.length) metric.detail.replaceChildren(element("b", "mono", group[0].id), document.createTextNode(`  ${displayTitle(group[0].title)}`));
    else metric.detail.textContent = "暂无任务";
  }
  prepareSequence();
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

function queueRow(task, selected) {
  const row = element("li", selected ? "current" : null);
  const open = button("queue-entry", () => openDetail(task));
  open.title = task.title;
  open.append(element("span", "mono", task.id), element("strong", null, displayTitle(task.title)));
  row.append(open);
  return row;
}

function eventRow(task, index) {
  const row = element("li");
  const open = button("event-entry", () => openDetail(task));
  open.title = task.title;
  open.append(
    element("span", "mono", clock(index * STEP_MS + TRAVEL_MS)),
    element("strong", null, `${task.id} → ${ROUTES[task.route].title}`),
    element("small", null, task.status)
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
  const task = sequence[step];
  activeNode = task ? task.route : -1;
  const queue = sequence.slice(step + Number(arrived));
  $("queue-count").textContent = queue.length;
  $("queue").replaceChildren(...queue.map((entry, index) => queueRow(entry, index === 0 && !arrived)));
  if (queue.length === 0) $("queue").append(element("li", "empty", sequence.length ? "本轮任务已展示" : "任务池为空"));
  const delivered = sequence.slice(0, step + Number(arrived));
  $("events").replaceChildren(...delivered.map(eventRow).reverse());
  $("empty-events").hidden = delivered.length > 0;
  controls.forEach(({ control }, index) => control.classList.toggle("active", arrived && index === activeNode));
  summaries.forEach((metric) => metric.control.classList.toggle("highlight", metric.routes.includes(activeNode)));
  const caption = $("stage-caption");
  if (task) {
    caption.replaceChildren(element("span", "mono", task.id), document.createTextNode(`→ ${ROUTES[task.route].title}`));
    $("packet").textContent = task.id;
  } else {
    caption.textContent = duration ? "本轮演示结束" : "暂无任务";
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
  if (playing) playbackFrame = requestAnimationFrame(tick);
}

$("playback").addEventListener("click", () => {
  if (playing) return setPlaying(false);
  if (elapsed >= duration) paint(0);
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
  const pool = document.querySelector(".pool").getBoundingClientRect();
  const activity = document.querySelector(".activity").getBoundingClientRect();
  $("core").style.setProperty("--globe-caption", `${radius + core.height / 2 + 11}px`);
  timelineGeometry = {
    center,
    coreRadius: core.width / 2,
    nodes: controls.map(({ control }) => {
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top, active: !control.classList.contains("quiet") };
    }),
    pool: compact ? null : { x: pool.right - bounds.left, y: pool.top + 130 - bounds.top },
    activity: compact ? null : { x: activity.left - bounds.left, y: activity.top + 147 - bounds.top }
  };
}

function networkLayout() {
  if (!timelineGeometry) measureNetwork();
  const progress = elapsed % STEP_MS / TRAVEL_MS;
  return { ...timelineGeometry, activeNode, playing, progress: !reducedMotion.matches && activeNode >= 0 && progress < 1 ? progress : null };
}

function trackPacket(position) {
  const packet = $("packet");
  const { center, coreRadius } = timelineGeometry;
  const passesCore = position && Math.hypot(position.x - center.x, position.y - center.y - 13) < coreRadius + 12;
  packet.hidden = !position || passesCore || !playing;
  if (!packet.hidden) packet.style.transform = `translate(${position.x}px, ${position.y - 13}px) translate(-50%, -100%)`;
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
  $("dialog-kicker").textContent = "TASK INDEX";
  $("dialog-title").textContent = title;
  $("task-index").hidden = false;
  $("task-detail").hidden = true;
  $("import-bar").hidden = Boolean(routes);
  showDialog();
  renderIndex();
}

function taskRow(task) {
  const row = element("li");
  const open = button("index-row", () => openDetail(task, true));
  open.append(
    element("span", "mono", `${task.source === "linear" ? "Linear" : "GitHub"} · ${task.id}`),
    element("small", null, task.status),
    element("strong", null, task.title)
  );
  row.append(open);
  return row;
}

function renderIndex() {
  const query = $("find-task").value.toLowerCase().trim();
  const results = tasks.filter((task) =>
    (!panelRoutes || panelRoutes.includes(task.route)) &&
    (panelSource === "all" || panelSource === task.source) &&
    (!query || [task.title, task.id, task.issueId].some((text) => typeof text === "string" && text.toLowerCase().includes(query)))
  );
  document.querySelectorAll(".tabs button").forEach((control) => {
    control.setAttribute("aria-pressed", String(control.dataset.source === panelSource));
  });
  $("index-caption").textContent = `${results.length} 条任务`;
  const list = $("index-results");
  list.replaceChildren(...results.map(taskRow));
  if (results.length === 0) list.append(element("li", "empty", "没有符合条件的任务"));
  list.scrollTop = 0;
}

function openDetail(task, fromIndex = false) {
  const previousHeading = fromIndex && !$("task-index").hidden ? $("dialog-title").textContent : "全部任务";
  const previousRoutes = fromIndex && !$("task-index").hidden ? panelRoutes : null;
  $("dialog-kicker").textContent = task.source === "linear" ? "LINEAR ISSUE" : "GITHUB PULL REQUEST";
  $("dialog-title").textContent = task.id;
  $("task-index").hidden = true;
  const detail = $("task-detail");
  detail.hidden = false;
  const back = button("button", () => openIndex({ routes: previousRoutes, title: previousHeading, reset: !fromIndex }));
  back.textContent = "← 返回任务列表";
  detail.replaceChildren(back, element("h3", "detail-title", task.title));
  const meta = element("dl", "detail-meta");
  const fields = [
    ["当前状态", task.status],
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
  replay.textContent = "从这条开始演示";
  actions.append(replay);
  if (task.url) {
    const link = element("a", "button original", `打开 ${task.source === "linear" ? "Linear" : "GitHub"} 原始任务 ↗`);
    link.href = task.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  detail.append(actions);
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
  detail.scrollTop = 0;
  showDialog();
  back.focus();
}

$("open-tasks").addEventListener("click", () => openIndex());
$("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close();
});
$("find-task").addEventListener("input", renderIndex);
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

try {
  setSnapshot(window.DISPATCH_SNAPSHOT || EXAMPLE, !window.DISPATCH_SNAPSHOT);
} catch {
  setSnapshot(EXAMPLE, true);
  $("snapshot-label").textContent = "快照无效 · 示例任务";
}
measureNetwork();
const observer = new ResizeObserver(measureNetwork);
observer.observe($("stage"));
new window.DispatchNetwork($("network"), networkLayout, trackPacket);
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) setPlaying(false);
});
if (!reducedMotion.matches) setPlaying(true);
