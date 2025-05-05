import { CommitMetadata } from './CommitMetadata';

/**
 * Interface for snapshot metadata
 * The id and filePath are not stored in the index, but are reconstructed when returned from APIs.
 */
export interface SnapshotMetadata extends Partial<CommitMetadata> {
  id?: string;                 // Unique identifier for the snapshot (reconstructed, not stored)
  filePath?: string;           // Path to the file relative to workspace (reconstructed, not stored)
  message?: string;            // User-provided description
  timestamp?: number;          // When the snapshot was taken
}
