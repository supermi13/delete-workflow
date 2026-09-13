#!/usr/bin/env node
/**
 * delete-workflow — Delete old GitHub Actions workflow runs.
 *
 * Rewritten from delete-workflow-runs (single-repository action) with:
 *   - ALL-repositories support: enumerate every repo of a user/org account
 *   - zero dependencies: Node 18+ global fetch, no build step, no dist/
 *   - dual mode: GitHub Action (composite) and standalone CLI
 *   - dry-run by default: deletions require an explicit opt-in
 *
 * Usage (CLI):
 *   GITHUB_TOKEN=ghp_xxx node index.js --owner myname --execute
 *   node index.js --repositories owner/a,owner/b --retain-days 7 --dry-run
 *
 * Usage (Action):
 *   - uses: supermi13/delete-workflow@main
 *     with:
 *       token: ${{ secrets.PAT }}
 *       repositories: ALL
 *       dry_run: false
 */

"use strict";

const {
  DAY_MS,
  log,
  group,
  sleep,
  parseArgs,
  readInput,
  toBool,
  toNum,
  splitList,
  GitHub,
  resolveRepositories,
  writeActionOutput,
  appendMarkdownSummary,
} = require("./lib");

const DELETE_THROTTLE_MS = 150;

/* ----------------------------- input handling ---------------------------- */

function resolveConfig(argv) {
  const cfg = {
    token: readInput("token", argv),
    baseUrl: (readInput("baseUrl", argv) || "https://api.github.com").replace(/\/+$/, ""),
    repositories: readInput("repositories", argv) || "",
    owner: (readInput("owner", argv) || "").trim(),
    includePrivate: toBool(readInput("include_private", argv), true),
    includeForks: toBool(readInput("include_forks", argv), false),
    includeArchived: toBool(readInput("include_archived", argv), false),
    repoPattern: readInput("repo_pattern", argv) || "",
    excludeRepos: splitList(readInput("exclude_repos", argv) || "").map((s) => s.toLowerCase()),
    retainDays: toNum(readInput("retain_days", argv), "retain_days") ?? 30,
    keepMinimumRuns: toNum(readInput("keep_minimum_runs", argv), "keep_minimum_runs") ?? 6,
    useDailyRetention: toBool(readInput("use_daily_retention", argv), false),
    deleteWorkflowPattern: readInput("delete_workflow_pattern", argv) || "",
    deleteWorkflowByStatePattern: readInput("delete_workflow_by_state_pattern", argv) || "ALL",
    deleteRunByConclusionPattern: readInput("delete_run_by_conclusion_pattern", argv) || "ALL",
    checkBranchExistence: toBool(readInput("check_branch_existence", argv), false),
    checkPullRequestExist: toBool(readInput("check_pullrequest_exist", argv), false),
    dryRun: toBool(readInput("dry_run", argv), true),
  };

  if (!cfg.token) {
    throw new Error(
      "Missing token. Pass --token / INPUT_TOKEN / GITHUB_TOKEN (needs Actions write + repo read on every target repository)."
    );
  }
  cfg.allowedConclusions =
    cfg.deleteRunByConclusionPattern.toUpperCase() === "ALL"
      ? []
      : splitList(cfg.deleteRunByConclusionPattern).map((c) => c.toLowerCase());
  return cfg;
}

/* ------------------------------ run filtering ---------------------------- */

function shouldDeleteRun(cfg, run, branchNames) {
  if (run.status !== "completed") {
    log.debug(`Skip run ${run.id}: status=${run.status}`);
    return false;
  }
  if (cfg.checkPullRequestExist && Array.isArray(run.pull_requests) && run.pull_requests.length > 0) {
    log.debug(`Skip run ${run.id}: linked to pull request(s)`);
    return false;
  }
  const headBranch = run.head_branch ?? "";
  if (cfg.checkBranchExistence && headBranch && branchNames.includes(headBranch)) {
    log.debug(`Skip run ${run.id}: branch "${headBranch}" still exists`);
    return false;
  }
  if (cfg.allowedConclusions.length > 0) {
    const conclusion = String(run.conclusion ?? "").toLowerCase();
    if (!cfg.allowedConclusions.includes(conclusion)) {
      log.debug(`Skip run ${run.id}: conclusion=${run.conclusion}`);
      return false;
    }
  }
  if (!cfg.useDailyRetention && cfg.retainDays > 0) {
    const created = new Date(run.created_at).getTime();
    if (!run.created_at || Number.isNaN(created)) {
      log.debug(`Skip run ${run.id}: no valid created_at`);
      return false;
    }
    const ageDays = (Date.now() - created) / DAY_MS;
    if (ageDays < cfg.retainDays) {
      log.debug(`Skip run ${run.id}: ${ageDays.toFixed(1)}d old (< ${cfg.retainDays}d)`);
      return false;
    }
  }
  return true;
}

