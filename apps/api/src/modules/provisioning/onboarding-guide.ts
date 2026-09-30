// SBS "Microsoft 365 New User Onboarding Guide" — the email the supervisor receives when a new
// account is provisioned, filled in from the run: who, which environment, whether a Cloud PC was
// assigned, and the first-sign-in credential.
//
// Pure: no I/O, no config reads. The caller (deliverCredentialToSupervisor) supplies everything,
// which is what lets this be tested exhaustively and keeps the credential's only path out of the
// process the message body.
//
// Only the environment the account actually lives in is shown. The source template listed
// Commercial and GCC High side by side for a human to tick; the system knows which one applies,
// and a GCC High user sent to the commercial portal simply cannot sign in.
import type { M365Cloud } from '../../config.js';

export interface OnboardingGuideInput {
  fullName: string;
  department: string;
  upn: string;
  /** The Temporary Access Pass or temporary password. Placed in the body and nowhere else. */
  credential: string;
  kind: 'tap' | 'password';
  /** Human lifetime of a TAP, e.g. "8 hours". Ignored for a password. */
  tapLifetime?: string;
  cloud: M365Cloud;
  cloudPcAssigned: boolean;
  issuedOn: Date;
  supervisorName?: string;
  helpdesk: { email?: string; phone?: string; portal?: string; hours?: string };
}

export interface RenderedEmail { subject: string; html: string; text: string }

interface Endpoints { label: string; portal: string; outlook: string }

const COMMERCIAL: Endpoints = {
  label: 'Microsoft 365 Commercial',
  portal: 'https://m365.cloud.microsoft',
  outlook: 'https://outlook.office.com',
};
const GCC_HIGH: Endpoints = {
  label: 'Microsoft 365 GCC High',
  portal: 'https://portal.office365.us',
  outlook: 'https://outlook.office365.us',
};
const CLOUD_PC_PORTAL = 'https://windows.cloud.microsoft';

/** GCC High and the DoD/Azure Government clouds use the .us endpoints; commercial and GCC use the commercial ones. */
export function endpointsFor(cloud: M365Cloud): Endpoints {
  return cloud === 'gcchigh' || cloud === 'azgov' ? GCC_HIGH : COMMERCIAL;
}

export function formatIssuedDate(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- tiny block model rendered to both HTML and plain text, so the two can never drift ----
type Inline = string | { b: string } | { code: string } | { link: string };
type Block =
  | { h1: string } | { h2: string } | { h3: string }
  | { p: Inline[] }
  | { ol: Inline[][] } | { ul: Inline[][] }
  | { kv: Array<[string, Inline[]]> }
  | { note: { title: string; body: Inline[] } }
  | { table: { head: string[]; rows: string[][] } }
  | { hr: true };

function inlineHtml(parts: Inline[]): string {
  return parts.map((x) => {
    if (typeof x === 'string') return esc(x);
    if ('b' in x) return `<strong>${esc(x.b)}</strong>`;
    if ('code' in x) {
      return `<code style="font-family:Consolas,Menlo,monospace;background:#f1f3f5;border:1px solid #dde1e6;border-radius:4px;padding:1px 6px;">${esc(x.code)}</code>`;
    }
    return `<a href="${esc(x.link)}" style="color:#0b5cad;">${esc(x.link)}</a>`;
  }).join('');
}

function inlineText(parts: Inline[]): string {
  return parts.map((x) => (typeof x === 'string' ? x : 'b' in x ? x.b : 'code' in x ? x.code : x.link)).join('');
}

const H = {
  h1: 'margin:28px 0 8px;font-size:20px;color:#0f2a4a;border-bottom:2px solid #0f2a4a;padding-bottom:4px;',
  h2: 'margin:20px 0 6px;font-size:16px;color:#0f2a4a;',
  h3: 'margin:14px 0 4px;font-size:14px;color:#333;',
  p: 'margin:6px 0;',
};

function blocksHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    if ('h1' in b) return `<h1 style="${H.h1}">${esc(b.h1)}</h1>`;
    if ('h2' in b) return `<h2 style="${H.h2}">${esc(b.h2)}</h2>`;
    if ('h3' in b) return `<h3 style="${H.h3}">${esc(b.h3)}</h3>`;
    if ('p' in b) return `<p style="${H.p}">${inlineHtml(b.p)}</p>`;
    if ('ol' in b) return `<ol style="margin:6px 0 6px 22px;padding:0;">${b.ol.map((i) => `<li style="margin:3px 0;">${inlineHtml(i)}</li>`).join('')}</ol>`;
    if ('ul' in b) return `<ul style="margin:6px 0 6px 22px;padding:0;">${b.ul.map((i) => `<li style="margin:3px 0;">${inlineHtml(i)}</li>`).join('')}</ul>`;
    if ('kv' in b) {
      return `<table role="presentation" style="border-collapse:collapse;margin:8px 0;">${b.kv.map(([k, v]) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#555;white-space:nowrap;vertical-align:top;"><strong>${esc(k)}</strong></td><td style="padding:4px 0;">${inlineHtml(v)}</td></tr>`).join('')}</table>`;
    }
    if ('note' in b) {
      return `<div style="margin:10px 0;padding:10px 14px;border:1px solid #f0c36d;border-radius:4px;background:#fff7e6;"><strong>${esc(b.note.title)}</strong><br>${inlineHtml(b.note.body)}</div>`;
    }
    if ('table' in b) {
      const th = b.table.head.map((h) => `<th style="text-align:left;padding:6px 10px;border:1px solid #dde1e6;background:#f1f3f5;">${esc(h)}</th>`).join('');
      const tr = b.table.rows.map((r) => `<tr>${r.map((c, i) => `<td style="padding:6px 10px;border:1px solid #dde1e6;">${i === 0 ? `<strong>${esc(c)}</strong>` : /^https?:\/\//.test(c) ? `<a href="${esc(c)}" style="color:#0b5cad;">${esc(c)}</a>` : esc(c)}</td>`).join('')}</tr>`).join('');
      return `<table style="border-collapse:collapse;margin:8px 0;font-size:13px;"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
    }
    return '<hr style="border:none;border-top:1px solid #dde1e6;margin:18px 0;">';
  }).join('\n');
}

