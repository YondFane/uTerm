import AppKit
import Sparkle
import UTermBridge

@MainActor
final class NativeUpdates: NSObject, ObservableObject, @preconcurrency SPUUpdaterDelegate {
    @Published private(set) var error = ""
    @Published private(set) var status = ""
    private(set) var configuration: NativeUpdateConfiguration?
    private(set) var controller: SPUStandardUpdaterController?
    private var started = false
    private var automatic = false
    private var appliedAutomatic: Bool?
    private(set) var qaEvents: [String] = []
    private(set) var qaLastError = ""
    var available: Bool { configuration != nil }

    override init() {
        super.init()
        guard let text = Bundle.main.object(forInfoDictionaryKey: "UTermUpdateFeedURL") as? String else { return }
        do {
            #if arch(arm64)
            let architecture = "arm64"
            #else
            let architecture = "x86_64"
            #endif
            guard let feed = URL(string: text), let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String else { throw BridgeFailure(code: "UPDATE_CONFIGURATION", message: "Missing update feed or public key") }
            configuration = try NativeUpdateConfiguration(feed: feed, channel: Bundle.main.object(forInfoDictionaryKey: "UTermUpdateChannel") as? String ?? "stable", architecture: architecture, publicKey: key, qa: Bundle.main.bundleIdentifier?.hasPrefix("sh.uterm.desktop.qa.") == true)
        } catch { self.error = error.localizedDescription }
    }
    func apply(_ settings: JSONValue) {
        automatic = settings["automaticUpdates"].bool == true
        guard available, automatic || controller != nil else { return }
        do { try start() } catch { self.error = error.localizedDescription }
    }
    private func start() throws {
        guard configuration != nil else { throw BridgeFailure(code: "UPDATES_UNAVAILABLE", message: localized("Update checks are unavailable for this build.", "此构建暂不提供更新检查。")) }
        if controller == nil { controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil) }
        guard let updater = controller?.updater else { return }
        if appliedAutomatic != automatic {
            // Shared settings are canonical; Sparkle must not revive a cached automatic opt-in.
            // 共享设置是唯一来源，Sparkle 不能恢复缓存中的自动更新授权。
            updater.automaticallyChecksForUpdates = automatic
            updater.automaticallyDownloadsUpdates = false
            appliedAutomatic = automatic
        }
        if !started { try updater.start(); started = true }
    }
    func check() {
        do {
            try start()
            guard let controller, controller.updater.canCheckForUpdates else { return }
            error = ""; status = localized("Checking for updates…", "正在检查更新…")
            controller.checkForUpdates(nil)
        } catch { self.error = error.localizedDescription }
    }
    func feedURLString(for updater: SPUUpdater) -> String? { configuration?.feed.absoluteString }
    func allowedChannels(for updater: SPUUpdater) -> Set<String> { Set(configuration.map { [$0.channel] } ?? []) }
    func updaterShouldPromptForPermissionToCheck(for updater: SPUUpdater) -> Bool { false }
    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard let configuration, let url = item.fileURL else { throw BridgeFailure(code: "UPDATE_TARGET", message: "Missing update archive") }
        try configuration.validateArchive(url, platform: item.propertiesDictionary["uterm:platform"] as? String, architecture: item.propertiesDictionary["uterm:architecture"] as? String, channel: item.channel)
        qaEvents.append("target-accepted:" + item.versionString)
    }
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) { status = localized("Update available: ", "发现新版本：") + item.displayVersionString; qaEvents.append("found:" + item.versionString) }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        self.error = localized("Update failed. Check the connection and retry.", "更新失败，请检查连接后重试。")
        let failure = error as NSError; qaLastError = failure.domain + ":" + String(failure.code)
        qaEvents.append("abort:" + qaLastError)
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        if error == nil { self.error = ""; status = localized("Update check finished.", "更新检查已完成。") }
        qaEvents.append("cycle-finished")
    }
}
