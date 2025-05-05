import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as os from 'os';

import { DebugLogger } from './DebugLogger';
import { SnapshotManager } from './SnapshotManager';
import { CommitMetadata } from '../interfaces/CommitMetadata';

/**
 * Manages Git repository operations
 */
export class GitManager {
  /**
   * List of URI schemes to ignore when tracking
   */
  public static readonly ignoredSchemes = [
    'output',
    'debug',
    'walkThrough',
    'walkThroughSnippet',
    'search-editor',
    'vscode-settings',
    'vscode-notebook',
    'vscode-notebook-cell',
    'vscode-userdata',
    'vscode-custom-editor',
    'vscode-webview',
    'vscode-insider',
    'vscode-terminal',
    'vscode-interactive-input',
    'vscode-interactive'
  ];

  constructor(private debug: DebugLogger) {}

  /**
   * Gets the active workspace folder based on the active editor
   * @returns The active workspace folder or undefined if none found
   */
  public getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    // First try to get the workspace folder of the active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      return vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    }

    // If no active editor in a workspace folder, return the first workspace folder
    return vscode.workspace.workspaceFolders?.[0];
  }

  /**
   * Finds the git repository root for a given file path
   * @param filePath The path to the file
   * @returns The path to the git repository root, or undefined if not in a git repository
   */
  public getGitRepoRoot(filePath: string): string | undefined {
    this.debug.log(`getGitRepoRoot called with filePath: ${filePath}`);

    // First check if the current directory is a git repo
    const currentPath = path.resolve(filePath);
    const currentDir = fs.statSync(currentPath).isDirectory() ? currentPath : path.dirname(currentPath);

    // Check if the current directory itself has a .git folder
    const gitDir = path.join(currentDir, '.git');
    if (fs.existsSync(gitDir)) {
      this.debug.log(`Found .git at current directory: ${gitDir}`);
      return currentDir;
    }

    // If not, start walking up the directory tree
    let parentDir = currentDir;
    const root = path.parse(parentDir).root;

    while (parentDir !== root) {
      const parentGitDir = path.join(parentDir, '.git');
      if (fs.existsSync(parentGitDir)) {
        this.debug.log(`Found .git at: ${parentGitDir}`);
        return parentDir;
      }
      const newParent = path.dirname(parentDir);
      if (newParent === parentDir) {
        // We've reached the top
        break;
      }
      parentDir = newParent;
    }

    // Check the root directory as well
    if (fs.existsSync(path.join(root, '.git'))) {
      this.debug.log(`Found .git at root: ${root}`);
      return root;
    }

    this.debug.warn('Did not find Git repo root.');
    return undefined;
  }

  /**
   * Runs a git command and returns the result
   * @param args The git command arguments
   * @param cwd The working directory
   * @param trimOutput Whether to trim the output
   * @returns The command result with stdout, stderr, and status
   */
  public runGitCommand(args: string[], cwd: string, trimOutput = true): Promise<{ stdout: string; stderr: string; status: number }> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const proc = spawn('git', args, { cwd, shell: true });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number) => {
        resolve({ stdout: trimOutput ? stdout.trim() : stdout, stderr: stderr.trim(), status: code ?? 0 });
      });
    });
  }

  /**
   * Resolves a git reference to a commit hash
   * @param inputRef The reference to resolve
   * @param cwd The git repository root
   * @returns The resolved commit hash or null if not found
   */
  public async resolveRefAsync(inputRef: string, cwd: string): Promise<string | null> {
    const ref = inputRef.trim();
    this.debug.log(`Resolving base ref: "${ref}" in ${cwd}`);

    if (ref.toUpperCase() === 'HEAD') {
      return 'HEAD';
    }

    if (ref.toUpperCase() === 'BRANCH') {
      try {
        // First, try to get the tracked upstream branch
        const currentBranch = await this.runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

        if (currentBranch.stdout === 'HEAD') {
          this.debug.warn(`Detached HEAD state - using HEAD~1`);
          return 'HEAD~1';
        }

        // Try to get the upstream branch
        const upstream = await this.runGitCommand(
          ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${currentBranch.stdout.trim()}`],
          cwd
        );

        if (upstream.stdout.trim()) {
          this.debug.log(`Found upstream branch: ${upstream.stdout.trim()}`);
          // Find the merge-base (common ancestor) between the current branch and the upstream
          const mergeBase = await this.runGitCommand(
            ['merge-base', 'HEAD', upstream.stdout.trim()],
            cwd
          );

          if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
            this.debug.log(`Using merge-base with upstream: ${mergeBase.stdout.trim()}`);
            return mergeBase.stdout.trim();
          }

          return upstream.stdout.trim(); // Fallback to upstream if merge-base fails
        }

        // No upstream, try main/master
        for (const baseBranch of ['origin/main', 'origin/master', 'main', 'master']) {
          const branchExists = await this.runGitCommand(['rev-parse', '--verify', baseBranch], cwd);
          if (branchExists.status === 0) {
            this.debug.log(`Using ${baseBranch} as base`);
            // Find the merge-base (common ancestor) between the current branch and the base branch
            const mergeBase = await this.runGitCommand(
              ['merge-base', 'HEAD', baseBranch],
              cwd
            );

            if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
              this.debug.log(`Using merge-base with ${baseBranch}: ${mergeBase.stdout.trim()}`);
              return mergeBase.stdout.trim();
            }

            return baseBranch; // Fallback to the branch itself if merge-base fails
          }
        }

        // If we can't find any good base, just use parent commit
        this.debug.warn(`No suitable base branch found - using HEAD~1`);
        const parentCheck = await this.runGitCommand(['rev-parse', '--verify', 'HEAD~1'], cwd);
        if (parentCheck.status === 0) {
          return 'HEAD~1';
        }

        // Last resort
        return 'HEAD';

      } catch (error) {
        this.debug.error(`Error resolving branch ref:`, error);
        return 'HEAD';
      }
    }

    if (ref.includes(' ')) {
      const candidates = ref.split(' ');
      for (const candidate of candidates) {
        const result = await this.resolveRefAsync(candidate.trim(), cwd);
        if (result) {
          this.debug.log(`Found matching ref: ${result} from input: ${candidate}`);
          return result;
        }
      }
      return null;
    }

    try {
      const revParseResult = await this.runGitCommand(['rev-parse', ref], cwd);
      return revParseResult.status === 0 ? revParseResult.stdout.trim() : null;
    } catch (error) {
      this.debug.error(`Error resolving ref ${ref}:`, error);
      return null;
    }
  }

  /**
   * Gets the count of files that have changed since the base ref
   * @param baseRef The base reference to compare against
   * @returns Promise with the number of changed files
   */
  public async getTrackedFilesCount(baseRef: string): Promise<number> {
    if (!baseRef) {
      return 0;
    }

    let changedFilesCount = 0;

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      return 0;
    }

    try {
      for (const folder of vscode.workspace.workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for folder: ${folderPath}`);
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.resolveRefAsync(baseRef, gitRoot);
        if (!resolvedRef) {
          continue;
        }

        // Get changed files compared to base ref
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', resolvedRef, '--', '.'],
          gitRoot
        );

        if (result.status === 0 || result.status === 1) {
          // Count changed files
          const diffFiles = result.stdout.split('\n').filter(f => f.trim());
          changedFilesCount += diffFiles.length;
        }

        // Also count untracked files
        const untrackedResult = await this.runGitCommand(
          ['ls-files', '--others', '--exclude-standard'],
          gitRoot
        );

        if (untrackedResult.status === 0) {
          const untrackedFiles = untrackedResult.stdout.split('\n').filter(f => f.trim());
          changedFilesCount += untrackedFiles.length;
        }
      }

      return changedFilesCount;
    } catch (error) {
      this.debug.error(`Error getting changed files count: ${error}`);
      return 0;
    }
  }

  /**
   * Gets the count of files that have changed since the last commit
   * @returns Promise with the number of changed files
   */
  public async getChangedFilesCount(): Promise<number> {
    let changedFilesCount = 0;

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      return 0;
    }

    try {
      for (const folder of vscode.workspace.workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for folder: ${folderPath}`);
          continue;
        }

        // Get changed files since last commit
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', 'HEAD', '--', '.'],
          gitRoot
        );

        if (result.status === 0 || result.status === 1) {
          // Count changed files
          const diffFiles = result.stdout.split('\n').filter(f => f.trim());
          changedFilesCount += diffFiles.length;
        }

        // Also count untracked files
        const untrackedResult = await this.runGitCommand(
          ['ls-files', '--others', '--exclude-standard'],
          gitRoot
        );

        if (untrackedResult.status === 0) {
          const untrackedFiles = untrackedResult.stdout.split('\n').filter(f => f.trim());
          changedFilesCount += untrackedFiles.length;
        }
      }

      return changedFilesCount;
    } catch (error) {
      this.debug.error(`Error getting changed files count since last commit: ${error}`);
      return 0;
    }
  }

  /**
   * Gets the changed files against a reference
   * @param gitRoot The git repository root
   * @param resolvedRef The reference to compare against
   * @returns Object with added, modified, and all changed files
   */
  public async getChangedFilesAgainstRef(
    gitRoot: string,
    resolvedRef: string
  ): Promise<{ added: string[], modified: string[], allChangedFiles: string[] }> {
    const added: string[] = [];
    const modified: string[] = [];
    const allChangedFiles: string[] = [];

    // Get status of all files compared to base ref
    const result = await this.runGitCommand(
      ['diff', '--ignore-cr-at-eol', '--name-status', resolvedRef, '--', '.'],
      gitRoot
    );

    if (result.status !== 0 && result.status !== 1) {
      this.debug.warn(`Error getting file status: ${result.stderr}`);
      return { added, modified, allChangedFiles };
    }

    this.debug.log(`Raw git diff output: ${result.stdout.substring(0, 200)}${result.stdout.length > 200 ? '...' : ''}`);

    // Parse the status output
    const statusLines = result.stdout.split('\n');
    for (const line of statusLines) {
      if (!line.trim()) continue;

      const statusMatch = line.match(/^([AMDRT])\s+(.+)/);
      if (statusMatch) {
        const [, status, filePath] = statusMatch;
        this.debug.log(`Found ${status} file: ${filePath}`);

        allChangedFiles.push(filePath);

        if (status === 'A') {
          added.push(filePath);
        } else if (status === 'M' || status === 'R' || status === 'T') {
          modified.push(filePath);
        }
      }
    }

    // Also try to get untracked files which may be new
    const untrackedResult = await this.runGitCommand(
      ['ls-files', '--others', '--exclude-standard'],
      gitRoot
    );

    if (untrackedResult.status === 0) {
      const untrackedFiles = untrackedResult.stdout.split('\n').filter(f => f.trim());
      for (const filePath of untrackedFiles) {
        this.debug.log(`Found untracked file: ${filePath}`);
        allChangedFiles.push(filePath);
        added.push(filePath);
      }
    }

    return { added, modified, allChangedFiles };
  }

  /**
   * Fetches Git commit metadata for a file if in a Git repository.
   * @param filePath Path to the file
   * @returns Commit metadata
   */
  public async getGitMetadata(filePath: string): Promise<CommitMetadata> {
    const metadata: CommitMetadata = {};
    const now = new Date();
    const gitRoot = this.getGitRepoRoot(filePath);
    if (gitRoot) {
      try {
        // Get all commit info in a single command
        const gitInfo = (await this.runGitCommand([
          'log',
          '-1',
          '--pretty=format:%H%n%an%n%ae%n%ai%n%D%n%s'
        ], gitRoot)).stdout?.trim();

        if (gitInfo) {
          const [hash, authorName, authorEmail, authorDate, refNames, subject] = gitInfo.split('\n');
          metadata.hash = hash;
          metadata.authorName = authorName;
          metadata.authorEmail = authorEmail;
          metadata.authorTimestamp = new Date(authorDate).getTime();
          metadata.subject = subject;

          // Get current branch separately since it's more reliable this way
          const branch = (await this.runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)).stdout?.trim();
          if (branch) {
            metadata.branch = branch;
          }
        } else {
          metadata.authorDate = now.toISOString();
        }
      } catch (error) {
        this.debug.warn(`Failed to get git metadata: ${error}`);
      }
    }
    return metadata;
  }

  /**
   * Stages a snapshot to git
   * @param filePath Path to the file
   * @param snapshotId ID of the snapshot to stage
   * @param snapshotManager The snapshot manager
   */
  public stageSnapshot(filePath: string, snapshotId: string, snapshotManager: SnapshotManager) {
    try {
      // Get the snapshot by ID
      const snapshot = snapshotManager.getSnapshotById(filePath, snapshotId);
      if (!snapshot) {
        vscode.window.showErrorMessage(`Snapshot not found: ${snapshotId}`);
        return;
      }

      // Get the Git repository root for this file
      const gitRoot = this.getGitRepoRoot(filePath);
      if (!gitRoot) {
        vscode.window.showErrorMessage('File is not in a Git repository');
        return;
      }

      // Get the relative path to the file from the git root
      const relativePath = path.relative(gitRoot, filePath);

      // Create a temporary file with the snapshot content
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcetracker-'));
      const tempFilePath = path.join(tempDir, path.basename(filePath));

      // Write the snapshot content to the temporary file
      fs.writeFileSync(tempFilePath, snapshot.content);

      // Use Git's hash-object command to add the content to Git's object database
      const hashResult = spawnSync('git', ['hash-object', '-w', tempFilePath], {
        cwd: gitRoot,
        encoding: 'utf-8'
      });

      if (hashResult.status !== 0) {
        vscode.window.showErrorMessage(`Failed to hash object: ${hashResult.stderr}`);
        return;
      }

      // Get the hash of the object
      const hash = hashResult.stdout.trim();

      // Use Git's update-index command to update the staging area
      const updateResult = spawnSync('git', ['update-index', '--cacheinfo', '100644', hash, relativePath], {
        cwd: gitRoot,
        encoding: 'utf-8'
      });

      // Clean up the temporary file
      fs.unlinkSync(tempFilePath);
      fs.rmdirSync(tempDir);

      if (updateResult.status === 0) {
        vscode.window.showInformationMessage(`Staged snapshot: ${snapshot.metadata.message || 'No message'}`);
        this.debug.info(`Successfully staged snapshot ${snapshotId} for file: ${filePath}`);

        // Offer to commit the changes
        vscode.window.showInformationMessage(
          `Snapshot staged. Do you want to commit it?`,
          'Yes', 'No'
        ).then(selection => {
          if (selection === 'Yes') {
            // Open the Git commit dialog
            vscode.commands.executeCommand('git.commitStaged');
          }
        });
      } else {
        vscode.window.showErrorMessage(`Failed to stage snapshot: ${updateResult.stderr}`);
        this.debug.error(`Failed to stage snapshot ${snapshotId}: ${updateResult.stderr}`);
      }
    } catch (error) {
      this.debug.error(`Error staging snapshot: ${error}`);
      vscode.window.showErrorMessage(`Error staging snapshot: ${error}`);
    }
  }
}
