// The SDK's one strings table (2.29): every fixed text the filters and the
// table write themselves, in the 7 RealAdvisor languages. A component takes
// `locale` (BCP 47, "fr-CH") and matches on the language part; `labels`
// overrides single strings on top. No `locale`: English, exactly as before.
// Plain data and pure functions, no imports, so ui.js and the TSX share it.

export const LOCALES = ["en", "fr", "de", "it", "es", "pl", "pt"];

/** "fr-CH" → "fr". An unknown language or no locale → "en". */
export function localeLang(locale) {
  const lang = String(locale ?? "").toLowerCase().split(/[-_]/)[0];
  return LOCALES.includes(lang) ? lang : "en";
}

const en = {
  period: {
    time: "Time", previous: "Previous period", next: "Next period", menu: "Pick a period",
    week: "Week", month: "Month", quarter: "Quarter", year: "Year", custom: "Custom", presets: "Shortcuts",
    inProgress: "in progress", inProgressTitle: "In progress: the numbers are not final yet",
    from: "From", to: "To", apply: "Apply",
    quarterLabel: (q, y) => `Q${q} ${y}`,
    lastDays: n => (n === 1 ? "Today" : `Last ${n} days`), mtd: "Month to date", qtd: "Quarter to date", ytd: "Year to date", allTime: "All time",
  },
  filterBar: { filters: "Filters", reset: "Reset", resetTitle: "Back to the default filters", done: "Done" },
  filter: { all: "All", none: "None", many: n => `${n} selected`, only: "Only", search: "Search", noMatch: "No match", groupAll: label => `All ${label}` },
  combobox: { placeholder: "Select...", search: "Search...", empty: "No results found." },
  refresh: {
    button: "Refresh data", running: (done, total) => `Refreshing ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} refreshed`, doneAt: at => `Refreshed ${at}`,
    titleIdle: "Refresh data", titleRunning: "Refreshing data…", titleFailed: "Refresh finished with errors", titleDone: "Data refreshed",
    descIdle: (total, concurrency) => `Re-runs ${total} warehouse ${total === 1 ? "query" : "queries"} (${concurrency} at a time) and updates the app as each one lands.`,
    descRunning: "You can close this — the refresh keeps running in the background.",
    descFailed: "Failed sources keep serving their previous data.", descDone: (total, took) => `All ${total} sources rebuilt in ${took}.`,
    queued: "Queued", running1: "Running", done1: "Done", failed1: "Failed", progress: (done, total) => `${done} of ${total} rebuilt`,
    close: "Close", cancel: "Cancel", start: "Start refresh", hide: "Hide", again: "Refresh again", finish: "Done",
    hint: "Re-runs every binding's warehouse query.", hintRunning: "Refresh in progress — click to see details.",
    stageWaiting: "Contacting Mako", stageBuilding: "Building from warehouse", stageLinking: "Getting download link",
    stageDownloading: "Downloading", stageLoading: "Loading into DuckDB", stageQuerying: "Running query", rowsWritten: n => `${n} rows`, of: "of",
  },
  freshness: { dialog: "Data freshness", sources: "Sources" },
  // DataTable's English set is DATA_TABLE_LABELS in ui.js (its range is JSX).
};

