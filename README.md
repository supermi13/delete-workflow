# delete-workflow

[中文](#中文说明) | [English](#english)

---

<a id="english"></a>

Two scheduled maintenance tasks for your whole GitHub account:

1. 🗑️ **Delete old GitHub Actions workflow runs — across ALL repositories** (rewritten from [delete-workflow-runs](https://github.com/supermi13/delete-workflow-runs), which cleans one repository per run)
2. 🔄 **Sync all forked repositories with their upstream** ("Syncing a fork", like the "Sync fork" button)

One workflow runs both tasks together on one schedule — see [cleanup.yml](./.github/workflows/cleanup.yml).

## Highlights

- 🗂️ **All repositories at once** — one scheduled job or one command processes every repo you own (org support included)
- 🔄 **Fork auto-sync** — `merge-upstream` API for every fork: fast-forward, merge, or clear "diverged" report; nothing silently lost
- 🧩 **Zero dependencies, no build step** — plain `index.js` / `sync-forks.js` / `lib.js` on Node 18+ built-in `fetch`; no `dist/`, no `npm install`
- 🔀 **Dual mode** — GitHub Actions (composite, no build) *and* standalone CLI
- 🔍 **Dry-run by default** — deletions and syncs require an explicit opt-in
- 🧯 **Safe filters** — keep minimum runs per workflow (or per day), age limit, orphan-run cleanup, workflow-name/state/conclusion filters, skip runs linked to PRs or existing branches, repo name/exclusion filters
- 📊 **Job summary** — per-repository tables written to `$GITHUB_STEP_SUMMARY`, plus step outputs

## Quick start

### 1. Scheduled cleanup + fork sync (recommended)

Copy [.github/workflows/cleanup.yml](./.github/workflows/cleanup.yml) into any repository, then:

1. Create a classic PAT with `repo` scope (or a fine-grained PAT with *Actions: Read and write* + *Contents: Read and write*) and add it as the repository secret **`PAT`** — the built-in `github.token` cannot reach your other repositories;
2. Adjust `owner`, `retain_days`, `keep_minimum_runs` in the workflow;
3. Trigger it manually with `dry_run` checked to preview; uncheck to execute. The daily 03:00 UTC schedule runs for real.

### 2. Use the actions separately

```yaml
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: supermi13/delete-workflow@main          # delete old runs (ALL mode)
        with:
          token: ${{ secrets.PAT }}
          owner: your-username
          repositories: ALL
          retain_days: "30"
          keep_minimum_runs: "6"
          dry_run: false

      - uses: supermi13/delete-workflow/sync-forks@main   # sync every fork
        with:
          token: ${{ secrets.PAT }}
          owner: your-username
          repositories: ALL
          dry_run: false
```

### 3. As a CLI

```bash
# Preview what would be deleted in ALL your repositories (safe)
GITHUB_TOKEN=$(gh auth token) node index.js --execute=false

# Delete runs older than 7 days in two specific repositories
node index.js --repositories owner/a,owner/b --retain-days 7 --execute

# Sync every fork of the account (preview first, then execute)
node sync-forks.js --owner your-username
node sync-forks.js --owner your-username --execute

# Only the "CI" workflow, keep at least 5 newest runs per workflow
node index.js --owner your-username --workflow-pattern CI --keep-minimum-runs 5 --execute
```

## Inputs — delete-workflow (root)

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

## Inputs — sync-forks

| Input | Default | Description |
| --- | --- | --- |
| `token` | `""` | GitHub token with Contents write on every target fork |
| `baseUrl` | `https://api.github.com` | API base URL (GitHub Enterprise) |
| `owner` | token's account | Account whose forks are enumerated |
| `repositories` | `ALL` | `ALL`, or a list of `owner/repo` (non-forks are skipped) |
| `include_private` | `true` | Include private forks |
| `include_archived` | `false` | Include archived forks |
| `repo_pattern` | *(all)* | Only forks whose name contains one of these substrings |
| `exclude_repos` | *(none)* | Forks to skip |
| `dry_run` | `true` | **Simulate only.** Set `false` to sync for real |

Sync results per fork: `up-to-date` (nothing to do), `fast-forward` (advanced, no data loss), `merge` (upstream merged; the fork has its own commits), `diverged` (API refuses — needs manual handling), `skipped` (not a fork).

CLI flags mirror the inputs (`--retain-days 7`, `--dry-run`, `--execute` = `--dry-run false`, …). Token comes from `--token` / `INPUT_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`.

## Outputs

- delete-workflow: `repos_processed`, `repos_failed`, `deleted_count`, `simulated_count`, `failed_count`
- sync-forks: `forks_total`, `synced_count`, `up_to_date_count`, `diverged_count`, `skipped_count`, `failed_count`, `simulated_count`

Both also write a Markdown table to the job summary.

## Deleted runs are permanent

GitHub does not offer a restore. Keep `dry_run: true` until the preview looks right.

## License

[MIT](./LICENSE)

---

<a id="中文说明"></a>

## 中文说明

一套针对整个 GitHub 账号的定时维护工具，两项任务在同一工作流中同时运行：

1. 🗑️ **批量删除所有仓库的旧 workflow runs**（重写自单仓库版的 [delete-workflow-runs](https://github.com/supermi13/delete-workflow-runs)）
2. 🔄 **自动同步所有 fork 项目**（等同 GitHub 页面上的 "Sync fork" 按钮，把上游更新同步进 fork）

仓库内置 [cleanup.yml](./.github/workflows/cleanup.yml)：每天 03:00 UTC 同时执行上述两项任务。

**特点**

- 一次清理/同步账号下所有仓库（支持个人账号和组织），可按名称过滤、排除指定仓库
- fork 同步走官方 `merge-upstream` 接口：能快进就快进（不丢提交）、有自有提交则合并、与上游分叉则明确报告 manual 处理，绝不静默丢数据
- 零依赖、无需构建：`index.js`（删 runs）+ `sync-forks.js`（同步 fork）+ `lib.js`（共享核心），Node 18+ 即可
- 既是 Action 也是 CLI
- **默认 dry-run**，只模拟不改动，确认无误后再正式执行
- 删除支持：保留每个 workflow 最新 N 条 / 每天保留 N 条、按天数清理、清理孤儿 runs、按 workflow 名称/状态/结论过滤、跳过 PR 关联或分支仍存在的 runs
- 运行结束后在 Job Summary 输出每个仓库的统计表

**快速开始**

1. 把 [.github/workflows/cleanup.yml](./.github/workflows/cleanup.yml) 复制到任意仓库（本仓库已内置，可直接用）；
2. 创建带 `repo` 权限的 classic PAT，添加为仓库 Secret `PAT`（内置 `github.token` 只能访问当前仓库）；
3. 按需修改 `owner`、`retain_days` 等参数；
4. 手动触发并勾选 `dry_run` 预览 → 取消勾选正式执行，之后每日定时自动运行。

**命令行用法**

```bash
# 预览所有仓库将被删除的 runs（安全，不删除）
GITHUB_TOKEN=$(gh auth token) node index.js

# 真正删除：7 天前、两个指定仓库
node index.js --repositories owner/a,owner/b --retain-days 7 --execute

# 预览/正式同步所有 fork 项目
node sync-forks.js --owner your-username
node sync-forks.js --owner your-username --execute

# 只清理名为 CI 的 workflow，每个 workflow 至少保留最新 5 条
node index.js --owner your-username --workflow-pattern CI --keep-minimum-runs 5 --execute
```

⚠️ **删除不可恢复**：GitHub 不提供已删除 runs 的恢复功能，请先 dry-run 预览。fork 同步不会丢失提交（分叉时会被 API 拒绝并报告）。
