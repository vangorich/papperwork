import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Aptos', '"Segoe UI Variable"', '"Noto Sans SC"', 'sans-serif'],
        display: ['"Iowan Old Style"', '"Source Han Serif SC"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
