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
    @StateObject private var radio = RadioPlayer()
    @AppStorage("bridgeURL") private var bridgeURL: String = ""
    @AppStorage("keepAwake") private var keepAwake: Bool = true
    /// the colour scheme (Einstellungen → Farbschema), kept on this Apple TV
    @AppStorage("tvTheme") private var themeName: String = TVTheme.aurora.rawValue
    @State private var showSettings = false
    @State private var confettiTick = 0
    @Environment(\.scenePhase) private var scenePhase

    private var theme: TVTheme { TVTheme(rawValue: themeName) ?? .aurora }

    var body: some View {
        DashboardView(model: model, radio: radio, openSettings: { showSettings = true }, confettiTick: confettiTick)
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
                    radio.stop()                // tvOS would pause it anyway – keep the buttons honest
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
                SettingsView(bridgeURL: $bridgeURL, keepAwake: $keepAwake, themeName: $themeName) {
                    showSettings = false
                    model.start()
                }
                .environment(\.tvTheme, theme)
                .preferredColorScheme(.dark)
            }
            .environment(\.tvTheme, theme)
            // glass and text colours are made for a dark room, whatever tvOS is set to
            .preferredColorScheme(.dark)
    }
}
