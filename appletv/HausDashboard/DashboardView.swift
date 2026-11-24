import SwiftUI

// Layout for a TV (1920 × 1080 points, of which about 1760 × 960 lie inside
// the safe area): clock and status on top; on the left what needs attention,
// the power flowing right now and today's totals; on the right the rooms and
// the next dates. Frosted-glass cards over a slowly drifting colour light that
// turns warm while the sun supplies the house. Every section is limited so the
// whole page fits without scrolling.

// MARK: - Colours and small helpers

private enum Palette {
    static let sun = Color(red: 1.0, green: 0.76, blue: 0.24)
    static let house = Color(red: 0.42, green: 0.70, blue: 1.0)
    static let green = Color(red: 0.33, green: 0.86, blue: 0.58)
    static let grid = Color(red: 1.0, green: 0.42, blue: 0.56)
    static let heatPump = Color(red: 1.0, green: 0.50, blue: 0.32)
    static let cold = Color(red: 0.40, green: 0.85, blue: 1.0)
    static let warn = Color(red: 1.0, green: 0.66, blue: 0.25)
}

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
    case "urgent": return Color(red: 1.0, green: 0.38, blue: 0.38)
    case "warn": return Palette.warn
    case "good": return Palette.green
    default: return Palette.house
    }
}

private func toneColor(_ tone: String?) -> Color {
    switch tone ?? "" {
    case "good": return Palette.green
    case "warn": return Palette.warn
    case "cold": return Palette.cold
    case "heat": return Color(red: 1.0, green: 0.62, blue: 0.3)
    case "muted": return .secondary
    default: return .primary
    }
}

/// Colour of a room's thermometer bar.
private func barColor(_ tone: String?) -> Color {
    switch tone ?? "" {
    case "cold": return Palette.cold
    case "warn": return Palette.warn
    case "heat": return Color(red: 1.0, green: 0.62, blue: 0.3)
    default: return Palette.green
    }
}

/// Moves the page by a few points every minute – a picture that stands still
/// for hours can burn into OLED TVs. The safe-area margin leaves room for it.
private func burnInShift(_ date: Date) -> CGSize {
    let steps: [(Double, Double)] = [(0, 0), (6, 3), (3, 7), (-4, 5), (-7, 0), (-3, -6), (4, -5), (7, -2)]
    let i = Calendar.current.component(.minute, from: date) % steps.count
    return CGSize(width: steps[i].0, height: steps[i].1)
}

extension View {
    /// Frosted glass – the coloured light behind the card shines through.
    func glassCard(_ radius: CGFloat = 26) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }
}

private struct SectionTitle: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 19, weight: .bold))
            .tracking(1.6)
            .foregroundStyle(.secondary)
    }
}

/// A share (0 … 1) as a small ring.
private struct Ring: View {
    let fraction: Double
    let color: Color

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: 5)
            Circle()
                .trim(from: 0, to: CGFloat(min(1, max(0, fraction))))
                .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}

// MARK: - Background

/// Slowly drifting colour light behind the glass: warmer while the sun covers
/// the house, cool blue otherwise. The motion also protects OLED screens.
struct AmbientBackground: View {
    let warmth: Double            // 0 … 1
    @State private var drift = false

    var body: some View {
        Color(red: 0.02, green: 0.03, blue: 0.06)
            .overlay(blob(Palette.sun, opacity: 0.06 + 0.30 * warmth, size: 1500)
                .offset(x: drift ? 600 : 380, y: drift ? -300 : -430))
            .overlay(blob(Color(red: 0.16, green: 0.42, blue: 1.0), opacity: 0.30 - 0.12 * warmth, size: 1400)
                .offset(x: drift ? -620 : -400, y: drift ? 380 : 230))
            .overlay(blob(Color(red: 0.58, green: 0.32, blue: 1.0), opacity: 0.16, size: 1200)
                .offset(x: drift ? -40 : 220, y: drift ? -40 : 120))
            .animation(.easeInOut(duration: 4), value: warmth)
            .onAppear {
                withAnimation(.easeInOut(duration: 50).repeatForever(autoreverses: true)) { drift = true }
            }
    }

