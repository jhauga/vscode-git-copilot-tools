# Git Copilot Tools

A [Microsoft Visual Studio Code](https://code.visualstudio.com/) (*VS Code*) extension that allows you to browse, preview, and download GitHub Copilot customizations. The default repository is [github/awesome-copilot](https://github.com/github/awesome-copilot), but other repositories with VS Code Copilot `agent`, `cookbook`, `hook`, `instruction`, `plugin`, `prompt`, `skill`, and `workflow` tools can be used.

This tool is a slight variation of [timheuer/vscode-awesome-copilot](https://github.com/timheuer/vscode-awesome-copilot) VS Code extension.

<!--
## Install in VS Code

PENDING_APPROVAL
 -->

## Features

- **🔍 Browse**: Explore agents, cookbook, hooks, instructions, plugins, prompts, skills, and workflows in a convenient tree view
- **� Search**: Quickly find files with real-time filtering across all categories
- **📖 Preview**: View file content before downloading
- **⬇️ Download**: Save files to the matching `.github/` folders in your workspace, or to another folder chosen per repository
- **🔃 Refresh**: Update repository data with manual refresh
- **💾 Caching**: Smart caching for better performance

| Browse and Search | Cache Management, Download, Preview, and Refresh |
| --- | --- |
| ![Search Feature Demo](resources/searchFeature.gif) | <br>![features.png](/resources/features.png)<br> |

## How to Use

1. **Open the Extension**: Click the Activity Bar icon, or use the view under Explorer.
2. **Search Files**: Use the search bar at the top to filter files across all categories in real-time
3. **Browse Categories**: Expand Agents, Cookbook, Hooks, Instructions, Plugins, Prompts, Skills, or Workflows sections
4. **Preview Content**: Click the preview icon on any file to see its content
5. **Download Files**: Click the download icon to save files to your workspace
6. **Refresh Data**: Click the refresh icon in the view title to update repository data

## Folder Structure

Downloaded files are organized in your workspace as follows:

- **Agents**       → `.github/agents/`
- **Cookbook**     → `.github/cookbook/`
- **Hooks**        → `.github/hooks/`
- **Instructions** → `.github/instructions/`
- **Plugins**      → `.github/plugins/`
- **Prompts**      → `.github/prompts/`
- **Skills**       → `.github/skills/` (*entire folders with SKILL.md and supporting files*)
- **Workflows**    → `.github/workflows/`

These folders will be created automatically if they don't exist.

A repository's `aiFolder` property replaces `.github` for the tools downloaded from it. With `"aiFolder": ".claude"`, a skill from that repository is saved to `.claude/skills/`.

> [!NOTE]
> Plugins are unique in that downloading a plugin saves every agent, skill, hook, instruction, and prompt its manifest lists to the matching folders above, and saves the plugin's own files, such as its `README.md` and manifest, to `.github/plugins/<plugin>/`. The manifest is `plugin.json` at the root of the plugin folder, or `.github/plugin/plugin.json` in repositories that use the earlier layout. Copilot extensions listed by a plugin are not downloaded.

> [!NOTE]
> Skills are unique in that each skill is a complete folder containing a `SKILL.md` file and potentially other supporting files. When you download a skill, the entire folder structure is preserved.

## Custom Folder Mappings

Not all source repositories follow the default `.github/{category}` folder structure, and
may not have the correct names. The extension supports configuring custom folder-to-category
mappings per repository so you can browse and download content from any GitHub repository
regardless of its directory layout.

### Automatic Configuration via UI

When you add a new source repository through **Manage Sources > Add Repository** and none of
the standard category folders (`agents`, `cookbook`, `hooks`, `instructions`, `plugins`, `prompts`, `skills`, `workflows`) are
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
`vscode-git-copilot-tools.repositories` array. Each repository object accepts optional
`folderMappings`, `branch`, and `aiFolder` properties. `branch` pins content fetching to a
specific branch, tag, or commit SHA; when it is omitted the repository's default branch is used.
You can also paste a full GitHub tree URL (e.g. `https://github.com/<owner>/<repo>/tree/<branch>`)
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
| `agents` | `string \| string[] \| null` | Path to agents folder, `"root"`, an array of folders, or `null` to exclude |
| `cookbook` | `string \| string[] \| null` | Path to cookbook folder, `"root"`, an array of folders, or `null` to exclude |
| `hooks` | `string \| string[] \| null` | Path to hooks folder, `"root"`, an array of folders, or `null` to exclude |
| `instructions` | `string \| string[] \| null` | Path to instructions folder, `"root"`, an array of folders, or `null` to exclude |
| `plugins` | `string \| string[] \| null` | Path to plugins folder, `"root"`, an array of folders, or `null` to exclude |
| `prompts` | `string \| string[] \| null` | Path to prompts folder, `"root"`, an array of folders, or `null` to exclude |
| `skills` | `string \| string[] \| null` | Path to skills folder, `"root"`, an array of folders, or `null` to exclude |
| `workflows` | `string \| string[] \| null` | Path to workflows folder, `"root"`, an array of folders, or `null` to exclude |

#### Several Folders for One Category

A category can be read from several folders by mapping it to an array. The folders are
searched in the order listed, and `"."` or `"/"` in the array is the repository root. Items from
an array mapping are shown as `folder/name` in the tree view, and the root entry does not list
the other folders of the same array as tools. An empty array excludes the category, the same
as `null`.

```json
{
  "owner": "acme-corp",
  "repo": "copilot-skills",
  "folderMappings": {
    "skills": ["frontend", "backend", "."]
  }
}
```

#### Repository Properties

| Property | Type | Description |
|---|---|---|
| `branch` | `string` | Branch, tag, or commit SHA to read content from. When omitted the repository's default branch is used. |
| `aiFolder` | `string` | Folder that tools from this repository are saved under, relative to the workspace. When omitted, `.github` is used. Absolute paths are ignored. |

All properties are optional. Omitted mappings use the default category path.

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

**Repository whose tools are saved under `.claude`:**

```json
{
  "owner": "acme-corp",
  "repo": "copilot-tools",
  "aiFolder": ".claude"
}
```

## Configuration Reference

All settings are under the `vscode-git-copilot-tools` namespace and scoped to the application level.

| Setting | Type | Default | Description |
|---|---|---|---|
| `repositories` | `array` | See [docs/configuration.md](docs/configuration.md) | GitHub repositories used as content sources. Each entry supports `owner`, `repo`, `label`, `baseUrl`, `branch`, `aiFolder`, and `folderMappings`. |
| `enterpriseToken` | `string` | `""` | Personal Access Token for GitHub Enterprise sources. Sent only to sources with a `baseUrl`. |
| `cacheTimeout` | `number` | `3600000` | How long repository listings are cached, in milliseconds (1 hour). Min 60000, max 86400000. |
| `autoRefresh` | `boolean` | `false` | Automatically refresh content on VS Code startup. |
| `showTreeView` | `boolean` | `true` | Show/hide the tree view in the Explorer panel. |
| `allowInsecureEnterpriseCerts` | `boolean` | `false` | Skip TLS certificate validation for GitHub Enterprise servers. Requests to github.com always validate certificates. |
| `enableGithubAuth` | `boolean` | `true` | Use VS Code's GitHub sign-in for github.com sources to increase API rate limits (60 to 5,000 req/hr). |
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
- The [`cmd-git-copilot-tools`](https://www.npmjs.com/package/cmd-git-copilot-tools) engine for GitHub requests, folder mapping, and downloads
- ESBuild for bundling

### Engine

Fetching, folder mapping, downloads, and plugin handling come from
[`cmd-git-copilot-tools`](https://www.npmjs.com/package/cmd-git-copilot-tools), the engine behind
the command-line tool of the same name. This extension keeps its own views, settings, sign-in,
and prompts, and passes the sources, settings, and GitHub token to the engine on every call:

```typescript
import { downloadItem, fetchCategory } from 'cmd-git-copilot-tools';

const source = { owner: 'acme-corp', repo: 'copilot-tools', aiFolder: '.claude' };
const skills = await fetchCategory(source, 'skills', token, cacheTimeout);
await downloadItem(skills[0], workspaceFolder, token, { targetName: 'my-skill' });
```

Engine changes are made in the engine repository and published to npm. `package.json` pins an
exact engine version, and each engine release reaches this extension as a dependency update.

To try an engine change before it is published, pack the engine and install the package without
changing the pin:

```bash
cd ../cmd-git-copilot-tools
npm pack
cd ../vscode-git-copilot-tools
npm install --no-save ../cmd-git-copilot-tools/cmd-git-copilot-tools-<version>.tgz
```

### Building

```bash
npm install
npm run compile
```

### Testing

```bash
npm run test
```

Tests run in a VS Code test host. The engine's own test suites run in the engine repository.

## UI Placement / Custom View Container

The extension contributes a custom Activity Bar view container named **Git Copilot Tools**.
If you prefer to move or hide it:

- Right-click the Activity Bar to toggle visibility.
- Drag the view into a different location if desired (VS Code will persist your layout).

**Enjoy browsing and using awesome GitHub Copilot customizations tools!**

## License

MIT
