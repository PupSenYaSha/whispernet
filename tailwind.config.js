
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'rgb(var(--color-bg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-bg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--color-bg-tertiary) / <alpha-value>)',
          hover: 'rgb(var(--color-bg-hover) / <alpha-value>)',
          active: 'rgb(var(--color-bg-active) / <alpha-value>)',
        },
        fg: {
          primary: 'rgb(var(--color-fg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)',
          muted: 'rgb(var(--color-fg-muted) / <alpha-value>)',
          subtle: 'rgb(var(--color-fg-subtle) / <alpha-value>)',
        },
        accent: {
          primary: 'rgb(var(--color-accent-primary) / <alpha-value>)',
          dim: 'rgb(var(--color-accent-dim) / <alpha-value>)',
          glow: 'rgb(var(--color-accent-glow) / <alpha-value>)',
          text: 'rgb(var(--color-accent-text) / <alpha-value>)',
          bg: 'var(--color-accent-bg)',
          'bg-hover': 'var(--color-accent-bg-hover)',
        },
        border: {
          default: 'rgb(var(--color-border-default) / <alpha-value>)',
          focus: 'rgb(var(--color-border-focus) / <alpha-value>)',
        },
        status: {
          error: 'rgb(var(--color-status-error) / <alpha-value>)',
          success: 'rgb(var(--color-status-success) / <alpha-value>)',
          warning: 'rgb(var(--color-status-warning) / <alpha-value>)',
        },
        bubble: {
          mine: 'rgb(var(--color-bubble-mine) / <alpha-value>)',
          'mine-text': 'rgb(var(--color-bubble-mine-text) / <alpha-value>)',
          other: 'rgb(var(--color-bubble-other) / <alpha-value>)',
          'other-text': 'rgb(var(--color-bubble-other-text) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'slide-in-from-right': 'slideInFromRight 0.2s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInFromRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
}
