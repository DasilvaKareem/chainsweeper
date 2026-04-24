import Foundation
import WebKit
import UniformTypeIdentifiers

/// Serves files from the app bundle's `web/` directory in response to `app://` URLs.
/// Using a custom scheme (instead of `file://`) gives the web build a real origin,
/// which ES modules, fetch, and localStorage all require.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let rootPath: String

    init(rootPath: String = AppConfig.bundleWebRoot) {
        self.rootPath = rootPath
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(Self.error(.badURL))
            return
        }

        var relativePath = url.path
        if relativePath.isEmpty || relativePath == "/" {
            relativePath = "/index.html"
        }
        // Strip leading slash so it's a relative resource path.
        if relativePath.hasPrefix("/") {
            relativePath.removeFirst()
        }

        let fullRelative = "\(rootPath)/\(relativePath)"
        guard
            let resourceURL = Bundle.main.url(forResource: fullRelative, withExtension: nil),
            let data = try? Data(contentsOf: resourceURL)
        else {
            urlSchemeTask.didFailWithError(Self.error(.fileDoesNotExist, url: url))
            return
        }

        let mimeType = Self.mimeType(for: resourceURL.pathExtension)
        let headers: [String: String] = [
            "Content-Type": mimeType,
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        ]
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!

        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // No long-running work to cancel — bundle reads are synchronous.
    }

    private static func mimeType(for ext: String) -> String {
        if let type = UTType(filenameExtension: ext)?.preferredMIMEType {
            return type
        }
        switch ext.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "css":       return "text/css"
        case "html":      return "text/html"
        case "json":      return "application/json"
        case "svg":       return "image/svg+xml"
        case "wasm":      return "application/wasm"
        default:          return "application/octet-stream"
        }
    }

    private static func error(_ code: URLError.Code, url: URL? = nil) -> NSError {
        var info: [String: Any] = [:]
        if let url { info[NSURLErrorFailingURLErrorKey] = url }
        return NSError(domain: NSURLErrorDomain, code: code.rawValue, userInfo: info)
    }
}
