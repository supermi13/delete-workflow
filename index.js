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

const fs = require("fs");

/* ------------------------------- constants ------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const FALSY = ["0", "no", "n", "false", "off"];
const DELETE_THROTTLE_MS = 150;
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;

const isAction = !!process.env.GITHUB_ACTIONS;

/* ------------------------------ log helpers ------------------------------ */

const log = {
  info: (msg) => console.log(msg),
  debug: (msg) => {
    if (isAction) console.log(`::debug::${msg}`);
  },
  warning: (msg) => {
    if (isAction) console.log(`::warning::${msg}`);
    else console.error(`⚠️  ${msg}`);
  },
  error: (msg) => {
    if (isAction) console.log(`::error::${msg}`);
    else console.error(`❌ ${msg}`);
  },
};

async function group(name, fn) {
  console.log(isAction ? `::group::${name}` : `── ${name} ${"─".repeat(Math.max(1, 60 - name.length))}`);
  try {
    return await fn();
  } finally {
    if (isAction) console.log("::endGroup::");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------------------------- input handling ---------------------------- */

/**
 * CLI flags: --name value / --name=value / boolean flag.
 * Names are normalized to snake_case so --retain-days and --retain_days match.
 */
function parseArgs(args) {
  const map = new Map();
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw.startsWith("--")) continue;
    let key = raw.slice(2);
    let val;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        val = "true";
      }
    }
    key = key.toLowerCase().replace(/-/g, "_");
    if (key === "execute") {
      map.set("dry_run", "false");
      continue;
    }
    map.set(key, val);
  }
  return map;
}

/** Precedence: CLI flag > INPUT_<NAME> env (action) > GITHUB_TOKEN/GH_TOKEN env (token only) > default. */
function readInput(rawName, argv) {
  const name = rawName.toLowerCase();
  if (argv.has(name)) return argv.get(name);
  const envValue = process.env[`INPUT_${name.toUpperCase()}`];
  if (envValue !== undefined && envValue !== "") return envValue;
  if (name === "token") {
    const tokenEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (tokenEnv) return tokenEnv;
  }
  return undefined;
}

const toBool = (value, defaultValue) => {
  if (value === undefined || value === "") return defaultValue;
  return !FALSY.includes(String(value).trim().toLowerCase());
};

const toNum = (value, name, { min = 0 } = {}) => {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`Invalid input "${name}": ${JSON.stringify(value)}`);
  }
  return n;
};

const splitList = (pattern) =>
  String(pattern ?? "")
    .split(/[\s,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);

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

/* ----------------------------- GitHub REST API --------------------------- */

class GitHub {
  constructor({ token, baseUrl }) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async request(method, path, { body } = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "delete-workflow",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt >= 4) throw new Error(`Network error calling ${method} ${path}: ${err.message}`);
        log.warning(`Network error (${err.message}), retry ${attempt}/3...`);
        await sleep(2000 * attempt);
        continue;
      }

      if (res.status === 204) return null;
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }

      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const rateLimited =
        (res.status === 403 || res.status === 429) &&
        (retryAfter > 0 || res.headers.get("x-ratelimit-remaining") === "0");
      if (rateLimited) {
        if (attempt >= 5) throw new Error(`Rate limit exceeded calling ${method} ${path}`);
        const resetMs = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
        let waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.max(1000, resetMs - Date.now() + 1000);
        waitMs = Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS);
        log.warning(`Rate limit hit on ${method} ${path}; waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }

      if (res.status >= 500 && attempt < 4) {
        await sleep(2000 * attempt);
        continue;
      }

      const errText = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} ${method} ${path}: ${errText.slice(0, 300)}`);
    }
  }

  /** Flatten any paginated list endpoint into one array. `pick` selects the array field. */
  async paginate(path, params = {}, pick = (data) => data) {
    const out = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ ...params, per_page: "100", page: String(page) });
      const data = await this.request("GET", `${path}?${query.toString()}`);
      const items = pick(data);
      if (!Array.isArray(items) || items.length === 0) break;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
}

