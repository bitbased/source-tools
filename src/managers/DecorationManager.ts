import * as vscode from 'vscode';
import * as Diff from 'diff';

import { DebugLogger } from './DebugLogger';
import { ConfigManager } from './ConfigManager';
import { GitManager } from './GitManager';

/**
 * Interface for a custom file decoration provider that can be updated
 */
interface CustomFileDecorationProvider extends vscode.FileDecorationProvider {
  setFiles(files: string[]): void;
}

/**
 * Interface for ranges of diffed lines
 */
interface DiffRange {
  startLine: number;
  endLine: number;
}

/**
 * Manages editor decorations for diffs and changes
 */
export class DecorationManager {
  private displayOptions: string = 'gutter overview tree-color tree-badges';
  private addedLineDecoration!: vscode.TextEditorDecorationType;
  private createdLineDecoration!: vscode.TextEditorDecorationType;
  private removedLineDecoration!: vscode.TextEditorDecorationType;
  private changedLineDecoration!: vscode.TextEditorDecorationType;
  private addedFileDecoration!: CustomFileDecorationProvider;
  private modifiedFileDecoration!: CustomFileDecorationProvider;
  private gitManager: GitManager = new GitManager(this.debug);

  constructor(
    private context: vscode.ExtensionContext,
    private debug: DebugLogger,
    private configManager: ConfigManager
  ) {
    // Set display options from configuration
    const decorations = this.configManager.get().diffDecorations;
    this.displayOptions = [
      decorations.gutter ? 'gutter' : '',
      decorations.overview ? 'overview' : '',
      decorations.border ? 'border' : '',
      decorations.background ? 'background' : '',
      decorations.backgroundModified ? 'background-modified' : '',
      decorations.treeBadges ? 'tree-badges' : '',
      decorations.treeColor ? 'tree-color' : ''
    ].filter(Boolean).join(' ');

    this.initDecorations();
  }

  /**
   * Initializes decorations based on display options
   */
  public initDecorations() {
    // Use config values for display options
    const decorations = this.configManager.get().diffDecorations;

    // Check which display methods to use
    const useGutterIcons = decorations.gutter || this.displayOptions.includes('gutter');
    const useBorder = decorations.border || this.displayOptions.includes('border');
    const useOverview = decorations.overview || this.displayOptions.includes('overview');
    const useBackground = decorations.background || /\bbackground\b(?!-)/.test(this.displayOptions);
    const useModifiedBackground = decorations.backgroundModified || this.displayOptions.includes('background-modified');
    const useTreeBadges = decorations.treeBadges || this.displayOptions.includes('tree-badges');
    const useTreeColor = decorations.treeColor || this.displayOptions.includes('tree-color');

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
   * Registers the file decoration providers
   * @returns A disposable for the registered providers
   */
  public registerDecorationProviders(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.registerFileDecorationProvider(this.addedFileDecoration),
      vscode.window.registerFileDecorationProvider(this.modifiedFileDecoration)
    );
  }

  /**
   * Creates a file decoration provider with the specified badge and color
   * @param badge The badge text to display
   * @param color The color of the badge
   * @returns A file decoration provider
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
   * Sets file decorations for added and modified files
   * @param addedFiles List of added files
   * @param modifiedFiles List of modified files
   */
  public setFileDecorations(addedFiles: string[], modifiedFiles: string[]) {
    this.addedFileDecoration.setFiles(addedFiles);
    this.modifiedFileDecoration.setFiles(modifiedFiles);
  }

  /**
   * Clears file decorations
   */
  public clearFileDecorations() {
    this.addedFileDecoration.setFiles([]);
    this.modifiedFileDecoration.setFiles([]);
  }

