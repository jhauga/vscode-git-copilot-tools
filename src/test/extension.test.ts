import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { GitHubService, classifyAuthFailure } from '../githubService';
import { DownloadMetadata, DownloadTracker } from '../downloadTracker';
import { EngineSettings, parseRepositoryInput, toRepositorySources } from '../repoStorage';
import { CopilotItem, GitHubApiError, ORDERED_CATEGORIES, RepositorySource } from '../types';
import { extractSlashCommands, generateNoteContent } from '../views/note.vscode-git-copilot-tools';
import * as logger from '../logger';

const EXTENSION_ID = 'jhauga.vscode-git-copilot-tools';
const CONFIG_SECTION = 'vscode-git-copilot-tools';
const DOWNLOADS_KEY = 'vscodeGitCopilotTools.downloads';

/** An extension context whose globalState lives in memory. */
function createContext(values: Record<string, unknown> = {}): vscode.ExtensionContext {
    const store = new Map<string, unknown>(Object.entries(values));
    const globalState = {
        keys: () => [...store.keys()],
        get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        setKeysForSync: () => undefined
    };
    return { globalState } as unknown as vscode.ExtensionContext;
}

function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
    return {
        cacheTimeout: 3600000,
        enterpriseToken: '',
        allowInsecureEnterpriseCerts: false,
        enableGithubAuth: true,
        ...overrides
    };
}

/** A download record as an earlier version stored it. */
function oldRecord(overrides: Partial<DownloadMetadata> = {}): DownloadMetadata {
    return {
        itemId: 'agents-helper.agent.md-acme-corp-copilot-tools',
        itemName: 'helper.agent.md',
        category: 'agents',
        repoOwner: 'acme-corp',
        repoName: 'copilot-tools',
        downloadTimestamp: 1000,
        sha: 'a'.repeat(64),
        size: 120,
        downloadUrl: 'https://raw.example.com/agents/helper.agent.md',
        ...overrides
    };
}

function agentItem(file: Partial<CopilotItem['file']> = {}): CopilotItem {
    return {
        id: 'acme-corp/copilot-tools/agents/helper.agent.md',
        name: 'helper.agent.md',
        category: 'agents',
        repo: { owner: 'acme-corp', repo: 'copilot-tools' },
        file: {
            name: 'helper.agent.md',
            path: 'agents/helper.agent.md',
            type: 'file',
            download_url: 'https://raw.example.com/agents/helper.agent.md',
            size: 120,
            sha: 'b'.repeat(40),
            ...file
        }
    };
}

