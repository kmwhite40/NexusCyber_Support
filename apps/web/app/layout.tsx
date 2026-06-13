import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/auth-context';

export const metadata: Metadata = {
  title: 'Anchor — Control Plane',
  description: 'Enterprise ITSM, on-call, and security posture platform for Commercial and Government clouds',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint to avoid a flash. Defaults to
            dark (the platform's original look) when nothing is stored. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('anchor-theme')||'dark';document.documentElement.classList.toggle('dark',t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();",
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        {/* Note: in a gov enclave, self-host fonts instead of loading from Google. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
