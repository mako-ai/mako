// @makoai/app-sdk strings table (2.29). Re-exported from "@makoai/app-sdk/ui" and "/components".

/** The languages the SDK ships strings for. */
export type LocaleLang = "en" | "fr" | "de" | "it" | "es" | "pl" | "pt";
export const LOCALES: readonly LocaleLang[];
/** "fr-CH" → "fr". An unknown language or no locale → "en". */
export function localeLang(locale?: string | null): LocaleLang;

/** Every fixed text of PeriodPicker. Override any with `labels`. */
export interface PeriodPickerLabels {
  /** The trigger's screen-reader name when `label` is not set. Default "Time". */
  time: string;
  /** The ‹ button's aria-label. Default "Previous period". */
  previous: string;
  /** The › button's aria-label. Default "Next period". */
  next: string;
  /** The menu's aria-label. Default "Pick a period". */
  menu: string;
  /** The unit tabs. Default "Week", "Month", "Quarter", "Year", "Custom". */
  week: string;
  month: string;
  quarter: string;
  year: string;
  custom: string;
  /** The tab of the `presets`. Default "Shortcuts". */
  presets: string;
  /** Under the period in progress in the grid. Default "in progress". */
  inProgress: string;
  /** The trigger's hover title on the period in progress. Default "In progress: the numbers are not final yet". */
  inProgressTitle: string;
  /** The custom range's fields and button. Default "From", "To", "Apply". */
  from: string;
  to: string;
  apply: string;
  /** A quarter, used only with `locale`. Default `Q4 2026`; French `T4 2026`. */
  quarterLabel: (quarter: number, year: string) => string;
  /** A rolling preset. Default `Last 28 days`. */
  lastDays: (n: number) => string;
  /** The to-date presets. Default "Month to date", "Quarter to date", "Year to date". */
  mtd: string;
  qtd: string;
  ytd: string;
}

/** Every fixed text of FilterBar. */
export interface FilterBarLabels {
  /** The phone chip, the sheet's title and the bar's aria-label. Default "Filters". */
  filters: string;
  /** Default "Reset". */
  reset: string;
  /** Reset's hover title. Default "Back to the default filters". */
  resetTitle: string;
  /** The sheet's close button. Default "Done". */
  done: string;
}

/** Every fixed text of MultiSelect, FilterItems and FilterMenu. Explicit props (`allLabel`, `noneLabel`, `formatMany`, `searchPlaceholder`, `searchEmpty`) win. */
export interface FilterLabels {
  /** The first row and the trigger under All. Default "All". */
  all: string;
  /** The trigger while nothing is ticked. Default "None". */
  none: string;
  /** The trigger for several values. Default `3 selected`. */
  many: (n: number) => string;
  /** The hover action that picks one row alone. Default "Only". */
  only: string;
  /** The search input's placeholder and name. Default "Search". */
  search: string;
  /** Shown when no row matches. Default "No match". */
  noMatch: string;
  /** FilterMenu: a group's own first row. Default `All Pages`. */
  groupAll: (label: string) => string;
}

/** Every fixed text of Combobox. Explicit props (`placeholder`, `searchPlaceholder`, `emptyText`) win. */
export interface ComboboxLabels {
  /** Default "Select...". */
  placeholder: string;
  /** Default "Search...". */
  search: string;
  /** Default "No results found.". */
  empty: string;
}

/** A non-English DataTable set: plain strings, plus `rows` (the default noun) and `of` ("51–100 of 312"). */
export interface DataTableLocaleStrings {
  rows: string;
  of: string;
  empty: string;
  page: (page: number, pageCount: number) => string;
  perPage: (size: number) => string;
  rowsPerPage: string;
  first: string;
  previous: string;
  next: string;
  last: string;
  sortHint: (label: string) => string;
  exportCsv: string;
  exportTitle: string;
  exportFailed: string;
  expand: string;
  collapse: string;
  info: (label: string) => string;
}

export interface LocaleStrings {
  period: PeriodPickerLabels;
  filterBar: FilterBarLabels;
  filter: FilterLabels;
  combobox: ComboboxLabels;
  /** Absent in en: DataTable's English set is DATA_TABLE_LABELS. */
  dataTable?: DataTableLocaleStrings;
}
/** The one strings table, by language. */
export const STRINGS: Readonly<Record<LocaleLang, LocaleStrings>>;
/** One section for a locale, with `labels` on top. */
export function localeStrings<K extends "period" | "filterBar" | "filter" | "combobox">(
  section: K,
  locale?: string | null,
  labels?: Partial<LocaleStrings[K]> | null,
): LocaleStrings[K];
export function localeStrings(section: "dataTable", locale?: string | null, labels?: null): DataTableLocaleStrings | Record<string, never>;
