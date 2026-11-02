import Foundation
import SwiftTerm
import XCTest

private final class ParserDelegate: TerminalDelegate {
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

final class SwiftTermParserTests: XCTestCase {
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
