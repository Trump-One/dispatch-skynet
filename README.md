# 任务调度中心

基于参考视频制作的 Linear / GitHub 任务调度演示。页面用旋转线框球、状态节点和光点展示任务如何按快照里的状态归类。点击任务可以查看原状态、关联项和原始链接。

## 打开

直接用浏览器打开 `index.html`。页面不需要安装依赖或启动服务。首次打开会使用示例任务。

## 换成真实任务

在「全部任务」中使用「载入任务快照」，选择本地 JSON。关闭或刷新页面会清除导入的数据。如需每次自动载入快照，可把 `index.html` 复制为 `preview.html`，在 `app.js` 的脚本标签前加上 `<script src="tasks.local.js"></script>`，并将 `window.DISPATCH_SNAPSHOT = <JSON>;` 写入 `tasks.local.js`。预览文件和本地快照均被 Git 忽略。

JSON 支持以下结构，其中日期使用 ISO 8601 格式，`issueId` 用于关联 Linear issue 和 PR。

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

每条记录可附 `url` 和 `updatedAt`。Linear 记录还可附 `project`、`completedAt`。GitHub 记录可附 `reviewDecision`、`mergedAt`、`createdAt`。页面按快照演示分流，浏览器无需连接 Linear 或 GitHub。
