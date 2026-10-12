// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getSkippedPluginEntries, resolveAiFolder, resolveCategoryDir } from 'cmd-git-copilot-tools';
import { VscodeGitCopilotToolsProvider, VscodeGitCopilotToolsTreeItem } from './treeProvider';
import { GitHubService } from './githubService';
import { CopilotPreviewProvider } from './previewProvider';
import { CopilotItem, GitHubApiError, ORDERED_CATEGORIES, PluginParseResult, RepositorySource, ToolCategory } from './types';
import { RepoStorage, parseRepositoryInput } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { DownloadTracker } from './downloadTracker';
import { SearchViewProvider } from './searchPanel';
import { showFolderMappingPanel } from './folderMappingPanel';
import { initializeLogger, getLogger } from './logger';
import { generateNoteContent } from './views/note.vscode-git-copilot-tools';

/** File written into each downloaded plugin folder, listing its slash commands. */
const NOTE_FILE_NAME = 'NOTE.VSCODE-VSCODE-GIT-COPILOT-TOOLS-EXTENSION.md';

/** How download prompts name the tool types that are folders. */
const FOLDER_LABELS: Partial<Record<ToolCategory, string>> = {
    hooks: 'hook folder',
    skills: 'skill folder',
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Validate a file or folder name typed into a download prompt. */
function validateDownloadName(value: string, emptyMessage: string): string | null {
    const name = value.trim();
    if (name === '') {
        return emptyMessage;
    }
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
        return 'Use a single name, without / or \\';
    }
    return null;
}

/** Category folder an item downloads into, honoring its source's aiFolder. */
function categoryDirFor(workspacePath: string, item: CopilotItem): string {
    return resolveCategoryDir(workspacePath, item.category, resolveAiFolder({ source: item.repo }));
}

/** A folder relative to the workspace, written with forward slashes. */
function toDisplayPath(workspacePath: string, folder: string): string {
    return path.relative(workspacePath, folder).split(path.sep).join('/');
}