    private func blob(_ color: Color, opacity: Double, size: CGFloat) -> some View {
        Circle()
            .fill(RadialGradient(colors: [color.opacity(opacity), color.opacity(0)],
                                 center: .center, startRadius: 0, endRadius: size / 2))
            .frame(width: size, height: size)
    }
}

// MARK: - Page

struct DashboardView: View {
    @ObservedObject var model: DashboardModel
    var openSettings: () -> Void

    /// 0 … 1: how much of the house the sun covers right now (warms the light).
    private var warmth: Double {
        guard let live = model.payload?.live, let pv = live.pv_w, pv > 50 else { return 0 }
        return min(1, pv / max(300, live.load_w ?? 300))
    }

    var body: some View {
        TimelineView(.everyMinute) { context in
            page.offset(burnInShift(context.date))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AmbientBackground(warmth: warmth).ignoresSafeArea())
    }

    @ViewBuilder private var page: some View {
        VStack(alignment: .leading, spacing: 24) {
            HeaderView(header: model.payload?.header, stand: model.payload?.stand,
                       error: model.error, lastOK: model.lastOK, openSettings: openSettings)
            if let payload = model.payload {
                HStack(alignment: .top, spacing: 36) {
                    VStack(alignment: .leading, spacing: 22) {
                        AlertsView(alerts: payload.alerts ?? [], more: payload.more ?? 0)
                        if let live = payload.live, !(payload.flow ?? []).isEmpty {
                            EnergyFlowCard(live: live, tiles: payload.flow ?? [], note: payload.note)
                        } else {
                            TileSection(title: "Energie jetzt", tiles: payload.flow ?? [], big: true,
                                        note: payload.note)
                        }
                        TileSection(title: "Heute", tiles: payload.today ?? [], big: false, note: nil)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    VStack(alignment: .leading, spacing: 22) {
                        RoomsView(rooms: payload.rooms ?? [])
                        EventsView(events: payload.events ?? [])
                    }
                    .frame(width: 620, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .top)
                }
                .frame(maxHeight: .infinity, alignment: .top)
                // numbers roll to their new value on every refresh
                .animation(.easeInOut(duration: 0.6), value: payload.ts ?? 0)
            } else {
                Text(model.error ?? "Verbinde mit der Bridge …")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Header

private struct Chip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 22, weight: .medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }
}

/// The gear is the only control on the page, so it always has the focus: a
/// quiet circle instead of tvOS' big white focus platter.
private struct GearButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        GearLabel(configuration: configuration)
    }
}

private struct GearLabel: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        configuration.label
            .padding(16)
            .background(Circle().fill(Color.white.opacity(isFocused ? 0.16 : 0.05)))
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(.easeOut(duration: 0.15), value: isFocused)
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
        HStack(alignment: .center, spacing: 28) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let time = context.date.formatted(Date.FormatStyle(date: .omitted, time: .shortened)
                    .locale(Locale(identifier: "de_DE")))
                VStack(alignment: .leading, spacing: 0) {
                    Text(time)
                        .font(.system(size: 92, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(.easeInOut(duration: 0.5), value: time)
                    Text(context.date.formatted(Date.FormatStyle().weekday(.wide).day().month(.wide)
                        .locale(Locale(identifier: "de_DE"))))
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 10) {
                if let outdoor = header?.outdoor, !outdoor.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "thermometer.medium")
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundStyle(Palette.house)
                        Text("außen " + outdoor)
                            .font(.system(size: 38, weight: .semibold, design: .rounded))
                            .contentTransition(.numericText())
                    }
                }
                HStack(spacing: 12) {
                    if let s = header?.status, !s.isEmpty { Chip(text: s) }
                    if let h = header?.hp, !h.isEmpty { Chip(text: "♨️ " + h) }
                }
                Text(statusLine)
                    .font(.system(size: 20))
                    .foregroundStyle(error == nil ? Color.secondary : Color.orange)
                    .lineLimit(1)
            }
            Button(action: openSettings) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 26))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(GearButtonStyle())
            .focusEffectDisabled()
        }
    }
}

