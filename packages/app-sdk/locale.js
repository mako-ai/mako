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
    lastDays: n => `Last ${n} days`, mtd: "Month to date", qtd: "Quarter to date", ytd: "Year to date",
  },
  filterBar: { filters: "Filters", reset: "Reset", resetTitle: "Back to the default filters", done: "Done" },
  filter: { all: "All", none: "None", many: n => `${n} selected`, only: "Only", search: "Search", noMatch: "No match", groupAll: label => `All ${label}` },
  combobox: { placeholder: "Select...", search: "Search...", empty: "No results found." },
  // DataTable's English set is DATA_TABLE_LABELS in ui.js (its range is JSX).
};

const fr = {
  period: {
    time: "Période", previous: "Période précédente", next: "Période suivante", menu: "Choisir une période",
    week: "Semaine", month: "Mois", quarter: "Trimestre", year: "Année", custom: "Personnalisé", presets: "Raccourcis",
    inProgress: "en cours", inProgressTitle: "En cours : les chiffres ne sont pas encore définitifs",
    from: "Du", to: "Au", apply: "Appliquer",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => `${n} derniers jours`, mtd: "Ce mois-ci", qtd: "Ce trimestre", ytd: "Cette année",
  },
  filterBar: { filters: "Filtres", reset: "Réinitialiser", resetTitle: "Revenir aux filtres par défaut", done: "Terminé" },
  filter: { all: "Tous", none: "Aucun", many: n => `${n} sélectionnés`, only: "Seulement", search: "Rechercher", noMatch: "Aucun résultat", groupAll: label => `${label} (tout)` },
  combobox: { placeholder: "Choisir…", search: "Rechercher…", empty: "Aucun résultat." },
  dataTable: {
    rows: "lignes", of: "sur", empty: "Aucune ligne pour ces filtres.",
    page: (p, n) => `Page ${p} sur ${n}`, perPage: s => `${s} par page`, rowsPerPage: "Lignes par page",
    first: "Première page", previous: "Page précédente", next: "Page suivante", last: "Dernière page",
    sortHint: l => `${l} · cliquer pour trier`, exportCsv: "Exporter en CSV",
    exportTitle: "Exporter toutes les lignes de toutes les pages, dans l'ordre du tri",
    exportFailed: "Le navigateur a bloqué le téléchargement. Ouvrez l'app dans un nouvel onglet et exportez à nouveau.",
    expand: "Afficher le détail", collapse: "Masquer le détail", info: l => `À propos de ${l}`,
  },
};

const de = {
  period: {
    time: "Zeitraum", previous: "Vorheriger Zeitraum", next: "Nächster Zeitraum", menu: "Zeitraum wählen",
    week: "Woche", month: "Monat", quarter: "Quartal", year: "Jahr", custom: "Individuell", presets: "Schnellwahl",
    inProgress: "laufend", inProgressTitle: "Laufend: die Zahlen sind noch nicht endgültig",
    from: "Von", to: "Bis", apply: "Anwenden",
    quarterLabel: (q, y) => `Q${q} ${y}`,
    lastDays: n => `Letzte ${n} Tage`, mtd: "Dieser Monat", qtd: "Dieses Quartal", ytd: "Dieses Jahr",
  },
  filterBar: { filters: "Filter", reset: "Zurücksetzen", resetTitle: "Zurück zu den Standardfiltern", done: "Fertig" },
  filter: { all: "Alle", none: "Keine", many: n => `${n} ausgewählt`, only: "Nur", search: "Suchen", noMatch: "Keine Treffer", groupAll: label => `${label} (alle)` },
  combobox: { placeholder: "Auswählen…", search: "Suchen…", empty: "Keine Ergebnisse." },
  dataTable: {
    rows: "Zeilen", of: "von", empty: "Keine Zeilen für diese Filter.",
    page: (p, n) => `Seite ${p} von ${n}`, perPage: s => `${s} pro Seite`, rowsPerPage: "Zeilen pro Seite",
    first: "Erste Seite", previous: "Vorherige Seite", next: "Nächste Seite", last: "Letzte Seite",
    sortHint: l => `${l} · klicken zum Sortieren`, exportCsv: "CSV exportieren",
    exportTitle: "Alle Zeilen aller Seiten exportieren, in der aktuellen Sortierung",
    exportFailed: "Der Browser hat den Download blockiert. Öffnen Sie die App in einem neuen Tab und exportieren Sie erneut.",
    expand: "Details anzeigen", collapse: "Details ausblenden", info: l => `Info zu ${l}`,
  },
};

