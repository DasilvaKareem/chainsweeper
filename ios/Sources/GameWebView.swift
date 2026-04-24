import SwiftUI
import WebKit
import UIKit

struct GameWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        config.setURLSchemeHandler(
            BundleSchemeHandler(),
            forURLScheme: AppConfig.bundleScheme
        )

        // JS → native bridge. Web code calls
        // `window.webkit.messageHandlers.haptic.postMessage({style})` to fire
        // a UIKit haptic (impact or selection). WKWebView has no built-in
        // equivalent to `navigator.vibrate`, so we ship our own.
        config.userContentController.add(
            context.coordinator,
            name: "haptic"
        )

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.contentMode = .scaleToFill
        webView.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> HapticBridge {
        HapticBridge()
    }
}

final class HapticBridge: NSObject, WKScriptMessageHandler {
    // Generators are kept as instance properties so prepare() can warm them
    // up — first-impact latency is ~60ms without a warmed generator, which
    // is long enough to feel disconnected from the triggering tap.
    private let lightImpact = UIImpactFeedbackGenerator(style: .light)
    private let mediumImpact = UIImpactFeedbackGenerator(style: .medium)
    private let heavyImpact = UIImpactFeedbackGenerator(style: .heavy)
    private let selection = UISelectionFeedbackGenerator()
    private let notification = UINotificationFeedbackGenerator()

    override init() {
        super.init()
        lightImpact.prepare()
        mediumImpact.prepare()
        heavyImpact.prepare()
        selection.prepare()
        notification.prepare()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any] else { return }
        let style = (body["style"] as? String) ?? "medium"
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch style {
            case "light":
                self.lightImpact.impactOccurred()
                self.lightImpact.prepare()
            case "heavy":
                self.heavyImpact.impactOccurred()
                self.heavyImpact.prepare()
            case "selection":
                self.selection.selectionChanged()
                self.selection.prepare()
            case "success":
                self.notification.notificationOccurred(.success)
                self.notification.prepare()
            case "warning":
                self.notification.notificationOccurred(.warning)
                self.notification.prepare()
            case "error":
                self.notification.notificationOccurred(.error)
                self.notification.prepare()
            default:
                self.mediumImpact.impactOccurred()
                self.mediumImpact.prepare()
            }
        }
    }
}
