import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Design tokens drive per-tenant branding (docs/nexus/10 §V.2) — CSS variables in
// globals.css are themeable per organization.
const config: Config = {
  // Class strategy: a `.dark` class on <html> selects the dark palette (see globals.css).
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1280px' },
    },
    extend: {
      colors: {
        bg: 'hsl(var(--bg))',
        surface: 'hsl(var(--surface))',
        'surface-2': 'hsl(var(--surface-2))',
        border: 'hsl(var(--border))',
        muted: 'hsl(var(--muted))',
        fg: 'hsl(var(--fg))',
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          fg: 'hsl(var(--brand-fg))',
        },
        accent: 'hsl(var(--accent))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger: 'hsl(var(--danger))',
        // shadcn-compatible semantic aliases (so vendored 21st.dev components work as-is)
        background: 'hsl(var(--bg))',
        foreground: 'hsl(var(--fg))',
        primary: 'hsl(var(--brand))',
        'primary-foreground': 'hsl(var(--brand-fg))',
        secondary: 'hsl(var(--surface-2))',
        'secondary-foreground': 'hsl(var(--fg))',
        'muted-foreground': 'hsl(var(--muted))',
        'accent-foreground': 'hsl(var(--fg))',
        destructive: 'hsl(var(--danger))',
        'destructive-foreground': 'hsl(var(--fg))',
        input: 'hsl(var(--border))',
        ring: 'hsl(var(--brand))',
        popover: 'hsl(var(--surface))',
        'popover-foreground': 'hsl(var(--fg))',
      },
      borderRadius: {
        lg: '14px',
        md: '10px',
        sm: '7px',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px hsl(var(--border)), 0 8px 30px -12px hsl(var(--brand) / 0.45)',
        card: '0 1px 0 0 hsl(var(--border)), 0 12px 40px -24px rgba(0,0,0,0.7)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // shadcn accordion (used by the vendored navbar's mobile menu)
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'fade-up': 'fade-up 0.4s cubic-bezier(0.16,1,0.3,1)',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
export default config;
