import Foundation
import SwiftTerm
import XCTest

private final class ParserDelegate: TerminalDelegate {
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

final class SwiftTermParserTests: XCTestCase {
    private let resizeMarker = "PERSONAL_READY 中文"
    private var resizeTranscript: String {
        let prompt = "iad20-fj923-4cecad19-61a1-41d4-bd80-9c412a1d1112-2AEEFCE9D86C:project runner$ "
        return "The default interactive shell is now zsh.\r\nTo update your account to use zsh, please run `chsh -s /bin/zsh`.\r\nFor more details, please visit https://support.apple.com/kb/HT208050.\r\n" + prompt + "printf 'PERSONAL_%s 中文\\n' READY\r\n" + resizeMarker + "\r\n" + prompt
    }
    private func bufferText(_ terminal: Terminal, visible: Bool = false) -> String {
        let start = terminal.buffer.totalLinesTrimmed + (visible ? terminal.buffer.yDisp : 0)
        let count = visible ? terminal.rows : terminal.rows + terminal.options.scrollback
        return (start..<(start + count)).compactMap { row in
            terminal.getScrollInvariantLine(row: row)?.translateToString(trimRight: true, skipNullCellsFollowingWide: true, characterProvider: { terminal.getCharacter(for: $0) })
        }.joined(separator: "\n")
    }
    func testUnicodeOutputRemainsVisibleAcrossRepeatedNarrowAndWideResizes() {
        let delegate = ParserDelegate()
        let terminal = Terminal(delegate: delegate)
        terminal.resize(cols: 80, rows: 28); terminal.feed(text: resizeTranscript)
        for columns in [52, 28, 80, 100, 58, 28, 52, 80] {
            terminal.resize(cols: columns, rows: 28)
            XCTAssertTrue(bufferText(terminal).contains(resizeMarker), "Buffer lost output at \(columns) columns")
            XCTAssertTrue(bufferText(terminal, visible: true).contains(resizeMarker), "Viewport lost output at \(columns) columns")
        }
    }
    func testHostSizedResetReplayRetainsUnicodeWhenRestoringViewport() {
        let delegate = ParserDelegate()
        let terminal = Terminal(delegate: delegate)
        for columns in [52, 28, 100, 28, 52] {
            terminal.resetToInitialState(); terminal.resize(cols: 80, rows: 28)
            terminal.feed(text: "\u{1b}c" + resizeTranscript); terminal.resize(cols: columns, rows: 28)
            XCTAssertTrue(bufferText(terminal).contains(resizeMarker), "Reset replay lost output at \(columns) columns")
        }
    }
    func testUnicodeCellsColorsAlternateScreenAndInputModes() throws {
        let delegate = ParserDelegate()
        let terminal = Terminal(delegate: delegate)
        terminal.feed(text: "\u{1b}[31mUTERM_中文 é\u{1b}[0m\r\nNORMAL")
        let first = try XCTUnwrap(terminal.getScrollInvariantLine(row: 0))
        let text = first.translateToString(trimRight: true, skipNullCellsFollowingWide: true, characterProvider: { terminal.getCharacter(for: $0) })
        XCTAssertEqual(text, "UTERM_中文 é")
        let normal = try XCTUnwrap(terminal.getScrollInvariantLine(row: 1))
        XCTAssertNotEqual(first.getData()[0].attribute, normal.getData()[0].attribute)
        terminal.feed(text: "\u{1b}[?1049hALT_SCREEN\u{1b}[?1049l")
        XCTAssertEqual(try XCTUnwrap(terminal.getScrollInvariantLine(row: 0)).translateToString(trimRight: true, skipNullCellsFollowingWide: true, characterProvider: { terminal.getCharacter(for: $0) }), text)
        terminal.feed(text: "\u{1b}[?2004h\u{1b}[?1000h")
        XCTAssertTrue(terminal.bracketedPasteMode)
        if case .off = terminal.mouseMode { XCTFail("Mouse tracking should be enabled") }
        terminal.feed(text: "\u{1b}[?2004l\u{1b}[?1000l")
        XCTAssertFalse(terminal.bracketedPasteMode)
        if case .off = terminal.mouseMode {} else { XCTFail("Mouse tracking should be disabled") }
    }
}