function countFiles(dir: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
    }
    return count;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

    // Initialize logger with configuration monitoring
    initializeLogger(context);
    const logger = getLogger();

    // Initialize services
    const statusBarManager = new StatusBarManager();
    const githubService = new GitHubService(statusBarManager);
    const downloadTracker = new DownloadTracker(context);
    const treeProvider = new VscodeGitCopilotToolsProvider(githubService, context, downloadTracker);
    const previewProvider = new CopilotPreviewProvider();

    // Certificate validation stays on unless allowInsecureEnterpriseCerts is set,
    // and then only for GitHub Enterprise servers
    githubService.applyRequestSettings();
    logger.info('Extension initialized');

    // Download records saved by earlier versions use the old item ids
    await downloadTracker.migrateIds();

    // Register manage sources command (UI entry point)
    const manageSourcesDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.manageSources', async () => {
        // Main quick pick menu
        let sources = RepoStorage.getSources(context);
        while (true) {
            const pick = await vscode.window.showQuickPick([
                { label: 'Add Repository', description: 'Add a new public GitHub repo as a source' },
                { label: 'Remove Repository', description: 'Remove a repo from sources' },
                { label: 'Reset to Default', description: 'Restore default source list' },
                { label: 'View Sources', description: sources.map(s => `${s.owner}/${s.repo}`).join(', ') },
                { label: 'Done', description: 'Exit' }
            ], { placeHolder: 'Manage Copilot Sources' });
            if (!pick || pick.label === 'Done') { break; }
            if (pick.label === 'Add Repository') {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter GitHub repo (owner/repo or full URL)',
                    validateInput: (val: string) => {
                        if (!val || !val.trim()) { return 'Repository required'; }
                        return null;
                    }
                });
                if (!input) { continue; }

                // Parse input - supports owner/repo and GitHub or GitHub Enterprise URLs
                const source = parseRepositoryInput(input);
                logger.debug('Parsed repository input:', { input: input.trim(), source });
                if (!source) {
                    vscode.window.showErrorMessage(`Invalid repository format: "${input.trim()}". Use owner/repo or a full repository URL.`);
                    continue;
                }
                await addRepository(context, source, sources, githubService, statusBarManager, treeProvider);
            } else if (pick.label === 'Remove Repository') {
                if (sources.length === 1) {
                    vscode.window.showWarningMessage('At least one source is required.');
                    continue;
                }
                const toRemove = await vscode.window.showQuickPick(
                    sources.map(s => ({ label: `${s.owner}/${s.repo}`, source: s })),
                    { placeHolder: 'Select a repo to remove' }
                );
                if (!toRemove) { continue; }

                // Clear cache for the repository being removed
                githubService.clearRepoCache(toRemove.source);

                sources = sources.filter(s => `${s.owner}/${s.repo}` !== toRemove.label);
                await RepoStorage.setSources(context, sources);

                // Refresh the tree provider to update the UI
                treeProvider.refresh();

                statusBarManager.showSuccess(`Removed source: ${toRemove.label}`);
            } else if (pick.label === 'Reset to Default') {
                // Clear all cache before resetting
                githubService.clearCache();

                sources = RepoStorage.getDefaultSources();
                await RepoStorage.setSources(context, sources);

                // Refresh the tree provider to update the UI
                treeProvider.refresh();

                statusBarManager.showSuccess('Sources reset to default');
            } else if (pick.label === 'View Sources') {
                statusBarManager.showInfo('Current sources: ' + sources.map(s => `${s.owner}/${s.repo}`).join(', '), 8000);
            }
        }
    });

    // Initialize repository sources from settings
    await RepoStorage.initializeFromSettings(context);

    // Listen for configuration changes
    const configChangeDisposable = RepoStorage.onConfigurationChanged(context, () => {
        // Refresh tree view when configuration changes
        treeProvider.refresh();
        statusBarManager.showInfo('Repository sources updated from settings');
    });

    // Apply certificate handling changes as soon as the setting changes
    const requestSettingsDisposable = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vscode-git-copilot-tools.allowInsecureEnterpriseCerts')) {
            githubService.applyRequestSettings();
        }
    });

    // Reload with the new session after signing in from a prompt
    const signInDisposable = githubService.onDidSignIn(() => {
        githubService.clearCache();
        treeProvider.refresh();
    });

    // Register search webview provider for Activity Bar view
    const searchViewProvider = new SearchViewProvider(context.extensionUri, treeProvider.getSearchBar());
    const searchView = vscode.window.registerWebviewViewProvider('vscodeGitCopilotToolsSearch', searchViewProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    });

    // Register search webview provider for File Explorer view (shares same SearchBar)
    const searchViewProviderSecondary = new SearchViewProvider(context.extensionUri, treeProvider.getSearchBar());
    const searchViewSecondary = vscode.window.registerWebviewViewProvider('vscodeGitCopilotToolsSearchSecondary', searchViewProviderSecondary, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    });

    // Register providers - both views share the same data provider instance
    const treeView = vscode.window.createTreeView('vscodeGitCopilotToolsExplorer', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Register secondary view in explorer (shares same data provider)
    const treeViewSecondary = vscode.window.createTreeView('vscodeGitCopilotToolsExplorerSecondary', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Trigger initial load for both views
    treeProvider.refresh();

    // Auto-preview when selecting a file (both views)
    const handleSelection = async (e: vscode.TreeViewSelectionChangeEvent<VscodeGitCopilotToolsTreeItem>) => {
        const selectedItem = e.selection[0];
        if (selectedItem?.copilotItem) {
            await previewCopilotItem(selectedItem.copilotItem, githubService, previewProvider);
        }
    };

    treeView.onDidChangeSelection(handleSelection);
    treeViewSecondary.onDidChangeSelection(handleSelection);

    const previewProviderDisposable = vscode.workspace.registerTextDocumentContentProvider('copilot-preview', previewProvider);

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json

    // Register refresh command
    const refreshDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.refreshVscodeGitCopilotTools', () => {
        treeProvider.refresh();
        statusBarManager.showSuccess('Refreshed Git Copilot Tools data');
    });

    // Register download command
    const downloadDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.downloadItem', async (treeItem?: VscodeGitCopilotToolsTreeItem) => {
        if (!treeItem || !treeItem.copilotItem) {
            vscode.window.showErrorMessage('No file selected for download');
            return;
        }
        await downloadCopilotItem(treeItem.copilotItem, githubService, downloadTracker);
    });

    // Register preview command
    const previewDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.previewItem', async (treeItem?: VscodeGitCopilotToolsTreeItem) => {
        if (!treeItem || !treeItem.copilotItem) {
            vscode.window.showErrorMessage('No file selected for preview');
            return;
        }
        await previewCopilotItem(treeItem.copilotItem, githubService, previewProvider);
    });

    // Register repository-specific commands
    const removeRepoDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.removeRepo', async (treeItem?: VscodeGitCopilotToolsTreeItem) => {
        // Validate that we have a tree item with the required properties
        if (!treeItem) {
            vscode.window.showErrorMessage('No repository selected for removal');
            return;
        }

        if (treeItem.itemType !== 'repo' || !treeItem.repo) {
            vscode.window.showErrorMessage('Invalid repository selection for removal');
            return;
        }

        const repo = treeItem.repo;
        const confirm = await vscode.window.showWarningMessage(
            `Remove repository ${repo.owner}/${repo.repo}?`,
            { modal: true },
            'Remove'
        );

        if (confirm === 'Remove') {
            let sources = RepoStorage.getSources(context);
            if (sources.length <= 1) {
                vscode.window.showWarningMessage('At least one repository source is required.');
                return;
            }

            // Clear cache for the repository being removed
            githubService.clearRepoCache(repo);

            sources = sources.filter(s => !(s.owner === repo.owner && s.repo === repo.repo));
            await RepoStorage.setSources(context, sources);
            treeProvider.refresh();
            statusBarManager.showSuccess(`Removed repository: ${repo.owner}/${repo.repo}`);
        }
    });

    const refreshRepoDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.refreshRepo', async (treeItem?: VscodeGitCopilotToolsTreeItem) => {
        // Validate that we have a tree item with the required properties
        if (!treeItem) {
            vscode.window.showErrorMessage('No repository selected for refresh');
            return;
        }

        if (treeItem.itemType !== 'repo' || !treeItem.repo) {
            vscode.window.showErrorMessage('Invalid repository selection for refresh');
            return;
        }

        const repo = treeItem.repo;
        // Clear cache for this specific repository only
        githubService.clearRepoCache(repo);
        // Refresh only this specific repository in the tree view
        treeProvider.refreshRepo(repo);
        statusBarManager.showSuccess(`Refreshed repository: ${repo.owner}/${repo.repo}`);
    });

    // Register token configuration command
    const configTokenDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.configureEnterpriseToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Enterprise GitHub Personal Access Token',
            password: true,
            placeHolder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Token cannot be empty';
                }
                if (!value.startsWith('ghp_') && !value.startsWith('gho_') && !value.startsWith('ghu_')) {
                    return 'Invalid token format. GitHub tokens typically start with ghp_, gho_, or ghu_';
                }
                return null;
            }
        });

        if (token) {
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            await config.update('enterpriseToken', token, vscode.ConfigurationTarget.Global);
            statusBarManager.showSuccess('Enterprise GitHub token configured successfully!');
        }
    });

    // Register clear token command
    const clearTokenDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.clearEnterpriseToken', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Clear Enterprise GitHub token?',
            { modal: true },
            'Clear'
        );

        if (confirm === 'Clear') {
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            await config.update('enterpriseToken', undefined, vscode.ConfigurationTarget.Global);
            statusBarManager.showSuccess('Enterprise GitHub token cleared');
        }
    });


    // Register tree view visibility commands
    const toggleTreeViewDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.toggleTreeView', async () => {
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const currentValue = config.get<boolean>('showTreeView', true);
        await config.update('showTreeView', !currentValue, vscode.ConfigurationTarget.Global);
        const newState = !currentValue ? 'shown' : 'hidden';
        statusBarManager.showInfo(`Git Copilot Tools tree view ${newState}`);
    });

    const showTreeViewDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.showTreeView', async () => {
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        await config.update('showTreeView', true, vscode.ConfigurationTarget.Global);
        statusBarManager.showInfo('Git Copilot Tools tree view shown');
    });

    const hideTreeViewDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.hideTreeView', async () => {
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        await config.update('showTreeView', false, vscode.ConfigurationTarget.Global);
        statusBarManager.showInfo('Git Copilot Tools tree view hidden');
    });

    // Register GitHub authentication commands
    const signInToGitHubDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.signInToGitHub', async () => {
        try {
            const session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: true
            });

            if (session) {
                statusBarManager.showSuccess(`Signed in to GitHub as ${session.account.label}. Rate limit increased to 5,000 requests/hour!`);
                // Clear cache to refresh with authenticated requests
                githubService.clearCache();
                treeProvider.refresh();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to sign in to GitHub: ${error}`);
        }
    });

    const signOutFromGitHubDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.signOutFromGitHub', async () => {
        try {
            // Try to get current session
            const session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: false,
                silent: true
            });

            if (session) {
                const confirm = await vscode.window.showWarningMessage(
                    `Sign out from GitHub? This will reduce your API rate limit from 5,000 to 60 requests per hour.`,
                    { modal: true },
                    'Sign Out'
                );

                if (confirm === 'Sign Out') {
                    // Note: VS Code doesn't provide a direct way to sign out from a specific provider
                    // The user needs to sign out through VS Code's account management
                    await vscode.commands.executeCommand('workbench.action.showAccountsManagement');
                    statusBarManager.showInfo('Please sign out from GitHub using the account management panel');
                }
            } else {
                statusBarManager.showInfo('Not currently signed in to GitHub');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error checking GitHub authentication: ${error}`);
        }
    });

    // Register command to open repository in browser
    const openRepoInBrowserDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.openRepoInBrowser', async (treeItem?: VscodeGitCopilotToolsTreeItem) => {
        // If called with a specific tree item (from inline context menu), use that repo
        if (treeItem && treeItem.itemType === 'repo' && treeItem.repo) {
            const repo = treeItem.repo;
            const repoUrl = repo.baseUrl ? `${repo.baseUrl}/${repo.owner}/${repo.repo}` : `https://github.com/${repo.owner}/${repo.repo}`;
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
            return;
        }

        // Otherwise, fallback to the original behavior for toolbar clicks
        const sources = RepoStorage.getSources(context);
        if (sources.length === 0) {
            vscode.window.showInformationMessage('No repository sources configured. Use "Manage Sources" to add one.');
            return;
        }

        // If only one source, open it directly
        if (sources.length === 1) {
            const repo = sources[0];
            const repoUrl = repo.baseUrl ? `${repo.baseUrl}/${repo.owner}/${repo.repo}` : `https://github.com/${repo.owner}/${repo.repo}`;
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
            return;
        }

        // If multiple sources, let user pick which one to open
        const selected = await vscode.window.showQuickPick(
            sources.map(s => ({
                label: s.label || `${s.owner}/${s.repo}`,
                description: `${s.owner}/${s.repo}`,
                repo: s
            })),
            { placeHolder: 'Select a repository to open in browser' }
        );

        if (selected) {
            const repoUrl = selected.repo.baseUrl
                ? `${selected.repo.baseUrl}/${selected.repo.owner}/${selected.repo.repo}`
                : `https://github.com/${selected.repo.owner}/${selected.repo.repo}`;
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
        }
    });

    context.subscriptions.push(
        refreshDisposable,
        downloadDisposable,
        previewDisposable,
        manageSourcesDisposable,
        removeRepoDisposable,
        refreshRepoDisposable,
        configTokenDisposable,
        clearTokenDisposable,
        toggleTreeViewDisposable,
        showTreeViewDisposable,
        hideTreeViewDisposable,
        signInToGitHubDisposable,
        signOutFromGitHubDisposable,
        openRepoInBrowserDisposable,
        configChangeDisposable,
        requestSettingsDisposable,
        signInDisposable,
        searchView,
        searchViewSecondary,
        treeView,
        treeViewSecondary,
        previewProviderDisposable,
        githubService,
        statusBarManager
    );
}

