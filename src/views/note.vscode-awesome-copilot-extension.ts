import * as path from 'path';
import * as fs from 'fs';

const TEMPLATE_PATH = path.join(__dirname, '..', 'src', 'views', 'note.vscode-git-copilot-tools-extension.md');
const PLACEHOLDER = '| /SLASH-COMMAND-NOTE |';

/**
 * Extract slash commands from a plugin README.
 * Looks for table rows like: | `/plugin-name:command-name` | ... |
 * Returns command names with the plugin-name prefix stripped.
 */
export function extractSlashCommands(readmeContent: string, pluginName: string): string[] {
    const commands: string[] = [];
    const lines = readmeContent.split('\n');

    // Match table rows containing backtick-wrapped slash commands
    // Pattern: | `/plugin-name:command-name` | ... |
    const commandPattern = new RegExp(
        '\\|\\s*`/' + escapeRegExp(pluginName) + ':([^`]+)`\\s*\\|',
        'g'
    );

    for (const line of lines) {
        let match;
        while ((match = commandPattern.exec(line)) !== null) {
            commands.push(match[1]);
        }
    }

    return commands;
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate the NOTE.VSCODE-AWESOME-COPILOT-EXTENSION.md content
 * from a plugin's README by extracting and remapping slash commands.
 */
export function generateNoteContent(readmeContent: string, pluginName: string): string {
    const commands = extractSlashCommands(readmeContent, pluginName);

    // Read the template
    let template: string;
    // In compiled output, __dirname is 'out/', template is at 'src/views/'
    // Try multiple paths for robustness
    const possiblePaths = [
        path.join(__dirname, '..', 'src', 'views', 'note.vscode-git-copilot-tools-extension.md'),
        path.join(__dirname, 'views', 'note.vscode-git-copilot-tools-extension.md'),
    ];

    template = '';
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            template = fs.readFileSync(p, 'utf8');
            break;
        }
    }

    if (!template) {
        // Fallback: use inline template
        template = `# NOTE\n\nPlugin slash commands are mapped as:\n\n| Command |\n|---------|\n${PLACEHOLDER}\n`;
    }

    if (commands.length === 0) {
        // No slash commands found - remove the placeholder row
        return template.replace(PLACEHOLDER + '\n', '| (none) |\n');
    }

    // Build command rows
    const commandRows = commands
        .map(cmd => `| \`/${cmd}\` |`)
        .join('\n');

    return template.replace(PLACEHOLDER, commandRows);
}
