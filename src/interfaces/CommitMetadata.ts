/**
 * Interface for Git commit metadata
 */
export interface CommitMetadata {
  hash?: string;              // Commit hash
  subject?: string;           // First line of the commit message
  commitMessage?: string;     // Full commit message
  authorName?: string;        // Author name
  authorEmail?: string;       // Author email
  authorDate?: string;        // Author date
  authorTimestamp?: number;   // Author timestamp
  branch?: string;            // Source branch
}