const fr = {
  period: {
    time: "Période", previous: "Période précédente", next: "Période suivante", menu: "Choisir une période",
    week: "Semaine", month: "Mois", quarter: "Trimestre", year: "Année", custom: "Personnalisé", presets: "Raccourcis",
    inProgress: "en cours", inProgressTitle: "En cours : les chiffres ne sont pas encore définitifs",
    from: "Du", to: "Au", apply: "Appliquer",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => (n === 1 ? "Aujourd'hui" : `${n} derniers jours`), mtd: "Ce mois-ci", qtd: "Ce trimestre", ytd: "Cette année", allTime: "Toute la période",
  },
  filterBar: { filters: "Filtres", reset: "Réinitialiser", resetTitle: "Revenir aux filtres par défaut", done: "Terminé" },
  filter: { all: "Tous", none: "Aucun", many: n => `${n} sélectionnés`, only: "Seulement", search: "Rechercher", noMatch: "Aucun résultat", groupAll: label => `${label} (tout)` },
  combobox: { placeholder: "Choisir…", search: "Rechercher…", empty: "Aucun résultat." },
  refresh: {
    button: "Actualiser", running: (done, total) => `Actualisation ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} actualisées`, doneAt: at => `Actualisé à ${at}`,
    titleIdle: "Actualiser les données", titleRunning: "Actualisation des données…", titleFailed: "Actualisation terminée avec des erreurs", titleDone: "Données actualisées",
    descIdle: (total, concurrency) => `Relance ${total} ${total === 1 ? "requête" : "requêtes"} dans l'entrepôt (${concurrency} à la fois) et met l'app à jour à chaque résultat.`,
    descRunning: "Vous pouvez fermer cette fenêtre. L'actualisation continue en arrière-plan.",
    descFailed: "Les sources en échec gardent leurs données précédentes.", descDone: (total, took) => `${total} sources reconstruites en ${took}.`,
    queued: "En attente", running1: "En cours", done1: "Terminé", failed1: "Échec", progress: (done, total) => `${done} sur ${total} reconstruites`,
    close: "Fermer", cancel: "Annuler", start: "Lancer l'actualisation", hide: "Masquer", again: "Actualiser à nouveau", finish: "Terminé",
    hint: "Relance la requête de chaque source dans l'entrepôt.", hintRunning: "Actualisation en cours. Cliquez pour voir le détail.",
    stageWaiting: "Connexion à Mako", stageBuilding: "Construction dans l'entrepôt", stageLinking: "Lien de téléchargement",
    stageDownloading: "Téléchargement", stageLoading: "Chargement dans DuckDB", stageQuerying: "Exécution de la requête", rowsWritten: n => `${n} lignes`, of: "sur",
  },
  freshness: { dialog: "Fraîcheur des données", sources: "Sources" },
  dataTable: {
    rows: "lignes", of: "sur", empty: "Aucune ligne pour ces filtres.",
    page: (p, n) => `Page ${p} sur ${n}`, perPage: s => `${s} par page`, rowsPerPage: "Lignes par page",
    first: "Première page", previous: "Page précédente", next: "Page suivante", last: "Dernière page",
    sortHint: l => `${l} · cliquer pour trier`, exportCsv: "Exporter en CSV",
    exportTitle: "Exporter toutes les lignes de toutes les pages, dans l'ordre du tri",
    exportFailed: "Le navigateur a bloqué le téléchargement. Ouvrez l'app dans un nouvel onglet et exportez à nouveau.",
    expand: "Afficher le détail", collapse: "Masquer le détail", info: l => `À propos de ${l}`,
    resizeHint: "Faire glisser pour redimensionner · double-clic pour réinitialiser",
  },
};

