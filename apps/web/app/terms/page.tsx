import * as React from 'react';
import type { Metadata } from 'next';
import { LegalShell, LegalSection } from '@/components/legal-shell';

export const metadata: Metadata = {
  title: 'Terms of Service — Anchor',
  description: 'The terms governing use of the Anchor service desk and security-posture platform.',
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="June 12, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of the Anchor
        platform (&ldquo;Anchor,&rdquo; the &ldquo;Service&rdquo;), an IT service management,
        on-call, and security-posture platform operated by NexusCyber as part of Strategic
        Business Systems, Inc. (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;). By
        accessing the Service, signing in, or using any feature, you agree to these Terms on
        behalf of yourself and, where applicable, the organization you represent
        (&ldquo;Customer&rdquo;).
      </p>

      <LegalSection heading="1. The Service">
        <p>
          Anchor provides ticketing and workflows (provisioning, deprovisioning, password and
          access support, group and license management, remote support), continuous monitoring
          (ConMon), on-call scheduling, analytics, and compliance and audit tooling. We may add,
          change, or remove features over time. Anchor is offered in commercial and U.S.
          Government cloud environments (Commercial, GCC, GCC High, and Azure Government);
          available features and data-handling commitments may differ by environment.
        </p>
      </LegalSection>

      <LegalSection heading="2. Accounts and access">
        <p>
          Access requires authentication. Anchor staff (agents) and Customer users may sign in
          through Microsoft Entra ID single sign-on or other supported methods. You are
          responsible for safeguarding credentials, for activity under your account, and for
          ensuring that only authorized individuals access the Service on your behalf. Access is
          governed by role-based and attribute-based permissions; you must not attempt to access
          data or functions outside your authorization.
        </p>
      </LegalSection>

      <LegalSection heading="3. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use the Service unlawfully or in violation of applicable regulations or contracts;</li>
          <li>attempt to bypass authentication, tenant isolation, or access controls;</li>
          <li>probe, scan, or test the vulnerability of the Service without written authorization;</li>
          <li>disrupt or degrade the Service, or introduce malicious code; or</li>
          <li>upload data you are not permitted to process, or that violates third-party rights.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. Customer data and confidentiality">
        <p>
          As between the parties, Customer retains all rights to data submitted to the Service
          (&ldquo;Customer Data&rdquo;). We process Customer Data to provide and secure the
          Service and as described in the <a href="/privacy">Privacy Policy</a>. We maintain
          administrative, technical, and physical safeguards designed to protect Customer Data,
          including multi-tenant isolation, encryption in transit and at rest, and audit logging.
          Each party will protect the other&rsquo;s confidential information using no less than
          reasonable care.
        </p>
      </LegalSection>

      <LegalSection heading="5. Government and compliance environments">
        <p>
          Where the Service is delivered in a U.S. Government cloud, data residency and handling
          follow the applicable enclave (e.g., Azure Government). Customers are responsible for
          determining whether the selected environment meets their regulatory obligations (such
          as FedRAMP, CMMC, ITAR, or agency-specific requirements) and for configuring the
          Service accordingly.
        </p>
      </LegalSection>

      <LegalSection heading="6. Service availability">
        <p>
          We aim to provide a reliable Service but do not guarantee uninterrupted availability.
          Specific availability and support commitments, if any, are set out in an applicable
          order, statement of work, or service-level agreement. We may perform maintenance and
          will use reasonable efforts to limit disruption.
        </p>
      </LegalSection>

      <LegalSection heading="7. Intellectual property">
        <p>
          The Service, including its software, design, and content (excluding Customer Data), is
          owned by us or our licensors and is protected by intellectual-property laws. We grant a
          limited, non-exclusive, non-transferable right to use the Service during your
          subscription, solely as permitted by these Terms.
        </p>
      </LegalSection>

      <LegalSection heading="8. Suspension and termination">
        <p>
          We may suspend or terminate access for material breach of these Terms, for security or
          legal reasons, or as set out in an applicable order. Upon termination, your right to use
          the Service ends; provisions that by their nature should survive (including
          confidentiality, IP, disclaimers, and limitations of liability) will survive.
        </p>
      </LegalSection>

      <LegalSection heading="9. Disclaimers and limitation of liability">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; to the
          fullest extent permitted by law, without warranties of any kind, express or implied. To
          the maximum extent permitted by law, we will not be liable for indirect, incidental,
          special, consequential, or punitive damages, or for lost profits or data. Nothing in
          these Terms limits liability that cannot be limited under applicable law.
        </p>
      </LegalSection>

      <LegalSection heading="10. Changes to these Terms">
        <p>
          We may update these Terms from time to time. Material changes will be reflected by
          updating the &ldquo;Last updated&rdquo; date and, where appropriate, by notice through
          the Service. Continued use after changes take effect constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection heading="11. Contact">
        <p>
          Questions about these Terms may be directed to your Anchor administrator or to Strategic
          Business Systems, Inc.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
