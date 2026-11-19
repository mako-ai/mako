// FilterMenu: one filter dropdown for flat and nested option lists, on stock
// shadcn DropdownMenu. Ported 1:1 from the apps' NestedFilterMenu
// (web-performance, hasura-performance, quarterly-requalification-rate):
// "All …" first, then the options; a group opens as a hover submenu (or with
// the arrow key) that starts with its own "All <group>" row. Each row has a
// checkbox (a tick when every leaf under it is picked, a dash when some are)
// and an "Only" action on hover. The menu stays open across toggles. Rows
// carry no hover descriptions: definitions live in the filter's info note.
//
// The selection model is the kit's (2.20, `filter*` in ui-core.js): a
// selection is a list of leaf values, [] means All, and "nothing ticked" is
// a draft that emits nothing until the next tick.
//
// 2.29: `locale` and `labels` translate All, None, Only, "All <group>" and
// "N selected" from the SDK's strings table (../locale.js).
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
  closePopovers,
  filterAllTick,
  filterLeaves,
  filterLeavesOf,
  filterNormalize,
  filterText,
  filterTick,
  filterToggle,
  filterToggleAll,
  type FilterTick,
} from "../ui.js";
import { localeStrings, type FilterLabels } from "../locale.js";
import { Checkbox } from "./checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export interface FilterMenuOption {
  value: string;
  label: string;
  /** A second, muted line under a leaf's label. */
  description?: string;
  /** What the option covers. Not shown on the row: definitions live in the filter's info note. */
  title?: string;
  /** A group: a hover submenu that starts with "All <label>". */
  children?: FilterMenuOption[];
}

const ROW =
  "mk-fm-row relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground";

const asChecked = (s: FilterTick) => (s === "on" ? true : s === "mixed" ? ("indeterminate" as const) : false);

/** The row's checkbox, drawn only: the row (or its wrapper) takes the click. */
function Tick(props: { state: FilterTick }) {
  return <Checkbox checked={asChecked(props.state)} tabIndex={-1} aria-hidden className="pointer-events-none" />;
}

export interface FilterMenuItemsProps {
  options: FilterMenuOption[];
  /** Picked leaf values; [] (or every leaf) = All. `value` is an alias. */
  selected?: readonly string[];
  value?: readonly string[];
  onChange: (selected: string[]) => void;
  /** The first row ("All traffic"). Default "All" (`labels.all`). */
  allLabel?: string;
  /** Mako thin prop (2.29): BCP 47 tag, e.g. "fr-CH": All, None, Only, "All <group>", "N selected" in that language. Default English. */
  locale?: string;
  /** Mako thin prop (2.29): override single texts on top of the locale. The explicit props win. */
  labels?: Partial<FilterLabels>;
  /** What All emits: [] (default) or every leaf value (false). */
  emptyMeansAll?: boolean;
  /** The "nothing ticked" draft, when the owner shows it (FilterMenu's trigger). Uncontrolled otherwise. */
  none?: boolean;
  onNoneChange?: (none: boolean) => void;
  /**
   * The phone Filters menu, where a submenu has no room beside its parent: a
   * group row opens in place instead (`drill.open(node)`), and `root` then
   * lists that group's rows, "All <group>" first.
   */
  drill?: { open: (node: FilterMenuOption) => void };
  root?: FilterMenuOption;
}

/**
 * The menu's rows ("All …", a separator, the options and their submenus), for
 * FilterMenu's own dropdown and for an app's combined toolbar menu, where
 * they fill one filter's submenu.
 */
