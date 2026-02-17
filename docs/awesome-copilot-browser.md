# Feature Specification: Awesome GitHub Copilot Browser

## Overview

A VS Code extension that provides an explorer view to browse, preview, and download GitHub Copilot customizations (plugins, instructions, prompts, agents, and skills) from configurable GitHub repositories. Users can filter items by filename, preview content, and selectively download files to their workspace with proper GitHub Copilot folder structure. Repositories with non-standard folder layouts can be configured through custom folder-to-category mappings.

## User Journey

1. **Open Explorer View**: User opens the "Awesome Copilot" view in the VS Code Activity Bar
2. **Browse Categories**: User sees five expandable sections: Plugins, Instructions, Prompts, Agents, and Skills
3. **Search Content**: User types in search bar to filter items across all categories by filename in real-time
4. **Preview Item**: User clicks on an item to see name and content preview
5. **Select for Download**: User clicks download button on desired item
6. **Confirm Download**: System prompts user to confirm download location and filename
7. **File Downloaded**: Item is saved to appropriate `.github/` folder structure in current workspace

## Functional Requirements

1. **FR-01**: Explorer View Integration
   - **Description**: Display a new tree view in VS Code Activity Bar titled "Awesome Copilot"
   - **Acceptance Criteria**:
     - [x] Tree view appears in Activity Bar with a dedicated view container
     - [x] View shows five main categories: Plugins, Instructions, Prompts, Agents, and Skills
     - [x] Each category is expandable/collapsible
     - [x] View persists across VS Code sessions

2. **FR-02**: Repository Data Fetching
   - **Description**: Fetch file listings from configurable GitHub repositories
   - **Acceptance Criteria**:
     - [x] Extension fetches files from plugins/, instructions/, prompts/, agents/, and skills/ folders
     - [x] Data is cached locally for performance
     - [x] Manual refresh button updates cached data
     - [x] Graceful error handling for network failures
     - [x] Support for multiple repository sources
     - [x] Support for GitHub Enterprise with custom tokens

3. **FR-03**: File Search
   - **Description**: Search bar at top of view to filter files across all categories by filename
   - **Acceptance Criteria**:
     - [x] Search bar appears at top of tree view
     - [x] Typing filters files in real-time based on filename match across all categories
     - [x] Search is case-insensitive
     - [x] Clear search button resets to show all files
     - [x] Search results maintain category structure

4. **FR-04**: Content Preview
   - **Description**: Display filename and content preview when item is selected
   - **Acceptance Criteria**:
     - [x] Clicking item shows preview pane with content
     - [x] Preview shows first 10-15 lines of file content
     - [x] Preview handles markdown formatting appropriately
     - [x] Preview includes full filename and file size

5. **FR-05**: Download Functionality
   - **Description**: Download selected files to appropriate workspace folders
   - **Acceptance Criteria**:
     - [x] Download button/icon appears for each file item
     - [x] Plugins save to `.github/plugins/`
     - [x] Instructions save to `.github/instructions/`
     - [x] Prompts save to `.github/prompts/`
     - [x] Agents save to `.github/agents/`
     - [x] Skills save to `.github/skills/`
     - [x] Creates folders if they don't exist

6. **FR-06**: Download Confirmation
   - **Description**: Prompt user before downloading to confirm action and allow filename changes
   - **Acceptance Criteria**:
     - [x] Modal dialog shows before download with filename and destination
     - [x] User can modify filename before confirming
     - [x] Warning if file with same name already exists
     - [x] Option to overwrite or rename existing files

7. **FR-07**: Status and Feedback
   - **Description**: Provide user feedback during operations
   - **Acceptance Criteria**:
     - [x] Loading indicator while fetching repository data
     - [x] Success notification after successful download
     - [x] Error messages for failed operations
     - [x] Progress indication for multiple downloads

8. **FR-08**: Custom Folder Mappings
   - **Description**: Configure custom folder-to-category mappings for repositories with non-standard layouts
   - **Acceptance Criteria**:
     - [x] When adding a repo with no standard folders, extension prompts to configure mappings
     - [x] Webview panel shows one input per category (agents, instructions, plugins, prompts, skills)
     - [x] Support `root` value to treat repo root as a single category source
     - [x] Support `null` value to exclude a category
     - [x] Support custom folder paths (e.g., `src/my-prompts`)
     - [x] When `root` is entered for one category, all other category inputs are disabled
     - [x] Mappings are persisted in VS Code settings alongside repository configuration
     - [x] API queries use resolved content paths based on folder mappings
     - [x] Categories mapped to `null` return empty results without errors

