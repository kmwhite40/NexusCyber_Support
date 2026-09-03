import type { Metadata } from 'next';
import { Public_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/components/auth-context';
import { WelcomeDialog } from '@/components/welcome-dialog';
import { HotlineBanner } from '@/components/hotline-banner';

// Public Sans is the official U.S. government typeface (USWDS) — a deliberate,
// context-specific choice for a gov control plane. JetBrains Mono carries machine
// data (ticket IDs, timestamps, metrics). next/font self-hosts both at build time,
// so there is no runtime egress to Google Fonts (gov-enclave friendly).
const sans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Anchor — Control Plane',
  description: 'Enterprise ITSM, on-call, and security posture platform for Government clouds',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/* Apply the saved theme before first paint to avoid a flash. Defaults to
            dark (the platform's original look) when nothing is stored. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('anchor-theme')||'dark';document.documentElement.classList.toggle('dark',t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();",
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>
          <HotlineBanner />
          {children}
          <WelcomeDialog />
        </AuthProvider>
      </body>
    </html>
  );
}
