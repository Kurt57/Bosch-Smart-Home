import SwiftUI
import SwiftData

@main
struct RechnungApp: App {
    var body: some Scene {
        WindowGroup {
            HistoryView()
                .environment(\.locale, Locale(identifier: "de_DE"))
        }
        .modelContainer(for: Invoice.self)
    }
}
