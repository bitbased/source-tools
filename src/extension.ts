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

interface DebugHandler {
  log(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
}

// Define a custom interface that extends FileDecorationProvider
interface CustomFileDecorationProvider extends vscode.FileDecorationProvider {
  setFiles(files: string[]): void;
}

class VirtualGitDiff {
  private baseRef: string;
  private displayOptions: string = 'gutter overview tree-color tree-badges';
  private addedLineDecoration!: vscode.TextEditorDecorationType;
  private createdLineDecoration!: vscode.TextEditorDecorationType;
  private removedLineDecoration!: vscode.TextEditorDecorationType;
  private changedLineDecoration!: vscode.TextEditorDecorationType;
  private addedFileDecoration!: CustomFileDecorationProvider;
  private modifiedFileDecoration!: CustomFileDecorationProvider;
  private diffTimeout?: NodeJS.Timeout;
  private statusBarUpdateInterval: NodeJS.Timeout | undefined;
  private snapshotManager?: SnapshotManager;
  private statusBarItem: vscode.StatusBarItem;
  public outputLevel: string = "error"; // error, log, warn, info
  public consoleLevel: string = "error warn"; // error, log, warn, info

  // Create an output channel for logging
  private outputChannel: vscode.OutputChannel;

  // Debug methods
  private debug = {
    log: (message: string, ...args: any[]) => {
      if (this.consoleLevel.includes('log')) {
          console.log(`[SourceTracker] ${message}`, ...args);
      }
      if (this.outputLevel.includes('log')) {
          this.outputChannel.appendLine(`[LOG] ${message} ${args.length ? JSON.stringify(args) : ''}`);
      }
    },
    warn: (message: string, ...args: any[]) => {
      if (this.consoleLevel.includes('warn')) {
          console.warn(`[SourceTracker] ${message}`, ...args);
      }
      if (this.outputLevel.includes('warn')) {
          this.outputChannel.appendLine(`[WARN] ${message} ${args.length ? JSON.stringify(args) : ''}`);
      }
    },
    error: (message: string, ...args: any[]) => {
      if (this.consoleLevel.includes('error')) {
          console.error(`[SourceTracker] ${message}`, ...args);
      }
      if (this.outputLevel.includes('error')) {
          this.outputChannel.appendLine(`[ERROR] ${message} ${args.length ? JSON.stringify(args) : ''}`);
      }
    },
    info: (message: string, ...args: any[]) => {
      if (this.consoleLevel.includes('info')) {
          console.info(`[SourceTracker] ${message}`, ...args);
      }
      if (this.outputLevel.includes('info')) {
          this.outputChannel.appendLine(`[INFO] ${message} ${args.length ? JSON.stringify(args) : ''}`);
      }
    }
  };

  constructor(private context: vscode.ExtensionContext) {
    // Initialize the channel
    this.outputChannel = vscode.window.createOutputChannel('SourceTracker');

    // Load the persisted base ref from context, or default to empty string
    this.baseRef = this.context.workspaceState.get<string>('sourceTracker.trackingBaseRef', '');

    this.displayOptions = this.context.workspaceState.get<string>('sourceTracker.displayOptions', 'gutter overview tree-color tree-badges');
    this.outputLevel = this.context.globalState.get<string>('sourceTracker.outputLevel', 'error');
    this.consoleLevel = this.context.globalState.get<string>('sourceTracker.consoleLevel', 'error warn');


    // Create the status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'sourceTracker.gitTrackingOptions';
    this.updateStatusBar();

    // Set up periodic status bar updates
    this.statusBarUpdateInterval = setInterval(() => this.updateStatusBar(), 30000); // Update every 30 seconds

    // Let’s log some initial info
    this.debug.info('Extension constructor called.');
    this.debug.log(`Loaded baseRef from storage: ${this.baseRef}`);
    // Initialize the context variable for when clauses
    vscode.commands.executeCommand('setContext', 'sourceTracker.trackingBaseRef', this.baseRef);
    this.debug.log(`Initialized context variable: sourceTracker.trackingBaseRef = ${this.baseRef}`);
    this.initDecorations();

    // Initialize snapshot manager when a workspace is available
    if (vscode.workspace.workspaceFolders?.length) {
      this.snapshotManager = new SnapshotManager(vscode.workspace.workspaceFolders[0].uri.fsPath, this.debug);
      this.debug.info(`Initialized snapshot manager for workspace: ${vscode.workspace.workspaceFolders[0].uri.fsPath}`);
    }

  }


