import AppKit
import UTermBridge

@MainActor
enum FileToolsSmoke {
    private static func click(_ files: ContentWindow, label: String) async throws {
        guard try await EditorSmoke.evaluate(files, script: """
            const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label);
            if(!button||button.disabled)return false;button.click();return true;
            """, arguments: ["label": label]) else { throw BridgeFailure(code: "FILES_CONTROL", message: "Missing enabled file control: " + label) }
    }
    private static func name(_ files: ContentWindow, _ text: String) async throws {
        try await ContentSmoke.wait(files, "document.querySelector('.file-inline-edit input') !== null")
        guard let window = files.presentationWindow, window.makeFirstResponder(files.webView), try await EditorSmoke.evaluate(files, script: """
            const field=document.querySelector('.file-inline-edit input');field.focus();field.select();
            return document.execCommand('insertText',false,text);
            """, arguments: ["text": text]) else { throw BridgeFailure(code: "FILES_INPUT", message: "File-name input did not accept WebKit typing") }
        _ = try await files.webView.evaluateJavaScript("document.querySelector('.file-inline-edit').requestSubmit()")
        try await ContentSmoke.wait(files, "document.querySelector('.file-inline-edit') === null")
    }
    private static func menu(_ files: ContentWindow, path: String, title: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while true {
            if try await EditorSmoke.evaluate(files, script: """
                const row=[...document.querySelectorAll('.file-row')].find(b=>b.dataset.path===path);
                if(!row)return false;row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:120}));return true;
                """, arguments: ["path": path]) { break }
            guard Date() < deadline else { throw BridgeFailure(code: "FILES_MENU", message: "Missing file row: " + path) }
            try await Task.sleep(for: .milliseconds(30))
        }
        try await ContentSmoke.wait(files, "document.querySelector('[role=menu]') !== null")
        try await EditorSmoke.click(files, title: title)
    }
    static func run(_ files: ContentWindow, root: URL, report: inout [String: Any]) async throws {
        let literal = "literal $(uterm-qa) 中文.txt", target = root.appendingPathComponent("copy-target")
        let source = root.appendingPathComponent(literal), renamed = target.appendingPathComponent("renamed 中文.txt")
        try await click(files, label: "New file")
        try await name(files, literal)
        guard FileManager.default.fileExists(atPath: source.path) else { throw BridgeFailure(code: "FILES_CREATE", message: "Actual file control did not create the literal name") }
        let bytes = Data("COPY_LITERAL_中文\n".utf8)
        try bytes.write(to: source)
        try await click(files, label: "New directory")
        try await name(files, "copy-target")
        try await menu(files, path: literal, title: "Copy")
        try await menu(files, path: "copy-target", title: "Paste")
        try await TerminalSmoke.wait("Complete actual file paste") { (try? Data(contentsOf: target.appendingPathComponent(literal))) == bytes }
        try await ContentSmoke.wait(files, "!document.querySelector('.file-options button[disabled]')")
        guard try Data(contentsOf: target.appendingPathComponent(literal)) == bytes else { throw BridgeFailure(code: "FILES_COPY", message: "Actual paste did not preserve file bytes") }
        guard try await EditorSmoke.evaluate(files, script: "document.querySelector('.file-row[data-path=\"copy-target\"]').click();return true;", arguments: [:]) else { throw BridgeFailure(code: "FILES_COPY", message: "Copied directory could not expand") }
        try await ContentSmoke.wait(files, "document.querySelector('.file-row[data-path^=\"copy-target/\"]') !== null")
        try await menu(files, path: "copy-target/" + literal, title: "Rename")
        try await name(files, "renamed 中文.txt")
        guard try Data(contentsOf: renamed) == bytes, !FileManager.default.fileExists(atPath: target.appendingPathComponent(literal).path) else { throw BridgeFailure(code: "FILES_RENAME", message: "Actual rename changed bytes or retained the old name") }
        try await menu(files, path: "copy-target/renamed 中文.txt", title: "Delete")
        try await EditorSmoke.click(files, title: "Confirm deletion")
        try await ContentSmoke.wait(files, "document.querySelector('.file-management') === null")
        guard !FileManager.default.fileExists(atPath: renamed.path) else { throw BridgeFailure(code: "FILES_DELETE", message: "Actual file deletion did not finish") }
        try await menu(files, path: "copy-target", title: "Delete")
        try await ContentSmoke.wait(files, "document.querySelector('dialog.file-delete-dialog[open]') !== null && document.activeElement?.textContent.trim() === 'Cancel'")
        try await EditorSmoke.click(files, title: "Cancel")
        guard FileManager.default.fileExists(atPath: target.path) else { throw BridgeFailure(code: "FILES_CANCEL", message: "Cancelling directory deletion changed the disk") }
        try await menu(files, path: "copy-target", title: "Delete")
        try await EditorSmoke.click(files, title: "Confirm deletion")
        try await ContentSmoke.wait(files, "document.querySelector('dialog.file-delete-dialog[open]') === null")
        guard !FileManager.default.fileExists(atPath: target.path) else { throw BridgeFailure(code: "FILES_DELETE", message: "Directory deletion did not finish") }
        try await menu(files, path: literal, title: "Delete")
        try await EditorSmoke.click(files, title: "Confirm deletion")
        try await ContentSmoke.wait(files, "document.querySelector('.file-management') === null")
        guard !FileManager.default.fileExists(atPath: source.path) else { throw BridgeFailure(code: "FILES_CLEANUP", message: "File-operation fixture was not removed") }
        report["sharedFilesActualCreateCopyRenameDeleteAndCancel"] = true
    }
}
