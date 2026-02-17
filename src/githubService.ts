
import axios from 'axios';
import * as vscode from 'vscode';
import * as https from 'https';
import { GitHubFile, CopilotCategory, CacheEntry, RepoSource, PluginMetadata, PluginParseResult, PLUGIN_JSON_RELATIVE_PATH, resolveContentPath } from './types';
import { RepoStorage } from './repoStorage';
import { StatusBarManager } from './statusBarManager';
import { getLogger } from './logger';


export class GitHubService {
    private static readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour
    // Cache key: repoKey|category
    private cache: Map<string, CacheEntry> = new Map();
    private statusBarManager: StatusBarManager;

    constructor(statusBarManager?: StatusBarManager) {
        // Use provided status bar manager or create a new one
        this.statusBarManager = statusBarManager || new StatusBarManager();
    }

    // Check if GitHub authentication is available and prompt if needed
    private async ensureGitHubAuth(isEnterprise: boolean = false): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);

        if (!enableAuth) {
            return false;
        }

        try {
            // For enterprise, check if token is configured first
            if (isEnterprise) {
                const enterpriseToken = config.get<string>('enterpriseToken');
                if (enterpriseToken) {
                    return true;
                }
            }

            // Try to get existing session
            let session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: false,
                silent: true
            });

            if (!session) {
                // Prompt user to sign in
                const signInChoice = await vscode.window.showInformationMessage(
                    'Sign in to GitHub to increase API rate limits from 60 to 5,000 requests per hour.',
                    'Sign In',
                    'Skip'
                );

                if (signInChoice === 'Sign In') {
                    session = await vscode.authentication.getSession('github', ['repo'], {
                        createIfNone: true
                    });
                    if (session) {
                        this.statusBarManager.showInfo('GitHub authentication successful!');
                        return true;
                    }
                }
                return false;
            }
            return true;
        } catch (error) {
            getLogger().error('GitHub authentication error:', error);
            return false;
        }
    }

    // Check if we have authentication available (silent check)
    private async checkAuthentication(): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');

            // Check for enterprise token
            const enterpriseToken = config.get<string>('enterpriseToken');
            if (enterpriseToken) {
                return true;
            }

            // Check for GitHub session
            const session = await vscode.authentication.getSession('github', ['repo'], {
                createIfNone: false,
                silent: true
            });

            return !!session;
        } catch (error) {
            return false;
        }
    }

    // Handle authentication-related HTTP errors
    private async handleAuthError(error: any, isEnterprise: boolean = false): Promise<boolean> {
        const isAxiosError = error && typeof error === 'object' && 'response' in error;
        const statusCode = isAxiosError ? error.response?.status : undefined;

        if (statusCode === 401 || statusCode === 403) {
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            const enableAuth = config.get<boolean>('enableGithubAuth', true);

            if (!enableAuth) {
                this.statusBarManager.showWarning('GitHub authentication is disabled. Enable it to avoid rate limits.');
                return false;
            }

            // Check if this is a rate limit issue
            const rateLimitRemaining = error.response?.headers['x-ratelimit-remaining'];
            const rateLimitReset = error.response?.headers['x-ratelimit-reset'];

            if (rateLimitRemaining === '0' || rateLimitRemaining === 0) {
                // Definitely rate limited
                if (rateLimitReset) {
                    const resetDate = new Date(parseInt(rateLimitReset) * 1000);
                    const waitMinutes = Math.ceil((resetDate.getTime() - Date.now()) / (60 * 1000));
                    this.statusBarManager.showWarning(`Rate limit exceeded. Resets in ${waitMinutes} minutes.`);

                    // Suggest authentication if not already authenticated
                    const authChoice = await vscode.window.showWarningMessage(
                        `GitHub API rate limit exceeded. Sign in to GitHub to get 5,000 requests/hour instead of 60.`,
                        'Sign In',
                        'Wait'
                    );

                    if (authChoice === 'Sign In') {
                        return await this.ensureGitHubAuth(isEnterprise);
                    }
                }
            } else {
                // 403 without rate limit = likely needs authentication for this resource
                const errorMessage = error.response?.data?.message || 'Authentication required';
                const authChoice = await vscode.window.showErrorMessage(
                    `GitHub API error: ${errorMessage}. Sign in to access repositories and increase rate limits (60 → 5,000 requests/hour).`,
                    'Sign In',
                    'Skip'
                );

                if (authChoice === 'Sign In') {
                    return await this.ensureGitHubAuth(isEnterprise);
                }
            }
        }
        return false;
    }

    // Create HTTPS agent with secure SSL handling - requires explicit user opt-in for insecure certificates
    private createHttpsAgent(url: string): https.Agent | undefined {
        try {
            // Check security configuration
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            // If it's not github.com, treat as enterprise
            const isEnterprise = !url.includes('github.com');


            if (isEnterprise && allowInsecureEnterpriseCerts) {
                // Only allow insecure certificates when explicitly enabled by user
                getLogger().warn('⚠️ SECURITY WARNING: Using insecure HTTPS agent for enterprise GitHub server');
                return new https.Agent({
                    rejectUnauthorized: false,
                    checkServerIdentity: () => undefined,
                    keepAlive: true,
                    maxSockets: 5
                });
            } else if (isEnterprise) {
                return new https.Agent({
                    rejectUnauthorized: true,
                    keepAlive: true,
                    maxSockets: 5
                });
            }
        } catch (error) {
            getLogger().warn('Failed to create HTTPS agent:', error);
        }
        return undefined;
    }

    // Create request headers with proper authentication for GitHub
    private async createRequestHeaders(isEnterprise: boolean = false): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'User-Agent': 'VSCode-VscodeGitCopilotTools-Extension/1.0.0',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };

        // Try to authenticate for all GitHub requests (both public and enterprise)
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);

        if (enableAuth) {
            if (isEnterprise) {
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
                const enterpriseToken = config.get<string>('enterpriseToken');
                if (enterpriseToken) {
                    headers['Authorization'] = `Bearer ${enterpriseToken}`;
                    return headers;
                }
            }

            // Try VS Code's GitHub authentication provider for both public and enterprise GitHub
            try {
                const session = await vscode.authentication.getSession('github', ['repo'], {
                    createIfNone: false,
                    silent: true
                });
                if (session && session.accessToken) {
                    headers['Authorization'] = `Bearer ${session.accessToken}`;
                    return headers;
                }
            } catch (authError) {
                getLogger().debug('GitHub authentication failed (silent):', authError);
            }
        }

        return headers;
    }

    // Get files for a category from all sources, merged
    async getFiles(category: CopilotCategory, forceRefresh: boolean = false, context?: vscode.ExtensionContext): Promise<GitHubFile[]> {
        // Get sources from storage (context required for multi-repo)
        let sources: RepoSource[] = [{ owner: 'github', repo: 'awesome-copilot', label: 'Git Copilot Tools' }];
        if (context) {
            try { sources = RepoStorage.getSources(context); } catch { }
        }

        // Proactively check for authentication to avoid 403 errors
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);

        if (enableAuth) {
            // Check if we have any authentication
            const hasAuth = await this.checkAuthentication();
            if (!hasAuth) {
                // Prompt for authentication before making requests
                getLogger().info('No GitHub authentication found, prompting user...');
                await this.ensureGitHubAuth(false);
            }
        }

        const now = Date.now();
        let allFiles: GitHubFile[] = [];
        for (const repo of sources) {
            const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
            const cacheKey = `${repoKey}|${category}`;
            const cacheEntry = this.cache.get(cacheKey);
            if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
                allFiles = allFiles.concat(cacheEntry.data);
                continue;
            }
            try {
                const contentPath = resolveContentPath(repo, category);
                if (contentPath === null) {
                    // Category is explicitly excluded via folder mappings
                    getLogger().debug(`Category '${category}' excluded for ${repo.owner}/${repo.repo} via folder mappings`);
                    continue;
                }
                const apiUrl = contentPath === ''
                    ? this.buildApiUrlForPath(repo, '')
                    : this.buildApiUrlForPath(repo, contentPath);
                const isEnterprise = !!repo.baseUrl;
                const headers = await this.createRequestHeaders(isEnterprise);

                const axiosConfig: any = {
                    timeout: 10000,
                    headers: headers,
                    // For enterprise GitHub, allow cookies to be sent for authentication
                    withCredentials: isEnterprise
                };

                // Apply SSL configuration for enterprise GitHub
                if (isEnterprise) {
                    const httpsAgent = this.createHttpsAgent(apiUrl);
                    if (httpsAgent) {
                        axiosConfig.httpsAgent = httpsAgent;
                        axiosConfig.agent = httpsAgent;
                    }
                }

                let response;
                const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
                const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

                try {
                    if (isEnterprise && allowInsecureEnterpriseCerts) {
                        // Temporary global TLS override for this specific enterprise request
                        const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                        try {
                            response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                        } finally {
                            // Restore original setting immediately
                            if (originalRejectUnauthorized === undefined) {
                                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                            } else {
                                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                            }
                        }
                    } else {
                        response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                    }
                } catch (requestError) {
                    // Handle authentication errors and retry
                    const authRetried = await this.handleAuthError(requestError, isEnterprise);
                    if (authRetried) {
                        // Retry with new authentication
                        const newHeaders = await this.createRequestHeaders(isEnterprise);
                        axiosConfig.headers = newHeaders;

                        if (isEnterprise && allowInsecureEnterpriseCerts) {
                            const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                            try {
                                response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                            } finally {
                                if (originalRejectUnauthorized === undefined) {
                                    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                                } else {
                                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                                }
                            }
                        } else {
                            response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                        }
                    } else {
                        throw requestError;
                    }
                }

                // For Skills category, show directories (folders); for other categories, show files
                // For Plugins category, show directories (each plugin is a directory)
                const files = (response.data as GitHubFile[])
                    .filter((file: GitHubFile) => {
                        if (category === CopilotCategory.Skills) {
                            return file.type === 'dir';
                        }
                        if (category === CopilotCategory.Plugins) {
                            return file.type === 'dir';
                        }
                        return file.type === 'file';
                    })
                    .map(f => ({ ...f, repo }));
                this.cache.set(cacheKey, {
                    data: files,
                    timestamp: now,
                    category,
                    repo
                });
                allFiles = allFiles.concat(files);
            } catch (error) {
                // Handle different types of errors
                const isAxiosError = error && typeof error === 'object' && 'response' in error;
                const statusCode = isAxiosError ? (error as any).response?.status : undefined;

                if (statusCode === 404) {
                    // 404 is expected when a repository doesn't have a particular category folder
                    getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                } else {
                    // Show warning in status bar for other errors (auth, network, etc.)
                    this.statusBarManager.showWarning(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
                }
            }
        }
        // Handle duplicate filenames by adding repo information to displayName
        const fileNameCounts = new Map<string, number>();
        const duplicateNames = new Set<string>();

        // First pass: count occurrences of each filename
        for (const file of allFiles) {
            const count = fileNameCounts.get(file.name) || 0;
            fileNameCounts.set(file.name, count + 1);
            if (count >= 1) {
                duplicateNames.add(file.name);
            }
        }

        // Second pass: add displayName for duplicates
        for (const file of allFiles) {
            if (duplicateNames.has(file.name) && file.repo) {
                // For duplicates, show "filename.ext (owner/repo)"
                file.displayName = `${file.name} (${file.repo.owner}/${file.repo.repo})`;
            } else {
                // For unique files, use original name
                file.displayName = file.name;
            }
        }

        return allFiles;
    }

    // Get files for a category from a specific repository
    async getFilesByRepo(repo: RepoSource, category: CopilotCategory, forceRefresh: boolean = false): Promise<GitHubFile[]> {
        // Resolve the content path using folder mappings (custom, root, or default)
        const contentPath = resolveContentPath(repo, category);
        if (contentPath === null) {
            // Category is explicitly excluded via folder mappings
            getLogger().debug(`Category '${category}' excluded for ${repo.owner}/${repo.repo} via folder mappings`);
            return [];
        }

        const now = Date.now();
        const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
        const cacheKey = `${repoKey}|${category}`;
        const cacheEntry = this.cache.get(cacheKey);

        if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < GitHubService.CACHE_DURATION) {
            return cacheEntry.data;
        }

        // Proactively check for authentication to avoid 403 errors (same as getFiles)
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        const enableAuth = config.get<boolean>('enableGithubAuth', true);
        const isEnterprise = !!repo.baseUrl;

        if (enableAuth && !isEnterprise) {
            // Check if we have any authentication for public GitHub
            const hasAuth = await this.checkAuthentication();
            if (!hasAuth) {
                // Prompt for authentication before making requests
                getLogger().info('No GitHub authentication found, prompting user...');
                await this.ensureGitHubAuth(false);
            }
        }

        try {
            // Build API URL using the resolved content path (supports custom folder mappings)
            const apiUrl = contentPath === ''
                ? this.buildApiUrlForPath(repo, '')
                : this.buildApiUrlForPath(repo, contentPath);
            const headers = await this.createRequestHeaders(isEnterprise);

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                // For enterprise GitHub, allow cookies to be sent for authentication
                withCredentials: isEnterprise
            };

            // Apply SSL configuration for enterprise GitHub
            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(apiUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            try {
                if (isEnterprise && allowInsecureEnterpriseCerts) {
                    // Temporary global TLS override for this specific enterprise request
                    const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                    try {
                        response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                    } finally {
                        // Restore original setting immediately
                        if (originalRejectUnauthorized === undefined) {
                            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                        } else {
                            process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                        }
                    }
                } else {
                    response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                }
            } catch (requestError) {
                // Handle authentication errors and retry (same pattern as getFiles)
                const authRetried = await this.handleAuthError(requestError, isEnterprise);
                if (authRetried) {
                    // Retry with new authentication
                    const newHeaders = await this.createRequestHeaders(isEnterprise);
                    axiosConfig.headers = newHeaders;

                    if (isEnterprise && allowInsecureEnterpriseCerts) {
                        const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                        try {
                            response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                        } finally {
                            if (originalRejectUnauthorized === undefined) {
                                delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                            } else {
                                process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                            }
                        }
                    } else {
                        response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                    }
                } else {
                    throw requestError;
                }
            }

            // For Skills category, show directories (folders); for other categories, show files
            // For Plugins category, show only .yml files
            const files = (response.data as GitHubFile[])
                .filter((file: GitHubFile) => {
                    if (category === CopilotCategory.Skills) {
                        return file.type === 'dir';
                    }
                    if (category === CopilotCategory.Plugins) {
                        return file.type === 'dir';
                    }
                    return file.type === 'file';
                })
                .map(f => ({ ...f, repo }));

            this.cache.set(cacheKey, {
                data: files,
                timestamp: now,
                category,
                repo
            });

            return files;
        } catch (error) {
            // Handle different types of errors
            const isAxiosError = error && typeof error === 'object' && 'response' in error;
            const statusCode = isAxiosError ? (error as any).response?.status : undefined;

            if (statusCode === 404) {
                // 404 is expected when a repository doesn't have a particular category folder
                // Return empty array instead of throwing error
                getLogger().debug(`Category '${category}' not found in ${repo.owner}/${repo.repo} (this is normal)`);
                return [];
            } else {
                // Log and throw error for other types of errors (auth, network, etc.)
                getLogger().error(`Failed to load ${category} from ${repo.owner}/${repo.repo}:`, error);
                throw new Error(`Failed to load ${category} from ${repo.owner}/${repo.repo}: ${error}`);
            }
        }
    }

    async getFileContent(downloadUrl: string): Promise<string> {
        try {
            const isEnterprise = !downloadUrl.includes('github.com');
            const headers = await this.createRequestHeaders(isEnterprise);

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                // For enterprise GitHub, allow cookies for authentication
                withCredentials: isEnterprise
            };

            // Apply SSL configuration for enterprise GitHub
            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(downloadUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            if (isEnterprise && allowInsecureEnterpriseCerts) {
                // Temporary global TLS override for this specific enterprise request
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                try {
                    response = await axios.get(downloadUrl, axiosConfig);
                } finally {
                    // Restore original setting immediately
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get(downloadUrl, axiosConfig);
            }
            return response.data;
        } catch (error) {
            getLogger().error('Failed to fetch file content:', error);
            throw new Error(`Failed to fetch file content: ${error}`);
        }
    }

    // Fetch file content by repo-relative path using GitHub Contents API
    async getFileContentByPath(repo: RepoSource, filePath: string): Promise<{
        content: string;
        download_url: string;
        sha: string;
        size: number;
    }> {
        try {
            const apiUrl = this.buildApiUrlForPath(repo, filePath);
            const isEnterprise = !!repo.baseUrl;
            const headers = await this.createRequestHeaders(isEnterprise);

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                withCredentials: isEnterprise
            };

            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(apiUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            if (isEnterprise && allowInsecureEnterpriseCerts) {
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                try {
                    response = await axios.get(apiUrl, axiosConfig);
                } finally {
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get(apiUrl, axiosConfig);
            }

            const data = response.data;

            // GitHub Contents API returns base64-encoded content for files up to 1MB
            if (data.type === 'file' && data.content) {
                const content = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
                return {
                    content,
                    download_url: data.download_url,
                    sha: data.sha,
                    size: data.size
                };
            }

            // For files >1MB, content is null but download_url is available
            if (data.type === 'file' && data.download_url) {
                const content = await this.getFileContent(data.download_url);
                return {
                    content,
                    download_url: data.download_url,
                    sha: data.sha,
                    size: data.size
                };
            }

            throw new Error(`Path "${filePath}" is not a file or has no content`);
        } catch (error) {
            getLogger().error(`Failed to fetch file content for path ${filePath}:`, error);
            throw new Error(`Failed to fetch file content for path "${filePath}": ${error}`);
        }
    }

    // Parse plugin.json file from a plugin directory and return metadata
    async parsePluginJson(repo: RepoSource, pluginDirPath: string): Promise<PluginParseResult> {
        try {
            const pluginJsonPath = `${pluginDirPath}/${PLUGIN_JSON_RELATIVE_PATH}`;
            const fileData = await this.getFileContentByPath(repo, pluginJsonPath);

            let metadata: PluginMetadata;
            try {
                metadata = JSON.parse(fileData.content) as PluginMetadata;
            } catch (parseError) {
                throw new Error('Invalid plugin.json format: not valid JSON');
            }

            // Structural validation of required fields
            if (!metadata || typeof metadata !== 'object') {
                throw new Error('Invalid plugin.json format: metadata is missing or not an object');
            }

            if (typeof metadata.name !== 'string' || !metadata.name.trim()) {
                throw new Error('Invalid plugin.json format: missing or invalid "name" field');
            }

            if (typeof metadata.description !== 'string' || !metadata.description.trim()) {
                throw new Error('Invalid plugin.json format: missing or invalid "description" field');
            }

            if (!Array.isArray(metadata.items)) {
                throw new Error('Invalid plugin.json format: missing or invalid "items" array');
            }

            const allowedKinds = ['instruction', 'prompt', 'agent', 'skill'];

            metadata.items.forEach((item: any, index: number) => {
                if (!item || typeof item !== 'object') {
                    throw new Error(`Invalid plugin.json format: item at index ${index} is not an object`);
                }

                if (typeof item.path !== 'string' || !item.path.trim()) {
                    throw new Error(`Invalid plugin.json format: item at index ${index} is missing or has an invalid "path" field`);
                }

                if (typeof item.kind !== 'string' || !item.kind.trim()) {
                    throw new Error(`Invalid plugin.json format: item at index ${index} is missing or has an invalid "kind" field`);
                }

                if (!allowedKinds.includes(item.kind)) {
                    throw new Error(
                        `Invalid plugin.json format: item at index ${index} has unsupported "kind" value "${item.kind}". ` +
                        `Allowed kinds are: ${allowedKinds.join(', ')}`
                    );
                }
            });

            // Derive id from directory name if not present in JSON
            if (!metadata.id || typeof metadata.id !== 'string') {
                const pathParts = pluginDirPath.split('/');
                metadata.id = pathParts[pathParts.length - 1];
            }

            return { metadata, rawContent: fileData.content };
        } catch (error) {
            getLogger().error('Failed to parse plugin.json:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse plugin.json: ${errorMessage}`);
        }
    }

    // Get contents of a directory recursively (for Skills folders)
    async getDirectoryContents(repo: RepoSource, path: string): Promise<GitHubFile[]> {
        try {
            const apiUrl = this.buildApiUrlForPath(repo, path);
            const isEnterprise = !!repo.baseUrl;
            const headers = await this.createRequestHeaders(isEnterprise);

            const axiosConfig: any = {
                timeout: 10000,
                headers: headers,
                withCredentials: isEnterprise
            };

            if (isEnterprise) {
                const httpsAgent = this.createHttpsAgent(apiUrl);
                if (httpsAgent) {
                    axiosConfig.httpsAgent = httpsAgent;
                    axiosConfig.agent = httpsAgent;
                }
            }

            let response;
            const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
            const allowInsecureEnterpriseCerts = config.get<boolean>('allowInsecureEnterpriseCerts', false);

            if (isEnterprise && allowInsecureEnterpriseCerts) {
                const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

                try {
                    response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
                } finally {
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            } else {
                response = await axios.get<GitHubFile[]>(apiUrl, axiosConfig);
            }

            const contents: GitHubFile[] = [];
            const items = response.data as GitHubFile[];

            // Add all items first
            for (const item of items) {
                contents.push({ ...item, repo });
            }

            // Recursively get subdirectory contents in parallel for better performance
            const subdirs = items.filter(item => item.type === 'dir');
            if (subdirs.length > 0) {
                const subContentPromises = subdirs.map(dir => this.getDirectoryContents(repo, dir.path));
                const subContentsArrays = await Promise.all(subContentPromises);

                // Flatten and add all subdirectory contents
                for (const subContents of subContentsArrays) {
                    contents.push(...subContents);
                }
            }

            return contents;
        } catch (error) {
            getLogger().error(`Failed to fetch directory contents for ${path}:`, error);
            throw new Error(`Failed to fetch directory contents: ${error}`);
        }
    }

    // Build API URL for a specific path (empty string means repo root)
    private buildApiUrlForPath(repo: RepoSource, path: string): string {
        const contentsSuffix = path ? `/contents/${path}` : '/contents';
        if (repo.baseUrl) {
            const baseUrl = repo.baseUrl.replace(/\/$/, '');
            return `${baseUrl}/api/v3/repos/${repo.owner}/${repo.repo}${contentsSuffix}`;
        } else {
            return `https://api.github.com/repos/${repo.owner}/${repo.repo}${contentsSuffix}`;
        }
    }

    // Build API URL for GitHub or GitHub Enterprise Server
    private buildApiUrl(repo: RepoSource, category: CopilotCategory): string {
        if (repo.baseUrl) {
            // GitHub Enterprise Server
            // Convert https://github.wdf.sap.corp to https://github.wdf.sap.corp/api/v3
            const baseUrl = repo.baseUrl.replace(/\/$/, ''); // Remove trailing slash
            return `${baseUrl}/api/v3/repos/${repo.owner}/${repo.repo}/contents/${category}`;
        } else {
            // Public GitHub
            return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${category}`;
        }
    }

    clearCache(): void {
        this.cache.clear();
    }

    // Clear cache entries for a specific repository
    clearRepoCache(repo: RepoSource): void {
        const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
        const keysToDelete: string[] = [];

        // Find all cache keys for this repository
        for (const cacheKey of this.cache.keys()) {
            if (cacheKey.startsWith(`${repoKey}|`)) {
                keysToDelete.push(cacheKey);
            }
        }

        // Delete the cache entries
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }

        getLogger().info(`Cleared cache for repository: ${repo.owner}/${repo.repo}`);
    }

	// Clear cache for a specific category in a repository
	clearCategoryCache(repo: RepoSource, category: CopilotCategory): void {
		const repoKey = `${repo.baseUrl || 'github.com'}/${repo.owner}/${repo.repo}`;
		const cacheKey = `${repoKey}|${category}`;
		
		if (this.cache.has(cacheKey)) {
			this.cache.delete(cacheKey);
			getLogger().debug(`Cleared cache for ${category} in ${repo.owner}/${repo.repo}`);
		}
	}
	getCacheStatus(): string {
		const entries = Array.from(this.cache.entries());
		if (entries.length === 0) {
			return 'Cache empty';
		}

		const now = Date.now();
		const status = entries.map(([category, entry]) => {
			const age = Math.floor((now - entry.timestamp) / (60 * 1000)); // minutes
			return `${category}: ${entry.data.length} files (${age}m old)`;
		}).join(', ');

		return status;
	}
}