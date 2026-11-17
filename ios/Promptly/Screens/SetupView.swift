import SwiftUI
import PromptlyCore

/// First run: which server is yours?
struct SetupView: View {
    @EnvironmentObject private var state: AppState
    @State private var typed = AppState.builtInHost
    @State private var problem: String?
    @State private var busy = false
    @State private var scanning = false
    @FocusState private var typing: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image("Mark")
                    .resizable()
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                    .padding(.top, 48)
                    .accessibilityHidden(true)
                Text("Welcome to Promptly")
                    .font(.title2.weight(.semibold))
                Text("Type your server's address, or scan the code from Files → Devices on a computer.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                TextField("promptly.example.org", text: $typed)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($typing)
                    .onSubmit(go)
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Server address")

                if let problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Button(action: go) {
                    HStack {
                        if busy { ProgressView().tint(.white) }
                        Text("Continue")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)

                Button {
                    typing = false
                    scanning = true
                } label: {
                    Label("Scan a code", systemImage: "qrcode.viewfinder")
                }
                .disabled(busy)
            }
            .padding(.horizontal, 28)
        }
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $scanning) {
            ScanSheet { link in
                scanning = false
                // Wait for the camera sheet to close before asking "Pair this iPhone?".
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { state.pendingPair = link }
            }
        }
    }

    private func go() {
        problem = nil
        switch ServerAddress.parse(typed) {
        case .failure(let why):
            problem = why.message
        case .success(let address):
            busy = true
            Task {
                defer { busy = false }
                do {
                    try await PairingClient.check(address)
                    state.use(address)
                } catch {
                    problem = error.localizedDescription
                }
            }
        }
    }
}
