import { z } from "zod";

/**
 * Creates a validated persist storage adapter that resets store on validation failure
 */
export function createValidatedStorage<T>(
  schema: z.ZodSchema<T>,
  storageName: string,
  _defaultState: T,
) {
  return {
    getItem: (name: string) => {
      try {
        const str = localStorage.getItem(name);
        if (!str) return null;

        const data = JSON.parse(str);

        // Validate the state
        const validationResult = schema.safeParse(data.state);

        if (!validationResult.success) {
          console.warn(
            `Validation failed for ${storageName}. Resetting to default state.`,
            validationResult.error.errors,
          );
          // Clear corrupted data
          localStorage.removeItem(name);
          return null;
        }

        // Return validated data
        return {
          ...data,
          state: validationResult.data,
        };
      } catch (error) {
        console.error(
          `Failed to parse ${storageName} from localStorage:`,
          error,
        );
        localStorage.removeItem(name);
        return null;
      }
    },
    setItem: (name: string, value: any) => {
      try {
        // Validate before saving
        const validationResult = schema.safeParse(value.state);
        if (!validationResult.success) {
          console.error(
            `Validation failed when saving ${storageName}:`,
            validationResult.error.errors,
          );
          return;
        }
        localStorage.setItem(name, JSON.stringify(value));
      } catch (error) {
        console.error(`Failed to save ${storageName} to localStorage:`, error);
      }
    },
    removeItem: (name: string) => {
      localStorage.removeItem(name);
    },
  };
}

// Common Zod refinements and transforms
export const dateString = z.string().transform(str => new Date(str));
export const optionalDateString = z
  .string()
  .optional()
  .nullable()
  .transform(str => (str ? new Date(str) : undefined));

// Ensure errors are always strings
export const errorSchema = z
  .union([z.string(), z.record(z.any()), z.null()])
  .transform(val => {
    if (typeof val === "string") return val;
    if (val === null) return null;
    if (typeof val === "object") {
      // Try to extract error message from common error object shapes
      if ("message" in val && typeof val.message === "string") {
        return val.message;
      }
      if ("error" in val && typeof val.error === "string") return val.error;
      // Fallback to JSON stringification for unknown objects
      try {
        return JSON.stringify(val);
      } catch {
        return "Unknown error";
      }
    }
    return "Unknown error";
  });