/* --------------------------- repository discovery ------------------------ */

function repoMatchesFilters(cfg, owner, repo) {
  if (!cfg.includePrivate && repo.private) return false;
  if (!cfg.includeForks && repo.fork) return false;
  if (!cfg.includeArchived && repo.archived) return false;

  const fullName = `${owner}/${repo.name}`.toLowerCase();
  if (cfg.excludeRepos.includes(fullName) || cfg.excludeRepos.includes(repo.name.toLowerCase())) {
    return false;
  }
  if (cfg.repoPattern) {
    const patterns = splitList(cfg.repoPattern).map((p) => p.toLowerCase());
    if (!patterns.some((p) => repo.name.toLowerCase().includes(p))) return false;
  }
  return true;
}

async function resolveRepositories(gh, cfg) {
  const explicit = splitList(cfg.repositories).filter((s) => s.toUpperCase() !== "ALL");
  const wantsAll = !explicit.length || splitList(cfg.repositories).some((s) => s.toUpperCase() === "ALL");
  if (explicit.length && !wantsAll) {
    const repos = explicit.map((full) => {
      const slash = full.indexOf("/");
      if (slash <= 0 || slash === full.length - 1) {
        throw new Error(`Invalid repository "${full}" (expected "owner/repo")`);
      }
      return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
    });
    return repos;
  }

  // ALL mode: enumerate every repository of the owner account.
  const me = await gh.request("GET", "/user");
  const owner = cfg.owner || me.login;
  if (!cfg.owner && /\[bot\]$/i.test(owner)) {
    throw new Error(
      `Token identifies "${owner}", not a user account. Set the "owner" input to the account whose repositories should be cleaned.`
    );
  }

  const account = await gh.request("GET", `/users/${encodeURIComponent(owner)}`);
  let listed;
  if (account.type === "Organization") {
    log.info(`🏛️  ${owner} is an organization; listing its repositories...`);
    listed = await gh.paginate(`/orgs/${owner}/repos`, { type: "all" });
  } else if (owner === me.login) {
    listed = await gh.paginate("/user/repos", { affiliation: "owner" });
  } else {
    listed = await gh.paginate(`/users/${owner}/repos`, { type: "owner" });
    log.warning(`Only public repositories of "${owner}" are visible to this token.`);
  }

  const seen = new Set();
  const repos = [];
  for (const repo of listed) {
    if (seen.has(repo.name.toLowerCase())) continue;
    seen.add(repo.name.toLowerCase());
    if (repoMatchesFilters(cfg, owner, repo)) repos.push({ owner, name: repo.name });
  }
  return repos;
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

/* -------------------------------- outputs -------------------------------- */

function writeActionOutputs(totals) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    `repos_processed=${totals.processed}\n` +
      `repos_failed=${totals.reposFailed}\n` +
      `deleted_count=${totals.deleted}\n` +
      `simulated_count=${totals.simulated}\n` +
      `failed_count=${totals.failed}\n`
  );
}

function appendStepSummary(totals, rows, cfg) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const mode = cfg.dryRun ? "🔍 dry-run (nothing deleted)" : "🗑️ executed";
  const lines = [
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
  ];
  fs.appendFileSync(summary, lines.join("\n"));
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

  appendStepSummary(totals, rows, cfg);
  writeActionOutputs(totals);

  const mode = cfg.dryRun ? "simulated" : "deleted";
  log.info(
    `🏁 Done. ${totals.processed} repo(s) processed (${totals.reposFailed} failed) · ` +
      `${totals.deleted} deleted · ${totals.simulated} ${mode} · ${totals.failed} failed deletions`
  );
  if (totals.reposFailed > 0 || totals.failed > 0) {
    log.warning("Some operations failed — see the logs above for details.");
  }
}

run().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
