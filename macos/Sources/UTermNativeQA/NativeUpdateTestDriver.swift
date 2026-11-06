import AppKit
import Sparkle
import UTermBridge

@MainActor
// Only the user decisions are simulated; the SDK still downloads, verifies and extracts the actual archive.
// 仅模拟用户决定，SDK 仍实际下载、验签并解压归档。
final class NativeUpdateTestDriver: NSObject, SPUUserDriver {
    let mode: String
    private(set) var ready = false
    private(set) var notFound = false
    private(set) var cancelled = false
    private(set) var receivedBytes: UInt64 = 0
    private(set) var errors: [String] = []
    private(set) var foundVersion: String?
    private var cancelDownload: (() -> Void)?
    init(mode: String) { self.mode = mode }
    func resetForRetry() { ready = false; notFound = false; cancelled = false; receivedBytes = 0; errors = []; foundVersion = nil; cancelDownload = nil }
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        foundVersion = appcastItem.versionString; reply(.install)
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { notFound = true; acknowledgement() }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        errors.append(contentsOf: updateErrorCodes(error)); acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { cancelDownload = cancellation }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
    func showDownloadDidReceiveData(ofLength length: UInt64) {
        receivedBytes += length
        if mode == "cancel", !cancelled { cancelled = true; cancelDownload?() }
    }
    func showDownloadDidStartExtractingUpdate() {}
    func showExtractionReceivedProgress(_ progress: Double) {}
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        ready = true
        reply(.dismiss)
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {}
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() { cancelDownload = nil }
    func showUpdateInFocus() {}
}
