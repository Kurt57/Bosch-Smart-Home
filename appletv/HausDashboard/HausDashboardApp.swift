// Haus-Dashboard für Apple TV – zeigt das Wohn-Dashboard der Energie-Bridge.
//
// Die App rechnet nichts selbst: Sie holt alle 15 Sekunden /api/tv von der
// Bridge (fertig formulierte Hinweise, Energie, Räume, Termine) und ordnet die
// Texte für den Fernseher an. Nur Standard-Schnittstellen von tvOS.

import SwiftUI
import UIKit

@main
struct HausDashboardApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @StateObject private var model = DashboardModel()
    @AppStorage("bridgeURL") private var bridgeURL: String = ""
    @AppStorage("keepAwake") private var keepAwake: Bool = true
    @State private var showSettings = false
    @State private var confettiTick = 0
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        DashboardView(model: model, openSettings: { showSettings = true }, confettiTick: confettiTick)
            .onAppear {
                // a wall display: no screen saver while the dashboard is open (switchable)
                UIApplication.shared.isIdleTimerDisabled = keepAwake
                if bridgeURL.isEmpty { showSettings = true }
                model.start()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    UIApplication.shared.isIdleTimerDisabled = keepAwake
                    model.start()
                } else if phase == .background {
                    model.stop()
                }
            }
            .onChange(of: keepAwake) { _, on in
                UIApplication.shared.isIdleTimerDisabled = on
            }
            .onPlayPauseCommand {
                confettiTick += 1               // on a party day: confetti again
                Task { await model.load() }
            }
            .fullScreenCover(isPresented: $showSettings) {
                SettingsView(bridgeURL: $bridgeURL, keepAwake: $keepAwake) {
                    showSettings = false
                    model.start()
                }
                .preferredColorScheme(.dark)
            }
            // glass and text colours are made for a dark room, whatever tvOS is set to
            .preferredColorScheme(.dark)
    }
}
