import { readFile } from "node:fs/promises";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AccountConfig, PiAuthEntry, SecretSource } from "../types";
import { commonUtil } from "./common";
import { fileUtil } from "./files";
import { providerUtil } from "./providers";

export const accountUtil = {
  clearAccountEnv: async (account: AccountConfig, modelRegistry?: ModelRegistry): Promise<void> => {
    // Clear the cross-process inheritance env var
    delete process.env.PI_ACCOUNT_SWITCHER_ACTIVE_ID;
    const authProvider = account.piAuth?.provider ?? providerUtil.normalizeProvider(account.provider);
    if (!account.piAuth && account.env) {
      for (const envName of Object.keys(account.env)) {
        delete process.env[envName];
      }
    }
    await removeRuntimeApiKey(modelRegistry, authProvider);
  },

  applyAccountEnv: async (
    account: AccountConfig,
    modelRegistry?: ModelRegistry,
    authProviderOverride?: string,
  ): Promise<string[]> => {
    if (account.piAuth) {
      const authProvider = authProviderOverride ?? account.piAuth.provider;
      await setStoredCredential(modelRegistry, authProvider, account.piAuth.entry);
      closeCachedSessions();
      return [];
    }

    const resolved = await accountUtil.resolveAccountEnv(account);
    return accountUtil.applyResolvedAccountEnv(account, resolved, modelRegistry, authProviderOverride);
  },

  resolveAccountEnv: async (account: AccountConfig): Promise<Array<[string, string]>> => {
    if (!account.env) return [];

    const resolvedEntries: Array<[string, string]> = [];
    for (const [envName, source] of Object.entries(account.env)) {
      const value = await accountUtil.resolveSecret(source);
      if (!value) throw new Error(`Resolved empty value for ${envName} in account ${account.id}`);
      resolvedEntries.push([envName, value]);
    }
    return resolvedEntries;
  },

  applyResolvedAccountEnv: async (
    account: AccountConfig,
    resolvedEntries: Array<[string, string]>,
    modelRegistry?: ModelRegistry,
    authProviderOverride?: string,
  ): Promise<string[]> => {
    const authProvider = authProviderOverride ?? providerUtil.normalizeProvider(account.provider);
    const applied: string[] = [];
    for (const [envName, value] of resolvedEntries) {
      process.env[envName] = value;
      applied.push(envName);
    }

    const firstValue = resolvedEntries[0]?.[1];
    if (firstValue) await setRuntimeApiKey(modelRegistry, authProvider, firstValue);
    else await removeRuntimeApiKey(modelRegistry, authProvider);

    return applied;
  },

  resolveSecret: async (source: SecretSource): Promise<string> => {
    if (typeof source === "string") {
      if (source.startsWith("op://")) return commonUtil.runOpRead(source);
      return source;
    }
    switch (source.type) {
      case "literal":
        return source.value;
      case "env": {
        const value = process.env[source.name];
        if (!value) throw new Error(`Environment variable ${source.name} is not set`);
        return value;
      }
      case "file":
        return (await readFile(fileUtil.expandHome(source.path), "utf8")).trim();
      case "command":
        return commonUtil.runCommand(source.command);
      case "op":
        return commonUtil.runOpRead(source.reference);
    }
  },
};

type LegacyAuthStorage = {
  set(provider: string, credential: PiAuthEntry): void;
  reload(): void;
  setRuntimeApiKey(provider: string, apiKey: string): void;
  removeRuntimeApiKey(provider: string): void;
};

type ModernCredentialStore = {
  modify(provider: string, update: () => Promise<PiAuthEntry>): Promise<unknown>;
};

type ModernModelRuntime = {
  credentials?: ModernCredentialStore;
  refresh(options: { allowNetwork: boolean; providers: string[] }): Promise<unknown>;
  setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey(provider: string): Promise<void>;
};