// MARK: - Alerts

struct AlertsView: View {
    let alerts: [TVAlert]
    let more: Int
    /// one row – the flow picture below needs the room
    private let maxTiles = 2

    private var hiddenLine: String {
        let titles = alerts.dropFirst(maxTiles).map { $0.title }
        let count = titles.count + more
        if count <= 0 { return "" }
        if titles.isEmpty { return "+ \(count) weitere" }
        return "+ \(count) weitere: " + titles.joined(separator: " · ")
    }

    var body: some View {
        if alerts.isEmpty {
            HStack(spacing: 14) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Palette.green)
                Text("Alles in Ordnung – nichts offen, nichts zu tun.")
                    .font(.system(size: 27, weight: .semibold))
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(22)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 18) {
                    ForEach(Array(alerts.prefix(maxTiles))) { alert in
                        AlertTile(alert: alert)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                if !hiddenLine.isEmpty {
                    Text(hiddenLine)
                        .font(.system(size: 21))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }
}

struct AlertTile: View {
    let alert: TVAlert
    @State private var glow = false

    var body: some View {
        let color = levelColor(alert.level)
        HStack(alignment: .center, spacing: 16) {
            ZStack {
                Circle().fill(color.opacity(0.22))
                Text(alert.icon).font(.system(size: 32))
            }
            .frame(width: 62, height: 62)
            VStack(alignment: .leading, spacing: 4) {
                Text(alert.title)
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if let d = alert.detail, !d.isEmpty {
                    Text(d)
                        .font(.system(size: 19))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(color.opacity(0.14)))
        .glassCard(22)
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(color.opacity((alert.blink ?? false) && glow ? 0.9 : 0.45), lineWidth: 2))
        .shadow(color: color.opacity((alert.blink ?? false) && glow ? 0.6 : 0), radius: 20)
        .onAppear {
            // the bridge gives a tile a new id when it starts blinking, so this runs again
            guard alert.blink ?? false else { return }
            withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) { glow = true }
        }
    }
}

// MARK: - Energy now: the house as a hub

struct EnergyFlowCard: View {
    let live: TVLive
    let tiles: [TVTile]
    let note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Energie jetzt")
            if let n = note, !n.isEmpty {
                Text("⚠︎ " + n)
                    .font(.system(size: 20))
                    .foregroundStyle(.orange)
            }
            EnergyFlowView(live: live, tiles: tiles)
                .frame(height: 290)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

/// Sun, battery, grid and heat pump around the house; dots run along the
/// lines in the direction the power flows – faster and bigger with more power.
/// Texts come from the bridge (flow tiles), the numbers only drive the motion.
struct EnergyFlowView: View {
    let live: TVLive
    let tiles: [TVTile]

    private func tile(_ id: String) -> TVTile? { tiles.first { $0.id == id } }

    private func edges(house: CGPoint, sun: CGPoint, batt: CGPoint, grid: CGPoint, hp: CGPoint) -> [FlowEdge] {
        var out: [FlowEdge] = []
        if tile("pv") != nil {
            out.append(FlowEdge(from: sun, to: house, color: Palette.sun, watts: max(0, live.pv_w ?? 0)))
        }
        if tile("batt") != nil {
            let b = live.batt_w ?? 0
            out.append(b >= 0 ? FlowEdge(from: batt, to: house, color: Palette.green, watts: b)
                              : FlowEdge(from: house, to: batt, color: Palette.green, watts: -b))
        }
        if tile("grid") != nil {
            let g = live.grid_w ?? 0
            out.append(g >= 0 ? FlowEdge(from: grid, to: house, color: Palette.grid, watts: g)
                              : FlowEdge(from: house, to: grid, color: Palette.green, watts: -g))
        }
        if tile("hp") != nil {
            out.append(FlowEdge(from: house, to: hp, color: Palette.heatPump, watts: max(0, live.hp_w ?? 0)))
        }
        return out
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let house = CGPoint(x: w * 0.5, y: h * 0.40)
            let sun = CGPoint(x: w * 0.30, y: h * 0.20)
            let batt = CGPoint(x: w * 0.30, y: h * 0.78)
            let grid = CGPoint(x: w * 0.70, y: h * 0.20)
            let hp = CGPoint(x: w * 0.70, y: h * 0.78)
            ZStack {
                FlowLines(edges: edges(house: house, sun: sun, batt: batt, grid: grid, hp: hp))
                if let t = tile("pv") {
                    FlowNode(icon: "☀️", color: Palette.sun, active: (live.pv_w ?? 0) > 50, size: 82)
                        .position(sun)
                    FlowCaption(tile: t, alignment: .trailing)
                        .frame(width: 250, alignment: .trailing)
                        .position(x: sun.x - 66 - 125, y: sun.y)
                }
                if let t = tile("batt") {
                    FlowNode(icon: "🔋", color: Palette.green, active: abs(live.batt_w ?? 0) > 30, size: 82)
                        .position(batt)
                    FlowCaption(tile: t, alignment: .trailing)
                        .frame(width: 250, alignment: .trailing)
                        .position(x: batt.x - 66 - 125, y: batt.y)
                }
                if let t = tile("grid") {
                    FlowNode(icon: "🔌", color: (live.grid_w ?? 0) < -30 ? Palette.green : Palette.grid,
                             active: abs(live.grid_w ?? 0) > 30, size: 82)
                        .position(grid)
                    FlowCaption(tile: t, alignment: .leading)
                        .frame(width: 250, alignment: .leading)
                        .position(x: grid.x + 66 + 125, y: grid.y)
                }
                if let t = tile("hp") {
                    FlowNode(icon: "♨️", color: Palette.heatPump, active: (live.hp_w ?? 0) > 40, size: 82)
                        .position(hp)
                    FlowCaption(tile: t, alignment: .leading)
                        .frame(width: 250, alignment: .leading)
                        .position(x: hp.x + 66 + 125, y: hp.y)
                }
                FlowNode(icon: "🏠", color: Palette.house, active: (live.load_w ?? 0) > 50, size: 104)
                    .position(house)
                if let t = tile("home") {
                    FlowCaption(tile: t, alignment: .center)
                        .frame(width: 340)
                        .position(x: house.x, y: house.y + 52 + 50)
                }
            }
        }
    }
}

private struct FlowEdge {
    let from: CGPoint
    let to: CGPoint
    let color: Color
    let watts: Double               // ≤ 30 W: an idle, faint line
}

/// The lines and the moving dots, redrawn up to 30 times a second.
private struct FlowLines: View {
    let edges: [FlowEdge]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { timeline in
            Canvas { context, _ in
                let t = timeline.date.timeIntervalSinceReferenceDate
                for e in edges {
                    var line = Path()
                    line.move(to: e.from)
                    line.addLine(to: e.to)
                    let on = e.watts > 30
                    context.stroke(line, with: .color(e.color.opacity(on ? 0.35 : 0.10)), lineWidth: on ? 3 : 2)
                    if !on { continue }
                    let dx = e.to.x - e.from.x
                    let dy = e.to.y - e.from.y
                    let len = (dx * dx + dy * dy).squareRoot()
                    if len < 1 { continue }
                    let strength = min(1.0, e.watts / 4000.0)
                    let gap: CGFloat = 44
                    let speed = 50.0 + 110.0 * strength          // points per second
                    let r: CGFloat = 4 + 3 * CGFloat(strength)
                    var d = CGFloat((t * speed).truncatingRemainder(dividingBy: Double(gap)))
                    while d < len {
                        let f = d / len
                        let p = CGPoint(x: e.from.x + dx * f, y: e.from.y + dy * f)
                        context.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)),
                                     with: .color(e.color))
                        d += gap
                    }
                }
            }
        }
    }
}

