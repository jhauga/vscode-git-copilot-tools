import * as vscode from 'vscode';
import { SearchBar } from './searchBar';
import { getLogger } from './logger';

/**
 * WebView provider for the search view
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private searchBar: SearchBar
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): void | Thenable<void> {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'search':
                    getLogger().debug('[SearchPanel] Search term received:', message.text);
                    this.searchBar.setSearchTerm(message.text);
                    break;
                case 'clear':
                    getLogger().debug('[SearchPanel] Clear search');
                    this.searchBar.clearSearch();
                    break;
            }
        });

        // Listen to search changes from other sources and update the webview
        this.searchBar.onSearchChange((term) => {
            if (this.view) {
                this.view.webview.postMessage({
                    command: 'updateSearch',
                    text: term
                });
            }
        });
    }

    public updateSearch(term: string): void {
        if (this.view) {
            this.view.webview.postMessage({
                command: 'updateSearch',
                text: term
            });
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const searchTerm = this.searchBar.getSearchTerm();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Search Files</title>
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-foreground);
            overflow: hidden;
        }
        .search-container {
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .search-wrapper {
            flex: 1;
            position: relative;
            display: flex;
            align-items: center;
        }
        .search-icon {
            position: absolute;
            left: 8px;
            opacity: 0.6;
            pointer-events: none;
            font-size: 14px;
        }
        .search-input {
            width: 100%;
            padding: 6px 32px 6px 28px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            outline: none;
            transition: border-color 0.15s;
        }
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .clear-button {
            position: absolute;
            right: 4px;
            padding: 4px 6px;
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            opacity: 0.6;
            transition: opacity 0.15s;
            display: none;
        }
        .clear-button.visible {
            display: block;
        }
        .clear-button:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
            border-radius: 2px;
        }
        .status-text {
            padding: 8px 16px;
            font-size: 11px;
            opacity: 0.7;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <div class="search-wrapper">
            <span class="search-icon">🔍</span>
            <input
                type="text"
                class="search-input"
                id="searchInput"
                placeholder="Filter files by name..."
                value="${searchTerm}"
                autofocus
            />
            <button class="clear-button${searchTerm ? ' visible' : ''}" id="clearButton" title="Clear search">✕</button>
        </div>
    </div>
    <div class="status-text" id="statusText">${searchTerm ? `Filtering: "${searchTerm}"` : 'Type to search...'}</div>

    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('searchInput');
        const clearButton = document.getElementById('clearButton');
        const statusText = document.getElementById('statusText');

        function updateUI(value) {
            if (value) {
                clearButton.classList.add('visible');
                statusText.textContent = 'Filtering: "' + value + '"';
            } else {
                clearButton.classList.remove('visible');
                statusText.textContent = 'Type to search...';
            }
        }

        // Debounce search to avoid too many updates
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            updateUI(e.target.value);
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                vscode.postMessage({
                    command: 'search',
                    text: e.target.value
                });
            }, 300);
        });

        // Immediate search on Enter
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(searchTimeout);
                vscode.postMessage({
                    command: 'search',
                    text: e.target.value
                });
            } else if (e.key === 'Escape') {
                searchInput.value = '';
                updateUI('');
                vscode.postMessage({
                    command: 'clear'
                });
            }
        });

        clearButton.addEventListener('click', () => {
            searchInput.value = '';
            updateUI('');
            vscode.postMessage({
                command: 'clear'
            });
            searchInput.focus();
        });

        // Listen for updates from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateSearch') {
                searchInput.value = message.text || '';
                updateUI(message.text || '');
            }
        });

        // Initial UI update
        updateUI(searchInput.value);
    </script>
</body>
</html>`;
    }
}
