import * as vscode from 'vscode';
import * as path from 'path';

import { ConfigManager } from './managers/ConfigManager';
import { DecorationManager } from './managers/DecorationManager';
import { GitManager } from './managers/GitManager';
import { SnapshotManager } from './managers/SnapshotManager';
import { DebugLogger } from './managers/DebugLogger';

/**
 * The main class that coordinates all functionality of the Source Tracker extension
 */
export class SourceTracker {
  private statusBarItem: vscode.StatusBarItem;
  private baseRef: string = '';
  private diffTimeout?: NodeJS.Timeout;
  private statusBarUpdateInterval?: NodeJS.Timeout;
  private fileExplorerTimeout?: NodeJS.Timeout;
  private lastSavedFile?: string;
  private lastSavedTime?: number;
  private previousFilePath?: string;
  private previousText?: string;

  constructor(
    private context: vscode.ExtensionContext,
    private debug: DebugLogger,
    private configManager: ConfigManager,
    private gitManager: GitManager,
    private decorationManager: DecorationManager,
    private snapshotManager?: SnapshotManager
  ) {
    // Load the persisted base ref from context, or default to empty string
    this.baseRef = this.context.workspaceState.get<string>('sourceTracker.trackingBaseRef', '');

    // Create the status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'sourceTracker.gitTrackingOptions';
    this.updateStatusBar();

    // Initialize the context variable for when clauses
    vscode.commands.executeCommand('setContext', 'sourceTracker.trackingBaseRef', this.baseRef);
    this.debug.log(`Initialized context variable: sourceTracker.trackingBaseRef = ${this.baseRef}`);

    // Register for config changes
    this.context.subscriptions.push(
      this.configManager.onChange(config => {
        // Update decorations when config changes
        this.decorationManager.clearDecorations();
        this.decorationManager.initDecorations();
        this.updateDecorations();
        this.scheduleFileExplorerUpdate(true);
      })
    );

    // Set up periodic status bar updates
    this.statusBarUpdateInterval = setInterval(() => this.updateStatusBar(), 30000);
  }

  /**
   * Activates the extension by registering commands and event handlers
   */
  public activate() {
    this.debug.info('Activating extension...');

    this.context.subscriptions.push(
      vscode.commands.registerCommand('sourceTracker.debugOptions', (...args) => {
        this.debug.log('>>> sourceTracker.debugOptions', args);
        this.debug.selectDebugLevel();
      }),
      vscode.commands.registerCommand('sourceTracker.displayOptions', (...args) => {
        this.debug.log('>>> sourceTracker.displayOptions', args);
        this.decorationManager.selectDisplayOptions(...args);
      }),
      vscode.commands.registerCommand('sourceTracker.gitTrackingOptions', (...args) => {
        this.debug.log('>>> sourceTracker.gitTrackingOptions', args);
        this.selectBaseRef();
      }),
      vscode.commands.registerCommand('sourceTracker.diffTrackedFile', (...args) => {
        this.debug.log('>>> sourceTracker.diffTrackedFile', args);
        this.diffTrackedFile();
      }),
      vscode.commands.registerCommand('sourceTracker.diffFileSnapshot', (...args) => {
        this.debug.log('>>> sourceTracker.diffFileSnapshot', args);
        this.diffTrackedFile(); // same logic
      }),
      vscode.commands.registerCommand('sourceTracker.stageFileSnapshot', (...args) => {
        this.debug.log('>>> sourceTracker.stageFileSnapshot', ...args);
        const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const snapshotId = args[0];

        if (filePath && snapshotId) {
          this.stageSnapshot(filePath, snapshotId);
        } else if (filePath && this.snapshotManager) {
          const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
          if (activeSnapshot) {
            this.stageSnapshot(filePath, activeSnapshot.metadata.id ?? '');
          } else {
            vscode.window.showErrorMessage('No active snapshot to stage');
          }
        }
      }),
      vscode.commands.registerCommand('sourceTracker.snapshotTrackingOptions', (...args) => {
        this.debug.log('>>> sourceTracker.snapshotTrackingOptions', ...args);
        this.selectSnapshotTrackingOptions(args[0]);
      }),
      vscode.commands.registerCommand('sourceTracker.openChangedFiles', (force) => this.openChangedFiles(force)),
      vscode.commands.registerCommand('sourceTracker.openTrackedFiles', (force) => this.openTrackedFiles(force)),
      vscode.workspace.onDidChangeTextDocument(e => this.handleDocChange(e)),
      vscode.window.onDidChangeTextEditorSelection(e => this.handleSelectionChange(e)),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleFileExplorerUpdate()),
      vscode.workspace.onDidSaveTextDocument((document) => this.handleDocumentSave(document)),
      vscode.window.onDidChangeActiveTextEditor(editor => this.handleActiveEditorChange(editor))
    );

    // Register the file decoration providers
    this.context.subscriptions.push(
      this.decorationManager.registerDecorationProviders(),
      this.statusBarItem
    );

    // Show the status bar with the current tracking reference
    this.updateStatusBar();

    // Attempt an initial decoration update
    if (this.diffTimeout) {
      clearTimeout(this.diffTimeout);
    }
    // Throttle multiple changes within a short time
    this.diffTimeout = setTimeout(() => this.updateDecorations(), 250);

    // Also schedule an initial file explorer update
    this.scheduleFileExplorerUpdate();

