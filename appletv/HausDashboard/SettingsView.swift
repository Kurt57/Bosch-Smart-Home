import SwiftUI

// Where the bridge is: the same address as in Safari on the iPhone, e.g.
// 192.168.2.20:8090, mac-name.local:8090 or a Tailscale name.
struct SettingsView: View {
    @Binding var bridgeURL: String
    @Binding var keepAwake: Bool
    var done: () -> Void
    @State private var draft: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 34) {
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
            Spacer()
        }
        .padding(80)
        .onAppear { draft = bridgeURL }
    }
}
