"use client"

// Combobox (2.28): shadcn's combobox recipe (ui.shadcn.com/docs/components/combobox)
// as shipped: Popover + Command, a Button trigger, a Check on the picked row,
// a pick closes the popover and picking the picked row again clears it.
// The recipe is a demo, so its hard-coded list, labels and width become props.
// Mako thin props (2.28): `count` per option (muted, right-aligned, never
// searched, never in the trigger), `keywords` per option, `icon` in the trigger.
// Search matches the label and keywords only, never the value or the count.

import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { defaultFilter } from "cmdk"
import { cn } from "../menu/utils"
import { Button } from "./button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

export type ComboboxOption<V extends string = string> = {
  value: V
  label: string
  /** Mako thin prop (2.28): a number shown muted at the row's right edge. */
  count?: number | string
  /** Mako thin prop (2.28): extra words the search matches. */
  keywords?: string[]
}

const formatCount = (n: number | string) =>
  typeof n === "number" ? n.toLocaleString("en-US") : n

// The item's value is the option value (unique); its keywords hold the label
// first, so the search scores the label and keywords and never the value.
const filterByLabel = (_value: string, search: string, keywords?: string[]) =>
  defaultFilter(keywords?.[0] ?? "", search, keywords?.slice(1))

function Combobox<V extends string = string>({
  options,
  value,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  icon,
  disabled,
  className,
  contentClassName,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<V | ComboboxOption<V>>
  value: V | null
  onChange: (value: V | null) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
  className?: string
  contentClassName?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const items = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o
  ) as ComboboxOption<V>[]
  const picked = items.find((o) => o.value === value)
  const text = picked?.label ?? value ?? placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-slot="combobox-trigger"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          title={text}
          className={cn("w-[200px] justify-between", className)}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate text-left">{text}</span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-(--radix-popover-trigger-width) min-w-[200px] p-0", contentClassName)}
        align="start"
      >
        <Command filter={filterByLabel}>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {items.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  onSelect={() => {
                    onChange(o.value === value ? null : o.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.count != null && (
                    <span
                      data-slot="combobox-count"
                      className="text-xs text-muted-foreground tabular-nums"
                    >
                      {formatCount(o.count)}
                    </span>
                  )}
                  <CheckIcon
                    className={cn(
                      "ml-auto",
                      value === o.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
