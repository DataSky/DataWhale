/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        "bg-primary": "#1a1d23",
        "bg-secondary": "#22252b",
        "bg-tertiary": "#2a2d35",
        "bg-hover": "#32353e",
        border: "#3a3d45",
        "text-primary": "#e8eaed",
        "text-secondary": "#9aa0a8",
        "text-muted": "#6b7280",
        accent: "#5b8def",
        "accent-hover": "#7ba5f5",
        "accent-muted": "#2d4a7a",
        success: "#34d399",
        error: "#f87171",
        warning: "#fbbf24",
      },
      typography: {
        DEFAULT: {
          css: {
            color: "#e8eaed",
            maxWidth: "none",
          },
        },
      },
    },
  },
  plugins: [],
}
