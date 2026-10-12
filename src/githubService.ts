import * as vscode from 'vscode';
import {
    cache,
    configureRequests,
    downloadItem as engineDownloadItem,
    downloadPlugin as engineDownloadPlugin,
    fetchCategory,
    getDirectoryContents as engineGetDirectoryContents,
    getFileContent as engineGetFileContent,
    getFileContentByPath as engineGetFileContentByPath,
    listDirectoryTree as engineListDirectoryTree,
    parsePluginJson as engineParsePluginJson,
    pathExists as enginePathExists,
} from 'cmd-git-copilot-tools';
import {
    CopilotItem,
    EngineDownloadMetadata,
    GitHubApiError,
    GitHubFileContent,
    GitHubFileEntry,
    PluginDownloadResult,
    PluginParseResult,
    RepositorySource,
    ToolCategory,
} from './types';
import { EngineSettings, readEngineSettings } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { getLogger } from './logger';

/** Time one GitHub request may take before it is abandoned, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10000;
/** Shortest gap between two prompts raised by failed loads, in milliseconds. */
const AUTH_PROMPT_INTERVAL_MS = 60000;

/** Why a request failed, when signing in or waiting can help. */
export type AuthFailure =
    | { kind: 'rate-limit'; resetsInMinutes?: number }
    | { kind: 'auth'; status: number; message: string };

/**
 * Classify a failed request. Rate limits are checked first because GitHub
 * refuses them with 403; any other 401 or 403 is an authentication problem.
 * Undefined for every other failure.
 */
export function classifyAuthFailure(error: unknown, now: number = Date.now()): AuthFailure | undefined {
    if (!(error instanceof GitHubApiError)) {
        return undefined;
    }
    if (error.isRateLimit) {
        const resetsInMinutes = error.rateLimitReset
            ? Math.max(1, Math.ceil((error.rateLimitReset.getTime() - now) / 60000))
            : undefined;
        return { kind: 'rate-limit', resetsInMinutes };
    }
    if (error.status === 401 || error.status === 403) {
        return { kind: 'auth', status: error.status, message: error.message };
    }
    return undefined;
}

function withoutFinalPeriod(text: string): string {
    return text.replace(/\.+$/, '');
}

/**
 * GitHub access for the extension. Listing, reading, and downloading run in the
 * cmd-git-copilot-tools engine; this class supplies the token from VS Code
 * sign-in or the enterprise token setting, the cache lifetime from settings,
 * and the prompts that offer sign-in.
 */
export class GitHubService implements vscode.Disposable {
    private readonly statusBarManager: StatusBarManager;
    private readonly signedInEmitter = new vscode.EventEmitter<void>();
    /** Fires after the user signs in from a prompt this service showed. */
    readonly onDidSignIn: vscode.Event<void> = this.signedInEmitter.event;
    private signInOffered = false;
    private lastAuthPromptAt = 0;

    constructor(statusBarManager?: StatusBarManager) {
        // Use provided status bar manager or create a new one
        this.statusBarManager = statusBarManager || new StatusBarManager();
    }

    dispose(): void {
        this.signedInEmitter.dispose();
    }

    /** Pass the request settings to the engine. Call at activation and whenever they change. */
    applyRequestSettings(): void {
        const { allowInsecureEnterpriseCerts } = readEngineSettings();
        configureRequests({ allowInsecureEnterpriseCerts, timeoutMs: REQUEST_TIMEOUT_MS });
        if (allowInsecureEnterpriseCerts) {
            getLogger().warn('⚠️ SECURITY WARNING: certificate validation is off for GitHub Enterprise servers (allowInsecureEnterpriseCerts).');
        }
    }

