# Rechnungen – iPhone-App (Best Limousinen Service → Gamma Placetel)

Erstellt die Rechnung im Layout der Word-Vorlage (`Gamma_Placetel_GmbH_1126.pdf`) als PDF.
Man gibt **nur die variablen Angaben** ein, alles andere bleibt immer gleich.

## Funktionen

- **Neue Rechnung (+)** – nur diese Felder:
  - Rechnungs-Nr. (wird automatisch hochgezählt, z. B. `076 / 2026`)
  - Rechnungsdatum
  - Betreff (z. B. `Transfer Herr Nowack` – wird von der letzten Rechnung vorgeschlagen)
  - Zeitraum von – bis
  - Betrag brutto → Netto und 19 % MwSt. werden automatisch berechnet
  - optional: „Ihr Schreiben vom“, „Ihr Zeichen“
- **Historie** – alle Rechnungen nach Monat gruppiert, mit Suche, Jahresumsatz und Status „offen / versendet“. Wischen zum Löschen.
- **PDF-Vorschau** jeder Rechnung, nachträglich bearbeitbar.
- **Per Mail senden** – öffnet Apple Mail mit Empfänger, Betreff, Text und PDF-Anhang
  (`Gamma_Placetel_GmbH_MMJJ.pdf`). Nach dem Senden wird die Rechnung als „versendet“ markiert.
  Ist Apple Mail nicht eingerichtet, öffnet sich das Teilen-Menü (Gmail, Outlook, …).
- **Teilen** – PDF über WhatsApp, Dateien, AirDrop usw.
- **Einstellungen (Zahnrad)** – Standard-Empfänger und CC für die Mail.

Feste Angaben (Adresse, Telefon, Steuernummer, IBAN, Empfänger, Texte) stehen in
`RechnungApp/Vorlage.swift` und können dort geändert werden.

## Installation aufs iPhone

Voraussetzung: Mac mit **Xcode 16** oder neuer, iPhone mit **iOS 17** oder neuer.

1. `RechnungApp.xcodeproj` in Xcode öffnen.
2. Links das Projekt **RechnungApp** → Target **RechnungApp** → Tab **Signing & Capabilities**:
   bei **Team** die eigene Apple-ID auswählen (kostenlose Apple-ID reicht).
   Falls die Bundle-ID schon vergeben ist, z. B. `de.bestlimousinen.rechnungen.deinname` eintragen.
3. iPhone per Kabel anschließen, oben als Ziel auswählen, **▶︎ Run** drücken.
4. Beim ersten Start auf dem iPhone: *Einstellungen → Allgemein → VPN & Geräteverwaltung* → Entwickler vertrauen.
   (Ab iOS 16 muss außerdem *Einstellungen → Datenschutz & Sicherheit → Entwicklermodus* an sein.)

Hinweis: Mit einer kostenlosen Apple-ID läuft die App 7 Tage und muss danach erneut aus Xcode installiert werden.
Mit einem Apple-Developer-Account (99 €/Jahr) ein Jahr bzw. dauerhaft über TestFlight.

Die Daten (Historie) liegen lokal auf dem iPhone (SwiftData).
