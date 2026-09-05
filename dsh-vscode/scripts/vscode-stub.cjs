// Minimal vscode module stub for bundle load sanity checks only.
module.exports = {
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: { createStatusBarItem: () => ({ show() {}, dispose() {} }), createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
  Uri: { parse: (s) => ({ toString: () => s }) },
  ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {},
  TreeItem: class { constructor() {} }, EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  Disposable: class { static from() {} },
}
