import * as vscode from 'vscode';

/**
 * Handles debug logging for the extension
 */
export class DebugLogger {
  private outputChannel: vscode.LogOutputChannel;
  private outputLevel: string = "error"; // error, log, warn, info
  private consoleLevel: string = "error warn"; // error, log, warn, info

  // ANSI color codes for OutputChannel coloring
  private static ansiColors = {
    log: '',      // White        // #ffffff
    warn: '',     // Yellow       // #ffff00
    error: '',    // Red          // #ff0000
    info: '',     // Cyan         // #00ffff
    strings: '',  // Red          // #ce9178
    numbers: '',  // Yellow       // #b5cea8
    symbols: '',  // Blue         // #569cd6
    comments: '', // Green        // #6a9955
    objects: '',  // Bright Black // #999999
    reset: ''
  };

  constructor(private context: vscode.ExtensionContext) {
    // Initialize the channel
    this.outputChannel = vscode.window.createOutputChannel('SourceTracker', { log: true });

    // Load debug levels from global state
    this.outputLevel = this.context.globalState.get<string>('sourceTracker.outputLevel', 'error');
    this.consoleLevel = this.context.globalState.get<string>('sourceTracker.consoleLevel', 'error warn');

    // Log initial info
    this.info('DebugLogger initialized');
  }

  /**
   * Formats and colors debug arguments for output/logging.
   * Strings are quoted, objects/arrays are pretty-printed, and primitive types are colored.
   */
  private formatDebugArgs(args: any[]): string {
    const MAX_LEN = 128;
    function ellipsis(str: string, colorStart: string, colorReset: string): string {
      // If string is longer than MAX_LEN, truncate and add ellipsis before reset code
      if (str.length > MAX_LEN) {
        // Remove color codes for length check, but keep them in output
        // Here, str starts with colorStart and ends with colorReset
        const prefixLen = colorStart.length;
        const suffixLen = colorReset.length;
        const visibleLen = str.length - prefixLen - suffixLen;
        if (visibleLen > MAX_LEN) {
          // Truncate only the visible content
          const content = str.slice(prefixLen, str.length - suffixLen);
          return colorStart + content.slice(0, MAX_LEN - 1) + '…' + colorReset;
        }
      }
      return str;
    }

    return args
      .map(arg => {
        if (typeof arg === 'string') {
          const colored = `${DebugLogger.ansiColors.strings}"${arg}"${DebugLogger.ansiColors.reset}`;
          return ellipsis(colored, DebugLogger.ansiColors.strings, DebugLogger.ansiColors.reset);
        } else if (typeof arg === 'number') {
          const colored = `${DebugLogger.ansiColors.numbers}${arg}${DebugLogger.ansiColors.reset}`;
          return ellipsis(colored, DebugLogger.ansiColors.numbers, DebugLogger.ansiColors.reset);
        } else if (typeof arg === 'boolean') {
          const colored = `${DebugLogger.ansiColors.symbols}${arg}${DebugLogger.ansiColors.reset}`;
          return ellipsis(colored, DebugLogger.ansiColors.symbols, DebugLogger.ansiColors.reset);
        } else if (arg === undefined) {
          const colored = `${DebugLogger.ansiColors.symbols}undefined${DebugLogger.ansiColors.reset}`;
          return ellipsis(colored, DebugLogger.ansiColors.symbols, DebugLogger.ansiColors.reset);
        } else if (arg === null) {
          // Red for null
          const colored = `${DebugLogger.ansiColors.symbols}null${DebugLogger.ansiColors.reset}`;
          return ellipsis(colored, DebugLogger.ansiColors.symbols, DebugLogger.ansiColors.reset);
        } else if (typeof arg === 'object') {
          // Pretty print objects/arrays
          try {
            const pretty = JSON.stringify(arg, null, 2);
            const colored = DebugLogger.ansiColors.log + pretty + DebugLogger.ansiColors.reset;
            return ellipsis(colored, DebugLogger.ansiColors.log, DebugLogger.ansiColors.reset);
          } catch {
            return '[object]';
          }
        }
        // Fallback: just toString
        return ellipsis(String(arg), '', '');
      })
      .join(' ');
  }

  /**
   * Updates the debug levels
   * @param outputLevel The new output level
   * @param consoleLevel The new console level
   */
  public setLevels(outputLevel: string, consoleLevel: string) {
    this.outputLevel = outputLevel;
    this.consoleLevel = consoleLevel;

    // Save to global state
    this.context.globalState.update('sourceTracker.outputLevel', this.outputLevel);
    this.context.globalState.update('sourceTracker.consoleLevel', this.consoleLevel);
  }

  /**
   * Opens a quick pick to select debug levels
   */
  public async selectDebugLevel() {
    this.log('selectDebugLevel called.');

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
        this.setLevels(selectedOutput.join(' '), selectedConsole.join(' '));

        this.info(`Updated debug levels - Console: ${this.consoleLevel}, Output: ${this.outputLevel}`);
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
   * Logs a message at the "log" level
   * @param message The message to log
   * @param args Additional arguments to log
   */
  public log(message: string, ...args: any[]): void {
    if (this.consoleLevel.includes('log')) {
      console.log(`[SourceTracker] ${message}`, ...args);
    }
    if (this.outputLevel.includes('log')) {
      this.outputChannel.debug(
        `${message}${args.length ? ' ' + this.formatDebugArgs(args) : ''}`
      );
    }
  }

  /**
   * Logs a message at the "trace" level
   * @param message The message to log
   * @param args Additional arguments to log
   */
  public trace(message: string, ...args: any[]): void {
    if (this.consoleLevel.includes('trace')) {
      console.trace(`[SourceTracker] ${message}`, ...args);
    }
    if (this.outputLevel.includes('trace')) {
      this.outputChannel.trace(
        `${message}${args.length ? ' ' + this.formatDebugArgs(args) : ''}`
      );
    }
  }

  /**
   * Logs a message at the "warn" level
   * @param message The message to log
   * @param args Additional arguments to log
   */
  public warn(message: string, ...args: any[]): void {
    if (this.consoleLevel.includes('warn')) {
      console.warn(`[SourceTracker] ${message}`, ...args);
    }
    if (this.outputLevel.includes('warn')) {
      this.outputChannel.warn(
        `${message}${args.length ? ' ' + this.formatDebugArgs(args) : ''}`
      );
    }
  }

  /**
   * Logs a message at the "error" level
   * @param message The message to log
   * @param args Additional arguments to log
   */
  public error(message: string, ...args: any[]): void {
    if (this.consoleLevel.includes('error')) {
      console.error(`[SourceTracker] ${message}`, ...args);
    }
    if (this.outputLevel.includes('error')) {
      this.outputChannel.error(
        `${message}${args.length ? ' ' + this.formatDebugArgs(args) : ''}`
      );
    }
  }

  /**
   * Logs a message at the "info" level
   * @param message The message to log
   * @param args Additional arguments to log
   */
  public info(message: string, ...args: any[]): void {
    if (this.consoleLevel.includes('info')) {
      console.info(`[SourceTracker] ${message}`, ...args);
    }
    if (this.outputLevel.includes('info')) {
      this.outputChannel.info(
        `${message}${args.length ? ' ' + this.formatDebugArgs(args) : ''}`
      );
    }
  }
}
