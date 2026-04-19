import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "DM Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        // Claude-inspired palette. Prefer CSS vars (see index.css) for dynamic
        // theming. These Tailwind colours are useful for utility classes.
        bg: {
          light: "#FAF9F7",
          dark: "#1C1917",
        },
        surface: {
          light: "#FFFFFF",
          dark: "#27231E",
        },
        accent: {
          DEFAULT: "#D97757",
        },
        ink: {
          light: "#1A1A19",
          dark: "#F5F5F4",
        },
        muted: {
          light: "#6B7280",
          dark: "#A8A29E",
        },
      },
      borderRadius: {
        card: "0.75rem",
        input: "1.5rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
