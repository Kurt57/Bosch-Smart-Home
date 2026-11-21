import SwiftUI

// Layout for a TV (1920 × 1080 points, of which about 1760 × 960 lie inside
// the safe area): clock and status on top; on the left what needs attention,
// energy now and today; on the right the rooms and the next dates. Every
// section is limited so the whole page fits without scrolling. Colours follow
// the web dashboard (dark).

private var cardFill: Color { Color.white.opacity(0.07) }

private func tileLabel(_ tile: TVTile) -> String {
    guard let icon = tile.icon, !icon.isEmpty else { return tile.label }
    return icon + " " + tile.label
}

private func eventLine(_ event: TVEvent) -> String {
    guard let loc = event.loc, !loc.isEmpty else { return event.title }
    return event.title + " · " + loc
}

private func levelColor(_ level: String) -> Color {
    switch level {
    case "urgent": return .red
    case "warn": return .orange
    case "good": return .green
    default: return .blue
    }
}

private func toneColor(_ tone: String?) -> Color {
    switch tone ?? "" {
    case "good": return .green
    case "warn": return .orange
    case "cold": return .cyan
    case "heat": return Color(red: 1.0, green: 0.62, blue: 0.3)
    case "muted": return .secondary
    default: return .primary
    }
}

/// Moves the page by a few points every minute – a picture that stands still
/// for hours can burn into OLED TVs. The safe-area margin leaves room for it.
private func burnInShift(_ date: Date) -> CGSize {
    let steps: [(Double, Double)] = [(0, 0), (6, 3), (3, 7), (-4, 5), (-7, 0), (-3, -6), (4, -5), (7, -2)]
    let i = Calendar.current.component(.minute, from: date) % steps.count
    return CGSize(width: steps[i].0, height: steps[i].1)
}

private struct SectionTitle: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(.secondary)
    }
}

struct DashboardView: View {
    @ObservedObject var model: DashboardModel
    var openSettings: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(red: 0.04, green: 0.05, blue: 0.07).ignoresSafeArea()
            TimelineView(.everyMinute) { context in
                page.offset(burnInShift(context.date))
            }
        }
    }

    @ViewBuilder private var page: some View {
        VStack(alignment: .leading, spacing: 24) {
            HeaderView(header: model.payload?.header, stand: model.payload?.stand,
                       error: model.error, lastOK: model.lastOK, openSettings: openSettings)
            if let payload = model.payload {
                HStack(alignment: .top, spacing: 36) {
                    VStack(alignment: .leading, spacing: 24) {
                        AlertsView(alerts: payload.alerts ?? [], more: payload.more ?? 0)
                        TileSection(title: "Energie jetzt", tiles: payload.flow ?? [], big: true,
                                    note: payload.note)
                        TileSection(title: "Heute", tiles: payload.today ?? [], big: false, note: nil)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    VStack(alignment: .leading, spacing: 24) {
                        RoomsView(rooms: payload.rooms ?? [])
                        EventsView(events: payload.events ?? [])
                    }
                    .frame(width: 620, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .top)
                }
                .frame(maxHeight: .infinity, alignment: .top)
            } else {
                Text(model.error ?? "Verbinde mit der Bridge …")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }
}

struct HeaderView: View {
    let header: TVHeader?
    let stand: String?
    let error: String?
    let lastOK: Date?
    let openSettings: () -> Void

    private var statusLine: String {
        if let e = error {
            if let t = lastOK {
                return "⚠︎ " + e + " · letzter Stand " + t.formatted(date: .omitted, time: .shortened)
            }
            return "⚠︎ " + e
        }
        if let s = stand { return "Stand " + s }
        return ""
    }

    var body: some View {
        HStack(alignment: .center, spacing: 30) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 0) {
                    Text(context.date.formatted(Date.FormatStyle(date: .omitted, time: .shortened)
                        .locale(Locale(identifier: "de_DE"))))
                        .font(.system(size: 84, weight: .heavy))
                        .monospacedDigit()
                    Text(context.date.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide)
                        .locale(Locale(identifier: "de_DE"))))
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if let outdoor = header?.outdoor, !outdoor.isEmpty {
                    Text("🌡️ außen " + outdoor)
                        .font(.system(size: 36, weight: .semibold))
                }
                HStack(spacing: 18) {
                    if let s = header?.status, !s.isEmpty { Text(s) }
                    if let h = header?.hp, !h.isEmpty { Text("♨️ " + h) }
                }
                .font(.system(size: 26))
                .foregroundStyle(.secondary)
                Text(statusLine)
                    .font(.system(size: 22))
                    .foregroundStyle(error == nil ? Color.secondary : Color.orange)
                    .lineLimit(1)
            }
            // the only control, so it always has the focus: plain style instead
            // of a big white platter; a click on the remote's centre opens it
            Button(action: openSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                    .padding(12)
            }
            .buttonStyle(.plain)
        }
    }
}

