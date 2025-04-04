import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as Diff from 'diff';

interface DiffRange {
  startLine: number;
  endLine: number;
}

// Define a custom interface that extends FileDecorationProvider
interface CustomFileDecorationProvider extends vscode.FileDecorationProvider {
  setFiles(files: string[]): void;
}

class VirtualGitDiff {
  private baseRef: string;
  private useTreeColor: Boolean = true;
  private addedLineDecoration!: vscode.TextEditorDecorationType;
  private createdLineDecoration!: vscode.TextEditorDecorationType;
  private removedLineDecoration!: vscode.TextEditorDecorationType;
  private changedLineDecoration!: vscode.TextEditorDecorationType;
  private addedFileDecoration!: CustomFileDecorationProvider;
  private modifiedFileDecoration!: CustomFileDecorationProvider;
  private diffTimeout?: NodeJS.Timeout;
  private snapshotManager?: SnapshotManager;

  // Create an output channel for logging
  private outputChannel: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    // Initialize the channel
    this.outputChannel = vscode.window.createOutputChannel('SourceTools');

    // Load the persisted base ref from context, or default to empty string
    this.baseRef = this.context.workspaceState.get<string>('sourceTools.trackingBaseRef', '');

    // Load the persisted base ref from context, or default to empty string
    this.useTreeColor = this.context.workspaceState.get<boolean>('sourceTools.useTreeColor', true);

    // Let's log an initial message
    console.log('[SourceTools] Extension constructor called.');
    console.log(`[SourceTools] Loaded baseRef from storage: ${this.baseRef}`);
    // Initialize the context variable for when clauses
    vscode.commands.executeCommand('setContext', 'sourceTools.trackingBaseRef', this.baseRef);
    console.log(`[SourceTools] Initialized context variable: sourceTools.trackingBaseRef = ${this.baseRef}`);
    this.initDecorations();

