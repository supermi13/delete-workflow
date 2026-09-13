#!/usr/bin/env node
/**
 * sync-forks — Sync every forked repository of an account with its upstream
 * ("Syncing a fork", the same operation as the "Sync fork" button).
 *
 * Companion to index.js (delete old workflow runs); both run in the same
 * scheduled workflow. Zero dependencies, dry-run by default.
 *
 * Sync semantics (POST /repos/{owner}/{repo}/merge-upstream):
 *   - "none"          → fork already up to date
 *   - "fast-forward"  → fork advanced to the upstream head (no data loss)
 *   - "merge"         → upstream merged into the fork (fork has own commits)
 *   - 409 diverged    → fork and upstream diverged; needs manual handling
 *
 * Usage (CLI):
 *   GITHUB_TOKEN=ghp_xxx node sync-forks.js --owner myname
 *   node sync-forks.js --repositories owner/a,owner/b --execute
 *
 * Usage (Action):
 *   - uses: supermi13/delete-workflow/sync-forks@main
 *     with:
 *       token: ${{ secrets.PAT }}
 */

"use strict";

const {
  log,
  group,
  sleep,
  parseArgs,
  readInput,
  toBool,
  splitList,
  GitHub,
  resolveRepositories,
  writeActionOutput,
  appendMarkdownSummary,
} = require("./lib");

const SYNC_THROTTLE_MS = 150;

/* ----------------------------- input handling ---------------------------- */

function resolveConfig(argv) {
  const cfg = {
    token: readInput("token", argv),
    baseUrl: (readInput("baseUrl", argv) || "https://api.github.com").replace(/\/+$/, ""),
    repositories: readInput("repositories", argv) || "",
    owner: (readInput("owner", argv) || "").trim(),
    includePrivate: toBool(readInput("include_private", argv), true),
    includeArchived: toBool(readInput("include_archived", argv), false),
    repoPattern: readInput("repo_pattern", argv) || "",
    excludeRepos: splitList(readInput("exclude_repos", argv) || "").map((s) => s.toLowerCase()),
    // This tool only ever touches forks.
    onlyForks: true,
    includeForks: true,
    dryRun: toBool(readInput("dry_run", argv), true),
  };
  if (!cfg.token) {
    throw new Error(
      "Missing token. Pass --token / INPUT_TOKEN / GITHUB_TOKEN (needs Contents write on every target fork)."
    );
  }
  return cfg;
}

/* ------------------------------ per-fork sync ---------------------------- */

async function syncFork(gh, cfg, repo) {
  const branch = repo.default_branch || "main";
  const full = `${repo.owner}/${repo.name}`;

  if (cfg.dryRun) {
    log.info(`[dry-run] 🔄 Would sync ${full} (branch ${branch}) with its upstream`);
    return { status: "simulated" };
  }

  try {
    const res = await gh.request("POST", `/repos/${repo.owner}/${repo.name}/merge-upstream`, {
      body: { branch },
    });
    const mergeType = res?.merge_type ?? "unknown";
    if (mergeType === "none") {
      log.info(`💤 ${full}: already up to date with upstream`);
      return { status: "up-to-date" };
    }
    log.info(`✅ ${full}: synced upstream into "${branch}" (${mergeType})${res?.message ? ` — ${res.message}` : ""}`);
    return { status: "synced", mergeType };
  } catch (err) {
    if (/\b409\b/.test(err.message)) {
      log.warning(`⚠️  ${full}: diverged from upstream — merge refused, needs manual handling`);
      return { status: "diverged" };
    }
    if (/not a fork|has no upstream/i.test(err.message)) {
      log.warning(`⚠️  ${full}: ${err.message}`);
      return { status: "skipped" };
    }
    log.error(`Failed to sync ${full}: ${err.message}`);
    return { status: "failed", error: err.message };
  } finally {
    await sleep(SYNC_THROTTLE_MS);
  }
}

/* ---------------------------------- main --------------------------------- */

async function run() {
  const cfg = resolveConfig(parseArgs(process.argv.slice(2)));
  const gh = new GitHub({ token: cfg.token, baseUrl: cfg.baseUrl });

  log.info(cfg.dryRun
    ? "🔍 DRY-RUN mode: forks will only be listed, nothing will be synced. Use dry_run=false (Action) or --execute (CLI) to sync."
    : "🔄 EXECUTE mode: forks will be synced with their upstream repositories.");

  const repos = await resolveRepositories(gh, cfg);
  if (repos.length === 0) {
    log.warning("No forked repositories matched the given filters; nothing to do.");
    return;
  }
  log.info(`🎯 ${repos.length} fork(s) to process:\n   ${repos.map((r) => `${r.owner}/${r.name}`).join("\n   ")}`);

  const totals = { total: repos.length, simulated: 0, synced: 0, upToDate: 0, diverged: 0, failed: 0, skipped: 0 };
  const rows = [];
  for (const repo of repos) {
    const result = await group(`${repo.owner}/${repo.name}`, async () => {
      // Explicit "owner/repo" lists carry no metadata; fetch it (and skip non-forks).
      if (repo.default_branch === undefined) {
        try {
          const detail = await gh.request("GET", `/repos/${repo.owner}/${repo.name}`);
          repo.default_branch = detail.default_branch;
          repo.fork = detail.fork;
        } catch (err) {
          log.error(`Failed to read ${repo.owner}/${repo.name}: ${err.message}`);
          return { status: "failed", error: err.message };
        }
        if (!repo.fork) {
          log.warning(`⚠️  ${repo.owner}/${repo.name} is not a fork; skipped`);
          return { status: "skipped" };
        }
      }
      return syncFork(gh, cfg, repo);
    });

    switch (result.status) {
      case "simulated": totals.simulated++; break;
      case "synced": totals.synced++; break;
      case "up-to-date": totals.upToDate++; break;
      case "diverged": totals.diverged++; break;
      case "failed": totals.failed++; break;
      default: totals.skipped++;
    }
    rows.push({
      repo: `${repo.owner}/${repo.name}`,
      branch: repo.default_branch || "main",
      status: result.error ? `error: ${String(result.error).replace(/\|/g, "/").slice(0, 120)}` : result.status,
    });
  }

  const mode = cfg.dryRun ? "🔍 dry-run (nothing synced)" : "🔄 executed";
  appendMarkdownSummary(
    [
      "## 🔄 Fork sync",
      "",
      `Mode: **${mode}** · Forks: **${totals.total}** · ` +
        `Synced: **${totals.synced}** · Up to date: **${totals.upToDate}** · ` +
        `Diverged: **${totals.diverged}** · Skipped: **${totals.skipped}** · Failed: **${totals.failed}**`,
      "",
      "| Fork | Default branch | Result |",
      "| --- | --- | --- |",
      ...rows.map((r) => `| ${r.repo} | ${r.branch} | ${r.status} |`),
      "",
    ].join("\n")
  );
  writeActionOutput("forks_total", totals.total);
  writeActionOutput("synced_count", totals.synced);
  writeActionOutput("up_to_date_count", totals.upToDate);
  writeActionOutput("diverged_count", totals.diverged);
  writeActionOutput("skipped_count", totals.skipped);
  writeActionOutput("failed_count", totals.failed);
  writeActionOutput("simulated_count", totals.simulated);

  log.info(
    `🏁 Done. ${totals.total} fork(s) · ${totals.synced} synced · ${totals.upToDate} up to date · ` +
      `${totals.diverged} diverged · ${totals.skipped} skipped · ${totals.failed} failed`
  );
  if (totals.failed > 0) {
    log.warning("Some forks failed to sync — see the logs above for details.");
  }
}

run().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
