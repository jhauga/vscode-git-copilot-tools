import * as vscode from 'vscode';
import { CopilotCategory, FolderMapping } from './types';

const CATEGORIES: CopilotCategory[] = [
    CopilotCategory.Agents,
    CopilotCategory.Instructions,
    CopilotCategory.Plugins,
    CopilotCategory.Prompts,
    CopilotCategory.Skills
];

/**
 * Shows a webview panel that lets the user configure folder-to-category mappings
 * for a source repository. Returns the folder mapping or undefined if cancelled.
 */
export function showFolderMappingPanel(
    extensionUri: vscode.Uri,
    repoLabel: string
): Promise<FolderMapping | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'folderMappingConfig',
            `Configure Folders: ${repoLabel}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = getFolderMappingHtml(panel.webview, repoLabel);

        let resolved = false;

        panel.webview.onDidReceiveMessage((message) => {
            if (message.type === 'save') {
                resolved = true;
                const mapping: FolderMapping = {};
                for (const cat of CATEGORIES) {
                    const value = message.mappings[cat];
                    if (value === 'null' || value === null) {
                        mapping[cat] = null;
                    } else if (value === 'root') {
                        mapping[cat] = 'root';
                    } else if (typeof value === 'string' && value.trim() !== '') {
                        mapping[cat] = value.trim();
                    }
                    // If empty/blank, leave it undefined (use default)
                }
                panel.dispose();
                resolve(mapping);
            } else if (message.type === 'cancel') {
                resolved = true;
                panel.dispose();
                resolve(undefined);
            }
        });

        panel.onDidDispose(() => {
            if (!resolved) {
                resolve(undefined);
            }
        });
    });
}

function getFolderMappingHtml(webview: vscode.Webview, repoLabel: string): string {
    const categoryInputs = CATEGORIES.map(cat => `
        <div class="category-row" id="row-${cat}">
            <label for="input-${cat}">${cat.charAt(0).toUpperCase() + cat.slice(1)}</label><br>
            <p>
                <b>NOTE</b> - input root if all files/folders in the repo are ${cat} files.
            </p>
            <p>
                Input <code>null</code> to exclude this folder or leave blank, else provide the path to the folder that will download <code>${cat}</code> files to <code>.github/${cat}</code>.
            </p>
            <input type="text" id="input-${cat}" data-category="${cat}" placeholder="input value" class="folder-input">
            <br><br>
        </div>
    `).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
            line-height: 1.5;
        }
        h2 {
            color: var(--vscode-foreground);
            margin-bottom: 8px;
        }
        .repo-label {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            margin-bottom: 16px;
        }
        .important-note {
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            padding: 8px 12px;
            margin-bottom: 16px;
            border-radius: 4px;
        }
        .category-row {
            margin-bottom: 4px;
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .category-row.disabled {
            opacity: 0.5;
            pointer-events: none;
        }
        label {
            font-weight: bold;
            font-size: 1.1em;
        }
        p {
            margin: 4px 0;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .folder-input {
            width: 100%;
            max-width: 500px;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            box-sizing: border-box;
        }
        .folder-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .folder-input:disabled {
            background-color: var(--vscode-input-background);
            opacity: 0.5;
        }
        .button-row {
            margin-top: 16px;
            display: flex;
            gap: 8px;
        }
        button {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <h2>Specify Path to Folders</h2>
    <div class="repo-label">Repository: ${escapeHtml(repoLabel)}</div>

    <div class="important-note">
        <b>IMPORTANT</b> - if a folder is specified as <code>root</code>, then all other folders will be disabled.
    </div>

    ${categoryInputs}

    <div class="button-row">
        <button class="btn-primary" id="btn-save">Save Configuration</button>
        <button class="btn-secondary" id="btn-cancel">Cancel</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const categories = ${JSON.stringify(CATEGORIES)};
        const inputs = {};

        categories.forEach(cat => {
            inputs[cat] = document.getElementById('input-' + cat);
        });

        // Handle root logic: when any input is set to 'root', disable all others
        function handleRootLogic() {
            let rootCategory = null;
            for (const cat of categories) {
                if (inputs[cat].value.trim().toLowerCase() === 'root') {
                    rootCategory = cat;
                    break;
                }
            }

            for (const cat of categories) {
                const row = document.getElementById('row-' + cat);
                if (rootCategory && cat !== rootCategory) {
                    inputs[cat].disabled = true;
                    inputs[cat].value = '';
                    row.classList.add('disabled');
                } else {
                    inputs[cat].disabled = false;
                    row.classList.remove('disabled');
                }
            }
        }

        // Add input event listeners
        categories.forEach(cat => {
            inputs[cat].addEventListener('input', handleRootLogic);
        });

        // Save button
        document.getElementById('btn-save').addEventListener('click', () => {
            const mappings = {};
            categories.forEach(cat => {
                const val = inputs[cat].value.trim();
                if (val === '') {
                    mappings[cat] = '';
                } else if (val.toLowerCase() === 'null') {
                    mappings[cat] = 'null';
                } else if (val.toLowerCase() === 'root') {
                    mappings[cat] = 'root';
                } else {
                    mappings[cat] = val;
                }
            });
            vscode.postMessage({ type: 'save', mappings: mappings });
        });

        // Cancel button
        document.getElementById('btn-cancel').addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
        });
    </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
