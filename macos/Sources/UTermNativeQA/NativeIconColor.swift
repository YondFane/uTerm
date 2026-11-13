import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeIconColor: View {
    @ObservedObject var model: NativeSettingsModel
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(localized("Icon highlight", "图标高亮"))
            Mode(model: model).frame(height: 26)
            if !(model.values["activeIconColor"]?.string ?? "").isEmpty {
                Text(localized("Custom highlight color", "自定义高亮颜色"))
                HStack(spacing: 8) {
                    Swatch(model: model).frame(width: 40, height: 28)
                    NativeSettingsField(model: model, key: "activeIconColor", numeric: false, label: localized("Highlight color value", "高亮颜色值")).frame(height: 26)
                }
            }
            Text(localized("Used for sidebar navigation and tool-panel switching. Applies and saves immediately.", "用于侧栏导航和工具面板切换，立即生效并自动保存。")).font(.caption).foregroundStyle(.secondary)
        }
    }

    @MainActor private struct Mode: NSViewRepresentable {
        @ObservedObject var model: NativeSettingsModel
        func makeCoordinator() -> Coordinator { Coordinator(model) }
        func makeNSView(context: Context) -> NSPopUpButton {
            let picker = NSPopUpButton(frame: .zero, pullsDown: false)
            picker.identifier = .init("native-settings-icon-color-mode")
            picker.target = context.coordinator; picker.action = #selector(Coordinator.select(_:))
            return picker
        }
        func updateNSView(_ picker: NSPopUpButton, context: Context) {
            picker.removeAllItems()
            for (id, label) in [("theme", localized("Follow theme", "跟随主题")), ("custom", localized("Custom color", "自定义颜色"))] {
                picker.addItem(withTitle: label); picker.lastItem?.representedObject = id
            }
            picker.selectItem(at: (model.values["activeIconColor"]?.string ?? "").isEmpty ? 0 : 1)
            picker.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
            picker.setAccessibilityLabel(localized("Icon highlight", "图标高亮"))
        }
        @MainActor final class Coordinator: NSObject {
            let model: NativeSettingsModel
            init(_ model: NativeSettingsModel) { self.model = model }
            @objc func select(_ picker: NSPopUpButton) {
                guard !model.busy, !model.frozen, let mode = picker.selectedItem?.representedObject as? String else { return }
                let accent = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)["accent"].string ?? "#62d98a"
                model.values["activeIconColor"] = .string(mode == "theme" ? "" : accent)
                model.saveAutomatically(["activeIconColor"])
            }
        }
    }

    @MainActor private struct Swatch: NSViewRepresentable {
        @ObservedObject var model: NativeSettingsModel
        func makeCoordinator() -> Coordinator { Coordinator(model) }
        func makeNSView(context: Context) -> NSColorWell {
            let well = NSColorWell()
            well.identifier = .init("native-settings-icon-color-well")
            well.target = context.coordinator; well.action = #selector(Coordinator.select(_:))
            well.setAccessibilityLabel(localized("Custom highlight color", "自定义高亮颜色"))
            return well
        }
        func updateNSView(_ well: NSColorWell, context: Context) {
            let accent = NativePreferences.interfacePalette(model.workspace.settings, catalog: model.catalog)["accent"]
            let saved = NativePreferences.color(model.lastSavedValue("activeIconColor"), fallback: NativePreferences.color(accent))
            well.color = NativePreferences.color(model.values["activeIconColor"] ?? .null, fallback: saved)
            well.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
        }
        @MainActor final class Coordinator: NSObject {
            let model: NativeSettingsModel
            init(_ model: NativeSettingsModel) { self.model = model }
            @objc func select(_ well: NSColorWell) {
                guard !model.busy, !model.frozen, let color = well.color.usingColorSpace(.sRGB) else { return }
                let channels = [color.redComponent, color.greenComponent, color.blueComponent].map { Int((min(1, max(0, $0)) * 255).rounded()) }
                model.values["activeIconColor"] = .string(String(format: "#%02x%02x%02x", channels[0], channels[1], channels[2]))
                model.saveAutomatically(["activeIconColor"])
            }
        }
    }
}
