import AVFoundation
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

/// Kinder-Routine: one task of one child.
struct TVRoutineItem: Decodable, Identifiable {
    let id: String
    let text: String
    let emoji: String?
    let done: Bool
}

struct TVRoutineKid: Decodable, Identifiable {
    let id: String
    let name: String
    let emoji: String?
    let items: [TVRoutineItem]
    let done: Int
    let total: Int
    let complete: Bool
    let stars: Int?             // finished days in the last 7
}

/// A routine running now (e.g. the evening routine) – ticked off with the remote.
struct TVRoutine: Decodable, Identifiable {
    let id: String
    let title: String
    let emoji: String?
    let to: String?
    let kids: [TVRoutineKid]
    let all_done: Bool?
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
    let routines: [TVRoutine]?
    let radio: [TVRadioStation]?
    let news: [TVNews]?
    let ticker: [TVTickerItem]?
    let note: String?
}

/// A headline from the feeds chosen in Setup.
struct TVNews: Decodable, Identifiable {
    let id: String
    let title: String
    let source: String
    let ago: String?
}

/// One piece of the running band: a football result or match, or a headline.
struct TVTickerItem: Decodable, Identifiable {
    let id: String
    let icon: String?
    let source: String?
    let text: String
}

/// What a station plays, as the bridge read it from the stream (GET /api/radio/now).
struct RadioNowAnswer: Decodable {
    let song: String?
    let cover: String?
    let meta: Bool?
}

/// A radio station from the app's Setup (found via radio-browser.info).
struct TVRadioStation: Decodable, Identifiable {
    let id: String
    let name: String
    let url: String
    let logo: String?           // the station's logo from the directory, if it has one
}

/// Apple's public iTunes search – used only to find the cover of the song the
/// radio plays (artist and title are sent, nothing else).
private struct ITunesAnswer: Decodable {
    struct Hit: Decodable {
        let artistName: String?
        let artworkUrl100: String?
    }
    let results: [Hit]
}

/// Plays a radio stream inside the app, so the dashboard stays in front. The
/// song now playing comes from the stream itself (Icecast/Shoutcast titles),
/// when the station sends it.
@MainActor
final class RadioPlayer: NSObject, ObservableObject, AVPlayerItemMetadataOutputPushDelegate {
    @Published private(set) var playingID: String?
    @Published private(set) var nowPlaying: String?
    @Published private(set) var problem: String?
    /// cover of the song now playing (streams rarely send pictures – it is
    /// looked up by artist and title); nil → the station's logo is shown
    @Published private(set) var cover: URL?
    private var player: AVPlayer?
    private var statusObservation: NSKeyValueObservation?
    private var coverTask: Task<Void, Never>?
    private var coverCache: [String: URL] = [:]
    /// asks the bridge what plays – it reads the stream's titles itself and finds the cover
    private var bridgeTask: Task<Void, Never>?
    /// the bridge knows this station's titles: the stream's own then only says "changed"
    private var bridgeKnows = false

    /// Click on a station: play it – or stop it, when it is the one playing.
    func toggle(_ station: TVRadioStation) {
        if playingID == station.id {
            stop()
        } else {
            play(station)
        }
    }

    func play(_ station: TVRadioStation) {
        stop()
        guard let url = URL(string: station.url) else {
            problem = "Die Adresse von \(station.name) ist ungültig."
            return
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        let item = AVPlayerItem(url: url)
        let output = AVPlayerItemMetadataOutput(identifiers: nil)
        output.setDelegate(self, queue: DispatchQueue.main)
        item.add(output)
        let name = station.name
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            let failed = observed.status == .failed
            Task { @MainActor in
                guard failed, let self else { return }
                self.stop()
                self.problem = "\(name) spielt gerade nicht – der Sender ist nicht erreichbar."
            }
        }
        let newPlayer = AVPlayer(playerItem: item)
        player = newPlayer
        playingID = station.id
        nowPlaying = nil
        problem = nil
        newPlayer.play()
        let id = station.id
        Task { @MainActor [weak self] in
            self?.followBridge(id, fresh: true)
        }
    }