private struct FlowNode: View {
    let icon: String
    let color: Color
    let active: Bool
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(.ultraThinMaterial)
            Circle().fill(color.opacity(active ? 0.22 : 0.06))
            Circle().strokeBorder(color.opacity(active ? 0.9 : 0.3), lineWidth: 3)
            Text(icon).font(.system(size: size * 0.42))
        }
        .frame(width: size, height: size)
        .shadow(color: color.opacity(active ? 0.55 : 0), radius: active ? 18 : 0)
    }
}

private struct FlowCaption: View {
    let tile: TVTile
    let alignment: HorizontalAlignment

    var body: some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(tile.label)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.secondary)
            Text(tile.value)
                .font(.system(size: 38, weight: .bold, design: .rounded))
                .foregroundStyle(toneColor(tile.tone))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText())
            if let sub = tile.sub, !sub.isEmpty {
                Text(sub)
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
    }
}

// MARK: - Tiles (today, or energy now without the flow picture)

/// One row of equally tall glass tiles (energy now: up to 5, today: up to 7).
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
            HStack(alignment: .center, spacing: 8) {
                Text(tile.value)
                    .font(.system(size: big ? 42 : 30, weight: .bold, design: .rounded))
                    .foregroundStyle(toneColor(tile.tone))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
                if let p = tile.pct {
                    Ring(fraction: p, color: Palette.green)
                        .frame(width: 24, height: 24)
                }
            }
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
        .glassCard(22)
    }
}

