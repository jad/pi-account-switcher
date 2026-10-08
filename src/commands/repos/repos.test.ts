import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useReposCommand } from "./repos";

describe("accounts:repos", () => {
  it("auto-saves the primary repository root to the active account", async () => {
    const base = mkdtempSync(join(tmpdir(), "account-switcher-command-"));
    const repo = join(base, "repo");
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      const account = {
        id: "work",
        label: "Work",
        provider: "anthropic",
        env: { ANTHROPIC_API_KEY: { type: "env", name: "ANTHROPIC_API_KEY" } },
      };
      const editAccount = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        load: vi.fn().mockResolvedValue(undefined),
        getAccounts: vi.fn().mockReturnValue([account]),
        getActiveAccount: vi.fn().mockReturnValue(account),
        editAccount,
      };
      let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          handler = command.handler;
        }),
      };
      useReposCommand(pi as any, runtime as any);

      const select = vi.fn().mockResolvedValue("Auto-save current repository");
      await handler!("", { cwd: repo, ui: { select, notify: vi.fn() } });

      expect(pi.registerCommand).toHaveBeenCalledWith("accounts:repos", expect.any(Object));
      expect(editAccount).toHaveBeenCalledWith(
        account,
        expect.objectContaining({ repos: [realpathSync.native(repo)] }),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
