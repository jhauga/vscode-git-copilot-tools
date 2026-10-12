import * as vscode from 'vscode';
import { isAbsolutePath, parseGitHubUrl } from 'cmd-git-copilot-tools';
import { FolderMappings, ORDERED_CATEGORIES, RepositorySource } from './types';
import { getLogger } from './logger';

const STORAGE_KEY = 'vscodeGitCopilotTools.sources';
const CONFIG_SECTION = 'vscode-git-copilot-tools';
const CONFIG_KEY = `${CONFIG_SECTION}.repositories`;
const DEFAULT_CACHE_TIMEOUT = 3600000;
const DEFAULT_SOURCES: RepositorySource[] = [
  { owner: 'github', repo: 'vscode-git-copilot-tools', label: 'Git Copilot Tools' }
];

/** aiFolder values already reported as ignored, so each one is logged once. */
const ignoredAiFolders = new Set<string>();

/** Extension settings that shape requests to GitHub. */
export interface EngineSettings {
  /** Lifetime of cached repository listings, in milliseconds. */
  cacheTimeout: number;
  /** Personal access token for GitHub Enterprise sources; empty when unset. */
  enterpriseToken: string;
  /** Skip certificate validation for GitHub Enterprise hosts. */
  allowInsecureEnterpriseCerts: boolean;
  /** Use the VS Code GitHub sign-in for github.com sources. */
  enableGithubAuth: boolean;
}

/** Read the settings that shape requests to GitHub, falling back to the package.json defaults. */
export function readEngineSettings(): EngineSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const cacheTimeout = config.get<unknown>('cacheTimeout');
  const enterpriseToken = config.get<unknown>('enterpriseToken');
  return {
    cacheTimeout: typeof cacheTimeout === 'number' && Number.isFinite(cacheTimeout) && cacheTimeout > 0
      ? cacheTimeout
      : DEFAULT_CACHE_TIMEOUT,
    enterpriseToken: typeof enterpriseToken === 'string' ? enterpriseToken.trim() : '',
    allowInsecureEnterpriseCerts: config.get<unknown>('allowInsecureEnterpriseCerts') === true,
    enableGithubAuth: config.get<unknown>('enableGithubAuth') !== false,
  };
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text === '' ? undefined : text;
}

function toFolderMappings(raw: unknown): FolderMappings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const input = raw as Record<string, unknown>;
  const mappings: FolderMappings = {};
  for (const category of ORDERED_CATEGORIES) {
    const value = input[category];
    if (value === null) {
      mappings[category] = null;
    } else if (typeof value === 'string') {
      mappings[category] = value.trim();
    } else if (Array.isArray(value)) {
      mappings[category] = value.filter((folder): folder is string => typeof folder === 'string');
    }
  }
  return mappings;
}

/**
 * Normalize stored repository sources for the engine. Entries without an owner
 * and a repo are dropped, text is trimmed, trailing slashes are removed from
 * `baseUrl`, and unknown properties are left out. An absolute `aiFolder` is
 * ignored, so downloads always land inside the workspace.
 */
export function toRepositorySources(raw: unknown): RepositorySource[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const sources: RepositorySource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const input = entry as Record<string, unknown>;
    const owner = readText(input.owner);
    const repo = readText(input.repo);
    if (!owner || !repo) {
      continue;
    }

    const source: RepositorySource = { owner, repo };
    const label = readText(input.label);
    if (label) {
      source.label = label;
    }
    const baseUrl = readText(input.baseUrl)?.replace(/\/+$/, '');
    if (baseUrl) {
      source.baseUrl = baseUrl;
    }
    const branch = readText(input.branch);
    if (branch) {
      source.branch = branch;
    }
    const folderMappings = toFolderMappings(input.folderMappings);
    if (folderMappings) {
      source.folderMappings = folderMappings;
    }
    const aiFolder = readText(input.aiFolder);
    if (aiFolder && isAbsolutePath(aiFolder)) {
      if (!ignoredAiFolders.has(aiFolder)) {
        ignoredAiFolders.add(aiFolder);
        getLogger().warn(`Ignoring aiFolder '${aiFolder}' for ${owner}/${repo}: use a folder relative to the workspace.`);
      }
    } else if (aiFolder) {
      source.aiFolder = aiFolder;
    }
    sources.push(source);
  }
  return sources;
}

