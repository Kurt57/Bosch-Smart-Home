import SwiftUI

// Where the bridge is: the same address as in Safari on the iPhone, e.g.
// 192.168.2.20:8090, mac-name.local:8090 or a Tailscale name. Next to it the
// colour scheme – it takes effect at once, on this page too.
// Shown as a full-screen cover with its own opaque background – otherwise
// tvOS lets the dashboard shine through and the page looks muddled.
struct SettingsView: View {
    @Binding var bridgeURL: String
    @Binding var keepAwake: Bool
    @Binding var themeName: String
    var done: () -> Void
    @State private var draft: String = ""

    var body: some View {
        HStack(alignment: .top, spacing: 60) {
            VStack(alignment: .leading, spacing: 30) {
                Label("Einstellungen", systemImage: "gearshape.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("Adresse der Bridge")
                    .font(.system(size: 48, weight: .bold))
                Text("Wie im Safari am iPhone, z. B. 192.168.2.20:8090 oder mac-name.local:8090. " +
                     "Ohne Angabe nimmt die App Port 8090.")
                    .font(.system(size: 26))
                    .foregroundStyle(.secondary)
                TextField("192.168.2.20:8090", text: $draft)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.system(size: 32))
                Toggle("Bildschirm anlassen, solange die App offen ist", isOn: $keepAwake)
                    .font(.system(size: 28))
                Text("Aus: Das Apple TV geht wie sonst nach der eingestellten Zeit in den Ruhezustand " +
                     "(spart Strom, schont OLED-Fernseher).")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                HStack(spacing: 30) {
                    Button("Speichern") {
                        bridgeURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        done()
                    }
                    Button("Abbrechen") {
                        done()
                    }
                }
                Text("Tipp: ▶︎❙❙ auf der Fernbedienung lädt die Werte sofort neu.")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .focusSection()

            // the colour scheme – swipe right to get here; a click switches at once
            VStack(alignment: .leading, spacing: 12) {
                Text("Farbschema")
                    .font(.system(size: 36, weight: .bold))
                Text("Wirkt sofort – auch hier auf der Seite.")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 6)
                ForEach(TVTheme.allCases) { theme in
                    Button {
                        themeName = theme.rawValue
                    } label: {
                        ThemeRow(theme: theme, selected: theme.rawValue == themeName)
                    }
                    .buttonStyle(ThemeRowStyle())
                    .focusEffectDisabled()
                }
            }
            .frame(width: 600, alignment: .leading)
            .focusSection()
        }
        .padding(56)
        .frame(maxWidth: 1720, alignment: .leading)
        .glassCard(36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AmbientBackground(warmth: 0).ignoresSafeArea())
        .onAppear { draft = bridgeURL }
    }
}

/// One colour scheme in the list: a small preview, its name, what it is like.
private struct ThemeRow: View {
    let theme: TVTheme
    let selected: Bool

    var body: some View {
        HStack(spacing: 16) {
            ThemeSwatch(theme: theme)
                .frame(width: 96, height: 58)
            VStack(alignment: .leading, spacing: 2) {
                Text(theme.name)
                    .font(.system(size: 24, weight: .semibold))
                Text(theme.note)
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 8)
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(selected ? Color.green : Color.secondary)
        }
    }
}

/// The scheme in miniature: its background, a card on it, the light.
private struct ThemeSwatch: View {
    let theme: TVTheme

    var body: some View {
        ZStack {
            LinearGradient(colors: [theme.top, theme.bottom], startPoint: .top, endPoint: .bottom)
            if theme.glow > 0 {
                RadialGradient(colors: [Color(red: 0.58, green: 0.32, blue: 1.0).opacity(0.8 * theme.glow), Color.clear],
                               center: .bottomLeading, startRadius: 0, endRadius: 70)
                RadialGradient(colors: [Color(red: 1.0, green: 0.76, blue: 0.24).opacity(0.6 * theme.glow), Color.clear],
                               center: .topTrailing, startRadius: 0, endRadius: 60)
            } else {
                RadialGradient(colors: [theme.light.opacity(0.35), Color.clear],
                               center: .topLeading, startRadius: 0, endRadius: 80)
            }
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(theme.card ?? Color.white.opacity(0.16))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(theme.stroke, lineWidth: 1))
                .padding(10)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
    }
}

private struct ThemeRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ThemeRowBody(configuration: configuration)
    }
}

private struct ThemeRowBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        configuration.label
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(isFocused ? 0.18 : 0.05)))
            .scaleEffect(configuration.isPressed ? 0.97 : (isFocused ? 1.03 : 1))
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}
