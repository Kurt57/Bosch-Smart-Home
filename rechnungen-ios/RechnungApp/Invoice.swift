import Foundation
import SwiftData

/// Eine gespeicherte Rechnung. Enthält nur die variablen Angaben – der Rest kommt aus `Vorlage`.
@Model
final class Invoice {
    var nummer: Int
    var jahr: Int
    var datum: Date
    var betreff: String
    var zeitraumVon: Date
    var zeitraumBis: Date
    var bruttoCent: Int
    var ihrSchreibenVom: String
    var ihrZeichen: String
    var erstelltAm: Date
    var versendetAm: Date?

    init(
        nummer: Int,
        datum: Date,
        betreff: String,
        zeitraumVon: Date,
        zeitraumBis: Date,
        bruttoCent: Int,
        ihrSchreibenVom: String = "",
        ihrZeichen: String = ""
    ) {
        self.nummer = nummer
        self.jahr = Calendar.current.component(.year, from: datum)
        self.datum = datum
        self.betreff = betreff
        self.zeitraumVon = zeitraumVon
        self.zeitraumBis = zeitraumBis
        self.bruttoCent = bruttoCent
        self.ihrSchreibenVom = ihrSchreibenVom
        self.ihrZeichen = ihrZeichen
        self.erstelltAm = .now
        self.versendetAm = nil
    }
}

extension Invoice {
    /// z. B. "075 / 2026"
    var nummerText: String { String(format: "%03d / %d", nummer, jahr) }

    var nettoCent: Int { Steuer.netto(bruttoCent) }
    var mwstCent: Int { Steuer.mwst(bruttoCent) }

    var zeitraumText: String { Fmt.zeitraum(zeitraumVon, zeitraumBis) }

    /// z. B. "Gamma_Placetel_GmbH_1126.pdf" (Monat + Jahr des Rechnungsdatums)
    var dateiName: String { "\(Vorlage.dateiPrefix)_\(Fmt.monatJahrKurz.string(from: datum)).pdf" }

    var mailBetreff: String { "Rechnung Nr. \(nummerText) – \(betreff)" }

    var mailText: String {
        """
        \(Vorlage.anrede)

        anbei erhalten Sie die Rechnung Nr. \(nummerText) für \(betreff) (\(zeitraumText)) über \(Fmt.euro(bruttoCent)).

        \(Vorlage.text2)

        \(Vorlage.gruss)
        \(Vorlage.firma)
        """
    }
}