## Non-Functional Requirements

- **Performance**: Initial load should complete within 10 seconds on normal internet connection
- **Reliability**: Graceful degradation when GitHub API is unavailable
- **Usability**: Interface follows VS Code design patterns and accessibility guidelines
- **Caching**: Repository data cached for 1 hour, with manual refresh option

## Out of Scope

- Editing downloaded files within the extension
- Uploading custom files back to the repository
- Bulk download of multiple files simultaneously

## Implementation Plan

### Phase 1: Foundation & Setup
- [x] **Step 1.1**: Update package.json with new extension configuration
- [x] **Step 1.2**: Create basic tree view provider structure
- [x] **Step 1.3**: Register tree view in VS Code explorer panel
- [x] **Step 1.4**: Set up TypeScript interfaces for data models

### Phase 2: GitHub API Integration
- [x] **Step 2.1**: Create GitHub API service to fetch repository contents
- [x] **Step 2.2**: Implement caching mechanism for repository data
- [x] **Step 2.3**: Add error handling for network operations
- [x] **Step 2.4**: Create data transformation layer for tree view

### Phase 3: Explorer View Implementation
- [x] **Step 3.1**: Implement tree data provider with categories
- [x] **Step 3.2**: Create tree items for files with appropriate icons
- [x] **Step 3.3**: Add expand/collapse functionality for categories
- [x] **Step 3.4**: Implement refresh button and manual data update

### Phase 4: Filtering & Search
- [x] **Step 4.1**: Add filter input boxes to tree view
- [x] **Step 4.2**: Implement real-time filename filtering logic
- [x] **Step 4.3**: Add clear filter functionality
- [x] **Step 4.4**: Update tree view to show filtered results

### Phase 5: Content Preview
- [x] **Step 5.1**: Create content preview panel/webview
- [x] **Step 5.2**: Fetch and display file content from GitHub
- [x] **Step 5.3**: Format markdown content for preview
- [x] **Step 5.4**: Handle preview error states

### Phase 6: Download Functionality
- [x] **Step 6.1**: Create download confirmation dialog
- [x] **Step 6.2**: Implement file system operations for downloads
- [x] **Step 6.3**: Add logic for appropriate folder structure creation
- [x] **Step 6.4**: Handle file conflicts and overwrite scenarios

### Phase 7: UI/UX & Feedback
- [x] **Step 7.1**: Add loading indicators and progress feedback
- [x] **Step 7.2**: Implement success/error notifications
- [x] **Step 7.3**: Add download buttons/icons to tree items
- [x] **Step 7.4**: Polish UI to match VS Code design patterns

### Phase 8: Testing & Validation
- [x] **Step 8.1**: Test all functional requirements
- [x] **Step 8.2**: Validate error handling scenarios
- [x] **Step 8.3**: Performance testing and optimization
- [x] **Step 8.4**: Final integration testing

### Phase 9: Custom Folder Mappings
- [x] **Step 9.1**: Add `FolderMapping` type and extend `RepoSource` interface (`src/types.ts`)
- [x] **Step 9.2**: Add `resolveContentPath()` helper for mapping categories to API paths (`src/types.ts`)
- [x] **Step 9.3**: Create folder mapping webview panel with input fields per category (`src/folderMappingPanel.ts`)
- [x] **Step 9.4**: Implement `root` logic (disables all other category inputs when set)
- [x] **Step 9.5**: Update `GitHubService` to use resolved content paths in `getFiles()` and `getFilesByRepo()` (`src/githubService.ts`)
- [x] **Step 9.6**: Add `updateFolderMappings()` method to `RepoStorage` (`src/repoStorage.ts`)
- [x] **Step 9.7**: Integrate folder mapping UI into "Add Repository" flow when no standard folders found (`src/extension.ts`)
- [x] **Step 9.8**: Add `folderMappings` to `package.json` repository configuration schema
- [x] **Step 9.9**: Document custom folder mappings in README.md with configuration reference and examples