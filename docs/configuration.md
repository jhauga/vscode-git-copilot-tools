# Configuration Guide

This document provides a comprehensive reference for all configuration options available in the
Git Copilot Tools VS Code extension.

## Extension Settings

All settings live under the `vscode-git-copilot-tools` namespace in VS Code settings. They are scoped to
the application level (global, not per-workspace).

### `vscode-git-copilot-tools.repositories`

**Type:** `array`
**Default:**

```json
[
  {
    "owner": "github",
    "repo": "vscode-git-copilot-tools",
    "label": "Git Copilot Tools"
  }
]
```

An array of GitHub repository sources to browse content from. Each entry is an object with the
following properties:

| Property | Type | Required | Description |
|---|---|---|---|
| `owner` | `string` | Yes | GitHub repository owner (user or organization) |
| `repo` | `string` | Yes | GitHub repository name |
| `label` | `string` | No | Display name shown in the tree view |
| `baseUrl` | `string` | No | GitHub Enterprise Server base URL (e.g., `https://github.example.com`) |
| `branch` | `string` | No | Branch, tag, or commit SHA to read content from. The repository's default branch is used when omitted. |
| `aiFolder` | `string` | No | Folder that tools from this repository are saved under, relative to the workspace (see below). Default: `.github` |
| `folderMappings` | `object` | No | Custom folder-to-category mappings (see below) |

#### `folderMappings`

When a source repository does not use the default folder layout, you can configure custom
paths for each content category. If omitted, the extension uses the standard category name
as the folder path (e.g., `agents`, `instructions`, `plugins`, `prompts`, `skills`).

Each property in `folderMappings` corresponds to a content category:

| Property | Type | Description |
|---|---|---|
| `agents` | `string \| string[] \| null` | Path to agents content, `"root"`, an array of folders, or `null` to exclude |
| `cookbook` | `string \| string[] \| null` | Path to cookbook content, `"root"`, an array of folders, or `null` to exclude |
| `hooks` | `string \| string[] \| null` | Path to hooks content, `"root"`, an array of folders, or `null` to exclude |
| `instructions` | `string \| string[] \| null` | Path to instructions content, `"root"`, an array of folders, or `null` to exclude |
| `plugins` | `string \| string[] \| null` | Path to plugins content, `"root"`, an array of folders, or `null` to exclude |
| `prompts` | `string \| string[] \| null` | Path to prompts content, `"root"`, an array of folders, or `null` to exclude |
| `skills` | `string \| string[] \| null` | Path to skills content, `"root"`, an array of folders, or `null` to exclude |
| `workflows` | `string \| string[] \| null` | Path to workflows content, `"root"`, an array of folders, or `null` to exclude |

**Special values:**

- `"root"` - The entire repository root is treated as the source for this category. When any
  category is set to `root`, all other categories are effectively disabled because the root
  contains a single type of content.
- `null` - The category is excluded entirely. It will not appear in the tree view and no API
  requests will be made for it.
- An array of folders - The category is read from each folder in the order listed. `"."` or `"/"`
  in the array is the repository root, and the root entry does not list the other folders of the
  same array as tools. Items are shown as `folder/name` in the tree view. An empty array excludes
  the category, the same as `null`.
- *(omitted)* - Uses the default path, which is the category name (e.g., `prompts`).

**Example: Standard repository (no custom mappings needed)**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "github",
      "repo": "awesome-copilot"
    }
  ]
}
```

**Example: Repository with all prompts at its root**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "myorg",
      "repo": "copilot-prompts",
      "folderMappings": {
        "prompts": "root"
      }
    }
  ]
}
```

**Example: Repository with a custom directory structure**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "myorg",
      "repo": "copilot-config",
      "folderMappings": {
        "instructions": "copilot/instructions",
        "prompts": "copilot/prompts",
        "agents": "copilot/agents",
        "plugins": null,
        "skills": null
      }
    }
  ]
}
```

**Example: Skills spread across several folders**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "acme-corp",
      "repo": "copilot-skills",
      "folderMappings": {
        "skills": ["frontend", "backend", "."]
      }
    }
  ]
}
```

**Example: GitHub Enterprise repository**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "team",
      "repo": "copilot-tools",
      "label": "Internal Tools",
      "baseUrl": "https://github.example.com"
    }
  ]
}
```

**Example: Multiple sources**

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "github",
      "repo": "vscode-git-copilot-tools",
      "label": "Git Copilot Tools"
    },
    {
      "owner": "myorg",
      "repo": "internal-prompts",
      "label": "Internal Prompts",
      "folderMappings": {
        "prompts": "root"
      }
    }
  ]
}
```

#### `aiFolder`

The folder that tools from a repository are saved under, relative to the workspace folder. When
omitted, tools are saved under `.github`. The category folders keep their names inside it.

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "acme-corp",
      "repo": "copilot-tools",
      "aiFolder": ".claude"
    }
  ]
}
```

With this source, a skill is saved to `.claude/skills/<skill>/` and an agent to
`.claude/agents/<agent>`. Absolute paths, such as `C:\Users\demo-user\ai` or `/opt/ai`, are
ignored and `.github` is used instead, so downloads always stay inside the workspace.

---

### `vscode-git-copilot-tools.enterpriseToken`

**Type:** `string`
**Default:** `""`

Personal Access Token for authenticating with GitHub Enterprise Server. Required when browsing
content from an Enterprise GitHub instance. The token is sent only to sources that have a
`baseUrl`.

**Required token permissions:** `repo`, `read:org`, `read:user`

Create a token at: `https://your-github-enterprise.com/settings/tokens`