/**
 * Read an "Add Repository" entry: a GitHub or GitHub Enterprise URL, where
 * `/tree/<branch>` selects the branch, or the `owner/repo` shorthand.
 * Undefined when the entry matches neither form.
 */
export function parseRepositoryInput(input: string): RepositorySource | undefined {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    const parsed = parseGitHubUrl(value.replace(/[?#].*$/, ''));
    if (!parsed) {
      return undefined;
    }
    const source: RepositorySource = { owner: parsed.owner, repo: parsed.repo };
    if (parsed.baseUrl) {
      source.baseUrl = parsed.baseUrl;
    }
    if (parsed.branch) {
      source.branch = parsed.branch;
    }
    return source;
  }

  const [owner, repo] = value.split('/').map(part => part.trim()).filter(Boolean);
  if (!owner || !repo) {
    return undefined;
  }
  return { owner, repo: repo.replace(/\.git$/, '') };
}

export class RepoStorage {
  /**
   * Get repository sources from VS Code settings first, then fallback to global state
   */
  static getSources(context: vscode.ExtensionContext): RepositorySource[] {
    // First try to get from VS Code settings
    const configSources = vscode.workspace.getConfiguration().get<unknown>(CONFIG_KEY);

    if (Array.isArray(configSources) && configSources.length > 0) {
      const sources = toRepositorySources(configSources);
      // Sync config to global state for backward compatibility
      void context.globalState.update(STORAGE_KEY, sources);
      return sources;
    }

    // Fallback to global state
    const stored = toRepositorySources(context.globalState.get<unknown>(STORAGE_KEY));
    if (stored.length > 0) {
      // Sync global state to config
      void this.syncToConfig(stored);
      return stored;
    }

    // Use defaults and sync to both
    void this.syncToConfig(DEFAULT_SOURCES);
    void context.globalState.update(STORAGE_KEY, DEFAULT_SOURCES);
    return [...DEFAULT_SOURCES];
  }

  /**
   * Set repository sources in both global state and VS Code settings
   */
  static async setSources(context: vscode.ExtensionContext, sources: RepositorySource[]): Promise<void> {
    // Update global state
    await context.globalState.update(STORAGE_KEY, sources);

    // Update VS Code settings
    await this.syncToConfig(sources);
  }

  /**
   * Get default repository sources
   */
  static getDefaultSources(): RepositorySource[] {
    return [...DEFAULT_SOURCES];
  }

  /**
   * Sync repository sources to VS Code settings
   */
  private static async syncToConfig(sources: RepositorySource[]): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(CONFIG_KEY, sources, vscode.ConfigurationTarget.Global);
    } catch (error) {
      getLogger().warn('Failed to sync repository sources to settings:', error);
    }
  }

  /**
   * Listen for configuration changes and sync back to global state
   */
  static onConfigurationChanged(context: vscode.ExtensionContext, callback?: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(CONFIG_KEY)) {
        const configSources = vscode.workspace.getConfiguration().get<unknown>(CONFIG_KEY);

        if (Array.isArray(configSources)) {
          // Sync from config to global state
          await context.globalState.update(STORAGE_KEY, toRepositorySources(configSources));

          // Notify callback if provided
          if (callback) {
            callback();
          }
        }
      }
    });
  }

  /**
   * Initialize repository sources from settings on startup
   */
  static async initializeFromSettings(context: vscode.ExtensionContext): Promise<void> {
    const sources = this.getSources(context);
    getLogger().info('Initialized repository sources:', sources.map(s => `${s.owner}/${s.repo}`).join(', '));
  }

  /**
   * Update folder mappings for a specific repository source
   */
  static async updateFolderMappings(
    context: vscode.ExtensionContext,
    owner: string,
    repo: string,
    folderMappings: FolderMappings
  ): Promise<void> {
    const sources = this.getSources(context);
    const source = sources.find(s => s.owner === owner && s.repo === repo);
    if (source) {
      source.folderMappings = folderMappings;
      await this.setSources(context, sources);
      getLogger().info(`Updated folder mappings for ${owner}/${repo}:`, folderMappings);
    }
  }
}
