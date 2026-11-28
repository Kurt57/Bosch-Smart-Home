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
    // Feier-Modus
    static let partyPink = Color(red: 1.0, green: 0.27, blue: 0.55)
    static let partyPurple = Color(red: 0.62, green: 0.33, blue: 1.0)
    static let partyGold = Color(red: 1.0, green: 0.80, blue: 0.25)
}

// MARK: - Colour schemes (Einstellungen → Farbschema)

/// How the app looks. "Aurora" is the original: drifting coloured light behind
/// frosted glass. The others are calmer – the light halved, or no drifting light
/// at all and matt cards that let nothing shimmer through – in other colours.
/// Chosen in the settings (⚙︎), kept on this Apple TV.
enum TVTheme: String, CaseIterable, Identifiable {
    case aurora, auroraSoft, night, graphite, forest, ember

    var id: String { rawValue }

    var name: String {
        switch self {
        case .aurora: return "Aurora"
        case .auroraSoft: return "Aurora sanft"
        case .night: return "Nacht"
        case .graphite: return "Graphit"
        case .forest: return "Wald"
        case .ember: return "Kamin"
        }
    }

    var note: String {
        switch self {
        case .aurora: return "Farblicht hinter Milchglas – wie bisher"
        case .auroraSoft: return "dasselbe Licht, halb so stark, Karten fast deckend"
        case .night: return "Anthrazit, ruhig, ohne Schimmer"
        case .graphite: return "kühles Blaugrau, matt"
        case .forest: return "tiefes Grün, matt"
        case .ember: return "warmes Braun wie Glut, matt"
        }
    }

    /// strength of the drifting colour light (0: none – a still background)
    var glow: Double {
        switch self {
        case .aurora: return 1
        case .auroraSoft: return 0.45
        default: return 0
        }
    }

    /// the screen from top to bottom
    var top: Color {
        switch self {
        case .aurora, .auroraSoft: return Color(red: 0.02, green: 0.03, blue: 0.06)
        case .night: return Color(red: 0.045, green: 0.047, blue: 0.055)
        case .graphite: return Color(red: 0.085, green: 0.11, blue: 0.145)
        case .forest: return Color(red: 0.035, green: 0.095, blue: 0.075)
        case .ember: return Color(red: 0.12, green: 0.07, blue: 0.045)
        }
    }

    var bottom: Color {
        switch self {
        case .aurora, .auroraSoft: return Color(red: 0.02, green: 0.03, blue: 0.06)
        case .night: return Color(red: 0.012, green: 0.012, blue: 0.016)
        case .graphite: return Color(red: 0.035, green: 0.045, blue: 0.062)
        case .forest: return Color(red: 0.012, green: 0.04, blue: 0.032)
        case .ember: return Color(red: 0.045, green: 0.025, blue: 0.018)
        }
    }

    /// matt card colour – nil: frosted glass, the light shines through
    var card: Color? {
        switch self {
        case .aurora: return nil
        case .auroraSoft: return Color(red: 0.07, green: 0.08, blue: 0.11).opacity(0.84)
        case .night: return Color(red: 0.095, green: 0.10, blue: 0.115)
        case .graphite: return Color(red: 0.125, green: 0.15, blue: 0.19)
        case .forest: return Color(red: 0.065, green: 0.135, blue: 0.11)
        case .ember: return Color(red: 0.165, green: 0.105, blue: 0.075)
        }
    }

    /// the thin line around the cards
    var stroke: Color {
        switch self {
        case .aurora: return Color.white.opacity(0.10)
        case .auroraSoft, .graphite: return Color.white.opacity(0.08)
        case .night: return Color.white.opacity(0.07)
        case .forest: return Color(red: 0.55, green: 0.95, blue: 0.75).opacity(0.10)
        case .ember: return Color(red: 1.0, green: 0.78, blue: 0.55).opacity(0.10)
        }
    }

    /// how much the halos shine – around the active circles of the energy flow,
    /// the birthday banner, the blurred radio cover (1 = Aurora)
    var halo: Double {
        switch self {
        case .aurora: return 1
        case .auroraSoft: return 0.55
        default: return 0.2
        }
    }

    /// the faint, still light in the top corner of the calm schemes
    var light: Color {
        switch self {
        case .aurora, .auroraSoft, .night: return Color(red: 0.42, green: 0.70, blue: 1.0)
        case .graphite: return Color(red: 0.55, green: 0.72, blue: 0.95)
        case .forest: return Color(red: 0.33, green: 0.86, blue: 0.58)
        case .ember: return Color(red: 1.0, green: 0.62, blue: 0.30)
        }
    }
}

private struct TVThemeKey: EnvironmentKey {
    static let defaultValue: TVTheme = .aurora
}

extension EnvironmentValues {
    /// the colour scheme chosen in the settings
    var tvTheme: TVTheme {
        get { self[TVThemeKey.self] }
        set { self[TVThemeKey.self] = newValue }
    }
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
    /// The cards: frosted glass in Aurora (the coloured light behind shines
    /// through), a matt colour in the calm schemes.
    func glassCard(_ radius: CGFloat = 26) -> some View {
        modifier(CardSurface(radius: radius))
    }
}

private struct CardSurface: ViewModifier {
    let radius: CGFloat
    @Environment(\.tvTheme) private var theme

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if let card = theme.card {
            content
                .background(card, in: shape)
                .overlay(shape.strokeBorder(theme.stroke, lineWidth: 1))
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.strokeBorder(theme.stroke, lineWidth: 1))
        }
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