    func stop() {
        player?.pause()
        player = nil
        statusObservation = nil
        coverTask?.cancel()
        coverTask = nil
        bridgeTask?.cancel()
        bridgeTask = nil
        bridgeKnows = false
        playingID = nil
        nowPlaying = nil
        cover = nil
        problem = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A new title from the stream: show it and look for its cover.
    private func setNowPlaying(_ text: String?) {
        guard text != nowPlaying else { return }
        nowPlaying = text
        coverTask?.cancel()
        cover = nil
        guard let text, let artist = RadioPlayer.split(text).artist else { return }
        if let known = coverCache[text] {
            cover = known
            return
        }
        let title = RadioPlayer.split(text).title
        coverTask = Task { [weak self] in
            let found = await RadioPlayer.findCover(artist: artist, title: title)
            guard !Task.isCancelled, let self else { return }
            if let found {
                if self.coverCache.count > 60 { self.coverCache.removeAll() }
                self.coverCache[text] = found
            }
            self.cover = found
        }
    }

    /// While a station plays: every 20 s – and right after the stream says the song
    /// changed – ask the bridge what plays and for the cover.
    @MainActor private func followBridge(_ stationID: String, fresh: Bool) {
        bridgeTask?.cancel()
        bridgeTask = Task { @MainActor [weak self] in
            var fresh = fresh
            while !Task.isCancelled {
                let answer = await RadioPlayer.askBridge(stationID, fresh: fresh)
                guard !Task.isCancelled, let self, self.playingID == stationID else { return }
                if let answer {
                    self.applyBridge(answer)
                }
                fresh = false
                // a stream without titles (or a bridge that cannot tell) is asked less often
                let seconds: UInt64 = answer?.meta == true ? 20 : 120
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            }
        }
    }

    /// The bridge's answer: when it can read the stream's titles, its title and
    /// cover win; otherwise the stream's own titles (as the Apple TV gets them) stay.
    @MainActor private func applyBridge(_ answer: RadioNowAnswer) {
        guard answer.meta == true else {
            bridgeKnows = false
            return
        }
        bridgeKnows = true
        let song = answer.song?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if song.isEmpty {                          // news, talk, ads: just the station
            if nowPlaying != nil {
                nowPlaying = nil
                coverTask?.cancel()
                cover = nil
            }
            return
        }
        let art = answer.cover.flatMap { URL(string: $0) }
        if song != nowPlaying {
            nowPlaying = song
            coverTask?.cancel()
            cover = art
        } else if let art, cover != art {
            cover = art
        }
    }

    /// GET /api/radio/now?id=… (nil when the bridge does not answer – an older
    /// bridge, say; then the stream's own titles are shown).
    nonisolated static func askBridge(_ stationID: String, fresh: Bool) async -> RadioNowAnswer? {
        let raw = UserDefaults.standard.string(forKey: "bridgeURL") ?? ""
        let path = "/api/radio/now?id=" + stationID + (fresh ? "&fresh=1" : "")
        guard let url = DashboardModel.endpoint(raw, path: path) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(RadioNowAnswer.self, from: result.0)
    }

    /// Stream titles carry no character set and arrive read as Latin-1: UTF-8
    /// titles then look garbled ("Ã¼" for "ü"), Turkish Windows ones show "Þ"/"ý"
    /// for "Ş"/"ı" – both are put right here.
    nonisolated static func repair(_ text: String) -> String {
        for encoding in [String.Encoding.isoLatin1, .windowsCP1252] {
            if let bytes = text.data(using: encoding), bytes.contains(where: { $0 >= 0xC2 && $0 <= 0xF4 }),
               let fixed = String(data: bytes, encoding: .utf8), fixed != text {
                return fixed
            }
        }
        let turkish: [Character: Character] = ["Þ": "Ş", "þ": "ş", "Ð": "Ğ", "ð": "ğ", "Ý": "İ", "ý": "ı"]
        return String(text.map { turkish[$0] ?? $0 })
    }

    /// "Artist - Title" (the usual stream title) → its parts; anything else is
    /// taken as a plain title.
    nonisolated static func split(_ text: String) -> (artist: String?, title: String) {
        for separator in [" - ", " – ", " — "] {
            if let range = text.range(of: separator) {
                let artist = text[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
                let title = text[range.upperBound...].trimmingCharacters(in: .whitespaces)
                if !artist.isEmpty && !title.isEmpty {
                    return (artist, title)
                }
            }
        }
        return (nil, text)
    }

    /// The cover from Apple's iTunes search – only when the artist found matches
    /// the one the station named (station slogans and ads get no stray cover).
    nonisolated static func findCover(artist: String, title: String) async -> URL? {
        let want = fold(artist)
        if want.isEmpty { return nil }
        for country in ["DE", "TR"] {
            var comps = URLComponents(string: "https://itunes.apple.com/search")
            comps?.queryItems = [
                URLQueryItem(name: "term", value: artist + " " + title),
                URLQueryItem(name: "media", value: "music"),
                URLQueryItem(name: "entity", value: "song"),
                URLQueryItem(name: "limit", value: "5"),
                URLQueryItem(name: "country", value: country)
            ]
            guard let url = comps?.url,
                  let result = try? await URLSession.shared.data(from: url),
                  let answer = try? JSONDecoder().decode(ITunesAnswer.self, from: result.0) else { continue }
            for hit in answer.results {
                guard let art = hit.artworkUrl100, let name = hit.artistName else { continue }
                let have = fold(name)
                if !have.isEmpty && (have.contains(want) || want.contains(have) || sharesWord(have, want)) {
                    return URL(string: art.replacingOccurrences(of: "100x100bb", with: "600x600bb"))
                }
            }
        }
        return nil
    }

    nonisolated static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated static func sharesWord(_ a: String, _ b: String) -> Bool {
        func words(_ s: String) -> Set<String> {
            Set(s.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count >= 3 })
        }
        return !words(a).isDisjoint(with: words(b))
    }

    nonisolated func metadataOutput(_ output: AVPlayerItemMetadataOutput,
                                    didOutputTimedMetadataGroups groups: [AVTimedMetadataGroup],
                                    from track: AVPlayerItemTrack?) {
        // ICY streams send "StreamTitle"; others (HLS) title and artist apart
        var streamTitle: String?
        var title: String?
        var artist: String?
        var other: String?
        for group in groups {
            for item in group.items {
                guard let raw = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !raw.isEmpty else { continue }
                let text = RadioPlayer.repair(raw)
                if item.identifier == .icyMetadataStreamTitle {
                    streamTitle = streamTitle ?? text
                } else if item.commonKey == .commonKeyTitle {
                    title = title ?? text
                } else if item.commonKey == .commonKeyArtist {
                    artist = artist ?? text
                } else if item.identifier != .icyMetadataStreamURL {
                    other = other ?? text
                }
            }
        }
        var found = streamTitle
        if found == nil, let title {
            found = artist.map { $0 + " - " + title } ?? title
        }
        let text = found ?? other
        Task { @MainActor in
            if self.bridgeKnows, let id = self.playingID {
                self.followBridge(id, fresh: true)      // the song changed – the bridge reads it right
            } else {
                self.setNowPlaying(text)
            }
        }
    }
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

    /// Kinder-Routine: tick (or untick) a task with the remote; the bridge keeps
    /// the list, so the wall dashboard shows the same at once.
    func toggleRoutine(routine: String, kid: String, item: String) async {
        let raw = UserDefaults.standard.string(forKey: "bridgeURL") ?? ""
        guard let url = DashboardModel.endpoint(raw, path: "/api/routine/toggle") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["routine": routine, "kid": kid, "item": item])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 {
                error = "Abhaken hat nicht geklappt (Fehler \(code))."
            }
        } catch {
            self.error = "Abhaken hat nicht geklappt – \(error.localizedDescription)"
        }
        await load()
    }

    /// "192.168.2.20", "mac.local:8090", "http://…/" → http://…:8090/api/tv
    nonisolated static func endpoint(_ raw: String, path: String = "/api/tv") -> URL? {
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
        return URL(string: s + path)
    }
}
