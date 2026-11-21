import Foundation

/// Alle festen Angaben der Rechnung. Hier ändern, wenn sich z. B. Adresse oder Konto ändern.
enum Vorlage {
    // Absender
    static let firma = "Best Limousinen Service UG"
    static let firmaAdresse = "Eintrachtstr. 25 · 50668 Köln"
    static let ort = "Köln"
    static let telefon = "(0049) (0) 0221/ 914 0 9170"
    static let fax = "(0049) (0) 0221/ 914 0 91717"
    static let email = "musa.murat@outlook.de"
    static let steuernummer = "215/5804/3623"
    static let bankzeile = "IBAN DE91370501981934996099 Sparkasse Köln Bonn"

    // Empfänger
    static let empfaengerName = "Gamma Placetel GmbH"
    static let empfaengerStrasse = "Lothringerstr. 56"
    static let empfaengerOrt = "50667 Köln"

    // Texte
    static let anrede = "Sehr geehrte Damen und Herren,"
    static let text1 = "hiermit schicke ich Ihnen die Rechnung für die diversen Fahrten in dem angegebenen Zeitraum."
    static let text2 = "Ich bitte Sie die Rechnung auf das unten angegebene Konto zu überweisen."
    static let gruss = "Mit freundlichen Grüßen"

    // Steuer & Datei
    static let mwstProzent: Double = 19
    static let dateiPrefix = "Gamma_Placetel_GmbH"
    static let betreffVorschlag = "Transfer Herr "
}

enum Steuer {
    /// Netto aus Brutto (in Cent), kaufmännisch gerundet.
    static func netto(_ bruttoCent: Int) -> Int {
        Int((Double(bruttoCent) * 100 / (100 + Vorlage.mwstProzent)).rounded())
    }

    static func mwst(_ bruttoCent: Int) -> Int {
        bruttoCent - netto(bruttoCent)
    }
}

enum Fmt {
    static let deutsch = Locale(identifier: "de_DE")

    static let datum: DateFormatter = {
        let f = DateFormatter()
        f.locale = deutsch
        f.dateFormat = "dd.MM.yyyy"
        return f
    }()

    static let monatJahrKurz: DateFormatter = {
        let f = DateFormatter()
        f.locale = deutsch
        f.dateFormat = "MMyy"
        return f
    }()

    static let monatJahrLang: DateFormatter = {
        let f = DateFormatter()
        f.locale = deutsch
        f.dateFormat = "LLLL yyyy"
        return f
    }()

    static let zahl: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = deutsch
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    static func betrag(_ cent: Int) -> String {
        zahl.string(from: NSNumber(value: Double(cent) / 100)) ?? "0,00"
    }

    static func euro(_ cent: Int) -> String {
        betrag(cent) + " €"
    }

    /// Liest Eingaben wie "390", "390,00", "1.234,56" oder "390.5" als Cent.
    static func cent(aus text: String) -> Int? {
        var s = text
            .replacingOccurrences(of: "€", with: "")
            .replacingOccurrences(of: " ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.contains(",") {
            s = s.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".")
        }
        guard let wert = Double(s), wert >= 0 else { return nil }
        return Int((wert * 100).rounded())
    }

    static func zeitraum(_ von: Date, _ bis: Date) -> String {
        if Calendar.current.isDate(von, inSameDayAs: bis) {
            return datum.string(from: von)
        }
        return "\(datum.string(from: von)) – \(datum.string(from: bis))"
    }

    static func adressen(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == ";" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}
