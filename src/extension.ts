// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { VscodeGitCopilotToolsProvider, VscodeGitCopilotToolsTreeItem } from './treeProvider';
import { GitHubService } from './githubService';
import { CopilotPreviewProvider } from './previewProvider';
import { CopilotItem, FOLDER_PATHS, CopilotCategory, KIND_TO_CATEGORY, FolderMapping, RepoSource } from './types';
import * as path from 'path';
import * as fs from 'fs';
import { RepoStorage } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { DownloadTracker } from './downloadTracker';
import { SearchViewProvider } from './searchPanel';
import { showFolderMappingPanel } from './folderMappingPanel';
import axios from 'axios';
import * as https from 'https';
import { createLogger, createLoggerWithConfigMonitoring, Logger } from '@timheuer/vscode-ext-logger';
import { initializeLogger, getLogger } from './logger';
import { generateNoteContent } from './views/note.vscode-git-copilot-tools';

// Global logger instance
let logger: Logger;

// Create HTTPS agent with secure SSL handling - requires explicit user opt-in for insecure certificates
function createHttpsAgent(url: string, allowInsecureEnterpriseCerts: boolean = false): https.Agent | undefined {
    logger.debug('[createHttpsAgent] Called with:', { url, allowInsecureEnterpriseCerts });

    try {
        // If it's not github.com, treat as enterprise
        const isEnterprise = !url.includes('github.com');
        logger.debug('[createHttpsAgent] isEnterprise:', isEnterprise);

        if (isEnterprise && allowInsecureEnterpriseCerts) {
            logger.debug('[createHttpsAgent] Creating INSECURE agent for enterprise');
            // Only allow insecure certificates when explicitly enabled by user
            logger.warn('⚠️ SECURITY WARNING: Using insecure HTTPS agent for enterprise GitHub server (user-configured)');
            const agent = new https.Agent({
                rejectUnauthorized: false,
                // Allow self-signed certificates
                checkServerIdentity: () => undefined,
                // Keep connections alive
                keepAlive: true,
                maxSockets: 5
            });
            logger.debug('[createHttpsAgent] Insecure agent created successfully:', !!agent);
            return agent;
        } else if (isEnterprise) {
            logger.debug('[createHttpsAgent] Creating SECURE agent for enterprise');
            // For enterprise GitHub with secure certificates
            return new https.Agent({
                // Full certificate validation enabled
                rejectUnauthorized: true,
                // Keep connections alive
                keepAlive: true,
                maxSockets: 5
            });
        } else {
            logger.debug('[createHttpsAgent] Public GitHub detected, returning undefined (default agent)');
        }
    } catch (error) {
        logger.warn('[createHttpsAgent] Failed to create HTTPS agent, using default:', error);
    }

    logger.debug('[createHttpsAgent] Returning undefined (default secure agent)');
    return undefined;
}
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

    // Initialize logger with configuration monitoring
    initializeLogger(context);
    logger = getLogger();

    // 🔒 Secure TLS handling - SSL verification enabled by default
    // Enterprise GitHub with self-signed certificates requires explicit user opt-in
    logger.info('Extension initialized with secure TLS handling (SSL verification enabled)');

    // Debug: Test configuration reading on startup
    const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
    const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);
    logger.debug('allowInsecureEnterpriseCerts setting:', allowInsecureEnterpriseCerts);
    logger.trace('Configuration inspection:', config.inspect('allowInsecureEnterpriseCerts'));

    // Register manage sources command (UI entry point)
    // Static imports for ESM/TS compatibility

    const manageSourcesDisposable = vscode.commands.registerCommand('vscode-git-copilot-tools.manageSources', async () => {
        // Main quick pick menu
        let sources = RepoStorage.getSources(context);
        while (true) {
            const pick = await vscode.window.showQuickPick([
                { label: 'Add Repository', description: 'Add a new public GitHub repo as a source' },
                { label: 'Remove Repository', description: 'Remove a repo from sources' },
                { label: 'Reset to Default', description: 'Restore default source list' },
                { label: 'View Sources', description: sources.map((s: any) => `${s.owner}/${s.repo}`).join(', ') },
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
                // Parse input - support GitHub Enterprise URLs
                let owner = '', repo = '', baseUrl = '', branch = '';

                // Clean the input first
                const cleanInput = input.trim();
                logger.debug('Parsing input:', `"${cleanInput}"`);

                try {
                    if (cleanInput.startsWith('http')) {
                        // Enhanced URL parsing for enterprise GitHub
                        // Also captures optional /tree/<branch> segment
                        const urlMatch = cleanInput.match(/^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/][^?#]*))?(?:[?#].*)?$/);
                        logger.debug('URL match result:', urlMatch);

                        if (urlMatch) {
                            const domain = urlMatch[1];
                            owner = urlMatch[2];
                            repo = urlMatch[3];
                            branch = urlMatch[4] ? urlMatch[4].trim() : '';

                            logger.debug('Parsed URL - domain:', domain, 'owner:', owner, 'repo:', repo, 'branch:', branch);

                            // If not github.com, it's GitHub Enterprise
                            if (domain !== 'github.com') {
                                baseUrl = `https://${domain}`;
                            }
                        } else {
                            throw new Error('Invalid URL format');
                        }
                    } else if (cleanInput.includes('/')) {
                        const parts = cleanInput.split('/').filter(p => p.trim());
                        logger.debug('Split parts:', parts);

                        if (parts.length >= 2) {
                            owner = parts[0].trim();
                            repo = parts[1].trim().replace(/\.git$/, ''); // Remove .git suffix if present

                            logger.debug('Parsed parts - owner:', owner, 'repo:', repo);
                        }
                    }
                } catch (parseError) {
                    logger.error('URL parsing error:', parseError);
                }

                logger.debug('Final parsed values - owner:', owner, 'repo:', repo, 'baseUrl:', baseUrl, 'branch:', branch);

                if (!owner || !repo) {
                    vscode.window.showErrorMessage(`Invalid repository format. Use owner/repo or full URL. Parsed: owner="${owner}", repo="${repo}"`);
                    continue;
                }
                // Check for duplicate
                if (sources.some((s: any) => s.owner === owner && s.repo === repo)) {
                    vscode.window.showWarningMessage('Repository already added.');
                    continue;
                }
                // For enterprise GitHub, show info message
                if (baseUrl) {
                    const enterpriseUrl = `${baseUrl}/${owner}/${repo}`;
                    vscode.window.showInformationMessage(
                        `🔐 Enterprise GitHub Detected: ${enterpriseUrl}\n\nPlease ensure you have configured your Personal Access Token using "Configure Enterprise Token" command.`
                    );
                }

                // Validate repo structure (check that at least one content folder exists)
                try {
                    const cats = ['plugins', 'instructions', 'prompts', 'agents', 'skills'];
                    const foundFolders: string[] = [];
                    const missingFolders: string[] = [];

                    // Show progress for enterprise repos
                    if (baseUrl) {
                        statusBarManager.showLoading(`Validating repository structure for ${owner}/${repo}...`);
                    }

                    // Helper function to check if a folder exists
                    const checkFolder = async (cat: string): Promise<boolean> => {
                        // Build correct API URL for GitHub or GitHub Enterprise
                        // Append ?ref=<branch> when a specific branch was requested
                        const refSuffix = branch ? `?ref=${encodeURIComponent(branch)}` : '';
                        let apiUrl: string;
                        if (baseUrl) {
                            apiUrl = `${baseUrl}/api/v3/repos/${owner}/${repo}/contents/${cat}${refSuffix}`;
                        } else {
                            apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cat}${refSuffix}`;
                        }

                        const headers: Record<string, string> = {
                            'User-Agent': 'VSCode-VscodeGitCopilotTools-Extension',
                            'Accept': 'application/vnd.github.v3+json'
                        };

                        if (baseUrl) {
                            // Enhanced enterprise GitHub auth headers
                            headers['X-Requested-With'] = 'VSCode-Extension';
                            headers['Accept-Encoding'] = 'gzip, deflate, br';
                            headers['Accept-Language'] = 'en-US,en;q=0.9';
                            headers['Cache-Control'] = 'no-cache';
                            headers['Pragma'] = 'no-cache';
                            headers['Sec-Fetch-Dest'] = 'empty';
                            headers['Sec-Fetch-Mode'] = 'cors';
                            headers['Sec-Fetch-Site'] = 'same-origin';

                            // Priority 1: Check for configured enterprise token
                            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
                            const enterpriseToken = config.get<string>('enterpriseToken');

                            if (enterpriseToken) {
                                headers['Authorization'] = `token ${enterpriseToken}`;
                                logger.debug('🔑 Using configured enterprise GitHub token');
                            } else {
                                // Priority 2: Try VS Code's authentication provider
                                try {
                                    const session = await vscode.authentication.getSession('github', [], {
                                        createIfNone: false,
                                        silent: true
                                    });
                                    if (session && session.accessToken) {
                                        headers['Authorization'] = `token ${session.accessToken}`;
                                        logger.debug('🔑 Using VS Code GitHub authentication');
                                    } else {
                                        logger.info('📝 No authentication available - please configure enterprise token');
                                    }
                                } catch (authError) {
                                    logger.info('📝 VS Code GitHub auth not available - please configure enterprise token');
                                }
                            }
                        }

                        // Enhanced SSL handling with security configuration
                        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
                        const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

                        // Debug logging for SSL handling
                        if (baseUrl) {
                            logger.debug('Enterprise GitHub detected:', baseUrl);
                            logger.debug('API URL:', apiUrl);
                            logger.debug('Configuration check - allowInsecureEnterpriseCerts:', allowInsecureEnterpriseCerts);
                            logger.trace('Configuration raw value:', config.get('allowInsecureEnterpriseCerts'));
                            logger.trace('Full config inspection:', config.inspect('allowInsecureEnterpriseCerts'));
                        }

                        const httpsAgent = createHttpsAgent(apiUrl, allowInsecureEnterpriseCerts);

                        // More debug logging for SSL handling
                        if (baseUrl) {
                            logger.debug('HTTPS Agent created:', !!httpsAgent);
                            logger.debug('🔧 createHttpsAgent parameters:', {
                                url: apiUrl,
                                allowInsecureEnterpriseCerts: allowInsecureEnterpriseCerts,
                                isEnterprise: !apiUrl.includes('github.com')
                            });
                            if (httpsAgent) {
                                logger.debug('HTTPS Agent options:', {
                                    rejectUnauthorized: (httpsAgent as any).options?.rejectUnauthorized,
                                    checkServerIdentity: !!(httpsAgent as any).options?.checkServerIdentity
                                });
                            } else {
                                logger.warn('❌ HTTPS Agent is undefined - checking createHttpsAgent logic');
                            }
                        }

                        const axiosConfig: any = {
                            headers: headers,
                            timeout: 10000, // Increased timeout for enterprise
                            // For enterprise GitHub, allow cookies for authentication
                            withCredentials: !!baseUrl
                        };

                        // Apply SSL configuration for enterprise GitHub
                        if (baseUrl) {
                            if (httpsAgent) {
                                axiosConfig.httpsAgent = httpsAgent;
                                // Ensure axios uses the custom agent
                                axiosConfig.agent = httpsAgent;
                                logger.debug('✅ HTTPS Agent applied to axios config');
                            } else {
                                logger.debug('❌ No HTTPS Agent created - will use default (secure) TLS');
                            }
                        }


                        try {
                            let resp;
                            if (baseUrl && allowInsecureEnterpriseCerts) {
                                // Temporary global TLS override for this specific enterprise request
                                logger.trace('🔧 [WORKAROUND] Applying global TLS override for enterprise GitHub request');
                                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                                try {
                                    resp = await axios.get(apiUrl, axiosConfig);
                                    logger.trace('🔧 [WORKAROUND] Enterprise request succeeded with global TLS override');
                                } finally {
                                    // Restore original setting immediately
                                    if (originalRejectUnauthorized === undefined) {
                                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                                    } else {
                                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                                    }
                                    logger.trace('🔧 [WORKAROUND] TLS validation restored');
                                }
                            } else {
                                resp = await axios.get(apiUrl, axiosConfig);
                            }

                            // Check if response contains valid directory content
                            return Array.isArray(resp.data) && resp.data.length > 0;
                        } catch (error: any) {
                            // If 404, folder doesn't exist - that's okay for our flexible validation
                            if (error.response?.status === 404) {
                                return false;
                            }
                            // Re-throw other errors (auth, network, etc.)
                            throw error;
                        }
                    };

                    // Check each folder and track which ones exist
                    for (const cat of cats) {
                        const exists = await checkFolder(cat);
                        if (exists) {
                            foundFolders.push(cat);
                        } else {
                            missingFolders.push(cat);
                        }
                    }

                    // Repository is valid if it has at least one content folder
                    if (foundFolders.length === 0) {
                        // No default folders found - offer folder mapping configuration UI
                        const configChoice = await vscode.window.showInformationMessage(
                            `No standard content folders found in ${owner}/${repo}. Would you like to configure custom folder mappings?`,
                            'Configure Folders',
                            'Cancel'
                        );

                        if (configChoice !== 'Configure Folders') {
                            continue;
                        }

                        const repoLabel = baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`;
                        const folderMappings = await showFolderMappingPanel(context.extensionUri, repoLabel);

                        if (!folderMappings) {
                            // User cancelled the folder mapping panel
                            continue;
                        }

                        // Check that at least one mapping is set
                        const hasMapping = Object.values(folderMappings).some(v => v !== null && v !== undefined && v !== '');
                        if (!hasMapping) {
                            vscode.window.showWarningMessage('No folder mappings configured. Repository not added.');
                            continue;
                        }

                        // Create repo source with custom folder mappings
                        const repoSource: RepoSource = baseUrl
                            ? { owner, repo, baseUrl, ...(branch && { branch }), folderMappings }
                            : { owner, repo, ...(branch && { branch }), folderMappings };
                        sources.push(repoSource);
                        await RepoStorage.setSources(context, sources);

                        logger.info('New repository source added with custom folder mappings:', {
                            owner, repo,
                            baseUrl: baseUrl || 'github.com',
                            folderMappings
                        });

                        const displayUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`;
                        statusBarManager.showSuccess(`Successfully added: ${displayUrl} (with custom folder mappings)`);
                        treeProvider.refresh();
                        continue;
                    }

                    // Create repo source object with baseUrl and optional branch if needed
                    const repoSource = baseUrl
                        ? { owner, repo, baseUrl, ...(branch && { branch }) }
                        : { owner, repo, ...(branch && { branch }) };
                    sources.push(repoSource);
                    await RepoStorage.setSources(context, sources);

                    // Log the successful addition
                    logger.info('New repository source added:', {
                        owner,
                        repo,
                        baseUrl: baseUrl || 'github.com',
                        branch: branch || '(default)',
                        foundFolders,
                        displayUrl: baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`
                    });

                    const displayUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `${owner}/${repo}`;
                    const branchSuffix = branch ? ` (branch: ${branch})` : '';

                    // Create success message with found folders
                    let successMessage = `✅ Successfully added: ${displayUrl}${branchSuffix}`;
                    if (foundFolders.length > 0) {
                        successMessage += `\n📁 Found folders: ${foundFolders.join(', ')}`;
                        if (missingFolders.length > 0) {
                            successMessage += `\n⚠️ Missing folders: ${missingFolders.join(', ')} (optional)`;
                        }
                    }

                    statusBarManager.showSuccess(`✅ Successfully added: ${displayUrl}${branchSuffix}`);                } catch (err: any) {
                    // Enhanced error handling with detailed diagnostics
                    const errorMessage = (err && err.message) || err;
                    const statusCode = err.response?.status;
                    const responseData = err.response?.data;

                    logger.error('Repository validation error:', {
                        error: errorMessage,
                        statusCode,
                        responseData,
                        owner,
                        repo,
                        baseUrl,
                        input: input,
                        apiUrl: baseUrl ? `${baseUrl}/api/v3/repos/${owner}/${repo}/contents/` : `https://api.github.com/repos/${owner}/${repo}/contents/`
                    });

                    if (statusCode === 404) {
                        // 404 Not Found - Repository or path doesn't exist
                        const repoUrl = baseUrl ? `${baseUrl}/${owner}/${repo}` : `https://github.com/${owner}/${repo}`;

                        // Debug the URL construction
                        logger.error('404 Error URL construction debug:', {
                            owner: `"${owner}"`,
                            repo: `"${repo}"`,
                            baseUrl: `"${baseUrl}"`,
                            repoUrl: `"${repoUrl}"`,
                            originalInput: `"${input}"`
                        });

                        const retryChoice = await vscode.window.showErrorMessage(
                            `🔍 Repository Not Found or No Valid Content\n\nThe repository ${owner}/${repo} was not found or doesn't contain any of the required content folders (plugins, instructions, prompts).\n\nPlease verify:\n1. Repository exists at: ${repoUrl}\n2. Repository is public or you have access\n3. Repository contains at least one of: plugins, instructions, or prompts folders\n\nNote: A repository only needs to have ONE of these folders, not all of them.\n\nDebug: Input="${input}", Owner="${owner}", Repo="${repo}"`,
                            'Check Repository',
                            'Retry',
                            'Cancel'
                        );

                        if (retryChoice === 'Check Repository') {
                            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
                        } else if (retryChoice === 'Retry') {
                            continue;
                        }
                    } else if (baseUrl && (statusCode === 401 || errorMessage.includes('401') || errorMessage.includes('Unauthorized'))) {
                        // Authentication error for enterprise GitHub
                        const retryChoice = await vscode.window.showErrorMessage(
                            `🔐 Authentication Required (401)\n\nFailed to access ${baseUrl}/${owner}/${repo}.\n\nPlease configure your Personal Access Token using "Configure Enterprise Token" command.`,
                            'Configure Token',
                            'Retry',
                            'Cancel'
                        );

                        if (retryChoice === 'Configure Token') {
                            // Run the token configuration command
                            await vscode.commands.executeCommand('vscode-git-copilot-tools.configureEnterpriseToken');
                        } else if (retryChoice === 'Retry') {
                            // Let user try again in the main loop
                            continue;
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
                        } else if (retryChoice === 'Retry') {
                            continue;
                        }
                    } else {
                        // Other errors
                        vscode.window.showErrorMessage(`❌ Failed to add repository: ${errorMessage}${statusCode ? ` (${statusCode})` : ''}`);
                    }
                }
            } else if (pick.label === 'Remove Repository') {
                if (sources.length === 1) {
                    vscode.window.showWarningMessage('At least one source is required.');
                    continue;
                }
                const toRemove = await vscode.window.showQuickPick(
                    sources.map((s: any) => ({ label: `${s.owner}/${s.repo}`, source: s })),
                    { placeHolder: 'Select a repo to remove' }
                );
                if (!toRemove) { continue; }

                // Clear cache for the repository being removed
                githubService.clearRepoCache(toRemove.source);

                sources = sources.filter((s: any) => `${s.owner}/${s.repo}` !== toRemove.label);
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
                statusBarManager.showInfo('Current sources: ' + sources.map((s: any) => `${s.owner}/${s.repo}`).join(', '), 8000);
            }
        }
    });

	// Initialize services
	const statusBarManager = new StatusBarManager();
	const githubService = new GitHubService(statusBarManager);
	const downloadTracker = new DownloadTracker(context);
	const treeProvider = new VscodeGitCopilotToolsProvider(githubService, context, downloadTracker);
	const previewProvider = new CopilotPreviewProvider();

    // Initialize repository sources from settings
    await RepoStorage.initializeFromSettings(context);

    // Listen for configuration changes
    const configChangeDisposable = RepoStorage.onConfigurationChanged(context, () => {
        // Refresh tree view when configuration changes
        treeProvider.refresh();
        statusBarManager.showInfo('Repository sources updated from settings');
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
	const handleSelection = async (e: vscode.TreeViewSelectionChangeEvent<any>) => {
		if (e.selection.length > 0) {
			const selectedItem = e.selection[0];
			if (selectedItem.copilotItem) {
				await previewCopilotItem(selectedItem.copilotItem, githubService, previewProvider);
			}
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
		searchView,
		searchViewSecondary,
		treeView,
		treeViewSecondary,
		previewProviderDisposable,
		statusBarManager
	);
}

async function downloadCopilotItem(item: CopilotItem, githubService: GitHubService, downloadTracker: DownloadTracker): Promise<void> {
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

        // Get target folder path
        const targetFolder = FOLDER_PATHS[item.category];
        const fullTargetPath = path.join(workspaceFolder.uri.fsPath, targetFolder);

        // Plugins: parse plugin.json and download individual items to category folders
        if (item.category === CopilotCategory.Plugins && item.file.type === 'dir') {
            // Fetch and parse plugin.json
            let pluginResult;
            try {
                pluginResult = await githubService.parsePluginJson(item.repo, item.file.path);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to read plugin metadata: ${error}`);
                return;
            }

            const metadata = pluginResult.metadata;
            const pluginItems = metadata.items ?? [];

            if (pluginItems.length === 0) {
                vscode.window.showWarningMessage(`Plugin "${metadata.name}" has no items to download.`);
                return;
            }

            // Show confirmation dialog with plugin details
            const confirm = await vscode.window.showInformationMessage(
                `Download plugin "${metadata.name}"?\n\n${metadata.description}\n\n${pluginItems.length} item(s) will be saved to their category folders.`,
                { modal: true },
                'Download'
            );

            if (confirm !== 'Download') {
                return;
            }

            // Download each item from plugin.json
            let downloadedCount = 0;
            let errorCount = 0;
            const downloadedFiles: string[] = [];
            const failedFiles: string[] = [];

            for (const pluginItem of pluginItems) {
                try {
                    const category = KIND_TO_CATEGORY[pluginItem.kind];
                    if (!category) {
                        getLogger().warn(`Unknown kind "${pluginItem.kind}" for item ${pluginItem.path}, skipping.`);
                        failedFiles.push(`${pluginItem.path} (unknown kind: ${pluginItem.kind})`);
                        errorCount++;
                        continue;
                    }

                    const categoryFolder = FOLDER_PATHS[category];
                    const fullCategoryPath = path.join(workspaceFolder.uri.fsPath, categoryFolder);

                    // Ensure category directory exists
                    if (!fs.existsSync(fullCategoryPath)) {
                        fs.mkdirSync(fullCategoryPath, { recursive: true });
                    }

                    if (pluginItem.kind === 'skill') {
                        // Skills are directories: use recursive download
                        const skillDirName = pluginItem.path.split('/').pop() || pluginItem.path;
                        const targetSkillPath = path.join(fullCategoryPath, skillDirName);

                        if (fs.existsSync(targetSkillPath)) {
                            fs.rmSync(targetSkillPath, { recursive: true, force: true });
                        }
                        fs.mkdirSync(targetSkillPath, { recursive: true });

                        const contents = await githubService.getDirectoryContents(item.repo, pluginItem.path);
                        for (const fileItem of contents) {
                            if (fileItem.type === 'file') {
                                const skillFolderPath = pluginItem.path.endsWith('/') ? pluginItem.path : pluginItem.path + '/';
                                const relativePath = fileItem.path.startsWith(skillFolderPath)
                                    ? fileItem.path.substring(skillFolderPath.length)
                                    : fileItem.path;
                                const targetFilePath = path.join(targetSkillPath, relativePath);

                                const parentDir = path.dirname(targetFilePath);
                                if (!fs.existsSync(parentDir)) {
                                    fs.mkdirSync(parentDir, { recursive: true });
                                }

                                const content = await githubService.getFileContent(fileItem.download_url);
                                fs.writeFileSync(targetFilePath, content, 'utf8');
                            }
                        }
                        downloadedFiles.push(`${pluginItem.kind}: ${skillDirName} (${contents.filter(f => f.type === 'file').length} files)`);
                    } else {
                        // Instruction, prompt, or agent items.
                        // In the current plugin.json format, agents may reference an entire directory
                        // (e.g. "plugins/foo/agents" with no file extension). In that case, download all
                        // files inside the directory to the category folder.
                        const lastSegment = pluginItem.path.split('/').pop() || pluginItem.path;
                        const isDirectoryRef = !lastSegment.includes('.');

                        if (isDirectoryRef) {
                            // Directory reference (e.g. agents dir) — download all contained files flat
                            const contents = await githubService.getDirectoryContents(item.repo, pluginItem.path);
                            for (const fileItem of contents) {
                                if (fileItem.type === 'file') {
                                    const targetFilePath = path.join(fullCategoryPath, fileItem.name);
                                    const content = await githubService.getFileContent(fileItem.download_url);
                                    fs.writeFileSync(targetFilePath, content, 'utf8');
                                }
                            }
                            const fileCount = contents.filter(f => f.type === 'file').length;
                            downloadedFiles.push(`${pluginItem.kind}: ${lastSegment}/ (${fileCount} files)`);
                        } else {
                            // Single file item
                            const filename = lastSegment;
                            const targetFilePath = path.join(fullCategoryPath, filename);
                            const fileData = await githubService.getFileContentByPath(item.repo, pluginItem.path);
                            fs.writeFileSync(targetFilePath, fileData.content, 'utf8');
                            downloadedFiles.push(`${pluginItem.kind}: ${filename}`);
                        }
                    }

                    downloadedCount++;
                } catch (itemError) {
                    getLogger().error(`Failed to download plugin item ${pluginItem.path}:`, itemError);
                    failedFiles.push(`${pluginItem.path}`);
                    errorCount++;
                }
            }

            // Save plugin files locally (plugin.json, agents/, commands/, README.md, NOTE)
            const pluginDir = path.join(fullTargetPath, metadata.id || item.name);
            if (!fs.existsSync(pluginDir)) {
                fs.mkdirSync(pluginDir, { recursive: true });
            }

            // Save plugin.json mirroring upstream structure (.github/plugin/plugin.json)
            try {
                const pluginJsonDir = path.join(pluginDir, '.github', 'plugin');
                if (!fs.existsSync(pluginJsonDir)) {
                    fs.mkdirSync(pluginJsonDir, { recursive: true });
                }
                fs.writeFileSync(
                    path.join(pluginJsonDir, 'plugin.json'),
                    JSON.stringify(metadata, null, 2),
                    'utf8'
                );
            } catch (metaSaveError) {
                getLogger().warn('Failed to save plugin.json locally:', metaSaveError);
            }

            // Download agents/, commands/, and README.md from the plugin directory
            try {
                const pluginContents = await githubService.getDirectoryContents(item.repo, item.file.path);
                const topLevelItems = pluginContents.filter(f => {
                    // Only top-level entries (direct children of the plugin dir)
                    const relativePath = f.path.substring(item.file.path.length + 1);
                    return !relativePath.includes('/');
                });

                // Download agents/ folder if it exists
                const agentsDir = topLevelItems.find(f => f.type === 'dir' && f.name === 'agents');
                if (agentsDir) {
                    const agentsLocalDir = path.join(pluginDir, 'agents');
                    if (!fs.existsSync(agentsLocalDir)) {
                        fs.mkdirSync(agentsLocalDir, { recursive: true });
                    }
                    const agentFiles = pluginContents.filter(
                        f => f.type === 'file' && f.path.startsWith(agentsDir.path + '/')
                    );
                    for (const agentFile of agentFiles) {
                        try {
                            const relativePath = agentFile.path.substring(agentsDir.path.length + 1);
                            const targetFilePath = path.join(agentsLocalDir, relativePath);
                            const parentDir = path.dirname(targetFilePath);
                            if (!fs.existsSync(parentDir)) {
                                fs.mkdirSync(parentDir, { recursive: true });
                            }
                            const content = await githubService.getFileContent(agentFile.download_url);
                            fs.writeFileSync(targetFilePath, content, 'utf8');
                        } catch (agentErr) {
                            getLogger().warn(`Failed to download agent file ${agentFile.name}:`, agentErr);
                        }
                    }
                }

                // Download commands/ folder if it exists
                const commandsDir = topLevelItems.find(f => f.type === 'dir' && f.name === 'commands');
                if (commandsDir) {
                    const commandsLocalDir = path.join(pluginDir, 'commands');
                    if (!fs.existsSync(commandsLocalDir)) {
                        fs.mkdirSync(commandsLocalDir, { recursive: true });
                    }
                    const commandFiles = pluginContents.filter(
                        f => f.type === 'file' && f.path.startsWith(commandsDir.path + '/')
                    );
                    for (const commandFile of commandFiles) {
                        try {
                            const relativePath = commandFile.path.substring(commandsDir.path.length + 1);
                            const targetFilePath = path.join(commandsLocalDir, relativePath);
                            const parentDir = path.dirname(targetFilePath);
                            if (!fs.existsSync(parentDir)) {
                                fs.mkdirSync(parentDir, { recursive: true });
                            }
                            const content = await githubService.getFileContent(commandFile.download_url);
                            fs.writeFileSync(targetFilePath, content, 'utf8');
                        } catch (cmdErr) {
                            getLogger().warn(`Failed to download command file ${commandFile.name}:`, cmdErr);
                        }
                    }
                }

                // Download README.md if it exists
                const readmeFile = topLevelItems.find(f => f.type === 'file' && f.name === 'README.md');
                let readmeContent = '';
                if (readmeFile) {
                    try {
                        readmeContent = await githubService.getFileContent(readmeFile.download_url);
                        fs.writeFileSync(path.join(pluginDir, 'README.md'), readmeContent, 'utf8');
                    } catch (readmeErr) {
                        getLogger().warn('Failed to download plugin README.md:', readmeErr);
                    }
                }

                // Generate NOTE.VSCODE-VSCODE-GIT-COPILOT-TOOLS-EXTENSION.md with slash command mappings
                const pluginName = metadata.id || item.name;
                const noteContent = generateNoteContent(readmeContent, pluginName);
                fs.writeFileSync(
                    path.join(pluginDir, 'NOTE.VSCODE-VSCODE-GIT-COPILOT-TOOLS-EXTENSION.md'),
                    noteContent,
                    'utf8'
                );
            } catch (pluginFilesError) {
                getLogger().warn('Failed to download additional plugin files:', pluginFilesError);
            }

            // Record download and clear cache
            await downloadTracker.recordDownload(item);
            githubService.clearCategoryCache(item.repo, item.category);

            // Show summary
            let summaryMessage = `Plugin "${metadata.name}" downloaded!\n\n`;
            summaryMessage += `Downloaded ${downloadedCount}/${pluginItems.length} item(s) successfully.`;
            if (errorCount > 0) {
                summaryMessage += `\n${errorCount} item(s) failed.`;
            }

            vscode.window.showInformationMessage(summaryMessage);
            return;
        }

        // Skills are folders - handle them differently
        if (item.category === CopilotCategory.Skills && item.file.type === 'dir') {
            // Show input box for folder name confirmation
            const folderName = await vscode.window.showInputBox({
                prompt: `Download skill folder ${item.name} to ${targetFolder}`,
                value: item.name,
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return 'Folder name cannot be empty';
                    }
                    return null;
                }
            });

            if (!folderName) {
                return; // User cancelled
            }

            const targetSkillPath = path.join(fullTargetPath, folderName);

            // Check if folder exists
            if (fs.existsSync(targetSkillPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `Skill folder ${folderName} already exists. Do you want to overwrite it?`,
                    'Overwrite', 'Cancel'
                );

                if (overwrite !== 'Overwrite') {
                    return;
                }

                // Remove existing folder
                fs.rmSync(targetSkillPath, { recursive: true, force: true });
            }

            // Create skill folder
            fs.mkdirSync(targetSkillPath, { recursive: true });

            // Get all contents of the skill folder recursively
            const contents = await githubService.getDirectoryContents(item.repo, item.file.path);

            // Download each file in the skill folder
            for (const fileItem of contents) {
                if (fileItem.type === 'file') {
                    // Calculate relative path within the skill folder
                    // Remove the skill folder path prefix to get the relative path
                    const skillFolderPath = item.file.path.endsWith('/') ? item.file.path : item.file.path + '/';
                    const relativePath = fileItem.path.startsWith(skillFolderPath)
                        ? fileItem.path.substring(skillFolderPath.length)
                        : fileItem.path;
                    const targetFilePath = path.join(targetSkillPath, relativePath);

                    // Create parent directory if needed
                    const parentDir = path.dirname(targetFilePath);
                    if (!fs.existsSync(parentDir)) {
                        fs.mkdirSync(parentDir, { recursive: true });
                    }

					// Download and save file
					const content = await githubService.getFileContent(fileItem.download_url);
					fs.writeFileSync(targetFilePath, content, 'utf8');
				}
			}

			// Record the download
			await downloadTracker.recordDownload(item);

			// Clear cache for this category to force fresh metadata on next refresh
			githubService.clearCategoryCache(item.repo, item.category);

            // Show success message
            const openFolder = await vscode.window.showInformationMessage(
                `Successfully downloaded skill folder ${folderName}`,
                'Open Folder'
            );

            if (openFolder === 'Open Folder') {
                // Open the SKILL.md file if it exists
                const skillMdPath = path.join(targetSkillPath, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                    const document = await vscode.workspace.openTextDocument(skillMdPath);
                    await vscode.window.showTextDocument(document);
                } else {
                    // If no SKILL.md, just reveal the folder
                    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(targetSkillPath));
                }
            }
        } else {
            // Regular file download (for other categories)
            // Show input box for filename confirmation
            const filename = await vscode.window.showInputBox({
                prompt: `Download ${item.name} to ${targetFolder}`,
                value: item.name,
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return 'Filename cannot be empty';
                    }
                    return null;
                }
            });

            if (!filename) {
                return; // User cancelled
            }

            const targetFilePath = path.join(fullTargetPath, filename);

            // Check if file exists
            if (fs.existsSync(targetFilePath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `File ${filename} already exists. Do you want to overwrite it?`,
                    'Overwrite', 'Cancel'
                );

                if (overwrite !== 'Overwrite') {
                    return;
                }
            }

            // Create directory if it doesn't exist
            if (!fs.existsSync(fullTargetPath)) {
                fs.mkdirSync(fullTargetPath, { recursive: true });
            }

			// Fetch content and save file
			const content = await githubService.getFileContent(item.file.download_url);
			fs.writeFileSync(targetFilePath, content, 'utf8');

			// Record the download with content for hash calculation
			await downloadTracker.recordDownload(item, content);

			// Clear cache for this category to force fresh metadata on next refresh
			githubService.clearCategoryCache(item.repo, item.category);

            // Show success message and offer to open file
            const openFile = await vscode.window.showInformationMessage(
                `Successfully downloaded ${filename}`,
                'Open File'
            );

            if (openFile === 'Open File') {
                const document = await vscode.workspace.openTextDocument(targetFilePath);
                await vscode.window.showTextDocument(document);
            }
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to download ${item.name}: ${error}`);
    }
}

async function previewCopilotItem(item: CopilotItem, githubService: GitHubService, previewProvider: CopilotPreviewProvider): Promise<void> {
    try {
        // For Skills folders, preview the SKILL.md file
        if (item.category === CopilotCategory.Skills && item.file.type === 'dir') {
            // Get the contents of the skill folder
            const contents = await githubService.getDirectoryContents(item.repo, item.file.path);

            // Find SKILL.md file
            const skillMdFile = contents.find(f => f.name === 'SKILL.md' && f.type === 'file');

            if (skillMdFile) {
                // Fetch SKILL.md content
                item.content = await githubService.getFileContent(skillMdFile.download_url);

                // Create and show preview document
                const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(item.name + '/SKILL.md')}`);

                // Set the item content in the preview provider
                previewProvider.setItem(previewUri, item);

                const doc = await vscode.workspace.openTextDocument(previewUri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } else {
                // No SKILL.md found, show list of files in the folder
                const skillFolderPath = item.file.path.endsWith('/') ? item.file.path : item.file.path + '/';
                const fileList = contents
                    .filter(f => f.type === 'file')
                    .map(f => {
                        const relativePath = f.path.startsWith(skillFolderPath)
                            ? f.path.substring(skillFolderPath.length)
                            : f.path;
                        return `- ${relativePath}`;
                    })
                    .join('\n');

                item.content = `# ${item.name}\n\n**Skill Folder Contents:**\n\n${fileList}\n\nDownload this skill to get all files.`;

                const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(item.name)}`);
                previewProvider.setItem(previewUri, item);

                const doc = await vscode.workspace.openTextDocument(previewUri);
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        } else if (item.category === CopilotCategory.Plugins && item.file.type === 'dir') {
            // For Plugin directories, show plugin.json metadata + README.md
            let previewContent = '';

            // Fetch plugin.json for metadata
            try {
                const pluginResult = await githubService.parsePluginJson(item.repo, item.file.path);
                const meta = pluginResult.metadata;
                previewContent += `# ${meta.name}\n\n`;
                previewContent += `${meta.description}\n\n`;
                if (meta.version) { previewContent += `**Version:** ${meta.version}\n`; }
                if (meta.author?.name) { previewContent += `**Author:** ${meta.author.name}\n`; }
                if (meta.license) { previewContent += `**License:** ${meta.license}\n`; }
                if (meta.tags?.length) { previewContent += `**Tags:** ${meta.tags.join(', ')}\n`; }
                const metaItems = meta.items ?? [];
                previewContent += `\n**Items (${metaItems.length}):**\n`;
                metaItems.forEach(pi => {
                    const filename = pi.path.split('/').pop() || pi.path;
                    previewContent += `- ${filename} (${pi.kind})\n`;
                });
                previewContent += '\n---\n\n';
            } catch {
                // plugin.json not available, continue without metadata
            }

            // Fetch README.md for additional preview content
            const contents = await githubService.getDirectoryContents(item.repo, item.file.path);
            const readmeMdFile = contents.find(f => f.name === 'README.md' && f.type === 'file');

            if (readmeMdFile) {
                const readmeContent = await githubService.getFileContent(readmeMdFile.download_url);
                previewContent += readmeContent;
            } else if (!previewContent) {
                previewContent = `# ${item.name}\n\n*(No plugin metadata or README found)*`;
            }

            item.content = previewContent;
            const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(item.name + '/README.md')}`);
            previewProvider.setItem(previewUri, item);
            const doc = await vscode.workspace.openTextDocument(previewUri);
            await vscode.window.showTextDocument(doc, { preview: true });
        } else {
            // Regular file preview (for other categories)
            // Fetch content if not already cached
            if (!item.content) {
                item.content = await githubService.getFileContent(item.file.download_url);
            }

            // Create and show preview document
            const previewUri = vscode.Uri.parse(`copilot-preview:${encodeURIComponent(item.name)}`);

            // Set the item content in the preview provider
            previewProvider.setItem(previewUri, item);

            const doc = await vscode.workspace.openTextDocument(previewUri);
            await vscode.window.showTextDocument(doc, { preview: true });
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to preview ${item.name}: ${error}`);
    }
}

// This method is called when your extension is deactivated
export function deactivate() { }