/// Aurora: slowly drifting colour light behind the glass – warmer while the sun
/// covers the house, cool blue otherwise, pink, violet and gold on a party day
/// (the motion also protects OLED screens). The calm schemes: a still gradient
/// with a faint light in the top corners – a little warmer while the sun
/// supplies the house, festive on a party day.
struct AmbientBackground: View {
    let warmth: Double            // 0 … 1
    var party = false
    @Environment(\.tvTheme) private var theme
    @State private var drift = false

    var body: some View {
        if theme.glow > 0 {
            auroraLight(theme.glow)
        } else {
            stillLight
        }
    }

    private func auroraLight(_ strength: Double) -> some View {
        let first = party ? Palette.partyPink : Palette.sun
        let second = party ? Palette.partyPurple : Color(red: 0.16, green: 0.42, blue: 1.0)
        let third = party ? Palette.partyGold : Color(red: 0.58, green: 0.32, blue: 1.0)
        let warm = party ? 0.75 : warmth
        return theme.top
            .overlay(blob(first, opacity: (0.06 + 0.30 * warm) * strength, size: 1500)
                .offset(x: drift ? 600 : 380, y: drift ? -300 : -430))
            .overlay(blob(second, opacity: (0.30 - 0.12 * warm) * strength, size: 1400)
                .offset(x: drift ? -620 : -400, y: drift ? 380 : 230))
            .overlay(blob(third, opacity: (party ? 0.20 : 0.16) * strength, size: 1200)
                .offset(x: drift ? -40 : 220, y: drift ? -40 : 120))
            .animation(.easeInOut(duration: 4), value: warmth)
            .animation(.easeInOut(duration: 3), value: party)
            .onAppear {
                withAnimation(.easeInOut(duration: 50).repeatForever(autoreverses: true)) { drift = true }
            }
            // switched to a calm scheme and back: the light starts drifting again
            .onDisappear { drift = false }
    }