  // Add a dispose method to clean up resources
  dispose() {
    if (this.statusBarUpdateInterval) {
      clearInterval(this.statusBarUpdateInterval);
      this.statusBarUpdateInterval = undefined;
    }

    this.statusBarItem.dispose();
    // Clean up any other resources as needed
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
        const relativeTime = this.getRelativeTimeString(activeSnapshot.timestamp);
        if (relativeTime?.includes('second')) {
          setTimeout(() => this.updateStatusBar(), 500);
        }
        this.statusBarItem.text = `$(sti-snapshot-compare) ${relativeTime}`;
        this.statusBarItem.tooltip = `SourceTracker: Tracking snapshot "${activeSnapshot.message || 'No description'}"`;
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
        const gitRoot = this.getGitRepoRoot(filePath);
        if (!gitRoot) {
          // this.debug.warn(`No Git root found for file: ${filePath}. Returning empty diff.`);
          // strikethrough
          resolvedRef = 'no git';
        } else {
          const relativePath = path.relative(gitRoot, filePath);
          this.debug.log(`Git root: ${gitRoot}, Relative path: ${relativePath}`);
          // 🔁 Dynamically resolve base ref for this file
          resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot) || '';
          if (!resolvedRef) {
            resolvedRef = 'not found';
            // this.debug.warn('Could not resolve base ref dynamically.');
          } else {
            // this.debug.log(`Resolved base ref: ${resolvedRef}`);
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

  private initDecorations() {
    this.displayOptions = this.context.workspaceState.get<string>('sourceTracker.displayOptions', 'gutter overview tree-color tree-badges');

    // Check which display methods to use
    const useGutterIcons = this.displayOptions.includes('gutter');
    const useBorder = this.displayOptions.includes('border');
    const useOverview = this.displayOptions.includes('overview');
    const useBackground = /\bbackground\b(?!-)/.test(this.displayOptions);
    const useModifiedBackground = this.displayOptions.includes('background-modified');
    const useTreeBadges = this.displayOptions.includes('tree-badges');
    const useTreeColor = this.displayOptions.includes('tree-color');

    // Create decorations based on selected display methods
    this.removedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      ...(useGutterIcons ? {
        gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-removed.svg')),
        gutterIconSize: 'contain',
      } : {}),
      ...(useBorder || useBackground ? {
        borderStyle: 'solid',
        borderWidth: '1px 0 0 0',
        borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      } : {}),
      // ...(useBackground ? {
      //   backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
      // } : {}),
      ...(useOverview ? {
        overviewRulerColor: 'rgba(225, 66, 64, 0.25)', // Red with 0.25 opacity
        overviewRulerLane: vscode.OverviewRulerLane.Left
      } : {})
    });

    this.changedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      ...(useGutterIcons ? {
        gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-changed.svg')),
        gutterIconSize: 'contain',
      } : {}),
      ...(useBorder ? {
        borderStyle: 'solid',
        borderWidth: '0 0 0 1px',
        borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
      } : {}),
      ...(useModifiedBackground ? {
        backgroundColor: 'rgba(66, 133, 244, 0.1)',
      } : {}),
      ...(useOverview ? {
        overviewRulerColor: 'rgba(66, 133, 244, 0.25)', // Blue with 0.25 opacity
        overviewRulerLane: vscode.OverviewRulerLane.Left
      } : {})
    });