/**
 * Check a new source against GitHub and save it. One listing of the repository
 * root shows which category folders exist; a repository with none of them
 * offers the folder mapping panel instead.
 */
async function addRepository(
    context: vscode.ExtensionContext,
    source: RepositorySource,
    sources: RepositorySource[],
    githubService: GitHubService,
    statusBarManager: StatusBarManager,
    treeProvider: VscodeGitCopilotToolsProvider
): Promise<void> {
    const logger = getLogger();
    const { owner, repo, baseUrl, branch } = source;

    // Check for duplicate
    if (sources.some(s => s.owner === owner && s.repo === repo)) {
        vscode.window.showWarningMessage('Repository already added.');
        return;
    }

    const displayUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`;
    const branchSuffix = branch ? ` (branch: ${branch})` : '';

    // For enterprise GitHub, show info message
    if (baseUrl) {
        vscode.window.showInformationMessage(
            `🔐 Enterprise GitHub Detected: ${displayUrl}\n\nPlease ensure you have configured your Personal Access Token using "Configure Enterprise Token" command.`
        );
        statusBarManager.showLoading(`Validating repository structure for ${owner}/${repo}...`);
    }

    try {
        const rootEntries = await githubService.getDirectoryContents(source, '');
        const foundFolders = ORDERED_CATEGORIES.filter(category =>
            rootEntries.some(entry => entry.type === 'dir' && entry.name === category));

        if (foundFolders.length === 0) {
            // No default folders found - offer folder mapping configuration UI
            const configChoice = await vscode.window.showInformationMessage(
                `No standard content folders found in ${owner}/${repo}. Would you like to configure custom folder mappings?`,
                'Configure Folders',
                'Cancel'
            );
            if (configChoice !== 'Configure Folders') {
                return;
            }

            const folderMappings = await showFolderMappingPanel(context.extensionUri, displayUrl);
            if (!folderMappings) {
                // User cancelled the folder mapping panel
                return;
            }

            // Check that at least one mapping is set
            const hasMapping = Object.values(folderMappings).some(v => v !== null && v !== undefined && v !== '');
            if (!hasMapping) {
                vscode.window.showWarningMessage('No folder mappings configured. Repository not added.');
                return;
            }

            sources.push({ ...source, folderMappings });
            await RepoStorage.setSources(context, sources);
            logger.info('New repository source added with custom folder mappings:', {
                owner, repo,
                baseUrl: baseUrl || 'github.com',
                folderMappings
            });
            statusBarManager.showSuccess(`Successfully added: ${displayUrl} (with custom folder mappings)`);
            treeProvider.refresh();
            return;
        }

        sources.push(source);
        await RepoStorage.setSources(context, sources);

        // Log the successful addition
        logger.info('New repository source added:', {
            owner,
            repo,
            baseUrl: baseUrl || 'github.com',
            branch: branch || '(default)',
            foundFolders,
            displayUrl
        });
        statusBarManager.showSuccess(`✅ Successfully added: ${displayUrl}${branchSuffix}`);
    } catch (err) {
        await reportAddRepositoryError(err, source, displayUrl);
    }
}

async function reportAddRepositoryError(err: unknown, source: RepositorySource, displayUrl: string): Promise<void> {
    const { owner, repo, baseUrl, branch } = source;
    const statusCode = err instanceof GitHubApiError ? err.status : undefined;

    getLogger().error('Repository validation error:', {
        error: errorText(err),
        statusCode,
        owner,
        repo,
        baseUrl,
        branch
    });

    if (statusCode === 404) {
        // 404 Not Found - the repository (or branch) does not exist, or is not visible
        const repoUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `https://github.com/${owner}/${repo}`;
        const retryChoice = await vscode.window.showErrorMessage(
            `🔍 Repository Not Found\n\n${owner}/${repo} was not found, or you do not have access to it.\n\nPlease verify:\n1. The repository exists at: ${repoUrl}\n2. The repository is public, or you have access to it${branch ? `\n3. The branch "${branch}" exists` : ''}`,
            'Check Repository',
            'Retry',
            'Cancel'
        );
        if (retryChoice === 'Check Repository') {
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
        }
    } else if (statusCode === 401 && baseUrl) {
        // Authentication error for enterprise GitHub
        const retryChoice = await vscode.window.showErrorMessage(
            `🔐 Authentication Required (401)\n\nFailed to access ${displayUrl}.\n\nPlease configure your Personal Access Token using "Configure Enterprise Token" command.`,
            'Configure Token',
            'Retry',
            'Cancel'
        );
        if (retryChoice === 'Configure Token') {
            await vscode.commands.executeCommand('vscode-git-copilot-tools.configureEnterpriseToken');
        }
    } else if (statusCode === 403) {
        // Forbidden - Rate limit or access denied
        const retryChoice = await vscode.window.showErrorMessage(
            `🚫 Access Forbidden (403)\n\nAccess to ${owner}/${repo} is forbidden. This could be due to:\n1. Repository is private and you don't have access\n2. API rate limit exceeded\n3. Token doesn't have required permissions`,
            'Configure Token',
            'Retry',
            'Cancel'
        );
        if (retryChoice === 'Configure Token') {
            await vscode.commands.executeCommand('vscode-git-copilot-tools.configureEnterpriseToken');
        }
    } else {
        // Other errors
        vscode.window.showErrorMessage(`❌ Failed to add repository: ${errorText(err)}${statusCode ? ` (${statusCode})` : ''}`);
    }
}