    // calm: no pink on a birthday (the banner says it) – a faint gold at most
    private var stillLight: some View {
        LinearGradient(colors: [theme.top, theme.bottom], startPoint: .top, endPoint: .bottom)
            .overlay(RadialGradient(colors: [theme.light.opacity(0.08), Color.clear],
                                    center: .topLeading, startRadius: 0, endRadius: 1300))
            .overlay(RadialGradient(colors: [(party ? Palette.partyGold : Palette.sun)
                                                .opacity(party ? 0.05 : 0.10 * warmth),
                                             Color.clear],
                                    center: .topTrailing, startRadius: 0, endRadius: 1100))
            .animation(.easeInOut(duration: 4), value: warmth)
            .animation(.easeInOut(duration: 3), value: party)
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
    @ObservedObject var radio: RadioPlayer
    var openSettings: () -> Void
    /// counts Play/Pause presses – on a party day each one fires confetti
    var confettiTick = 0
    /// clicks on the birthday banner – confetti again
    @State private var partyTaps = 0

    /// 0 … 1: how much of the house the sun covers right now (warms the light).
    private var warmth: Double {
        guard let live = model.payload?.live, let pv = live.pv_w, pv > 50 else { return 0 }
        return min(1, pv / max(300, live.load_w ?? 300))
    }

    /// the station the radio plays (its card sits in the header)
    private var playingStation: TVRadioStation? {
        guard let id = radio.playingID else { return nil }
        return model.payload?.radio?.first(where: { $0.id == id })
    }

    /// children who finished a routine right now (-1 until the first answer, so
    /// opening the app does not count as "just finished")
    private var finishedKids: Int {
        guard let payload = model.payload else { return -1 }
        var n = 0
        for routine in payload.routines ?? [] {
            for kid in routine.kids where kid.complete {
                n += 1
            }
        }
        return n
    }

    /// While the children's routine runs (its card lies below the first screen):
    /// a hint among the alerts – how far they are, and where to tick off.
    private func routineHint(_ payload: TVPayload) -> [TVAlert] {
        guard let routine = payload.routines?.first, routine.all_done != true else { return [] }
        let done = routine.kids.reduce(0) { $0 + $1.done }
        let total = routine.kids.reduce(0) { $0 + $1.total }
        let until = routine.to.map { "bis " + $0 + " Uhr · " } ?? ""
        return [TVAlert(id: "routine-hint", level: "info", icon: routine.emoji ?? "✅",
                        title: "\(routine.title): \(done) von \(total) erledigt",
                        detail: until + "zum Abhaken nach unten wischen", blink: nil)]
    }

    // The first screen is exactly as high as the TV – nothing gets pushed off the
    // top any more. Everything else (the children's routine while it runs, all
    // dates with the football matches, the news) lies below it: swipe down and
    // the page scrolls along with the remote's focus.
    var body: some View {
        GeometryReader { geo in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 36) {
                    TimelineView(.everyMinute) { context in
                        page.offset(burnInShift(context.date))
                    }
                    .frame(height: geo.size.height)
                    if let payload = model.payload {
                        MoreSections(payload: payload) { routine, kid, item in
                            Task { await model.toggleRoutine(routine: routine, kid: kid, item: item) }
                        }
                        .padding(.bottom, 40)
                    }
                }
            }
            .scrollClipDisabled()
        }
        .background(AmbientBackground(warmth: warmth, party: model.payload?.party != nil).ignoresSafeArea())
        .overlay(ConfettiLayer(partyID: model.payload?.party?.title, tick: confettiTick + partyTaps,
                               celebrate: finishedKids))
    }

    @ViewBuilder private var page: some View {
        VStack(alignment: .leading, spacing: 20) {
            HeaderView(header: model.payload?.header, stand: model.payload?.stand,
                       error: model.error, lastOK: model.lastOK, openSettings: openSettings,
                       party: model.payload?.party, partyTap: { partyTaps += 1 },
                       radio: radio, radioStation: playingStation)
            if let payload = model.payload {
                HStack(alignment: .top, spacing: 36) {
                    // energy always stays in view
                    VStack(alignment: .leading, spacing: 22) {
                        AlertsView(alerts: (payload.alerts ?? []) + routineHint(payload), more: payload.more ?? 0)
                        if let live = payload.live, !(payload.flow ?? []).isEmpty {
                            EnergyFlowCard(live: live, tiles: payload.flow ?? [], note: payload.note,
                                           consumers: payload.consumers ?? [])
                        } else {
                            TileSection(title: "Energie jetzt", tiles: payload.flow ?? [], big: true,
                                        note: payload.note)
                            if let consumers = payload.consumers, !consumers.isEmpty {
                                // without the flow picture there is room enough below the tiles
                                VStack(alignment: .leading, spacing: 10) {
                                    SectionTitle(text: "Weitere Verbraucher")
                                    ConsumerStrip(consumers: consumers, houseW: payload.live?.load_w)
                                }
                                .padding(.horizontal, 22)
                                .padding(.vertical, 14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .glassCard()
                            }
                        }
                        TileSection(title: "Heute", tiles: payload.today ?? [], big: false, note: nil)
                    }
                    .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
                    // the column under the gear: everything the remote can select lives here,
                    // so swiping down from the top right always lands on it
                    VStack(alignment: .leading, spacing: 22) {
                        if !(payload.radio ?? []).isEmpty || radio.playingID != nil {
                            // on a birthday the banner has the header: what plays sits here then
                            RadioBar(stations: payload.radio ?? [], radio: radio, showsTitle: payload.party != nil)
                        }
                        // the rooms always stay up here; the routine (a few hours a day) is below
                        RoomsView(rooms: payload.rooms ?? [])
                        EventsView(events: payload.events ?? [])
                    }
                    .frame(width: 620, alignment: .topLeading)
                    .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
                    .focusSection()
                }
                // min + max height: the columns take the room that is left and never
                // grow past it (that used to push the whole page up and off the TV)
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
                .clipped()
                // numbers roll to their new value on every refresh
                .animation(.easeInOut(duration: 0.6), value: payload.ts ?? 0)
                if let items = payload.ticker, !items.isEmpty {
                    TickerBand(items: items)
                }
            } else {
                Text(model.error ?? "Verbinde mit der Bridge …")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Below the first screen

/// Reached by swiping down: every card can take the remote's focus, so the
/// page scrolls along. First the children's routine while it runs (one swipe
/// down lands on its tasks), then all dates (with the football matches) and
/// the news.
private struct MoreSections: View {
    let payload: TVPayload
    let toggle: (String, String, String) -> Void          // routine, kid, item

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let routine = payload.routines?.first {
                RoutineCard(routine: routine) { kid, item in toggle(routine.id, kid, item) }
            }
            HStack(alignment: .top, spacing: 36) {
                if !(payload.events ?? []).isEmpty {
                    FocusCard {
                        EventsCard(events: Array((payload.events ?? []).prefix(12)))
                    }
                }
                if !(payload.news ?? []).isEmpty {
                    FocusCard {
                        NewsCard(news: payload.news ?? [])
                    }
                }
            }
            // new things come last – "Sonne & Wetter" with its gauges
            if let weather = payload.weather, !weather.days.isEmpty {
                FocusCard {
                    WeatherCard(weather: weather)
                }
            }
        }
    }
}

/// Sun and weather today and the next two days: the sky, the sunshine as a
/// gauge (share of the daylight), the yield the PV system should make of it as
/// a bar – and a tip when to run the washing machine & co.
private struct WeatherCard: View {
    let weather: TVWeather

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(text: "Sonne & Wetter")
            HStack(alignment: .top, spacing: 18) {
                ForEach(weather.days) { day in
                    WeatherDayView(day: day)
                }
            }
            if let tip = weather.tip, !tip.isEmpty {
                Text(tip)
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(Palette.sun)
                    .lineLimit(2)
            } else if let note = weather.note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 19))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

private struct WeatherDayView: View {
    let day: TVWeatherDay

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(day.label.uppercased())
                .font(.system(size: 16, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(Palette.house)
            HStack(spacing: 14) {
                Text(day.icon)
                    .font(.system(size: 52))
                VStack(alignment: .leading, spacing: 2) {
                    Text(day.text)
                        .font(.system(size: 22, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let temp = day.temp, !temp.isEmpty {
                        Text(temp)
                            .font(.system(size: 20))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            HStack(alignment: .center, spacing: 16) {
                if let share = day.share {
                    ArcGauge(fraction: share, color: Palette.sun, label: "\(Int((share * 100).rounded())) %")
                        .frame(width: 74, height: 74)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let sun = day.sun, !sun.isEmpty {
                        Text(sun)
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                    }
                    if let pv = day.pv, !pv.isEmpty {
                        Text("Ertrag " + pv)
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        if let f = day.pv_frac {
                            GaugeBar(fraction: f, color: Palette.sun)
                                .frame(width: 160, height: 7)
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// A small speedometer: a 270° arc filled to `fraction`, the value inside. It
/// sweeps up from zero when it appears and rolls to every new value.
private struct ArcGauge: View {
    let fraction: Double
    let color: Color
    let label: String
    @State private var shown: Double = 0

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0, to: 0.75)
                .stroke(Color.white.opacity(0.10), style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(135))
            Circle()
                .trim(from: 0, to: 0.75 * CGFloat(min(1, max(0, shown))))
                .stroke(color, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(135))
            Text(label)
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .monospacedDigit()
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.4)) { shown = fraction }
        }
        .onChange(of: fraction) { _, value in
            withAnimation(.easeInOut(duration: 1.0)) { shown = value }
        }
    }
}

/// A thin bar filled to `fraction` – grows from zero when it appears.
private struct GaugeBar: View {
    let fraction: Double
    let color: Color
    @State private var shown: Double = 0

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(color)
                    .frame(width: max(geo.size.height, geo.size.width * CGFloat(min(1, max(0, shown)))))
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.2)) { shown = fraction }
        }
        .onChange(of: fraction) { _, value in
            withAnimation(.easeInOut(duration: 1.0)) { shown = value }
        }
    }
}

/// A card the remote can land on – that is how a tvOS page scrolls (the focus
/// moves, the scroll view follows). Nothing to click; it just lights up.
private struct FocusCard<Content: View>: View {
    @FocusState private var focused: Bool
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(focused ? 0.6 : 0), lineWidth: 3))
            .scaleEffect(focused ? 1.015 : 1)
            .shadow(color: Color.black.opacity(focused ? 0.35 : 0), radius: 18, y: 8)
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .animation(.easeOut(duration: 0.2), value: focused)
    }
}

/// The newest headlines of the feeds chosen in Setup.
private struct NewsCard: View {
    let news: [TVNews]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "Nachrichten")
            ForEach(Array(news.prefix(10))) { item in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 10) {
                        Text(item.source.uppercased())
                            .font(.system(size: 15, weight: .bold))
                            .tracking(1.1)
                            .foregroundStyle(Palette.house)
                        if let ago = item.ago, !ago.isEmpty {
                            Text(ago)
                                .font(.system(size: 15))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(item.title)
                        .font(.system(size: 22, weight: .medium))
                        .lineLimit(2)
                }
                .padding(.vertical, 2)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

/// The running band at the foot of the first screen: football results and the
/// next matches, then the headlines – right to left, like a news channel's crawl
/// (the motion also keeps OLED screens from burning in).
private struct TickerBand: View {
    let items: [TVTickerItem]
    @State private var rowWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let speed = 60.0          // points per second
    private let gap: CGFloat = 90

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
                let cycle = Double(rowWidth + gap)
                let travelled = context.date.timeIntervalSinceReferenceDate * speed
                let x: CGFloat = (reduceMotion || rowWidth <= 0) ? 0
                    : -CGFloat(travelled.truncatingRemainder(dividingBy: cycle))
                HStack(spacing: gap) {
                    row
                    row
                }
                .offset(x: x)
                .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
            }
        }
        .frame(height: 52)
        .clipped()
        .glassCard(26)
        .onPreferenceChange(TickerWidthKey.self) { width in
            rowWidth = width
        }
    }

    private var row: some View {
        HStack(spacing: 44) {
            ForEach(items) { item in
                HStack(spacing: 10) {
                    Text(item.icon ?? "•")
                        .font(.system(size: 22))
                    if let source = item.source, !source.isEmpty {
                        Text(source.uppercased())
                            .font(.system(size: 16, weight: .bold))
                            .tracking(1.1)
                            .foregroundStyle(Palette.house)
                    }
                    Text(item.text)
                        .font(.system(size: 22, weight: .medium))
                }
                .fixedSize()
            }
        }
        .padding(.horizontal, 24)
        .fixedSize()
        .background(GeometryReader { g in
            Color.clear.preference(key: TickerWidthKey.self, value: g.size.width)
        })
    }
}

