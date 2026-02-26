# Git Copilot Tools

A [Microsoft Visual Studio Code](https://code.visualstudio.com/) (*VS Code*) extension that allows you to browse, preview, and download GitHub Copilot customizations. The default repository is [github/awesome-copilot](https://github.com/github/awesome-copilot), but other repositories with VS Code Copilot `agent`, `instruction`, `plugin`, `prompt`, and `skill` tools can be used.

This tool is a slight variation of [timheuer/vscode-awesome-copilot](https://github.com/timheuer/vscode-awesome-copilot) VS Code extension.

<!--
## Install in VS Code

PENDING_APPROVAL
 -->

## Features

- **🔍 Browse**: Explore agents, instructions, plugins, prompts, and skills in a convenient tree view
- **� Search**: Quickly find files with real-time filtering across all categories
- **📖 Preview**: View file content before downloading
- **⬇️ Download**: Save files to appropriate `.github/` folders in your workspace
- **🔃 Refresh**: Update repository data with manual refresh
- **💾 Caching**: Smart caching for better performance

| Browse and Search | Cache Management, Download, Preview, and Refresh |
| --- | --- |
| ![Search Feature Demo](resources/searchFeature.gif) | <br>![features.png](/resources/features.png)<br> |

## How to Use

1. **Open the Extension**: Click the Activity Bar icon, or use the view under Explorer.
2. **Search Files**: Use the search bar at the top to filter files across all categories in real-time
3. **Browse Categories**: Expand Plugins, Instructions, Prompts, Agents, or Skills sections
4. **Preview Content**: Click the preview icon on any file to see its content
5. **Download Files**: Click the download icon to save files to your workspace
6. **Refresh Data**: Click the refresh icon in the view title to update repository data

## Folder Structure

Downloaded files are organized in your workspace as follows:

- **Agents**  → `.github/agents/`
- **Instructions** → `.github/instructions/`
- **Plugins**      → `.github/plugins/`
- **Prompts** → `.github/prompts/`
- **Skills**  → `.github/skills/` (*entire folders with SKILL.md and supporting files*)

These folders will be created automatically if they don't exist.

> [!NOTE]
> Plugins are unique in that each plugin will download a collection of items from the plugin's `<plugin>/.github/plugin/plugin.json` file, and download the corresponding items to the workspace `.github` folder accordingly.

> [!NOTE]
> Skills are unique in that each skill is a complete folder containing a `SKILL.md` file and potentially other supporting files. When you download a skill, the entire folder structure is preserved.

## Custom Folder Mappings

Not all source repositories follow the default `.github/{category}` folder structure, and
may not have the correct names. The extension supports configuring custom folder-to-category
mappings per repository so you can browse and download content from any GitHub repository
regardless of its directory layout.

### Automatic Configuration via UI

When you add a new source repository through **Manage Sources > Add Repository** and none of
the standard category folders (`agents`, `instructions`, `plugins`, `prompts`, `skills`) are
found, the extension thows message box that will allow you to opens a configuration panel
where you can manually map repository folders to categories.

The panel shows one input field per category. For each category you can enter:

| Input Value | Behavior |
|---|---|
| *(blank)* | Uses the default path (`.github/{category}`) |
| `root` | Treats the entire repository root as this category's source. **All other categories are disabled.** |
| `null` | Explicitly excludes this category (it will not appear in the tree view) |
| Any other path | Custom folder path within the repository (e.g., `src/my-prompts`, `copilot/instructions`) |

> [!IMPORTANT]
> If any category is set to `root`, all other category inputs are disabled because the entire
> repository is treated as a single content source.

### Manual Configuration via Settings

Folder mappings can also be set directly in VS Code `settings.json` under the
`vscode-git-copilot-tools.repositories` array. Each repository object accepts an optional
`folderMappings` property and an optional `branch` property to pin content fetching to a
specific branch, tag, or commit SHA. When `branch` is omitted the repository's default branch
is used. You can also paste a full GitHub tree URL (e.g. `https://github.com/<owner>/<repo>/tree/<branch>`)
into **Manage Sources > Add Repository** and the branch will be extracted automatically.

```json
{
  "vscode-git-copilot-tools.repositories": [
    {
      "owner": "example",
      "repo": "my-skills",
      "folderMappings": {
        "skills": "root",
        "agents": null,
        "instructions": null,
        "plugins": null,
        "prompts": null
      }
    }
  ]
}
```

#### `folderMappings` Property Reference

| Property | Type | Description |
|---|---|---|
| `agents` | `string \| null` | Path to agents folder, `"root"`, or `null` to exclude |
| `instructions` | `string \| null` | Path to instructions folder, `"root"`, or `null` to exclude |
| `plugins` | `string \| null` | Path to plugins folder, `"root"`, or `null` to exclude |
| `prompts` | `string \| null` | Path to prompts folder, `"root"`, or `null` to exclude |
| `skills` | `string \| null` | Path to skills folder, `"root"`, or `null` to exclude |

#### Repository `branch` Property

| Property | Type | Description |
|---|---|---|
| `branch` | `string` | Branch, tag, or commit SHA to read content from. When omitted the repository's default branch is used. |

All properties are optional. Omitted properties use the default category path.

### Examples

**Repository with all prompts at its root:**

```json
{
  "owner": "myorg",
  "repo": "copilot-prompts",
  "folderMappings": {
    "prompts": "root"
  }
}
```

**Repository with a custom directory layout:**

```json
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
```

**Standard repository (no `folderMappings` needed):**

```json
{
  "owner": "github",
  "repo": "awesome-copilot"
}
```

**Repository pinned to a specific branch:**

```json
{
  "owner": "myorg",
  "repo": "copilot-config",
  "branch": "dev"
}
```

## Configuration Reference

All settings are under the `vscode-git-copilot-tools` namespace and scoped to the application level.

| Setting | Type | Default | Description |
|---|---|---|---|
| `repositories` | `array` | See [docs/configuration.md](docs/configuration.md) | GitHub repositories used as content sources. Each entry supports `owner`, `repo`, `label`, `baseUrl`, `branch`, and `folderMappings`. |
| `enterpriseToken` | `string` | `""` | Personal Access Token for GitHub Enterprise authentication. |
| `cacheTimeout` | `number` | `3600000` | Cache duration in milliseconds (1 hour). Min 60000, max 86400000. |
| `autoRefresh` | `boolean` | `false` | Automatically refresh content on VS Code startup. |
| `showTreeView` | `boolean` | `true` | Show/hide the tree view in the Explorer panel. |
| `allowInsecureEnterpriseCerts` | `boolean` | `false` | Allow insecure TLS certificates for Enterprise GitHub servers. |
| `enableGithubAuth` | `boolean` | `true` | Enable GitHub OAuth to increase API rate limits (60 to 5,000 req/hr). |
| `logLevel` | `string` | `"info"` | Log level: `error`, `warn`, `info`, `debug`, or `trace`. |
| `checkForUpdates` | `boolean` | `true` | Check for updates to downloaded items and show notifications. |

## Requirements

- VS Code version 1.103.0 or higher
- Internet connection to fetch repository data
- A workspace folder open in VS Code (for downloads)

## Extension Commands

- `Refresh`: Update repository data from GitHub
- `Download`: Save a file to your workspace
- `Preview`: View file content in VS Code

---

## Development

This extension was built with:

- TypeScript
- VS Code Extension API
- Axios for HTTP requests
- ESBuild for bundling

### Building

```bash
npm install
npm run compile
```

### Testing

```bash
npm run test
```

## UI Placement / Custom View Container

The extension contributes a custom Activity Bar view container named **Git Copilot Tools**.
If you prefer to move or hide it:

- Right-click the Activity Bar to toggle visibility.
- Drag the view into a different location if desired (VS Code will persist your layout).

**Enjoy browsing and using awesome GitHub Copilot customizations tools!**

## License

MIT
