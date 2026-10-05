# Songsaver

Lädt einen Playlist-Export (CSV von [Exportify](https://exportify.net)) und zeigt, wo die Songs zu kaufen sind und was sie kosten – inklusive Hinweis, wann sich ein ganzes Album lohnt.

Die App läuft komplett im Browser (statische Seite, kein Server, kein Build-Schritt). Preise kommen live aus der öffentlichen iTunes Search API; jeder Nutzer hat damit sein eigenes Anfragelimit (~20/Minute).

Vor der Suche zeigt die App eine Zeitschätzung für die aktuelle Auswahl. Gesucht wird nur auf Klick; die Suche lässt sich pausieren und nach einem Neuladen fortsetzen (Titel, Ergebnisse und ein 7-Tage-Cache liegen in IndexedDB). Optional meldet eine Browser-Benachrichtigung das Ende der Suche.

## Entwicklung

```sh
npm start               # lokaler Server auf http://localhost:8080
npm test                # Offline-Tests (CSV, Abgleich, Einkaufsliste)
npm run check:live      # Beispiel-CSV gegen das echte iTunes abgleichen
npm run check:ui        # App im Headless-Browser durchklicken, Screenshots in screenshots/
```

`check:ui` braucht einmalig `npm install` und `npx playwright install chromium-headless-shell`.

## Aufbau

- `js/csv.js` – Exportify-CSV einlesen (englische und deutsche Spaltennamen)
- `js/text.js` – Titel/Künstler normalisieren (Remaster-, feat.-Zusätze) und vergleichen
- `js/itunes.js` – iTunes-Client mit Drosselung, Pause (AbortSignal) und Cache
- `js/store.js` – IndexedDB-Speicher für Cache und Sitzung (Fallback: flüchtig)
- `js/zip.js`, `js/playlists.js` – Exportify-ZIP lesen, Playlists zusammenführen
- `js/matcher.js` – Titel finden (Album-Titel gebündelt über eine Album-Abfrage), Anfragen schätzen, günstigsten Einkauf berechnen
- `js/app.js` – Oberfläche
- `samples/beispiel-playlist.csv` – 5 Einzeltitel + komplettes Album „Thriller“ (Metadaten und ISRCs von Deezer, Spotify-URIs sind Platzhalter)