export function FilterMenuItems(props: FilterMenuItemsProps) {
  const { options, drill, emptyMeansAll = true } = props;
  const L = localeStrings("filter", props.locale, props.labels);
  const allLabel = props.allLabel ?? L.all;
  // English keeps 2.28's two text nodes ("All ", label); a locale writes one string.
  const translated = props.locale != null || props.labels?.groupAll != null;
  const groupAllText = (label: string) => (translated ? L.groupAll(label) : <>All {label}</>);
  const selected = filterNormalize(options, props.selected ?? props.value ?? []);
  const [ownNone, setOwnNone] = React.useState(false);
  const none = props.none ?? ownNone;
  const setNone = props.onNoneChange ?? setOwnNone;

  const emit = (next: string[]) => {
    setNone(false);
    props.onChange(next.length ? next : emptyMeansAll ? [] : filterLeaves(options));
  };
  const apply = (r: { none: boolean; selected: string[] }) => (r.none ? setNone(true) : emit(r.selected));
  const flip = (node: FilterMenuOption) => apply(filterToggle(options, selected, node, none));
  const tick = (node: FilterMenuOption) => filterTick(node, selected, none);

  const only = (node: FilterMenuOption) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    emit(filterNormalize(options, filterLeavesOf(node)));
  };
  // A group with no children yet picks nothing: no Only, and its box is inert.
  const empty = (node: FilterMenuOption) => filterLeavesOf(node).length === 0;
  const onlyButton = (node: FilterMenuOption) =>
    empty(node) ? null : (
      <span role="button" tabIndex={-1} className="mk-fm-only" onClick={only(node)} onPointerUp={e => e.stopPropagation()}>
        {L.only}
      </span>
    );

  const leafRow = (node: FilterMenuOption) => {
    const st = tick(node);
    return (
      <DropdownMenuPrimitive.CheckboxItem
        key={node.value}
        className={ROW}
        checked={asChecked(st)}
        onSelect={e => {
          e.preventDefault();
          flip(node);
        }}
      >
        <Tick state={st} />
        {node.description ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate">{node.label}</span>
            <span className="block text-xs text-muted-foreground">{node.description}</span>
          </span>
        ) : (
          <span className="flex-1 truncate">{node.label}</span>
        )}
        {onlyButton(node)}
      </DropdownMenuPrimitive.CheckboxItem>
    );
  };

  /** A group's box: toggles the whole group; the rest of the row opens it. */
  const groupBox = (node: FilterMenuOption, st: FilterTick) => (
    <span
      role="checkbox"
      aria-checked={st === "on" ? true : st === "mixed" ? "mixed" : false}
      aria-label={L.groupAll(node.label)}
      aria-disabled={empty(node) || undefined}
      className="flex"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        if (!empty(node)) flip(node);
      }}
      onPointerUp={e => e.stopPropagation()}
    >
      <Tick state={st} />
    </span>
  );

  /** "All <group>", first in a group's own list. */
  const groupAll = (node: FilterMenuOption, st: FilterTick) => (
    <DropdownMenuPrimitive.CheckboxItem
      className={ROW}
      checked={asChecked(st)}
      onSelect={e => {
        e.preventDefault();
        flip(node);
      }}
    >
      <Tick state={st} />
      <span className="flex-1">{groupAllText(node.label)}</span>
    </DropdownMenuPrimitive.CheckboxItem>
  );

  const level = (list: FilterMenuOption[]): React.ReactNode[] =>
    list.map(node => {
      if (!node.children) return leafRow(node);
      const st = tick(node);
      if (drill)
        return (
          <DropdownMenuPrimitive.Item
            key={node.value}
            className={`${ROW} mk-fm-drill`}
            onSelect={e => {
              e.preventDefault();
              drill.open(node);
            }}
            onKeyDown={e => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                drill.open(node);
              }
            }}
          >
            {groupBox(node, st)}
            <span className="flex-1 truncate">{node.label}</span>
            {onlyButton(node)}
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </DropdownMenuPrimitive.Item>
        );
      return (
        <DropdownMenuSub key={node.value}>
          <DropdownMenuSubTrigger className="mk-fm-row cursor-pointer gap-2 pl-2">
            {groupBox(node, st)}
            <span className="flex-1 truncate">{node.label}</span>
            {onlyButton(node)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[70vh] min-w-48 overflow-y-auto">
            {groupAll(node, st)}
            <DropdownMenuSeparator />
            {level(node.children)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    });

  if (props.root?.children)
    return (
      <>
        {groupAll(props.root, tick(props.root))}
        <DropdownMenuSeparator />
        {level(props.root.children)}
      </>
    );
  const allSt = filterAllTick(selected, none);
  return (
    <>
      <DropdownMenuPrimitive.CheckboxItem
        className={ROW}
        checked={asChecked(allSt)}
        onSelect={e => {
          e.preventDefault();
          apply(filterToggleAll(selected, none));
        }}
      >
        <Tick state={allSt} />
        <span className="flex-1">{allLabel}</span>
      </DropdownMenuPrimitive.CheckboxItem>
      <DropdownMenuSeparator />
      {level(options)}
    </>
  );
}

export interface FilterMenuProps extends Omit<FilterMenuItemsProps, "none" | "onNoneChange" | "drill" | "root"> {
  /** The accessible name of the trigger ("Traffic"). */
  label: string;
  /** Fixed-width trigger class (no layout shift). */
  triggerClassName?: string;
  /** Trigger text; default filterText(): All, the one picked label, or the picked parts ("Pages + Assets: Images"). */
  summary?: string;
  /** "N selected" for a flat list. */
  formatMany?: (n: number) => string;
  /** The trigger while nothing is ticked (the draft). Default "None". */
  noneLabel?: string;
  /**
   * More texts the trigger is sized to, besides allLabel and the top-level
   * labels (e.g. its default pick, "Pages + Data"). A longer pick ends in an
   * ellipsis inside the trigger, whole in its title.
   */
  probes?: readonly string[];
  /** Replaces allLabel and the top-level labels as what the trigger is sized to. */
  sizeTo?: readonly string[];
  /** Menu alignment against the trigger. Default "start". */
  align?: "start" | "center" | "end";
}

/** The filter dropdown: the kit's trigger (`mk-ms-trigger`) over FilterMenuItems. */
export function FilterMenu(props: FilterMenuProps) {
  const { options } = props;
  const L = localeStrings("filter", props.locale, props.labels);
  const allLabel = props.allLabel ?? L.all;
  const noneLabel = props.noneLabel ?? L.none;
  const selected = filterNormalize(options, props.selected ?? props.value ?? []);
  const [none, setNone] = React.useState(false);
  const text = none ? noneLabel : (props.summary ?? filterText(options, selected, allLabel, props.formatMany ?? L.many));
  const probes = [...(props.sizeTo ?? [allLabel, ...options.map(o => o.label)]), ...(props.probes ?? [])];
  return (
    <DropdownMenu
      onOpenChange={open => {
        if (open) closePopovers();
        else setNone(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button type="button" className={`mk-ms-trigger ${props.triggerClassName ?? ""}`} aria-label={props.label} title={text}>
          <span className="mk-ms-value">
            <span className="mk-ms-fit">
              {/* The text first: a grid's baseline is its first item's, and the probes are 0 px tall. */}
              <span className="mk-ms-text">{text}</span>
              {probes.map((p, i) => (
                <span key={i} className="mk-ms-probe" aria-hidden>
                  {p}
                </span>
              ))}
            </span>
          </span>
          <ChevronDown className="mk-ms-caret" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={props.align ?? "start"} className="max-h-[70vh] min-w-52 overflow-y-auto">
        <FilterMenuItems
          options={options}
          selected={selected}
          onChange={props.onChange}
          allLabel={allLabel}
          locale={props.locale}
          labels={props.labels}
          emptyMeansAll={props.emptyMeansAll}
          none={none}
          onNoneChange={setNone}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