function blocksText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if ('h1' in b) out.push('', b.h1.toUpperCase(), '='.repeat(Math.min(b.h1.length, 60)));
    else if ('h2' in b) out.push('', b.h2, '-'.repeat(Math.min(b.h2.length, 60)));
    else if ('h3' in b) out.push('', b.h3);
    else if ('p' in b) out.push(inlineText(b.p));
    else if ('ol' in b) b.ol.forEach((i, n) => out.push(`  ${n + 1}. ${inlineText(i)}`));
    else if ('ul' in b) b.ul.forEach((i) => out.push(`  - ${inlineText(i)}`));
    else if ('kv' in b) b.kv.forEach(([k, v]) => out.push(`${k.endsWith(':') ? k : `${k}:`} ${inlineText(v)}`));
    else if ('note' in b) out.push('', `** ${b.note.title} ** ${inlineText(b.note.body)}`, '');
    else if ('table' in b) {
      out.push(b.table.head.join(' | '));
      b.table.rows.forEach((r) => out.push(r.join(' | ')));
    } else out.push('', '----------------------------------------');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const box = (checked: boolean) => (checked ? '☒' : '☐');

export function renderOnboardingGuide(d: OnboardingGuideInput): RenderedEmail {
  const env = endpointsFor(d.cloud);
  const isGov = env === GCC_HIGH;
  const isTap = d.kind === 'tap';
  const credLabel = isTap ? 'Temporary Access Pass' : 'Temporary Password';
  const dept = d.department.trim() || 'Not specified';
  const issued = formatIssuedDate(d.issuedOn);
  const cloudPc = d.cloudPcAssigned ? 'Assigned' : 'Not Assigned';
  const hd = d.helpdesk;

  const blocks: Block[] = [
    // A cover note for the recipient: this email carries a live credential.
    { note: {
      title: `For ${d.supervisorName?.trim() || 'the supervisor'}:`,
      body: [
        `this guide contains ${d.fullName}'s ${credLabel.toLowerCase()}. Print it or give it to ${d.fullName} in person. `,
        'Do not forward this email or share the credential by chat or text.',
      ],
    } },
    { kv: [
      ['User:', [d.fullName]],
      ['Department / Program:', [dept]],
      ['Date Issued:', [issued]],
      ['Microsoft 365 Environment:', [`${box(!isGov)} Commercial  ${box(isGov)} GCC High`]],
      ['Windows 365 Cloud PC:', [`${box(d.cloudPcAssigned)} Assigned  ${box(!d.cloudPcAssigned)} Not Assigned`]],
    ] },
    { hr: true },
    { h1: 'Welcome to Strategic Business Systems' },
    { p: ['Welcome to ', { b: 'Strategic Business Systems (SBS)' }, '.'] },
    { p: ['This guide provides the information required to activate your Microsoft 365 account, configure Multi-Factor Authentication (MFA), access Outlook'
      + (d.cloudPcAssigned ? ', and connect to your Windows 365 Cloud PC.' : '.')] },
    { p: ['Please complete the setup steps below before beginning normal business operations.'] },

    { h1: '1 | Your SBS Microsoft 365 Account' },
    { p: ['Your SBS Microsoft 365 account has been created.'] },
    { h3: 'User Information' },
    { kv: [
      ['Employee Name:', [{ code: d.fullName }]],
      ['Microsoft 365 Username:', [{ code: d.upn }]],
      [`${credLabel}:`, [{ code: d.credential }]],
      ['Environment:', [{ code: isGov ? 'GCC HIGH' : 'COMMERCIAL' }]],
      ['Cloud PC:', [{ code: cloudPc.toUpperCase() }]],
    ] },
    { h3: 'Important' },
    ...(isTap
      ? [
        { p: [`Your Temporary Access Pass is for initial account activation only. It can be used once and expires in ${d.tapLifetime ?? 'a few hours'}. `
          + 'Use it to sign in and register Microsoft Authenticator before it expires; if it expires first, contact SBS IT for a new one.'] } as Block,
      ]
      : [
        { p: ['Your temporary password is intended only for initial account activation.'] } as Block,
        { p: ['During your first login, Microsoft will require you to create a new password that complies with SBS security requirements.'] } as Block,
      ]),
    { p: [{ b: 'Never share your password with another individual, including SBS IT personnel.' }] },

    { h1: '2 | First-Time Microsoft 365 Sign-In' },
    { h2: env.label },
    { kv: [
      [isGov ? 'Microsoft 365 GCC High Portal:' : 'Microsoft 365 Portal:', [{ link: env.portal }]],
      [isGov ? 'GCC High Outlook Web Access:' : 'Outlook Web Access:', [{ link: env.outlook }]],
    ] },
    { h3: 'Initial Sign-In' },
    { ol: [
      ['Open ', { b: 'Microsoft Edge' }, ' or another SBS-approved browser.'],
      ['Navigate to ', { link: env.portal }, '.'],
      ['Enter your SBS Microsoft 365 username: ', { code: d.upn }, '.'],
      ...(isTap
        ? [['When prompted, enter the Temporary Access Pass provided above (instead of a password).'] as Inline[]]
        : [['Enter the temporary password provided above.'] as Inline[], ['Change your password when prompted.'] as Inline[]]),
      ['Complete Microsoft Authenticator registration (section 3).'],
      ['Accept any SBS organizational prompts or security notifications.'],
      ['Confirm that the Microsoft 365 home page loads successfully.'],
    ] },

    { h1: '3 | Configure Microsoft Authenticator' },
    { p: ['SBS uses ', { b: 'Multi-Factor Authentication (MFA)' }, ' to provide additional protection for Microsoft 365 accounts. Microsoft Authenticator should be configured during your initial account setup.'] },
    { h2: 'Step 1 — Install Microsoft Authenticator' },
    { p: ['On your mobile device, open the ', { b: 'Apple App Store' }, ' or ', { b: 'Google Play Store' }, ', search for ', { b: 'Microsoft Authenticator' }, ', verify it is published by ', { b: 'Microsoft Corporation' }, ', and install it.'] },
    { h2: 'Step 2 — Begin MFA Registration' },
    { p: ['During your first Microsoft 365 login, Microsoft may display ', { b: 'More information required' }, '. Select ', { b: 'Next' }, ' to begin registration.'] },
    { h2: 'Step 3 — Add Your SBS Account' },
    { p: ['In Microsoft Authenticator select ', { b: '+ Add Account' }, ', then ', { b: 'Work or school account' }, ', then ', { b: 'Scan QR Code' }, '.'] },
    { h2: 'Step 4 — Scan the QR Code' },
    { ol: [['Scan the QR code shown on your computer.'], ['Return to your computer.'], ['Select ', { b: 'Next' }, '.']] },
    { note: { title: 'SBS SECURITY NOTICE', body: ['Never photograph, save, email, text, or share your MFA QR code.'] } },
    { h2: 'Step 5 — Verify Microsoft Authenticator' },
    { ol: [
      ['Open the Microsoft Authenticator notification on your mobile device.'],
      ['Enter the number displayed on your computer.'],
      ['Select ', { b: 'Approve' }, '.'],
      ['Return to your computer and complete the registration.'],
    ] },
    { p: ['Your SBS account is now protected with Multi-Factor Authentication.'] },

    { h1: '4 | Access SBS Outlook' },
    { h2: `${isGov ? 'GCC High ' : ''}Outlook Web Access` },
    { kv: [
      ['Address:', [{ link: env.outlook }]],
      ['Username:', [{ code: d.upn }]],
      ['Password:', [isTap ? 'Sign in with Microsoft Authenticator (or your password, once you have set one)' : 'Your current SBS Microsoft 365 password']],
    ] },
    { p: ['Approve the Microsoft Authenticator request when prompted.'] },
    ...(isGov ? [{ note: { title: 'GCC HIGH USERS', body: ['Use the GCC High Microsoft 365 and Outlook addresses above unless otherwise directed by SBS IT.'] } } as Block] : []),

    ...(d.cloudPcAssigned
      ? [
        { h1: '5 | Access Your SBS Windows 365 Cloud PC' },
        { p: ['A ', { b: 'Windows 365 Cloud PC' }, ' has been assigned to you. It can take a few hours after your account is created before it is ready.'] },
        { kv: [['Windows 365 Access Portal:', [{ link: CLOUD_PC_PORTAL }]]] },
        { h3: 'Connect to Your Cloud PC' },
        { ol: [
          ['Open Microsoft Edge or another supported browser.'],
          ['Navigate to ', { link: CLOUD_PC_PORTAL }, '.'],
          ['Enter your SBS Microsoft 365 username.'],
          ['Enter your password if requested.'],
          ['Complete Microsoft Authenticator verification.'],
          ['Locate ', { b: 'Your Cloud PCs' }, ' and select your assigned SBS Cloud PC.'],
          ['Select ', { b: 'Open in browser' }, '.'],
        ] },
        { p: ['Depending on your configuration, you may also connect using the ', { b: 'Windows App' }, '.'] },
        { h1: '6 | Cloud PC Initial Setup' },
        { ol: [
          ['Allow Windows to complete your user profile configuration.'],
          ['Verify Microsoft 365 applications are available.'],
          ['Launch ', { b: 'Microsoft Outlook' }, '.'],
          ['Launch ', { b: 'Microsoft Teams' }, ', if assigned.'],
          ['Verify ', { b: 'Microsoft OneDrive' }, ' is connected, if enabled.'],
          ['Allow SBS security and endpoint management policies to apply.'],
          ['Allow Microsoft Defender and other SBS security tools to complete initialization.'],
          ['Restart the Cloud PC if instructed.'],
        ] },
        { h3: 'Do Not' },
        { p: ['Do not disable, uninstall, or modify SBS-managed:'] },
        { ul: [['Microsoft Defender'], ['Endpoint security software'], ['Intune management'], ['Security policies'],
          ['VPN or connectivity software'], ['Compliance controls'], ['Device certificates'], ['Monitoring agents']] },
        { p: ['Contact SBS IT if a security application prevents you from performing an approved business function.'] },
      ] as Block[]
      : [
        { h1: '5 | Windows 365 Cloud PC' },
        { p: ['No Windows 365 Cloud PC has been assigned to this account. Contact SBS IT if you believe you need one.'] },
      ] as Block[]),

    { h1: `${d.cloudPcAssigned ? '7' : '6'} | MFA & Account Security` },
    { p: ['Only approve a Microsoft Authenticator notification when ', { b: 'you initiated the login' }, '. If an unexpected request appears, select ', { b: 'DENY' }, ' and contact the SBS IT Service Desk.'] },
    { p: ['Never provide another person with:'] },
    { ul: [['Your SBS password'], ['MFA verification codes'], ['Microsoft Authenticator approval numbers'], ['Registration QR codes'],
      ['Temporary Access Passes'], ['Password reset codes'], ['Recovery codes']] },
    { p: [{ b: 'SBS IT will never ask you to disclose your password.' }] },

    { h1: `${d.cloudPcAssigned ? '8' : '7'} | Quick Access` },
    { table: { head: ['SBS Service', env.label.replace('Microsoft 365 ', '')], rows: [
      ['Microsoft 365', env.portal],
      ['Outlook', env.outlook],
      ...(d.cloudPcAssigned ? [['Windows 365 Cloud PC', CLOUD_PC_PORTAL]] : []),
      ['MFA', 'Microsoft Authenticator'],
    ] } },

    { h1: `${d.cloudPcAssigned ? '9' : '8'} | SBS IT Support` },
    { p: ['If you experience problems with your account, contact the ', { b: 'SBS IT Service Desk' }, '.'] },
    { kv: [
      ...(hd.email ? [['Email:', [{ link: `mailto:${hd.email}` }]] as [string, Inline[]]] : []),
      ...(hd.phone ? [['Phone:', [hd.phone]] as [string, Inline[]]] : []),
      ...(hd.portal ? [['Support Portal:', [{ link: hd.portal }]] as [string, Inline[]]] : []),
      ...(hd.hours ? [['Support Hours:', [hd.hours]] as [string, Inline[]]] : []),
    ] },
    { p: ['When contacting SBS IT, provide your full name, your SBS username, the device name if applicable, a description of the issue, and a screenshot of the error when appropriate.'] },
    { note: { title: 'Never Include', body: ['Do not send your password, MFA verification code, Temporary Access Pass, or authentication QR code in a support ticket, email, Teams message, or screenshot.'] } },

    { h1: `${d.cloudPcAssigned ? '10' : '9'} | New User Setup Verification` },
    { h3: 'Account' },
    { ul: [
      ['☐ Initial Microsoft 365 login completed'],
      ...(isTap ? [] : [['☐ Temporary password changed'] as Inline[]]),
      ['☐ Microsoft Authenticator configured'],
      ['☐ MFA verification successfully tested'],
    ] },
    { h3: 'Microsoft 365' },
    { ul: [['☐ Microsoft 365 portal accessible'], ['☐ Outlook accessible'], ['☐ Outlook test email sent and received'],
      ['☐ Teams accessible, if assigned'], ['☐ OneDrive accessible, if assigned']] },
    { h3: 'Windows 365' },
    { ul: d.cloudPcAssigned
      ? [['☒ Cloud PC assigned'], ['☐ Cloud PC accessible'], ['☐ Outlook verified from Cloud PC'], ['☐ Teams verified from Cloud PC'], ['☐ Security policies successfully applied']]
      : [['☒ Cloud PC not applicable']] },

    { h1: 'SBS User Information' },
    { kv: [
      ['Employee Name:', [d.fullName]],
      ['Username:', [d.upn]],
      ['Department / Program:', [dept]],
      ['Environment:', [`${box(!isGov)} Microsoft 365 Commercial  ${box(isGov)} Microsoft 365 GCC High`]],
      ['Cloud PC:', [d.cloudPcAssigned
        ? `${box(!isGov)} Commercial  ${box(isGov)} Government / GCC High  ☐ Not Assigned`
        : '☐ Commercial  ☐ Government / GCC High  ☒ Not Assigned']],
      ['Authenticator Configured:', ['☐ Yes']],
      ['Outlook Verified:', ['☐ Yes']],
      ['Cloud PC Verified:', [d.cloudPcAssigned ? '☐ Yes  ☐ N/A' : '☒ N/A']],
      ['Setup Completed:', ['____________________']],
      ['Technician:', ['____________________']],
    ] },
    { hr: true },
    { p: [{ b: 'STRATEGIC BUSINESS SYSTEMS' }] },
    { p: ['Microsoft 365 User Onboarding | SBS Information Technology — Internal Use'] },
  ];

  const header = '<div style="background:#0f2a4a;color:#fff;padding:18px 22px;">'
    + '<div style="font-size:12px;letter-spacing:2px;">STRATEGIC BUSINESS SYSTEMS</div>'
    + '<div style="font-size:20px;font-weight:bold;margin-top:4px;">Microsoft 365 New User Onboarding Guide</div>'
    + '<div style="font-size:13px;margin-top:2px;opacity:.85;">SBS Information Technology</div></div>';
  // Declared explicitly: without it a client (or a browser opening a saved copy) may guess
  // Windows-1252 and turn ☐ ☒ — into mojibake like "â˜".
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>'
    + '<body style="margin:0;background:#f4f6f8;">'
    + '<div style="max-width:720px;margin:0 auto;background:#fff;font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2933;">'
    + header
    + `<div style="padding:8px 22px 24px;">${blocksHtml(blocks)}</div></div></body></html>`;
  const text = [
    'STRATEGIC BUSINESS SYSTEMS',
    'Microsoft 365 New User Onboarding Guide — SBS Information Technology',
    '',
    blocksText(blocks),
  ].join('\n');

  return { subject: `SBS Microsoft 365 Onboarding Guide — ${d.fullName} (${d.upn})`, html, text };
}