private struct TickerWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
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
            .glassCard(24)              // a capsule in the colour scheme's card style
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
    let party: TVParty?
    /// click on the birthday banner
    var partyTap: () -> Void = {}
    /// the radio, and the station it plays – its card sits in the middle
    var radio: RadioPlayer? = nil
    var radioStation: TVRadioStation? = nil

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
            .layoutPriority(1)
            if let party {
                Spacer(minLength: 12)
                // a button: select it with the remote and click – confetti again
                Button(action: partyTap) {
                    PartyBanner(party: party)
                }
                .buttonStyle(PartyBannerStyle())
                .focusEffectDisabled()
                Spacer(minLength: 12)
            } else if let radio, let radioStation {
                Spacer(minLength: 12)
                NowPlayingCard(station: radioStation, radio: radio)
                Spacer(minLength: 12)
            } else {
                Spacer()
            }
            VStack(alignment: .trailing, spacing: 10) {
                if let outdoor = header?.outdoor, !outdoor.isEmpty {
                    HStack(spacing: 10) {
                        // today's sky (from the forecast) – or the thermometer while none is known
                        if let sky = header?.sky, !sky.isEmpty {
                            Text(sky)
                                .font(.system(size: 34))
                        } else {
                            Image(systemName: "thermometer.medium")
                                .font(.system(size: 30, weight: .semibold))
                                .foregroundStyle(Palette.house)
                        }
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
            .layoutPriority(1)
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
    /// the other big consumers right now – a row below the picture
    var consumers: [TVConsumer] = []

    var body: some View {
        let strip = !consumers.isEmpty
        VStack(alignment: .leading, spacing: strip ? 6 : 8) {
            SectionTitle(text: "Energie jetzt")
            if let n = note, !n.isEmpty {
                Text("⚠︎ " + n)
                    .font(.system(size: 20))
                    .foregroundStyle(.orange)
            }
            // With the row below, the picture gives up to 44 points (and the card
            // 14 of its padding) when the column is tight, so the page still fits:
            // the row costs about as much as that. 246 is as low as it goes – below
            // that the house's caption would reach out of the picture.
            EnergyFlowView(live: live, tiles: tiles)
                .frame(minHeight: strip ? 246 : 290, maxHeight: 290)
            if strip {
                ConsumerStrip(consumers: consumers, houseW: live.load_w)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, strip ? 12 : 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

/// The other big consumers right now, next to the heat pump: the Smart Home's
/// measured devices from 100 W, the rest of the house nothing measures on its
/// own (house − heat pump − devices, with the smart meter) and, beyond four,
/// the smallest pooled – texts from the bridge. The ring around an icon is the
/// share of what the house draws right now.
struct ConsumerStrip: View {
    let consumers: [TVConsumer]
    let houseW: Double?

    private func share(_ c: TVConsumer) -> Double? {
        guard let house = houseW, house > 50, let w = c.w, w > 0 else { return nil }
        return min(1, w / house)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            ForEach(Array(consumers.prefix(4))) { c in
                ConsumerChip(consumer: c, share: share(c))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct ConsumerChip: View {
    let consumer: TVConsumer
    let share: Double?
    @Environment(\.tvTheme) private var theme

    /// from 1 kW a consumer is a big one right now: orange, with a halo
    private var big: Bool { (consumer.w ?? 0) >= 1000 }

    private var color: Color {
        if big { return Palette.warn }
        switch consumer.kind ?? "" {
        case "rest", "more": return Color(white: 0.80)
        default: return Palette.house
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle().fill(color.opacity(big ? 0.22 : 0.12))
                if let s = share {
                    Ring(fraction: s, color: color)
                } else {
                    Circle().strokeBorder(color.opacity(0.45), lineWidth: 3)
                }
                Text(consumer.icon).font(.system(size: 21))
            }
            .frame(width: 46, height: 46)
            .shadow(color: color.opacity(big ? 0.5 * theme.halo : 0), radius: big ? 12 : 0)
            VStack(alignment: .leading, spacing: 0) {
                Text(consumer.name)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(consumer.value)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(big ? Palette.warn : .primary)
                        .lineLimit(1)
                        .fixedSize()
                        .contentTransition(.numericText())
                    if let sub = consumer.sub, !sub.isEmpty {
                        Text(sub)
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                }
            }
        }
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
                    if let soc = live.soc {
                        // the charge as a gauge around the battery
                        SocRing(soc: soc, charging: (live.batt_w ?? 0) < -30)
                            .frame(width: 102, height: 102)
                            .position(batt)
                    }
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

/// The battery's charge as a ring around its node: green from half full, orange
/// below, red under a fifth. It rolls to a new value; while the battery charges a
/// bright spark runs along the filled part.
private struct SocRing: View {
    let soc: Double                 // 0 … 100 %
    let charging: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var fraction: CGFloat {
        CGFloat(min(100, max(0, soc)) / 100)
    }

    private var color: Color {
        soc >= 50 ? Palette.green : soc >= 20 ? Palette.warn : Color(red: 1.0, green: 0.38, blue: 0.38)
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.10), lineWidth: 6)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 1.2), value: fraction)
            if charging && !reduceMotion && fraction > 0.03 {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    let head = CGFloat((t / 2.4).truncatingRemainder(dividingBy: 1)) * fraction
                    Circle()
                        .trim(from: max(0, head - 0.05), to: head)
                        .stroke(Color.white.opacity(0.85), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
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
    @Environment(\.tvTheme) private var theme

    var body: some View {
        ZStack {
            if theme.card == nil {
                Circle().fill(.ultraThinMaterial)          // glass, as the cards
            } else {
                Circle().fill(Color.white.opacity(0.04))     // matt, as the cards
            }
            Circle().fill(color.opacity(active ? 0.22 : 0.06))
            Circle().strokeBorder(color.opacity(active ? 0.9 : 0.3), lineWidth: 3)
            Text(icon).font(.system(size: size * 0.42))
        }
        .frame(width: size, height: size)
        // the halo of an active circle – strong in Aurora, faint in the calm schemes
        .shadow(color: color.opacity(active ? 0.55 * theme.halo : 0), radius: active ? 18 : 0)
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
            if let b = tile.bar {
                // the sun made so far against what the forecast promised for today
                GaugeBar(fraction: b, color: Palette.sun)
                    .frame(height: 6)
                    .padding(.vertical, 2)
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
                // too little room left: nothing rather than a cut-off card (all dates are below)
                Color.clear.frame(height: 0)
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

// MARK: - Radio

/// What the radio plays, in the middle of the header: the cover (or the
/// station's logo), title and artist, small dancing bars – and the cover,
/// blurred, as a coloured light behind the glass.
struct NowPlayingCard: View {
    let station: TVRadioStation
    @ObservedObject var radio: RadioPlayer
    /// the small one under the station buttons (on a birthday the banner has the header)
    var compact = false

    private var parts: (artist: String?, title: String) {
        RadioPlayer.split(radio.nowPlaying ?? "")
    }

    private var art: URL? {
        radio.cover ?? station.logo.flatMap { URL(string: $0) }
    }

    var body: some View {
        let side: CGFloat = compact ? 76 : 104
        HStack(spacing: compact ? 14 : 18) {
            CoverView(url: art, isLogo: radio.cover == nil)
                .frame(width: side, height: side)
            VStack(alignment: .leading, spacing: compact ? 2 : 4) {
                HStack(spacing: 8) {
                    EqualizerBars()
                        .frame(width: 22, height: 16)
                    Text("LÄUFT GERADE · " + station.name.uppercased())
                        .font(.system(size: compact ? 13 : 15, weight: .bold))
                        .tracking(1.2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(parts.artist == nil ? (radio.nowPlaying ?? station.name) : parts.title)
                    .font(.system(size: compact ? 23 : 28, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                if let artist = parts.artist {
                    Text(artist)
                        .font(.system(size: compact ? 18 : 22, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
            .frame(maxWidth: compact ? CGFloat.infinity : 520, alignment: .leading)
        }
        .padding(.leading, compact ? 8 : 12)
        .padding(.trailing, compact ? 16 : 26)
        .padding(.vertical, compact ? 8 : 12)
        .background(CoverGlow(url: radio.cover))
        .glassCard(compact ? 22 : 28)
        .animation(.easeInOut(duration: 0.6), value: radio.cover)
        .animation(.easeInOut(duration: 0.4), value: radio.nowPlaying)
    }
}

/// The cover, big and blurred, as light behind the card.
private struct CoverGlow: View {
    let url: URL?
    @Environment(\.tvTheme) private var theme

    var body: some View {
        ZStack {
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Color.clear
                    }
                }
                .blur(radius: 36)
                .opacity(0.6 * max(0.35, theme.halo))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}

/// The cover – or, while none is known, the station's logo on white.
private struct CoverView: View {
    let url: URL?
    let isLogo: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(isLogo && url != nil ? Color.white.opacity(0.92) : Color.white.opacity(0.08))
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        if isLogo {
                            image.resizable().scaledToFit().padding(12)
                        } else {
                            image.resizable().scaledToFill()
                        }
                    } else {
                        Image(systemName: "radio")
                            .font(.system(size: 40))
                            .foregroundStyle(Color.gray)
                    }
                }
                .id(url)
            } else {
                Image(systemName: "radio")
                    .font(.system(size: 40))
                    .foregroundStyle(Color.secondary)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: Color.black.opacity(0.4), radius: 12, y: 6)
    }
}

/// Four little bars dancing while the radio plays (still with "Bewegung reduzieren").
private struct EqualizerBars: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(0..<4, id: \.self) { i in
                    Capsule()
                        .fill(Palette.green)
                        .frame(width: 4, height: 16 * barHeight(i, t))
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    private func barHeight(_ i: Int, _ t: Double) -> Double {
        if reduceMotion { return [0.5, 0.8, 0.6, 0.9][i % 4] }
        return 0.3 + 0.7 * abs(sin(t * (2.1 + Double(i) * 0.8) + Double(i) * 1.7))
    }
}

/// The stations from the app's Setup as buttons: click plays, click again stops.
/// What plays stands in the header; here – small, with the cover – only when the
/// header is taken (birthday banner).
struct RadioBar: View {
    let stations: [TVRadioStation]
    @ObservedObject var radio: RadioPlayer
    var showsTitle = true

    private var line: String? {
        radio.problem.map { "⚠︎ " + $0 }
    }

    private var playing: TVRadioStation? {
        guard showsTitle, let id = radio.playingID else { return nil }
        return stations.first(where: { $0.id == id })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // one row – it scrolls sideways when there are more stations than fit
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(stations) { station in
                        Button {
                            radio.toggle(station)
                        } label: {
                            Label(station.name, systemImage: radio.playingID == station.id ? "stop.fill" : "play.fill")
                                .font(.system(size: 21, weight: .semibold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .buttonStyle(RadioChipStyle(active: radio.playingID == station.id))
                        .focusEffectDisabled()
                    }
                    // a station deleted in Setup while it plays can still be stopped
                    if let id = radio.playingID, !stations.contains(where: { $0.id == id }) {
                        Button {
                            radio.stop()
                        } label: {
                            Label("Stopp", systemImage: "stop.fill")
                                .font(.system(size: 21, weight: .semibold))
                        }
                        .buttonStyle(RadioChipStyle(active: true))
                        .focusEffectDisabled()
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
            }
            .scrollClipDisabled()
            if let line {
                Text(line)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(Color.orange)
                    .lineLimit(1)
            } else if let playing {
                NowPlayingCard(station: playing, radio: radio, compact: true)
            }
        }
    }
}

private struct RadioChipStyle: ButtonStyle {
    let active: Bool

    func makeBody(configuration: Configuration) -> some View {
        RadioChipBody(configuration: configuration, active: active)
    }
}

private struct RadioChipBody: View {
    let configuration: ButtonStyleConfiguration
    let active: Bool
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        configuration.label
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(Capsule().fill(active ? Palette.green.opacity(isFocused ? 0.6 : 0.38)
                                              : Color.white.opacity(isFocused ? 0.24 : 0.07)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.95 : (isFocused ? 1.05 : 1))
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

// MARK: - Kinder-Routine

/// The children's checklist (e.g. the evening routine) – the first card below the
/// first screen while it runs: the children side by side, their tasks two by two,
/// every task a button – swipe down, select it with the remote, click to tick it off.
struct RoutineCard: View {
    let routine: TVRoutine
    let toggle: (String, String) -> Void          // kid, item

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text((routine.emoji ?? "✅") + " " + routine.title)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(routine.all_done == true ? "Alle fertig – gute Nacht! 🌙"
                     : (routine.to.map { "bis " + $0 + " Uhr" } ?? ""))
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(routine.all_done == true ? Palette.green : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            // the children side by side – below the first screen there is the whole width
            HStack(alignment: .top, spacing: 16) {
                ForEach(routine.kids) { kid in
                    KidBlock(kid: kid) { item in toggle(kid.id, item) }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .focusSection()
    }
}

private struct KidBlock: View {
    let kid: TVRoutineKid
    let toggle: (String) -> Void
    private let maxItems = 8
    private let columns = [GridItem(.flexible(), spacing: 10, alignment: .topLeading),
                           GridItem(.flexible(), spacing: 10, alignment: .topLeading)]

    private var line: String {
        let stars = String(repeating: "⭐", count: min(7, kid.stars ?? 0))
        let base = kid.complete ? "Alles erledigt – super! 🎉" : "\(kid.done) von \(kid.total) erledigt"
        return stars.isEmpty ? base : base + " · " + stars
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(kid.emoji ?? "🙂")
                    .font(.system(size: 38))
                VStack(alignment: .leading, spacing: 0) {
                    Text(kid.name)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text(line)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(kid.complete ? Palette.green : Color.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
                Ring(fraction: Double(kid.done) / Double(max(1, kid.total)), color: Palette.green)
                    .frame(width: 34, height: 34)
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                ForEach(Array(kid.items.prefix(maxItems))) { item in
                    Button {
                        toggle(item.id)
                    } label: {
                        RoutineItemLabel(item: item)
                    }
                    .buttonStyle(RoutineItemStyle())
                    .focusEffectDisabled()
                }
            }
            if kid.items.count > maxItems {
                Text("+ \(kid.items.count - maxItems) weitere im Wohn-Dashboard")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(kid.complete ? Palette.green.opacity(0.8) : Color.clear, lineWidth: 2))
    }
}

private struct RoutineItemLabel: View {
    let item: TVRoutineItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(item.done ? Palette.green : Color.secondary)
            if let e = item.emoji, !e.isEmpty {
                Text(e).font(.system(size: 24))
            }
            // one line per task – the card stays compact
            Text(item.text)
                .font(.system(size: 22, weight: .semibold))
                .strikethrough(item.done)
                .foregroundStyle(item.done ? Color.secondary : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
            Spacer(minLength: 0)
        }
    }
}

/// A task row: a quiet background that lights up and grows a little while the
/// remote points at it (instead of tvOS' big white focus platter).
private struct RoutineItemStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RoutineItemBody(configuration: configuration)
    }
}

private struct RoutineItemBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        configuration.label
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(isFocused ? 0.26 : 0.06)))
            .scaleEffect(configuration.isPressed ? 0.97 : (isFocused ? 1.05 : 1))
            .shadow(color: Color.black.opacity(isFocused ? 0.35 : 0), radius: 12, y: 6)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

// MARK: - Feier-Modus

/// The greeting in party colours. Emoji keep their own colours – inside the
/// gradient they would turn into flat silhouettes.
private func partyTitle(_ s: String) -> Text {
    let gradient = LinearGradient(colors: [Color(red: 1.0, green: 0.48, blue: 0.62), Palette.partyGold,
                                           Color(red: 0.84, green: 0.55, blue: 1.0)],
                                  startPoint: .leading, endPoint: .trailing)
    func isEmoji(_ c: Character) -> Bool {
        guard let first = c.unicodeScalars.first else { return false }
        return first.properties.isEmojiPresentation || (c.unicodeScalars.count > 1 && first.properties.isEmoji)
    }
    func piece(_ text: String, emoji: Bool) -> Text {
        emoji ? Text(verbatim: text).foregroundStyle(Color.white) : Text(verbatim: text).foregroundStyle(gradient)
    }
    var result = Text(verbatim: "")
    var run = ""
    var runIsEmoji = false
    for c in s {
        let e = isEmoji(c)
        if !run.isEmpty && e != runIsEmoji {
            result = result + piece(run, emoji: runIsEmoji)
            run = ""
        }
        run.append(c)
        runIsEmoji = e
    }
    if !run.isEmpty {
        result = result + piece(run, emoji: runIsEmoji)
    }
    return result
}

/// The banner as a button: grows a little and lights up while the remote points at it.
private struct PartyBannerStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PartyBannerBody(configuration: configuration)
    }
}

private struct PartyBannerBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        configuration.label
            .brightness(isFocused ? 0.08 : 0)
            .scaleEffect(configuration.isPressed ? 0.96 : (isFocused ? 1.06 : 1))
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

/// Birthday (or anniversary) greeting in the middle of the header.
struct PartyBanner: View {
    let party: TVParty
    @State private var wiggle = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.tvTheme) private var theme

    var body: some View {
        HStack(spacing: 18) {
            Text(party.emoji ?? "🎉")
                .font(.system(size: 58))
                .rotationEffect(.degrees(wiggle ? 9 : -9), anchor: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                partyTitle(party.title)
                    .font(.system(size: 42, weight: .heavy, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let sub = party.sub, !sub.isEmpty {
                    Text(sub + " 🎉")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.leading, 22)
        .padding(.trailing, 32)
        .padding(.vertical, 12)
        .background(LinearGradient(colors: [Palette.partyPink.opacity(0.30), Palette.partyPurple.opacity(0.26),
                                            Palette.partyGold.opacity(0.22)],
                                   startPoint: .leading, endPoint: .trailing),
                    in: Capsule())
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(LinearGradient(colors: [Palette.partyPink.opacity(0.8), Palette.partyGold.opacity(0.8),
                                                                Palette.partyPurple.opacity(0.8)],
                                                       startPoint: .leading, endPoint: .trailing),
                                        lineWidth: 2))
        .shadow(color: Palette.partyPink.opacity(0.35 * theme.halo), radius: 26)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) { wiggle = true }
        }
    }
}

/// One volley of confetti: when it started, its random seed, and whether it
/// rains from above (the shower every ten minutes) or shoots from the corners.
struct ConfettiShot: Equatable {
    let start: Date
    let seed: Double
    let rain: Bool
}

/// Confetti over the whole page on a party day: cannons from the lower corners
/// when the party starts (or the app opens) and on Play/Pause, a shower from
/// above every ten minutes. Drawn only while pieces fly; nothing with
/// "Bewegung reduzieren" switched on.
struct ConfettiLayer: View {
    let partyID: String?
    let tick: Int
    /// children who finished their routine (-1: nothing loaded yet) – one more → cannons
    var celebrate = -1
    @State private var shot: ConfettiShot? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let shot {
                TimelineView(.animation) { context in
                    Canvas { ctx, size in
                        ConfettiPainter.draw(in: &ctx, size: size, shot: shot,
                                             t: context.date.timeIntervalSince(shot.start))
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
        .task(id: partyID) {
            guard partyID != nil, !reduceMotion else {
                shot = nil
                return
            }
            try? await Task.sleep(for: .seconds(1))
            var rain = false
            while !Task.isCancelled {
                fire(rain: rain)
                rain = true
                try? await Task.sleep(for: .seconds(600))
            }
        }
        .onChange(of: tick) { _, _ in
            if partyID != nil && !reduceMotion { fire(rain: false) }
        }
        .onChange(of: celebrate) { old, new in
            if old >= 0 && new > old && !reduceMotion { fire(rain: false) }
        }
    }

    private func fire(rain: Bool) {
        let next = ConfettiShot(start: Date(), seed: Double.random(in: 0..<1000), rain: rain)
        shot = next
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(ConfettiPainter.duration))
            if shot == next { shot = nil }
        }
    }
}

/// Draws one volley at time t. Every piece is a closed-form throw with linear
/// air drag – it shoots up fast, then flutters down slowly, turning and
/// flipping – so a frame needs no stored state and never drifts.
enum ConfettiPainter {
    static let duration: Double = 8
    static let count = 170
    static let colors: [Color] = [
        Color(red: 1.0, green: 0.22, blue: 0.37), Color(red: 1.0, green: 0.62, blue: 0.04),
        Color(red: 1.0, green: 0.84, blue: 0.04), Color(red: 0.19, green: 0.82, blue: 0.35),
        Color(red: 0.39, green: 0.82, blue: 1.0), Color(red: 0.04, green: 0.52, blue: 1.0),
        Color(red: 0.75, green: 0.35, blue: 0.95), Color(red: 1.0, green: 0.43, blue: 0.78), .white
    ]

    /// Stable pseudo-random number 0 ..< 1 for piece i, property k.
    static func rnd(_ i: Int, _ k: Int, _ seed: Double) -> Double {
        let x = sin(Double(i) * 12.9898 + Double(k) * 78.233 + seed) * 43758.5453
        return x - x.rounded(.down)
    }

    static func draw(in ctx: inout GraphicsContext, size: CGSize, shot: ConfettiShot, t: Double) {
        let width = Double(size.width)
        let height = Double(size.height)
        let gravity = height * 1.15
        let scale = max(0.85, min(1.7, min(width, height) / 650))
        for i in 0..<count {
            let r: (Int) -> Double = { Self.rnd(i, $0, shot.seed) }
            let tt = t - (shot.rain ? r(0) * 2.2 : r(0) * 0.25)
            if tt <= 0 { continue }
            var x0 = 0.0, y0 = 0.0, angle = 0.0, speed = 0.0
            if shot.rain {
                x0 = r(1) * width
                y0 = -10 - r(2) * height * 0.3
                angle = (90 + (r(3) - 0.5) * 40) * .pi / 180
                speed = height * 0.1 * (0.55 + r(4) * 0.6)
            } else {
                let left = i % 2 == 0
                x0 = left ? -8 : width + 8
                y0 = height * 0.95
                angle = ((left ? -61.0 : -119.0) + (r(3) - 0.5) * 28) * .pi / 180
                speed = height * 3.7 * (0.55 + r(4) * 0.6)
            }
            let drag = 3 + r(5) * 1.4
            let terminal = gravity / drag
            let decay = exp(-drag * tt)
            let sway = sin(r(6) * 6.28 + tt * 2.6) * (14 + r(7) * 26) * scale * min(1, tt / 1.2)
            let x = x0 + cos(angle) * speed / drag * (1 - decay) + sway
            let y = y0 + terminal * tt + (sin(angle) * speed - terminal) / drag * (1 - decay)
            if y > height + 40 || tt >= duration { continue }
            let life = tt > duration - 1 ? duration - tt : 1
            let flip = cos(r(10) * 6.28 + (5 + r(11) * 9) * tt)
            let w = (6 + r(12) * 6) * scale
            let h = (9 + r(13) * 9) * scale
            let color = colors[Int(r(14) * Double(colors.count)) % colors.count]
            var c = ctx
            c.translateBy(x: x, y: y)
            c.rotate(by: .radians(r(8) * 6.28 + (r(9) - 0.5) * 11 * tt))
            c.scaleBy(x: 1, y: max(0.12, abs(flip)))
            c.opacity = life * (0.72 + 0.28 * abs(flip))
            let shape = r(15)
            if shape < 0.2 {            // streamer
                c.fill(Path(CGRect(x: -w * 0.17, y: -h * 0.9, width: w * 0.34, height: h * 1.8)), with: .color(color))
            } else if shape < 0.42 {    // dot
                c.fill(Path(ellipseIn: CGRect(x: -w * 0.42, y: -w * 0.42, width: w * 0.84, height: w * 0.84)),
                       with: .color(color))
            } else {                    // paper square
                c.fill(Path(CGRect(x: -w / 2, y: -h * 0.31, width: w, height: h * 0.62)), with: .color(color))
            }
        }
    }
}