let failCount = 0;
suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    // Mock the logger for tests
    const mockLogger = {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        dispose: () => {}
    };

    // Override getLogger to return mock logger
    suiteSetup(async () => {
        (logger as any).getLogger = () => mockLogger;
        // Disable GitHub auth for tests to avoid hanging on auth dialog prompts
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await config.update('enableGithubAuth', false, vscode.ConfigurationTarget.Global);
    });

    setup(function() {});

    teardown(function() {
        if (this.currentTest?.state === 'failed') {
            failCount++;
        }
    });

    suiteTeardown(async () => {
        // Restore default auth setting
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await config.update('enableGithubAuth', undefined, vscode.ConfigurationTarget.Global);
        console.log(`  ${failCount} failing`);
    });

    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });

    test('GitHub Service can be instantiated', () => {
        const service = new GitHubService();
        assert.ok(service);
        service.dispose();
    });

    suite('Activation Tests', () => {
        // Every category excluded, so activating the extension sends no requests
        const offlineSource = {
            owner: 'acme-corp',
            repo: 'copilot-tools',
            folderMappings: Object.fromEntries(ORDERED_CATEGORIES.map(category => [category, null]))
        };

        suiteSetup(async () => {
            await vscode.workspace.getConfiguration(CONFIG_SECTION)
                .update('repositories', [offlineSource], vscode.ConfigurationTarget.Global);
        });

        suiteTeardown(async () => {
            await vscode.workspace.getConfiguration(CONFIG_SECTION)
                .update('repositories', undefined, vscode.ConfigurationTarget.Global);
        });

        test('activates and registers its commands', async () => {
            const extension = vscode.extensions.getExtension(EXTENSION_ID);
            assert.ok(extension, `${EXTENSION_ID} is loaded in the test host`);
            await extension.activate();
            assert.strictEqual(extension.isActive, true);

            const commands = await vscode.commands.getCommands(true);
            for (const command of [
                'refreshVscodeGitCopilotTools', 'downloadItem', 'previewItem', 'manageSources',
                'removeRepo', 'refreshRepo', 'configureEnterpriseToken', 'clearEnterpriseToken',
                'signInToGitHub', 'signOutFromGitHub', 'openRepoInBrowser'
            ]) {
                assert.ok(commands.includes(`vscode-git-copilot-tools.${command}`), `${command} is registered`);
            }
        }).timeout(60000);
    });

    suite('Repository Settings Tests', () => {
        test('drops entries without an owner or a repo', () => {
            const sources = toRepositorySources([
                { owner: 'acme-corp' },
                { repo: 'copilot-tools' },
                { owner: '  ', repo: 'copilot-tools' },
                'acme-corp/copilot-tools',
                null
            ]);
            assert.deepStrictEqual(sources, []);
        });

        test('reads nothing from a value that is not an array', () => {
            assert.deepStrictEqual(toRepositorySources(undefined), []);
            assert.deepStrictEqual(toRepositorySources({ owner: 'acme-corp', repo: 'copilot-tools' }), []);
        });

        test('trims text and removes trailing slashes from baseUrl', () => {
            const [source] = toRepositorySources([{
                owner: ' acme-corp ',
                repo: ' copilot-tools ',
                label: ' Acme Tools ',
                baseUrl: 'https://github.example.com//',
                branch: ' dev '
            }]);
            assert.deepStrictEqual(source, {
                owner: 'acme-corp',
                repo: 'copilot-tools',
                label: 'Acme Tools',
                baseUrl: 'https://github.example.com',
                branch: 'dev'
            });
        });

        test('keeps folder mappings, including arrays, and drops unknown keys', () => {
            const [source] = toRepositorySources([{
                owner: 'acme-corp',
                repo: 'copilot-skills',
                extra: true,
                folderMappings: {
                    skills: ['frontend', '.', 42],
                    agents: null,
                    prompts: ' root ',
                    unknown: 'folder'
                }
            }]);
            assert.deepStrictEqual(source, {
                owner: 'acme-corp',
                repo: 'copilot-skills',
                folderMappings: { agents: null, prompts: 'root', skills: ['frontend', '.'] }
            });
        });

        test('keeps a relative aiFolder and ignores an absolute one', () => {
            const sources = toRepositorySources([
                { owner: 'acme-corp', repo: 'relative', aiFolder: '.claude' },
                { owner: 'acme-corp', repo: 'drive', aiFolder: 'C:\\Users\\demo-user\\ai' },
                { owner: 'acme-corp', repo: 'posix', aiFolder: '/opt/ai' },
                { owner: 'acme-corp', repo: 'home', aiFolder: '~/ai' }
            ]);
            assert.deepStrictEqual(sources.map(source => source.aiFolder), ['.claude', undefined, undefined, undefined]);
        });
    });

    suite('Repository Input Tests', () => {
        test('reads owner/repo and drops a .git suffix', () => {
            assert.deepStrictEqual(parseRepositoryInput('acme-corp/copilot-tools'), { owner: 'acme-corp', repo: 'copilot-tools' });
            assert.deepStrictEqual(parseRepositoryInput(' acme-corp/copilot-tools.git '), { owner: 'acme-corp', repo: 'copilot-tools' });
        });

        test('reads the branch from a /tree/ URL', () => {
            assert.deepStrictEqual(
                parseRepositoryInput('https://github.com/acme-corp/copilot-tools/tree/dev'),
                { owner: 'acme-corp', repo: 'copilot-tools', branch: 'dev' }
            );
        });

        test('sets baseUrl for a GitHub Enterprise URL', () => {
            assert.deepStrictEqual(
                parseRepositoryInput('https://github.example.com/acme-corp/copilot-tools'),
                { owner: 'acme-corp', repo: 'copilot-tools', baseUrl: 'https://github.example.com' }
            );
        });

        test('ignores a query and a fragment', () => {
            assert.deepStrictEqual(
                parseRepositoryInput('https://github.com/acme-corp/copilot-tools?tab=readme#usage'),
                { owner: 'acme-corp', repo: 'copilot-tools' }
            );
        });

        test('rejects input that names no repository', () => {
            for (const input of ['copilot-tools', 'https://github.com/acme-corp', '', '   ']) {
                assert.strictEqual(parseRepositoryInput(input), undefined, `'${input}'`);
            }
        });
    });

    suite('Token Resolution Tests', () => {
        const publicRepo: RepositorySource = { owner: 'acme-corp', repo: 'copilot-tools' };
        const enterpriseRepo: RepositorySource = { owner: 'acme-corp', repo: 'copilot-tools', baseUrl: 'https://github.example.com' };
        const authentication = vscode.authentication as unknown as { getSession: unknown };
        const originalGetSession = authentication.getSession;
        let sessionLookups = 0;
        let service: GitHubService;

        setup(() => {
            sessionLookups = 0;
            authentication.getSession = async () => {
                sessionLookups++;
                return { id: 'test', accessToken: 'session-token', account: { id: 'demo', label: 'demo-user' }, scopes: ['repo'] };
            };
            service = new GitHubService();
        });

        teardown(() => {
            authentication.getSession = originalGetSession;
            service.dispose();
        });

        test('uses the VS Code session for a github.com source', async () => {
            assert.strictEqual(await service.resolveToken(publicRepo, engineSettings()), 'session-token');
        });

        test('sends no token when GitHub authentication is off', async () => {
            assert.strictEqual(await service.resolveToken(publicRepo, engineSettings({ enableGithubAuth: false })), undefined);
            assert.strictEqual(sessionLookups, 0);
        });

        test('uses the enterprise token for a GitHub Enterprise source', async () => {
            const settings = engineSettings({ enterpriseToken: 'enterprise-token', enableGithubAuth: false });
            assert.strictEqual(await service.resolveToken(enterpriseRepo, settings), 'enterprise-token');
        });

        test('never sends the github.com session to a GitHub Enterprise host', async () => {
            assert.strictEqual(await service.resolveToken(enterpriseRepo, engineSettings()), undefined);
            assert.strictEqual(sessionLookups, 0);
        });

        test('keeps the enterprise token away from github.com', async () => {
            const settings = engineSettings({ enterpriseToken: 'enterprise-token' });
            assert.strictEqual(await service.resolveToken(publicRepo, settings), 'session-token');
        });
    });

    suite('Authentication Failure Tests', () => {
        const url = 'https://api.github.com/repos/acme-corp/copilot-tools/contents/skills';
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);

        test('403 with no requests remaining is a rate limit, with the minutes until reset', () => {
            const error = new GitHubApiError('rate limited', 403, url, { remaining: 0, reset: new Date(now + 10 * 60000) });
            assert.deepStrictEqual(classifyAuthFailure(error, now), { kind: 'rate-limit', resetsInMinutes: 10 });
        });

        test('429 is a rate limit', () => {
            assert.deepStrictEqual(classifyAuthFailure(new GitHubApiError('too many requests', 429, url), now), { kind: 'rate-limit', resetsInMinutes: undefined });
        });

        test('a reset time already passed counts as one minute', () => {
            const error = new GitHubApiError('rate limited', 403, url, { remaining: 0, reset: new Date(now - 5000) });
            assert.deepStrictEqual(classifyAuthFailure(error, now), { kind: 'rate-limit', resetsInMinutes: 1 });
        });

        test('401, and 403 with requests remaining, are authentication failures', () => {
            assert.deepStrictEqual(
                classifyAuthFailure(new GitHubApiError('Bad credentials', 401, url), now),
                { kind: 'auth', status: 401, message: 'Bad credentials' }
            );
            assert.deepStrictEqual(
                classifyAuthFailure(new GitHubApiError('Forbidden', 403, url, { remaining: 4999 }), now),
                { kind: 'auth', status: 403, message: 'Forbidden' }
            );
        });

        test('other failures are not authentication problems', () => {
            assert.strictEqual(classifyAuthFailure(new GitHubApiError('missing', 404, url), now), undefined);
            assert.strictEqual(classifyAuthFailure(new Error('offline'), now), undefined);
        });
    });

    suite('Download Record Tests', () => {
        test('moves old records to the engine item ids and clears content hashes', async () => {
            const tracker = new DownloadTracker(createContext({
                [DOWNLOADS_KEY]: {
                    'agents-helper.agent.md-acme-corp-copilot-tools': oldRecord(),
                    'skills-my-skill-acme-corp-copilot-tools': oldRecord({
                        itemId: 'skills-my-skill-acme-corp-copilot-tools',
                        itemName: 'my-skill',
                        category: 'skills',
                        sha: 'd'.repeat(40),
                        size: 0
                    })
                }
            }));

            assert.strictEqual(await tracker.migrateIds(), 2);
            const downloads = tracker.getDownloads();
            assert.deepStrictEqual(Object.keys(downloads).sort(), [
                'acme-corp/copilot-tools/agents/helper.agent.md',
                'acme-corp/copilot-tools/skills/my-skill'
            ]);
            const agent = downloads['acme-corp/copilot-tools/agents/helper.agent.md'];
            assert.strictEqual(agent.itemId, 'acme-corp/copilot-tools/agents/helper.agent.md');
            assert.strictEqual(agent.sha, '', 'a content hash is cleared');
            assert.strictEqual(downloads['acme-corp/copilot-tools/skills/my-skill'].sha, 'd'.repeat(40), 'a GitHub sha is kept');
            assert.strictEqual(tracker.isDownloaded(agentItem().id), true);
        });

        test('keeps a newer record already stored under the new id', async () => {
            const newId = 'acme-corp/copilot-tools/agents/helper.agent.md';
            const tracker = new DownloadTracker(createContext({
                [DOWNLOADS_KEY]: {
                    'agents-helper.agent.md-acme-corp-copilot-tools': oldRecord({ downloadTimestamp: 1000 }),
                    [newId]: oldRecord({ itemId: newId, downloadTimestamp: 2000, sha: 'e'.repeat(40) })
                }
            }));

            assert.strictEqual(await tracker.migrateIds(), 0);
            const downloads = tracker.getDownloads();
            assert.deepStrictEqual(Object.keys(downloads), [newId]);
            assert.strictEqual(downloads[newId].sha, 'e'.repeat(40));
        });

        test('drops records that cannot be moved', async () => {
            const tracker = new DownloadTracker(createContext({
                [DOWNLOADS_KEY]: { 'agents-helper.agent.md--copilot-tools': oldRecord({ repoOwner: '' }) }
            }));
            assert.strictEqual(await tracker.migrateIds(), 0);
            assert.deepStrictEqual(tracker.getDownloads(), {});
        });

        test('runs once', async () => {
            const context = createContext({ [DOWNLOADS_KEY]: {} });
            const tracker = new DownloadTracker(context);
            await tracker.migrateIds();

            await context.globalState.update(DOWNLOADS_KEY, { 'agents-later.agent.md-acme-corp-copilot-tools': oldRecord() });
            assert.strictEqual(await tracker.migrateIds(), 0);
            assert.deepStrictEqual(Object.keys(tracker.getDownloads()), ['agents-later.agent.md-acme-corp-copilot-tools']);
        });

        test('compares shas when both are known, and sizes otherwise', () => {
            const item = agentItem();
            const tracker = (records: Record<string, DownloadMetadata>) => new DownloadTracker(createContext({ [DOWNLOADS_KEY]: records }));

            const withoutSha = tracker({ [item.id]: oldRecord({ itemId: item.id, sha: '', size: 120 }) });
            assert.strictEqual(withoutSha.hasUpdate(item), false, 'same size');
            assert.strictEqual(withoutSha.hasUpdate(agentItem({ size: 200 })), true, 'different size');

            const withSha = tracker({ [item.id]: oldRecord({ itemId: item.id, sha: 'b'.repeat(40), size: 999 }) });
            assert.strictEqual(withSha.hasUpdate(item), false, 'same sha');
            assert.strictEqual(withSha.hasUpdate(agentItem({ sha: 'c'.repeat(40) })), true, 'different sha');
        });

        test('records the GitHub sha and the path the engine wrote', async () => {
            const tracker = new DownloadTracker(createContext());
            const item = agentItem();
            await tracker.recordDownload(item, {
                itemId: item.id,
                itemName: item.name,
                category: item.category,
                repoOwner: 'acme-corp',
                repoName: 'copilot-tools',
                downloadTimestamp: 5000,
                sha: 'f'.repeat(64),
                size: 120,
                downloadUrl: item.file.download_url ?? '',
                localPath: '/workspace/.github/agents/helper.agent.md'
            });

            const stored = tracker.getDownloadMetadata(item.id);
            assert.ok(stored);
            assert.strictEqual(stored.sha, item.file.sha, 'the listing sha, not a content hash');
            assert.strictEqual(stored.localPath, '/workspace/.github/agents/helper.agent.md');
            assert.strictEqual(stored.downloadTimestamp, 5000);
            assert.strictEqual(tracker.hasUpdate(item), false);
        });
    });

    suite('Slash Command Note Generation Tests', () => {
        test('should extract single slash command from README', () => {
            const readme = [
                '### Commands (Slash Commands)',
                '',
                '| Command | Description |',
                '|---------|-------------|',
                '| `/php-mcp-development:php-mcp-server-generator` | Generate a PHP MCP server |',
            ].join('\n');

            const commands = extractSlashCommands(readme, 'php-mcp-development');
            assert.strictEqual(commands.length, 1);
            assert.strictEqual(commands[0], 'php-mcp-server-generator');
        });

        test('should extract multiple slash commands from README', () => {
            const readme = [
                '| Command | Description |',
                '|---------|-------------|',
                '| `/context-engineering:context-map` | Generate a map |',
                '| `/context-engineering:what-context-needed` | Ask what files needed |',
                '| `/context-engineering:refactor-plan` | Plan a refactor |',
            ].join('\n');

            const commands = extractSlashCommands(readme, 'context-engineering');
            assert.strictEqual(commands.length, 3);
            assert.strictEqual(commands[0], 'context-map');
            assert.strictEqual(commands[1], 'what-context-needed');
            assert.strictEqual(commands[2], 'refactor-plan');
        });

        test('should return empty array when no slash commands found', () => {
            const readme = [
                '# Plugin README',
                '',
                'No slash commands here.',
            ].join('\n');

            const commands = extractSlashCommands(readme, 'some-plugin');
            assert.strictEqual(commands.length, 0);
        });

        test('should not extract commands from a different plugin name', () => {
            const readme = [
                '| `/other-plugin:some-command` | Description |',
            ].join('\n');

            const commands = extractSlashCommands(readme, 'my-plugin');
            assert.strictEqual(commands.length, 0);
        });

        test('should generate note content with single command', () => {
            const readme = [
                '| Command | Description |',
                '|---------|-------------|',
                '| `/php-mcp-development:php-mcp-server-generator` | Generate a PHP MCP server |',
            ].join('\n');

            const content = generateNoteContent(readme, 'php-mcp-development');
            assert.ok(content.includes('# NOTE'));
            assert.ok(content.includes('| `/php-mcp-server-generator` |'));
            assert.ok(!content.includes('SLASH-COMMAND-NOTE'));
            assert.ok(!content.includes('php-mcp-development:'));
        });

        test('should generate note content with multiple commands', () => {
            const readme = [
                '| Command | Description |',
                '|---------|-------------|',
                '| `/context-engineering:context-map` | Map |',
                '| `/context-engineering:what-context-needed` | Ask |',
                '| `/context-engineering:refactor-plan` | Plan |',
            ].join('\n');

            const content = generateNoteContent(readme, 'context-engineering');
            assert.ok(content.includes('| `/context-map` |'));
            assert.ok(content.includes('| `/what-context-needed` |'));
            assert.ok(content.includes('| `/refactor-plan` |'));
        });

        test('should generate note content with (none) when no commands', () => {
            const readme = '# Plugin with no commands';

            const content = generateNoteContent(readme, 'no-commands-plugin');
            assert.ok(content.includes('(none)'));
            assert.ok(!content.includes('SLASH-COMMAND-NOTE'));
        });

        test('should generate note content with empty README', () => {
            const content = generateNoteContent('', 'empty-readme');
            assert.ok(content.includes('# NOTE'));
            assert.ok(content.includes('(none)'));
        });
    });
});