const de = {
  period: {
    time: "Zeitraum", previous: "Vorheriger Zeitraum", next: "Nächster Zeitraum", menu: "Zeitraum wählen",
    week: "Woche", month: "Monat", quarter: "Quartal", year: "Jahr", custom: "Individuell", presets: "Schnellwahl",
    inProgress: "laufend", inProgressTitle: "Laufend: die Zahlen sind noch nicht endgültig",
    from: "Von", to: "Bis", apply: "Anwenden",
    quarterLabel: (q, y) => `Q${q} ${y}`,
    lastDays: n => (n === 1 ? "Heute" : `Letzte ${n} Tage`), mtd: "Dieser Monat", qtd: "Dieses Quartal", ytd: "Dieses Jahr", allTime: "Gesamter Zeitraum",
  },
  filterBar: { filters: "Filter", reset: "Zurücksetzen", resetTitle: "Zurück zu den Standardfiltern", done: "Fertig" },
  filter: { all: "Alle", none: "Keine", many: n => `${n} ausgewählt`, only: "Nur", search: "Suchen", noMatch: "Keine Treffer", groupAll: label => `${label} (alle)` },
  combobox: { placeholder: "Auswählen…", search: "Suchen…", empty: "Keine Ergebnisse." },
  refresh: {
    button: "Aktualisieren", running: (done, total) => `Aktualisiere ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} aktualisiert`, doneAt: at => `Aktualisiert ${at}`,
    titleIdle: "Daten aktualisieren", titleRunning: "Daten werden aktualisiert…", titleFailed: "Aktualisierung mit Fehlern beendet", titleDone: "Daten aktualisiert",
    descIdle: (total, concurrency) => `Führt ${total} ${total === 1 ? "Abfrage" : "Abfragen"} im Warehouse erneut aus (${concurrency} gleichzeitig) und aktualisiert die App nach jedem Ergebnis.`,
    descRunning: "Sie können dieses Fenster schließen. Die Aktualisierung läuft im Hintergrund weiter.",
    descFailed: "Fehlgeschlagene Quellen behalten ihre bisherigen Daten.", descDone: (total, took) => `Alle ${total} Quellen in ${took} neu erstellt.`,
    queued: "Wartet", running1: "Läuft", done1: "Fertig", failed1: "Fehlgeschlagen", progress: (done, total) => `${done} von ${total} neu erstellt`,
    close: "Schließen", cancel: "Abbrechen", start: "Aktualisierung starten", hide: "Ausblenden", again: "Erneut aktualisieren", finish: "Fertig",
    hint: "Führt die Warehouse-Abfrage jeder Quelle erneut aus.", hintRunning: "Aktualisierung läuft. Klicken für Details.",
    stageWaiting: "Verbindung zu Mako", stageBuilding: "Aufbau im Warehouse", stageLinking: "Download-Link wird geholt",
    stageDownloading: "Download", stageLoading: "Laden in DuckDB", stageQuerying: "Abfrage läuft", rowsWritten: n => `${n} Zeilen`, of: "von",
  },
  freshness: { dialog: "Datenaktualität", sources: "Quellen" },
  dataTable: {
    rows: "Zeilen", of: "von", empty: "Keine Zeilen für diese Filter.",
    page: (p, n) => `Seite ${p} von ${n}`, perPage: s => `${s} pro Seite`, rowsPerPage: "Zeilen pro Seite",
    first: "Erste Seite", previous: "Vorherige Seite", next: "Nächste Seite", last: "Letzte Seite",
    sortHint: l => `${l} · klicken zum Sortieren`, exportCsv: "CSV exportieren",
    exportTitle: "Alle Zeilen aller Seiten exportieren, in der aktuellen Sortierung",
    exportFailed: "Der Browser hat den Download blockiert. Öffnen Sie die App in einem neuen Tab und exportieren Sie erneut.",
    expand: "Details anzeigen", collapse: "Details ausblenden", info: l => `Info zu ${l}`,
    resizeHint: "Ziehen zum Ändern der Breite · Doppelklick zum Zurücksetzen",
  },
};

const it = {
  period: {
    time: "Periodo", previous: "Periodo precedente", next: "Periodo successivo", menu: "Scegli un periodo",
    week: "Settimana", month: "Mese", quarter: "Trimestre", year: "Anno", custom: "Personalizzato", presets: "Scorciatoie",
    inProgress: "in corso", inProgressTitle: "In corso: i numeri non sono ancora definitivi",
    from: "Da", to: "A", apply: "Applica",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => (n === 1 ? "Oggi" : `Ultimi ${n} giorni`), mtd: "Questo mese", qtd: "Questo trimestre", ytd: "Quest'anno", allTime: "Tutto il periodo",
  },
  filterBar: { filters: "Filtri", reset: "Reimposta", resetTitle: "Torna ai filtri predefiniti", done: "Fatto" },
  filter: { all: "Tutti", none: "Nessuno", many: n => `${n} selezionati`, only: "Solo", search: "Cerca", noMatch: "Nessun risultato", groupAll: label => `${label} (tutti)` },
  combobox: { placeholder: "Seleziona…", search: "Cerca…", empty: "Nessun risultato." },
  refresh: {
    button: "Aggiorna", running: (done, total) => `Aggiornamento ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} aggiornate`, doneAt: at => `Aggiornato alle ${at}`,
    titleIdle: "Aggiorna i dati", titleRunning: "Aggiornamento dei dati…", titleFailed: "Aggiornamento concluso con errori", titleDone: "Dati aggiornati",
    descIdle: (total, concurrency) => `Riesegue ${total} query sul warehouse (${concurrency} alla volta) e aggiorna l'app a ogni risultato.`,
    descRunning: "Puoi chiudere questa finestra. L'aggiornamento continua in background.",
    descFailed: "Le fonti non riuscite mantengono i dati precedenti.", descDone: (total, took) => `Tutte le ${total} fonti ricostruite in ${took}.`,
    queued: "In coda", running1: "In corso", done1: "Fatto", failed1: "Non riuscito", progress: (done, total) => `${done} di ${total} ricostruite`,
    close: "Chiudi", cancel: "Annulla", start: "Avvia l'aggiornamento", hide: "Nascondi", again: "Aggiorna di nuovo", finish: "Fatto",
    hint: "Riesegue la query sul warehouse di ogni fonte.", hintRunning: "Aggiornamento in corso. Clicca per i dettagli.",
    stageWaiting: "Connessione a Mako", stageBuilding: "Costruzione dal warehouse", stageLinking: "Link di download",
    stageDownloading: "Download", stageLoading: "Caricamento in DuckDB", stageQuerying: "Esecuzione della query", rowsWritten: n => `${n} righe`, of: "di",
  },
  freshness: { dialog: "Aggiornamento dei dati", sources: "Fonti" },
  dataTable: {
    rows: "righe", of: "di", empty: "Nessuna riga per questi filtri.",
    page: (p, n) => `Pagina ${p} di ${n}`, perPage: s => `${s} per pagina`, rowsPerPage: "Righe per pagina",
    first: "Prima pagina", previous: "Pagina precedente", next: "Pagina successiva", last: "Ultima pagina",
    sortHint: l => `${l} · clicca per ordinare`, exportCsv: "Esporta CSV",
    exportTitle: "Esporta tutte le righe di tutte le pagine, nell'ordine attuale",
    exportFailed: "Il browser ha bloccato il download. Apri l'app in una nuova scheda ed esporta di nuovo.",
    expand: "Mostra dettagli", collapse: "Nascondi dettagli", info: l => `Info su ${l}`,
    resizeHint: "Trascina per ridimensionare · doppio clic per ripristinare",
  },
};

