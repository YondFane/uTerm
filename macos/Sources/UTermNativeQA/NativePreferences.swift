import AppKit
import SwiftTerm
import UTermBridge

@MainActor
enum NativePreferences {
    static func light(_ settings: JSONValue) -> Bool {
        switch settings["appearance"].string {
        case "light": true
        case "dark": false
        default: NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua
        }
    }
    static func color(_ value: JSONValue, fallback: NSColor = .textColor) -> NSColor {
        guard let hex = value.string, hex.count == 7, hex.first == "#", let number = UInt32(hex.dropFirst(), radix: 16) else { return fallback }
        return NSColor(srgbRed: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255, blue: CGFloat(number & 255) / 255, alpha: 1)
    }
    static func font(_ families: String, size: CGFloat, mono: Bool = false, bold: Bool = false) -> NSFont {
        var selected: NSFont?
        for family in families.split(separator: ",") {
            let name = family.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if name == "-apple-system" || name == "BlinkMacSystemFont" || name == "sans-serif" { selected = .systemFont(ofSize: size); break }
            if name == "monospace" { selected = .monospacedSystemFont(ofSize: size, weight: .regular); break }
            if name == "Cascadia Code", let value = NSFont(name: "CascadiaCode-Regular", size: size) { selected = value; break }
            if let value = NSFont(name: name, size: size) { selected = value; break }
        }
        let font = selected ?? (mono ? .monospacedSystemFont(ofSize: size, weight: .regular) : .systemFont(ofSize: size))
        if bold, font.familyName == "Cascadia Code", let semibold = NSFont(name: "CascadiaCode-SemiBold", size: size) { return semibold }
        return bold ? NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) : font
    }
    static func semiboldFont(_ families: String, size: CGFloat) -> NSFont {
        let regular = font(families, size: size)
        if regular.familyName == NSFont.systemFont(ofSize: size).familyName { return .systemFont(ofSize: size, weight: .semibold) }
        let descriptor = regular.fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: NSFont.Weight.semibold.rawValue]])
        return NSFont(descriptor: descriptor, size: size) ?? regular
    }
    static func terminalTheme(_ settings: JSONValue, catalog: JSONValue) -> JSONValue {
        let id = settings[light(settings) ? "lightTheme" : "darkTheme"]
        return (settings["customThemes"].array + catalog["themes"].array).first { $0["id"] == id } ?? .null
    }
    static func interfacePalette(_ settings: JSONValue, catalog: JSONValue) -> JSONValue {
        let theme = catalog["interfaceThemes"].array.first { $0["id"] == settings["interfaceTheme"] }
        return theme?[light(settings) ? "light" : "dark"] ?? .null
    }
}

@MainActor
final class NativeTerminalView: TerminalView {
    var copyOnSelect = false
    override func mouseUp(with event: NSEvent) {
        super.mouseUp(with: event)
        if copyOnSelect, let selection = getSelection(), !selection.isEmpty { copy(self) }
    }
}
