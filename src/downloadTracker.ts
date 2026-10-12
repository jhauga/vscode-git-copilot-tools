import * as vscode from 'vscode';
import { CopilotItem, EngineDownloadMetadata } from './types';
import { getLogger } from './logger';

const DOWNLOADS_STORAGE_KEY = 'vscodeGitCopilotTools.downloads';
const DOWNLOADS_SCHEMA_KEY = 'vscodeGitCopilotTools.downloadsSchema';
/** Version 2 keys records by the engine item id and stores the GitHub sha. */
const DOWNLOADS_SCHEMA_VERSION = 2;
/** A sha256 content hash, which version 1 stored for single files. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export interface DownloadMetadata {
    itemId: string;
    itemName: string;
    category: string;
    repoOwner: string;
    repoName: string;
    repoBaseUrl?: string;
    downloadTimestamp: number;
    /** GitHub sha of the file or folder at download time; empty when unknown. */
    sha: string;
    size: number;
    downloadUrl: string;
    /** Where the item was written. */
    localPath?: string;
}

export class DownloadTracker {
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Record a download when an item is downloaded. `meta` is what the engine
     * returned, which supplies the path the item was written to.
     */
    async recordDownload(item: CopilotItem, meta?: EngineDownloadMetadata): Promise<void> {
        try {
            const downloads = this.getDownloads();

            const metadata: DownloadMetadata = {
                itemId: item.id,
                itemName: item.name,
                category: item.category,
                repoOwner: item.repo.owner,
                repoName: item.repo.repo,
                repoBaseUrl: item.repo.baseUrl,
                downloadTimestamp: meta?.downloadTimestamp ?? Date.now(),
                // The listing sha, compared with later listings to detect updates
                sha: item.file.sha,
                size: item.file.size,
                downloadUrl: item.file.download_url ?? '',
                localPath: meta?.localPath
            };

            // Store or update the download metadata
            downloads[item.id] = metadata;

            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, downloads);

            getLogger().debug('Recorded download:', { itemId: item.id, itemName: item.name });
        } catch (error) {
            getLogger().error('Failed to record download:', error);
        }
    }

    /**
     * Move records saved by earlier versions to the engine item ids, once.
     *
     * Earlier versions keyed records as `<category>-<name>-<owner>-<repo>` and
     * stored a sha256 of single-file content, which never equals a GitHub sha.
     * Keys are rebuilt as `<owner>/<repo>/<category>/<name>`, and content
     * hashes are cleared so update checks compare sizes until the next
     * download records the GitHub sha. Returns the number of records moved.
     */
    async migrateIds(): Promise<number> {
        if (this.context.globalState.get<number>(DOWNLOADS_SCHEMA_KEY) === DOWNLOADS_SCHEMA_VERSION) {
            return 0;
        }

        const downloads = this.getDownloads();
        let moved = 0;
        for (const [key, record] of Object.entries(downloads)) {
            if (key.includes('/')) {
                continue;
            }
            delete downloads[key];
            if (!record || !record.repoOwner || !record.repoName || !record.category || !record.itemName) {
                continue;
            }

            const itemId = `${record.repoOwner}/${record.repoName}/${record.category}/${record.itemName}`;
            const existing = downloads[itemId];
            if (existing && existing.downloadTimestamp >= record.downloadTimestamp) {
                continue;
            }
            const sha = typeof record.sha === 'string' && !CONTENT_HASH_PATTERN.test(record.sha) ? record.sha : '';
            downloads[itemId] = { ...record, itemId, sha };
            moved++;
        }

        await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, downloads);
        await this.context.globalState.update(DOWNLOADS_SCHEMA_KEY, DOWNLOADS_SCHEMA_VERSION);
        if (moved > 0) {
            getLogger().info(`Moved ${moved} download record(s) to the current item ids.`);
        }
        return moved;
    }

    /**
     * Get all recorded downloads
     */
    getDownloads(): Record<string, DownloadMetadata> {
        return this.context.globalState.get<Record<string, DownloadMetadata>>(DOWNLOADS_STORAGE_KEY) || {};
    }

    /**
     * Check if an item has been downloaded
     */
    isDownloaded(itemId: string): boolean {
        const downloads = this.getDownloads();
        return itemId in downloads;
    }

    /**
     * Get download metadata for an item
     */
    getDownloadMetadata(itemId: string): DownloadMetadata | undefined {
        const downloads = this.getDownloads();
        return downloads[itemId];
    }

    /**
     * Check if a downloaded item has updates available.
     * Compares the GitHub sha when both sides have one, and the size otherwise.
     */
    hasUpdate(item: CopilotItem): boolean {
        const metadata = this.getDownloadMetadata(item.id);
        if (!metadata) {
            return false; // Not downloaded, so no update to check
        }

        const remoteSha = item.file.sha;
        if (remoteSha && metadata.sha) {
            return remoteSha !== metadata.sha;
        }

        // Compare size as a fallback
        return item.file.size !== metadata.size;
    }

    /**
     * Find all items that have updates available
     */
    findItemsWithUpdates(allItems: CopilotItem[]): CopilotItem[] {
        const itemsWithUpdates: CopilotItem[] = [];

        for (const item of allItems) {
            if (this.hasUpdate(item)) {
                itemsWithUpdates.push(item);
            }
        }

        return itemsWithUpdates;
    }

    /**
     * Remove a download record (e.g., when user manually deletes the file)
     */
    async removeDownload(itemId: string): Promise<void> {
        try {
            const downloads = this.getDownloads();
            delete downloads[itemId];
            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, downloads);
            getLogger().debug('Removed download record:', itemId);
        } catch (error) {
            getLogger().error('Failed to remove download record:', error);
        }
    }

    /**
     * Clear all download records
     */
    async clearAllDownloads(): Promise<void> {
        try {
            await this.context.globalState.update(DOWNLOADS_STORAGE_KEY, {});
            getLogger().info('Cleared all download records');
        } catch (error) {
            getLogger().error('Failed to clear download records:', error);
        }
    }
}
