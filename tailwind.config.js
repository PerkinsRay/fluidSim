/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // ---- 设计令牌（design.md §4） ----
        abyss: "#070B14",
        panel: "#0D1420",
        canvasbg: "#0A101C",
        "accent-cyan": "#22D3EE",
        "accent-blue": "#3B82F6",
        "solid-wall": "#64748B",
        "accent-rose": "#FB7185",
        "accent-green": "#34D399",
        subtle: "rgba(148,163,184,0.14)",
      },
      fontFamily: {
        sans: ["'Space Grotesk'", "'Noto Sans SC'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        panel: "0 8px 40px rgba(0,0,0,0.45)",
        glow: "0 0 24px rgba(34,211,238,0.35)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "aurora-a": {
          "0%,100%": { transform: "translate(0px, 0px)" },
          "50%": { transform: "translate(40px, 24px)" },
        },
        "aurora-b": {
          "0%,100%": { transform: "translate(0px, 0px)" },
          "50%": { transform: "translate(-40px, -28px)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.8)" },
        },
        "pulse-ring": {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(34,211,238,0.35)" },
          "50%": { boxShadow: "0 0 0 5px rgba(34,211,238,0.08)" },
        },
        "gradient-pan": {
          "0%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
        "arrow-nudge-x": {
          "0%,100%": { transform: "translateX(0)" },
          "50%": { transform: "translateX(4px)" },
        },
        "arrow-nudge-y": {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(4px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "aurora-a": "aurora-a 12s ease-in-out infinite",
        "aurora-b": "aurora-b 16s ease-in-out infinite",
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
        "pulse-ring": "pulse-ring 2s ease-in-out infinite",
        "gradient-pan": "gradient-pan 3s ease-in-out infinite",
        "arrow-nudge-x": "arrow-nudge-x 2.5s ease-in-out infinite",
        "arrow-nudge-y": "arrow-nudge-y 2.5s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
