import AVFoundation
import SwiftUI
import UIKit
import PromptlyCore

/// Point the camera at the pairing code from Files → Devices.
struct ScanSheet: View {
    let found: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access: Access = .asking
    @State private var note: String?

    enum Access { case asking, yes, no, noCamera }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch access {
                case .asking:
                    ProgressView().tint(.white)
                case .yes:
                    CameraView { text in
                        if let link = PairingLink.parse(text) {
                            found(link)
                        } else {
                            note = "That isn't a Promptly pairing code."
                        }
                    }
                    .ignoresSafeArea()
                    VStack {
                        Spacer()
                        Text(note ?? "On a computer, open Files → Devices → Add a phone, then point the camera at the code.")
                            .font(.callout)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white)
                            .padding(14)
                            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .padding(24)
                    }
                case .no:
                    message("Promptly isn't allowed to use the camera. Turn it on in Settings → Promptly → Camera.", settings: true)
                case .noCamera:
                    message("This device has no camera to scan with.", settings: false)
                }
            }
            .navigationTitle("Scan a code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .task { await ask() }
    }

    private func message(_ text: String, settings: Bool) -> some View {
        VStack(spacing: 16) {
            Text(text)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
            if settings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(32)
    }

    private func ask() async {
        guard AVCaptureDevice.default(for: .video) != nil else {
            access = .noCamera
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            access = .yes
        case .notDetermined:
            access = await AVCaptureDevice.requestAccess(for: .video) ? .yes : .no
        default:
            access = .no
        }
    }
}

/// The live camera picture, reporting any QR code it reads.
private struct CameraView: UIViewControllerRepresentable {
    let read: (String) -> Void

    func makeUIViewController(context: Context) -> CameraController {
        let controller = CameraController()
        controller.read = read
        return controller
    }

    func updateUIViewController(_ controller: CameraController, context: Context) {
        controller.read = read
    }
}

final class CameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var read: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "org.promptly.scan")
    private var preview: AVCaptureVideoPreviewLayer?
    private var last = ""
    private var lastAt = Date.distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = session
        queue.async { if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = session
        queue.async { if session.isRunning { session.stopRunning() } }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = code.stringValue else { return }
        // The camera reports the same code many times a second; pass each one on once.
        if text == last, Date().timeIntervalSince(lastAt) < 3 { return }
        last = text
        lastAt = Date()
        read?(text)
    }
}