// MARK: - Rooms

struct RoomsView: View {
    let rooms: [TVRoom]
    private let maxRows = 9

    var body: some View {
        if !rooms.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle(text: "Räume")
                    .padding(.bottom, 4)
                ForEach(Array(rooms.prefix(maxRows))) { room in
                    RoomRow(room: room)
                }
                if rooms.count > maxRows {
                    Text("+ \(rooms.count - maxRows) weitere Räume")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }
}

private struct RoomRow: View {
    let room: TVRoom

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                Text(room.name)
                    .font(.system(size: 24, weight: .semibold))
                    .lineLimit(1)
                if let info = room.info, !info.isEmpty {
                    Text(info)
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            if let t = room.t {
                TempBar(t: t, ref: room.ref, color: barColor(room.tone))
                    .frame(width: 104, height: 8)
            }
            VStack(alignment: .trailing, spacing: 0) {
                Text(room.temp)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(toneColor(room.tone))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                if let s = room.soll, !s.isEmpty {
                    Text(s)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(minWidth: 92, alignment: .trailing)
        }
        .padding(.vertical, 2)
    }
}

/// 16 … 26 °C as a bar; the white tick is the wish (or a real setpoint).
private struct TempBar: View {
    let t: Double
    let ref: Double?
    let color: Color
    private let lo = 16.0
    private let hi = 26.0

    private func frac(_ v: Double) -> CGFloat {
        CGFloat((min(hi, max(lo, v)) - lo) / (hi - lo))
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let bh = geo.size.height
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(color.opacity(0.85))
                    .frame(width: max(bh, w * frac(t)))
                if let r = ref {
                    Capsule()
                        .fill(Color.white)
                        .frame(width: 3, height: bh + 8)
                        .offset(x: w * frac(r) - 1.5)
                }
            }
        }
    }
}

// MARK: - Dates

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
        VStack(alignment: .leading, spacing: 5) {
            SectionTitle(text: "Termine")
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                if index == 0 || events[index - 1].day != event.day {
                    Text(event.day.uppercased())
                        .font(.system(size: 16, weight: .bold))
                        .tracking(1.2)
                        .foregroundStyle(Palette.house)
                        .padding(.top, 6)
                }
                HStack(alignment: .firstTextBaseline, spacing: 14) {
                    Text(event.time)
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .frame(width: 140, alignment: .leading)
                    Text(eventLine(event))
                        .font(.system(size: 23, weight: (event.now ?? false) ? .bold : .regular))
                        .foregroundStyle((event.now ?? false) ? Palette.sun : Color.primary)
                        .lineLimit(1)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}