    this.addedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      ...(useGutterIcons ? {
        gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-added.svg')),
        gutterIconSize: 'contain',
      } : {}),
      ...(useBorder ? {
        borderStyle: 'solid',
        borderWidth: '0 0 0 1px',
        borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      } : {}),
      ...(useBackground ? {
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      } : {}),
      ...(useOverview ? {
        overviewRulerColor: 'rgba(82, 183, 136, 0.25)', // Green with 0.25 opacity
        overviewRulerLane: vscode.OverviewRulerLane.Left
      } : {})
    });

    this.createdLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      ...(useGutterIcons ? {
        gutterIconPath: vscode.Uri.file(this.context.asAbsolutePath('resources/git-gutter-created.svg')),
        gutterIconSize: 'contain',
      } : {}),
      ...(useBorder ? {
        borderStyle: 'solid',
        borderWidth: '0 0 0 1px',
        borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      } : {}),
      ...(useBackground ? {
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      } : {})
    });

    // Create file decorations for the explorer
    if (!this.addedFileDecoration && !this.modifiedFileDecoration) {
      this.addedFileDecoration = this.createFileDecorationProvider('a', new vscode.ThemeColor('gitDecoration.addedResourceForeground')) as CustomFileDecorationProvider;
      this.modifiedFileDecoration = this.createFileDecorationProvider('m', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')) as CustomFileDecorationProvider;
    }
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
        const useTreeColor = this.displayOptions.includes('tree-color');
        const useTreeBadges = this.displayOptions.includes('tree-badges');
        files.forEach(file => {

          if (!useTreeBadges && !useTreeColor) {
            return; // Skip if tree badges are disabled
          }

          if (useTreeColor && useTreeBadges) {
            decoratedFiles.set(file, {
              badge,
              color
            });
          } else if (useTreeColor && !useTreeBadges) {
            decoratedFiles.set(file, {
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

  public activate() {
    this.debug.info('Activating extension...');

    this.context.subscriptions.push(
      vscode.commands.registerCommand('sourceTracker.debugOptions', (...args) => {
        this.debug.log('>>> sourceTracker.debugOptions', args);
        this.selectDebugLevel();
      }),
      vscode.commands.registerCommand('sourceTracker.displayOptions', (...args) => {
        this.debug.log('>>> sourceTracker.displayOptions', args);
        this.selectDisplayOptions(...args);
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
            this.stageSnapshot(filePath, activeSnapshot.id);
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
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleFileExplorerUpdate()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.handleActiveEditorChange(editor))
    );

    // Register the file decoration providers
    this.context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this.addedFileDecoration),
      vscode.window.registerFileDecorationProvider(this.modifiedFileDecoration),
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

  private async selectDisplayOptions(forceDisplayOptions: string|undefined = undefined) {
    this.debug.log('selectDisplayOptions called.');

    if (forceDisplayOptions) {
      // Directly apply the provided options without showing the UI
      this.displayOptions = forceDisplayOptions;
      await this.context.workspaceState.update('sourceTracker.displayOptions', this.displayOptions);
      this.clearDecorations();
      this.initDecorations();
      this.updateDecorations();
      this.scheduleFileExplorerUpdate(true);
      this.debug.info(`Updated change display options: ${this.displayOptions}`);
      return;
    }
    // Define display options
    const displayOptions = [
      {
        label: 'Gutter',
        detail: 'Show icons in the gutter for added, modified, and removed lines',
        picked: this.displayOptions.includes('gutter'),
        value: 'gutter'
      },
      {
        label: 'Overview',
        detail: 'Show markers in the scrollbar/overview ruler',
        picked: this.displayOptions.includes('overview'),
        value: 'overview'
      },
      {
        label: 'Borders',
        detail: 'Show colored borders on changed lines',
        picked: this.displayOptions.includes('border'),
        value: 'border'
      },
      {
        label: 'Background (for additions)',
        detail: 'Highlight added lines with background color',
        picked: /\bbackground\b(?!-)/.test(this.displayOptions),
        value: 'background'
      },
      {
        label: 'Background (for changes)',
        detail: 'Highlight changed lines with background color',
        picked: this.displayOptions.includes('background-modified'),
        value: 'background-modified'
      }
      ,
      {
        label: 'Tree Badges',
        detail: 'Show badges (a/m) in file explorer for added/modified files',
        picked: this.displayOptions.includes('tree-badges'),
        value: 'tree-badges'
      },
      {
        label: 'Tree Color',
        detail: 'Color the badges in file explorer based on file status',
        picked: this.displayOptions.includes('tree-color'),
        value: 'tree-color'
      }
    ];

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Choose how to display tracked changes';
    quickPick.canSelectMany = true;
    quickPick.items = displayOptions;

    // Set initially selected items based on current display options
    quickPick.selectedItems = displayOptions.filter(item => item.picked);

    return new Promise<void>(resolve => {
      quickPick.onDidChangeSelection(async items => {
        // Preview the changes immediately when selection changes
        const selectedOptions = items
          .map(item => (item as any).value)
          .join(' ');

        if (selectedOptions && selectedOptions !== this.displayOptions) {
          // Temporarily apply the new display options
          const originalDisplay = this.displayOptions;
          this.displayOptions = selectedOptions;
          await this.context.workspaceState.update('sourceTracker.displayOptions', this.displayOptions);

          this.clearDecorations();
          this.initDecorations();
          this.updateDecorations();
          this.scheduleFileExplorerUpdate(true);

          // This is just a preview - we'll only persist on Accept
          this.debug.log(`Previewing display options: ${selectedOptions}`);
        }
      });

      quickPick.onDidAccept(async () => {
        // Get selected display methods
        const selectedOptions = quickPick.selectedItems
          .map(item => (item as any).value)
          .join(' ');

        // Update display options if changed
        if (this.displayOptions !== selectedOptions && quickPick.selectedItems.length > 0) {
          this.displayOptions = selectedOptions;
          await this.context.workspaceState.update('sourceTracker.displayOptions', this.displayOptions);

          this.clearDecorations();
          // Reinitialize decorations with new display options
          this.initDecorations();

          // Update decorations for the active editor
          this.updateDecorations();
          this.scheduleFileExplorerUpdate(true);

          vscode.window.showInformationMessage(`Change display options updated`);
          this.debug.info(`Updated change display options: ${this.displayOptions}`);
        } else if (quickPick.selectedItems.length === 0) {
          vscode.window.showWarningMessage('At least one display option must be selected');
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

  private async selectDebugLevel() {
    this.debug.log('selectDebugLevel called.');

    const debugLevels = ['error', 'warn', 'log', 'info'];

    // Create items for the quick pick with checkbox behavior
    const consoleItems = debugLevels.map(level => ({
      label: `$(terminal) Console: ${level}`,
      detail: `Show ${level} messages in the console`,
      picked: this.consoleLevel.includes(level),
      level
    }));

    const outputItems = debugLevels.map(level => ({
      label: `$(output) Output Channel: ${level}`,
      detail: `Show ${level} messages in the output channel`,
      picked: this.outputLevel.includes(level),
      level
    }));

    // Combine all items with a separator
    const quickPickItems = [
      ...consoleItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...outputItems
    ];

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Select Debug Levels';
    quickPick.placeholder = 'Choose which debug levels to enable';
    quickPick.canSelectMany = true;
    quickPick.items = quickPickItems;

    // Set initially selected items based on current levels
    quickPick.selectedItems = quickPickItems.filter(
      item => 'level' in item && (
        (item.label.startsWith('$(terminal)') && this.consoleLevel.includes(item.level)) ||
        (item.label.startsWith('$(output)') && this.outputLevel.includes(item.level))
      )
    );

    return new Promise<void>(resolve => {
      quickPick.onDidAccept(async () => {
        // Process selected items
        const selectedConsole = quickPick.selectedItems
          .filter(item => 'level' in item && item.label.startsWith('$(terminal)'))
          .map(item => (item as any).level);

        const selectedOutput = quickPick.selectedItems
          .filter(item => 'level' in item && item.label.startsWith('$(output)'))
          .map(item => (item as any).level);

        // Update debug levels
        this.consoleLevel = selectedConsole.join(' ');
        this.outputLevel = selectedOutput.join(' ');

        // Save settings
        await this.context.globalState.update('sourceTracker.outputLevel', this.outputLevel);
        await this.context.globalState.update('sourceTracker.consoleLevel', this.consoleLevel);

        this.debug.info(`Updated debug levels - Console: ${this.consoleLevel}, Output: ${this.outputLevel}`);
        vscode.window.showInformationMessage(`Debug levels updated`);

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
      const isActive = activeSnapshot && snapshot.id === activeSnapshot.id;
      return {
        label: isActive
          ? `$(triangle-right)${this.getRelativeTimeString(snapshot.timestamp)}`
          : (activeSnapshot ? `$(blank)${this.getRelativeTimeString(snapshot.timestamp)}` : `$(blank)${this.getRelativeTimeString(snapshot.timestamp)}`),
        description: snapshot.message || 'No description',
        actionId: `snapshot:${snapshot.id}`
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
        { label: '$(discard) Revert To Snapshot', description: 'Restore file to snapshot state', actionId: 'revert-snapshot' },
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
      const activeItem = snapshotItems.find(item => item.actionId === `snapshot:${activeSnapshot.id}`);
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
    // quickPick.title = 'SourceTracker: Manage Snapshots';
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

        if (actionId === 'revert-snapshot') {
          this.restoreFromSnapshot(filePath);
        } else if (actionId === 'delete-active-snapshot') {
          this.clearSnapshot(filePath);
        } else if (actionId === 'delete-all-snapshots') {
          this.clearSnapshot(filePath, true);
        } else if (actionId === 'disable-snapshot') {
          this.deactivateSnapshot(filePath);
        } else if (actionId === 'stage-snapshot') {
          if (activeSnapshot) {
            this.stageSnapshot(filePath, activeSnapshot.id);
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
            this.renameSnapshot(filePath, activeSnapshot.id);
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

  private async restoreFromSnapshot(filePath: string) {
    this.debug.info(`restoreFromSnapshot called for file: ${filePath}`);
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
        this.debug.info(`User cancelled restore from snapshot`);
        return;
      }

      // Create a backup of the current content first
      const currentContent = editor.document.getText();
      this.snapshotManager.takeSnapshot(filePath, currentContent, "* Backup");

      // Replace the editor content with the snapshot content
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(editor.document.lineCount, 0)
      );
      edit.replace(editor.document.uri, fullRange, activeSnapshot.content);

      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`Restored from snapshot: ${new Date(activeSnapshot.timestamp).toLocaleString()}`);
      this.debug.info(`Restored file from snapshot: ${filePath}`);

      // Update context after restoring from snapshot
      this.updateActiveEditorContext(editor);
    } catch (error) {
      this.debug.error(`Error restoring from snapshot: ${error}`);
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
          this.snapshotManager.deleteSnapshot(filePath, activeSnapshot.id);
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
        value: snapshot.message || ''
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

  private stageSnapshot(filePath: string, id: string) {
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
        vscode.window.showInformationMessage(`Staged snapshot: ${snapshot.message || 'No message'}`);
        this.debug.info(`Successfully staged snapshot ${id} for file: ${filePath}`);

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
        this.debug.error(`Failed to stage snapshot ${id}: ${updateResult.stderr}`);
      }
    } catch (error) {
      this.debug.error(`Error staging snapshot: ${error}`);
      vscode.window.showErrorMessage(`Error staging snapshot: ${error}`);
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

  private takeNewSnapshot(filePath: string, message: string) {
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
      const snapshotId = this.snapshotManager.takeSnapshot(filePath, content, message);

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

  private handleDocChange(event: vscode.TextDocumentChangeEvent) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && event.document === activeEditor.document) {
      // Skip non-file editors (output, terminal, webview, etc.)
      if (activeEditor.document.uri.scheme === 'output') {
        // dont output, since it can be recursive if we are outputting logs to output channel
        // this.debug.log(`Ignoring changes for non-file editor: ${activeEditor.document.uri.scheme}`);
        return;
      }
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
          this.debug.warn(`No Git root found for folder: ${folderPath}`);
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
      this.debug.error(`Error getting changed files count: ${error}`);
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

  private async selectBaseRef(serializedUri: any = undefined) {
    this.debug.log('selectBaseRef called.');

    // Get changed files count if base ref is set
    let trackedFilesCount = 0;
    if (this.baseRef) {
      const trackedFiles = await this.getTrackedFilesCount();
      trackedFilesCount = trackedFiles;
    }

    // Get changed files count since last commit (independent of baseRef)
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
          // Get the last 6 commits with hash and first line of message
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

    const commonActionIds = options.map(opt => opt.actionId)?.filter(b => b);
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
      vscode.window.showInformationMessage(`Tracking ref set to: ${ref}`);
      this.debug.info(`Base ref set to raw input: ${ref}`);
      this.updateDecorations();
      this.scheduleFileExplorerUpdate();
    }
  }

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
        const diffs = await this.computeDiffForFileAsync(file);
        this.debug.log(`Computed diffs for active snapshot.`);
        this.applyDecorations(editor, diffs);
        continue;
      }
      if (!this.baseRef) {
        this.debug.log('baseRef is empty, clearing decorations.');
        this.clearDecorations();
        return;
      }

      this.debug.log(`Computing diff for file: ${file}`);
      const diffs = await this.computeDiffForFileAsync(file);
      this.debug.log(`Computed diffs.`);
      this.applyDecorations(editor, diffs);
    }
  }

  private clearDecorations() {
    this.debug.log('clearDecorations called. Removing all decorations from visible editors.');

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
    this.debug.log('openChangedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.getActiveWorkspaceFolder();
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
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        this.debug.log(`Getting changed files since HEAD in ${gitRoot}`);

        // Get changed files compared to HEAD
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', 'HEAD', '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          this.debug.warn(`Error getting changed files: ${result.stderr}`);
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
    } catch (error) {
      this.debug.error(`Error opening changed files: ${error}`);
      vscode.window.showErrorMessage(`Error opening changed files: ${error}`);
    }
  }

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
        this.debug.log(`Using active snapshot for diff: ${activeSnapshot.id}`);
        // Create a title for the diff view
        const title = `${path.basename(filePath)} (Snapshot: ${new Date(activeSnapshot.timestamp).toLocaleString()})`;

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

    const gitRoot = this.getGitRepoRoot(filePath);

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
      const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
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
      const baseContentResult = await this.runGitCommand(['show', `${resolvedRef}:${relativePath}`], gitRoot, false);

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
   * Opens all files that have been modified or added since the base ref
   */
  private async openTrackedFiles(force = false) {
    this.debug.log('openTrackedFiles called.');

    // Get the active workspace folder
    const activeWorkspaceFolder = this.getActiveWorkspaceFolder();
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
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for folder: ${folderPath}`);
          continue;
        }

        // Resolve the base ref
        const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          this.debug.warn('Could not resolve base ref dynamically.');
          continue;
        }

        this.debug.log(`Getting changed files against ref: ${resolvedRef} in ${gitRoot}`);

        // Get changed files compared to base ref
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-only', resolvedRef, '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          this.debug.warn(`Error getting changed files: ${result.stderr}`);
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
    } catch (error) {
      this.debug.error(`Error opening changed files: ${error}`);
      vscode.window.showErrorMessage(`Error opening changed files: ${error}`);
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
      (this.addedFileDecoration as any).setFiles([]);
      (this.modifiedFileDecoration as any).setFiles([]);
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
        const gitRoot = this.getGitRepoRoot(folderPath);

        if (!gitRoot) {
          this.debug.warn(`No Git root found for workspace folder: ${folderPath}`);
          continue;
        }

        const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
        if (!resolvedRef) {
          this.debug.warn('Could not resolve base ref dynamically.');
          continue;
        }

        this.debug.log(`Getting file status against ref: ${resolvedRef} in ${gitRoot}`);

        // Get status of all files compared to base ref - use a more reliable command
        const result = await this.runGitCommand(
          ['diff', '--ignore-cr-at-eol', '--name-status', resolvedRef, '--', '.'],
          gitRoot
        );

        if (result.status !== 0 && result.status !== 1) {
          this.debug.warn(`Error getting file status: ${result.stderr}`);
          continue;
        }

        this.debug.log(`Raw git diff output: ${result.stdout.substring(0, 200)}${result.stdout.length > 200 ? '...' : ''}`);

        // Parse the status output
        const statusLines = result.stdout.split('\n');
        for (const line of statusLines) {
          if (!line.trim()) continue;

          const statusMatch = line.match(/^([AMDRT])\s+(.+)/);
          if (statusMatch) {
            const [, status, filePath] = statusMatch;
            const absolutePath = path.join(gitRoot, filePath);

            this.debug.log(`Found ${status} file: ${filePath}`);

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
            this.debug.log(`Found untracked file: ${filePath}`);
            addedFiles.push(absolutePath);
          }
        }
      }

      this.debug.info(`Found ${addedFiles.length} added files and ${modifiedFiles.length} modified files`);

      // Set the decorations
      if (this.addedFileDecoration && typeof this.addedFileDecoration.setFiles === 'function') {
        this.addedFileDecoration.setFiles(addedFiles);
      } else {
        this.debug.error('addedFileDecoration is not properly initialized');
      }

      if (this.modifiedFileDecoration && typeof this.modifiedFileDecoration.setFiles === 'function') {
        this.modifiedFileDecoration.setFiles(modifiedFiles);
      } else {
        this.debug.error('modifiedFileDecoration is not properly initialized');
      }
    } catch (error) {
      this.debug.error(`Error updating file explorer decorations: ${error}`);
    }
  }

  private processDiffResult(diffResult: Diff.Change[]): { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] } {
    this.debug.log('processDiffResult called.');

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

    this.debug.log('processDiffResult completed.');
    return { added, removed, changed, created };
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    diffs: { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] }
  ) {
    this.debug.log(`applyDecorations called for editor: ${editor.document.fileName}`);
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
        this.debug.log(`Found active snapshot for file: ${filePath}`);

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
      this.debug.warn(`No Git root found for file: ${filePath}. Returning empty diff.`);
      return { added: [], removed: [], changed: [], created: [] };
    }

    const relativePath = path.relative(gitRoot, filePath);
    this.debug.log(`Git root: ${gitRoot}, Relative path: ${relativePath}`);

    // 🔁 Dynamically resolve base ref for this file
    const resolvedRef = await this.resolveRefAsync(this.baseRef, gitRoot);
    if (!resolvedRef) {
      this.debug.warn('Could not resolve base ref dynamically.');
      return { added: [], removed: [], changed: [], created: [] };
    }
    this.debug.log(`Resolved base ref: ${resolvedRef}`);

    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);

    if (editor) {
      const currentContent = editor.document.getText();

      try {

        // Check if there's an active snapshot for this file
        let baseContentResult = await this.runGitCommand(['show', `${resolvedRef}:${relativePath}`], gitRoot, false);

        // If status is not 0, the file might be newly added and not exist in the base ref
        if (baseContentResult.status !== 0) {
          this.debug.log(`File ${relativePath} might be newly added (not in base ref)`);
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
        this.debug.warn(`Error creating virtual diff: ${error}`);
        return { added: [], removed: [], changed: [], created: [] };
      }
    } else {
      const result = await this.runGitCommand(['diff', '--ignore-cr-at-eol', resolvedRef, '--', relativePath], gitRoot);
      return this.parseUnifiedDiff(result.stdout);
    }
  }

  private parseUnifiedDiff(diffText: string): { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] } {
    this.debug.log('parseUnifiedDiff called.');
    // this.debug.log('Processing the following diff text:');
    // this.debug.log(diffText);

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

    this.debug.log('parseUnifiedDiff completed.');
    // this.debug.log(`Added Ranges: ${JSON.stringify(added)}`);
    // this.debug.log(`Removed Options: ${JSON.stringify(removed)}`);
    // this.debug.log(`Changed Options: ${JSON.stringify(changed)}`);

    return { added, removed, changed, created };
  }
}

let virtualGitDiff: VirtualGitDiff;

export function activate(context: vscode.ExtensionContext) {
  virtualGitDiff = new VirtualGitDiff(context);
  virtualGitDiff.activate();
}

export function deactivate() {
  if (virtualGitDiff) {
    virtualGitDiff.dispose();
    virtualGitDiff = undefined as any;
  }
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
  private debug: DebugHandler;

  constructor(private workspaceRoot: string, debugHandler: DebugHandler) {
    // Create .sourcetracker directory if it doesn't exist
    this.snapshotDir = path.join(workspaceRoot, '.vscode', 'snapshots');
    this.indexFile = path.join(workspaceRoot, '.vscode', 'snapshot-index.json');
    this.debug = debugHandler;
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

  private saveIndex() {
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
        this.debug.error(`Error loading snapshot ${id}: ${error}`);
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
   * Get a specific snapshot by its ID for a file
   * @param filePath The path to the file
   * @param id The snapshot ID to retrieve
   * @returns The snapshot if found, undefined otherwise
   */
  public getSnapshotById(filePath: string, id: string): FileSnapshot | undefined {
    const snapshots = this.getSnapshots(filePath);
    return snapshots.find(snapshot => snapshot.id === id);
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
      this.debug.error(`Error loading active snapshot ${id}: ${error}`);
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
   * Updates the message for an existing snapshot
   * @param filePath The path to the file
   * @param id The ID of the snapshot to update
   * @param message The new message for the snapshot
   */
  updateSnapshotMessage(filePath: string, id: string, message: string): void {
    try {
      // Get the snapshot file path
      const snapshotPath = path.join(this.snapshotDir, `${id}.json`);

      // Check if the snapshot exists
      if (fs.existsSync(snapshotPath)) {
        // Read the snapshot file
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

        // Update the message
        snapshot.message = message;

        // Write the updated snapshot back to the file
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

        this.debug.log(`Updated message for snapshot ${id}`);
      } else {
        this.debug.error(`Snapshot file not found: ${snapshotPath}`);
      }
    } catch (error) {
      this.debug.error(`Error updating snapshot message: ${error}`);
    }
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
