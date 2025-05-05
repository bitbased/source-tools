import * as fs from 'fs';
import * as path from 'path';

import { DebugLogger } from './DebugLogger';
import { FileSnapshot } from '../interfaces/FileSnapshot';
import { SnapshotMetadata } from '../interfaces/SnapshotMetadata';
import { CommitMetadata } from '../interfaces/CommitMetadata';

/**
 * Interface for the snapshot index structure
 */
interface SnapshotIndex {
  [filePath: string]: {
    snapshots: { [snapshotId: string]: SnapshotMetadata }; // Map of snapshot IDs to metadata
    activeSnapshot?: string;  // Currently active snapshot ID
  };
}

/**
 * Manages file snapshots for tracking changes over time
 */
export class SnapshotManager {
  private snapshotDir: string;
  private indexFile: string;
  private index: SnapshotIndex = {};

  /**
   * Creates a new SnapshotManager
   * @param workspaceRoot Root directory of the workspace
   * @param debug Debug handler for logging
   */
  constructor(private workspaceRoot: string, private debug: DebugLogger) {
    // Create directory paths
    this.snapshotDir = path.join(workspaceRoot, '.vscode', 'snapshots');
    this.indexFile = path.join(workspaceRoot, '.vscode', 'snapshots.json');

    // Load existing index if available
    this.loadIndex();
  }

  /**
   * Ensure the necessary directories exist, but only if we have snapshots
   * This prevents creating directories unless the feature is actually used
   */
  private ensureDirectoriesExist(): void {
    // Only create directories if we have at least one snapshot
    const hasSnapshots = Object.keys(this.index).length > 0;

    if (hasSnapshots || this.isFileOperationInProgress()) {
      if (!fs.existsSync(path.join(this.workspaceRoot, '.vscode'))) {
        fs.mkdirSync(path.join(this.workspaceRoot, '.vscode'), { recursive: true });
      }

      if (!fs.existsSync(this.snapshotDir)) {
        fs.mkdirSync(this.snapshotDir, { recursive: true });
      }
    }
  }

  /**
   * Check if we're in the middle of a file operation
   * This helps determine if we should create directories
   * @returns True if a file operation is in progress
   */
  private isFileOperationInProgress(): boolean {
    // We can assume a file operation is in progress if this method is called
    // during takeSnapshot, deleteSnapshot, etc.
    return true;
  }

