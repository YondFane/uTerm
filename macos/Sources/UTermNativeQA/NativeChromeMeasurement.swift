import AppKit
import SwiftUI

@MainActor
struct NativeChromeMeasurement: NSViewRepresentable {
    let report: (CGRect) -> Void
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.report = report; view.measure() }
    @MainActor final class Probe: NSView {
        var report: ((CGRect) -> Void)?
        private var previous: CGRect?
        override func layout() { super.layout(); measure() }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); measure() }
        func measure() {
            guard let root = window?.contentView, bounds.height > 0 else { return }
            let raw = convert(bounds, to: root)
            let frame = CGRect(x: raw.minX - root.bounds.minX, y: root.isFlipped ? raw.minY - root.bounds.minY : root.bounds.maxY - raw.maxY, width: raw.width, height: raw.height)
            guard previous != frame else { return }
            previous = frame
            DispatchQueue.main.async { [weak self] in
                guard let self, self.window != nil, self.previous == frame else { return }
                self.report?(frame)
            }
        }
    }
}
