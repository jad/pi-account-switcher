import { exec, execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const commonUtil = {
  unique: (values: string[]): string[] => {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  },

  isLikelyEnvKey: (value: string): boolean => {
    return /^[A-Z][A-Z0-9_]*$/.test(value);
  },

  omitUndefined: <T extends Record<string, unknown>>(value: T): T => {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
  },

  parseCsv: (value: string): string[] => {
    return [
      ...new Set(
        value
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      ),
    ];
  },

  blankToUndefined: (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  },

  parseJsonArray: (value: string | undefined, field: string): unknown[] | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
    return parsed;
  },

  parseJsonRecord: (value: string | undefined, field: string): Record<string, unknown> | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${field} must be a JSON object`);
    return parsed as Record<string, unknown>;
  },

  slugify: (value: string): string => {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  },

  runCommand: async (command: string): Promise<string> => {
    const { stdout } = await execAsync(command, { timeout: 15_000, maxBuffer: 1024 * 1024, env: process.env });
    return stdout.trim();
  },

  runOpRead: async (reference: string): Promise<string> => {
    const { stdout } = await execFileAsync("op", ["read", reference], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  },

  runWithConcurrency: async <T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
      await runNext();
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
    return results;
  },
};

/**
 * Find the account whose dirs contain the longest prefix of cwd.
 * Returns the account id, or undefined if no match.
 * On tie (same dir length on two accounts), first-in-array wins.
 */
export function findLongestMatchingDir<T extends { id: string; dirs?: string[] }>(
  accounts: T[],
  cwd: string,
): string | undefined {
  let bestId: string | undefined;
  let bestLen = -1;
  for (const account of accounts) {
    const dirs = account.dirs;
    if (!dirs || dirs.length === 0) continue;
    for (const dir of dirs) {
      const normalized = normalizeLocalPath(dir);
      const matches = normalized === "/" ? cwd.startsWith("/") : cwd === normalized || cwd.startsWith(normalized + "/");
      if (matches && normalized.length > bestLen) {
        bestLen = normalized.length;
        bestId = account.id;
      }
    }
  }
  return bestId;
}

/** Return the primary checkout root shared by a Git repository and its linked worktrees. */
export function findGitRepositoryRoot(cwd: string): string | undefined {
  try {
    const commonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commonDir) return undefined;
    const absolute = resolve(cwd, commonDir);
    return normalizeExistingPath(basename(absolute) === ".git" ? dirname(absolute) : absolute);
  } catch {
    return undefined;
  }
}

/** Match an account by exact Git repository root. First-in-array wins on ties. */
export function findMatchingRepo<T extends { id: string; repos?: string[] }>(
  accounts: T[],
  repositoryRoot: string,
): string | undefined {
  const normalizedRoot = normalizeExistingPath(repositoryRoot);
  return accounts.find((account) => account.repos?.some((repo) => normalizeExistingPath(repo) === normalizedRoot))?.id;
}

function normalizeLocalPath(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  const normalized = resolve(expanded);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function normalizeExistingPath(path: string): string {
  const normalized = normalizeLocalPath(path);
  try {
    return realpathSync.native(normalized);
  } catch {
    // A configured repository may be temporarily absent.
    return normalized;
  }
}
