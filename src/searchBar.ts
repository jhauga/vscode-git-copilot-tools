import * as vscode from 'vscode';
import { CopilotItem } from './types';
import { getLogger } from './logger';

/**
 * SearchBar provides file filtering functionality for the Git Copilot Tools tree view
 */
export class SearchBar {
    private searchTerm: string = '';
    private onSearchChangeEmitter: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onSearchChange: vscode.Event<string> = this.onSearchChangeEmitter.event;

    constructor() {
        getLogger().debug('[SearchBar] Initialized');
    }

    /**
     * Show a quick input box to allow users to search/filter files
     */
    public async showSearchInput(): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: 'Search files by name',
            placeHolder: 'Enter filename to filter...',
            value: this.searchTerm,
            ignoreFocusOut: false
        });

        if (result !== undefined) {
            this.searchTerm = result.trim();
            getLogger().debug(`[SearchBar] Search term updated: "${this.searchTerm}"`);
            this.onSearchChangeEmitter.fire(this.searchTerm);
        }
    }

    /**
     * Update the search term programmatically
     */
    public setSearchTerm(term: string): void {
        this.searchTerm = term.trim();
        getLogger().debug(`[SearchBar] Search term set: "${this.searchTerm}"`);
        this.onSearchChangeEmitter.fire(this.searchTerm);
    }

    /**
     * Get the current search term
     */
    public getSearchTerm(): string {
        return this.searchTerm;
    }

    /**
     * Clear the search filter
     */
    public clearSearch(): void {
        this.searchTerm = '';
        getLogger().debug('[SearchBar] Search cleared');
        this.onSearchChangeEmitter.fire(this.searchTerm);
    }

    /**
     * Check if a file matches the current search term
     * @param fileName The name of the file to check
     * @returns true if the file matches or if no search term is set
     */
    public matchesSearch(fileName: string): boolean {
        if (!this.searchTerm) {
            return true; // No filter, show all
        }

        const searchLower = this.searchTerm.toLowerCase();
        const fileNameLower = fileName.toLowerCase();

        return fileNameLower.includes(searchLower);
    }

    /**
     * Filter a list of items based on the current search term
     * @param items Array of CopilotItem to filter
     * @returns Filtered array of items
     */
    public filterItems(items: CopilotItem[]): CopilotItem[] {
        if (!this.searchTerm) {
            return items; // No filter, return all
        }

        const filtered = items.filter(item => this.matchesSearch(item.name));
        getLogger().debug(`[SearchBar] Filtered ${items.length} items to ${filtered.length} matches`);
        
        return filtered;
    }

    /**
     * Get a status message for the current search state
     */
    public getStatusMessage(): string {
        if (this.searchTerm) {
            return `Filtering by: "${this.searchTerm}"`;
        }
        return '';
    }

    /**
     * Check if a search is currently active
     */
    public isSearchActive(): boolean {
        return this.searchTerm.length > 0;
    }
}
