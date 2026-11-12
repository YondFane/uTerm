import AppKit
import SwiftUI
import UTermBridge

@MainActor
struct NativeFontPickerRow: View {
    @ObservedObject var model: NativeSettingsModel
    let key: String
    let title: String
    var body: some View {
        HStack {
            Text(title)
            Spacer()
            NativeFontPicker(model: model, key: key).frame(minWidth: 140, idealWidth: 230, maxWidth: 260, minHeight: 24)
        }
    }
}

@MainActor
private struct NativeFontPicker: NSViewRepresentable {
    @ObservedObject var model: NativeSettingsModel
    let key: String
    func makeCoordinator() -> Coordinator { Coordinator(model: model, key: key) }
    func makeNSView(context: Context) -> NSPopUpButton {
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        picker.identifier = NSUserInterfaceItemIdentifier("native-settings-font-" + key)
        picker.target = context.coordinator; picker.action = #selector(Coordinator.select(_:))
        picker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        picker.setAccessibilityLabel(key == "interfaceFont" ? localized("Interface font", "界面字体") : localized("Terminal font family", "终端字体"))
        return picker
    }
    func updateNSView(_ picker: NSPopUpButton, context: Context) {
        let value = model.values[key]?.string ?? ""
        let fonts = model.catalog["fonts"][key].array
        picker.removeAllItems()
        if !fonts.contains(where: { $0["value"].string == value }) {
            picker.addItem(withTitle: localized("Current custom font: ", "当前自定义字体：") + value)
            picker.lastItem?.representedObject = value
        }
        for font in fonts {
            picker.addItem(withTitle: model.title(font))
            picker.lastItem?.representedObject = font["value"].string
        }
        if let item = picker.itemArray.first(where: { $0.representedObject as? String == value }) { picker.select(item) }
        picker.isEnabled = context.environment.isEnabled && !model.busy && !model.frozen
    }
    @MainActor final class Coordinator: NSObject {
        let model: NativeSettingsModel
        let key: String
        init(model: NativeSettingsModel, key: String) { self.model = model; self.key = key }
        @objc func select(_ picker: NSPopUpButton) {
            guard !model.busy, !model.frozen, let value = picker.selectedItem?.representedObject as? String else { return }
            model.values[key] = .string(value); model.saveAutomatically([key])
        }
    }
}
