# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Published builds are
versioned by Nerdbank.GitVersioning, so the patch number of a build comes from the commit height.

## [Unreleased]

### Added

- Each `folderMappings` category accepts an array of folders, searched in order, with `"."` for the repository root. Items from an array mapping are shown as `folder/name`
- The `aiFolder` repository property, which sets the folder that tools from a repository are saved under (default `.github`)
- The `branch` repository property in the settings schema
- Hook items in plugins
- Plugin download summaries list the entries that were not downloaded, such as Copilot extensions

### Changed

- GitHub requests, folder mapping, downloads, and plugin handling come from the `cmd-git-copilot-tools` engine 2.1.0, shared with the command-line tool
- Categories are listed in alphabetical order in the tree view and in the folder mapping panel, which now includes Cookbook and Hooks
- Categories a repository excludes with `null` or an empty array are no longer shown
- The `cacheTimeout` setting sets how long repository listings are cached; they were cached for one hour regardless of the setting
- The VS Code GitHub session is sent only to github.com sources; GitHub Enterprise sources use the `enterpriseToken` setting
- Sign-in is offered once per session and no longer delays loading, and prompts raised by failed requests appear at most once a minute
- Adding a repository checks its root folder with one request, and reports a repository that does not exist or cannot be accessed
- The download name prompt rejects names that contain `/` or `\`

### Fixed

- Plugins whose manifest is `plugin.json` at the root of the plugin folder download their agents, skills, and hooks
- Downloaded single files no longer always show "Update Available". Records saved by earlier versions are moved to the new item ids on first start
- Previewing a hook folder lists its files instead of failing
- "Show Diff" compares against the file where the item was downloaded
- A 403 response caused by missing permissions is no longer reported as a rate limit

### Removed

- The `axios` dependency