    setTimeout(() => {
      this.updateActiveEditorContext();
    }, 500);
  }

  /**
   * Disposes of resources used by the extension
   */
  public dispose() {
    if (this.statusBarUpdateInterval) {
      clearInterval(this.statusBarUpdateInterval);
      this.statusBarUpdateInterval = undefined;
    }

    // Dispose of config manager subscription
    if (this.configManager) {
      this.configManager.dispose();
    }

    // Dispose of status bar item
    this.statusBarItem.dispose();
  }

  /**
   * Updates the status bar item with the current tracking reference
   */
  private async updateStatusBar() {
    // Check if active editor has an active snapshot
    const editor = vscode.window.activeTextEditor;
    if (editor &&
        editor.document &&
        editor.document.uri.scheme === 'file' &&
        this.snapshotManager) {
      const filePath = editor.document.uri.fsPath;
      const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);

      if (activeSnapshot) {
        const relativeTime = this.getRelativeTimeString(activeSnapshot.metadata.timestamp ?? 0);
        if (relativeTime?.includes('second')) {
          setTimeout(() => this.updateStatusBar(), 500);
        }
        this.statusBarItem.text = `$(sti-snapshot-compare) ${relativeTime}`;
        this.statusBarItem.tooltip = `SourceTracker: Tracking snapshot "${activeSnapshot.metadata.message || 'No description'}"`;
        this.statusBarItem.command = 'sourceTracker.snapshotTrackingOptions';
        this.statusBarItem.color = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
        this.statusBarItem.show();
        return;
      }
    }
    this.statusBarItem.command = 'sourceTracker.gitTrackingOptions';

    // Fall back to git tracking if no snapshot is active
    if (this.baseRef) {
      let refName = this.baseRef;

      if (refName === 'master main trunk default') {
        refName = 'master/main';
      }

      let resolvedRef = 'inactive';
      const editor = vscode.window.activeTextEditor;
      if (editor &&
          editor.document &&
          editor.document.uri.scheme === 'file'
      ) {
        const filePath = editor.document.uri.fsPath;
        const gitRoot = this.gitManager.getGitRepoRoot(filePath);
        if (!gitRoot) {
          resolvedRef = 'no git';
        } else {
          const relativePath = path.relative(gitRoot, filePath);
          this.debug.log(`Git root: ${gitRoot}, Relative path: ${relativePath}`);
          // 🔁 Dynamically resolve base ref for this file
          resolvedRef = await this.gitManager.resolveRefAsync(this.baseRef, gitRoot) || '';
          if (!resolvedRef) {
            resolvedRef = 'not found';
          } else {
            // If it's a hash, just show a shortened version
            if (/^[0-9a-f]{40}$/i.test(resolvedRef)) {
              resolvedRef = resolvedRef.substring(0, 7);
            }
          }
        }
      } else {
        resolvedRef = 'inactive';
      }

      if (resolvedRef === refName && /^[0-9a-f]{7}$/i.test(resolvedRef) ) {
        refName = 'COMMIT';
      }

      this.statusBarItem.text = `$(sti-tracking-compare) ${refName} (${resolvedRef})`;
      this.statusBarItem.tooltip = `SourceTracker: Tracking changes against ${refName} (${resolvedRef})`;
      if (resolvedRef === 'no git' || resolvedRef === 'inactive') {
        this.statusBarItem.color = new vscode.ThemeColor('disabledForeground');
      } else if (resolvedRef === 'not found') {
        this.statusBarItem.color = new vscode.ThemeColor('gitDecoration.deletedResourceForeground');
      } else {
        this.statusBarItem.color = new vscode.ThemeColor('gitDecoration.addedResourceForeground');
      }
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = `$(sti-tracking-compare) (inactive)`;
      this.statusBarItem.tooltip = 'SourceTracker: Click to select a tracking reference';
      this.statusBarItem.color = new vscode.ThemeColor('disabledForeground');;
      this.statusBarItem.show();
    }
  }

  /**
   * Formats a timestamp as a relative time string (seconds ago, minutes ago, hours ago, etc.)
   * @param timestamp The timestamp to format
   * @returns A human-readable relative time string
   */
  private getRelativeTimeString(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    // Less than a minute
    if (diff < 60 * 1000) {
      const seconds = Math.floor(diff / 1000);
      return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
    }

    // Less than 2 hours
    if (diff < 120 * 60 * 1000) {
      const minutes = Math.floor(diff / (60 * 1000));
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }

    // Less than 2 days
    if (diff < 48 * 60 * 60 * 1000) {
      const hours = Math.floor(diff / (60 * 60 * 1000));
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }

    // Less than a week
    if (diff < 7 * 24 * 60 * 60 * 1000) {
      const days = Math.floor(diff / (24 * 60 * 60 * 1000));
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }

    // For older timestamps, show the actual date
    return new Date(timestamp).toLocaleString();
  }

  /**
   * Handles text editor selection changes to detect large text additions or deletions
   * @param e The SelectionChangeEvent
   */
  private async handleSelectionChange(e: vscode.TextEditorSelectionChangeEvent) {
    const editor = e.textEditor;

    // Ignore events from documents with ignored schemes
    if (editor?.document?.uri?.scheme && GitManager.ignoredSchemes.includes(editor.document.uri.scheme)) {
      return;
    }

    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    // Get current document text
    const currentText = editor.document.getText();
    const filePath = editor.document.uri.fsPath;

    // Store current text for next comparison
    this.previousText = currentText;
    this.previousFilePath = filePath;
  }

  /**
   * Handles document changes to detect large text additions or deletions
   * @param event The document change event
   */
  private handleDocChange(event: vscode.TextDocumentChangeEvent) {
    // Ignore events from documents with ignored schemes
    if (event.document.uri.scheme && GitManager.ignoredSchemes.includes(event.document.uri.scheme)) {
      return;
    }

    // ------------------------------------------------------------------
    //  Detect large paste / deletion operations and create snapshots
    // ------------------------------------------------------------------
    if (event.reason) {
      this.previousText = event.document.getText();
      this.previousFilePath = event.document.uri.fsPath;
      return;
    }

    // Make sure the document is the same as the previous one
    if (this.previousFilePath && event.document.uri.fsPath !== this.previousFilePath) {
      // Update previous references and exit early
      this.previousText = event.document.getText();
      this.previousFilePath = event.document.uri.fsPath;
      return;
    }

    // --------------------------------------------------------------
    //  Ignore trivial edits (whitespace‑only or single‑character)
    // --------------------------------------------------------------
    const isWhitespaceOnlyChange = event.contentChanges.every(change =>
      change.text.trim().length === 0 && change.rangeLength === 0
    );

    // Detect multi‑cursor typing where each cursor inserts a single character
    // Detect single‑character edits (normal typing)
    const isSingleCharacterChange =
      event.contentChanges.length === 1 &&
      event.contentChanges[0].text.length === 1 &&
      event.contentChanges[0].rangeLength <= 1;

    const isMultiCursorSingleCharacterChange =
      event.contentChanges.length > 1 &&
      event.contentChanges.every(
        change => change.text.length === 1 && change.rangeLength <= 1
      );

    if (
      isWhitespaceOnlyChange ||
      isSingleCharacterChange ||
      isMultiCursorSingleCharacterChange
    ) {
      // Keep previous text references in sync then exit early
      this.previousText     = event.document.getText();
      this.previousFilePath = event.document.uri.fsPath;
      return;
    }

    const document = event.document;

    // Only track real file‑system files
    if (document.uri.scheme !== 'file') {
      return;
    }

    const filePath = document.uri.fsPath;

    // Aggregate character / line additions & removals coming with this change
    let addedChars = 0;
    let removedChars = 0;
    let addedLines = 0;
    let removedLines = 0;

    for (const change of event.contentChanges) {
      addedChars   += change.text.length;
      removedChars += change.rangeLength;

      addedLines   += (change.text.split('\n').length - 1);
      removedLines += (change.range.end.line - change.range.start.line);
    }

    const netCharChange = addedChars - removedChars;

    // Thresholds (could be configurable in the future)
    const significantChangeThreshold = 10;
    const significantLineThreshold   = 2;

    const { beforePaste: beforePasteTrigger, beforeDeletion: beforeDeleteTrigger } =
      this.configManager.get().snapshotTriggers;

    // If both triggers are disabled, simply keep previous text up‑to‑date and exit
    if (!beforePasteTrigger.replace('off', '') && !beforeDeleteTrigger.replace('off', '')) {
      this.previousText     = document.getText();
      this.previousFilePath = filePath;
      return;
    }

    const wasDeletion = (removedChars >= significantChangeThreshold || removedLines >= significantLineThreshold)
                        && netCharChange < 0;
    const wasPaste    = (addedChars   >= significantChangeThreshold || addedLines   >= significantLineThreshold)
                        && netCharChange > 0;

    const currentSnapshot = this.snapshotManager?.getActiveSnapshot(filePath);

    const createSnapshot = async (
      triggerType: 'deletion' | 'paste',
      triggerSetting: string
    ) => {
      if (!this.snapshotManager || !this.previousText) { return; }

      const now            = new Date();
      const formattedDate  = now.toLocaleDateString();
      const formattedTime  = now.toLocaleTimeString();
      const metadata       = await this.gitManager.getGitMetadata(filePath);
      const snapshotId     = this.snapshotManager.takeSnapshot(
        filePath,
        this.previousText,
        `* Auto-snapshot (before ${triggerType}, ${formattedDate} ${formattedTime})`,
        metadata
      );

      // Activate snapshot depending on trigger configuration
      if (triggerSetting === 'activate' ||
          (triggerSetting === 'auto' &&
            (!currentSnapshot || currentSnapshot.metadata.message?.startsWith('*')))) {
        this.snapshotManager.setActiveSnapshot(filePath, snapshotId);
      }

      this.debug.info(`Created snapshot before large ${triggerType}: ${filePath}`);
      vscode.window.showInformationMessage(
        `Snapshot created before ${triggerType} for ${path.basename(filePath)}`
      );

      // Refresh decorations & context
      this.updateDecorations();
      this.updateActiveEditorContext();
    };

    if (wasPaste && beforePasteTrigger.replace('off', '')) {
      createSnapshot('paste', beforePasteTrigger);
    } else if (wasDeletion && beforeDeleteTrigger.replace('off', '')) {
      createSnapshot('deletion', beforeDeleteTrigger);
    }

    // Store current text for next comparison
    this.previousText     = document.getText();
    this.previousFilePath = filePath;

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && event.document === activeEditor.document) {
      // Skip non-file editors (output, terminal, webview, etc.)
      if (activeEditor.document.uri.scheme === 'output') {
        return;
      }
      if (this.diffTimeout) {
        clearTimeout(this.diffTimeout);
      }
      // Throttle multiple changes within a short time
      this.diffTimeout = setTimeout(() => this.updateDecorations(), 250);
    }
  }

  /**
   * Handles document save to trigger automatic snapshots
   * @param document The saved document
   */
  private async handleDocumentSave(document: vscode.TextDocument): Promise<void> {
    const currentTime = Date.now();
    const filePath = document.uri.fsPath;

    // Get snapshot trigger settings from configuration
    const config = vscode.workspace.getConfiguration('sourceTracker.snapshots');
    const singleSaveTrigger = config.get<string>('triggers.onSave', 'off').replace('off','');
    const doubleSaveTrigger = config.get<string>('triggers.onDoubleSave', 'off').replace('off', '');
    const maxAutoSnapshots = config.get<number>('maxAutoSnapshots', 10);

    // Check if we need to take a snapshot - either on single save or double save
    const isDoubleSave = this.lastSavedFile === filePath &&
                        this.lastSavedTime &&
                        (currentTime - this.lastSavedTime) < 300;

    if ((singleSaveTrigger && !isDoubleSave) || (doubleSaveTrigger && isDoubleSave)) {
      // Double save detected, create a snapshot
      if (this.snapshotManager) {
        const content = document.getText();

        // Check if the active snapshot has the same content
        const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
        if (activeSnapshot && activeSnapshot.content === content) {
          this.debug.log(`Skipping snapshot creation - content unchanged from active snapshot`);
          vscode.window.showInformationMessage(`Snapshot unchanged for ${path.basename(filePath)}`);
          return;
        }

        const now = new Date();
        const formattedDate = now.toLocaleDateString();
        const formattedTime = now.toLocaleTimeString();

        const triggerType = isDoubleSave ? "double-save" : "single-save";

        // Always fetch git metadata for the snapshot
        const metadata = await this.gitManager.getGitMetadata(filePath);
        const snapshotId = this.snapshotManager.takeSnapshot(
          filePath,
          content,
          `* Auto-snapshot (${triggerType}, ${formattedDate} ${formattedTime})`,
          metadata
        );

        if (
          (isDoubleSave && doubleSaveTrigger === 'activate') ||
          (!isDoubleSave && singleSaveTrigger === 'activate') ||
          (!activeSnapshot || (activeSnapshot?.metadata?.message?.startsWith('*')) && ((isDoubleSave && doubleSaveTrigger === 'auto') || (!isDoubleSave && singleSaveTrigger === 'auto')))
        ) {
          this.snapshotManager.setActiveSnapshot(filePath, snapshotId);
        }

        this.debug.info(`Auto-created snapshot for ${triggerType} of file: ${filePath}`);
        vscode.window.showInformationMessage(`Snapshot created for ${path.basename(filePath)} (${triggerType})`);

        // Update decorations to reflect changes
        this.updateDecorations();
        this.updateActiveEditorContext();
      }
    }

    // Update tracking variables
    this.lastSavedFile = filePath;
    this.lastSavedTime = currentTime;
  }

  /**
   * Handles active editor changes to update decorations
   * @param editor The new active editor
   */
  private handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
    // Check if editor has an active snapshot and set context
    this.updateActiveEditorContext(editor);

    this.debug.log('Active editor changed.');
    if (editor) {
      this.debug.log(`New active file: ${editor.document.uri.fsPath}`);
      // Update decorations whenever the active editor changes
      // Attempt an initial decoration update
      if (this.diffTimeout) {
        clearTimeout(this.diffTimeout);
      }
      // Throttle multiple changes within a short time
      this.diffTimeout = setTimeout(() => this.updateDecorations(), 250);
    }
  }

  /**
   * Updates the VS Code context based on whether the active editor has an active snapshot
   * @param editor The active text editor or undefined
   */
  private updateActiveEditorContext(editor: vscode.TextEditor | undefined = undefined) {
    if (!editor) {
      editor = vscode.window.activeTextEditor;
    }

    // Check if editor is valid and not a debug configuration provider
    if (editor &&
        editor.document &&
        editor.document.uri &&
        editor.document.uri.scheme === 'file' &&
        this.snapshotManager) {
      const filePath = editor.document.uri.fsPath;
      const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);

      // Set context variable for when clauses
      vscode.commands.executeCommand(
        'setContext',
        'sourceTracker.hasActiveSnapshot',
        activeSnapshot !== undefined
      );

      this.debug.log(`Active editor has snapshot: ${activeSnapshot !== undefined}`);
    } else {
      // Clear context when no editor is active
      vscode.commands.executeCommand('setContext', 'sourceTracker.hasActiveSnapshot', false);
    }

    this.updateStatusBar();
  }

  /**
   * Updates the decorations in visible editors
   */
  private async updateDecorations() {
    this.debug.log('updateDecorations called.');
    this.debug.log(`Current baseRef: ${this.baseRef}`);

    for (const editor of vscode.window.visibleTextEditors) {
      // Skip non-file editors (output, terminal, etc.)
      if (editor.document.uri.scheme !== 'file') {
        this.debug.log(`Skipping non-file editor: ${editor.document.uri}`);
        continue;
      }
      const file = editor.document.uri.fsPath;
      this.debug.log(`Checking for active snapshot for file: ${file}`);

      if (this.snapshotManager && this.snapshotManager.getActiveSnapshot(file)) {
        this.debug.log('Active snapshot found, skipping baseRef check.');
        const diffs = await this.decorationManager.computeDiffForFileAsync(file);
        this.debug.log(`Computed diffs for active snapshot.`);
        this.decorationManager.applyDecorations(editor, diffs);
        continue;
      }

      if (!this.baseRef) {
        this.debug.log('baseRef is empty, clearing decorations.');
        this.decorationManager.clearDecorations();
        return;
      }

      this.debug.log(`Computing diff for file: ${file}`);
      const diffs = await this.decorationManager.computeDiffForFileAsync(file);
      this.debug.log(`Computed diffs.`);
      this.decorationManager.applyDecorations(editor, diffs);
    }
  }

  /**
   * Schedules an update of file explorer decorations with debouncing
   */
  private scheduleFileExplorerUpdate(immediate = false) {
    this.debug.log('Scheduling file explorer decoration update');
    if (this.fileExplorerTimeout) {
      clearTimeout(this.fileExplorerTimeout);
    }
    // Use a longer debounce time (2 seconds) for file explorer updates
    this.fileExplorerTimeout = setTimeout(() => this.updateFileExplorerDecorations(), immediate ? 100 : 1000);
  }

  /**
   * Updates the file explorer decorations by finding modified and added files
   * since the base ref.
   */
  private async updateFileExplorerDecorations() {
    this.debug.log('updateFileExplorerDecorations called.');

    if (!this.baseRef) {
      this.debug.log('No baseRef set, clearing file decorations');
      // Clear file explorer decorations
      this.decorationManager.clearFileDecorations();
      return;
    }

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      this.debug.warn('No workspace folders available for file explorer decorations');
      return;
    }

    try {
      // Get all modified and added files in all workspace folders
      const addedFiles: string[] = [];
      const modifiedFiles: string[] = [];

      for (const folder of vscode.workspace.workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.gitManager.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        const resolvedRef = await this.gitManager.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          this.debug.warn('Could not resolve base ref dynamically.');
          continue;
        }

        this.debug.log(`Getting file status against ref: ${resolvedRef} in ${gitRoot}`);

        // Get status of all files compared to base ref
        const { added, modified } = await this.gitManager.getChangedFilesAgainstRef(gitRoot, resolvedRef);

        // Add absolute paths
        addedFiles.push(...added.map(file => path.join(gitRoot, file)));
        modifiedFiles.push(...modified.map(file => path.join(gitRoot, file)));
      }

      this.debug.info(`Found ${addedFiles.length} added files and ${modifiedFiles.length} modified files`);

      // Set the decorations
      this.decorationManager.setFileDecorations(addedFiles, modifiedFiles);
    } catch (error) {
      this.debug.error(`Error updating file explorer decorations: ${error}`);
    }
  }

  /**
   * Opens all files that have been modified or added since the base ref
   * @param force Whether to bypass confirmation for opening many files
   */
  private async openTrackedFiles(force = false) {
    this.debug.log('openTrackedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.gitManager.getActiveWorkspaceFolder();
    this.debug.log(`Active workspace folder: ${activeWorkspaceFolder?.uri.fsPath || 'none'}`);

    if (!this.baseRef) {
      vscode.window.showInformationMessage('No tracking ref set. Please set a tracking ref first.');
      return;
    }

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showInformationMessage('No workspace folders available.');
      return;
    }

    try {
      // Get all modified and added files in all workspace folders
      const changedFiles: string[] = [];

      // Default behavior: only open files in the active workspace folder
      const workspaceFolders = activeWorkspaceFolder
        ? [activeWorkspaceFolder]
        : vscode.workspace.workspaceFolders;

      for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.gitManager.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for folder: ${folderPath}`);
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.gitManager.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          this.debug.warn('Could not resolve base ref dynamically.');
          continue;
        }

        // Get changed files against the resolved ref
        const { allChangedFiles } = await this.gitManager.getChangedFilesAgainstRef(gitRoot, resolvedRef);

        // Add absolute paths
        changedFiles.push(...allChangedFiles.map(file => path.join(gitRoot, file)));
      }

      await this.openChangedFilesList(changedFiles, force);
    } catch (error) {
      this.debug.error(`Error opening tracked files: ${error}`);
      vscode.window.showErrorMessage(`Error opening tracked files: ${error}`);
    }
  }

  /**
   * Opens all files that have been modified or added since the last commit
   * @param force Whether to bypass confirmation for opening many files
   */
  private async openChangedFiles(force = false) {
    this.debug.log('openChangedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.gitManager.getActiveWorkspaceFolder();
    this.debug.log(`Active workspace folder: ${activeWorkspaceFolder?.uri.fsPath || 'none'}`);

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showInformationMessage('No workspace folders available.');
      return;
    }

    try {
      // Get all modified and added files in relevant workspace folders
      const changedFiles: string[] = [];

      // Default behavior: only open files in the active workspace folder
      const workspaceFolders = activeWorkspaceFolder
        ? [activeWorkspaceFolder]
        : vscode.workspace.workspaceFolders;

      for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.gitManager.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        // Get changed files since HEAD
        const { allChangedFiles } = await this.gitManager.getChangedFilesAgainstRef(gitRoot, 'HEAD');

        // Add absolute paths
        changedFiles.push(...allChangedFiles.map(file => path.join(gitRoot, file)));
      }

      await this.openChangedFilesList(changedFiles, force);
    } catch (error) {
      this.debug.error(`Error opening changed files: ${error}`);
      vscode.window.showErrorMessage(`Error opening changed files: ${error}`);
    }
  }

  /**
   * Opens a list of changed files
   * @param changedFiles List of file paths to open
   * @param force Whether to bypass confirmation for opening many files
   */
  private async openChangedFilesList(changedFiles: string[], force = false) {
    // Open all changed files
    if (changedFiles.length === 0) {
      vscode.window.showInformationMessage('No changed files found.');
      return;
    }

    this.debug.info(`Opening ${changedFiles.length} changed files`);

    // Confirm with user before opening many files
    if (changedFiles.length > 10 && force !== true) {
      const confirmed = await vscode.window.showWarningMessage(
        `Are you sure you want to open ${changedFiles.length} files?`,
        'Yes', 'No'
      );
      if (confirmed !== 'Yes') {
        return;
      }
    }

    // Open each file
    for (const file of changedFiles) {
      try {
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        this.debug.error(`Error opening file ${file}: ${error}`);
      }
    }

    vscode.window.showInformationMessage(`Opened ${changedFiles.length} changed files.`);
  }

  /**
   * Diffs the current file against its tracked reference or snapshot
   */
  private async diffTrackedFile() {
    this.debug.log('diffTrackedFile called.');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor to diff.');
      return;
    }

    const filePath = editor.document.uri.fsPath;

    // Check if there's an active snapshot for this file first
    if (this.snapshotManager) {
      const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
      if (activeSnapshot) {
        this.debug.log(`Using active snapshot for diff: ${activeSnapshot.metadata.id}`);
        // Create a title for the diff view
        const title = `${path.basename(filePath)} (Snapshot: ${new Date(activeSnapshot.metadata.timestamp ?? 0).toLocaleString()})`;

        // Create a virtual document URI
        const baseContent = activeSnapshot.content;
        const virtualDocumentUri = vscode.Uri.parse(`sourcetracker-diff:/${path.basename(filePath)}?${Date.now()}`);

        // Register a content provider for the virtual document
        const contentProvider = vscode.workspace.registerTextDocumentContentProvider('sourcetracker-diff', {
          provideTextDocumentContent: (uri: vscode.Uri) => {
            return baseContent;
          }
        });

        // Add the content provider to subscriptions for cleanup
        this.context.subscriptions.push(contentProvider);

        // Open diff view with current editor on the left
        await vscode.commands.executeCommand(
          'vscode.diff',
          virtualDocumentUri,
          editor.document.uri,
          title
        );

        // Dispose the content provider after a delay to ensure the diff view has loaded
        setTimeout(() => {
          contentProvider.dispose();
        }, 30000); // 30 seconds

        return;
      }
    }

    if (!this.baseRef) {
      // Try to use standard Git commands if our custom functionality isn't available
      try {
        // Execute the built-in git.openChange command instead
        await vscode.commands.executeCommand('git.openChange');
        return;
      } catch (error) {
        this.debug.error(`Error using git.openChange: ${error}`);
        vscode.window.showInformationMessage('No tracking ref set. Please set a tracking ref first.');
        return;
      }
    }

    const gitRoot = this.gitManager.getGitRepoRoot(filePath);

    if (!gitRoot) {
      try {
        // Try built-in Git command as fallback
        await vscode.commands.executeCommand('git.openChange');
        return;
      } catch (error) {
        this.debug.error(`Error using git.openChange: ${error}`);
        vscode.window.showInformationMessage('File is not in a Git repository.');
        return;
      }
    }

    try {
      const relativePath = path.relative(gitRoot, filePath);
      this.debug.log(`Git root: ${gitRoot}, Relative path: ${relativePath}`);

      // Dynamically resolve base ref for this file
      const resolvedRef = await this.gitManager.resolveRefAsync(this.baseRef, gitRoot);
      if (!resolvedRef) {
        // Try built-in Git command as fallback
        try {
          await vscode.commands.executeCommand('git.openChange');
          return;
        } catch (error) {
          this.debug.error(`Error using git.openChange: ${error}`);
          vscode.window.showErrorMessage('Could not resolve tracking reference.');
        }
        return;
      }

      // Get content from the base ref
      const baseContentResult = await this.gitManager.runGitCommand(['show', `${resolvedRef}:${relativePath}`], gitRoot, false);

      // If the file doesn't exist in the base ref
      if (baseContentResult.status !== 0) {
        // Try built-in Git command as fallback
        try {
          await vscode.commands.executeCommand('git.openChange');
          return;
        } catch (error) {
          this.debug.error(`Error using git.openChange: ${error}`);
          vscode.window.showInformationMessage('File does not exist in the tracking reference.');
        }
        return;
      }

      // Create a title for the diff view
      const title = `${path.basename(filePath)} (${this.baseRef})`;

      // Create a virtual document URI
      const baseContent = baseContentResult.stdout;
      const virtualDocumentUri = vscode.Uri.parse(`sourcetracker-diff:/${path.basename(filePath)}?${Date.now()}`);

      // Register a content provider for the virtual document
      const contentProvider = vscode.workspace.registerTextDocumentContentProvider('sourcetracker-diff', {
        provideTextDocumentContent: (uri: vscode.Uri) => {
          return baseContent;
        }
      });

      // Add the content provider to subscriptions for cleanup
      this.context.subscriptions.push(contentProvider);

      // Open diff view with current editor on the left
      await vscode.commands.executeCommand(
        'vscode.diff',
        virtualDocumentUri,
        editor.document.uri,
        title
      );

      // Dispose the content provider after a delay to ensure the diff view has loaded
      setTimeout(() => {
        contentProvider.dispose();
      }, 30000); // 30 seconds

    } catch (error) {
      this.debug.error(`Error creating diff view: ${error}`);

      // Try built-in Git command as final fallback
      try {
        await vscode.commands.executeCommand('git.openChange');
      } catch (secondError) {
        this.debug.error(`Error using git.openChange fallback: ${secondError}`);
        vscode.window.showErrorMessage(`Error creating diff view: ${error}`);
      }
    }
  }

  /**
   * Stages a snapshot to git
   * @param filePath Path to the file
   * @param id Snapshot ID to stage
   */
  private stageSnapshot(filePath: string, id: string) {
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    this.gitManager.stageSnapshot(filePath, id, this.snapshotManager);
  }

  /**
   * Shows the base ref selection menu
   * @param serializedUri Optional URI to select a tracking reference for
   */
  private async selectBaseRef(serializedUri: any = undefined) {
    this.debug.log('selectBaseRef called.');

    // Get changed files count if base ref is set
    let trackedFilesCount = 0;
    if (this.baseRef) {
      const trackedFiles = await this.gitManager.getTrackedFilesCount(this.baseRef);
      trackedFilesCount = trackedFiles;
    }

    // Get changed files count since last commit (independent of baseRef)
    let changedFilesCount = 0;
    const changedFiles = await this.gitManager.getChangedFilesCount();
    changedFilesCount = changedFiles;

    // Get the last 3 commit hashes with their messages
    let recentCommits: vscode.QuickPickItem[] = [];

    // Get the workspace folders
    if (vscode.workspace.workspaceFolders?.length) {
      const folder = vscode.workspace.workspaceFolders[0];
      const gitRoot = this.gitManager.getGitRepoRoot(folder.uri.fsPath);

      if (gitRoot) {
        try {
          // Get the last 6 commits with hash and first line of message
          const commitsResult = await this.gitManager.runGitCommand(
            ['log', '-n', '6', '--pretty=format:"%h %cr - %s"'],
            gitRoot
          );

          if (commitsResult.status === 0) {
            const commits = commitsResult.stdout.split('\n').filter(line => line.trim());
            recentCommits = commits.map(commit => {
              const parts = commit.split(' ');
              const hash = parts[0];
              const message = parts.slice(1).join(' ');
              return {
                label: `$(blank)${hash}`,
                description: message.length > 80 ? message.substring(0, 77) + '...' : message,
                actionId: `commit:${hash}`
              };
            });
          }
        } catch (error) {
          this.debug.error(`Error getting recent commits: ${error}`);
        }
      }
    }

    // Define quick pick items with actionId
    const options: (vscode.QuickPickItem & { actionId?: string })[] = [
      { label: '$(circle-slash)', description: 'Disable tracking', actionId: 'disable-tracking' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '', description: 'Tracking Refs' },
      { label: '$(blank)BRANCH', description: 'Auto-detect branch tracking/main base', actionId: 'BRANCH' },
      { label: '$(blank)HEAD', description: 'Current checked out commit', actionId: 'HEAD' },
      { label: '$(blank)HEAD~1', description: 'Previous commit', actionId: 'HEAD~1' },
      { label: '$(blank)develop', description: 'Develop branch', actionId: 'develop' },
      { label: '$(blank)master or main', description: 'Main branch', actionId: 'master main trunk default' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      ...recentCommits,
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '', description: 'Tracking Actions' },
      { label: '$(files) Open tracked files', description: trackedFilesCount > 0 ? `Open ${trackedFilesCount} tracked file changes` : 'Open tracked file changes', actionId: 'open-tracked-files' },
      { label: '$(files) Open changed files', description: changedFilesCount > 0 ? `Open ${changedFilesCount} changed files since last commit` : 'Open changed files since last commit', actionId: 'open-changed-files' },
      { label: '$(sti-tracking-compare) Diff tracked file', description: 'Diff current file against tracked ref', actionId: 'diff-tracked-file' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(sti-snapshot-options-alt) Snapshot Tracking', description: 'Open snapshot tracking options', actionId: 'snapshot-tracking' },
      { label: '$(sti-tracking-options-alt) Display Options', description: 'Open tracking display options', actionId: 'display-options' }
    ];

    const commonActionIds = options.map(opt => opt.actionId)?.filter(Boolean);
    if (this.baseRef &&
      !commonActionIds.includes(`ref:${this.baseRef}`) &&
      !commonActionIds.includes(`commit:${this.baseRef}`) &&
      !commonActionIds.includes(this.baseRef)) {
      // Add the active base ref as the first option after the tracking refs section header
      const trackingRefsIndex = options.findIndex(item => item.description === 'Tracking Refs');
      if (trackingRefsIndex !== -1) {
        options.splice(trackingRefsIndex + 1, 0, { label: `$(triangle-right)${this.baseRef}`, description: 'Current tracking ref', actionId: `ref:${this.baseRef}` });
      } else {
        options.unshift({ label: `$(triangle-right)${this.baseRef}`, description: 'Current tracking ref', actionId: `ref:${this.baseRef}` });
      }
    }

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Select or type a git tracking base';
    quickPick.items = options;
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = false;

    // Set the current base ref as the active item if it exists
    if (this.baseRef) {
      // Find the item by actionId instead of label
      const currentItem = options.find(item =>
        item.actionId === `ref:${this.baseRef}` ||
        item.actionId === `commit:${this.baseRef}` ||
        item.actionId === this.baseRef);
      if (currentItem) {
        // Update the label icon from $(blank) to $(triangle-right)
        if (currentItem.label.startsWith('$(blank)')) {
          currentItem.label = currentItem.label.replace('$(blank)', '$(triangle-right)');
        }
        quickPick.activeItems = [currentItem];
      }
    } else {
      quickPick.activeItems = [options[0]];
    }
    quickPick.items = options;

    return new Promise<void>(resolve => {
      quickPick.onDidChangeValue(() => {
        // Refresh the list when user types, but keep the custom value at top
        const customItem = {
          label: quickPick.value,
          description: 'Custom commit hash or branch name',
          actionId: 'custom-ref'
        };
        const filteredItems = options.filter(item =>
          item.label.toLowerCase().includes(quickPick.value.toLowerCase())
        );

        // Only add custom item if it's not empty and not exactly matching an existing option
        if (quickPick.value && !options.some(item => item.label === quickPick.value)) {
          quickPick.items = [customItem, ...filteredItems];
        } else {
          quickPick.items = filteredItems;
        }
      });

      quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0] as (vscode.QuickPickItem & { actionId?: string });

        const actionId = selectedItem?.actionId || '';

        // Disable any active snapshot tracking for the current file before setting baseRef
        if (vscode.window.activeTextEditor) {
          if ((!selectedItem && !quickPick.value.trim() && quickPick.value.trim()) || (
            actionId.startsWith('ref:') || actionId.startsWith('commit:') || ['BRANCH', 'HEAD', 'HEAD~1', 'develop', 'master main trunk default', 'disable-tracking'].includes(actionId)
          )) {
            const currentFilePath = vscode.window.activeTextEditor.document.uri.fsPath;
            if (this.snapshotManager && this.snapshotManager.getActiveSnapshot(currentFilePath)) {
              this.debug.log(`Disabling snapshot tracking for ${currentFilePath} before setting baseRef`);
              this.snapshotManager.setActiveSnapshot(currentFilePath, undefined);
              this.updateActiveEditorContext();
            }
          }
        }

        if (!selectedItem) {
          // If no item is selected but there's input text - treat as custom ref
          if (quickPick.value.trim()) {
            this.baseRef = quickPick.value.trim();
            await this.setBaseRef(this.baseRef);
          }
          quickPick.hide();
          resolve();
          return;
        }

        if (actionId === 'disable-tracking') {
          // Disable tracking
          this.baseRef = '';
          await this.setBaseRef('');
        } else if (actionId === 'open-tracked-files') {
          // Open tracked files command
          vscode.commands.executeCommand('sourceTracker.openTrackedFiles', true);
        } else if (actionId === 'open-changed-files') {
          // Open changed files command
          vscode.commands.executeCommand('sourceTracker.openChangedFiles', true);
        } else if (actionId === 'diff-tracked-file') {
          // Diff tracked file command
          vscode.commands.executeCommand('sourceTracker.diffTrackedFile', true);
        } else if (actionId === 'snapshot-tracking') {
          // Open snapshot tracking options
          quickPick.hide();
          this.selectSnapshotTrackingOptions(serializedUri);
          return;
        } else if (actionId === 'display-options') {
          // Open display options
          quickPick.hide();
          vscode.commands.executeCommand('sourceTracker.displayOptions');
          return;
        } else if (actionId === 'custom-ref') {
          // Custom ref from input text
          this.baseRef = quickPick.value.trim();
          await this.setBaseRef(this.baseRef);
        } else if (actionId.startsWith('commit:')) {
          // Commit hash selected - extract the hash
          const commitHash = actionId.substring('commit:'.length);
          this.baseRef = commitHash;
          await this.setBaseRef(this.baseRef);
        } else if (actionId.startsWith('ref:')) {
          // Existing ref selected - extract the ref name
          const refName = actionId.substring('ref:'.length);
          this.baseRef = refName;
          await this.setBaseRef(this.baseRef);
        } else if (actionId) {
          // Other standard actions with specific actionId (branch, head, head~1, etc.)
          this.baseRef = actionId;
          await this.setBaseRef(this.baseRef);
        } else {
          // Handle items without an explicit actionId - use the label text
          // Remove any icon prefix like $(blank) first
          let refName = selectedItem.label.replace(/^\$\([^)]+\)/, '').trim();
          this.baseRef = refName;
          await this.setBaseRef(this.baseRef);
        }

        quickPick.hide();
        resolve();
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve();
      });

      quickPick.show();
    });
  }

  /**
   * Sets the base ref and updates UI and context
   * @param ref The reference to set as base
   */
  private async setBaseRef(ref: string) {
    // Persist the base ref to context
    await this.context.workspaceState.update('sourceTracker.trackingBaseRef', ref);
    this.debug.info(`Persisted baseRef to storage: ${ref}`);

    // Update the status bar with the new tracking reference
    this.updateStatusBar();

    // Update the VS Code context for when clauses
    await vscode.commands.executeCommand('setContext', 'sourceTracker.trackingBaseRef', ref);
    this.debug.log(`Updated context variable for when clauses: sourceTracker.trackingBaseRef = ${ref}`);

    if (!ref) {
      vscode.window.showInformationMessage('Tracking disabled.');
      this.debug.info('Base ref cleared. Tracking disabled.');
      this.decorationManager.clearDecorations();
      // Clear file explorer decorations
      this.decorationManager.clearFileDecorations();
      // Cancel any pending file explorer updates
      if (this.fileExplorerTimeout) {
        clearTimeout(this.fileExplorerTimeout);
        this.fileExplorerTimeout = undefined;
      }
    } else {
      vscode.window.showInformationMessage(`Tracking ref set to: ${ref}`);
      this.debug.info(`Base ref set to raw input: ${ref}`);
      this.updateDecorations();
      this.scheduleFileExplorerUpdate();
    }
  }

  /**
   * Shows the snapshot tracking options menu
   * @param serializedUri Optional URI to select a snapshot for
   */
  private async selectSnapshotTrackingOptions(serializedUri: any) {
    this.debug.log('selectSnapshotTrackingOptions called.');
    let documentUri: vscode.Uri | undefined;

    // Use the external property if available (this contains the fully qualified URI)
    if (serializedUri && typeof serializedUri === 'object' && 'external' in serializedUri) {
      documentUri = vscode.Uri.parse(serializedUri.external);
      this.debug.log('Using provided URI:', documentUri.toString());
    } else {
      // Fall back to the active editor if no URI was provided
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        documentUri = editor.document.uri;
        this.debug.log('Falling back to active editor URI:', documentUri.toString());
      } else {
        vscode.window.showInformationMessage('No document available to manage snapshots.');
        return;
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor to manage snapshots.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    this.debug.log(`Managing snapshots for file: ${filePath}`);

    // Get snapshots for this file
    const snapshots = this.snapshotManager?.getSnapshots(filePath) || [];
    const activeSnapshot = this.snapshotManager?.getActiveSnapshot(filePath);

    // Create QuickPickItems for each snapshot
    const snapshotItems: (vscode.QuickPickItem & { actionId?: string })[] = snapshots.map(snapshot => {
      // Check if this is the active snapshot
      const isActive = activeSnapshot && snapshot.metadata.id === activeSnapshot.metadata.id;
      return {
        label: isActive
          ? `$(triangle-right)${this.getRelativeTimeString(snapshot.metadata.timestamp ?? 0)}`
          : (activeSnapshot ? `$(blank)${this.getRelativeTimeString(snapshot.metadata.timestamp ?? 0)}` : `$(blank)${this.getRelativeTimeString(snapshot.metadata.timestamp ?? 0)}`),
        description: snapshot.metadata.message || 'No description',
        actionId: `snapshot:${snapshot.metadata.id}`
      };
    });

    const options: (vscode.QuickPickItem & { actionId?: string })[] = [
      ...(activeSnapshot ? [
        { label: '$(circle-slash)', description: 'Disable Snapshot', actionId: 'disable-snapshot' },
      ] : []),
      ... snapshotItems?.length ? [
        { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '', description: 'Snapshots', kind: vscode.QuickPickItemKind.Default }
      ] : [],
      ...snapshotItems,
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '', description: 'Snapshot Actions', kind: vscode.QuickPickItemKind.Default },
      ...(activeSnapshot ? [
        { label: '$(edit) Rename Snapshot', description: 'Update the snapshot message', actionId: 'rename-snapshot' },
        { label: '$(discard) Apply Snapshot', description: 'Restore file to snapshot state', actionId: 'apply-snapshot' },
        { label: '$(error) Delete Active Snapshot', description: 'Clear the current snapshot', actionId: 'delete-active-snapshot' },
      ] : []),
      { label: '$(clear-all) Delete File Snapshots', description: 'Clear all snapshots for this file', actionId: 'delete-all-snapshots' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '', description: 'Tracking Actions', kind: vscode.QuickPickItemKind.Default },
      { label: '$(device-camera) Take Snapshot', description: 'Type a message to take a new snapshot', actionId: 'take-snapshot' },
      { label: '$(sti-snapshot-compare) Diff tracked file', description: 'Diff current file against snapshot', actionId: 'diff-tracked-file' },
      { label: '$(source-control) Stage To Git', description: 'Stage current file snapshot content to Git', actionId: 'stage-snapshot' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(sti-tracking-base-alt) Git Tracking', description: 'Open git tracking options', actionId: 'git-tracking' },
      { label: '$(sti-tracking-options-alt) Display Options', description: 'Open tracking display options', actionId: 'display-options' }
    ];

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Select or type a snapshot option or message';
    quickPick.items = options;
    // Set currently active snapshot as selected if one exists
    if (activeSnapshot) {
      const activeItem = snapshotItems.find(item => item.actionId === `snapshot:${activeSnapshot.metadata.id}`);
      if (activeItem) {
        quickPick.activeItems = [activeItem];
      }
    } else {
      // Set "Take Snapshot" as the default option when no active snapshot exists
      const takeSnapshotItem = options.find(item => item.actionId === 'take-snapshot');
      if (takeSnapshotItem) {
        quickPick.activeItems = [takeSnapshotItem];
      }
    }
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = false;

    quickPick.onDidChangeValue(() => {
      // Refresh the list when user types, but keep the custom value at top
      const customItem = {
        label: quickPick.value,
        description: 'Take new snapshot',
        actionId: 'custom-snapshot'
      };
      const filteredItems = options.filter(item =>
        item.label.toLowerCase().includes(quickPick.value.toLowerCase())
      );

      // Only add custom item if it's not empty and not exactly matching an existing option
      if (quickPick.value && !options.some(item => item.label === quickPick.value)) {
        quickPick.items = [customItem, ...filteredItems];
      } else {
        quickPick.items = filteredItems;
      }
    });

    quickPick.onDidAccept(() => {
      this.debug.log('onDidAccept', quickPick.value, quickPick.items, quickPick.selectedItems);
      const selectedItem = quickPick.selectedItems[0] as (vscode.QuickPickItem & { actionId?: string });

      if (selectedItem) {
        const actionId = selectedItem.actionId;

        if (actionId === 'apply-snapshot') {
          this.applySnapshot(filePath);
        } else if (actionId === 'delete-active-snapshot') {
          this.clearSnapshot(filePath);
        } else if (actionId === 'delete-all-snapshots') {
          this.clearSnapshot(filePath, true);
        } else if (actionId === 'disable-snapshot') {
          this.deactivateSnapshot(filePath);
        } else if (actionId === 'stage-snapshot') {
          if (activeSnapshot) {
            this.stageSnapshot(filePath, activeSnapshot.metadata.id ?? '');
          } else {
            vscode.window.showErrorMessage('No active snapshot to stage');
          }
        } else if (actionId === 'diff-tracked-file') {
          this.diffTrackedFile();
        } else if (actionId === 'display-options') {
          quickPick.hide();
          vscode.commands.executeCommand('sourceTracker.displayOptions');
          return;
        } else if (actionId === 'git-tracking') {
          this.selectBaseRef(serializedUri);
        } else if (actionId === 'custom-snapshot' || actionId === 'take-snapshot') {
          // Only take snapshot if there's a message
          if (quickPick.value.trim()) {
            this.debug.log('SNAPSHOT >>> ', quickPick.value);
            this.takeNewSnapshot(filePath, quickPick.value);
          } else {
            // Prompt for a snapshot message
            vscode.window.showInputBox({
              prompt: 'Enter a message for the snapshot',
              placeHolder: 'Snapshot message',
              value: 'Snapshot'
            }).then(message => {
              if (message) {
                this.takeNewSnapshot(filePath, message);
              } else {
                vscode.window.showWarningMessage('Snapshot creation cancelled: No name provided.');
              }
            });
          }
        } else if (actionId === 'rename-snapshot') {
          if (activeSnapshot) {
            this.renameSnapshot(filePath, activeSnapshot.metadata.id ?? '');
          } else {
            vscode.window.showErrorMessage('No active snapshot to rename');
          }
        } else if (actionId && actionId.startsWith('snapshot:')) {
          // A specific snapshot was selected - activate it
          const snapshotId = actionId.substring('snapshot:'.length);
          if (this.snapshotManager) {
            this.snapshotManager.setActiveSnapshot(filePath, snapshotId);
            this.updateStatusBar();
            vscode.window.showInformationMessage(`Activated snapshot: ${selectedItem.description}`);
            this.updateActiveEditorContext();
            this.updateDecorations();
          }
        }
      } else if (quickPick.value.trim()) {
        this.debug.log('SNAPSHOT >>> ', quickPick.value);
        // No item selected but there's input text - treat as new snapshot
        this.takeNewSnapshot(filePath, quickPick.value);
      }
      quickPick.hide();
    });

    quickPick.show();
  }

  /**
   * Takes a new snapshot of the current file
   * @param filePath Path to the file
   * @param message Message to describe the snapshot
   * @param isAuto Whether this is an automatic snapshot
   */
  private async takeNewSnapshot(filePath: string, message: string, isAuto = false) {
    this.debug.log(`takeNewSnapshot called with filePath: ${filePath}, message: ${message}`);
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.fsPath !== filePath) {
      vscode.window.showErrorMessage('Cannot take snapshot: file not open in editor');
      return;
    }

    try {
      // Get content from the current editor
      const content = editor.document.getText();

      // Use the correct method: takeSnapshot
      const metadata = await this.gitManager.getGitMetadata(filePath);
      const snapshotId = this.snapshotManager.takeSnapshot(filePath, content, message, metadata);

      // Set it as the active snapshot
      this.snapshotManager.setActiveSnapshot(filePath, snapshotId);

      vscode.window.showInformationMessage(`Snapshot created for ${path.basename(filePath)}`);
      this.debug.info(`Created new snapshot for file: ${filePath} with message: ${message}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after taking new snapshot
      this.updateActiveEditorContext(editor);
    } catch (error) {
      this.debug.error(`Error taking snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to take snapshot: ${error}`);
    }
  }

  /**
   * Applies a snapshot to the current file
   * @param filePath Path to the file
   */
  private async applySnapshot(filePath: string) {
    this.debug.info(`applySnapshot called for file: ${filePath}`);
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
    if (!activeSnapshot) {
      vscode.window.showInformationMessage('No active snapshot to apply');
      return;
    }

    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.fsPath !== filePath) {
        vscode.window.showErrorMessage('Cannot apply snapshot: file not open in editor');
        return;
      }

      // Confirm with user before apply snapshot
      const confirmed = await vscode.window.showWarningMessage(
        `This will replace the current file content with the snapshot from ${new Date(activeSnapshot.metadata.timestamp ?? 0).toLocaleString()}. Continue?`,
        { modal: true },
        'Yes', 'No'
      );

      if (confirmed !== 'Yes') {
        this.debug.info(`User cancelled apply snapshot`);
        return;
      }

      // Create a backup of the current content first
      const currentContent = editor.document.getText();

      const metadata = await this.gitManager.getGitMetadata(filePath);
      this.snapshotManager.takeSnapshot(filePath, currentContent, "* Auto Backup", metadata);

      // Replace the editor content with the snapshot content
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(editor.document.lineCount, 0)
      );
      edit.replace(editor.document.uri, fullRange, activeSnapshot.content);

      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`Applied snapshot: ${new Date(activeSnapshot.metadata.timestamp ?? 0).toLocaleString()}`);
      this.debug.info(`Applied snapshot: ${filePath}`);

      // Update context after applying snapshot
      this.updateActiveEditorContext(editor);
    } catch (error) {
      this.debug.error(`Error applying snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to apply snapshot: ${error}`);
    }
  }

  /**
   * Clears a snapshot or all snapshots for a file
   * @param filePath Path to the file
   * @param allForFile Whether to clear all snapshots for the file
   */
  private async clearSnapshot(filePath: string, allForFile = false) {
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    try {
      if (allForFile) {
        // Show a warning modal for confirmation before deleting all snapshots
        const confirmed = await vscode.window.showWarningMessage(
          `Are you sure you want to delete ALL snapshots for ${path.basename(filePath)}? This cannot be undone.`,
          { modal: true },
          'Yes, Delete All', 'Cancel'
        );

        if (confirmed !== 'Yes, Delete All') {
          this.debug.info(`User cancelled deletion of all snapshots for ${filePath}`);
          return;
        }
        this.snapshotManager.clearSnapshots(filePath);
      } else {
        const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
        if (activeSnapshot) {
          this.snapshotManager.deleteSnapshot(filePath, activeSnapshot.metadata.id ?? '');
        } else {
          vscode.window.showInformationMessage('No active snapshot to clear');
        }
      }
      vscode.window.showInformationMessage(`Snapshots cleared for ${path.basename(filePath)}`);
      this.debug.info(`Cleared snapshots for file: ${filePath}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after clearing snapshots
      this.updateActiveEditorContext();
    } catch (error) {
      this.debug.error(`Error clearing snapshots: ${error}`);
      vscode.window.showErrorMessage(`Failed to clear snapshots: ${error}`);
    }
  }

  /**
   * Deactivates the current snapshot for a file
   * @param filePath Path to the file
   */
  private deactivateSnapshot(filePath: string) {
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    try {
      this.snapshotManager.setActiveSnapshot(filePath, undefined);
      vscode.window.showInformationMessage(`Snapshot tracking deactivated for ${path.basename(filePath)}`);
      this.debug.info(`Deactivated snapshot tracking for file: ${filePath}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after deactivating snapshot
      this.updateActiveEditorContext();
    } catch (error) {
      this.debug.error(`Error deactivating snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to deactivate snapshot: ${error}`);
    }
  }

  /**
   * Renames the active snapshot for a file
   * @param filePath Path to the file
   * @param id ID of the snapshot to rename
   */
  private renameSnapshot(filePath: string, id: string) {
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    try {
      // Get the snapshot by ID
      const snapshot = this.snapshotManager.getSnapshotById(filePath, id);
      if (!snapshot) {
        vscode.window.showErrorMessage(`Snapshot not found: ${id}`);
        return;
      }

      // Prompt for a new message
      vscode.window.showInputBox({
        prompt: 'Enter a new message for the snapshot',
        placeHolder: 'Snapshot message',
        value: snapshot.metadata.message || ''
      }).then(newMessage => {
        if (newMessage !== undefined) { // User didn't cancel
          // Update the snapshot message
          if (this.snapshotManager) {
            this.snapshotManager.updateSnapshotMessage(filePath, id, newMessage);
            vscode.window.showInformationMessage(`Snapshot message updated`);
            this.debug.info(`Updated message for snapshot ${id} of file: ${filePath}`);
          }
        }
      });
    } catch (error) {
      this.debug.error(`Error renaming snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to rename snapshot: ${error}`);
    }
  }
}
