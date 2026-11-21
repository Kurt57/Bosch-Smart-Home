import SwiftUI
import SwiftData

/// Startbildschirm: Historie aller Rechnungen, nach Monat gruppiert.
struct HistoryView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Invoice.datum, order: .reverse) private var rechnungen: [Invoice]

    @State private var pfad: [Invoice] = []
    @State private var zeigeNeu = false
    @State private var zeigeEinstellungen = false
    @State private var suche = ""

    private var gefiltert: [Invoice] {
        let s = suche.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return rechnungen }
        return rechnungen.filter {
            $0.betreff.localizedCaseInsensitiveContains(s)
                || $0.nummerText.contains(s)
                || $0.zeitraumText.contains(s)
        }
    }

    private struct Gruppe: Identifiable {
        let monat: Date
        let eintraege: [Invoice]
        var id: Date { monat }
    }

    private var gruppen: [Gruppe] {
        let kal = Calendar.current
        let dict = Dictionary(grouping: gefiltert) { r in
            kal.date(from: kal.dateComponents([.year, .month], from: r.datum)) ?? r.datum
        }
        return dict.keys.sorted(by: >).map { monat in
            Gruppe(monat: monat,
                   eintraege: (dict[monat] ?? []).sorted { ($0.jahr, $0.nummer) > ($1.jahr, $1.nummer) })
        }
    }

    private var aktuellesJahr: Int { Calendar.current.component(.year, from: .now) }

    private var summeJahr: Int {
        rechnungen.filter { $0.jahr == aktuellesJahr }.reduce(0) { $0 + $1.bruttoCent }
    }

    private var anzahlJahr: Int {
        rechnungen.filter { $0.jahr == aktuellesJahr }.count
    }

    var body: some View {
        NavigationStack(path: $pfad) {
            List {
                if !rechnungen.isEmpty && suche.isEmpty {
                    Section {
                        LabeledContent {
                            Text(Fmt.euro(summeJahr)).bold().monospacedDigit()
                        } label: {
                            Text("Umsatz \(String(aktuellesJahr)) (brutto)")
                            Text("\(anzahlJahr) Rechnungen")
                        }
                    }
                }
                ForEach(gruppen) { gruppe in
                    Section(Fmt.monatJahrLang.string(from: gruppe.monat)) {
                        ForEach(gruppe.eintraege) { r in
                            NavigationLink(value: r) {
                                InvoiceRow(invoice: r)
                            }
                        }
                        .onDelete { indizes in
                            for i in indizes { context.delete(gruppe.eintraege[i]) }
                            try? context.save()
                        }
                    }
                }
            }
            .overlay {
                if rechnungen.isEmpty {
                    ContentUnavailableView(
                        "Noch keine Rechnungen",
                        systemImage: "doc.text",
                        description: Text("Tippe auf + um die erste Rechnung zu erstellen.")
                    )
                } else if gefiltert.isEmpty {
                    ContentUnavailableView.search(text: suche)
                }
            }
            .navigationTitle("Rechnungen")
            .navigationDestination(for: Invoice.self) { InvoiceDetailView(invoice: $0) }
            .searchable(text: $suche, prompt: "Name, Nummer, Datum")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { zeigeEinstellungen = true } label: { Image(systemName: "gearshape") }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { zeigeNeu = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $zeigeNeu) {
                InvoiceEditView(invoice: nil) { neu in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { pfad = [neu] }
                }
            }
            .sheet(isPresented: $zeigeEinstellungen) { EinstellungenView() }
        }
    }
}

struct InvoiceRow: View {
    let invoice: Invoice

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(invoice.betreff).font(.headline)
                Text(invoice.zeitraumText).font(.subheadline).foregroundStyle(.secondary)
                Text("Nr. \(invoice.nummerText) · \(Fmt.datum.string(from: invoice.datum))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.euro(invoice.bruttoCent)).font(.headline).monospacedDigit()
                if invoice.versendetAm != nil {
                    Label("versendet", systemImage: "checkmark.circle.fill")
                        .font(.caption).foregroundStyle(.green)
                } else {
                    Label("offen", systemImage: "clock")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
