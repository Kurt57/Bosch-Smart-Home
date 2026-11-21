import SwiftUI
import PDFKit
import MessageUI

/// PDF-Anzeige
struct PDFKitView: UIViewRepresentable {
    let data: Data

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .secondarySystemBackground
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        guard context.coordinator.data != data else { return }
        context.coordinator.data = data
        view.document = PDFDocument(data: data)
        view.autoScales = true
    }

    final class Coordinator {
        var data: Data?
    }
}

/// Apple-Mail-Fenster mit fertigem Text und PDF-Anhang
struct MailView: UIViewControllerRepresentable {
    let an: [String]
    let cc: [String]
    let betreff: String
    let text: String
    let anhang: Data
    let dateiName: String
    let fertig: (MFMailComposeResult) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(fertig: fertig) }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let vc = MFMailComposeViewController()
        vc.mailComposeDelegate = context.coordinator
        vc.setToRecipients(an)
        if !cc.isEmpty { vc.setCcRecipients(cc) }
        vc.setSubject(betreff)
        vc.setMessageBody(text, isHTML: false)
        vc.addAttachmentData(anhang, mimeType: "application/pdf", fileName: dateiName)
        return vc
    }

    func updateUIViewController(_ vc: MFMailComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let fertig: (MFMailComposeResult) -> Void
        init(fertig: @escaping (MFMailComposeResult) -> Void) { self.fertig = fertig }

        func mailComposeController(_ controller: MFMailComposeViewController,
                                   didFinishWith result: MFMailComposeResult,
                                   error: Error?) {
            fertig(result)
        }
    }
}

/// System-Teilen-Menü (Fallback, wenn Apple Mail nicht eingerichtet ist)
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
