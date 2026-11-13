import SwiftUI

@MainActor
struct NativeSettingsForm<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28).padding(.vertical, 18)
        }.scrollIndicators(.hidden).toggleStyle(.checkbox)
    }
}
