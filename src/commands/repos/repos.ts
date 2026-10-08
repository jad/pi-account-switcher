import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import type { AccountSwitcher } from "../../runtime";
import type { AccountConfig, AccountSwitcherContext } from "../../types";
import { COMMANDS } from "../../constants";
import { findGitRepositoryRoot, findMatchingRepo } from "../../utils";
import { BaseCommand } from "../base";
import { buildGroupedItems } from "../accounts/shared/select";

export const useReposCommand = (pi: ExtensionAPI, runtime: AccountSwitcher) => {
  new ReposCommand(pi, runtime).register();
};

class ReposCommand extends BaseCommand {
  constructor(pi: ExtensionAPI, runtime: AccountSwitcher) {
    super(pi, runtime, COMMANDS.accounts.repos);
  }

  async handler(ctx: AccountSwitcherContext): Promise<void> {
    await this.runtime.load();
    const accounts = this.runtime.getAccounts();
    if (accounts.length === 0) {
      ctx.ui.notify("No accounts configured.", "info");
      return;
    }

    const repositoryRoot = ctx.cwd ? findGitRepositoryRoot(ctx.cwd) : undefined;
    const activeAccount = this.runtime.getActiveAccount();
    const entryOptions =
      repositoryRoot && activeAccount
        ? ["Auto-save current repository", "Select an account to configure"]
        : ["Select an account to configure"];
    const entry = await ctx.ui.select("Repository auto-select", entryOptions);
    if (!entry) return;

    if (entry === "Auto-save current repository") {
      if (activeAccount && repositoryRoot) await this.addRepository(ctx, activeAccount, repositoryRoot);
      return;
    }

    const account = await this.pickAccount(ctx, accounts);
    if (!account) return;
    await this.manageRepos(ctx, account, repositoryRoot);
  }

  private async addRepository(
    ctx: AccountSwitcherContext,
    account: AccountConfig,
    repositoryRoot: string,
  ): Promise<void> {
    const current = this.runtime.getAccounts().find((candidate) => candidate.id === account.id) ?? account;
    if (findMatchingRepo([current], repositoryRoot)) {
      ctx.ui.notify(`Repository already configured for ${current.label}.`, "info");
      return;
    }

    const repo = collapseHome(repositoryRoot);
    await this.runtime.editAccount(current, { ...current, repos: [...(current.repos ?? []), repo] });
    ctx.ui.notify(`Added repo: ${repo}`, "info");
  }

  private async manageRepos(
    ctx: AccountSwitcherContext,
    account: AccountConfig,
    repositoryRoot: string | undefined,
  ): Promise<void> {
    const current = this.runtime.getAccounts().find((candidate) => candidate.id === account.id) ?? account;
    const repos = current.repos ?? [];
    ctx.ui.notify(`Account: ${current.label} | Repos: ${repos.length > 0 ? repos.join(", ") : "(none)"}`, "info");

    const options = [...(repositoryRoot ? ["Add current repository"] : []), "Remove repository"];
    const action = await ctx.ui.select("Repository auto-select", options);
    if (!action) return;

    if (action === "Add current repository") {
      if (repositoryRoot) await this.addRepository(ctx, current, repositoryRoot);
      return;
    }

    if (repos.length === 0) {
      ctx.ui.notify("No repositories configured.", "info");
      return;
    }
    const selected = await ctx.ui.select("Remove repository", repos);
    if (!selected) return;
    const updatedRepos = repos.filter((repo) => repo !== selected);
    await this.runtime.editAccount(current, { ...current, repos: updatedRepos.length > 0 ? updatedRepos : undefined });
    ctx.ui.notify(`Removed repo: ${selected}`, "info");
  }

  private async pickAccount(
    ctx: AccountSwitcherContext,
    accounts: AccountConfig[],
  ): Promise<AccountConfig | undefined> {
    const items = buildGroupedItems(accounts, this.runtime.getProviders(), this.runtime.getActiveAccount()?.id);
    const labels: string[] = [];
    const values: Array<AccountConfig | null> = [];
    for (const item of items) {
      if (item.type === "header") {
        labels.push(item.provider);
        values.push(null);
      } else {
        labels.push(`  ${this.isActiveAccount(item.account) ? `${item.account.label} (active)` : item.account.label}`);
        values.push(item.account);
      }
    }
    return this.pickGrouped(ctx, "Pick account to configure repos", labels, values);
  }
}

function collapseHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