async function downloadCopilotItem(item: CopilotItem, githubService: GitHubService, downloadTracker: DownloadTracker): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        const workspacePath = workspaceFolder.uri.fsPath;

        // Plugins: each item listed in plugin.json goes to its own category folder
        if (item.category === 'plugins' && item.file.type === 'dir') {
            await downloadPluginItems(item, workspacePath, githubService, downloadTracker);
            return;
        }

        const categoryDir = categoryDirFor(workspacePath, item);
        const targetFolder = toDisplayPath(workspacePath, categoryDir);
        if (item.file.type === 'dir') {
            await downloadFolder(item, workspacePath, categoryDir, targetFolder, githubService, downloadTracker);
        } else {
            await downloadSingleFile(item, workspacePath, categoryDir, targetFolder, githubService, downloadTracker);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to download ${item.name}: ${errorText(error)}`);
    }
}

/** Download a plugin item by item, then add the slash command note to its folder. */
async function downloadPluginItems(
    item: CopilotItem,
    workspacePath: string,
    githubService: GitHubService,
    downloadTracker: DownloadTracker
): Promise<void> {
    let parsed: PluginParseResult;
    try {
        parsed = await githubService.parsePluginJson(item.repo, item.file.path);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to read plugin metadata: ${errorText(error)}`);
        return;
    }

    const metadata = parsed.metadata;
    const itemCount = metadata.items?.length ?? 0;
    if (itemCount === 0) {
        // A plugin can hold only content this extension does not install, such as Copilot extensions
        const skipped = getSkippedPluginEntries(metadata);
        vscode.window.showWarningMessage(skipped.length > 0
            ? `Plugin "${metadata.name}" has no agents, skills, hooks, instructions, or prompts to download. Skipped: ${skipped.join('; ')}`
            : `Plugin "${metadata.name}" has no items to download.`);
        return;
    }

    // Show confirmation dialog with plugin details
    const confirm = await vscode.window.showInformationMessage(
        `Download plugin "${metadata.name}"?\n\n${metadata.description}\n\n${itemCount} item(s) will be saved to their category folders.`,
        { modal: true },
        'Download'
    );
    if (confirm !== 'Download') {
        return;
    }

    const result = await githubService.downloadPlugin(item, workspacePath);
    for (const failure of result.failed) {
        getLogger().error(`Failed to download plugin item ${failure}`);
    }
    for (const notice of result.notices) {
        getLogger().warn(`Plugin entry not downloaded: ${notice}`);
    }

    // NOTE file with the plugin's slash commands, read from its README
    try {
        const noteContent = generateNoteContent(result.readmeContent, result.metadata.id || item.name);
        fs.writeFileSync(path.join(result.pluginDir, NOTE_FILE_NAME), noteContent, 'utf8');
    } catch (noteError) {
        getLogger().warn('Failed to write the plugin note:', noteError);
    }

    // Record download and clear cache
    await downloadTracker.recordDownload(item);
    githubService.clearCategoryCache(item.repo, item.category);

    // Show summary
    let summaryMessage = `Plugin "${metadata.name}" downloaded!\n\n`;
    summaryMessage += `Downloaded ${result.downloaded.length}/${itemCount} item(s) successfully.`;
    if (result.failed.length > 0) {
        summaryMessage += `\n${result.failed.length} item(s) failed.`;
    }
    if (result.notices.length > 0) {
        summaryMessage += `\nNot downloaded: ${result.notices.join('; ')}`;
    }
    vscode.window.showInformationMessage(summaryMessage);
}

