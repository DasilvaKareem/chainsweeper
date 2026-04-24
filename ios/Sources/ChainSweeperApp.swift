import SwiftUI
import AVFAudio

@main
struct ChainSweeperApp: App {
    init() {
        configureAudio()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
                .persistentSystemOverlays(.hidden)
        }
    }

    private func configureAudio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }
}
