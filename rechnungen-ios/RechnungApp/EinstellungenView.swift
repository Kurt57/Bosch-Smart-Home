import SwiftUI

struct EinstellungenView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("mailEmpfaenger") private var empfaenger = ""
    @AppStorage("mailCC") private var cc = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Empfänger, z. B. buchhaltung@…", text: $empfaenger)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("CC (optional)", text: $cc)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Mail-Versand")
                } footer: {
                    Text("Wird beim Mail-Button automatisch eingetragen. Mehrere Adressen mit Komma trennen.")
                }

                Section {
                    LabeledContent("Absender", value: Vorlage.firma)
                    LabeledContent("Empfänger", value: Vorlage.empfaengerName)
                    LabeledContent("Steuernummer", value: Vorlage.steuernummer)
                    LabeledContent("E-Mail", value: Vorlage.email)
                    Text(Vorlage.bankzeile).font(.footnote)
                } header: {
                    Text("Feste Angaben der Vorlage")
                } footer: {
                    Text("Diese Angaben stehen auf jeder Rechnung gleich (Datei Vorlage.swift).")
                }
            }
            .navigationTitle("Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }
}
