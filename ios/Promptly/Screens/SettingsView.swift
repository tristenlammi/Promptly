import SwiftUI
import PromptlyCore

/// "This iPhone": which server, whether it's paired, and how to change either.
/// Reached from the long-press menu on the app's icon, or when the server can't be reached.
struct SettingsView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var scanning = false
    @State private var confirmingForget = false
    @State private var confirmingUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    if let server = state.server {
                        LabeledContent("Address", value: server.origin)
                    } else {
                        Text("No server chosen yet.")
                    }
                }

                Section {
                    if let account = state.account {
                        LabeledContent("Paired as", value: account.deviceName)
                        LabeledContent("Account", value: account.username)
                        Button("Stop using this pairing", role: .destructive) { confirmingUnpair = true }
                    } else {
                        Text("Not paired yet.")
                        Button {
                            scanning = true
                        } label: {
                            Label("Scan a pairing code", systemImage: "qrcode.viewfinder")
                        }
                    }
                } header: {
                    Text("This iPhone")
                } footer: {
                    Text("Pairing gives this iPhone its own sign-in for photo backup and notifications, which arrive in a later version. You'll find it under Account → Devices on your server, where you can remove it at any time.")
                }

                if state.server != nil {
                    Section {
                        Button("Use a different server", role: .destructive) { confirmingForget = true }
                    } footer: {
                        Text("Signs you out here and forgets this server on this iPhone. Nothing on the server changes.")
                    }
                }

                Section {
                    LabeledContent("Version", value: "\(AppState.version) (\(AppState.build))")
                }
            }
            .navigationTitle("This iPhone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $scanning) {
                ScanSheet { link in
                    scanning = false
                    dismiss()
                    // Wait for both sheets to close before asking "Pair this iPhone?".
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { state.pendingPair = link }
                }
            }
            .confirmationDialog("Stop using this pairing?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Stop using it", role: .destructive) { state.unpair() }
            } message: {
                Text("To remove it completely, also remove this iPhone under Account → Devices on your server.")
            }
            .confirmationDialog("Use a different server?", isPresented: $confirmingForget, titleVisibility: .visible) {
                Button("Forget this server", role: .destructive) {
                    Task {
                        await state.forgetServer()
                        dismiss()
                    }
                }
            }
        }
    }
}
