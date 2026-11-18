import { CheckIcon, MinusIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./utils";

/**
 * shadcn's Checkbox, with the indeterminate state: a white tick when checked,
 * a white dash when indeterminate, both on the brand colour; an empty box
 * when unchecked. The one checkbox style of the app.
 */
function Checkbox({ className, checked, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={checked}
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input bg-background shadow-xs outline-none transition-shadow",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-[var(--brand)] data-[state=checked]:bg-[var(--brand)]",
        "data-[state=indeterminate]:border-[var(--brand)] data-[state=indeterminate]:bg-[var(--brand)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center">
        {checked === "indeterminate" ? (
          <MinusIcon className="size-3.5 text-white" strokeWidth={3} />
        ) : (
          <CheckIcon className="size-3.5 text-white" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