type CompatibleModelRegistry = ModelRegistry & {
  authStorage?: LegacyAuthStorage;
  runtime?: ModernModelRuntime;
};

function compatibleRegistry(modelRegistry?: ModelRegistry): CompatibleModelRegistry | undefined {
  return modelRegistry as CompatibleModelRegistry | undefined;
}

async function setStoredCredential(
  modelRegistry: ModelRegistry | undefined,
  provider: string,
  credential: PiAuthEntry,
): Promise<void> {
  const registry = compatibleRegistry(modelRegistry);
  if (!registry) return;

  if (registry.authStorage) {
    registry.authStorage.set(provider, credential);
    registry.authStorage.reload();
    return;
  }

  const runtime = registry.runtime;
  if (!runtime?.credentials) {
    throw new Error("This Pi version does not expose a compatible credential store");
  }
  await runtime.credentials.modify(provider, async () => credential);
  await runtime.refresh({ allowNetwork: false, providers: [provider] });
}

async function setRuntimeApiKey(
  modelRegistry: ModelRegistry | undefined,
  provider: string,
  apiKey: string,
): Promise<void> {
  const registry = compatibleRegistry(modelRegistry);
  if (registry?.authStorage) {
    registry.authStorage.setRuntimeApiKey(provider, apiKey);
    return;
  }
  await registry?.runtime?.setRuntimeApiKey(provider, apiKey);
}

async function removeRuntimeApiKey(modelRegistry: ModelRegistry | undefined, provider: string): Promise<void> {
  const registry = compatibleRegistry(modelRegistry);
  if (registry?.authStorage) {
    registry.authStorage.removeRuntimeApiKey(provider);
    return;
  }
  await registry?.runtime?.removeRuntimeApiKey(provider);
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/$/, "");
}

/**
 * Check if an account has a specific directory.
 * Normalizes trailing slashes before comparison.
 */
export function hasDir<T extends { dirs?: string[] }>(account: T, dir: string): boolean {
  const dirs = account.dirs;
  if (!dirs || dirs.length === 0) return false;
  const normalized = normalizeDir(dir);
  return dirs.some((d) => normalizeDir(d) === normalized);
}

/**
 * Add a directory to an account.
 * Returns a new AccountConfig with the dir added, or null if the dir already exists.
 * Dirs are kept sorted for consistent display.
 */
export function addDirToAccount<T extends { id: string; label: string; provider: string; dirs?: string[] }>(
  account: T,
  dir: string,
): T | null {
  if (hasDir(account, dir)) return null;

  const existing = account.dirs ?? [];
  const newDirs = [...existing, dir].sort();
  return { ...account, dirs: newDirs };
}

/**
 * Remove a directory from an account.
 * Returns a new AccountConfig with the dir removed, or null if the dir does not exist.
 */
export function removeDirFromAccount<T extends { id: string; label: string; provider: string; dirs?: string[] }>(
  account: T,
  dir: string,
): T | null {
  const dirs = account.dirs;
  if (!dirs || dirs.length === 0) return null;

  const normalized = normalizeDir(dir);
  const filtered = dirs.filter((d) => normalizeDir(d) !== normalized);

  if (filtered.length === dirs.length) return null;
  if (filtered.length === 0) return { ...account, dirs: undefined };
  return { ...account, dirs: filtered };
}

function closeCachedSessions(): void {
  // Dynamic import so the module is not required at load time — @earendil-works/pi-ai
  // is a peerDependency provided by the pi agent host, not bundled with this package.
  import("@earendil-works/pi-ai")
    .then((piAi) => {
      const helpers = piAi as {
        cleanupSessionResources?: () => void;
        closeOpenAICodexWebSocketSessions?: () => void;
      };
      helpers.cleanupSessionResources?.();
      helpers.closeOpenAICodexWebSocketSessions?.();
    })
    .catch(() => {
      // pi-ai not available in this environment — skip session cleanup
    });
}