const it = {
  period: {
    time: "Periodo", previous: "Periodo precedente", next: "Periodo successivo", menu: "Scegli un periodo",
    week: "Settimana", month: "Mese", quarter: "Trimestre", year: "Anno", custom: "Personalizzato", presets: "Scorciatoie",
    inProgress: "in corso", inProgressTitle: "In corso: i numeri non sono ancora definitivi",
    from: "Da", to: "A", apply: "Applica",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => `Ultimi ${n} giorni`, mtd: "Questo mese", qtd: "Questo trimestre", ytd: "Quest'anno",
  },
  filterBar: { filters: "Filtri", reset: "Reimposta", resetTitle: "Torna ai filtri predefiniti", done: "Fatto" },
  filter: { all: "Tutti", none: "Nessuno", many: n => `${n} selezionati`, only: "Solo", search: "Cerca", noMatch: "Nessun risultato", groupAll: label => `${label} (tutti)` },
  combobox: { placeholder: "Seleziona…", search: "Cerca…", empty: "Nessun risultato." },
  dataTable: {
    rows: "righe", of: "di", empty: "Nessuna riga per questi filtri.",
    page: (p, n) => `Pagina ${p} di ${n}`, perPage: s => `${s} per pagina`, rowsPerPage: "Righe per pagina",
    first: "Prima pagina", previous: "Pagina precedente", next: "Pagina successiva", last: "Ultima pagina",
    sortHint: l => `${l} · clicca per ordinare`, exportCsv: "Esporta CSV",
    exportTitle: "Esporta tutte le righe di tutte le pagine, nell'ordine attuale",
    exportFailed: "Il browser ha bloccato il download. Apri l'app in una nuova scheda ed esporta di nuovo.",
    expand: "Mostra dettagli", collapse: "Nascondi dettagli", info: l => `Info su ${l}`,
  },
};

const es = {
  period: {
    time: "Periodo", previous: "Periodo anterior", next: "Periodo siguiente", menu: "Elegir un periodo",
    week: "Semana", month: "Mes", quarter: "Trimestre", year: "Año", custom: "Personalizado", presets: "Atajos",
    inProgress: "en curso", inProgressTitle: "En curso: las cifras aún no son definitivas",
    from: "Desde", to: "Hasta", apply: "Aplicar",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => `Últimos ${n} días`, mtd: "Este mes", qtd: "Este trimestre", ytd: "Este año",
  },
  filterBar: { filters: "Filtros", reset: "Restablecer", resetTitle: "Volver a los filtros por defecto", done: "Listo" },
  filter: { all: "Todos", none: "Ninguno", many: n => `${n} seleccionados`, only: "Solo", search: "Buscar", noMatch: "Sin resultados", groupAll: label => `${label} (todo)` },
  combobox: { placeholder: "Seleccionar…", search: "Buscar…", empty: "Sin resultados." },
  dataTable: {
    rows: "filas", of: "de", empty: "Ninguna fila con estos filtros.",
    page: (p, n) => `Página ${p} de ${n}`, perPage: s => `${s} por página`, rowsPerPage: "Filas por página",
    first: "Primera página", previous: "Página anterior", next: "Página siguiente", last: "Última página",
    sortHint: l => `${l} · clic para ordenar`, exportCsv: "Exportar CSV",
    exportTitle: "Exportar todas las filas de todas las páginas, en el orden actual",
    exportFailed: "El navegador bloqueó la descarga. Abre la app en una pestaña nueva y exporta de nuevo.",
    expand: "Ver detalles", collapse: "Ocultar detalles", info: l => `Acerca de ${l}`,
  },
};

