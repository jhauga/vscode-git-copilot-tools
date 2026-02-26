# VSCODE `git` Copilot Tools TODO

- [x] Add issue, asking permission to publish variation of [jhauga/vscode-git-copilot-tools](https://github.com/jhauga/vscode-git-copilot-tools/issues) when marketplace ready
- [x] Remove cloned repository breadcrumbs
- [x] Update documentation
  - Specify variation features simulaities to clone, and differences
- [x] Update graphics

## Extension Base

Keeping core functionality add additionaly features that allow more customization, and tools to be downloaded for use with GitHub Copilot.

- [x] Assign custom types for folders from the source repository that will be mapped and downloaded according to the cloned repo from [jhauga/vscode-awesome-copilo](https://github.com/jhauga/vscode-git-copilot-tools)
- [x] Configure source folders by assigning a type of either: `agents`, `instructions`, `plugins`, `prompts`, or `skills`; to a source folder, then mimic current behaviour

## Features

### Major Features

- [ ] **Custom Download Behaviour** - Extension configuration to specify where and how to download tools
  - [ ] Refactor existing download functions into reusable, configurable components for a custom UI
    - [ ] Keep UI/UX simple with strict constraints to prevent unexpected downloads
  - [ ] Allow user to specify target folder(s) for downloaded tools
  - [ ] Allow user to map tool metadata (name, description, version, etc.)
  - [ ] Add **configuration types** to categorize settings:
    - `config-download-folder` - where tools are saved
    - `config-tool` - tool-specific settings
    - `config-data` - data/metadata handling
    - `config-support` - supporting file settings
  - [ ] Add **download mode types** to control download behavior:
    - `config-folder` - folder-level settings
    - `config-download` - download action settings
  - [ ] Implement folder naming using configuration types:
    - [ ] **Single-file download mode** - For downloading individual files
      - Example: downloading `fix-bugs.instructions.md` from the Instructions folder
    - [ ] **Multi-file download mode** - For downloading folders with multiple files
      - Used when a tool has supporting files (assets, references, scripts)
      - Example: downloading a skill folder that includes `SKILL.md` plus a `references/` subfolder
      - User can configure: subfolder naming, subfolder location, how to handle each file type
  - [ ] Classify files in a tool's folder by type:
    - **Tool types** (main files): `agent`, `instruction`, `plugin`, `prompt`, `skill`
    - **Data types** (metadata files): `mapping-data`, `metadata`, `readme`
      - Note: `mapping-data` refers to file path information (can be a single line)
    - **Support types** (helper files): `asset`, `reference`, `script`
  - [ ] Write tests for custom download behaviour using preset configurations
- [ ] **Bulk operations** - Allow users to select and download multiple items at once with checkboxes
- [ ] **Favorites/bookmarking system** - Let users star frequently used items with auto-update on new versions
- [ ] **Local file management** - Show downloaded items in tree view with ability to delete/manage from extension

### New Download Tools

- [ ] **`cookbook` and recipe downloading** - Download Copilot **Cookbook** tools and/or recipes
- [ ] **`hooks`** - Download Copilot **Hooks** or automated workflows
- [ ] **`agentic-workflow`** - Download Copilot **Agentic Workflows** to run coding agents in actions

### Minor Features

- [ ] **Enhanced search with sorting** - Sort results by name, category, size, or date
- [ ] **Markdown preview rendering** - Render .md files with proper formatting in preview panel
- [ ] **One-click "Update All"** - Single command to update all items with newer versions available
- [ ] **Inline quick actions in tree view** - Add context menu shortcuts for common operations
- [ ] **Download history/statistics** - Track and display download analytics

## Improvements

### Major Improvements

- [ ] **Offline mode with cached data** - Allow browsing and using cached items when offline
- [ ] **Offline mode with local tools** - Allow local folders to mapped to source and downloaded per workspace
- [ ] **Visual configuration UI** - Replace JSON editing with GUI for repository and folder mapping management

### Minor Improvements

- [ ] **Side-by-side diff view** - Show differences when items have updates available
- [ ] **Advanced filtering UI** - Filter by repository, category, or size range
- [ ] **Progressive loading** - Display cached items immediately while fetching updates in background
- [ ] **File info panel** - Show size, modification date, and source repository for items
- [ ] **Smart cache invalidation** - Implement more intelligent cache refresh strategies