const es = {
  period: {
    time: "Periodo", previous: "Periodo anterior", next: "Periodo siguiente", menu: "Elegir un periodo",
    week: "Semana", month: "Mes", quarter: "Trimestre", year: "Año", custom: "Personalizado", presets: "Atajos",
    inProgress: "en curso", inProgressTitle: "En curso: las cifras aún no son definitivas",
    from: "Desde", to: "Hasta", apply: "Aplicar",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => (n === 1 ? "Hoy" : `Últimos ${n} días`), mtd: "Este mes", qtd: "Este trimestre", ytd: "Este año", allTime: "Todo el periodo",
  },
  filterBar: { filters: "Filtros", reset: "Restablecer", resetTitle: "Volver a los filtros por defecto", done: "Listo" },
  filter: { all: "Todos", none: "Ninguno", many: n => `${n} seleccionados`, only: "Solo", search: "Buscar", noMatch: "Sin resultados", groupAll: label => `${label} (todo)` },
  combobox: { placeholder: "Seleccionar…", search: "Buscar…", empty: "Sin resultados." },
  refresh: {
    button: "Actualizar", running: (done, total) => `Actualizando ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} actualizadas`, doneAt: at => `Actualizado a las ${at}`,
    titleIdle: "Actualizar los datos", titleRunning: "Actualizando los datos…", titleFailed: "Actualización terminada con errores", titleDone: "Datos actualizados",
    descIdle: (total, concurrency) => `Vuelve a ejecutar ${total} ${total === 1 ? "consulta" : "consultas"} en el warehouse (${concurrency} a la vez) y actualiza la app con cada resultado.`,
    descRunning: "Puedes cerrar esta ventana. La actualización sigue en segundo plano.",
    descFailed: "Las fuentes con error siguen mostrando sus datos anteriores.", descDone: (total, took) => `${total} fuentes reconstruidas en ${took}.`,
    queued: "En cola", running1: "En curso", done1: "Hecho", failed1: "Error", progress: (done, total) => `${done} de ${total} reconstruidas`,
    close: "Cerrar", cancel: "Cancelar", start: "Iniciar la actualización", hide: "Ocultar", again: "Actualizar de nuevo", finish: "Listo",
    hint: "Vuelve a ejecutar la consulta de cada fuente en el warehouse.", hintRunning: "Actualización en curso. Haz clic para ver el detalle.",
    stageWaiting: "Conectando con Mako", stageBuilding: "Construyendo en el warehouse", stageLinking: "Obteniendo el enlace",
    stageDownloading: "Descargando", stageLoading: "Cargando en DuckDB", stageQuerying: "Ejecutando la consulta", rowsWritten: n => `${n} filas`, of: "de",
  },
  freshness: { dialog: "Actualidad de los datos", sources: "Fuentes" },
  dataTable: {
    rows: "filas", of: "de", empty: "Ninguna fila con estos filtros.",
    page: (p, n) => `Página ${p} de ${n}`, perPage: s => `${s} por página`, rowsPerPage: "Filas por página",
    first: "Primera página", previous: "Página anterior", next: "Página siguiente", last: "Última página",
    sortHint: l => `${l} · clic para ordenar`, exportCsv: "Exportar CSV",
    exportTitle: "Exportar todas las filas de todas las páginas, en el orden actual",
    exportFailed: "El navegador bloqueó la descarga. Abre la app en una pestaña nueva y exporta de nuevo.",
    expand: "Ver detalles", collapse: "Ocultar detalles", info: l => `Acerca de ${l}`,
    resizeHint: "Arrastra para cambiar el ancho · doble clic para restablecer",
  },
};

