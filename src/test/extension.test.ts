import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { GitHubService } from '../githubService';
import { CopilotCategory } from '../types';
import { extractSlashCommands, generateNoteContent } from '../views/note.vscode-git-copilot-tools';
import * as logger from '../logger';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    // Mock the logger for tests
    const mockLogger = {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        dispose: () => {}
    };

    // Override getLogger to return mock logger
    suiteSetup(async () => {
        (logger as any).getLogger = () => mockLogger;
        // Disable GitHub auth for tests to avoid hanging on auth dialog prompts
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        await config.update('enableGithubAuth', false, vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
        // Restore default auth setting
        const config = vscode.workspace.getConfiguration('vscode-git-copilot-tools');
        await config.update('enableGithubAuth', undefined, vscode.ConfigurationTarget.Global);
    });

    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });

    test('GitHub Service can be instantiated', () => {
        const service = new GitHubService();
        assert.ok(service);
    });

    test('GitHub Service can fetch plugins', async () => {
        const service = new GitHubService();
        try {
            const files = await service.getFiles(CopilotCategory.Plugins);
            assert.ok(Array.isArray(files));
            console.log(`Found ${files.length} plugin files`);
        } catch (error) {
            console.warn('Network test failed - this is expected in CI/offline environments:', error);
        }
    }).timeout(30000);

    test('GitHub Service can fetch skills', async () => {
        const service = new GitHubService();
        try {
            const files = await service.getFiles(CopilotCategory.Skills);
            assert.ok(Array.isArray(files));
            console.log(`Found ${files.length} skills files`);
        } catch (error) {
            console.warn('Network test failed - this is expected in CI/offline environments:', error);
        }
    }).timeout(15000);

    suite('parsePluginJson Tests', () => {
        let service: GitHubService;
        const mockRepo = { owner: 'test', repo: 'test-repo' };

        // Helper to mock getFileContentByPath
        function mockFileContent(service: GitHubService, content: string) {
            (service as any).getFileContentByPath = async () => ({
                content,
                download_url: 'http://test-url.com/plugin.json',
                sha: 'abc123',
                size: content.length
            });
        }

        setup(() => {
            service = new GitHubService();
        });

        test('should parse valid JSON with all required fields', async () => {
            const validJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin for validation",
                version: "1.0.0",
                author: { name: "Test Author" },
                tags: ["test", "sample"],
                items: [
                    { path: "instructions/test.instructions.md", kind: "instruction" },
                    { path: "prompts/sample.prompt.md", kind: "prompt" }
                ],
                display: { ordering: "alpha", show_badge: true }
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/test-plugin');

            // id should be derived from directory name
            assert.strictEqual(result.metadata.id, 'test-plugin');
            assert.strictEqual(result.metadata.name, 'Test Plugin');
            assert.strictEqual(result.metadata.description, 'A test plugin for validation');
            assert.strictEqual(result.metadata.version, '1.0.0');
            assert.strictEqual(result.metadata.author?.name, 'Test Author');
            assert.ok(Array.isArray(result.metadata.items));
            assert.strictEqual(result.metadata.items.length, 2);
            assert.strictEqual(result.metadata.items[0].path, 'instructions/test.instructions.md');
            assert.strictEqual(result.metadata.items[0].kind, 'instruction');
            assert.strictEqual(result.rawContent, validJson);
        });

        test('should use id from JSON when present', async () => {
            const validJson = JSON.stringify({
                id: "custom-id",
                name: "Test Plugin",
                description: "A test plugin",
                items: [{ path: "prompts/test.md", kind: "prompt" }]
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/test-plugin');

            assert.strictEqual(result.metadata.id, 'custom-id');
        });

        test('should reject JSON missing name field', async () => {
            const invalidJson = JSON.stringify({
                description: "A test plugin",
                items: [{ path: "test.md", kind: "instruction" }]
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "name" field'));
                    return true;
                }
            );
        });

        test('should reject JSON with empty name field', async () => {
            const invalidJson = JSON.stringify({
                name: "   ",
                description: "A test plugin",
                items: [{ path: "test.md", kind: "instruction" }]
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "name" field'));
                    return true;
                }
            );
        });

        test('should reject JSON missing description field', async () => {
            const invalidJson = JSON.stringify({
                name: "Test Plugin",
                items: [{ path: "test.md", kind: "instruction" }]
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "description" field'));
                    return true;
                }
            );
        });

        test('should reject JSON with empty description field', async () => {
            const invalidJson = JSON.stringify({
                name: "Test Plugin",
                description: "",
                items: [{ path: "test.md", kind: "instruction" }]
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "description" field'));
                    return true;
                }
            );
        });

        test('should reject JSON missing items array', async () => {
            const invalidJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin"
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "items" array'));
                    return true;
                }
            );
        });

        test('should reject JSON with non-array items field', async () => {
            const invalidJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin",
                items: "not an array"
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "items" array'));
                    return true;
                }
            );
        });

        test('should accept JSON with empty items array', async () => {
            const validJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin",
                items: []
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/test-plugin');

            assert.strictEqual(result.metadata.id, 'test-plugin');
            assert.ok(Array.isArray(result.metadata.items));
            assert.strictEqual(result.metadata.items.length, 0);
            assert.strictEqual(result.rawContent, validJson);
        });

        test('should reject completely invalid JSON', async () => {
            const invalidJson = 'this is not valid json at all {{{';

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    return true;
                }
            );
        });

        test('should reject null or undefined JSON content', async () => {
            const invalidJson = 'null';

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('Invalid plugin.json format'));
                    return true;
                }
            );
        });

        test('should parse JSON with optional fields', async () => {
            const validJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin",
                version: "2.0.0",
                author: { name: "Author Name" },
                repository: "https://github.com/test/repo",
                license: "MIT",
                featured: true,
                tags: ["testing", "sample", "demo"],
                items: [
                    { path: "instructions/test.instructions.md", kind: "instruction" }
                ],
                display: { ordering: "custom", show_badge: false }
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/test-plugin');

            assert.ok(result.metadata.tags);
            assert.strictEqual(result.metadata.tags!.length, 3);
            assert.strictEqual(result.metadata.tags![0], 'testing');
            assert.strictEqual(result.metadata.version, '2.0.0');
            assert.strictEqual(result.metadata.author?.name, 'Author Name');
            assert.strictEqual(result.metadata.repository, 'https://github.com/test/repo');
            assert.strictEqual(result.metadata.license, 'MIT');
            assert.strictEqual(result.metadata.featured, true);
            assert.ok(result.metadata.display);
            assert.strictEqual(result.metadata.display!.ordering, 'custom');
            assert.strictEqual(result.metadata.display!.show_badge, false);
            assert.strictEqual(result.rawContent, validJson);
        });

        test('should handle multiple items with different kinds', async () => {
            const validJson = JSON.stringify({
                name: "Multi-Kind Plugin",
                description: "Plugin with multiple item kinds",
                items: [
                    { path: "instructions/test.instructions.md", kind: "instruction" },
                    { path: "prompts/sample.prompt.md", kind: "prompt" },
                    { path: "agents/helper.agent.md", kind: "agent" },
                    { path: "skills/analyzer", kind: "skill" }
                ]
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/multi-kind');

            assert.strictEqual(result.metadata.id, 'multi-kind');
            assert.ok(Array.isArray(result.metadata.items));
            assert.strictEqual(result.metadata.items!.length, 4);
            assert.strictEqual(result.metadata.items![0].kind, 'instruction');
            assert.strictEqual(result.metadata.items![1].kind, 'prompt');
            assert.strictEqual(result.metadata.items![2].kind, 'agent');
            assert.strictEqual(result.metadata.items![3].kind, 'skill');
            assert.strictEqual(result.rawContent, validJson);
        });

        test('should parse current format with agents and skills arrays', async () => {
            const validJson = JSON.stringify({
                name: "awesome-copilot",
                description: "Meta prompts for discovery",
                version: "1.0.0",
                author: { name: "Awesome Copilot Community" },
                repository: "https://github.com/github/awesome-copilot",
                license: "MIT",
                keywords: ["github-copilot", "discovery"],
                agents: ["./agents"],
                skills: [
                    "./skills/suggest-awesome-github-copilot-skills",
                    "./skills/suggest-awesome-github-copilot-instructions"
                ]
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/awesome-copilot');

            assert.strictEqual(result.metadata.id, 'awesome-copilot');
            assert.strictEqual(result.metadata.name, 'awesome-copilot');
            assert.ok(Array.isArray(result.metadata.items));
            // 1 agent dir + 2 skill dirs = 3 items
            assert.strictEqual(result.metadata.items!.length, 3);
            // agent item should resolve relative path to repo-relative path
            assert.strictEqual(result.metadata.items![0].kind, 'agent');
            assert.strictEqual(result.metadata.items![0].path, 'plugins/awesome-copilot/agents');
            // skill items should strip ./ and trailing slashes
            assert.strictEqual(result.metadata.items![1].kind, 'skill');
            assert.strictEqual(result.metadata.items![1].path, 'plugins/awesome-copilot/skills/suggest-awesome-github-copilot-skills');
            assert.strictEqual(result.metadata.items![2].kind, 'skill');
            assert.strictEqual(result.metadata.items![2].path, 'plugins/awesome-copilot/skills/suggest-awesome-github-copilot-instructions');
        });

        test('should parse current format with only skills (no agents)', async () => {
            const validJson = JSON.stringify({
                name: "Skills Only Plugin",
                description: "A plugin with only skills",
                skills: [
                    "./skills/my-skill"
                ]
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/skills-only');

            assert.ok(Array.isArray(result.metadata.items));
            assert.strictEqual(result.metadata.items!.length, 1);
            assert.strictEqual(result.metadata.items![0].kind, 'skill');
            assert.strictEqual(result.metadata.items![0].path, 'plugins/skills-only/skills/my-skill');
        });

        test('should parse current format with trailing slashes stripped from skill paths', async () => {
            const validJson = JSON.stringify({
                name: "Slash Strip Plugin",
                description: "Tests trailing slash removal",
                skills: [
                    "./skills/my-skill/"
                ]
            });

            mockFileContent(service, validJson);

            const result = await service.parsePluginJson(mockRepo, 'plugins/slash-strip');

            assert.ok(Array.isArray(result.metadata.items));
            assert.strictEqual(result.metadata.items![0].path, 'plugins/slash-strip/skills/my-skill');
        });

        test('should reject current format JSON missing both items and type arrays', async () => {
            const invalidJson = JSON.stringify({
                name: "Test Plugin",
                description: "A test plugin"
                // No items, no agents, no skills, no instructions, no prompts
            });

            mockFileContent(service, invalidJson);

            await assert.rejects(
                async () => await service.parsePluginJson(mockRepo, 'plugins/test-plugin'),
                (error: Error) => {
                    assert.ok(error.message.includes('Failed to parse plugin.json'));
                    assert.ok(error.message.includes('missing or invalid "items" array'));
                    return true;
                }
            );
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
