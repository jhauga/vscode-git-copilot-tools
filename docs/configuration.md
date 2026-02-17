# Configuration Guide

This document provides a comprehensive reference for all configuration options available in the
Awesome Copilot (clone) VS Code extension.

## Extension Settings

All settings live under the `awesome-copilot` namespace in VS Code settings. They are scoped to
the application level (global, not per-workspace).

### `awesome-copilot.repositories`

**Type:** `array`
**Default:**

```json
[
  {
    "owner": "github",
    "repo": "awesome-copilot",
    "label": "Awesome Copilot (clone)"
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
| `folderMappings` | `object` | No | Custom folder-to-category mappings (see below) |

#### `folderMappings`

When a source repository does not use the default folder layout, you can configure custom
paths for each content category. If omitted, the extension uses the standard category name
as the folder path (e.g., `plugins`, `instructions`, `prompts`, `agents`, `skills`).

Each property in `folderMappings` corresponds to a content category:

| Property | Type | Description |
|---|---|---|
| `agents` | `string \| null` | Path to agents content, `"root"`, or `null` to exclude |
| `instructions` | `string \| null` | Path to instructions content, `"root"`, or `null` to exclude |
| `plugins` | `string \| null` | Path to plugins content, `"root"`, or `null` to exclude |
| `prompts` | `string \| null` | Path to prompts content, `"root"`, or `null` to exclude |
| `skills` | `string \| null` | Path to skills content, `"root"`, or `null` to exclude |

**Special values:**

- `"root"` - The entire repository root is treated as the source for this category. When any
  category is set to `root`, all other categories are effectively disabled because the root
  contains a single type of content.
- `null` - The category is excluded entirely. It will not appear in the tree view and no API
  requests will be made for it.
- *(omitted)* - Uses the default path, which is the category name (e.g., `prompts`).

**Example: Standard repository (no custom mappings needed)**

```json
{
  "awesome-copilot.repositories": [
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
  "awesome-copilot.repositories": [
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
  "awesome-copilot.repositories": [
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

**Example: GitHub Enterprise repository**

```json
{
  "awesome-copilot.repositories": [
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
  "awesome-copilot.repositories": [
    {
      "owner": "github",
      "repo": "awesome-copilot",
      "label": "Awesome Copilot"
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

---

### `awesome-copilot.enterpriseToken`

**Type:** `string`
**Default:** `""`

Personal Access Token for authenticating with GitHub Enterprise Server. Required when browsing
content from an Enterprise GitHub instance.

**Required token permissions:** `repo`, `read:org`, `read:user`

Create a token at: `https://your-github-enterprise.com/settings/tokens`

---

### `awesome-copilot.cacheTimeout`

**Type:** `number`
**Default:** `3600000` (1 hour)
**Minimum:** `60000` (1 minute)
**Maximum:** `86400000` (24 hours)

Duration (in milliseconds) to cache repository data before re-fetching from GitHub. Lower
values provide fresher data but consume more API requests.

---

### `awesome-copilot.autoRefresh`

**Type:** `boolean`
**Default:** `false`

When enabled, the extension automatically refreshes content from all configured repositories
on VS Code startup.

---

### `awesome-copilot.showTreeView`

**Type:** `boolean`
**Default:** `true`

Show or hide the Awesome Copilot tree view in the Explorer panel. The Activity Bar view is
always available.

---

### `awesome-copilot.allowInsecureEnterpriseCerts`

**Type:** `boolean`
**Default:** `false`

> **Security Warning:** This setting disables TLS certificate validation for Enterprise GitHub
> servers only. Only enable for trusted enterprise environments with self-signed certificates.

When enabled, the extension will accept self-signed or untrusted TLS certificates when
communicating with Enterprise GitHub servers. Public GitHub (github.com) is unaffected.

---

### `awesome-copilot.enableGithubAuth`

**Type:** `boolean`
**Default:** `true`

Enable GitHub authentication via VS Code's built-in GitHub OAuth provider. This increases API
rate limits from 60 requests/hour (unauthenticated) to 5,000 requests/hour (authenticated).

The extension will prompt for sign-in when authentication is needed.

---

### `awesome-copilot.logLevel`

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

### `awesome-copilot.checkForUpdates`

**Type:** `boolean`
**Default:** `true`

When enabled, the extension checks whether downloaded items have newer versions available in
the source repository. Items with updates are indicated with a cloud-download icon in the
tree view.

## Download Folder Structure

Downloaded content is saved to the workspace under the following paths:

| Category | Local Path |
|---|---|
| Plugins | `.github/plugins` |
| Instructions | `.github/instructions` |
| Prompts | `.github/prompts` |
| Agents | `.github/agents` |
| Skills | `.github/skills` |

Folders are created automatically if they do not exist. The local save paths are fixed
regardless of any custom `folderMappings` configured for the source repository;
`folderMappings` only control where content is fetched *from*, not where it is saved.

## Configuring Folder Mappings via the UI

When adding a repository that does not contain any of the standard category folders, the
extension opens a webview panel titled **Specify Path to Folders**. The panel provides one
input field per category.

**Input rules:**

| Value | Effect |
|---|---|
| *(empty)* | Uses the default category path |
| `root` | Treats the entire repo root as this category. All other inputs are disabled. |
| `null` | Excludes this category (no content fetched, not shown in tree) |
| Custom path | Fetches content from the specified folder within the repository |

After saving, the mappings are persisted in the `awesome-copilot.repositories` setting and
applied on every subsequent data fetch.
