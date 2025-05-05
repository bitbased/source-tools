import { SnapshotMetadata } from './SnapshotMetadata';

/**
 * Interface for file snapshots, combining metadata and content
 */
export interface FileSnapshot {
  metadata: SnapshotMetadata;
  content: string;            // The file content at snapshot time
}
