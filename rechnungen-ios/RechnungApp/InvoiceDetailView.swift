import SwiftUI
import SwiftData
import MessageUI

/// PDF-Vorschau einer Rechnung mit Mail- und Teilen-Button.
struct InvoiceDetailView: View {
    @Bindable var invoice: Invoice

    @AppStorage("mailEmpfaenger") private var empfaenger = ""
    @AppStorage("mailCC") private var cc = ""

    @State private var zeigeBearbeiten = false
    @State private var zeigeMail = false
    @State private var zeigeTeilen = false
    @State private var pdfURL: URL?

    init(invoice: Invoice) {
        self.invoice = invoice
    }

    var body: some View {
        let pdf = InvoicePDF.data(for: invoice)

        VStack(spacing: 0) {
            PDFKitView(data: pdf)

            VStack(spacing: 10) {
                if let d = invoice.versendetAm {
                    Label("Per Mail versendet am \(Fmt.datum.string(from: d))", systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
                HStack(spacing: 12) {
                    Button(action: sendeMail) {
                        Label("Per Mail senden", systemImage: "envelope.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    if let url = pdfURL {
                        ShareLink(item: url) {
                            Label("Teilen", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .controlSize(.large)
            }
            .padding()
            .background(.bar)
        }
        .navigationTitle("Nr. \(invoice.nummerText)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { zeigeBearbeiten = true } label: {
                        Label("Bearbeiten", systemImage: "pencil")
                    }
                    if invoice.versendetAm == nil {
                        Button { invoice.versendetAm = .now } label: {
                            Label("Als versendet markieren", systemImage: "checkmark.circle")
                        }
                    } else {
                        Button { invoice.versendetAm = nil } label: {
                            Label("Als offen markieren", systemImage: "clock")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(isPresented: $zeigeBearbeiten) {
            InvoiceEditView(invoice: invoice)
        }
        .sheet(isPresented: $zeigeMail) {
            MailView(
                an: Fmt.adressen(empfaenger),
                cc: Fmt.adressen(cc),
                betreff: invoice.mailBetreff,
                text: invoice.mailText,
                anhang: pdf,
                dateiName: invoice.dateiName
            ) { ergebnis in
                if ergebnis == .sent { invoice.versendetAm = .now }
                zeigeMail = false
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $zeigeTeilen) {
            if let url = pdfURL {
                ActivityView(items: [url])
                    .presentationDetents([.medium, .large])
            }
        }
        .task(id: pdf) {
            pdfURL = try? InvoicePDF.speichere(pdf, name: invoice.dateiName)
        }
    }

    private func sendeMail() {
        if MFMailComposeViewController.canSendMail() {
            zeigeMail = true
        } else {
            // Kein Konto in Apple Mail eingerichtet → Teilen-Menü (Gmail, Outlook, …)
            zeigeTeilen = true
        }
    }
}
