// Shared domain types for the API.

export type Plane = 'nexus' | 'customer';

export interface Principal {
  id: string;
  plane: Plane;
  email: string;
  displayName: string | null;
  organizationId: string | null; // customer plane: their org
  roles: string[]; // role keys
  permissions: string[]; // resolved permission verbs
  assignedOrgs: string[]; // nexus plane scope
  elevated: boolean;
}

export interface SessionClaims {
  sub: string;
  plane: Plane;
  email: string;
  org: string | null;
  roles: string[];
  iat?: number;
  exp?: number;
}
