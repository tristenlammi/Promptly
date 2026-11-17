import SafariServices
import SwiftUI
import UIKit
import WebKit
import PromptlyCore

/// What the screen around the web view needs to know about it.
@MainActor
final class WebPage: ObservableObject {
    /// Set when the server couldn't be reached; the words to show.
    @Published var problem: String?
    fileprivate var retryAction: (() -> Void)?

    func retry() {
        problem = nil
        retryAction?()
    }
}

/// The server's own web app, shown in a web view. The rules for where links
/// go, what may use the camera, and what counts as a download live in
/// PromptlyCore (`LinkPolicy`), where they are tested.
struct WebScreen: UIViewRepresentable {
    let server: ServerAddress
    @ObservedObject var page: WebPage
    @Binding var pendingPath: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(server: server, page: page)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The default store keeps cookies and site data between launches: one sign-in.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.applicationNameForUserAgent = UserAgent.suffix(version: AppState.version)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Lets the web app know it's inside the iPhone app, and which version.
        let version = AppState.version.filter { $0.isNumber || $0 == "." }
        let hello = "window.PromptlyNative = Object.freeze({ platform: 'ios', version: '\(version)', caps: [] });"
        configuration.userContentController.addUserScript(
            WKUserScript(source: hello, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        // The web app lays itself out under the notch and home bar
        // (viewport-fit=cover), and scrolls inside its own panes, so the page
        // itself never rubber-bands or pulls to refresh.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "LaunchBackground")
        webView.scrollView.backgroundColor = UIColor(named: "LaunchBackground")
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        context.coordinator.webView = webView
        page.retryAction = { [weak coordinator = context.coordinator] in coordinator?.reload() }
        let first = pendingPath.flatMap { server.url(path: $0) } ?? server.url
        if pendingPath != nil { DispatchQueue.main.async { pendingPath = nil } }
        webView.load(URLRequest(url: first))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let path = pendingPath else { return }
        DispatchQueue.main.async { pendingPath = nil }
        if let url = server.url(path: path) {
            page.problem = nil
            webView.load(URLRequest(url: url))
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let server: ServerAddress
        let page: WebPage
        weak var webView: WKWebView?
        private var lastWanted: URL?
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(server: ServerAddress, page: WebPage) {
            self.server = server
            self.page = page
        }

        func reload() {
            guard let webView else { return }
            if webView.url != nil, webView.url?.absoluteString != "about:blank" {
                webView.reload()
            } else {
                webView.load(URLRequest(url: lastWanted ?? server.url))
            }
        }

        // MARK: Where links go

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            switch LinkPolicy.decide(url, server: server, mainFrame: mainFrame) {
            case .inApp:
                if mainFrame, server.owns(url) { lastWanted = url }
                decisionHandler(.allow)
            case .browser:
                decisionHandler(.cancel)
                showInBrowser(url)
            case .system:
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
            case .block:
                decisionHandler(.cancel)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            guard navigationResponse.isForMainFrame else {
                decisionHandler(.allow)
                return
            }
            let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
            if LinkPolicy.isDownload(contentDisposition: disposition, canShow: navigationResponse.canShowMIMEType) {
                decisionHandler(.download)
            } else {
                decisionHandler(.allow)
            }
        }

        /// A link that asks for a new tab (`target="_blank"`, `window.open`).
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            switch LinkPolicy.decide(url, server: server, mainFrame: true) {
            case .inApp:
                webView.load(navigationAction.request)
            case .browser:
                showInBrowser(url)
            case .system:
                UIApplication.shared.open(url)
            case .block:
                break
            }
            return nil
        }

        private func showInBrowser(_ url: URL) {
            let safari = SFSafariViewController(url: url)
            safari.preferredControlTintColor = UIColor(named: "AccentColor")
            presenter?.present(safari, animated: true)
        }

        // MARK: Loading and failing

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            page.problem = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // iOS closed the page to free memory; bring it back.
            reload()
        }

        private func report(_ error: Error) {
            let e = error as NSError
            if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
            // "Frame load interrupted": the page turned into a download. Not a failure.
            if e.domain == "WebKitErrorDomain", e.code == 102 { return }
            guard e.domain == NSURLErrorDomain else { return }
            page.problem = e.localizedDescription
        }

        // MARK: Camera and microphone

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            // iOS has already asked the person once for the app as a whole. The
            // server's own pages don't ask again each time; nothing else gets either.
            let allowed = LinkPolicy.mayCapture(host: origin.host, scheme: origin.protocol, port: origin.port, server: server)
            decisionHandler(allowed ? .grant : .deny)
        }

        // MARK: alert(), confirm() and prompt() from the page

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            show(alert, otherwise: completionHandler)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            show(alert) { completionHandler(false) }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                completionHandler(alert?.textFields?.first?.text ?? "")
            })
            show(alert) { completionHandler(nil) }
        }

        /// The page is waiting for an answer, so if the box can't be shown it must still get one.
        private func show(_ alert: UIAlertController, otherwise: @escaping () -> Void) {
            guard let presenter else {
                otherwise()
                return
            }
            presenter.present(alert, animated: true)
        }

        /// The view controller on top, which is the only one allowed to present another.
        private var presenter: UIViewController? {
            var top = webView?.window?.rootViewController
            while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
            return top
        }

        // MARK: Downloads

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping (URL?) -> Void
        ) {
            // Each download gets a folder of its own, so two files with one name can't clash.
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("downloads", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            } catch {
                completionHandler(nil)
                return
            }
            let file = folder.appendingPathComponent(LinkPolicy.fileName(suggested: suggestedFilename))
            downloads[ObjectIdentifier(download)] = file
            completionHandler(file)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            // The share sheet is where "Save to Files", "Save Image", AirDrop and the rest live.
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = webView
            sheet.completionWithItemsHandler = { _, _, _, _ in
                try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            }
            presenter?.present(sheet, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
                try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            }
            let alert = UIAlertController(title: "The download didn't finish", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            presenter?.present(alert, animated: true)
        }
    }
}
