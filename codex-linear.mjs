import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const TIMEOUT = 18_000;
const FIELDS = ["id", "title", "status", "statusType", "url", "updatedAt", "completedAt", "project"];
let connector;

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function connectionError() {
  return sourceError("NETWORK", "暂时无法连接 Codex 中的 Linear");
}

class LinearConnector {
  constructor(executable) {
    this.executable = executable;
    this.pending = new Map();
    this.serial = 0;
    this.closed = false;
    const env = { ...process.env };
    delete env.LINEAR_API_KEY;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    this.child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"], env
    });
    this.output = createInterface({ input: this.child.stdout });
    this.output.on("line", (line) => this.receive(line));
    this.child.stdin.on("error", () => this.close(connectionError()));
    this.child.on("error", (error) => {
      this.close(error.code === "ENOENT"
        ? sourceError("UNCONFIGURED", "找不到 Codex CLI")
        : connectionError());
    });
    this.child.on("exit", () => this.close(connectionError()));
    this.threadId = this.initialize();
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "dispatch-skynet", title: "Dispatch Skynet", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.write({ method: "initialized" });
    // Keep the connector context in memory. No turn is started and no conversation is saved.
    const { thread } = await this.request("thread/start", {
      ephemeral: true, approvalPolicy: "never", cwd: tmpdir()
    });
    if (!thread?.id || thread.path) {
      throw sourceError("UPSTREAM", "Codex 无法为 Linear 建立临时读取会话");
    }
    return thread.id;
  }

  write(message) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params) {
    if (this.closed) return Promise.reject(connectionError());
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => this.close(sourceError("NETWORK", "读取 Linear 超时")), TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = this.pending.get(message?.id);
    if (!entry || !("result" in message || "error" in message)) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(sourceError("UPSTREAM", "Codex 中的 Linear 连接未返回任务"));
    } else {
      entry.resolve(message.result);
    }
  }

  close(error = connectionError()) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.output.close();
    this.child.stdin.end();
    this.child.kill();
  }

  async issues(link, assignee, limit) {
    let threadId;
    try {
      threadId = await this.threadId;
    } catch (error) {
      this.close(error);
      throw error;
    }
    const response = await this.request("mcpServer/tool/call", {
      threadId, server: "codex_apps", tool: "linear.list_issues",
      arguments: { link_id: link, assignee, limit, orderBy: "updatedAt", fields: FIELDS }
    });
    const content = response?.content?.filter((item) => item?.type === "text").map((item) => item.text).join("") || "";
    if (response?.isError) {
      if (/rate limit|too many requests|429/i.test(content)) {
        throw sourceError("RATE_LIMIT", "Linear 达到读取频率限制");
      }
      if (/auth|forbidden|permission|reconnect|401|403/i.test(content)) {
        this.close();
        throw sourceError("AUTH", "请检查 Codex 中的 Linear 连接权限");
      }
      throw sourceError("UPSTREAM", "Codex 中的 Linear 暂时无法读取");
    }
    let payload = response?.structuredContent || content;
    try {
      if (typeof payload === "string") payload = JSON.parse(payload);
      if (typeof payload === "string") payload = JSON.parse(payload);
    } catch {
      throw sourceError("UPSTREAM", "Linear 返回了无法读取的数据");
    }
    return payload?.issues;
  }
}

export function closeConnectorLinear() {
  connector?.close();
  connector = undefined;
}

export async function readConnectorLinear(config) {
  const link = config.linearLinkId?.trim();
  const assignee = config.linearAssignee?.trim();
  const workspace = config.linearWorkspace?.trim().toLowerCase();
  if (!link || !assignee) {
    throw sourceError("UNCONFIGURED", "请配置本机的 Linear 连接和任务负责人");
  }
  const executable = config.codexPath || "codex";
  const count = Number(config.limit);
  const limit = Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 50;
  if (!connector || connector.closed || connector.executable !== executable) {
    closeConnectorLinear();
    connector = new LinearConnector(executable);
  }
  const issues = await connector.issues(link, assignee, limit);
  if (!Array.isArray(issues) || issues.some((issue) =>
    typeof issue?.id !== "string" || typeof issue.title !== "string" || typeof issue.status !== "string"
  )) {
    throw sourceError("UPSTREAM", "Linear 返回了不完整的任务列表");
  }
  if (workspace && issues.some((issue) =>
    typeof issue.url !== "string" || !issue.url.toLowerCase().startsWith(`https://linear.app/${workspace}/issue/`)
  )) {
    throw sourceError("AUTH", "Linear 返回了其他工作区的任务");
  }
  return issues.map(({ id, title, status, statusType, url, updatedAt, completedAt, project }) =>
    ({ id, title, status, statusType, url, updatedAt, completedAt, project })
  );
}
