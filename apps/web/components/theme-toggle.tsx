'use client';
import * as React from 'react';

type Theme = 'light' | 'dark';

// Toggle between light and dark. The initial class is set before paint by the
// no-FOUC script in app/layout.tsx; here we just keep the button label in sync
// and persist the user's choice to localStorage.
export function ThemeToggle() {
  // Start as 'dark' so SSR and the first client render agree (the script also
  // defaults to dark). useEffect then corrects to whatever is actually applied.
  const [theme, setTheme] = React.useState<Theme>('dark');

  React.useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('anchor-theme', next);
    } catch {
      /* storage may be blocked; the in-memory toggle still works for this session */
    }
  };

  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {isDark ? <IconSun /> : <IconMoon />}
    </button>
  );
}

function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