/** Download a hook, skill, or other folder under a name the user confirms. */
async function downloadFolder(
    item: CopilotItem,
    workspacePath: string,
    categoryDir: string,
    targetFolder: string,
    githubService: GitHubService,
    downloadTracker: DownloadTracker
): Promise<void> {
    const label = FOLDER_LABELS[item.category] ?? 'folder';
    const folderName = await vscode.window.showInputBox({
        prompt: `Download ${label} ${item.name} to ${targetFolder}`,
        value: item.name,
        validateInput: value => validateDownloadName(value, 'Folder name cannot be empty')
    });
    if (!folderName) {
        return; // User cancelled
    }

    const name = folderName.trim();
    const targetPath = path.join(categoryDir, name);

    // Check if folder exists
    if (fs.existsSync(targetPath)) {
        const overwrite = await vscode.window.showWarningMessage(
            `${capitalize(label)} ${name} already exists. Do you want to overwrite it?`,
            'Overwrite', 'Cancel'
        );
        if (overwrite !== 'Overwrite') {
            return;
        }
        // Remove existing folder so files deleted upstream do not linger
        fs.rmSync(targetPath, { recursive: true, force: true });
    }

    const meta = await githubService.downloadItem(item, workspacePath, name);
    await downloadTracker.recordDownload(item, meta);

    // Clear cache for this category to force fresh metadata on next refresh
    githubService.clearCategoryCache(item.repo, item.category);

    if (item.category === 'skills') {
        const openFolder = await vscode.window.showInformationMessage(
            `Successfully downloaded skill folder ${name}`,
            'Open Folder'
        );
        if (openFolder === 'Open Folder') {
            // Open the SKILL.md file if it exists
            const skillMdPath = path.join(meta.localPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
                const document = await vscode.workspace.openTextDocument(skillMdPath);
                await vscode.window.showTextDocument(document);
            } else {
                // If no SKILL.md, just reveal the folder
                await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(meta.localPath));
            }
        }
        return;
    }

    const openFolder = await vscode.window.showInformationMessage(
        `Successfully downloaded ${label} ${name} (${countFiles(meta.localPath)} file(s))`,
        'Open Folder'
    );
    if (openFolder === 'Open Folder') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(meta.localPath));
    }
}

