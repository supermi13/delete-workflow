"use strict";

/**
 * Shared core for the delete-workflow project:
 * logging, input parsing, a zero-dependency GitHub REST client with
 * rate-limit handling, and account-wide repository discovery.
 */

const fs = require("fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const FALSY = ["0", "no", "n", "false", "off"];
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
  if (cfg.onlyForks && !repo.fork) return false;
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

/**
 * Resolve the target repositories.
 * - `repositories` lists explicit "owner/repo" entries → used as-is.
 * - otherwise "ALL" mode: enumerate every repository of `owner`
 *   (defaults to the token's own account; supports orgs) and apply filters.
 * Returns [{ owner, name, default_branch?, private?, fork? }, ...]
 */
async function resolveRepositories(gh, cfg) {
  const explicit = splitList(cfg.repositories).filter((s) => s.toUpperCase() !== "ALL");
  const wantsAll = !explicit.length || splitList(cfg.repositories).some((s) => s.toUpperCase() === "ALL");
  if (explicit.length && !wantsAll) {
    return explicit.map((full) => {
      const slash = full.indexOf("/");
      if (slash <= 0 || slash === full.length - 1) {
        throw new Error(`Invalid repository "${full}" (expected "owner/repo")`);
      }
      return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
    });
  }

  const me = await gh.request("GET", "/user");
  const owner = cfg.owner || me.login;
  if (!cfg.owner && /\[bot\]$/i.test(owner)) {
    throw new Error(
      `Token identifies "${owner}", not a user account. Set the "owner" input to the account whose repositories should be processed.`
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
    if (repoMatchesFilters(cfg, owner, repo)) {
      repos.push({
        owner,
        name: repo.name,
        default_branch: repo.default_branch,
        private: repo.private,
        fork: repo.fork,
      });
    }
  }
  return repos;
}

/* ------------------------- outputs / job summary ------------------------- */

function writeActionOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${key}=${value}\n`);
}

function appendMarkdownSummary(text) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  fs.appendFileSync(summary, text);
}

module.exports = {
  DAY_MS,
  isAction,
  log,
  group,
  sleep,
  parseArgs,
  readInput,
  toBool,
  toNum,
  splitList,
  GitHub,
  repoMatchesFilters,
  resolveRepositories,
  writeActionOutput,
  appendMarkdownSummary,
};