    // Initialize snapshot manager when a workspace is available
    if (vscode.workspace.workspaceFolders?.length) {
      this.snapshotManager = new SnapshotManager(vscode.workspace.workspaceFolders[0].uri.fsPath);
      console.log(`[SourceTools] Initialized snapshot manager for workspace: ${vscode.workspace.workspaceFolders[0].uri.fsPath}`);
    }

  }

  private initDecorations() {
    this.removedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-removed.svg')),
      gutterIconSize: 'contain',
      // overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerColor: 'rgba(225, 66, 64, 0.25)', // Red with 0.25 opacity
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    this.changedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-changed.svg')),
      gutterIconSize: 'contain',
      // overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerColor: 'rgba(66, 133, 244, 0.25)', // Blue with 0.25 opacity
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    this.addedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-added.svg')),
      gutterIconSize: 'contain',
      // overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerColor: 'rgba(82, 183, 136, 0.25)', // Green with 0.25 opacity
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    this.createdLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-created.svg')),
      gutterIconSize: 'contain',
      // overviewRulerColor: 'rgba(140, 212, 105, 0.1)'
      // overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      // overviewRulerLane: vscode.OverviewRulerLane.Left
    });

    // Create file decorations for the explorer
    this.addedFileDecoration = this.createFileDecorationProvider('a', new vscode.ThemeColor('gitDecoration.addedResourceForeground')) as CustomFileDecorationProvider;
    this.modifiedFileDecoration = this.createFileDecorationProvider('m', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')) as CustomFileDecorationProvider;
  }

  /**
   * Creates a file decoration provider with the specified badge and color
   */
  private createFileDecorationProvider(
    badge: string,
    color: vscode.ThemeColor
  ): vscode.FileDecorationProvider {
    // Create a map to track decorated files
    const decoratedFiles = new Map<string, vscode.FileDecoration>();

    // Create event emitter for file decoration changes
    const fileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

    // Create the provider object
    const provider = {
      provideFileDecoration: (uri: vscode.Uri): vscode.FileDecoration | undefined => {
        return decoratedFiles.get(uri.fsPath);
      },

      onDidChangeFileDecorations: fileDecorationsEmitter.event,

      // Custom method to update decorated files
      setFiles: (files: string[]): void => {
        decoratedFiles.clear();
        files.forEach(file => {
          if (this.useTreeColor) {
            decoratedFiles.set(file, {
              badge,
              color
            });
          } else {
            decoratedFiles.set(file, {
              badge
            });
          }
        });
        // Trigger a refresh of decorations
        fileDecorationsEmitter.fire(undefined);
      }
    };

    return provider;
  }

  /**
   * Finds the git repository root for a given file path
   * @param filePath The path to the file
   * @returns The path to the git repository root, or undefined if not in a git repository
   */
  private getGitRepoRoot(filePath: string): string | undefined {
    console.log(`[SourceTools] getGitRepoRoot called with filePath: ${filePath}`);

    // First check if the current directory is a git repo
    const currentPath = path.resolve(filePath);
    const currentDir = fs.statSync(currentPath).isDirectory() ? currentPath : path.dirname(currentPath);

    // Check if the current directory itself has a .git folder
    const gitDir = path.join(currentDir, '.git');
    if (fs.existsSync(gitDir)) {
      console.log(`[SourceTools] Found .git at current directory: ${gitDir}`);
      return currentDir;
    }

    // If not, start walking up the directory tree
    let parentDir = currentDir;
    const root = path.parse(parentDir).root;

    while (parentDir !== root) {
      const parentGitDir = path.join(parentDir, '.git');
      if (fs.existsSync(parentGitDir)) {
        console.log(`[SourceTools] Found .git at: ${parentGitDir}`);
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
      console.log(`[SourceTools] Found .git at root: ${root}`);
      return root;
    }

    console.log('[SourceTools] Did not find Git repo root.');
    return undefined;
  }

  public activate() {
    console.log('[SourceTools] Activating extension...');

    this.context.subscriptions.push(
      vscode.commands.registerCommand('sourceTools.gitTrackingOptions', (...args) => {
        console.log('>>> sourceTools.gitTrackingOptions', args);
        this.selectBaseRef();
      }),
      vscode.commands.registerCommand('sourceTools.diffTrackedFile', (...args) => {
        console.log('>>> sourceTools.diffTrackedFile', args);
        this.diffTrackedFile();
      }),
      vscode.commands.registerCommand('sourceTools.diffFileSnapshot', (...args) => {
        console.log('>>> sourceTools.diffFileSnapshot', args);
        this.diffTrackedFile(); // diffTrackedFile should show a diff agaisnt active snapshot if any, so no need for a separate function
      }),
      vscode.commands.registerCommand('sourceTools.snapshotTrackingOptions', (...args) => {
        console.log('>>> sourceTools.snapshotTrackingOptions', ...args);
        this.selectSnapshotTrackingOptions(args[0]);
      }),
      vscode.commands.registerCommand('sourceTools.openChangedFiles', (force) => this.openChangedFiles(force)),
      vscode.commands.registerCommand('sourceTools.openTrackedFiles', (force) => this.openTrackedFiles(force)),
      vscode.commands.registerCommand('sourceTools.toggleTreeColor', async () => {
        this.useTreeColor = !this.useTreeColor;
        await this.context.workspaceState.update('sourceTools.useTreeColor', this.useTreeColor);
        this.scheduleFileExplorerUpdate(true);
      }),
      vscode.workspace.onDidChangeTextDocument(e => this.handleDocChange(e)),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleFileExplorerUpdate()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.handleActiveEditorChange(editor))
    );

    // Register the file decoration providers
    this.context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this.addedFileDecoration),
      vscode.window.registerFileDecorationProvider(this.modifiedFileDecoration)
    );

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
    }, 1000);
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

  private async selectSnapshotTrackingOptions(serializedUri: any) {
    console.log('[SourceTools] selectSnapshotTrackingOptions called.');
    let documentUri: vscode.Uri | undefined;

    // Use the external property if available (this contains the fully qualified URI)
    if (serializedUri && typeof serializedUri === 'object' && 'external' in serializedUri) {
      documentUri = vscode.Uri.parse(serializedUri.external);
      console.log('[SourceTools] Using provided URI:', documentUri.toString());
    } else {
      // Fall back to the active editor if no URI was provided
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        documentUri = editor.document.uri;
        console.log('[SourceTools] Falling back to active editor URI:', documentUri.toString());
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
    console.log(`[SourceTools] Managing snapshots for file: ${filePath}`);

    // Get snapshots for this file
    const snapshots = this.snapshotManager?.getSnapshots(filePath) || [];
    const activeSnapshot = this.snapshotManager?.getActiveSnapshot(filePath);

    // Create QuickPickItems for each snapshot
    const snapshotItems: vscode.QuickPickItem[] = snapshots.map(snapshot => {
      // Check if this is the active snapshot
      const isActive = activeSnapshot && snapshot.id === activeSnapshot.id;
      return {
        label: isActive ? `$(triangle-right) ${this.getRelativeTimeString(snapshot.timestamp)}` : (activeSnapshot ? `$(blank) ${this.getRelativeTimeString(snapshot.timestamp)}` : `${this.getRelativeTimeString(snapshot.timestamp)}`),
        description: snapshot.message || 'No description',
        id: snapshot.id
      };
    });

    // the separators are putting the lavbels over the items, instead of space betweeen!!!
    const options: vscode.QuickPickItem[] = [
      ...(activeSnapshot ? [
        { label: '$(close)', description: 'Deactivate Snapshot' },
      ] : []),
      ... snapshotItems?.length ? [
        { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '', description: 'Snapshots', kind: vscode.QuickPickItemKind.Default }
      ] : [],
      ...snapshotItems,
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '', description: 'Snapshot Actions', kind: vscode.QuickPickItemKind.Default },
      { label: 'Delete Active Snapshot', description: 'Clear the current snapshot' },
      { label: 'Delete File Snapshots', description: 'Clear all file snapshots' },
      { label: 'Restore From Snapshot', description: 'Restore file from snapshot state' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Take Snapshot', description: 'Type a message to take a new snapshot' }
    ];

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Select or type a snapshot option or message';
    quickPick.items = options;
    // Set currently active snapshot as selected if one exists
    if (activeSnapshot) {
      const activeItem = snapshotItems.find(item => 'id' in item && item.id === activeSnapshot.id);
      if (activeItem) {
        quickPick.activeItems = [activeItem];
      }
    } else {
      // Set "Take Snapshot" as the default option when no active snapshot exists
      const takeSnapshotItem = options.find(item => item.label === 'Take Snapshot');
      if (takeSnapshotItem) {
        quickPick.activeItems = [takeSnapshotItem];
      }
    }
    quickPick.title = 'Source Tools: Manage Snapshots';
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = false;

    quickPick.onDidChangeValue(() => {
      // Refresh the list when user types, but keep the custom value at top
      const customItem = { label: quickPick.value, description: 'Take new snapshot' };
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
      console.log('onDidAccept', quickPick.value, quickPick.items, quickPick.selectedItems)
      const selectedItem = quickPick.selectedItems[0];
      if (selectedItem) {
        if (selectedItem.label === 'Restore From Snapshot') {
          this.restoreFromSnapshot(filePath);
        } else if (selectedItem.label === 'Delete Active Snapshot') {
          this.clearSnapshot(filePath);
        } else if (selectedItem.label === 'Delete File Snapshots') {
          this.clearSnapshot(filePath, true);
        } else if (selectedItem.description === 'Deactivate Snapshot') {
          this.deactivateSnapshot(filePath);
        } else if (selectedItem.description === 'Take new snapshot' || selectedItem.label === 'Take Snapshot') {
          // Only take snapshot if there's a message
          if (quickPick.value.trim()) {
            console.log('SNAPSHOT >>> ', quickPick.value)
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
        } else {
          // A specific snapshot was selected - activate it
          if ('id' in selectedItem && this.snapshotManager) {
            this.snapshotManager.setActiveSnapshot(filePath, 'id' in selectedItem ? selectedItem.id?.toString() : undefined);
            vscode.window.showInformationMessage(`Activated snapshot: ${selectedItem.description}`);
            this.updateActiveEditorContext();
            this.updateDecorations();
          }
        }
      } else if (quickPick.value.trim()) {
        console.log('SNAPSHOT >>> ', quickPick.value)
        // No item selected but there's input text - treat as new snapshot
        this.takeNewSnapshot(filePath, quickPick.value);
      }
      quickPick.hide();
    });

    quickPick.show();
  }

  private async restoreFromSnapshot(filePath: string) {
    console.log(`[SourceTools] restoreFromSnapshot called for file: ${filePath}`);
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
    if (!activeSnapshot) {
      vscode.window.showInformationMessage('No active snapshot to restore from');
      return;
    }

    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.fsPath !== filePath) {
        vscode.window.showErrorMessage('Cannot restore snapshot: file not open in editor');
        return;
      }

      // Confirm with user before restoring from snapshot
      const confirmed = await vscode.window.showWarningMessage(
        `This will replace the current file content with the snapshot from ${new Date(activeSnapshot.timestamp).toLocaleString()}. Continue?`,
        { modal: true },
        'Yes', 'No'
      );

      if (confirmed !== 'Yes') {
        console.log(`[SourceTools] User cancelled restore from snapshot`);
        return;
      }

      // Create a backup of the current content first
      const currentContent = editor.document.getText();
      this.snapshotManager.takeSnapshot(filePath, currentContent, "Backup Snapshot");

      // Replace the editor content with the snapshot content
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(editor.document.lineCount, 0)
      );
      edit.replace(editor.document.uri, fullRange, activeSnapshot.content);

      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`Restored from snapshot: ${new Date(activeSnapshot.timestamp).toLocaleString()}`);
      console.log(`[SourceTools] Restored file from snapshot: ${filePath}`);

      // Update context after restoring from snapshot
      this.updateActiveEditorContext(editor);
    } catch (error) {
      console.error(`[SourceTools] Error restoring from snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to restore from snapshot: ${error}`);
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
        'sourceTools.hasActiveSnapshot',
        activeSnapshot !== undefined
      );

      console.log(`[SourceTools] Active editor has snapshot: ${activeSnapshot !== undefined}`);
    } else {
      // Clear context when no editor is active
      vscode.commands.executeCommand('setContext', 'sourceTools.hasActiveSnapshot', false);
    }
  }

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
          console.log(`[SourceTools] User cancelled deletion of all snapshots for ${filePath}`);
          return;
        }
        this.snapshotManager.clearSnapshots(filePath);
      } else {
        const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
        if (activeSnapshot) {
          this.snapshotManager.deleteSnapshot(filePath, activeSnapshot.id);
        } else {
          vscode.window.showInformationMessage('No active snapshot to clear');
        }
      }
      vscode.window.showInformationMessage(`Snapshots cleared for ${path.basename(filePath)}`);
      console.log(`[SourceTools] Cleared snapshots for file: ${filePath}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after clearing snapshots
      this.updateActiveEditorContext();
    } catch (error) {
      console.error(`[SourceTools] Error clearing snapshots: ${error}`);
      vscode.window.showErrorMessage(`Failed to clear snapshots: ${error}`);
    }
  }

  private deactivateSnapshot(filePath: string) {
    if (!this.snapshotManager) {
      vscode.window.showErrorMessage('Snapshot manager is not initialized');
      return;
    }

    try {
      this.snapshotManager.setActiveSnapshot(filePath, undefined);
      vscode.window.showInformationMessage(`Snapshot tracking deactivated for ${path.basename(filePath)}`);
      console.log(`[SourceTools] Deactivated snapshot tracking for file: ${filePath}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after deactivating snapshot
      this.updateActiveEditorContext();
    } catch (error) {
      console.error(`[SourceTools] Error deactivating snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to deactivate snapshot: ${error}`);
    }
  }

  private takeNewSnapshot(filePath: string, message: string) {
    console.log(`[SourceTools] takeNewSnapshot called with filePath: ${filePath}, message: ${message}`);
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
      const snapshotId = this.snapshotManager.takeSnapshot(filePath, content, message);

      // Set it as the active snapshot
      this.snapshotManager.setActiveSnapshot(filePath, snapshotId);

      vscode.window.showInformationMessage(`Snapshot created for ${path.basename(filePath)}`);
      console.log(`[SourceTools] Created new snapshot for file: ${filePath} with message: ${message}`);

      // Update decorations to reflect changes
      this.updateDecorations();

      // Update context after taking new snapshot
      this.updateActiveEditorContext(editor);
    } catch (error) {
      console.error(`[SourceTools] Error taking snapshot: ${error}`);
      vscode.window.showErrorMessage(`Failed to take snapshot: ${error}`);
    }
  }

  private handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
    // Check if editor has an active snapshot and set context
    this.updateActiveEditorContext(editor);

    console.log('[SourceTools] Active editor changed.');
    if (editor) {
      console.log(`[SourceTools] New active file: ${editor.document.uri.fsPath}`);
      // Update decorations whenever the active editor changes
      // Attempt an initial decoration update
      if (this.diffTimeout) {
        clearTimeout(this.diffTimeout);
      }
      // Throttle multiple changes within a short time
      this.diffTimeout = setTimeout(() => this.updateDecorations(), 250);
    }
  }

  private handleDocChange(event: vscode.TextDocumentChangeEvent) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && event.document === activeEditor.document) {
      if (this.diffTimeout) {
        clearTimeout(this.diffTimeout);
      }
      // Throttle multiple changes within a short time
      this.diffTimeout = setTimeout(() => this.updateDecorations(), 250);
    }
  }

  private runGitCommand(args: string[], cwd: string, trimOutput = true): Promise<{ stdout: string; stderr: string; status: number }> {
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

  private async resolveRefAsync(inputRef: string, cwd: string): Promise<string | null> {
    const ref = inputRef.trim();
    console.log(`[SourceTools] Resolving base ref: "${ref}" in ${cwd}`);

    if (ref.toUpperCase() === 'HEAD') {
      return 'HEAD';
    }

    if (ref.toUpperCase() === 'BRANCH') {
      try {
        // First, try to get the tracked upstream branch
        const currentBranch = await this.runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

        if (currentBranch.stdout === 'HEAD') {
          console.log(`[SourceTools] Detached HEAD state - using HEAD~1`);
          return 'HEAD~1';
        }

        // Try to get the upstream branch
        const upstream = await this.runGitCommand(
          ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${currentBranch.stdout.trim()}`],
          cwd
        );

        if (upstream.stdout.trim()) {
          console.log(`[SourceTools] Found upstream branch: ${upstream.stdout.trim()}`);
          // Find the merge-base (common ancestor) between the current branch and the upstream
          const mergeBase = await this.runGitCommand(
            ['merge-base', 'HEAD', upstream.stdout.trim()],
            cwd
          );

          if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
            console.log(`[SourceTools] Using merge-base with upstream: ${mergeBase.stdout.trim()}`);
            return mergeBase.stdout.trim();
          }

          return upstream.stdout.trim(); // Fallback to upstream if merge-base fails
        }

        // No upstream, try main/master
        for (const baseBranch of ['origin/main', 'origin/master', 'main', 'master']) {
          const branchExists = await this.runGitCommand(['rev-parse', '--verify', baseBranch], cwd);
          if (branchExists.status === 0) {
            console.log(`[SourceTools] Using ${baseBranch} as base`);
            // Find the merge-base (common ancestor) between the current branch and the base branch
            const mergeBase = await this.runGitCommand(
              ['merge-base', 'HEAD', baseBranch],
              cwd
            );

            if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
              console.log(`[SourceTools] Using merge-base with ${baseBranch}: ${mergeBase.stdout.trim()}`);
              return mergeBase.stdout.trim();
            }

            return baseBranch; // Fallback to the branch itself if merge-base fails
          }
        }

        // If we can't find any good base, just use parent commit
        console.log(`[SourceTools] No suitable base branch found - using HEAD~1`);
        const parentCheck = await this.runGitCommand(['rev-parse', '--verify', 'HEAD~1'], cwd);
        if (parentCheck.status === 0) {
          return 'HEAD~1';
        }

        // Last resort
        return 'HEAD';

      } catch (error) {
        console.error(`[SourceTools] Error resolving branch ref:`, error);
        return 'HEAD';
      }
    }

    if (ref.includes(' ')) {
      const candidates = ref.split(' ');
      for (const candidate of candidates) {
        const result = await this.resolveRefAsync(candidate.trim(), cwd);
        if (result) {
          console.log(`[SourceTools] Found matching ref: ${result} from input: ${candidate}`);
          return result;
        }
      }
      return null;
    }

    try {
      const revParseResult = await this.runGitCommand(['rev-parse', ref], cwd);
      return revParseResult.status === 0 ? revParseResult.stdout.trim() : null;
    } catch (error) {
      console.error(`[SourceTools] Error resolving ref ${ref}:`, error);
      return null;
    }
  }

  /**
   * Gets the count of files that have changed since the base ref
   * @returns Promise with the number of changed files
   */
  private async getTrackedFilesCount(): Promise<number> {
    if (!this.baseRef) {
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
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
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
      console.error(`[SourceTools] Error getting changed files count: ${error}`);
      return 0;
    }
  }

  private async getChangedFilesCount(): Promise<number> {
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
      console.error(`[SourceTools] Error getting changed files count since last commit: ${error}`);
      return 0;
    }
  }

  private async selectBaseRef() {
    console.log('[SourceTools] selectBaseRef called.');

    // Get changed files count if base ref is set
    let trackedFilesCount = 0;
    if (this.baseRef) {
      const trackedFiles = await this.getTrackedFilesCount();
      trackedFilesCount = trackedFiles;
    }

    // Get changed files count if base ref is set
    let changedFilesCount = 0;
    const changedFiles = await this.getChangedFilesCount();
    changedFilesCount = changedFiles;



    // Get the last 3 commit hashes with their messages
    let recentCommits: vscode.QuickPickItem[] = [];

    // Get the workspace folders
    if (vscode.workspace.workspaceFolders?.length) {
      const folder = vscode.workspace.workspaceFolders[0];
      const gitRoot = this.getGitRepoRoot(folder.uri.fsPath);

      if (gitRoot) {
        try {
          // Get the last 3 commits with hash and first line of message
          const commitsResult = await this.runGitCommand(
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
                label: hash,
                description: message.length > 80 ? message.substring(0, 77) + '...' : message
              };
            });
          }
        } catch (error) {
          console.error(`[SourceTools] Error getting recent commits: ${error}`);
        }
      }
    }

    // Define common options
    const commonOptions: vscode.QuickPickItem[] = [
      { label: '', description: 'Disable tracking' },
      { label: 'BRANCH', description: 'Auto-detect branch tracking/main base' },
      { label: 'HEAD', description: 'Current checked out commit' },
      { label: 'HEAD~1', description: 'Previous commit' },
      { label: 'develop', description: 'Develop branch' },
      { label: 'master main', description: 'Main branch' },
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      ...recentCommits,
      { label: '', description: '', kind: vscode.QuickPickItemKind.Separator },
      { label: this.useTreeColor ? 'Disable file color' : 'Enable file color', description: 'Toggle tracking colors in file tree' },
      { label: 'Open tracked files', description: trackedFilesCount > 0 ? `Open ${trackedFilesCount} tracked file changes` : 'Open tracked file changes' },
      { label: 'Open changed files', description: changedFilesCount > 0 ? `Open ${changedFilesCount} changed files since last commit` : 'Open changed files since last commit' },
      { label: 'Diff tracked file', description: 'Diff current file against tracked ref' }
    ];

    // Add current base ref to options if it exists and isn't already in the list
    const commonLabels = commonOptions.map(opt => opt.label);
    if (this.baseRef && !commonLabels.includes(this.baseRef)) {
      commonOptions.unshift({ label: this.baseRef, description: 'Current base ref' });
    }

    // Create quick pick with input box and set current ref as active item
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Select or type a git tracking base';
    quickPick.items = commonOptions;
    quickPick.title = 'Source Tools: Select Git Tracking Base';
    quickPick.canSelectMany = false;

    // Set the current base ref as the active item if it exists
    if (this.baseRef) {
      const currentItem = commonOptions.find(item => item.label === this.baseRef);
      if (currentItem) {
        quickPick.activeItems = [currentItem];
      }
    } else {
      quickPick.activeItems = [commonOptions[0]];
    }

    // Make it accept custom input
    quickPick.ignoreFocusOut = false;

    let input: string | undefined;

    // Create promise to handle selection
    const promise = new Promise<string | undefined>(resolve => {
      quickPick.onDidChangeValue(() => {
        // Refresh the list when user types, but keep the custom value at top
        const customItem = { label: quickPick.value, description: 'Custom commit hash or branch name' };
        const filteredItems = commonOptions.filter(item =>
          item.label.toLowerCase().includes(quickPick.value.toLowerCase())
        );

        // Only add custom item if it's not empty and not exactly matching an existing option
        if (quickPick.value && !commonOptions.some(item => item.label === quickPick.value)) {
          quickPick.items = [customItem, ...filteredItems];
        } else {
          quickPick.items = filteredItems;
        }
      });

      quickPick.onDidAccept(() => {
        // When user accepts an item (or custom input)
        if (quickPick.selectedItems.length > 0) {
          input = quickPick.selectedItems[0].label;
        } else {
          input = quickPick.value;
        }
        quickPick.hide();
        resolve(input);
      });

      quickPick.onDidHide(() => {
        resolve(input);
        quickPick.dispose();
      });
    });

    quickPick.show();
    input = await promise;

    if (input === undefined) {
      console.log('[SourceTools] User canceled base ref input.');
      return;
    }

    // Check if the input is one of the action commands
    if (input === 'Enable file color' || input === 'Disable file color') {
      vscode.commands.executeCommand('sourceTools.toggleTreeColor');
      return;
    } else if (input === 'Open tracked files') {
      vscode.commands.executeCommand('sourceTools.openTrackedFiles', true);
      return;
    } else if (input === 'Open changed files') {
      vscode.commands.executeCommand('sourceTools.openChangedFiles', true);
      return;
    } else if (input === 'Diff tracked file') {
      vscode.commands.executeCommand('sourceTools.diffTrackedFile', true);
      return;
    }

    this.baseRef = input.trim();

    // Persist the base ref to context
    await this.context.workspaceState.update('sourceTools.trackingBaseRef', this.baseRef);
    console.log(`[SourceTools] Persisted baseRef to storage: ${this.baseRef}`);

    // Update the VS Code context for when clauses
    await vscode.commands.executeCommand('setContext', 'sourceTools.trackingBaseRef', this.baseRef);
    console.log(`[SourceTools] Updated context variable for when clauses: sourceTools.trackingBaseRef = ${this.baseRef}`);

    if (!this.baseRef) {
      vscode.window.showInformationMessage('Virtual Git Diff disabled.');
      console.log('[SourceTools] Base ref cleared. Virtual Git Diff disabled.');
      this.clearDecorations();
      // Clear file explorer decorations
      (this.addedFileDecoration as any).setFiles([]);
      (this.modifiedFileDecoration as any).setFiles([]);
      // Cancel any pending file explorer updates
      if (this.fileExplorerTimeout) {
        clearTimeout(this.fileExplorerTimeout);
        this.fileExplorerTimeout = undefined;
      }
    } else {
      vscode.window.showInformationMessage(`Base ref set to: ${this.baseRef}`);
      console.log(`[SourceTools] Base ref set to raw input: ${this.baseRef}`);
      this.updateDecorations();
      this.scheduleFileExplorerUpdate();
    }
  }

  private async updateDecorations() {
    console.log('[SourceTools] updateDecorations called.');
    console.log(`[SourceTools] Current baseRef: ${this.baseRef}`);

    for (const editor of vscode.window.visibleTextEditors) {
      // Skip non-file editors (output, terminal, etc.)
      if (editor.document.uri.scheme !== 'file') {
        console.log(`[SourceTools] Skipping non-file editor: ${editor.document.uri}`);
        continue;
      }
      const file = editor.document.uri.fsPath;
      console.log(`[SourceTools] Checking for active snapshot for file: ${file}`);
      if (this.snapshotManager && this.snapshotManager.getActiveSnapshot(file)) {
        console.log('[SourceTools] Active snapshot found, skipping baseRef check.');
        const diffs = await this.computeDiffForFileAsync(file);
        console.log(`[SourceTools] Computed diffs for active snapshot.`);
        this.applyDecorations(editor, diffs);
        continue;
      }
      if (!this.baseRef) {
        console.log('[SourceTools] baseRef is empty, clearing decorations.');
        this.clearDecorations();
        return;
      }
      console.log(`[SourceTools] Computing diff for file: ${file}`);
      const diffs = await this.computeDiffForFileAsync(file);
      console.log(`[SourceTools] Computed diffs.`);
      this.applyDecorations(editor, diffs);
    }
  }

  private clearDecorations() {
    console.log('[SourceTools] clearDecorations called. Removing all decorations from visible editors.');

    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.changedLineDecoration, []);
      editor.setDecorations(this.addedLineDecoration, []);
      editor.setDecorations(this.removedLineDecoration, []);
    }

    // Clear file explorer decorations
    (this.addedFileDecoration as any).setFiles([]);
    (this.modifiedFileDecoration as any).setFiles([]);
  }


  // Debounced timeout for file explorer decorations
  private fileExplorerTimeout?: NodeJS.Timeout;

  /**
   * Gets the active workspace folder based on the active editor
   * @returns The active workspace folder or undefined if none found
   */
  private getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    // First try to get the workspace folder of the active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      return vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    }

    // If no active editor in a workspace folder, return the first workspace folder
    return vscode.workspace.workspaceFolders?.[0];
  }


  /**
   * Opens all files that have been modified or added since the last commit
   */
  private async openChangedFiles(force = false) {
    console.log('[SourceTools] openChangedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.getActiveWorkspaceFolder();
    console.log(`[SourceTools] Active workspace folder: ${activeWorkspaceFolder?.uri.fsPath || 'none'}`);

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
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          console.log(`[SourceTools] No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        console.log(`[SourceTools] Getting changed files since HEAD in ${gitRoot}`);

        // Get changed files compared to HEAD
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', 'HEAD', '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          console.log(`[SourceTools] Error getting changed files: ${result.stderr}`);
          continue;
        }

        // Add changed files to the list
        const diffFiles = result.stdout.split('\n').filter(f => f.trim());
        for (const filePath of diffFiles) {
          const absolutePath = path.join(gitRoot, filePath);
          changedFiles.push(absolutePath);
        }

        // Also get untracked files
        const untrackedResult = await this.runGitCommand(
          ['ls-files', '--others', '--exclude-standard'],
          gitRoot
        );

        if (untrackedResult.status === 0) {
          const untrackedFiles = untrackedResult.stdout.split('\n').filter(f => f.trim());
          for (const filePath of untrackedFiles) {
            const absolutePath = path.join(gitRoot, filePath);
            changedFiles.push(absolutePath);
          }
        }
      }

      // Open all changed files
      if (changedFiles.length === 0) {
        vscode.window.showInformationMessage('No changed files found.');
        return;
      }

      console.log(`[SourceTools] Opening ${changedFiles.length} changed files`);

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
          console.error(`[SourceTools] Error opening file ${file}: ${error}`);
        }
      }

      vscode.window.showInformationMessage(`Opened ${changedFiles.length} changed files.`);
    } catch (error) {
      console.error(`[SourceTools] Error opening changed files: ${error}`);
      vscode.window.showErrorMessage(`Error opening changed files: ${error}`);
    }
  }

  private async diffTrackedFile() {
    console.log('[SourceTools] diffTrackedFile called.');

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
        console.log(`[SourceTools] Using active snapshot for diff: ${activeSnapshot.id}`);
        // Create a title for the diff view
        const title = `${path.basename(filePath)} (Snapshot: ${new Date(activeSnapshot.timestamp).toLocaleString()})`;

        // Create a virtual document URI
        const baseContent = activeSnapshot.content;
        const virtualDocumentUri = vscode.Uri.parse(`sourcetools-diff:/${path.basename(filePath)}?${Date.now()}`);

        // Register a content provider for the virtual document
        const contentProvider = vscode.workspace.registerTextDocumentContentProvider('sourcetools-diff', {
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
      vscode.window.showInformationMessage('No base ref set. Please set a base ref first.');
      return;
    }

    const gitRoot = this.getGitRepoRoot(filePath);

    if (!gitRoot) {
      vscode.window.showInformationMessage('File is not in a Git repository.');
      return;
    }

    try {
      const relativePath = path.relative(gitRoot, filePath);
      console.log(`[SourceTools] Git root: ${gitRoot}, Relative path: ${relativePath}`);

      // Dynamically resolve base ref for this file
      const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
      if (!resolvedRef) {
        vscode.window.showErrorMessage('Could not resolve base reference.');
        return;
      }

      // Get content from the base ref
      const baseContentResult = await this.runGitCommand(['show', `${resolvedRef}:${relativePath}`], gitRoot, false);

      // If the file doesn't exist in the base ref
      if (baseContentResult.status !== 0) {
        vscode.window.showInformationMessage('File does not exist in the base reference.');
        return;
      }

      // Create a title for the diff view
      const title = `${path.basename(filePath)} (${this.baseRef})`;

      // Create a virtual document URI
      const baseContent = baseContentResult.stdout;
      const virtualDocumentUri = vscode.Uri.parse(`sourcetools-diff:/${path.basename(filePath)}?${Date.now()}`);

      // Register a content provider for the virtual document
      const contentProvider = vscode.workspace.registerTextDocumentContentProvider('sourcetools-diff', {
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
      console.error(`[SourceTools] Error creating diff view: ${error}`);
      vscode.window.showErrorMessage(`Error creating diff view: ${error}`);
    }
  }

  /**
  * Opens all files that have been modified or added since the base ref
  */
  private async openTrackedFiles(force = false) {
    console.log('[SourceTools] openTrackedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.getActiveWorkspaceFolder();
    console.log(`[SourceTools] Active workspace folder: ${activeWorkspaceFolder?.uri.fsPath || 'none'}`);

    if (!this.baseRef) {
      vscode.window.showInformationMessage('No base ref set. Please set a base ref first.');
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
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          console.log(`[SourceTools] No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          console.log('[SourceTools] Could not resolve base ref dynamically.');
          continue;
        }

        console.log(`[SourceTools] Getting changed files against ref: ${resolvedRef} in ${gitRoot}`);

        // Get changed files compared to base ref
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', resolvedRef, '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          console.log(`[SourceTools] Error getting changed files: ${result.stderr}`);
          continue;
        }

        // Add changed files to the list
        const diffFiles = result.stdout.split('\n').filter(f => f.trim());
        for (const filePath of diffFiles) {
          const absolutePath = path.join(gitRoot, filePath);
          changedFiles.push(absolutePath);
        }

        // Also get untracked files
        const untrackedResult = await this.runGitCommand(
          ['ls-files', '--others', '--exclude-standard'],
          gitRoot
        );

        if (untrackedResult.status === 0) {
          const untrackedFiles = untrackedResult.stdout.split('\n').filter(f => f.trim());
          for (const filePath of untrackedFiles) {
            const absolutePath = path.join(gitRoot, filePath);
            changedFiles.push(absolutePath);
          }
        }
      }

      // Open all changed files
      if (changedFiles.length === 0) {
        vscode.window.showInformationMessage('No changed files found.');
        return;
      }

      console.log(`[SourceTools] Opening ${changedFiles.length} changed files`);

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
          console.error(`[SourceTools] Error opening file ${file}: ${error}`);
        }
      }

      vscode.window.showInformationMessage(`Opened ${changedFiles.length} changed files.`);
    } catch (error) {
      console.error(`[SourceTools] Error opening changed files: ${error}`);
      vscode.window.showErrorMessage(`Error opening changed files: ${error}`);
    }
  }

  /**
  * Schedules an update of file explorer decorations with debouncing
  */
  private scheduleFileExplorerUpdate(immediate = false) {
    console.log('[SourceTools] Scheduling file explorer decoration update');
    if (this.fileExplorerTimeout) {
      clearTimeout(this.fileExplorerTimeout);
    }
    // Use a longer debounce time (2 seconds) for file explorer updates
    this.fileExplorerTimeout = setTimeout(() => this.updateFileExplorerDecorations(), immediate ? 250 : 1000);
  }

  /**
  * Updates the file explorer decorations by finding modified and added files
  * since the base ref.
  */
  private async updateFileExplorerDecorations() {
    console.log('[SourceTools] updateFileExplorerDecorations called.');

    if (!this.baseRef) {
      console.log('[SourceTools] No baseRef set, clearing file decorations');
      // Clear file explorer decorations
      (this.addedFileDecoration as any).setFiles([]);
      (this.modifiedFileDecoration as any).setFiles([]);
      return;
    }

    // Get the workspace folders
    if (!vscode.workspace.workspaceFolders?.length) {
      console.log('[SourceTools] No workspace folders');
      return;
    }

    try {
      // Get all modified and added files in all workspace folders
      const addedFiles: string[] = [];
      const modifiedFiles: string[] = [];

      for (const folder of vscode.workspace.workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          console.log(`[SourceTools] No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          console.log('[SourceTools] Could not resolve base ref dynamically.');
          continue;
        }

        console.log(`[SourceTools] Getting file status against ref: ${resolvedRef} in ${gitRoot}`);

        // Get status of all files compared to base ref - use a more reliable command
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-status', resolvedRef, '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          console.log(`[SourceTools] Error getting file status: ${result.stderr}`);
          continue;
        }

        console.log(`[SourceTools] Raw git diff output: ${result.stdout.substring(0, 200)}${result.stdout.length > 200 ? '...' : ''}`);

        // Parse the status output
        const statusLines = result.stdout.split('\n');
        for (const line of statusLines) {
          if (!line.trim()) continue;

          const statusMatch = line.match(/^([AMDRT])\s+(.+)/);
          if (statusMatch) {
            const [, status, filePath] = statusMatch;
            const absolutePath = path.join(gitRoot, filePath);

            console.log(`[SourceTools] Found ${status} file: ${filePath}`);

            if (status === 'A') {
              addedFiles.push(absolutePath);
            } else if (status === 'M' || status === 'R' || status === 'T') {
              modifiedFiles.push(absolutePath);
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
            const absolutePath = path.join(gitRoot, filePath);
            console.log(`[SourceTools] Found untracked file: ${filePath}`);
            addedFiles.push(absolutePath);
          }
        }
      }

      console.log(`[SourceTools] Found ${addedFiles.length} added files and ${modifiedFiles.length} modified files`);

      // Set the decorations
      if (this.addedFileDecoration && typeof this.addedFileDecoration.setFiles === 'function') {
        this.addedFileDecoration.setFiles(addedFiles);
      } else {
        console.error('[SourceTools] addedFileDecoration is not properly initialized');
      }

      if (this.modifiedFileDecoration && typeof this.modifiedFileDecoration.setFiles === 'function') {
        this.modifiedFileDecoration.setFiles(modifiedFiles);
      } else {
        console.error('[SourceTools] modifiedFileDecoration is not properly initialized');
      }
    } catch (error) {
      console.error(`[SourceTools] Error updating file explorer decorations: ${error}`);
    }
  }

  private processDiffResult(diffResult: Diff.Change[]): { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] } {
    console.log('[SourceTools] processDiffResult called.');

    const added: DiffRange[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const changed: vscode.DecorationOptions[] = [];
    const created: DiffRange[] = [];

    let lineNumber = 0;
    let currentAddedRange: DiffRange | null = null;
    let removedLineCount = 0;
    let removedAt = -1;

    // First pass: identify removed and added blocks that are consecutive
    // These should be marked as modified rather than separate add/remove
    const diffCount = diffResult.length;
    for (let i = 0; i < diffCount; i++) {
      const part = diffResult[i];
      const nextPart = i < diffCount - 1 ? diffResult[i + 1] : null;
      // Count the number of lines in this chunk
      // Normalize line endings before counting to avoid false positives
      const normalizedValue = part.value.replace(/\r\n/g, '\n');
      const lineCount = normalizedValue.split('\n').length - (normalizedValue.endsWith('\n') ? 1 : 0);

      if (part.added && removedLineCount > 0 && removedAt >= 0) {
          // This is a change rather than just an addition
          const minLines = Math.min(lineCount, removedLineCount);

          // Mark the changed lines
          for (let i = 0; i < minLines; i++) {
            changed.push({ range: new vscode.Range(removedAt + i, 0, removedAt + i, 0) });
          }

          // If there are more added lines than removed, mark the extra as additions
          if (lineCount > removedLineCount) {
            const startLine = removedAt + removedLineCount;
            const endLine = lineNumber + lineCount - 1;
            added.push({ startLine, endLine });
          }

          // Reset removed counter
          removedLineCount = 0;
          removedAt = -1;

          lineNumber += lineCount;
      } else if (part.added) {
          // This is a pure addition
          const startLine = lineNumber;
          const endLine = lineNumber + lineCount - 1;

          if (currentAddedRange && currentAddedRange.endLine === startLine - 1) {
            // Extend existing range if consecutive
            currentAddedRange.endLine = endLine;
          } else {
            // Start a new range
            if (currentAddedRange) {
              added.push({...currentAddedRange});
            }
            currentAddedRange = { startLine, endLine };
          }

        lineNumber += lineCount;
      } else if (part.removed) {
        // Record the position for potential change detection
        if (removedLineCount === 0) {
          // Only set removedAt for the first removal in a sequence
          removedAt = lineNumber;
        }
        removedLineCount += lineCount;

        // If this removal is NOT followed by an addition, handle it as a pure removal
        if (nextPart && nextPart.added) {
          // This will be handled in the next iteration as a change
          // removedLineCount and removedAt are already set
        } else {
          // If we have multiple removals in sequence, only handle them as pure removals
          // if we've confirmed there's no addition following
          if (!nextPart || !nextPart.added) {
            // This is a pure removal with no corresponding addition
            // Only add one decoration at the start of the removed block
            removed.push({ range: new vscode.Range(lineNumber, 0, lineNumber, 0) });
            // Reset counters since we've handled these removals
            removedLineCount = 0;
            removedAt = -1;
          }
        }

        // We don't increment lineNumber for removed chunks as they don't exist in the current file
      } else {
        // Unchanged section

        // If we have pending removals and no additions followed, they are true removals
        if (removedLineCount > 0) {
          // Only add one decoration at the start of the removed block
          removed.push({ range: new vscode.Range(removedAt, 0, removedAt, 0) });
          removedLineCount = 0;
          removedAt = -1;
        }

        // Complete any open addition range
        if (currentAddedRange) {
          added.push({...currentAddedRange});
          currentAddedRange = null;
        }

        lineNumber += lineCount;
      }
    }

    // Handle any remaining removed lines at the end of the diff
    if (removedLineCount > 0) {
      // Only add one decoration at the start of the removed block
      removed.push({ range: new vscode.Range(removedAt, 0, removedAt, 0) });
    }

    // Finalize any remaining added range
    if (currentAddedRange) {
      added.push({...currentAddedRange});
    }

    // Additional check to handle empty line at end of file issues
    // If the last part was not a real change but just a line ending difference,
    // remove it from the lists to avoid false positives
    if (added.length > 0) {
      const lastAdded = added[added.length - 1];
      if (lastAdded.startLine === lastAdded.endLine && lastAdded.startLine === lineNumber - 1) {
        // Check if this is just a line ending difference
        const lastPart = diffResult[diffResult.length - 1];
        if (lastPart && lastPart.added &&
            (lastPart.value === '\n' || lastPart.value === '\r\n' || lastPart.value === '')) {
          // Remove this false positive
          added.pop();
        }
      }
    }

    console.log('[SourceTools] processDiffResult completed.');
    return { added, removed, changed, created };
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    diffs: { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] }
  ) {
    console.log(`[SourceTools] applyDecorations called for editor: ${editor.document.fileName}`);
    const addedRanges = diffs.added.map(r => new vscode.Range(r.startLine, 0, r.endLine, 0));
    const createdRanges = diffs.created.map(r => new vscode.Range(r.startLine, 0, r.endLine, 0));

    editor.setDecorations(this.changedLineDecoration, diffs.changed);
    editor.setDecorations(this.addedLineDecoration, addedRanges);
    editor.setDecorations(this.removedLineDecoration, diffs.removed);
    editor.setDecorations(this.createdLineDecoration, createdRanges);
  }

  private async computeDiffForFileAsync(filePath: string): Promise<{ added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] }> {
    // First check if there's an active snapshot for this file
    if (this.snapshotManager) {
      const activeSnapshot = this.snapshotManager.getActiveSnapshot(filePath);
      if (activeSnapshot) {
        console.log(`[SourceTools] Found active snapshot for file: ${filePath}`);

        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
        if (editor) {
          const currentContent = editor.document.getText();
          const baseContent = activeSnapshot.content;

          // Use in-memory diff to compare snapshot with current content
          const diffs = Diff.diffLines(
            baseContent,
            currentContent,
            {
              ignoreWhitespace: false,
              newlineIsToken: false,
              ignoreNewlineAtEof: true,
              stripTrailingCr: true,
              ignoreCase: false
            }
          );

          // Process the diffs to get the line ranges
          return this.processDiffResult(diffs);
        }
      }
    }

    const gitRoot = this.getGitRepoRoot(filePath);
    if (!gitRoot) {
      console.log(`[SourceTools] No Git root found for file: ${filePath}. Returning empty diff.`);
      return { added: [], removed: [], changed: [], created: [] };
    }

    const relativePath = path.relative(gitRoot, filePath);
    console.log(`[SourceTools] Git root: ${gitRoot}, Relative path: ${relativePath}`);

    // 🔁 Dynamically resolve base ref for this file
    const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
    if (!resolvedRef) {
      console.log('[SourceTools] Could not resolve base ref dynamically.');
      return { added: [], removed: [], changed: [], created: [] };
    }
    console.log(`[SourceTools] Resolved base ref: ${resolvedRef}`);

    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);

    if (editor) {
      const currentContent = editor.document.getText();

      try {

        // Check if there's an active snapshot for this file
        let baseContentResult = await this.runGitCommand(['show', `${resolvedRef}:${relativePath}`], gitRoot, false);

        // If status is not 0, the file might be newly added and not exist in the base ref
        if (baseContentResult.status !== 0) {
          console.log(`[SourceTools] File ${relativePath} might be newly added (not in base ref)`);
          // Mark all lines as added for new files
          const lineCount = editor.document.lineCount;
          return {
            added: [],
            removed: [],
            changed: [],
            created: [{ startLine: 0, endLine: lineCount - 1 }]
          };
        }

        const baseContent = baseContentResult.stdout;

        // use in memory diff to simulate git diff
        const diffs = Diff.diffLines(
          baseContent,
          currentContent,
          {
            ignoreWhitespace: false,
            newlineIsToken: false,
            ignoreNewlineAtEof: true,
            stripTrailingCr: true,
            ignoreCase: false
          }
        );

        // Process the diffs to get the line ranges
        const result = this.processDiffResult(diffs);
        return result;

        // const tmpDir = os.tmpdir();
        // const baseContentTempFile = path.join(tmpDir, `base-${Date.now()}-${Math.random().toString(36).substring(2)}`);
        // const currentContentTempFile = path.join(tmpDir, `current-${Date.now()}-${Math.random().toString(36).substring(2)}`);

        // fs.writeFileSync(baseContentTempFile, baseContent);
        // fs.writeFileSync(currentContentTempFile, currentContent);

        // try {
        //   const diffResult = await this.runGitCommand(['diff', '--ignore-cr-at-eol', '--no-index', baseContentTempFile, currentContentTempFile], gitRoot);

        //   if (diffResult.status !== 0 && diffResult.status !== 1) {
        //     return { added: [], removed: [], changed: [], created: [] };
        //   }

        //   return this.parseUnifiedDiff(diffResult.stdout);
        // } finally {
        //   try { fs.unlinkSync(baseContentTempFile); } catch (_) {}
        //   try { fs.unlinkSync(currentContentTempFile); } catch (_) {}
        // }
      } catch (error) {
        console.log(`[SourceTools] Error creating virtual diff: ${error}`);
        return { added: [], removed: [], changed: [], created: [] };
      }
    } else {
      const result = await this.runGitCommand(['diff', '--ignore-cr-at-eol', resolvedRef, '--', relativePath], gitRoot);
      return this.parseUnifiedDiff(result.stdout);
    }
  }

  private parseUnifiedDiff(diffText: string): { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] } {
    console.log('[SourceTools] parseUnifiedDiff called.');
    // console.log('[SourceTools] Processing the following diff text:');
    // console.log(diffText);

    const added: DiffRange[] = [];
    const created: DiffRange[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const changed: vscode.DecorationOptions[] = [];

    const lines = diffText.split('\n');
    const hunkHeaderRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

    let targetLineNum = 0;
    let currentAddedRange: DiffRange | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++')
      ) {
        continue;
      }

      const hunkMatch = line.match(hunkHeaderRegex);
      if (hunkMatch) {
        // Close out any active added range
        if (currentAddedRange) {
          added.push({ ...currentAddedRange });
          currentAddedRange = null;
        }

        // We adjust so that line indexes are 0-based
        targetLineNum = parseInt(hunkMatch[2], 10) - 1;
        continue;
      }

      // + lines
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (!currentAddedRange) {
          currentAddedRange = { startLine: targetLineNum, endLine: targetLineNum };
        } else if (currentAddedRange.endLine === targetLineNum - 1) {
          currentAddedRange.endLine = targetLineNum;
        } else {
          added.push({ ...currentAddedRange });
          currentAddedRange = { startLine: targetLineNum, endLine: targetLineNum };
        }
        targetLineNum++;
        continue;
      }

      // - lines
      if (line.startsWith('-') && !line.startsWith('---')) {
        let j = i + 1;
        // Check if the next lines are changed lines or something else
        while (
          j < lines.length &&
          (lines[j] === '' || (!lines[j].startsWith('+') && !lines[j].startsWith('-') && !lines[j].match(hunkHeaderRegex)))
        ) {
          j++;
        }

        // If a + follows a -, mark it as changed
        if (j < lines.length && lines[j].startsWith('+')) {
          changed.push({ range: new vscode.Range(targetLineNum, 0, targetLineNum, 0) });
        } else {
          // Check if this is a unique removal that hasn't been added yet
          const existingRemoval = removed.find(r =>
            r.range.start.line === targetLineNum && r.range.end.line === targetLineNum);

          if (!existingRemoval) {
            removed.push({ range: new vscode.Range(targetLineNum, 0, targetLineNum, 0) });
          }
        }
        // Notice we do not increment targetLineNum here because a '-' means the original lines are removed
        continue;
      }

      // For non +/- lines we finalize any in-progress "added range"
      if (currentAddedRange) {
        added.push({ ...currentAddedRange });
        currentAddedRange = null;
      }

      // Normal context line => increment target line pointer
      if (!line.startsWith('+') && !line.startsWith('-')) {
        targetLineNum++;
      }
    }

    // If there's an unfinished added range, close it out
    if (currentAddedRange) {
      added.push({ ...currentAddedRange });
    }

    console.log('[SourceTools] parseUnifiedDiff completed.');
    // console.log(`[SourceTools] Added Ranges: ${JSON.stringify(added)}`);
    // console.log(`[SourceTools] Removed Options: ${JSON.stringify(removed)}`);
    // console.log(`[SourceTools] Changed Options: ${JSON.stringify(changed)}`);

    return { added, removed, changed, created };
  }
}

