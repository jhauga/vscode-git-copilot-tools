import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildCacheKey,
    buildCachePrefix,
    getItemDisplayName,
    resolveAiFolder,
    resolveCategoryDir,
    resolveCategoryPaths,
} from 'cmd-git-copilot-tools';
import { GitHubService } from './githubService';
import {
    CATEGORY_DISPLAY,
    CATEGORY_ICONS,
    CopilotItem,
    GitHubApiError,
    ORDERED_CATEGORIES,
    RepositorySource,
    ToolCategory,
} from './types';
import { RepoStorage } from './repoStorage';
import { getLogger } from './logger';
import { DownloadTracker } from './downloadTracker';
import { SearchBar } from './searchBar';

// Text document provider for remote content in diff view
class RemoteContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return Buffer.from(uri.query, 'base64').toString('utf8');
    }
}

/** Description and tooltip text for the tool types that are folders. */
const FOLDER_ITEM_TEXT: Partial<Record<ToolCategory, { type: string; action: string }>> = {
    hooks: { type: 'Hook Folder', action: 'Click to preview or download entire hook folder' },
    plugins: { type: 'Plugin', action: 'Click to preview or download plugin' },
    skills: { type: 'Skill Folder', action: 'Click to preview or download entire skill folder' },
};

const DEFAULT_FOLDER_TEXT = { type: 'Folder', action: 'Click to preview or download folder' };