struct AlertsView: View {
    let alerts: [TVAlert]
    let more: Int
    /// two rows – more would push energy and today off the screen
    private let maxTiles = 4

    private var rows: [[TVAlert]] {
        let shown = Array(alerts.prefix(maxTiles))
        return stride(from: 0, to: shown.count, by: 2).map { Array(shown[$0..<min($0 + 2, shown.count)]) }
    }

    private var hiddenLine: String {
        let titles = alerts.dropFirst(maxTiles).map { $0.title }
        let count = titles.count + more
        if count <= 0 { return "" }
        if titles.isEmpty { return "+ \(count) weitere" }
        return "+ \(count) weitere: " + titles.joined(separator: " · ")
    }

    var body: some View {
        if alerts.isEmpty {
            Text("✓ Alles in Ordnung – nichts offen, nichts zu tun.")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.green)
        } else {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(0..<rows.count, id: \.self) { r in
                    HStack(alignment: .top, spacing: 18) {
                        ForEach(rows[r]) { alert in
                            AlertTile(alert: alert)
                        }
                        if rows[r].count == 1 {
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                if !hiddenLine.isEmpty {
                    Text(hiddenLine)
                        .font(.system(size: 22))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }
}

struct AlertTile: View {
    let alert: TVAlert
    @State private var dim = false

    var body: some View {
        let color = levelColor(alert.level)
        HStack(alignment: .center, spacing: 18) {
            Text(alert.icon)
                .font(.system(size: 44))
            VStack(alignment: .leading, spacing: 4) {
                Text(alert.title)
                    .font(.system(size: 27, weight: .bold))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if let d = alert.detail, !d.isEmpty {
                    Text(d)
                        .font(.system(size: 20))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(color.opacity(0.14)))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(color.opacity(0.55), lineWidth: 2))
        .opacity((alert.blink ?? false) && dim ? 0.55 : 1)
        .onAppear {
            // the bridge gives a tile a new id when it starts blinking, so this runs again
            guard alert.blink ?? false else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
    }
}

/// One row of equally tall tiles (energy now: up to 5, today: up to 7).
struct TileSection: View {
    let title: String
    let tiles: [TVTile]
    let big: Bool
    let note: String?

    var body: some View {
        if !tiles.isEmpty || !(note ?? "").isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: title)
                if let n = note, !n.isEmpty {
                    Text("⚠︎ " + n)
                        .font(.system(size: 22))
                        .foregroundStyle(.orange)
                }
                HStack(alignment: .top, spacing: big ? 16 : 14) {
                    ForEach(tiles) { tile in
                        TileView(tile: tile, big: big)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct TileView: View {
    let tile: TVTile
    let big: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(tileLabel(tile))
                .font(.system(size: big ? 22 : 18))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(tile.value)
                .font(.system(size: big ? 42 : 30, weight: .bold))
                .foregroundStyle(toneColor(tile.tone))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let sub = tile.sub, !sub.isEmpty {
                Text(sub)
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
        }
        .padding(big ? 18 : 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 22).fill(cardFill))
    }
}

struct RoomsView: View {
    let rooms: [TVRoom]
    private let maxRows = 10

    var body: some View {
        if !rooms.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle(text: "Räume")
                    .padding(.bottom, 4)
                ForEach(Array(rooms.prefix(maxRows))) { room in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(room.name)
                            .font(.system(size: 26, weight: .semibold))
                            .lineLimit(1)
                            .layoutPriority(2)
                        if let info = room.info, !info.isEmpty {
                            Text(info)
                                .font(.system(size: 18))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if let s = room.soll, !s.isEmpty {
                            Text(s)
                                .font(.system(size: 17))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .layoutPriority(1)
                        }
                        Text(room.temp)
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(toneColor(room.tone))
                            .monospacedDigit()
                            .lineLimit(1)
                            .layoutPriority(3)
                    }
                    .padding(.vertical, 3)
                }
                if rooms.count > maxRows {
                    Text("+ \(rooms.count - maxRows) weitere Räume")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 24).fill(cardFill))
        }
    }
}

/// As many of the next dates as fit below the rooms.
struct EventsView: View {
    let events: [TVEvent]

    var body: some View {
        if !events.isEmpty {
            ViewThatFits(in: .vertical) {
                EventsCard(events: events)
                EventsCard(events: Array(events.prefix(6)))
                EventsCard(events: Array(events.prefix(4)))
                EventsCard(events: Array(events.prefix(2)))
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

struct EventsCard: View {
    let events: [TVEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Termine")
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                if index == 0 || events[index - 1].day != event.day {
                    Text(event.day.uppercased())
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 6)
                }
                HStack(alignment: .firstTextBaseline, spacing: 14) {
                    Text(event.time)
                        .font(.system(size: 20))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .frame(width: 150, alignment: .leading)
                    Text(eventLine(event))
                        .font(.system(size: 24, weight: (event.now ?? false) ? .bold : .regular))
                        .lineLimit(1)
                }
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24).fill(cardFill))
    }
}
