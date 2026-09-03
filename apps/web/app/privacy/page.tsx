import * as React from 'react';
import type { Metadata } from 'next';
import { LegalShell, LegalSection } from '@/components/legal-shell';

export const metadata: Metadata = {
  title: 'Privacy Policy — Anchor',
  description: 'How Anchor collects, uses, and protects information.',
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="June 12, 2026">
      <p>
        This Privacy Policy explains how Anchor (the &ldquo;Service&rdquo;), operated by
        NexusCyber as part of Strategic Business Systems, Inc. (&ldquo;we,&rdquo; &ldquo;us,&rdquo;
        &ldquo;our&rdquo;), handles information when you use the platform. Anchor is primarily a
        business-to-business service: most data is processed on behalf of the organization
        (&ldquo;Customer&rdquo;) that provides you access, under that Customer&rsquo;s agreement
        and instructions.
      </p>

      <LegalSection heading="1. Information we process">
        <ul>
          <li>
            <strong>Account and identity:</strong> name, email/UPN, organization, role
            assignments, and identifiers from your sign-in provider (e.g., Microsoft Entra ID
            object and tenant ids) used to authenticate you and apply permissions.
          </li>
          <li>
            <strong>Service content:</strong> tickets, comments, attachments, knowledge-base
            entries, on-call schedules, posture findings, and related records you or your
            organization create.
          </li>
          <li>
            <strong>Usage and security telemetry:</strong> log data, audit events, IP address,
            timestamps, and diagnostic information used to operate, secure, and improve the
            Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="2. How we use information">
        <p>We use information to:</p>
        <ul>
          <li>provide, maintain, and secure the Service and authenticate users;</li>
          <li>enforce role-based and attribute-based access and tenant isolation;</li>
          <li>generate analytics, reporting, and compliance and audit records;</li>
          <li>detect, investigate, and prevent security incidents and abuse; and</li>
          <li>meet legal, regulatory, and contractual obligations.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="3. Data isolation and security">
        <p>
          Anchor enforces multi-tenant isolation so each organization&rsquo;s data is segregated
          (including database row-level security keyed to the organization). We use encryption in
          transit and at rest, least-privilege access, and hash-chained audit logging. No method
          of transmission or storage is perfectly secure, but we maintain safeguards designed to
          protect information appropriate to its sensitivity and the operating environment.
        </p>
      </LegalSection>

      <LegalSection heading="4. Government cloud and data residency">
        <p>
          When the Service is delivered in a U.S. Government cloud (e.g., GCC High or Azure
          Government), data is processed and stored within that enclave&rsquo;s boundary and
          subject to its controls. Identity federation for U.S. Government environments uses the
          U.S. Government Microsoft endpoints. Available regions and residency depend on the
          Customer&rsquo;s selected environment.
        </p>
      </LegalSection>

      <LegalSection heading="5. Sharing and subprocessors">
        <p>
          We do not sell personal information. We share information with infrastructure and
          service subprocessors (such as cloud hosting and identity providers) strictly to
          operate the Service, under contractual confidentiality and security obligations, and as
          required by law or to protect rights and safety.
        </p>
      </LegalSection>

      <LegalSection heading="6. Retention">
        <p>
          We retain information for as long as needed to provide the Service, comply with legal
          and audit obligations, resolve disputes, and enforce agreements. Customer Data is
          retained and deleted in accordance with the Customer&rsquo;s configuration and
          agreement.
        </p>
      </LegalSection>

      <LegalSection heading="7. Cookies and sessions">
        <p>
          Anchor uses strictly necessary cookies and browser storage to maintain authenticated
          sessions and security. We do not use the Service for advertising or cross-site tracking.
        </p>
      </LegalSection>

      <LegalSection heading="8. Your choices and rights">
        <p>
          Because Anchor processes most data on behalf of Customers, requests to access, correct,
          or delete data are generally handled through your organization&rsquo;s administrator. If
          you have rights under applicable privacy laws, we will support Customers in honoring
          valid requests consistent with our agreements and legal obligations.
        </p>
      </LegalSection>

      <LegalSection heading="9. Changes to this Policy">
        <p>
          We may update this Policy from time to time. Material changes will be reflected by
          updating the &ldquo;Last updated&rdquo; date and, where appropriate, by notice through
          the Service.
        </p>
      </LegalSection>

      <LegalSection heading="10. Contact">
        <p>
          Privacy questions may be directed to your Anchor administrator or to Strategic Business
          Systems, Inc.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
