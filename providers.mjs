import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const REQUEST_TIMEOUT = 12_000;
const DEFAULT_LIMIT = 50;
const ISSUE_FIELDS = `
  nodes {
    identifier
    title
    state { name type }
    url
    updatedAt
    completedAt
    project { name }
  }
`;

function sourceError(code, message, retryAfter) {
  const error = new Error(message);
  error.code = code;
  if (retryAfter > 0) error.retryAfter = retryAfter;
  return error;
}

function maxResults(config) {
  const limit = Number(config.limit);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : DEFAULT_LIMIT;
}

export async function readLinear(config) {
  const key = config.linearKey?.trim();
  if (!key) throw sourceError("UNCONFIGURED", "请在本机配置 Linear 只读 API 密钥");

  const assignee = config.linearAssignee?.trim();
  const query = assignee ? `
    query DispatchIssues($limit: Int!, $assignee: String!) {
      issues(first: $limit, orderBy: updatedAt, filter: {assignee: {email: {eq: $assignee}}}) {
        ${ISSUE_FIELDS}
      }
    }
  ` : `
    query DispatchIssues($limit: Int!) {
      viewer {
        assignedIssues(first: $limit, orderBy: updatedAt) {
          ${ISSUE_FIELDS}
        }
      }
    }
  `;
  const variables = { limit: maxResults(config) };
  if (assignee) variables.assignee = assignee;

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    redirect: "error"
  }).catch(() => {
    throw sourceError("NETWORK", "暂时无法连接 Linear");
  });

  if (response.status === 401 || response.status === 403) {
    throw sourceError("AUTH", "Linear 密钥失效或缺少读取权限");
  }
  if (response.status === 429) {
    throw sourceError("RATE_LIMIT", "Linear 达到读取频率限制", Number(response.headers.get("Retry-After")) * 1000);
  }
  if (!response.ok) throw sourceError("UPSTREAM", "Linear 暂时不可用");
  const result = await response.json().catch(() => {
    throw sourceError("UPSTREAM", "Linear 返回了无法读取的数据");
  });
  if (Array.isArray(result?.errors) && result.errors.length) {
    if (result.errors.some((error) => error.extensions?.code === "RATELIMITED")) {
      throw sourceError("RATE_LIMIT", "Linear 达到读取频率限制", Number(response.headers.get("Retry-After")) * 1000);
    }
    throw sourceError("UPSTREAM", "Linear 未能返回任务列表");
  }
  const nodes = assignee ? result?.data?.issues?.nodes : result?.data?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(nodes) || nodes.some((issue) =>
    typeof issue?.identifier !== "string" || typeof issue.title !== "string" || typeof issue.state?.name !== "string"
  )) {
    throw sourceError("UPSTREAM", "Linear 返回了不完整的任务列表");
  }
  const workspace = config.linearWorkspace?.trim().toLowerCase();
  if (workspace && nodes.some((issue) => !issue.url?.toLowerCase().startsWith(`https://linear.app/${workspace}/issue/`))) {
    throw sourceError("AUTH", "Linear 返回了其他工作区的任务");
  }
  return nodes.map((issue) => ({
    id: issue.identifier,
    title: issue.title,
    status: issue.state.name,
    statusType: issue.state.type,
    url: issue.url,
    project: issue.project?.name,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt
  }));
}

function issueIdentifier(title, branch) {
  const pattern = /\b[A-Z][A-Z0-9]*-\d+\b/i;
  return (title.match(pattern)?.[0] || branch?.match(pattern)?.[0])?.toUpperCase();
}

export async function readGitHub(config) {
  if (!config.githubRepo || !/^[\w.-]+\/[\w.-]+$/.test(config.githubRepo)) {
    throw sourceError("UNCONFIGURED", "请在本机配置要跟踪的 GitHub 仓库");
  }
  const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
  delete env.LINEAR_API_KEY;
  const { stdout } = await run(config.ghPath || "gh", [
    "pr", "list", "--repo", config.githubRepo, "--author", config.githubAuthor || "@me",
    "--state", "all", "--search", "sort:updated-desc", "--limit", String(maxResults(config)),
    "--json", "number,title,headRefName,state,isDraft,reviewDecision,url,createdAt,updatedAt,mergedAt"
  ], { timeout: REQUEST_TIMEOUT, maxBuffer: 2_000_000, env }).catch((error) => {
    if (error.code === "ENOENT") throw sourceError("UNCONFIGURED", "找不到 GitHub CLI");
    const stderr = String(error.stderr || "");
    if (/rate limit|abuse detection/i.test(stderr)) throw sourceError("RATE_LIMIT", "GitHub 达到读取频率限制");
    if (/auth login|bad credentials|not logged in|could not resolve to a repository|resource not accessible|HTTP 40[134]/i.test(stderr)) {
      throw sourceError("AUTH", "请检查 GitHub 登录和仓库读取权限");
    }
    throw sourceError("UPSTREAM", "暂时无法读取 GitHub PR");
  });

  let pulls;
  try {
    pulls = JSON.parse(stdout);
  } catch {
    throw sourceError("UPSTREAM", "GitHub 返回了无法读取的数据");
  }
  if (!Array.isArray(pulls) || pulls.some((pull) =>
    !Number.isSafeInteger(pull?.number) || typeof pull.title !== "string" || typeof pull.state !== "string"
  )) {
    throw sourceError("UPSTREAM", "GitHub 返回了不完整的 PR 列表");
  }
  return pulls.map(({ headRefName, ...pull }) => ({ ...pull, issueId: issueIdentifier(pull.title, headRefName) }));
}
