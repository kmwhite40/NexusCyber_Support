// Notification adapter contract (docs/nexus/06 §K.5). The router calls this
// interface; the concrete implementation (Graph vs console) is chosen at runtime
// from config + the per-cloud capability matrix.

export interface EmailEnvelope {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
}

export interface TeamsEnvelope {
  summary: string;
  text: string;
}

export interface DeliveryResult {
  status: 'sent' | 'failed';
  providerMessageId?: string;
  error?: string;
}

export interface AdapterCapabilities {
  email: boolean;
  teams: boolean;
}

export interface NotificationAdapter {
  name: string;
  capabilities: () => AdapterCapabilities;
  sendEmail: (env: EmailEnvelope) => Promise<DeliveryResult>;
  sendTeams: (env: TeamsEnvelope) => Promise<DeliveryResult>;
}
