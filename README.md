# 任务调度中心

本机运行的中文 Linear / GitHub 任务看板。左侧上方是任务池，下方是已完成池。任务完成或 PR 合并后会自动移入已完成池，右侧显示打开页面后观察到的状态变化。点击任务可以查看详情、关联项和原始链接，左下角可以播放参考视频风格的分流演示。

## 本机运行

需要 Node.js 22 或更新版本及已登录的 GitHub CLI。复制 `.env.example` 为 `.env.local`，填入要跟踪的仓库与 Linear 配置，然后启动本地服务。

```sh
node --env-file-if-exists=.env.local server.mjs
```

打开 [本机看板](http://127.0.0.1:4321)。默认约每 20 秒检查一次最近更新的 50 条指派给你的 Linear issue 和 50 条你提交的仓库 PR。当两边都读成功时，页面右上角显示「本地实时」。某一来源暂时失败时，另一来源继续更新，失败的来源保留上次成功的数据。读取恢复后，打开的页面会接着更新。终端按 Ctrl+C 可停止服务。

### Linear 连接

可复用 Codex 中已登录的 Linear 连接。填写 `LINEAR_LINK_ID`、`LINEAR_ASSIGNEE` 和 `LINEAR_WORKSPACE`。服务使用本机 Codex CLI 的实验性 App Server 工具接口读取指定负责人的 issue。如需指定 Codex 或 GitHub CLI 的路径，分别填写 `DISPATCH_CODEX_PATH` 或 `DISPATCH_GH_PATH`。

也可在 `.env.local` 中填入 Linear 的只读个人 API 密钥 `LINEAR_API_KEY`，由服务直接访问 Linear。省略 `LINEAR_ASSIGNEE` 时，使用密钥所属用户。参见 [Linear API 密钥文档](https://linear.app/docs/api-and-webhooks)。

服务只监听 `127.0.0.1`，只读 Linear 与 GitHub。本机配置和缓存位于 Git 忽略的 `.env.local` 和 `.dispatch/`。

## 中文任务标题

本机可通过 `.dispatch/translations.json` 给任务标题和项目名添加中文译文。文件是由原文到中文的 JSON 对象，页面可展开查看标题原文，也支持中英文搜索。支持本地翻译的浏览器可以处理新出现的英文标题。缺少语言包时，「全部任务」里会提供启用入口。

## 离线演示

直接在浏览器打开 `index.html` 可查看示例数据。也可以在「全部任务」里载入本地 JSON 快照。JSON 使用以下结构，`issueId` 可将 Linear issue 和 GitHub PR 关联起来。

```json
{
  "snapshotAt": "2026-11-16T10:00:00Z",
  "issues": [
    {"id":"DEMO-1","title":"整理反馈","status":"In Progress","statusType":"started"}
  ],
  "pullRequests": [
    {"number":42,"title":"更新界面","state":"OPEN","isDraft":false,"issueId":"DEMO-1"}
  ]
}
```