  /**
   * Load the snapshot index from disk
   */
  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile)) {
        this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        this.debug.log(`Loaded snapshot index from ${this.indexFile}`);
      } else {
        this.index = {};
        this.debug.log(`No snapshot index found, creating new one`);
      }
    } catch (error) {
      this.debug.error(`Error loading snapshot index: ${error}`);
      this.index = {};
    }
  }

  /**
   * Save the snapshot index to disk
   */
  private saveIndex(): void {
    try {
      // Ensure directories exist before saving
      this.ensureDirectoriesExist();

      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8');
      this.debug.log(`Saved snapshot index to ${this.indexFile}`);
    } catch (error) {
      this.debug.error(`Error saving snapshot index: ${error}`);
    }
  }

  /**
   * Take a new snapshot of a file
   * @param filePath Path to the file to snapshot
   * @param content Content of the file
   * @param message User message describing the snapshot
   * @param metadata Optional additional metadata
   * @returns The ID of the created snapshot
   */
  public takeSnapshot(filePath: string, content: string, message: string, metadata: Partial<CommitMetadata> = {}): string {
    // Ensure directories exist since we're about to create a file
    this.ensureDirectoriesExist();

    // Generate unique ID for this snapshot
    const id = `${path.basename(filePath)}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Create the metadata object (don't redundantly store id or filePath)
    const snapshotMetadata: SnapshotMetadata = {
      message,
      timestamp: Date.now(),
      ...metadata // Spread additional metadata if provided
    };

    // Save the content to a separate file
    const contentPath = path.join(this.snapshotDir, `${id}.content`);
    fs.writeFileSync(contentPath, content, 'utf8');

    // Update the index
    if (!this.index[filePath]) {
      this.index[filePath] = { snapshots: {} };
    }

    this.index[filePath].snapshots[id] = snapshotMetadata;
    this.saveIndex();

    return id;
  }

  /**
   * Get all snapshots for a file
   * @param filePath Path to the file
   * @returns Array of file snapshots sorted by timestamp (newest first)
   */
  public getSnapshots(filePath: string): FileSnapshot[] {
    if (!this.index[filePath] || Object.keys(this.index[filePath].snapshots).length === 0) {
      return [];
    }

    const snapshots: FileSnapshot[] = [];
    const fileSnapshots = this.index[filePath].snapshots;

    for (const id in fileSnapshots) {
      // Reconstruct id and filePath on the fly in returned metadata
      const metadata: SnapshotMetadata = {
        ...fileSnapshots[id],
        id,
        filePath
      };
      try {
        const contentPath = path.join(this.snapshotDir, `${id}.content`);
        if (fs.existsSync(contentPath)) {
          const content = fs.readFileSync(contentPath, 'utf8');
          snapshots.push({ metadata, content }); // Combine metadata from index and content from file
        } else {
          this.debug.warn(`Content file not found for snapshot ${id}: ${contentPath}`);
        }
      } catch (error) {
        this.debug.error(`Error loading content for snapshot ${id}: ${error}`);
      }
    }

    // Sort by timestamp, newest first
    return snapshots.sort((a, b) => (b.metadata.timestamp ?? 0) - (a.metadata.timestamp ?? 0));
  }

  /**
   * Set the active snapshot for a file
   * @param filePath Path to the file
   * @param snapshotId ID of the snapshot to set as active, or undefined to clear
   */
  public setActiveSnapshot(filePath: string, snapshotId: string | undefined): void {
    // Ensure directories exist if we are modifying the index
    this.ensureDirectoriesExist();

    if (!this.index[filePath]) {
      // If setting an active snapshot for a file with no snapshots yet, initialize
      this.index[filePath] = { snapshots: {} };
    }

    this.index[filePath].activeSnapshot = snapshotId;
    this.saveIndex();
  }

  /**
   * Get a specific snapshot by its ID for a file
   * @param filePath The path to the file
   * @param id The snapshot ID to retrieve
   * @returns The snapshot if found, undefined otherwise
   */
  public getSnapshotById(filePath: string, id: string): FileSnapshot | undefined {
    if (!this.index[filePath] || !this.index[filePath].snapshots[id]) {
      return undefined; // Metadata not found in index
    }

    const baseMetadata = this.index[filePath].snapshots[id];
    // Reconstruct id and filePath on the fly
    const metadata: SnapshotMetadata = {
      ...baseMetadata,
      id,
      filePath
    };
    try {
      const contentPath = path.join(this.snapshotDir, `${id}.content`);
      if (fs.existsSync(contentPath)) {
        const content = fs.readFileSync(contentPath, 'utf8');
        return { metadata, content }; // Combine metadata and content
      } else {
        this.debug.warn(`Content file not found for snapshot ${id}: ${contentPath}`);
      }
    } catch (error) {
      this.debug.error(`Error loading content for snapshot ${id}: ${error}`);
    }
    return undefined; // Content file missing or error reading
  }

  /**
   * Get the active snapshot for a file
   * @param filePath Path to the file
   * @returns The active snapshot if set and exists, undefined otherwise
   */
  public getActiveSnapshot(filePath: string): FileSnapshot | undefined {
    const activeSnapshotId = this.index[filePath]?.activeSnapshot;

    if (!activeSnapshotId) {
      return undefined;
    }

    // Get metadata from the index
    const baseMetadata = this.index[filePath].snapshots[activeSnapshotId];
    if (!baseMetadata) {
      this.debug.warn(`Metadata not found in index for active snapshot ID: ${activeSnapshotId}`);
      // Clear the invalid active snapshot ID
      this.index[filePath].activeSnapshot = undefined;
      this.saveIndex();
      return undefined;
    }

    // Reconstruct id and filePath on the fly
    const metadata: SnapshotMetadata = {
      ...baseMetadata,
      id: activeSnapshotId,
      filePath
    };

    // Get content from the file
    try {
      const contentPath = path.join(this.snapshotDir, `${activeSnapshotId}.content`);
      if (fs.existsSync(contentPath)) {
        const content = fs.readFileSync(contentPath, 'utf8');
        return { metadata, content }; // Combine metadata and content
      } else {
        this.debug.warn(`Content file not found for active snapshot ${activeSnapshotId}: ${contentPath}`);
        // Clear the invalid active snapshot ID as content is missing
        this.index[filePath].activeSnapshot = undefined;
        this.saveIndex();
      }
    } catch (error) {
      this.debug.error(`Error loading content for active snapshot ${activeSnapshotId}: ${error}`);
    }

    return undefined;
  }

  /**
   * Delete a snapshot
   * @param filePath Path to the file
   * @param snapshotId ID of the snapshot to delete
   */
  public deleteSnapshot(filePath: string, snapshotId: string): void {
    if (!this.index[filePath]) {
      return;
    }

    // Remove metadata from index
    if (this.index[filePath].snapshots[snapshotId]) {
      delete this.index[filePath].snapshots[snapshotId];
    }

    // If this was the active snapshot, clear it
    if (this.index[filePath].activeSnapshot === snapshotId) {
      this.index[filePath].activeSnapshot = undefined;
    }

    // Remove the content file
    const contentPath = path.join(this.snapshotDir, `${snapshotId}.content`);
    if (fs.existsSync(contentPath)) {
      try {
        fs.unlinkSync(contentPath);
      } catch (error) {
        this.debug.error(`Error deleting content file ${contentPath}: ${error}`);
      }
    }

    // If no snapshots remain for this file, remove the file entry from index
    if (Object.keys(this.index[filePath].snapshots).length === 0) {
      delete this.index[filePath];
    }

    this.saveIndex();
  }

  /**
   * Updates the message for an existing snapshot
   * @param filePath The path to the file
   * @param id The ID of the snapshot to update
   * @param message The new message for the snapshot
   */
  public updateSnapshotMessage(filePath: string, id: string, message: string): void {
    try {
      // Find the metadata in the index
      if (this.index[filePath] && this.index[filePath].snapshots[id]) {
        const metadata = this.index[filePath].snapshots[id];
        // Update the message
        metadata.message = message;

        // Save the updated index
        this.saveIndex();
        this.debug.log(`Updated message for snapshot ${id}`);
      } else {
        this.debug.error(`Snapshot metadata not found in index for ID: ${id} and file: ${filePath}`);
      }
    } catch (error) {
      this.debug.error(`Error updating snapshot message in index: ${error}`);
    }
  }

  /**
   * Clear all snapshots for a file
   * @param filePath Path to the file
   */
  public clearSnapshots(filePath: string): void {
    if (!this.index[filePath]) {
      return;
    }

    // Delete all content files associated with this file path
    const snapshotIds = Object.keys(this.index[filePath].snapshots);
    for (const id of snapshotIds) {
      const contentPath = path.join(this.snapshotDir, `${id}.content`);
      if (fs.existsSync(contentPath)) {
        try {
          fs.unlinkSync(contentPath);
        } catch (error) {
          this.debug.error(`Error deleting content file ${contentPath}: ${error}`);
        }
      }
    }

    // Remove from index
    delete this.index[filePath];
    this.saveIndex();
  }

  /**
   * Trims the number of snapshots for a file to the specified limit
   * @param filePath Path to the file
   * @param maxSnapshots Maximum number of snapshots to keep
   */
  public trimSnapshots(filePath: string, maxSnapshots: number): void {
    if (!this.index[filePath] || maxSnapshots <= 0) {
      return;
    }

    const snapshots = this.getSnapshots(filePath);
    if (snapshots.length <= maxSnapshots) {
      return; // No need to trim
    }

    // Sort by timestamp, oldest first
    snapshots.sort((a, b) => (a.metadata.timestamp ?? 0) - (b.metadata.timestamp ?? 0));

    // Keep the newest ones, delete the oldest ones
    const toDelete = snapshots.slice(0, snapshots.length - maxSnapshots);

    for (const snapshot of toDelete) {
      if (snapshot.metadata.id) {
        this.deleteSnapshot(filePath, snapshot.metadata.id);
      }
    }
  }
}