const pl = {
  period: {
    time: "Okres", previous: "Poprzedni okres", next: "Następny okres", menu: "Wybierz okres",
    week: "Tydzień", month: "Miesiąc", quarter: "Kwartał", year: "Rok", custom: "Własny", presets: "Skróty",
    inProgress: "w toku", inProgressTitle: "W toku: liczby nie są jeszcze ostateczne",
    from: "Od", to: "Do", apply: "Zastosuj",
    quarterLabel: (q, y) => `Q${q} ${y}`,
    lastDays: n => (n === 1 ? "Dzisiaj" : `Ostatnie ${n} dni`), mtd: "Ten miesiąc", qtd: "Ten kwartał", ytd: "Ten rok", allTime: "Cały okres",
  },
  filterBar: { filters: "Filtry", reset: "Resetuj", resetTitle: "Przywróć domyślne filtry", done: "Gotowe" },
  filter: { all: "Wszystkie", none: "Brak", many: n => `Wybrano: ${n}`, only: "Tylko", search: "Szukaj", noMatch: "Brak wyników", groupAll: label => `${label} (wszystko)` },
  combobox: { placeholder: "Wybierz…", search: "Szukaj…", empty: "Brak wyników." },
  refresh: {
    button: "Odśwież", running: (done, total) => `Odświeżanie ${done}/${total}…`, partial: (ok, total) => `Odświeżono ${ok}/${total}`, doneAt: at => `Odświeżono ${at}`,
    titleIdle: "Odśwież dane", titleRunning: "Odświeżanie danych…", titleFailed: "Odświeżanie zakończone z błędami", titleDone: "Dane odświeżone",
    descIdle: (total, concurrency) => `Ponownie uruchamia zapytania w hurtowni (${total}, po ${concurrency} naraz) i aktualizuje aplikację po każdym wyniku.`,
    descRunning: "Możesz zamknąć to okno. Odświeżanie trwa w tle.",
    descFailed: "Źródła z błędem zachowują poprzednie dane.", descDone: (total, took) => `Odbudowano wszystkie źródła (${total}) w ${took}.`,
    queued: "W kolejce", running1: "W toku", done1: "Gotowe", failed1: "Błąd", progress: (done, total) => `Odbudowano ${done} z ${total}`,
    close: "Zamknij", cancel: "Anuluj", start: "Rozpocznij odświeżanie", hide: "Ukryj", again: "Odśwież ponownie", finish: "Gotowe",
    hint: "Ponownie uruchamia zapytanie każdego źródła w hurtowni.", hintRunning: "Trwa odświeżanie. Kliknij, aby zobaczyć szczegóły.",
    stageWaiting: "Łączenie z Mako", stageBuilding: "Budowanie w hurtowni", stageLinking: "Pobieranie linku",
    stageDownloading: "Pobieranie", stageLoading: "Ładowanie do DuckDB", stageQuerying: "Wykonywanie zapytania", rowsWritten: n => `${n} wierszy`, of: "z",
  },
  freshness: { dialog: "Aktualność danych", sources: "Źródła" },
  dataTable: {
    rows: "wierszy", of: "z", empty: "Brak wierszy dla tych filtrów.",
    page: (p, n) => `Strona ${p} z ${n}`, perPage: s => `${s} na stronę`, rowsPerPage: "Wierszy na stronę",
    first: "Pierwsza strona", previous: "Poprzednia strona", next: "Następna strona", last: "Ostatnia strona",
    sortHint: l => `${l} · kliknij, aby sortować`, exportCsv: "Eksportuj CSV",
    exportTitle: "Eksportuj wszystkie wiersze ze wszystkich stron, w bieżącej kolejności",
    exportFailed: "Przeglądarka zablokowała pobieranie. Otwórz aplikację w nowej karcie i wyeksportuj ponownie.",
    expand: "Pokaż szczegóły", collapse: "Ukryj szczegóły", info: l => `Informacje: ${l}`,
    resizeHint: "Przeciągnij, aby zmienić szerokość · kliknij dwukrotnie, aby przywrócić",
  },
};

