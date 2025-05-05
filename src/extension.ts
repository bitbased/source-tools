import * as vscode from 'vscode';

import { SourceTracker } from './SourceTracker';
import { ConfigManager } from './managers/ConfigManager';
import { DecorationManager } from './managers/DecorationManager';
import { GitManager } from './managers/GitManager';
import { SnapshotManager } from './managers/SnapshotManager'
import { DebugLogger } from './managers/DebugLogger';

let sourceTracker: SourceTracker;

export function activate(context: vscode.ExtensionContext) {
  // Initialize the debug logger
  const debugLogger = new DebugLogger(context);

  // Initialize all managers
  const configManager = new ConfigManager(debugLogger, context);
  const gitManager = new GitManager(debugLogger);
  const decorationManager = new DecorationManager(context, debugLogger, configManager);

  // Initialize snapshot manager when a workspace is available
  let snapshotManager: SnapshotManager | undefined;
  if (vscode.workspace.workspaceFolders?.length) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    snapshotManager = new SnapshotManager(workspaceRoot, debugLogger);
    debugLogger.info(`Initialized snapshot manager for workspace: ${workspaceRoot}`);
  }

  // Create the main SourceTracker instance
  sourceTracker = new SourceTracker(
    context,
    debugLogger,
    configManager,
    gitManager,
    decorationManager,
    snapshotManager
  );

  // Activate the extension
  sourceTracker.activate();
}

export function deactivate() {
  if (sourceTracker) {
    sourceTracker.dispose();
  }
}
