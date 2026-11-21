import SwiftUI
import SwiftData

/// Formular nur für die variablen Felder. Neu anlegen (invoice == nil) oder bearbeiten.
struct InvoiceEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Invoice.erstelltAm, order: .reverse) private var alle: [Invoice]

    let invoice: Invoice?
    let onSaved: ((Invoice) -> Void)?

    init(invoice: Invoice?, onSaved: ((Invoice) -> Void)? = nil) {
        self.invoice = invoice
        self.onSaved = onSaved
    }

    @State private var nummer = 1
    @State private var datum = Date.now
    @State private var betreff = ""
    @State private var von = Date.now
    @State private var bis = Date.now
    @State private var betragText = ""
    @State private var ihrSchreibenVom = ""
    @State private var ihrZeichen = ""
    @State private var geladen = false

    private var jahr: Int { Calendar.current.component(.year, from: datum) }
    private var bruttoCent: Int? { Fmt.cent(aus: betragText) }

    private var nummerVergeben: Bool {
        alle.contains { $0.jahr == jahr && $0.nummer == nummer && $0 !== invoice }
    }

    private var gueltig: Bool {
        nummer > 0
            && (bruttoCent ?? 0) > 0
            && !betreff.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Rechnung") {
                    HStack {
                        Text("Rechnungs-Nr.")
                        Spacer()
                        TextField("Nr.", value: $nummer, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 70)
                        Text("/ \(String(jahr))").foregroundStyle(.secondary)
                    }
                    if nummerVergeben {
                        Label("Nummer ist \(String(jahr)) schon vergeben", systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    DatePicker("Rechnungsdatum", selection: $datum, displayedComponents: .date)
                }

                Section("Fahrt") {
                    TextField("Betreff, z. B. Transfer Herr Nowack", text: $betreff)
                    DatePicker("Von", selection: $von, displayedComponents: .date)
                    DatePicker("Bis", selection: $bis, in: von..., displayedComponents: .date)
                }

                Section {
                    TextField("z. B. 390,00", text: $betragText)
                        .keyboardType(.decimalPad)
                        .font(.title3.monospacedDigit())
                    if let c = bruttoCent, c > 0 {
                        LabeledContent("Gesamt Netto", value: Fmt.euro(Steuer.netto(c)))
                        LabeledContent("Zzgl. 19 % MwSt.", value: Fmt.euro(Steuer.mwst(c)))
                        LabeledContent("Gesamt Brutto") {
                            Text(Fmt.euro(c)).bold()
                        }
                    }
                } header: {
                    Text("Betrag brutto (€)")
                } footer: {
                    Text("Netto und MwSt. werden automatisch berechnet.")
                }

                Section("Optional") {
                    TextField("Ihr Schreiben vom", text: $ihrSchreibenVom)
                    TextField("Ihr Zeichen", text: $ihrZeichen)
                }
            }
            .navigationTitle(invoice == nil ? "Neue Rechnung" : "Bearbeiten")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { speichern() }
                        .bold()
                        .disabled(!gueltig)
                }
            }
            .onAppear(perform: laden)
            .onChange(of: von) { _, neu in
                if bis < neu { bis = neu }
            }
        }
    }

    private func laden() {
        guard !geladen else { return }
        geladen = true

        if let r = invoice {
            nummer = r.nummer
            datum = r.datum
            betreff = r.betreff
            von = r.zeitraumVon
            bis = r.zeitraumBis
            betragText = Fmt.betrag(r.bruttoCent)
            ihrSchreibenVom = r.ihrSchreibenVom
            ihrZeichen = r.ihrZeichen
        } else {
            let j = Calendar.current.component(.year, from: .now)
            nummer = (alle.filter { $0.jahr == j }.map(\.nummer).max() ?? 0) + 1
            betreff = alle.first?.betreff ?? Vorlage.betreffVorschlag
        }
    }

    private func speichern() {
        guard let cent = bruttoCent else { return }
        let r: Invoice
        if let invoice {
            r = invoice
        } else {
            r = Invoice(nummer: nummer, datum: datum, betreff: betreff,
                        zeitraumVon: von, zeitraumBis: bis, bruttoCent: cent)
            context.insert(r)
        }
        r.nummer = nummer
        r.datum = datum
        r.jahr = jahr
        r.betreff = betreff.trimmingCharacters(in: .whitespaces)
        r.zeitraumVon = von
        r.zeitraumBis = max(von, bis)
        r.bruttoCent = cent
        r.ihrSchreibenVom = ihrSchreibenVom
        r.ihrZeichen = ihrZeichen
        try? context.save()

        dismiss()
        onSaved?(r)
    }
}