    /**
     * Token for requests to `repo`. A GitHub Enterprise source uses the
     * enterpriseToken setting; a github.com source uses the VS Code GitHub
     * session when enableGithubAuth is on. The github.com session is never
     * sent to another host. Undefined when no token applies.
     */
    async resolveToken(repo?: RepositorySource, settings: EngineSettings = readEngineSettings()): Promise<string | undefined> {
        if (repo?.baseUrl) {
            return settings.enterpriseToken || undefined;
        }
        if (!settings.enableGithubAuth) {
            return undefined;
        }
        try {
            const session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: false,
                silent: true
            });
            return session?.accessToken;
        } catch (error) {
            getLogger().debug('GitHub authentication failed (silent):', error);
            return undefined;
        }
    }

    /**
     * Tools of one category in one repository, cached for the cacheTimeout
     * setting. A category folder the repository does not have lists nothing.
     */
    async getItems(repo: RepositorySource, category: ToolCategory, forceRefresh: boolean = false): Promise<CopilotItem[]> {
        const settings = readEngineSettings();
        if (forceRefresh) {
            cache.clearCategory(repo, category);
        }
        const token = await this.resolveToken(repo, settings);
        if (!token && !repo.baseUrl && settings.enableGithubAuth) {
            this.offerSignInOnce();
        }
        try {
            return await fetchCategory(repo, category, token, settings.cacheTimeout);
        } catch (error) {
            this.reportAuthFailure(error, repo, settings, token !== undefined);
            throw error;
        }
    }

    async getFileContent(repo: RepositorySource, downloadUrl: string): Promise<string> {
        return engineGetFileContent(downloadUrl, await this.resolveToken(repo));
    }

    /** Entries directly inside a repository folder (`''` for the root). */
    async getDirectoryContents(repo: RepositorySource, repoPath: string): Promise<GitHubFileEntry[]> {
        return engineGetDirectoryContents(repo, repoPath, await this.resolveToken(repo));
    }

    /** Entries of a repository folder and all of its subfolders. */
    async listDirectoryTree(repo: RepositorySource, repoPath: string): Promise<GitHubFileEntry[]> {
        return engineListDirectoryTree(repo, repoPath, await this.resolveToken(repo));
    }

    async getFileContentByPath(repo: RepositorySource, filePath: string): Promise<GitHubFileContent> {
        return engineGetFileContentByPath(repo, filePath, await this.resolveToken(repo));
    }

    /** Whether a repository path exists. Fails for errors other than "not found". */
    async pathExists(repo: RepositorySource, repoPath: string): Promise<boolean> {
        return enginePathExists(repo, repoPath, await this.resolveToken(repo));
    }

    async parsePluginJson(repo: RepositorySource, pluginDirPath: string): Promise<PluginParseResult> {
        return engineParsePluginJson(repo, pluginDirPath, await this.resolveToken(repo));
    }

    /**
     * Download a tool into its category folder in `workspaceFolder`, under
     * `targetName` when given. Existing files are overwritten.
     */
    async downloadItem(item: CopilotItem, workspaceFolder: string, targetName?: string): Promise<EngineDownloadMetadata> {
        return engineDownloadItem(item, workspaceFolder, await this.resolveToken(item.repo), { targetName });
    }

    /** Download a plugin item by item into the category folders of `workspaceFolder`. */
    async downloadPlugin(item: CopilotItem, workspaceFolder: string): Promise<PluginDownloadResult> {
        return engineDownloadPlugin(item, workspaceFolder, await this.resolveToken(item.repo));
    }

    clearCache(): void {
        cache.clear();
    }

    // Clear cache entries for a specific repository
    clearRepoCache(repo: RepositorySource): void {
        cache.clearRepo(repo);
        getLogger().info(`Cleared cache for repository: ${repo.owner}/${repo.repo}`);
    }

    // Clear cache for a specific category in a repository
    clearCategoryCache(repo: RepositorySource, category: ToolCategory): void {
        cache.clearCategory(repo, category);
        getLogger().debug(`Cleared cache for ${category} in ${repo.owner}/${repo.repo}`);
    }

    /** Offer sign-in once per session without holding up the load that noticed it. */
    private offerSignInOnce(): void {
        if (this.signInOffered) {
            return;
        }
        this.signInOffered = true;
        getLogger().info('No GitHub authentication found, offering sign-in.');
        void this.promptSignIn(
            'Sign in to GitHub to increase API rate limits from 60 to 5,000 requests per hour.',
            'info',
            'Skip'
        );
    }

    /**
     * Tell the user about a rate limit or an authentication failure, offering
     * sign-in or the enterprise token where that helps. At most one prompt is
     * shown per minute, and no prompt waits on the caller.
     */
    private reportAuthFailure(error: unknown, repo: RepositorySource, settings: EngineSettings, authenticated: boolean): void {
        const failure = classifyAuthFailure(error);
        if (!failure) {
            return;
        }
        const now = Date.now();
        if (now - this.lastAuthPromptAt < AUTH_PROMPT_INTERVAL_MS) {
            return;
        }
        this.lastAuthPromptAt = now;

        if (failure.kind === 'rate-limit') {
            const resets = failure.resetsInMinutes === undefined ? '' : ` Resets in ${failure.resetsInMinutes} minutes.`;
            this.statusBarManager.showWarning(`Rate limit exceeded.${resets}`);
            if (!authenticated && !repo.baseUrl && settings.enableGithubAuth) {
                void this.promptSignIn(
                    'GitHub API rate limit exceeded. Sign in to GitHub to get 5,000 requests/hour instead of 60.',
                    'warning',
                    'Wait'
                );
            }
            return;
        }

        if (repo.baseUrl) {
            void this.promptEnterpriseToken(
                `GitHub Enterprise authentication failed for ${repo.baseUrl}: ${withoutFinalPeriod(failure.message)}. ` +
                'Configure a Personal Access Token for this server.'
            );
            return;
        }
        if (!settings.enableGithubAuth) {
            this.statusBarManager.showWarning('GitHub authentication is disabled. Enable it to avoid rate limits.');
            return;
        }
        void this.promptSignIn(
            `GitHub API error: ${withoutFinalPeriod(failure.message)}. Sign in to access repositories and increase rate limits (60 → 5,000 requests/hour).`,
            'error',
            'Skip'
        );
    }

    private async promptSignIn(message: string, severity: 'info' | 'warning' | 'error', dismissLabel: string): Promise<void> {
        let choice: string | undefined;
        if (severity === 'error') {
            choice = await vscode.window.showErrorMessage(message, 'Sign In', dismissLabel);
        } else if (severity === 'warning') {
            choice = await vscode.window.showWarningMessage(message, 'Sign In', dismissLabel);
        } else {
            choice = await vscode.window.showInformationMessage(message, 'Sign In', dismissLabel);
        }
        if (choice !== 'Sign In') {
            return;
        }

        try {
            const session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: true
            });
            if (session) {
                this.statusBarManager.showInfo('GitHub authentication successful!');
                this.signedInEmitter.fire();
            }
        } catch (error) {
            getLogger().error('GitHub authentication error:', error);
        }
    }

    private async promptEnterpriseToken(message: string): Promise<void> {
        const choice = await vscode.window.showErrorMessage(message, 'Configure Token', 'Skip');
        if (choice === 'Configure Token') {
            await vscode.commands.executeCommand('vscode-git-copilot-tools.configureEnterpriseToken');
        }
    }
}
