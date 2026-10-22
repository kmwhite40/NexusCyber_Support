// "Locked out? Reset your password" — the self-service reset link for a user who cannot sign in.
//
// It has to be on the LOGIN page: the welcome dialog only opens for a signed-in user, so a
// locked-out user never sees it there. The URL comes from the public /auth/config (it is
// cloud-specific — a GCC High account cannot reset on the commercial portal), and the link is
// hidden rather than pointing somewhere wrong when the API does not supply one.
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import { WelcomeDialog } from '@/components/welcome-dialog';
import { auth, type Me } from '@/lib/api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const authState = { me: null as Me | null };
vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({ ...authState, loading: false, can: () => false, refresh: vi.fn(), logout: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    auth: { ...actual.auth, config: vi.fn(), devUsers: vi.fn(async () => ({ users: [] })) },
  };
});
const config = vi.mocked(auth.config);

const SSO_OFF = { oidcEnabled: false, oidcLabel: '', customerOidcEnabled: false, customerOidcLabel: '' };
const GOV = 'https://passwordreset.activedirectory.windowsazure.us';

beforeEach(() => {
  config.mockReset();
  authState.me = null;
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

describe('login page reset link', () => {
  it('links to the configured SSPR portal in a new tab, without leaking the opener', async () => {
    config.mockResolvedValue({ ...SSO_OFF, ssprUrl: GOV });
    render(<LoginPage />);
    const link = await screen.findByRole('link', { name: /reset your password/i });
    expect(link).toHaveAttribute('href', GOV);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/locked out\?/i)).toBeInTheDocument();
  });

  it('is shown even when no SSO button is', async () => {
    // A password user who has locked themselves out needs it as much as an SSO user does.
    config.mockResolvedValue({ ...SSO_OFF, ssprUrl: GOV });
    render(<LoginPage />);
    expect(await screen.findByRole('link', { name: /reset your password/i })).toBeInTheDocument();
  });

  it('is hidden when the API supplies no ssprUrl', async () => {
    config.mockResolvedValue({ ...SSO_OFF });
    render(<LoginPage />);
    await waitFor(() => expect(config).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /reset your password/i })).not.toBeInTheDocument();
  });

  it('is hidden when /auth/config fails', async () => {
    config.mockRejectedValue(new Error('offline'));
    render(<LoginPage />);
    await waitFor(() => expect(config).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /reset your password/i })).not.toBeInTheDocument();
  });
});

describe('welcome dialog reset link', () => {
  it('shows the same link to a signed-in user', async () => {
    authState.me = { id: 'u1', plane: 'customer', email: 'a@acme.gov', organization_id: 'o1', roles: [], capabilities: [] } as unknown as Me;
    config.mockResolvedValue({ ...SSO_OFF, ssprUrl: GOV });
    render(<WelcomeDialog />);
    const link = await screen.findByRole('link', { name: /reset your password/i });
    expect(link).toHaveAttribute('href', GOV);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits it when no ssprUrl is configured', async () => {
    authState.me = { id: 'u1', plane: 'customer', email: 'a@acme.gov', organization_id: 'o1', roles: [], capabilities: [] } as unknown as Me;
    config.mockResolvedValue({ ...SSO_OFF });
    render(<WelcomeDialog />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(config).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /reset your password/i })).not.toBeInTheDocument();
  });
});
