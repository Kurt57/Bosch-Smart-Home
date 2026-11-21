import UIKit

/// Zeichnet die Rechnung als A4-PDF im Layout der Word-Vorlage.
enum InvoicePDF {
    static let seite = CGRect(x: 0, y: 0, width: 595.2, height: 841.8) // A4 in Punkt
    private static let links: CGFloat = 72
    private static let linieRechts: CGFloat = 580
    private static let betragRechts: CGFloat = 510
    private static let spalte2: CGFloat = 340

    static func data(for r: Invoice) -> Data {
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: "\(Vorlage.empfaengerName) \(Fmt.monatJahrKurz.string(from: r.datum))",
            kCGPDFContextAuthor as String: Vorlage.firma,
            kCGPDFContextSubject as String: "Rechnung Nr. \(r.nummerText)"
        ]
        let renderer = UIGraphicsPDFRenderer(bounds: seite, format: format)
        return renderer.pdfData { ctx in
            ctx.beginPage()
            zeichne(r)
        }
    }

    /// Schreibt das PDF mit passendem Dateinamen in den temporären Ordner (für Teilen).
    static func speichere(_ data: Data, name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }

    // MARK: - Layout

    private static func zeichne(_ r: Invoice) {
        let breite = seite.width

        // Briefkopf
        text(Vorlage.firma, x: 0, y: 36, breite: breite, font: times(17, fett: true), ausrichtung: .center)
        text(Vorlage.firmaAdresse, x: 0, y: 57, breite: breite, font: times(11), ausrichtung: .center)
        linie(x1: links, x2: linieRechts, y: 78, staerke: 1.3)

        // Ort, Datum
        text("\(Vorlage.ort), den \(Fmt.datum.string(from: r.datum))",
             x: links, y: 106, breite: linieRechts - links, font: times(12), ausrichtung: .right)

        // Empfänger
        linie(x1: links, x2: 232, y: 178, staerke: 0.8)
        text(Vorlage.empfaengerName, x: links, y: 193, font: times(12))
        text(Vorlage.empfaengerStrasse, x: links, y: 207, font: times(12))
        text(Vorlage.empfaengerOrt, x: links, y: 236, font: times(12))

        // Rechte Spalte
        let klein = times(10.5)
        var y: CGFloat = 166
        let zeile: CGFloat = 13.5
        text("Tel.:", x: spalte2, y: y, font: klein)
        text(Vorlage.telefon, x: spalte2 + 36, y: y, breite: 220, font: klein); y += zeile
        text("Fax:", x: spalte2, y: y, font: klein)
        text(Vorlage.fax, x: spalte2 + 36, y: y, breite: 220, font: klein); y += zeile
        for z in [
            "Email:  \(Vorlage.email)",
            "Mein Zeichen: Rechnung Nr. \(r.nummerText)",
            "Ihr Schreiben vom: \(r.ihrSchreibenVom)",
            "Ihr Zeichen: \(r.ihrZeichen)",
            "Steuernummer: \(Vorlage.steuernummer)"
        ] {
            text(z, x: spalte2, y: y, breite: 240, font: klein)
            y += zeile
        }

        // Betreff
        text("Betreff: \(r.betreff)", x: links, y: 303, breite: 450, font: times(12, fett: true))
        text(r.zeitraumText, x: links, y: 318, font: times(12))

        // Brieftext
        text(Vorlage.anrede, x: links, y: 376, breite: 450, font: times(12))
        let h = text(Vorlage.text1, x: links, y: 402, breite: 450, font: times(12))
        text(Vorlage.text2, x: links, y: 402 + h + 14, breite: 450, font: times(12))

        // Beträge
        betragZeile("Gesamt Netto.", Fmt.euro(r.nettoCent), y: 510)
        betragZeile("Zzgl. \(Int(Vorlage.mwstProzent)) % MwSt.", Fmt.euro(r.mwstCent), y: 539)
        betragZeile("Gesamt Brutto.", Fmt.euro(r.bruttoCent), y: 568, fett: true)

        // Gruß
        text(Vorlage.gruss, x: links, y: 638, font: times(12))

        // Bankverbindung
        UIColor(white: 0.82, alpha: 1).setFill()
        UIBezierPath(rect: CGRect(x: links, y: 745, width: linieRechts - links, height: 19)).fill()
        text(Vorlage.bankzeile, x: links, y: 747, breite: linieRechts - links, font: times(12.5, fett: true), ausrichtung: .center)

        text("Seite 1", x: 0, y: 772, breite: breite, font: times(11), ausrichtung: .center)
    }

    private static func betragZeile(_ label: String, _ wert: String, y: CGFloat, fett: Bool = false) {
        text(label, x: links, y: y, font: times(12))
        text(wert, x: betragRechts - 160, y: y, breite: 160, font: times(12, fett: fett),
             ausrichtung: .right, unterstrichen: fett)
    }

    // MARK: - Helfer

    private static func times(_ groesse: CGFloat, fett: Bool = false) -> UIFont {
        let name = fett ? "TimesNewRomanPS-BoldMT" : "TimesNewRomanPSMT"
        return UIFont(name: name, size: groesse)
            ?? (fett ? .boldSystemFont(ofSize: groesse) : .systemFont(ofSize: groesse))
    }

    @discardableResult
    private static func text(
        _ s: String,
        x: CGFloat,
        y: CGFloat,
        breite: CGFloat = 400,
        font: UIFont,
        ausrichtung: NSTextAlignment = .left,
        unterstrichen: Bool = false
    ) -> CGFloat {
        let absatz = NSMutableParagraphStyle()
        absatz.alignment = ausrichtung
        absatz.lineBreakMode = .byWordWrapping
        var attribute: [NSAttributedString.Key: Any] = [
            .font: font,
            .paragraphStyle: absatz,
            .foregroundColor: UIColor.black
        ]
        if unterstrichen {
            attribute[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        let a = NSAttributedString(string: s, attributes: attribute)
        let optionen: NSStringDrawingOptions = [.usesLineFragmentOrigin, .usesFontLeading]
        let hoehe = ceil(a.boundingRect(with: CGSize(width: breite, height: .greatestFiniteMagnitude),
                                        options: optionen, context: nil).height)
        a.draw(with: CGRect(x: x, y: y, width: breite, height: hoehe), options: optionen, context: nil)
        return hoehe
    }

    private static func linie(x1: CGFloat, x2: CGFloat, y: CGFloat, staerke: CGFloat) {
        let pfad = UIBezierPath()
        pfad.move(to: CGPoint(x: x1, y: y))
        pfad.addLine(to: CGPoint(x: x2, y: y))
        pfad.lineWidth = staerke
        UIColor.black.setStroke()
        pfad.stroke()
    }
}
