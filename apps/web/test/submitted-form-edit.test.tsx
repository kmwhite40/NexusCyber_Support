import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmittedForm } from '@/components/submitted-form';
import { ApiError, ticketForm, type SubmittedForm as Form } from '@/lib/api';

// ticketForm's methods close over the module's own `api`, so mock them directly.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    ticketForm: { get: vi.fn(), edit: vi.fn() },
  };
});
const mocked = vi.mocked(ticketForm, true);

const def = (key: string, label: string, over: Record<string, unknown> = {}) => ({
  key, label, data_type: 'text', required: false, options: [], options_source: null, visible_when: null,
  sensitive: false, section: 'The person', maps_to: null, locked: null, ...over,
});

const FORM: Form = {
  form_key: 'user_onboarding',
  form_name: 'User onboarding',
  sections: [{
    section: 'The person',
    fields: [
      { key: 'legal_first_name', label: 'Legal first name', data_type: 'text', value: 'Grace', display: 'Grace', sensitive: false },
      { key: 'start_date', label: 'Start date', data_type: 'date', value: '2026-10-01', display: '2026-10-01', sensitive: false },
      { key: 'personal_email', label: 'Personal email', data_type: 'email', value: null, display: null, sensitive: true },
    ],
  }],
  fields: [
    def('legal_first_name', 'Legal first name', { required: true, maps_to: 'subject' }),
    def('start_date', 'Start date', { data_type: 'date', required: true }),
    def('personal_email', 'Personal email', { data_type: 'email', sensitive: true }),
  ] as Form['fields'],
  edit: { blocked: null, locked: {} },
  requester: null, affected_user: null, approvers: [], notes: null, pii: 'withheld',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('SubmittedForm editing', () => {
  it('offers no Edit button without ticket.form.edit, or on a resolved ticket', async () => {
    mocked.get.mockResolvedValue({ data: FORM });
    const { rerender } = render(<SubmittedForm ticketId="T-1" canViewPii={false} ticketStatus="in_progress" />);
    await screen.findByText('Grace');
    expect(screen.queryByRole('button', { name: /edit answers/i })).not.toBeInTheDocument();
    rerender(<SubmittedForm ticketId="T-1" canViewPii={false} canEdit ticketStatus="resolved" />);
    expect(screen.queryByRole('button', { name: /edit answers/i })).not.toBeInTheDocument();
  });

  it('disables Edit and says why when the API reports the form is frozen', async () => {
    mocked.get.mockResolvedValue({ data: { ...FORM, edit: { blocked: 'Account provisioning is in progress for this request.', locked: {} } } });
    render(<SubmittedForm ticketId="T-1" canViewPii={false} canEdit ticketStatus="in_progress" />);
    expect(await screen.findByRole('button', { name: /edit answers/i })).toBeDisabled();
    expect(screen.getByText(/provisioning is in progress/i)).toBeInTheDocument();
  });

  it('sends only the changed answers with the reason, and keeps input when the server refuses', async () => {
    mocked.get.mockResolvedValue({ data: FORM });
    mocked.edit.mockRejectedValueOnce(new ApiError(422, 'Start date must be a date (YYYY-MM-DD)', [{ field: 'start_date', message: 'Start date must be a date (YYYY-MM-DD)' }]));
    const onSaved = vi.fn();
    render(<SubmittedForm ticketId="T-1" canViewPii={false} canEdit ticketStatus="in_progress" onSaved={onSaved} />);
    await userEvent.click(await screen.findByRole('button', { name: /edit answers/i }));

    // PII is not editable without reveal/permission.
    expect(screen.getByText(/only be changed by staff with PII access/i)).toBeInTheDocument();

    const first = screen.getByDisplayValue('Grace');
    await userEvent.clear(first);
    await userEvent.type(first, 'Grayce');
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled(); // reason still empty
    await userEvent.type(screen.getByPlaceholderText(/HR corrected/i), 'Spelling');
    await userEvent.click(save);

    expect(mocked.edit).toHaveBeenCalledWith('T-1', { legal_first_name: 'Grayce' }, 'Spelling', false);
    expect(await screen.findAllByText(/must be a date/i)).not.toHaveLength(0);
    expect(screen.getByDisplayValue('Grayce')).toBeInTheDocument(); // input kept
    expect(onSaved).not.toHaveBeenCalled();

    const saved = { ...FORM, sections: [{ ...FORM.sections[0], fields: [{ ...FORM.sections[0].fields[0], value: 'Grayce', display: 'Grayce' }, ...FORM.sections[0].fields.slice(1)] }] };
    mocked.edit.mockResolvedValueOnce({ data: saved });
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Grayce')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });
});
