import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGitHub, readLinear } from "./providers.mjs";
import { readConnectorLinear, closeConnectorLinear } from "./codex-linear.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

function configuredNumber(value, defaultValue, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : defaultValue;
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const sourceErrors = {
  linear: {
    UNCONFIGURED: "需要在本机配置 Linear 连接",
    AUTH: "请检查 Linear 工作区连接或读取权限",
    RATE_LIMIT: "Linear 达到读取频率限制，将稍后重试",
    NETWORK: "暂时无法连接 Linear",
    UPSTREAM: "暂时无法读取 Linear 任务"
  },
  github: {
    UNCONFIGURED: "请检查 GitHub CLI 和仓库配置",
    AUTH: "请检查 GitHub 登录和仓库读取权限",
    RATE_LIMIT: "GitHub 达到读取频率限制，将稍后重试",
    UPSTREAM: "暂时无法读取 GitHub PR"
  }
};

const staticAssets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/network.js", ["network.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);

function serveAsset(response, url, head) {
  const asset = staticAssets.get(url);
  if (!asset) return reply(response, 404, "Not found");
  const [file, contentType] = asset;
  const content = readFileSync(resolve(root, file), "utf8");
  const body = file === "index.html"
    ? content.replace("<head>", '<head>\n  <meta name="dispatch-live" content="true">')
    : content;
  reply(response, 200, head ? "" : body, contentType);
}

function reply(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

export async function startServer(options = {}) {
  const port = options.port ?? configuredNumber(process.env.DISPATCH_PORT, 4321, 1024, 65535);
  const intervalSeconds = options.intervalSeconds ?? configuredNumber(process.env.DISPATCH_INTERVAL_SECONDS, 20, 10, 300);
  const interval = intervalSeconds * 1000;
  const localDirectory = options.localDirectory ?? resolve(root, ".dispatch");
  const checkpointPath = resolve(localDirectory, "snapshot.json");
  const config = {
    linearKey: process.env.LINEAR_API_KEY,
    linearAssignee: process.env.LINEAR_ASSIGNEE,
    linearLinkId: process.env.LINEAR_LINK_ID,
    linearWorkspace: process.env.LINEAR_WORKSPACE,
    codexPath: process.env.DISPATCH_CODEX_PATH,
    githubRepo: process.env.GITHUB_REPO,
    githubAuthor: process.env.GITHUB_AUTHOR,
    ghPath: process.env.DISPATCH_GH_PATH,
    limit: configuredNumber(process.env.DISPATCH_TASK_LIMIT, 50, 1, 100)
  };
  const readIssues = options.readIssues ?? (config.linearKey || !config.linearLinkId
    ? () => readLinear(config)
    : () => readConnectorLinear(config));
  const readPulls = options.readPulls ?? (() => readGitHub(config));
  const cached = readJSON(checkpointPath);
  const baseline = readJSON(resolve(localDirectory, "linear-baseline.json"));
  const linearSeed = Array.isArray(cached?.issues) ? cached.issues : baseline?.issues;
  const subscribers = new Set();
  let stopped = false;
  let origin;
  let snapshotAt = cached?.snapshotAt || baseline?.snapshotAt || null;
  const feeds = {
    linear: {
      rows: Array.isArray(linearSeed) ? linearSeed : [], load: readIssues,
      state: "loading", checkedAt: cached?.linearCheckedAt || baseline?.snapshotAt || null
    },
    github: {
      rows: Array.isArray(cached?.pullRequests) ? cached.pullRequests : [], load: readPulls,
      state: "loading", checkedAt: cached?.githubCheckedAt || null
    }
  };

  function snapshot() {
    const { linear, github } = feeds;
    return {
      snapshotAt, intervalSeconds, issues: linear.rows, pullRequests: github.rows,
      sources: Object.fromEntries(Object.entries(feeds).map(([name, { state, checkedAt, reason }]) =>
        [name, { state, checkedAt, reason }]))
    };
  }

  function sendEvent(response, event) {
    if (response.destroyed) return;
    if (response.writableLength > 1_000_000) response.destroy();
    else response.write(event);
  }

  function publish() {
    if (!subscribers.size) return;
    const event = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const response of subscribers) sendEvent(response, event);
  }

  function save() {
    try {
      mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
      const { issues, pullRequests } = snapshot();
      const { linear, github } = feeds;
      const data = { snapshotAt, issues, pullRequests, linearCheckedAt: linear.checkedAt, githubCheckedAt: github.checkedAt };
      const temporary = `${checkpointPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600 });
      renameSync(temporary, checkpointPath);
    } catch {
      console.warn("本机任务快照无法保存。这次读取的数据仍会显示在页面上。");
    }
  }

  async function refresh(name) {
    const feed = feeds[name];
    if (stopped || feed.running) return;
    feed.running = true;
    let delay = interval;
    try {
      const records = await feed.load();
      if (stopped) return;
      const changed = JSON.stringify(feed.rows) !== JSON.stringify(records) || !feed.checkedAt;
      feed.rows = records;
      feed.checkedAt = new Date().toISOString();
      feed.state = "ok";
      feed.reason = undefined;
      if (changed) {
        snapshotAt = feed.checkedAt;
        save();
      }
    } catch (error) {
      if (stopped) return;
      feed.state = "error";
      feed.reason = sourceErrors[name][error.code] || sourceErrors[name].UPSTREAM;
      if (error.code === "RATE_LIMIT") delay = Math.max(60_000, interval, error.retryAfter || 0);
      if (error.code === "UNCONFIGURED" || error.code === "AUTH") delay = Math.max(60_000, interval);
    } finally {
      feed.running = false;
      if (!stopped) {
        publish();
        feed.timer = setTimeout(() => refresh(name), delay);
      }
    }
  }

  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
    if (request.headers.host !== origin?.host) return reply(response, 403, "Local access only");
    if (!["GET", "HEAD"].includes(request.method)) return reply(response, 405, "Method not allowed");
    if (request.url === "/api/snapshot" && request.method === "GET") {
      return reply(response, 200, JSON.stringify(snapshot()), "application/json; charset=utf-8");
    }
    if (request.url === "/api/events" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
      subscribers.add(response);
      response.on("close", () => subscribers.delete(response));
      sendEvent(response, `retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      return;
    }
    try {
      serveAsset(response, request.url, request.method === "HEAD");
    } catch {
      reply(response, 500, "Unable to load the application");
    }
  });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      origin = new URL(`http://127.0.0.1:${server.address().port}`);
      resolveListening();
    });
  });
  server.on("clientError", (_, socket) => socket.destroy());
  const keepalive = setInterval(() => {
    for (const response of subscribers) sendEvent(response, ": keepalive\n\n");
  }, 15_000);
  for (const name of Object.keys(feeds)) void refresh(name);

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(keepalive);
    for (const feed of Object.values(feeds)) clearTimeout(feed.timer);
    for (const response of subscribers) response.end();
    closeConnectorLinear();
    await new Promise((resolveClosed) => {
      server.close(resolveClosed);
      server.closeIdleConnections();
    });
  }

  return { url: origin.origin, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await startServer();
    console.log(`任务调度中心 · ${service.url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void service.stop());
  } catch (error) {
    console.error(error.code === "EADDRINUSE" ? "本机端口已被占用。可通过 DISPATCH_PORT 选择其他端口。" : "任务调度中心无法启动。");
    process.exitCode = 1;
  }
}
