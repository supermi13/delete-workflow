# delete-workflow

[中文](#中文说明) | [English](#english)

---

<a id="english"></a>

Delete old GitHub Actions workflow runs — **across ALL repositories** of a user or organization account.

Rewritten from [delete-workflow-runs](https://github.com/supermi13/delete-workflow-runs) (which cleans a single repository per run). This project enumerates **every repository** of the account and cleans them all in one pass.

## Highlights

- 🗂️ **All repositories at once** — one scheduled job or one command cleans every repo you own (org support included)
- 🧩 **Zero dependencies, no build step** — a single `index.js` using Node 18+ built-in `fetch`; no `dist/`, no `npm install`
- 🔀 **Dual mode** — works as a GitHub Action (composite) *and* as a standalone CLI
- 🔍 **Dry-run by default** — deletions never happen unless explicitly enabled
- 🧯 **Safe filters** — keep minimum runs per workflow (or per day), age limit, orphan-run cleanup, workflow-name/state/conclusion filters, skip runs linked to PRs or existing branches
- 📊 **Job summary** — per-repository table written to `$GITHUB_STEP_SUMMARY`, plus step outputs

## Quick start

### 1. As a GitHub Action (scheduled cleanup of all repositories)

Add `.github/workflows/cleanup.yml` to any repository:

```yaml
name: Cleanup workflow runs
on:
  schedule:
    - cron: "0 3 * * *" # daily
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run (simulate only)"
        type: boolean
        default: true

permissions: {}

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: supermi13/delete-workflow@main
        with:
          token: ${{ secrets.PAT }}   # classic PAT with `repo` scope
          owner: your-username
          repositories: ALL
          retain_days: "30"
          keep_minimum_runs: "6"
          dry_run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}
```

> **Token:** the built-in `github.token` can only see the repository it runs in. To clean **other** repositories, create a classic PAT with `repo` scope (or a fine-grained PAT with *Actions: Read and write*) and store it as the `PAT` secret.

### 2. As a CLI

```bash
# Preview what would be deleted in ALL your repositories (safe)
GITHUB_TOKEN=$(gh auth token) node index.js --execute=false

# Delete runs older than 7 days in two specific repositories
node index.js --repositories owner/a,owner/b --retain-days 7 --execute

# Only the "CI" workflow, keep at least 5 newest runs per workflow
node index.js --owner your-username --workflow-pattern CI --keep-minimum-runs 5 --execute
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `""` | GitHub token with Actions write + repo read on **every** target repository |
| `baseUrl` | `https://api.github.com` | API base URL (GitHub Enterprise) |
| `owner` | token's account | Account whose repos are enumerated (`ALL` mode); user or org |
| `repositories` | `ALL` | `ALL`, or a comma/space separated list of `owner/repo` |
| `include_private` | `true` | Include private repositories |
| `include_forks` | `false` | Include forked repositories |
| `include_archived` | `false` | Include archived repositories |
| `repo_pattern` | *(all)* | Only repos whose name contains one of these substrings |
| `exclude_repos` | *(none)* | Repos to skip (`owner/repo` or `repo-name`), comma-separated |
| `retain_days` | `30` | Delete runs older than N days (`0` = no age limit) |
| `keep_minimum_runs` | `6` | Newest runs kept per workflow (or per day with daily retention) |
| `use_daily_retention` | `false` | Apply `keep_minimum_runs` per day inside the retain window |
| `delete_workflow_pattern` | *(all)* | Workflow name/filename substring patterns, comma-separated |
| `delete_workflow_by_state_pattern` | `ALL` | Workflow states to target |
| `delete_run_by_conclusion_pattern` | `ALL` | Run conclusions to target, e.g. `Success,Failure` |
| `check_branch_existence` | `false` | Skip runs whose head branch still exists |
| `check_pullrequest_exist` | `false` | Skip runs linked to pull requests |
| `dry_run` | `true` | **Simulate only.** Set `false` to delete for real |

CLI flags mirror the inputs (`--retain-days 7`, `--dry-run`, `--execute` = `--dry-run false`, …). Token comes from `--token` / `INPUT_TOKEN` / `GITHUB_TOKEN`.

## Outputs

`repos_processed`, `repos_failed`, `deleted_count`, `simulated_count`, `failed_count` — also written as a Markdown table to the job summary.

## Deleted runs are permanent

GitHub does not offer a restore. Keep `dry_run: true` until the preview looks right.

## License

[MIT](./LICENSE)

---

<a id="中文说明"></a>

## 中文说明

批量删除 GitHub Actions 的旧 workflow runs —— 一次运行即可清理**账号下所有仓库**（重写自单仓库版的 [delete-workflow-runs](https://github.com/supermi13/delete-workflow-runs)）。

**特点**

- 一次清理所有仓库（支持个人账号和组织），可按名称过滤、排除指定仓库
- 零依赖、无需构建：单文件 `index.js`（Node 18+，使用内置 fetch），既是 Action 也是 CLI
- **默认 dry-run**，只模拟不删除，确认无误后再开启真实删除
- 支持：保留每个 workflow 最新 N 条 / 每天保留 N 条、按天数清理、清理孤儿 runs（workflow 文件已删除的残留 runs）、按 workflow 名称/状态/结论过滤、跳过 PR 关联或分支仍存在的 runs
- 运行结束后在 Job Summary 输出每个仓库的清理统计表

**快速开始**

1. 在任意仓库添加 `.github/workflows/cleanup.yml`（参考上方英文示例，可直接复制 [cleanup.yml](./.github/workflows/cleanup.yml)）；
2. 创建一个带 `repo` 权限的 classic PAT（内置 `github.token` 只能访问当前仓库，无法清理其他仓库），添加为仓库 Secret `PAT`；
3. 手动触发并勾选 `dry_run` 先预览，确认后再取消勾选正式删除，或等待每日定时任务执行。

**命令行用法**

```bash
# 预览所有仓库将被删除的 runs（安全，不删除）
GITHUB_TOKEN=$(gh auth token) node index.js

# 真正删除：7 天前、两个指定仓库
node index.js --repositories owner/a,owner/b --retain-days 7 --execute

# 只清理名为 CI 的 workflow，每个 workflow 至少保留最新 5 条
node index.js --owner your-username --workflow-pattern CI --keep-minimum-runs 5 --execute
```

⚠️ **删除不可恢复**：GitHub 不提供已删除 runs 的恢复功能，请先 dry-run 预览。
