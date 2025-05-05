import * as vscode from 'vscode';

import { DebugLogger } from './DebugLogger';

/**
 * Interface for the configuration values
 */
export interface ConfigValues {
  outputLevel: string;
  consoleLevel: string;
  snapshotStorage: string,
  snapshotTriggers: {
    onOpen: string;
    onSave: string;
    onDoubleSave: string;
    beforeApply: string;
    beforePaste: string;
    beforeDeletion: string;
  };
  snapshotTriggersExclude: string[];
  snapshotDoubleSaveDelay: number;
  snapshotDeletionThreshold: number;
  maxAutoSnapshots: number;
  maxAutoSnapshotSize: number;
  defaultEditorMenu: string;
  displayCustomRefs: string[];
  displayRecentBranches: number;
  displayRecentCommits: number;
  displayRecentSnapshots: number;
  displayCommitTemplate: string;
  displaySnapshotTemplate: string;
  diffDecorationsGutterWidth: number;
  diffDecorations: {
    gutter: boolean;
    overview: boolean;
    border: boolean;
    background: boolean;
    backgroundModified: boolean;
    treeBadges: boolean;
    treeColor: boolean;
  };
}

/**
 * Manages the extension's configuration
 */
export class ConfigManager {
  private config: ConfigValues;
  private changeListeners: Array<(config: ConfigValues) => void> = [];
  private configChangeDisposable: vscode.Disposable | undefined;

  /**
   * Creates a new ConfigManager
   * @param debug The debug logger
   * @param context The extension context
   */
  constructor(private debug: DebugLogger, private context: vscode.ExtensionContext) {
    this.config = this.loadConfig();
    this.setupConfigChangeListener();
  }

  /**
   * Loads the configuration values from the VS Code configuration
   * @returns The configuration values
   */
  private loadConfig(): ConfigValues {
    const displayConfig = vscode.workspace.getConfiguration('sourceTracker.display');
    const snapshotsConfig = vscode.workspace.getConfiguration('sourceTracker.snapshots');

    return {
      outputLevel: this.context ? this.context.globalState.get<string>('sourceTracker.outputLevel', 'error') : 'error',
      consoleLevel: this.context ? this.context.globalState.get<string>('sourceTracker.consoleLevel', 'error warn') : 'error warn',
      snapshotStorage: snapshotsConfig.get<string>('storage', 'folder'),
      snapshotTriggers: {
        onOpen: snapshotsConfig.get<string>('triggers.onOpen', 'off'),
        onSave: snapshotsConfig.get<string>('triggers.onSave', 'off'),
        onDoubleSave: snapshotsConfig.get<string>('triggers.onDoubleSave', 'off'),
        beforeApply: snapshotsConfig.get<string>('triggers.beforeApply', 'auto'),
        beforePaste: snapshotsConfig.get<string>('triggers.beforePaste', 'off'),
        beforeDeletion: snapshotsConfig.get<string>('triggers.beforeDeletion', 'off')
      },
      snapshotTriggersExclude: snapshotsConfig.get<string[]>('triggersExclude', []),
      snapshotDoubleSaveDelay: snapshotsConfig.get<number>('doubleSaveDelay', 300),
      snapshotDeletionThreshold: snapshotsConfig.get<number>('deletionThreshold', 1),
      maxAutoSnapshots: snapshotsConfig.get<number>('maxAutoSnapshots', 10),
      maxAutoSnapshotSize: snapshotsConfig.get<number>('maxAutoSnapshotSize', 256),
      defaultEditorMenu: displayConfig.get<string>('defaultEditorMenu', 'auto'),
      displayCustomRefs: displayConfig.get<string[]>('customRefs', [
        "BRANCH Merge-base of current branch",
        "HEAD Current checked out commit",
        "HEAD~1 Previous commit",
        "develop Develop branch",
        "master|main Main branch"
      ]),
      displayRecentBranches: displayConfig.get<number>('recentBranches', 5),
      displayRecentCommits: displayConfig.get<number>('recentCommits', 5),
      displayRecentSnapshots: displayConfig.get<number>('recentSnapshots', 10),
      diffDecorationsGutterWidth: displayConfig.get<number>('diffDecorationsGutterWidth', 3),
      displayCommitTemplate: displayConfig.get<string>('commitTemplate', '${hashShort} ${authorDateAgo} - ${subject...}'),
      displaySnapshotTemplate: displayConfig.get<string>('snapshotTemplate', '${snapshotDateAgo} ${message...}'),
      diffDecorations: {
        gutter: displayConfig.get<boolean>('diffDecorations.gutter', true),
        overview: displayConfig.get<boolean>('diffDecorations.overview', true),
        border: displayConfig.get<boolean>('diffDecorations.border', false),
        background: displayConfig.get<boolean>('diffDecorations.background', false),
        backgroundModified: displayConfig.get<boolean>('diffDecorations.backgroundModified', false),
        treeBadges: displayConfig.get<boolean>('diffDecorations.treeBadges', true),
        treeColor: displayConfig.get<boolean>('diffDecorations.treeColor', true)
      }
    };
  }

  /**
   * Sets up a listener for configuration changes
   */
  private setupConfigChangeListener(): void {
    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('sourceTracker')) {
        this.debug.log('Configuration changed, updating config values');
        this.config = this.loadConfig();
        this.notifyListeners();
      }
    });
  }

  /**
   * Gets the current configuration values
   * @returns The configuration values
   */
  public get(): ConfigValues {
    return this.config;
  }

  /**
   * Registers a listener for configuration changes
   * @param listener The listener function
   * @returns A disposable to unregister the listener
   */
  public onChange(listener: (config: ConfigValues) => void): vscode.Disposable {
    this.changeListeners.push(listener);
    return {
      dispose: () => {
        const index = this.changeListeners.indexOf(listener);
        if (index !== -1) {
          this.changeListeners.splice(index, 1);
        }
      }
    };
  }

  /**
   * Notifies all registered listeners of configuration changes
   */
  private notifyListeners(): void {
    for (const listener of this.changeListeners) {
      listener(this.config);
    }
  }

  /**
   * Disposes of resources used by the ConfigManager
   */
  public dispose(): void {
    if (this.configChangeDisposable) {
      this.configChangeDisposable.dispose();
    }
  }
}
