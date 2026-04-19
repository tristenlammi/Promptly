import clsx, { type ClassValue } from "clsx";

/** Tiny wrapper around clsx so imports are one symbol across the app. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