function isNotFound(error: unknown): boolean {
    return error instanceof GitHubApiError && error.status === 404;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class VscodeGitCopilotToolsTreeItem extends vscode.TreeItem {
    public readonly copilotItem?: CopilotItem;
    public readonly category?: ToolCategory;
    public readonly repo?: RepositorySource;
    public readonly itemType: 'repo' | 'category' | 'file' | 'search';

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        itemType: 'repo' | 'category' | 'file' | 'search',
        copilotItem?: CopilotItem,
        category?: ToolCategory,
        repo?: RepositorySource,
        downloadTracker?: DownloadTracker
    ) {
        super(label, collapsibleState);
        this.itemType = itemType;
        this.copilotItem = copilotItem;
        this.category = category;
        this.repo = repo;

        if (itemType === 'search') {
            this.contextValue = 'copilotSearch';
            this.iconPath = new vscode.ThemeIcon('search');
            this.command = {
                command: 'vscode-git-copilot-tools.searchFiles',
                title: 'Search Files'
            };
            this.description = '';
            this.tooltip = 'Click to search/filter files';
        } else if (itemType === 'file' && copilotItem) {
            this.contextValue = 'copilotFile';

            // Check if this item has an update available
            const hasUpdate = downloadTracker?.hasUpdate(copilotItem) || false;
            const isDownloaded = downloadTracker?.isDownloaded(copilotItem.id) || false;

            // Left-slot icon: always the category icon. Tinted terminal-green
            // when the item is downloaded locally so users can tell installed
            // tools apart at a glance. Update status is surfaced in the
            // description text rather than by replacing the icon.
            const iconId = CATEGORY_ICONS[copilotItem.category];
            this.iconPath = isDownloaded
                ? new vscode.ThemeIcon(iconId, new vscode.ThemeColor('terminal.ansiGreen'))
                : new vscode.ThemeIcon(iconId);

            const repoText = `${copilotItem.repo.owner}/${copilotItem.repo.repo}`;
            if (copilotItem.file.type === 'dir') {
                // Skills, plugins, and hooks are folders, not individual files
                const text = FOLDER_ITEM_TEXT[copilotItem.category] ?? DEFAULT_FOLDER_TEXT;
                const updateNote = hasUpdate
                    ? '\n\n⚠️ **Update Available** - A newer version is available on the remote repository.'
                    : '';
                this.description = hasUpdate ? '🔄 Update Available' : text.type;
                this.tooltip = new vscode.MarkdownString(
                    `**${copilotItem.name}**\n\nType: ${text.type}\nRepo: ${repoText}${updateNote}\n\n${text.action}`
                );
            } else {
                if (copilotItem.file.download_url) {
                    this.resourceUri = vscode.Uri.parse(copilotItem.file.download_url);
                }
                const size = `${(copilotItem.file.size / 1024).toFixed(1)}KB`;
                this.description = hasUpdate ? '🔄 Update Available' : size;
                this.tooltip = new vscode.MarkdownString(
                    `**${copilotItem.name}**\n\nSize: ${size}\nRepo: ${repoText}\n\nClick to preview content`
                );
            }
        } else if (itemType === 'category') {
            this.contextValue = 'copilotCategory';
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (itemType === 'repo' && repo) {
            this.contextValue = 'copilotRepo';
            this.iconPath = new vscode.ThemeIcon('repo');
            this.description = `${repo.owner}/${repo.repo}${repo.branch ? `@${repo.branch}` : ''}`;
            this.tooltip = new vscode.MarkdownString(
                `**Repository**: ${repo.owner}/${repo.repo}\n\n${repo.label || 'GitHub Repository'}${repo.branch ? `\n\n**Branch**: ${repo.branch}` : ''}\n\nRight-click for options`
            );
        }
    }
}

export class VscodeGitCopilotToolsProvider implements vscode.TreeDataProvider<VscodeGitCopilotToolsTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<VscodeGitCopilotToolsTreeItem | undefined | null | void> = new vscode.EventEmitter<VscodeGitCopilotToolsTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<VscodeGitCopilotToolsTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private repoItems: Map<string, Map<ToolCategory, CopilotItem[]>> = new Map();
    private loading: Set<string> = new Set();
    // Per (repo|category) cache of paths that passed root-mapped category validation.
    private rootFilterCache: Map<string, Set<string>> = new Map();
    private context: vscode.ExtensionContext | undefined;
    private searchBar: SearchBar;
    private downloadTracker: DownloadTracker | undefined;

    constructor(private githubService: GitHubService, context?: vscode.ExtensionContext, downloadTracker?: DownloadTracker) {
        this.context = context;
        this.downloadTracker = downloadTracker;
        this.searchBar = new SearchBar();

        // Listen to search changes and refresh the tree
        this.searchBar.onSearchChange(() => {
            getLogger().debug('[TreeProvider] Search term changed, refreshing tree view');
            this._onDidChangeTreeData.fire();
        });
    }

    /**
     * Get the SearchBar instance for external access
     */
    public getSearchBar(): SearchBar {
        return this.searchBar;
    }

    refresh(): void {
        // Clear all cached data
        this.repoItems.clear();
        this.loading.clear();
        this.rootFilterCache.clear();

        // Fire tree data change event to refresh the UI
        this._onDidChangeTreeData.fire();

        // Reload data for current repositories (wrapped to prevent state corruption)
        this.loadAllReposAndCategories(true).catch(error => {
            getLogger().error('Error during full tree refresh:', error);
            // Even if loading fails, we've cleared state so subsequent attempts should work
        });
    }

    // Refresh only a specific repository in the tree
    refreshRepo(repo: RepositorySource): void {
        // Find and remove cached data for this specific repo
        const repoKey = `${repo.owner}/${repo.repo}`;
        this.repoItems.delete(repoKey);

        // Drop cached root-mapped validation entries for this repo.
        const repoCachePrefix = buildCachePrefix(repo);
        for (const key of Array.from(this.rootFilterCache.keys())) {
            if (key.startsWith(repoCachePrefix)) {
                this.rootFilterCache.delete(key);
            }
        }

        // Clear loading states for this repo to allow fresh requests
        const loadingKeysToDelete = Array.from(this.loading).filter(key => key.startsWith(`${repoKey}-`));
        loadingKeysToDelete.forEach(key => this.loading.delete(key));

        // Find the tree item for this repository
        const targetRepo = this.getSources().find(r =>
            r.owner === repo.owner && r.repo === repo.repo && (r.baseUrl || 'github.com') === (repo.baseUrl || 'github.com'));

        if (targetRepo) {
            // Create the tree item for this repo
            const repoTreeItem = new VscodeGitCopilotToolsTreeItem(
                targetRepo.label || `${targetRepo.owner}/${targetRepo.repo}`,
                vscode.TreeItemCollapsibleState.Expanded,
                'repo',
                undefined,
                undefined,
                targetRepo
            );

            // Fire change event for just this repository tree item
            this._onDidChangeTreeData.fire(repoTreeItem);

            // Preload the data for this repository (wrapped in try-catch to prevent state corruption)
            this.loadSingleRepo(targetRepo, true).catch(error => {
                getLogger().error(`Error during repository refresh for ${repo.owner}/${repo.repo}:`, error);
                // Even if loading fails, we've already cleared the state, so subsequent attempts should work
            });
        }
    }

    private getSources(): RepositorySource[] {
        return this.context ? RepoStorage.getSources(this.context) : RepoStorage.getDefaultSources();
    }

    private getRepoData(repoKey: string): Map<ToolCategory, CopilotItem[]> {
        let repoData = this.repoItems.get(repoKey);
        if (!repoData) {
            repoData = new Map();
            this.repoItems.set(repoKey, repoData);
        }
        return repoData;
    }

    private createFileItem(item: CopilotItem, repo: RepositorySource): VscodeGitCopilotToolsTreeItem {
        return new VscodeGitCopilotToolsTreeItem(
            getItemDisplayName(item),
            vscode.TreeItemCollapsibleState.None,
            'file',
            item,
            item.category,
            repo,
            this.downloadTracker
        );
    }

    // Load data for a single repository
    private async loadSingleRepo(repo: RepositorySource, forceRefresh: boolean = false): Promise<void> {
        const repoKey = `${repo.owner}/${repo.repo}`;
        const repoData = this.getRepoData(repoKey);
        const allItems: CopilotItem[] = [];

        for (const category of ORDERED_CATEGORIES) {
            const loadingKey = `${repoKey}-${category}`;
            if (this.loading.has(loadingKey)) {
                continue;
            }
            this.loading.add(loadingKey);

            try {
                const items = await this.githubService.getItems(repo, category, forceRefresh);
                repoData.set(category, items);
                allItems.push(...items);
            } catch (error) {
                if (isNotFound(error)) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    repoData.set(category, []);
                    getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                } else {
                    // Show error for other types of errors (auth, network, etc.)
                    getLogger().error(`Failed to load ${category} from ${repoKey}: ${errorText(error)}`);
                }
            } finally {
                this.loading.delete(loadingKey);
            }
        }

        // Fire change event to update UI for this repo after all categories are loaded
        this._onDidChangeTreeData.fire();

        // Check for updates if setting is enabled
        await this.checkForUpdates(allItems);
    }

    getTreeItem(element: VscodeGitCopilotToolsTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: VscodeGitCopilotToolsTreeItem): Promise<VscodeGitCopilotToolsTreeItem[]> {
        if (!element) {
            // Return root repositories
            return this.getSources().map(repo =>
                new VscodeGitCopilotToolsTreeItem(
                    repo.label || `${repo.owner}/${repo.repo}`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'repo',
                    undefined,
                    undefined,
                    repo
                )
            );
        }

        if (element.itemType === 'repo' && element.repo) {
            const repo = element.repo;

            // If any categories are mapped to repo root, expand the repo node directly
            // to those categories' files (skip the intermediate categories layer).
            const rootCategories = ORDERED_CATEGORIES.filter(category => repo.folderMappings?.[category] === 'root');
            if (rootCategories.length > 0) {
                const fileItems: VscodeGitCopilotToolsTreeItem[] = [];
                for (const category of rootCategories) {
                    const items = await this.getItemsForRepoAndCategory(repo, category);
                    // Apply category-specific filtering to exclude unrelated repo-root
                    // entries (e.g. .git, .github, images, README.md, LICENSE).
                    const categoryFiltered = await this.filterRootCategoryItems(repo, category, items);
                    for (const item of this.searchBar.filterItems(categoryFiltered)) {
                        fileItems.push(this.createFileItem(item, repo));
                    }
                }
                return fileItems;
            }

            // Return categories for this repository. Excluded categories are not shown.
            return ORDERED_CATEGORIES
                .filter(category => resolveCategoryPaths(repo, category).length > 0)
                .map(category => new VscodeGitCopilotToolsTreeItem(
                    CATEGORY_DISPLAY[category].title,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'category',
                    undefined,
                    category,
                    repo
                ));
        }

        if (element.itemType === 'category' && element.category && element.repo) {
            const repo = element.repo;
            // Return files for the category in this repository
            const items = await this.getItemsForRepoAndCategory(repo, element.category);

            // Apply search filter if active
            return this.searchBar.filterItems(items).map(item => this.createFileItem(item, repo));
        }

        return [];
    }

    private async getItemsForRepoAndCategory(repo: RepositorySource, category: ToolCategory): Promise<CopilotItem[]> {
        const repoKey = `${repo.owner}/${repo.repo}`;
        const loadingKey = `${repoKey}-${category}`;
        const repoData = this.getRepoData(repoKey);

        if (!repoData.has(category) && !this.loading.has(loadingKey)) {
            this.loading.add(loadingKey);
            try {
                // Fetch items from specific repository
                const items = await this.githubService.getItems(repo, category);
                repoData.set(category, items);
                this._onDidChangeTreeData.fire();
            } catch (error) {
                if (isNotFound(error)) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    // Set empty array and don't show error to user
                    repoData.set(category, []);
                    getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                } else {
                    // Show error for other types of errors (auth, network, etc.)
                    vscode.window.showErrorMessage(`Failed to load ${category} from ${repoKey}: ${errorText(error)}`);
                }
                return [];
            } finally {
                this.loading.delete(loadingKey);
            }
        }

        return repoData.get(category) || [];
    }

    /**
     * Filter items returned for a category that is mapped to the repo root, so that
     * unrelated entries (e.g. .git, .github, images, README.md, LICENSE) are hidden.
     *
     * Rules per category:
     *  - Plugins      : directory containing "README.md" and a manifest, either
     *                   "plugin.json" or ".github/plugin"
     *  - Instructions : file whose name ends with ".instructions.md"
     *  - Prompts      : file whose name ends with ".prompt.md"
     *  - Agents       : file whose name ends with ".agent.md"
     *  - Skills       : directory containing "SKILL.md"
     *  - Workflows    : file ending in ".md" whose front-matter "name:" value
     *                   matches the filename (dashes replaced with spaces, case
     *                   insensitive substring match)
     */
    private async filterRootCategoryItems(
        repo: RepositorySource,
        category: ToolCategory,
        items: CopilotItem[]
    ): Promise<CopilotItem[]> {
        // Fast, name-only filters first.
        const nameFiltered = items.filter(item => {
            const name = item.name.toLowerCase();
            switch (category) {
                case 'instructions':
                    return item.file.type === 'file' && name.endsWith('.instructions.md');
                case 'prompts':
                    return item.file.type === 'file' && name.endsWith('.prompt.md');
                case 'agents':
                    return item.file.type === 'file' && name.endsWith('.agent.md');
                case 'workflows':
                    return item.file.type === 'file' && name.endsWith('.md');
                case 'skills':
                case 'plugins':
                    return item.file.type === 'dir' && !item.name.startsWith('.');
                default:
                    return true;
            }
        });

        // Categories without remote validation are done.
        if (category === 'instructions' || category === 'prompts' || category === 'agents') {
            return nameFiltered;
        }

        const cacheKey = buildCacheKey(repo, category);
        const cached = this.rootFilterCache.get(cacheKey);

        const validate = async (item: CopilotItem): Promise<boolean> => {
            try {
                switch (category) {
                    case 'plugins': {
                        const entries = await this.githubService.getDirectoryContents(repo, item.file.path);
                        const hasFile = (name: string) => entries.some(entry => entry.type === 'file' && entry.name === name);
                        if (!hasFile('README.md')) { return false; }
                        if (hasFile('plugin.json')) { return true; }
                        return entries.some(entry => entry.type === 'dir' && entry.name === '.github')
                            && await this.githubService.pathExists(repo, `${item.file.path}/.github/plugin`);
                    }
                    case 'skills':
                        return await this.githubService.pathExists(repo, `${item.file.path}/SKILL.md`);
                    case 'workflows': {
                        const fileData = await this.githubService.getFileContentByPath(repo, item.file.path);
                        const nameMatch = /^---[\r\n]+([\s\S]*?)[\r\n]+---/m.exec(fileData.content);
                        if (!nameMatch) { return false; }
                        const frontMatter = nameMatch[1];
                        const nameProp = /^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(frontMatter);
                        if (!nameProp) { return false; }
                        const declaredName = nameProp[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                        const baseName = item.name.replace(/\.md$/i, '').replace(/-/g, ' ').toLowerCase();
                        return declaredName.indexOf(baseName) > -1;
                    }
                    default:
                        return true;
                }
            } catch (error) {
                getLogger().debug(`Root-category validation failed for ${item.file.path}:`, error);
                return false;
            }
        };

        if (cached) {
            return nameFiltered.filter(item => cached.has(item.file.path));
        }

        const results = await Promise.all(nameFiltered.map(async item => ({
            item,
            ok: await validate(item)
        })));

        const accepted = new Set(results.filter(r => r.ok).map(r => r.item.file.path));
        this.rootFilterCache.set(cacheKey, accepted);

        return results.filter(r => r.ok).map(r => r.item);
    }

    private async loadAllReposAndCategories(forceRefresh: boolean = false): Promise<void> {
        if (!this.context) {
            return;
        }

        // Collect all items for update checking
        const allItems: CopilotItem[] = [];

        for (const repo of RepoStorage.getSources(this.context)) {
            const repoKey = `${repo.owner}/${repo.repo}`;
            const repoData = this.getRepoData(repoKey);

            for (const category of ORDERED_CATEGORIES) {
                try {
                    const items = await this.githubService.getItems(repo, category, forceRefresh);
                    repoData.set(category, items);
                    allItems.push(...items);
                } catch (error) {
                    if (isNotFound(error)) {
                        // 404 is expected when a repository doesn't have a particular category folder
                        // Set empty array and don't show error to user
                        repoData.set(category, []);
                        getLogger().debug(`Category '${category}' not found in ${repoKey} (this is normal)`);
                    } else {
                        // Show error for other types of errors (auth, network, etc.)
                        vscode.window.showErrorMessage(`Failed to load ${category} from ${repoKey}: ${errorText(error)}`);
                    }
                }
            }
        }

        this._onDidChangeTreeData.fire();

        // Check for updates if setting is enabled
        await this.checkForUpdates(allItems);
    }

    private async checkForUpdates(allItems: CopilotItem[]): Promise<void> {
        // Check if update checking is enabled
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const checkForUpdates = config.get<boolean>('checkForUpdates', true);

        if (!checkForUpdates || !this.downloadTracker) {
            return;
        }

        try {
            // Find items with updates
            const itemsWithUpdates = this.downloadTracker.findItemsWithUpdates(allItems);

            if (itemsWithUpdates.length > 0) {
                // Group by category for better readability
                const updatesByCategory: Record<string, CopilotItem[]> = {};
                for (const item of itemsWithUpdates) {
                    const categoryLabel = CATEGORY_DISPLAY[item.category].title;
                    if (!updatesByCategory[categoryLabel]) {
                        updatesByCategory[categoryLabel] = [];
                    }
                    updatesByCategory[categoryLabel].push(item);
                }

                // Build detailed message for logging
                let detailedMessage = `Updates available for ${itemsWithUpdates.length} downloaded item(s):\n\n`;
                for (const [category, items] of Object.entries(updatesByCategory)) {
                    detailedMessage += `${category}:\n`;
                    for (const item of items) {
                        detailedMessage += `  • ${getItemDisplayName(item)}\n`;
                    }
                    detailedMessage += '\n';
                }

                // Build summary for notification (single line with categories)
                const categoryList = Object.keys(updatesByCategory).join(', ');
                const shortMessage = `📦 Updates available for ${itemsWithUpdates.length} downloaded item(s) in: ${categoryList}`;

                // Show notification with action button
                const choice = await vscode.window.showInformationMessage(
                    shortMessage,
                    'Show Details',
                    'Dismiss'
                );

                if (choice === 'Show Details') {
                    // Show detailed list in a quick pick with actions
                    const quickPickItems: Array<vscode.QuickPickItem & { item?: CopilotItem }> = [];
                    for (const [category, categoryItems] of Object.entries(updatesByCategory)) {
                        quickPickItems.push({
                            label: category,
                            kind: vscode.QuickPickItemKind.Separator
                        });
                        for (const item of categoryItems) {
                            quickPickItems.push({
                                label: getItemDisplayName(item),
                                description: 'Update available',
                                detail: 'Click to download the latest version',
                                item: item
                            });
                        }
                    }

                    const selected = await vscode.window.showQuickPick(quickPickItems, {
                        title: '📦 Available Updates',
                        placeHolder: 'Select an item to download the latest version'
                    });

                    // If user selected an item, trigger download
                    if (selected && selected.item) {
                        await this.handleUpdateDownload(selected.item);
                    }
                }

                getLogger().info(detailedMessage);
            }
        } catch (error) {
            getLogger().error('Error checking for updates:', error);
        }
    }

    private async handleUpdateDownload(item: CopilotItem): Promise<void> {
        try {
            // Loop to allow returning to menu after viewing diff
            let continueLoop = true;
            while (continueLoop) {
                // Ask user what they want to do
                const action = await vscode.window.showQuickPick(
                    [
                        { label: 'Download Update', description: 'Download and replace the local version', value: 'download' },
                        { label: 'Show Diff', description: 'Compare local version with the update', value: 'diff' },
                        { label: 'Cancel', description: '', value: 'cancel' }
                    ],
                    {
                        title: `Update Available: ${item.name}`,
                        placeHolder: 'Choose an action'
                    }
                );

                if (!action || action.value === 'cancel') {
                    return;
                }

                if (action.value === 'download') {
                    // Create a tree item wrapper to trigger the download command
                    const treeItem = new VscodeGitCopilotToolsTreeItem(
                        item.name,
                        vscode.TreeItemCollapsibleState.None,
                        'file',
                        item,
                        item.category,
                        item.repo
                    );

                    // Execute the download command
                    await vscode.commands.executeCommand('vscode-git-copilot-tools.downloadItem', treeItem);
                    continueLoop = false; // Exit after download
                } else if (action.value === 'diff') {
                    await this.showDiff(item);
                    // After showing diff, loop back to menu (continueLoop stays true)
                }
            }
        } catch (error) {
            getLogger().error('Error handling update:', error);
            vscode.window.showErrorMessage(`Failed to handle update for ${item.name}: ${errorText(error)}`);
        }
    }

    private async showDiff(item: CopilotItem): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            if (item.file.type !== 'file' || !item.file.download_url) {
                vscode.window.showInformationMessage(`${item.name} is a folder. Diff compares single files; download the update to replace the folder.`);
                return;
            }

            // The recorded download path, or the default location for this item
            const recordedPath = this.downloadTracker?.getDownloadMetadata(item.id)?.localPath;
            const categoryDir = resolveCategoryDir(workspaceFolder.uri.fsPath, item.category, resolveAiFolder({ source: item.repo }));
            const localFilePath = vscode.Uri.file(recordedPath ?? path.join(categoryDir, item.name));

            // Check if local file exists
            if (!fs.existsSync(localFilePath.fsPath)) {
                vscode.window.showWarningMessage(`Local file not found: ${item.name}. It may have been moved or deleted.`);
                return;
            }

            // Fetch the remote content
            const remoteContent = await this.githubService.getFileContent(item.repo, item.file.download_url);

            // Create a virtual document for the remote content
            const remoteUri = vscode.Uri.parse(`copilot-remote:${item.name}`).with({
                query: Buffer.from(remoteContent).toString('base64')
            });

            // Register a text document provider for the remote content
            const providerDisposable = vscode.workspace.registerTextDocumentContentProvider(
                'copilot-remote',
                new RemoteContentProvider()
            );

            try {
                // Open diff view
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    localFilePath,
                    remoteUri,
                    `${item.name} (Local ↔ Remote Update)`,
                    { preview: true }
                );
            } finally {
                // Clean up the provider after giving time for the diff to load
                setTimeout(() => providerDisposable.dispose(), 5000);
            }
        } catch (error) {
            getLogger().error('Error showing diff:', error);
            vscode.window.showErrorMessage(`Failed to show diff for ${item.name}: ${errorText(error)}`);
        }
    }

    getItem(id: string): CopilotItem | undefined {
        for (const repoData of this.repoItems.values()) {
            for (const items of repoData.values()) {
                const found = items.find(item => item.id === id);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }
}
