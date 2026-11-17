import SwiftUI
import PromptlyCore

struct RootView: View {
    @EnvironmentObject private var state: AppState
    @State private var pairProblem: String?
    @State private var pairing = false

    var body: some View {
        Group {
            if let server = state.server {
                WebContainer(server: server)
                    // A different server is a different web view, with nothing carried over.
                    .id(server.origin)
            } else {
                SetupView()
            }
        }
        .sheet(isPresented: $state.showingSettings) {
            SettingsView()
        }
        .alert(
            "Pair this iPhone?",
            isPresented: Binding(get: { state.pendingPair != nil && !pairing }, set: { if !$0 { state.pendingPair = nil } }),
            presenting: state.pendingPair
        ) { link in
            Button("Pair") { pair(link) }
            Button("Not now", role: .cancel) { state.pendingPair = nil }
        } message: { link in
            Text("This iPhone will be added to your devices on \(link.server.host).")
        }
        .alert("Pairing didn't work", isPresented: Binding(get: { pairProblem != nil }, set: { if !$0 { pairProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(pairProblem ?? "")
        }
    }

    private func pair(_ link: PairingLink) {
        pairing = true
        Task {
            defer {
                pairing = false
                state.pendingPair = nil
            }
            do {
                try await state.pair(with: link)
            } catch {
                pairProblem = error.localizedDescription
            }
        }
    }
}

/// The server's web app, with a plain page over it when it can't be reached.
struct WebContainer: View {
    let server: ServerAddress
    @EnvironmentObject private var state: AppState
    @StateObject private var page = WebPage()

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()
            WebScreen(server: server, page: page, pendingPath: $state.pendingPath)
                .ignoresSafeArea()
                .opacity(page.problem == nil ? 1 : 0)
            if let problem = page.problem {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                    Text("Can't reach your server")
                        .font(.title3.weight(.semibold))
                    Text(problem)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try again") { page.retry() }
                        .buttonStyle(.borderedProminent)
                    Button("This iPhone") { state.showingSettings = true }
                        .font(.callout)
                }
                .padding(32)
            }
        }
    }
}