/** Keep the newest N runs per day inside the retain window; everything else is deleted. */
function filterRunsByDailyRetention(candidates, keepMinimumRuns, retainDays) {
  if (keepMinimumRuns <= 0 || retainDays <= 0) {
    return { runsToDelete: candidates, runsToRetain: [] };
  }
  const cutoff = Date.now() - retainDays * DAY_MS;
  const runsByDate = new Map();
  const expired = [];
  for (const run of candidates) {
    const created = new Date(run.created_at).getTime();
    if (!run.created_at || Number.isNaN(created) || created < cutoff) {
      expired.push(run);
      continue;
    }
    const dateKey = new Date(created).toISOString().split("T")[0];
    if (!runsByDate.has(dateKey)) runsByDate.set(dateKey, []);
    runsByDate.get(dateKey).push(run);
  }
  const runsToDelete = [...expired];
  const runsToRetain = [];
  for (const dayRuns of runsByDate.values()) {
    dayRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    runsToRetain.push(...dayRuns.slice(0, keepMinimumRuns));
    runsToDelete.push(...dayRuns.slice(keepMinimumRuns));
  }
  return { runsToDelete, runsToRetain };
}

/** Keep the newest N runs overall (reference behaviour); everything older is deleted. */
function applyRetention(candidates, cfg) {
  if (cfg.useDailyRetention) {
    return filterRunsByDailyRetention(candidates, cfg.keepMinimumRuns, cfg.retainDays);
  }
  const sorted = [...candidates].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (cfg.keepMinimumRuns > 0) {
    const keep = Math.min(cfg.keepMinimumRuns, sorted.length);
    return { runsToDelete: sorted.slice(0, sorted.length - keep), runsToRetain: sorted.slice(-keep) };
  }
  return { runsToDelete: sorted, runsToRetain: [] };
}

/* ------------------------------ deletions ------------------------------- */

async function deleteRuns(gh, cfg, owner, repo, runs, label) {
  const counts = { deleted: 0, simulated: 0, failed: 0 };
  if (!runs.length) return counts;

  for (const run of runs) {
    if (cfg.dryRun) {
      log.info(`[dry-run] 🚀 Would delete run ${run.id} (${run.name || label}, created ${run.created_at})`);
      counts.simulated++;
      continue;
    }
    try {
      await gh.request("DELETE", `/repos/${owner}/${repo}/actions/runs/${run.id}`);
      log.info(`✅ Deleted run ${run.id} (${run.name || label}, created ${run.created_at})`);
      counts.deleted++;
    } catch (err) {
      log.error(`Failed to delete run ${run.id}: ${err.message}`);
      counts.failed++;
    }
    await sleep(DELETE_THROTTLE_MS);
  }
  return counts;
}

function addCounts(target, source) {
  target.deleted += source.deleted;
  target.simulated += source.simulated;
  target.failed += source.failed;
}

/* ------------------------------ per-repo pass ---------------------------- */

