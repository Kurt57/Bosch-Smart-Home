import Foundation
import SwiftUI

// What /api/tv delivers – every value is already a display text (German).
// All fields optional where the bridge may leave them out, so an older or
// newer bridge never breaks the decoding.

struct TVHeader: Decodable {
    let outdoor: String?
    let status: String?
    let hp: String?
}

struct TVAlert: Decodable, Identifiable {
    let id: String
    let level: String
    let icon: String
    let title: String
    let detail: String?
    let blink: Bool?
}

struct TVTile: Decodable, Identifiable {
    let id: String
    let icon: String?
    let label: String
    let value: String
    let sub: String?
    let tone: String?
    let pct: Double?            // 0 … 1 for shares (autark, Eigenverbrauch) – drawn as a ring
}

struct TVRoom: Decodable, Identifiable {
    let id: String
    let name: String
    let temp: String
    let soll: String?
    let info: String?
    let tone: String?
    let t: Double?              // °C, for the thermometer bar
    let ref: Double?            // the wish (or a real setpoint) – marker on the bar
    let hum: Double?
}

/// Power right now in W, for the animated flow picture. Fronius signs:
/// battery > 0 discharging, < 0 charging; grid > 0 import, < 0 export.
struct TVLive: Decodable {
    let pv_w: Double?
    let load_w: Double?
    let batt_w: Double?
    let grid_w: Double?
    let soc: Double?
    let hp_w: Double?
}

struct TVEvent: Decodable, Identifiable {
    let id: String
    let day: String
    let time: String
    let title: String
    let loc: String?
    let now: Bool?
}

/// Feier-Modus: a birthday or anniversary (set in the app's Setup, or an
/// all-day calendar entry today) – a greeting in the header and confetti.
struct TVParty: Decodable, Equatable {
    let title: String
    let sub: String?
    let emoji: String?
}

struct TVPayload: Decodable {
    let ok: Bool?
    let ts: Int?
    let stand: String?
    let live: TVLive?
    let header: TVHeader?
    let alerts: [TVAlert]?
    let more: Int?
    let flow: [TVTile]?
    let today: [TVTile]?
    let rooms: [TVRoom]?
    let events: [TVEvent]?
    let party: TVParty?
    let note: String?
}

@MainActor
final class DashboardModel: ObservableObject {
    @Published var payload: TVPayload?
    @Published var error: String?
    @Published var lastOK: Date?

    private var loop: Task<Void, Never>?

    /// Polls the bridge every 15 seconds while the app is in front.
    func start() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func load() async {
        let raw = UserDefaults.standard.string(forKey: "bridgeURL") ?? ""
        guard let url = DashboardModel.endpoint(raw) else {
            error = "Bitte die Adresse der Bridge eintragen – Mitte der Fernbedienung drücken (⚙︎ oben rechts)."
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else {
                error = code == 403
                    ? "Die Bridge lehnt den Zugriff ab (403) – ist das Apple TV im Heimnetz?"
                    : "Die Bridge antwortet mit Fehler \(code) – ist sie aktuell (ab v219)?"
                return
            }
            payload = try JSONDecoder().decode(TVPayload.self, from: data)
            error = nil
            lastOK = Date()
        } catch {
            self.error = "Bridge nicht erreichbar – \(error.localizedDescription)"
        }
    }

    /// "192.168.2.20", "mac.local:8090", "http://…/" → http://…:8090/api/tv
    static func endpoint(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            s = "http://" + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let base = URL(string: s) else { return nil }
        if base.port == nil && base.scheme == "http" && base.path.isEmpty {
            s += ":8090"            // the bridge's default port
        }
        return URL(string: s + "/api/tv")
    }
}