  /**
   * Clears all decorations from visible editors
   */
  public clearDecorations() {
    this.debug.log('clearDecorations called. Removing all decorations from visible editors.');

    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.changedLineDecoration, []);
      editor.setDecorations(this.addedLineDecoration, []);
      editor.setDecorations(this.removedLineDecoration, []);
      editor.setDecorations(this.createdLineDecoration, []);
    }

    // Clear file explorer decorations
    this.clearFileDecorations();
  }

  /**
   * Applies decorations to editor
   * @param editor The text editor
   * @param diffs The diff ranges to decorate
   */
  public applyDecorations(
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

  /**
   * Opens a quick pick to select display options
   * @param forceDisplayOptions Optional display options to force
   */
  public async selectDisplayOptions(forceDisplayOptions: string | undefined = undefined) {
    this.debug.log('selectDisplayOptions called.');

    if (forceDisplayOptions) {
      // Directly apply the provided options without showing the UI
      this.displayOptions = forceDisplayOptions;
      await this.context.workspaceState.update('sourceTracker.displayOptions', this.displayOptions);
      this.clearDecorations();
      this.initDecorations();
      // Schedule file explorer update
      this.debug.info(`Updated change display options: ${this.displayOptions}`);
      return;
    }

    // Define display options
    const displayOptions = [
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
      },
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

          // Update all decoration settings in the configuration
          const decorationsConfig = vscode.workspace.getConfiguration('sourceTracker.display');

          const workspaceConfig = vscode.workspace.getConfiguration('sourceTracker.display', null);
          const hasWorkspaceDecoration = workspaceConfig.inspect('diffDecorations')?.workspaceValue !== undefined;

          await decorationsConfig.update('diffDecorations', {
            gutter: selectedOptions.includes('gutter'),
            overview: selectedOptions.includes('overview'),
            border: selectedOptions.includes('border'),
            background: /\bbackground\b(?!-)/.test(selectedOptions),
            backgroundModified: selectedOptions.includes('background-modified'),
            treeBadges: selectedOptions.includes('tree-badges'),
            treeColor: selectedOptions.includes('tree-color')
          }, hasWorkspaceDecoration ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
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

          // Update all decoration settings in the configuration
          const decorationsConfig = vscode.workspace.getConfiguration('sourceTracker.display');

          const workspaceConfig = vscode.workspace.getConfiguration('sourceTracker.display', null);
          const hasWorkspaceDecoration = workspaceConfig.inspect('diffDecorations')?.workspaceValue !== undefined;

          await decorationsConfig.update('diffDecorations', {
            gutter: selectedOptions.includes('gutter'),
            overview: selectedOptions.includes('overview'),
            border: selectedOptions.includes('border'),
            background: /\bbackground\b(?!-)/.test(selectedOptions),
            backgroundModified: selectedOptions.includes('background-modified'),
            treeBadges: selectedOptions.includes('tree-badges'),
            treeColor: selectedOptions.includes('tree-color')
          }, hasWorkspaceDecoration ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);

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

  /**
   * Computes diff for a file against a reference or snapshot
   * @param filePath Path to the file
   * @returns The diff ranges
   */
  public async computeDiffForFileAsync(filePath: string): Promise<{ added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] }> {
    // Check if there's an active snapshot for this file
    // This will be handled by the main SourceTracker class

    const gitRoot = this.gitManager.getGitRepoRoot(filePath);
    if (!gitRoot) {
      this.debug.warn(`No Git root found for file: ${filePath}. Returning empty diff.`);
      return { added: [], removed: [], changed: [], created: [] };
    }

    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);

    if (editor) {
      const currentContent = editor.document.getText();

      try {
        // Get the base content in memory
        let baseContent = "";
        // If using a snapshot, baseContent would be set to the snapshot content
        // This would be handled by the caller (SourceTracker)

        // Use in memory diff to simulate git diff
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
      } catch (error) {
        this.debug.warn(`Error creating virtual diff: ${error}`);
        return { added: [], removed: [], changed: [], created: [] };
      }
    } else {
      return { added: [], removed: [], changed: [], created: [] };
    }
  }

  /**
   * Processes diff results to get line ranges
   * @param diffResult The diff result
   * @returns The processed diff ranges
   */
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

  /**
   * Parses a unified diff output
   * @param diffText The unified diff text
   * @returns The processed diff ranges
   */
  private parseUnifiedDiff(diffText: string): { added: DiffRange[]; removed: vscode.DecorationOptions[]; changed: vscode.DecorationOptions[]; created: DiffRange[] } {
    this.debug.log('parseUnifiedDiff called.');

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
    return { added, removed, changed, created };
  }
}