/** Download one file under a name the user confirms. */
async function downloadSingleFile(
    item: CopilotItem,
    workspacePath: string,
    categoryDir: string,
    targetFolder: string,
    githubService: GitHubService,
    downloadTracker: DownloadTracker
): Promise<void> {
    // Show input box for filename confirmation
    const filename = await vscode.window.showInputBox({
        prompt: `Download ${item.name} to ${targetFolder}`,
        value: item.name,
        validateInput: value => validateDownloadName(value, 'Filename cannot be empty')
    });
    if (!filename) {
        return; // User cancelled
    }

    const name = filename.trim();

    // Check if file exists
    if (fs.existsSync(path.join(categoryDir, name))) {
        const overwrite = await vscode.window.showWarningMessage(
            `File ${name} already exists. Do you want to overwrite it?`,
            'Overwrite', 'Cancel'
        );
        if (overwrite !== 'Overwrite') {
            return;
        }
    }

    const meta = await githubService.downloadItem(item, workspacePath, name);
    await downloadTracker.recordDownload(item, meta);

    // Clear cache for this category to force fresh metadata on next refresh
    githubService.clearCategoryCache(item.repo, item.category);

    // Show success message and offer to open file
    const openFile = await vscode.window.showInformationMessage(
        `Successfully downloaded ${name}`,
        'Open File'
    );
    if (openFile === 'Open File') {
        const document = await vscode.workspace.openTextDocument(meta.localPath);
        await vscode.window.showTextDocument(document);
    }
}

