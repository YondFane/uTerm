import Foundation
#if os(macOS)
import Darwin
#endif

public enum WindowCaptureSystemPointer {
    // Hidden cursors can retain WindowServer metadata; require the kernel-reported system executable.
    // 光标隐藏后仍可能保留 WindowServer 元数据，因此必须核实内核报告的系统可执行路径。
    public static func isHiddenPointer(hiddenByQA: Bool, executable: String?, layer: Int, width: Double, height: Double) -> Bool {
        hiddenByQA && ["/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
                       "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer"].contains(executable ?? "")
            && layer == 2147483630 && width.isFinite && height.isFinite
            && width > 0 && height > 0 && width <= 128 && height <= 128
    }

    #if os(macOS)
    public static func executable(pid: Int32) -> String? {
        // libproc's maximum is 4096 bytes; Xcode 16.4 does not export its size macro to Swift.
        // libproc 的上限为 4096 字节；Xcode 16.4 不向 Swift 导出该尺寸宏。
        var buffer = [CChar](repeating: 0, count: 4096)
        let count = buffer.withUnsafeMutableBufferPointer { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        guard count > 0 else { return nil }
        return String(cString: buffer)
    }
    #endif
}