function matchesPattern(workflow, patterns) {
  const filename = String(workflow.path ?? "").replace(/^\.github\/workflows\//, "");
  const name = String(workflow.name ?? "").toLowerCase();
  const file = filename.toLowerCase();
  return patterns.some((p) => name.includes(p) || file.includes(p));
}

async function cleanRepository(gh, cfg, owner, repo) {
  return group(`${owner}/${repo}`, async () => {
    const result = { candidates: 0, deleted: 0, simulated: 0, failed: 0, error: null };
    try {
      const workflows = await gh.paginate(
        `/repos/${owner}/${repo}/actions/workflows`,
        {},
        (d) => d.workflows
      );

      let branchNames = [];
      if (cfg.checkBranchExistence) {
        branchNames = (await gh.paginate(`/repos/${owner}/${repo}/branches`)).map((b) => b.name);
        log.info(`💬 ${branchNames.length} branch(es) found`);
      }

      let targets = workflows;
      if (cfg.deleteWorkflowPattern) {
        const patterns = splitList(cfg.deleteWorkflowPattern).map((p) => p.toLowerCase());
        targets = targets.filter((w) => matchesPattern(w, patterns));
        log.info(`🔍 Workflow pattern filter: ${patterns.join(", ")} → ${targets.length} match(es)`);
      }
      if (cfg.deleteWorkflowByStatePattern.toUpperCase() !== "ALL") {
        const states = splitList(cfg.deleteWorkflowByStatePattern).map((s) => s.toLowerCase());
        targets = targets.filter((w) => states.includes(String(w.state ?? "").toLowerCase()));
        log.info(`🔍 Workflow state filter: ${states.join(", ")} → ${targets.length} match(es)`);
      }

      const knownIds = new Set(workflows.map((w) => w.id));
      const allRuns = await gh.paginate(
        `/repos/${owner}/${repo}/actions/runs`,
        {},
        (d) => d.workflow_runs
      );
      log.info(`🏃 ${allRuns.length} run(s), ${workflows.length} workflow definition(s)`);

      const orphans = allRuns.filter((run) => !knownIds.has(run.workflow_id));
      if (orphans.length > 0) {
        log.info(`👻 ${orphans.length} orphan run(s) (workflow file removed)`);
        result.candidates += orphans.length;
        addCounts(result, await deleteRuns(gh, cfg, owner, repo, orphans, "orphan runs"));
      }

      const runsByWorkflow = new Map();
      for (const run of allRuns) {
        if (!runsByWorkflow.has(run.workflow_id)) runsByWorkflow.set(run.workflow_id, []);
        runsByWorkflow.get(run.workflow_id).push(run);
      }

      for (const workflow of targets) {
        await group(`${workflow.name} (ID: ${workflow.id})`, async () => {
          const runs = runsByWorkflow.get(workflow.id) ?? [];
          const candidates = runs.filter((run) => shouldDeleteRun(cfg, run, branchNames));
          const { runsToDelete, runsToRetain } = applyRetention(candidates, cfg);
          log.info(
            `💬 ${runs.length} run(s) → keep ${runsToRetain.length}, ${runsToDelete.length} to ${cfg.dryRun ? "simulate deleting" : "delete"}`
          );
          result.candidates += runsToDelete.length;
          addCounts(result, await deleteRuns(gh, cfg, owner, repo, runsToDelete, workflow.name));
        });
      }
    } catch (err) {
      result.error = err.message;
      log.error(`Repository ${owner}/${repo} failed: ${err.message}`);
    }
    return result;
  });
}

/* ---------------------------------- main --------------------------------- */

async function run() {
  const cfg = resolveConfig(parseArgs(process.argv.slice(2)));
  const gh = new GitHub({ token: cfg.token, baseUrl: cfg.baseUrl });

  log.info(cfg.dryRun
    ? "🔍 DRY-RUN mode: deletions will only be simulated. Set dry_run=false (Action) or --execute (CLI) to delete for real."
    : "🗑️ EXECUTE mode: matching runs will be permanently deleted.");

  const repos = await resolveRepositories(gh, cfg);
  if (repos.length === 0) {
    log.warning("No repositories matched the given filters; nothing to do.");
    return;
  }
  log.info(`🎯 ${repos.length} repository(ies) to process:\n   ${repos.map((r) => `${r.owner}/${r.name}`).join("\n   ")}`);

  const totals = { processed: 0, reposFailed: 0, deleted: 0, simulated: 0, failed: 0 };
  const rows = [];
  for (const { owner, name } of repos) {
    const result = await cleanRepository(gh, cfg, owner, name);
    totals.processed++;
    if (result.error) totals.reposFailed++;
    addCounts(totals, result);
    rows.push({
      repo: `${owner}/${name}`,
      candidates: result.candidates,
      deleted: result.deleted,
      simulated: result.simulated,
      failed: result.failed,
      error: result.error,
    });
  }

  const mode = cfg.dryRun ? "🔍 dry-run (nothing deleted)" : "🗑️ executed";
  appendMarkdownSummary(
    [
      "## 🗑️ Workflow runs cleanup",
      "",
      `Mode: **${mode}** · Retention: **${cfg.retainDays}d** · Keep minimum: **${cfg.keepMinimumRuns}**`,
      "",
      "| Repository | Candidates | Deleted | Simulated | Failed |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...rows.map((r) => {
        const failed = r.error ? `error: ${String(r.error).replace(/\|/g, "/").slice(0, 120)}` : r.failed;
        return `| ${r.repo} | ${r.candidates} | ${r.deleted} | ${r.simulated} | ${failed} |`;
      }),
      "",
    ].join("\n")
  );
  writeActionOutput("repos_processed", totals.processed);
  writeActionOutput("repos_failed", totals.reposFailed);
  writeActionOutput("deleted_count", totals.deleted);
  writeActionOutput("simulated_count", totals.simulated);
  writeActionOutput("failed_count", totals.failed);

  log.info(
    `🏁 Done. ${totals.processed} repo(s) processed (${totals.reposFailed} failed) · ` +
      `${totals.deleted} deleted · ${totals.simulated} simulated · ${totals.failed} failed deletions`
  );
  if (totals.reposFailed > 0 || totals.failed > 0) {
    log.warning("Some operations failed — see the logs above for details.");
  }
}

run().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