---

### `vscode-git-copilot-tools.cacheTimeout`

**Type:** `number`
**Default:** `3600000` (1 hour)
**Minimum:** `60000` (1 minute)
**Maximum:** `86400000` (24 hours)

Duration (in milliseconds) to cache repository data before re-fetching from GitHub. Lower
values provide fresher data but consume more API requests.

---

### `vscode-git-copilot-tools.autoRefresh`

**Type:** `boolean`
**Default:** `false`

When enabled, the extension automatically refreshes content from all configured repositories
on VS Code startup.

---

### `vscode-git-copilot-tools.showTreeView`

**Type:** `boolean`
**Default:** `true`

Show or hide the Git Copilot Tools tree view in the Explorer panel. The Activity Bar view is
always available.

---

### `vscode-git-copilot-tools.allowInsecureEnterpriseCerts`

**Type:** `boolean`
**Default:** `false`

> **Security Warning:** This setting disables TLS certificate validation for Enterprise GitHub
> servers only. Only enable for trusted enterprise environments with self-signed certificates.

When enabled, the extension will accept self-signed or untrusted TLS certificates when
communicating with Enterprise GitHub servers. Public GitHub (github.com) is unaffected. Changes
take effect immediately.

---

### `vscode-git-copilot-tools.enableGithubAuth`

**Type:** `boolean`
**Default:** `true`

Enable GitHub authentication via VS Code's built-in GitHub OAuth provider. This increases API
rate limits from 60 requests/hour (unauthenticated) to 5,000 requests/hour (authenticated).

The session is used only for github.com sources; GitHub Enterprise sources use
`enterpriseToken`. When no session exists, the extension offers sign-in once per VS Code
session, and again when GitHub refuses a request that signing in would allow.

---

### `vscode-git-copilot-tools.logLevel`

**Type:** `string`
**Default:** `"info"`
**Options:** `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"`

Controls the verbosity of log output in the Output panel.

| Level | Description |
|---|---|
| `error` | Only error messages |
| `warn` | Warnings and errors |
| `info` | Informational messages, warnings, and errors |
| `debug` | Debug information and all above |
| `trace` | All logging including detailed trace information |

---

### `vscode-git-copilot-tools.checkForUpdates`

**Type:** `boolean`
**Default:** `true`

When enabled, the extension checks whether downloaded items have newer versions available in
the source repository. Items with updates show **Update Available** in the tree view.

## Download Folder Structure

Downloaded content is saved to the workspace under the following paths:

| Category | Local Path |
|---|---|
| Agents | `.github/agents` |
| Cookbook | `.github/cookbook` |
| Hooks | `.github/hooks` |
| Instructions | `.github/instructions` |
| Plugins | `.github/plugins` |
| Prompts | `.github/prompts` |
| Skills | `.github/skills` |
| Workflows | `.github/workflows` |

Folders are created automatically if they do not exist. `folderMappings` only control where
content is fetched *from*. Where it is saved is set per repository by `aiFolder`, which replaces
`.github` in these paths.

Downloading a plugin saves each agent, skill, hook, instruction, and prompt its manifest lists
to the folders above, and saves the plugin's own files to `plugins/<plugin>/`. The manifest is
`plugin.json` at the root of the plugin folder, or `.github/plugin/plugin.json` in repositories
that use the earlier layout. Copilot extensions listed by a plugin are not downloaded.

## Installing Hooks

Hook configuration files downloaded from a source repository are saved to `.github/hooks/`
in your workspace. To activate hooks in your own repository:

1. Copy the hook folder to your repository's `.github/hooks/` directory.
2. Ensure any bundled scripts are executable (`chmod +x script.sh`).
3. Commit and merge the changes to the repository's default branch.

Each hook file is a JSON document named `<description>.json` and must include
`"version": 1` at the top level along with a `hooks` object containing one or more
trigger keys (`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`,
`postToolUse`, `errorOccurred`). See the
[GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
for the full schema.

## Configuring Folder Mappings via the UI

When adding a repository that does not contain any of the standard category folders, the
extension opens a webview panel titled **Specify Path to Folders**. The panel provides one
input field for each of the eight categories, and each field takes one folder. To read a
category from several folders, set an array for it in `folderMappings` in `settings.json`.

**Input rules:**

| Value | Effect |
|---|---|
| *(empty)* | Uses the default category path |
| `root` | Treats the entire repo root as this category. All other inputs are disabled. |
| `null` | Excludes this category (no content fetched, not shown in tree) |
| Custom path | Fetches content from the specified folder within the repository |

After saving, the mappings are persisted in the `vscode-git-copilot-tools.repositories` setting and
applied on every subsequent data fetch.