const pl = {
  period: {
    time: "Okres", previous: "Poprzedni okres", next: "Następny okres", menu: "Wybierz okres",
    week: "Tydzień", month: "Miesiąc", quarter: "Kwartał", year: "Rok", custom: "Własny", presets: "Skróty",
    inProgress: "w toku", inProgressTitle: "W toku: liczby nie są jeszcze ostateczne",
    from: "Od", to: "Do", apply: "Zastosuj",
    quarterLabel: (q, y) => `Q${q} ${y}`,
    lastDays: n => `Ostatnie ${n} dni`, mtd: "Ten miesiąc", qtd: "Ten kwartał", ytd: "Ten rok",
  },
  filterBar: { filters: "Filtry", reset: "Resetuj", resetTitle: "Przywróć domyślne filtry", done: "Gotowe" },
  filter: { all: "Wszystkie", none: "Brak", many: n => `Wybrano: ${n}`, only: "Tylko", search: "Szukaj", noMatch: "Brak wyników", groupAll: label => `${label} (wszystko)` },
  combobox: { placeholder: "Wybierz…", search: "Szukaj…", empty: "Brak wyników." },
  dataTable: {
    rows: "wierszy", of: "z", empty: "Brak wierszy dla tych filtrów.",
    page: (p, n) => `Strona ${p} z ${n}`, perPage: s => `${s} na stronę`, rowsPerPage: "Wierszy na stronę",
    first: "Pierwsza strona", previous: "Poprzednia strona", next: "Następna strona", last: "Ostatnia strona",
    sortHint: l => `${l} · kliknij, aby sortować`, exportCsv: "Eksportuj CSV",
    exportTitle: "Eksportuj wszystkie wiersze ze wszystkich stron, w bieżącej kolejności",
    exportFailed: "Przeglądarka zablokowała pobieranie. Otwórz aplikację w nowej karcie i wyeksportuj ponownie.",
    expand: "Pokaż szczegóły", collapse: "Ukryj szczegóły", info: l => `Informacje: ${l}`,
  },
};

const pt = {
  period: {
    time: "Período", previous: "Período anterior", next: "Período seguinte", menu: "Escolher um período",
    week: "Semana", month: "Mês", quarter: "Trimestre", year: "Ano", custom: "Personalizado", presets: "Atalhos",
    inProgress: "em curso", inProgressTitle: "Em curso: os números ainda não são definitivos",
    from: "De", to: "Até", apply: "Aplicar",
    quarterLabel: (q, y) => `T${q} ${y}`,
    lastDays: n => `Últimos ${n} dias`, mtd: "Este mês", qtd: "Este trimestre", ytd: "Este ano",
  },
  filterBar: { filters: "Filtros", reset: "Repor", resetTitle: "Voltar aos filtros predefinidos", done: "Concluído" },
  filter: { all: "Todos", none: "Nenhum", many: n => `${n} selecionados`, only: "Apenas", search: "Procurar", noMatch: "Sem resultados", groupAll: label => `${label} (tudo)` },
  combobox: { placeholder: "Selecionar…", search: "Procurar…", empty: "Sem resultados." },
  dataTable: {
    rows: "linhas", of: "de", empty: "Nenhuma linha com estes filtros.",
    page: (p, n) => `Página ${p} de ${n}`, perPage: s => `${s} por página`, rowsPerPage: "Linhas por página",
    first: "Primeira página", previous: "Página anterior", next: "Página seguinte", last: "Última página",
    sortHint: l => `${l} · clique para ordenar`, exportCsv: "Exportar CSV",
    exportTitle: "Exportar todas as linhas de todas as páginas, pela ordem atual",
    exportFailed: "O navegador bloqueou a transferência. Abra a app num novo separador e exporte de novo.",
    expand: "Ver detalhes", collapse: "Ocultar detalhes", info: l => `Sobre ${l}`,
  },
};

/** Every language's strings, by section: period, filterBar, filter, combobox, dataTable (not in en). */
export const STRINGS = { en, fr, de, it, es, pl, pt };

/**
 * One section's strings for a locale, with `labels` on top. No locale and no
 * labels returns the English object itself.
 */
export function localeStrings(section, locale, labels) {
  const base = STRINGS[localeLang(locale)][section] ?? en[section] ?? {};
  return labels ? { ...base, ...labels } : base;
}