async function previewCopilotItem(item: CopilotItem, githubService: GitHubService, previewProvider: CopilotPreviewProvider): Promise<void> {
    try {
        if (item.category === 'plugins' && item.file.type === 'dir') {
            // For Plugin directories, show plugin.json metadata + README.md
            item.content = await buildPluginPreview(item, githubService);
            await showPreview(previewProvider, item, `${item.name}/README.md`);
        } else if (item.file.type === 'dir') {
            // For Skills folders, preview the SKILL.md file
            const contents = await githubService.getDirectoryContents(item.repo, item.file.path);
            const skillMdFile = item.category === 'skills'
                ? contents.find(f => f.name === 'SKILL.md' && f.type === 'file')
                : undefined;

            if (skillMdFile?.download_url) {
                item.content = await githubService.getFileContent(item.repo, skillMdFile.download_url);
                await showPreview(previewProvider, item, `${item.name}/SKILL.md`);
            } else {
                // No SKILL.md (or not a skill): show the list of files in the folder
                item.content = await buildFolderListing(item, githubService);
                await showPreview(previewProvider, item, item.name);
            }
        } else {
            // Regular file preview (for other categories)
            // Fetch content if not already cached
            if (!item.content && item.file.download_url) {
                item.content = await githubService.getFileContent(item.repo, item.file.download_url);
            }
            await showPreview(previewProvider, item, item.name);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to preview ${item.name}: ${errorText(error)}`);
    }
}

async function showPreview(previewProvider: CopilotPreviewProvider, item: CopilotItem, documentName: string): Promise<void> {
    const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(documentName)}`);

    // Set the item content in the preview provider
    previewProvider.setItem(previewUri, item);

    const doc = await vscode.workspace.openTextDocument(previewUri);
    await vscode.window.showTextDocument(doc, { preview: true });
}

async function buildPluginPreview(item: CopilotItem, githubService: GitHubService): Promise<string> {
    let previewContent = '';

    // Fetch plugin.json for metadata
    try {
        const { metadata: meta } = await githubService.parsePluginJson(item.repo, item.file.path);
        previewContent += `# ${meta.name}\n\n`;
        previewContent += `${meta.description}\n\n`;
        if (meta.version) { previewContent += `**Version:** ${meta.version}\n`; }
        if (meta.author?.name) { previewContent += `**Author:** ${meta.author.name}\n`; }
        if (meta.license) { previewContent += `**License:** ${meta.license}\n`; }
        if (meta.tags?.length) { previewContent += `**Tags:** ${meta.tags.join(', ')}\n`; }
        const metaItems = meta.items ?? [];
        previewContent += `\n**Items (${metaItems.length}):**\n`;
        for (const pluginItem of metaItems) {
            const filename = pluginItem.path.split('/').pop() || pluginItem.path;
            previewContent += `- ${filename} (${pluginItem.kind})\n`;
        }
        previewContent += '\n---\n\n';
    } catch {
        // plugin.json not available, continue without metadata
    }

    // Fetch README.md for additional preview content
    const contents = await githubService.getDirectoryContents(item.repo, item.file.path);
    const readmeMdFile = contents.find(f => f.name === 'README.md' && f.type === 'file');

    if (readmeMdFile?.download_url) {
        previewContent += await githubService.getFileContent(item.repo, readmeMdFile.download_url);
    } else if (!previewContent) {
        previewContent = `# ${item.name}\n\n*(No plugin metadata or README found)*`;
    }
    return previewContent;
}

async function buildFolderListing(item: CopilotItem, githubService: GitHubService): Promise<string> {
    const entries = await githubService.listDirectoryTree(item.repo, item.file.path);
    const folderPrefix = item.file.path.endsWith('/') ? item.file.path : `${item.file.path}/`;
    const fileList = entries
        .filter(f => f.type === 'file')
        .map(f => `- ${f.path.startsWith(folderPrefix) ? f.path.substring(folderPrefix.length) : f.path}`)
        .join('\n');

    const label = FOLDER_LABELS[item.category] ?? 'folder';
    const noun = label.replace(/ folder$/, '');
    return `# ${item.name}\n\n**${capitalize(label).replace(/ folder$/, ' Folder')} Contents:**\n\n${fileList}\n\nDownload this ${noun} to get all files.`;
}

// This method is called when your extension is deactivated
export function deactivate() { }
