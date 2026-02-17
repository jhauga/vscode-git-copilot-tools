/**
 * Types and interfaces for the Awesome Copilot Browser extension
 */


// Represents a file in a GitHub repo
export interface GitHubFile {
    name: string;
    path: string;
    download_url: string;
    size: number;
    type: 'file' | 'dir';
    sha?: string; // Git SHA hash from GitHub API
    repo?: RepoSource; // Optional: which repo this file comes from
    displayName?: string; // For handling duplicate filenames across repos
}


// Per-repository folder mapping: maps each category to a custom folder path, 'root', or null (excluded)
export type FolderMapping = Partial<Record<CopilotCategory, string | null>>;

// Represents a GitHub repo source
export interface RepoSource {
    owner: string;
    repo: string;
    label?: string;
    baseUrl?: string; // For GitHub Enterprise: https://github.wdf.sap.corp
    folderMappings?: FolderMapping; // Custom folder-to-category mapping for this repo
}

export interface CopilotItem {
    id: string;
    name: string;
    category: CopilotCategory;
    file: GitHubFile;
    content?: string;
    repo: RepoSource;
}

export enum CopilotCategory {
    Plugins = 'plugins',
    Instructions = 'instructions',
    Prompts = 'prompts',
    Agents = 'agents',
    Skills = 'skills'
}


// Cache per repo+category
export interface CacheEntry {
    data: GitHubFile[];
    timestamp: number;
    category: CopilotCategory;
    repo: RepoSource;
}

export const CATEGORY_LABELS: Record<CopilotCategory, string> = {
    [CopilotCategory.Plugins]: 'Plugins',
    [CopilotCategory.Instructions]: 'Instructions',
    [CopilotCategory.Prompts]: 'Prompts',
    [CopilotCategory.Agents]: 'Agents',
    [CopilotCategory.Skills]: 'Skills'
};

export const FOLDER_PATHS: Record<CopilotCategory, string> = {
    [CopilotCategory.Plugins]: '.github/plugins',
    [CopilotCategory.Instructions]: '.github/instructions',
    [CopilotCategory.Prompts]: '.github/prompts',
    [CopilotCategory.Agents]: '.github/agents',
    [CopilotCategory.Skills]: '.github/skills'
};

// Path to plugin.json within a plugin directory
export const PLUGIN_JSON_RELATIVE_PATH = '.github/plugin/plugin.json';

// Map plugin item "kind" values to CopilotCategory for local save paths
export const KIND_TO_CATEGORY: Record<string, CopilotCategory> = {
    'instruction': CopilotCategory.Instructions,
    'prompt': CopilotCategory.Prompts,
    'agent': CopilotCategory.Agents,
    'skill': CopilotCategory.Skills,
};

// Plugin metadata structure from plugin.json files
export interface PluginMetadata {
    id?: string;
    name: string;
    description: string;
    version?: string;
    author?: { name: string };
    repository?: string;
    license?: string;
    featured?: boolean;
    tags?: string[];
    items: PluginItem[];
    display?: {
        ordering?: 'alpha' | 'custom' | 'manual';
        show_badge?: boolean;
    };
}

export interface PluginItem {
    path: string;
    kind: 'instruction' | 'prompt' | 'agent' | 'skill';
}

export interface PluginParseResult {
    metadata: PluginMetadata;
    rawContent: string;
}

/**
 * Resolve the API content path for a given category and repo source.
 * Returns the folder path to query, or null if the category is excluded.
 * When the mapping is 'root', returns an empty string (repo root).
 */
export function resolveContentPath(repo: RepoSource, category: CopilotCategory): string | null {
    if (repo.folderMappings) {
        const mapping = repo.folderMappings[category];
        if (mapping === null) {
            // Explicitly excluded
            return null;
        }
        if (mapping === 'root') {
            // Entire repo root is this category's source
            return '';
        }
        if (typeof mapping === 'string' && mapping.trim() !== '') {
            // Custom folder path
            return mapping.trim();
        }
    }
    // Default: use the standard category name as path
    return category;
}