const pt = {
  period: {
    time: "Período", previous: "Período anterior", next: "Período seguinte", menu: "Escolher um período",
    week: "Semana", month: "Mês", quarter: "Trimestre", year: "Ano", custom: "Personalizado", presets: "Atalhos",
    inProgress: "em curso", inProgressTitle: "Em curso: os números ainda não são definitivos",
    from: "De", to: "Até", apply: "Aplicar",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => (n === 1 ? "Hoje" : `Últimos ${n} dias`), mtd: "Este mês", qtd: "Este trimestre", ytd: "Este ano", allTime: "Todo o período",
  },
  filterBar: { filters: "Filtros", reset: "Repor", resetTitle: "Voltar aos filtros predefinidos", done: "Concluído" },
  filter: { all: "Todos", none: "Nenhum", many: n => `${n} selecionados`, only: "Apenas", search: "Procurar", noMatch: "Sem resultados", groupAll: label => `${label} (tudo)` },
  combobox: { placeholder: "Selecionar…", search: "Procurar…", empty: "Sem resultados." },
  refresh: {
    button: "Atualizar", running: (done, total) => `A atualizar ${done}/${total}…`, partial: (ok, total) => `${ok}/${total} atualizadas`, doneAt: at => `Atualizado às ${at}`,
    titleIdle: "Atualizar os dados", titleRunning: "A atualizar os dados…", titleFailed: "Atualização concluída com erros", titleDone: "Dados atualizados",
    descIdle: (total, concurrency) => `Volta a executar ${total} ${total === 1 ? "consulta" : "consultas"} no warehouse (${concurrency} de cada vez) e atualiza a app a cada resultado.`,
    descRunning: "Pode fechar esta janela. A atualização continua em segundo plano.",
    descFailed: "As fontes com erro mantêm os dados anteriores.", descDone: (total, took) => `${total} fontes reconstruídas em ${took}.`,
    queued: "Em fila", running1: "Em curso", done1: "Concluído", failed1: "Falhou", progress: (done, total) => `${done} de ${total} reconstruídas`,
    close: "Fechar", cancel: "Cancelar", start: "Iniciar a atualização", hide: "Ocultar", again: "Atualizar de novo", finish: "Concluído",
    hint: "Volta a executar a consulta de cada fonte no warehouse.", hintRunning: "Atualização em curso. Clique para ver o detalhe.",
    stageWaiting: "A ligar ao Mako", stageBuilding: "A construir no warehouse", stageLinking: "A obter a ligação",
    stageDownloading: "A transferir", stageLoading: "A carregar no DuckDB", stageQuerying: "A executar a consulta", rowsWritten: n => `${n} linhas`, of: "de",
  },
  freshness: { dialog: "Atualidade dos dados", sources: "Fontes" },
  dataTable: {
    rows: "linhas", of: "de", empty: "Nenhuma linha com estes filtros.",
    page: (p, n) => `Página ${p} de ${n}`, perPage: s => `${s} por página`, rowsPerPage: "Linhas por página",
    first: "Primeira página", previous: "Página anterior", next: "Página seguinte", last: "Última página",
    sortHint: l => `${l} · clique para ordenar`, exportCsv: "Exportar CSV",
    exportTitle: "Exportar todas as linhas de todas as páginas, pela ordem atual",
    exportFailed: "O navegador bloqueou a transferência. Abra a app num novo separador e exporte de novo.",
    expand: "Ver detalhes", collapse: "Ocultar detalhes", info: l => `Sobre ${l}`,
    resizeHint: "Arraste para redimensionar · duplo clique para repor",
  },
};

/** Every language's strings, by section: period, filterBar, filter, combobox, refresh, freshness (2.30), dataTable (not in en). */
export const STRINGS = { en, fr, de, it, es, pl, pt };

/**
 * One section's strings for a locale, with `labels` on top. No locale and no
 * labels returns the English object itself.
 */
export function localeStrings(section, locale, labels) {
  const base = STRINGS[localeLang(locale)][section] ?? en[section] ?? {};
  return labels ? { ...base, ...labels } : base;
}