let virtualGitDiff: VirtualGitDiff;

export function activate(context: vscode.ExtensionContext) {
  virtualGitDiff = new VirtualGitDiff(context);
  virtualGitDiff.activate();
}

export function deactivate() {
  // Optional cleanup
}

// File snapshot handling
interface FileSnapshot {
  id: string;          // Unique identifier for the snapshot
  filePath: string;    // Path to the file relative to workspace
  message: string;     // User-provided description
  timestamp: number;   // When the snapshot was taken
  content: string;     // The file content at snapshot time
}

interface SnapshotIndex {
  [filePath: string]: {
    snapshots: string[];  // Array of snapshot IDs for this file
    activeSnapshot?: string; // Currently active snapshot ID
  };
}

class SnapshotManager {
  private snapshotDir: string;
  private indexFile: string;
  private index: SnapshotIndex = {};

  constructor(private workspaceRoot: string) {
    // Create .sourcetools directory if it doesn't exist
    this.snapshotDir = path.join(workspaceRoot, '.vscode', 'snapshots');
    this.indexFile = path.join(workspaceRoot, '.vscode', 'snapshot-index.json');

    // Load existing index if available
    this.loadIndex();
  }

  /**
    * Ensure the necessary directories exist, but only if we have snapshots
    * This prevents creating directories unless the feature is actually used
    */
  private ensureDirectoriesExist() {
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
    */
  private isFileOperationInProgress(): boolean {
    // We can assume a file operation is in progress if this method is called
    // during takeSnapshot, deleteSnapshot, etc.
    return true;
  }

  private loadIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        console.log(`[SourceTools] Loaded snapshot index from ${this.indexFile}`);
      } else {
        this.index = {};
        console.log(`[SourceTools] No snapshot index found, creating new one`);
      }
    } catch (error) {
      console.error(`[SourceTools] Error loading snapshot index: ${error}`);
      this.index = {};
    }
  }

  private saveIndex() {
    try {
      // Ensure directories exist before saving
      this.ensureDirectoriesExist();

      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8');
      console.log(`[SourceTools] Saved snapshot index to ${this.indexFile}`);
    } catch (error) {
      console.error(`[SourceTools] Error saving snapshot index: ${error}`);
    }
  }

  /**
    * Take a new snapshot of a file
    */
  public takeSnapshot(filePath: string, content: string, message: string): string {
    // Ensure directories exist since we're about to create a file
    this.ensureDirectoriesExist();

    // Generate unique ID for this snapshot
    const id = `${path.basename(filePath)}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Create the snapshot object
    const snapshot: FileSnapshot = {
      id,
      filePath: filePath,
      message,
      timestamp: Date.now(),
      content
    };

    // Save the snapshot to a file
    const snapshotPath = path.join(this.snapshotDir, `${id}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

    // Update the index
    if (!this.index[filePath]) {
      this.index[filePath] = { snapshots: [] };
    }

    this.index[filePath].snapshots.push(id);
    this.saveIndex();

    return id;
  }

  /**
    * Get all snapshots for a file
    */
  public getSnapshots(filePath: string): FileSnapshot[] {
    if (!this.index[filePath] || !this.index[filePath].snapshots.length) {
      return [];
    }

    const snapshots: FileSnapshot[] = [];
    for (const id of this.index[filePath].snapshots) {
      try {
        const snapshotPath = path.join(this.snapshotDir, `${id}.json`);
        if (fs.existsSync(snapshotPath)) {
          const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
          snapshots.push(snapshot);
        }
      } catch (error) {
        console.error(`[SourceTools] Error loading snapshot ${id}: ${error}`);
      }
    }

    // Sort by timestamp, newest first
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
    * Set the active snapshot for a file
    */
  public setActiveSnapshot(filePath: string, snapshotId: string | undefined) {
    if (!this.index[filePath]) {
      this.index[filePath] = { snapshots: [] };
    }

    this.index[filePath].activeSnapshot = snapshotId;
    this.saveIndex();
  }

  /**
    * Get the active snapshot for a file
    */
  public getActiveSnapshot(filePath: string): FileSnapshot | undefined {
    if (!this.index[filePath] || !this.index[filePath].activeSnapshot) {
      return undefined;
    }

    const id = this.index[filePath].activeSnapshot;
    try {
      const snapshotPath = path.join(this.snapshotDir, `${id}.json`);
      if (fs.existsSync(snapshotPath)) {
        return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      }
    } catch (error) {
      console.error(`[SourceTools] Error loading active snapshot ${id}: ${error}`);
    }

    return undefined;
  }

  /**
    * Delete a snapshot
    */
  public deleteSnapshot(filePath: string, snapshotId: string) {
    if (!this.index[filePath]) {
      return;
    }

    // Remove from index
    this.index[filePath].snapshots = this.index[filePath].snapshots.filter(id => id !== snapshotId);

    // If this was the active snapshot, clear it
    if (this.index[filePath].activeSnapshot === snapshotId) {
      this.index[filePath].activeSnapshot = undefined;
    }

    // Remove the snapshot file
    const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }

    this.saveIndex();
  }

  /**
    * Clear all snapshots for a file
    */
  public clearSnapshots(filePath: string) {
    if (!this.index[filePath]) {
      return;
    }

    // Delete all snapshot files
    for (const id of this.index[filePath].snapshots) {
      const snapshotPath = path.join(this.snapshotDir, `${id}.json`);
      if (fs.existsSync(snapshotPath)) {
        fs.unlinkSync(snapshotPath);
      }
    }

    // Remove from index
    delete this.index[filePath];
    this.saveIndex();
  }
}
