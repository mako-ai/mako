import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's `cn`: Tailwind class merge for the stock components in this folder. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
