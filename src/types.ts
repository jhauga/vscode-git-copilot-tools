/**
 * Types and constants for the Git Copilot Tools extension.
 *
 * Shared types and constants come from the cmd-git-copilot-tools engine; the
 * values defined here belong to the extension's own views.
 */

import type { ToolCategory } from 'cmd-git-copilot-tools';

export type {
    CopilotItem,
    DownloadMetadata as EngineDownloadMetadata,
    FolderMappings,
    GitHubFileContent,
    GitHubFileEntry,
    PluginDownloadResult,
    PluginParseResult,
    RepositorySource,
    ToolCategory,
} from 'cmd-git-copilot-tools';

export {
    CATEGORY_DISPLAY,
    GitHubApiError,
    ORDERED_CATEGORIES,
} from 'cmd-git-copilot-tools';

/** Codicon shown for the items of each tool type in the tree view. */
export const CATEGORY_ICONS: Record<ToolCategory, string> = {
    agents: 'robot',
    cookbook: 'notebook',
    hooks: 'zap',
    instructions: 'book',
    plugins: 'package',
    prompts: 'lightbulb',
    skills: 'folder',
    workflows: 'file',
};
