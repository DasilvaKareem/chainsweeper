import SwiftUI

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            GameWebView(url: AppConfig.startURL)
                .ignoresSafeArea()
        }
    }
}
