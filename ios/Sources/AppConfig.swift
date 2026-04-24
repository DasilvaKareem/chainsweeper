import Foundation

enum AppConfig {
    /// When true, the WebView loads the bundled web build via the `app://` scheme.
    /// When false, it loads `remoteURL` — useful for iterating against the Vite dev server.
    static let useLocalBundle = true

    /// Remote URL used when `useLocalBundle` is false.
    /// For the Vite dev server on your Mac, use your LAN IP (e.g. http://192.168.1.42:5173)
    /// so a physical device can reach it. `localhost` only works in the simulator.
    static let remoteURL = URL(string: "http://localhost:5173")!

    /// Custom scheme used to serve the bundled build. `http`/`https`/`file` are reserved
    /// by WKWebView, so we pick something unique.
    static let bundleScheme = "app"

    /// Host component for the custom scheme URL.
    static let bundleHost = "chainsweeper.local"

    /// Relative path inside the app bundle where the Vite `dist/` has been copied.
    static let bundleWebRoot = "web"

    static var startURL: URL {
        if useLocalBundle {
            return URL(string: "\(bundleScheme)://\(bundleHost)/index.html")!
        }
        return remoteURL
    }
}
