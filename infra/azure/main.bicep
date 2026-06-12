// Nexus — compact Azure deployment starting point (Container Apps + Postgres Flexible
// Server + Log Analytics). A production deployment layers on Front Door/WAF, Private
// Endpoints, Managed Identity + Key Vault, and (for gov) deploys the SAME images into a
// separate Azure Government subscription. See docs/nexus/10-stack-ux-ops.md (Section V)
// and docs/nexus/artifacts/deploy/README.md.

@description('Deployment location.')
param location string = resourceGroup().location

@description('Short name prefix for resources.')
param name string = 'nexus'

@description('Enclave selector passed to the API: commercial | gov')
@allowed(['commercial', 'gov'])
param enclave string = 'commercial'

@description('Container image refs (push to ACR/registry first).')
param apiImage string
param webImage string

@description('Postgres admin password.')
@secure()
param pgAdminPassword string

@description('Runtime app DB role password (non-owner; RLS enforced).')
@secure()
param appDbPassword string

@description('Session signing key (dev JWT). Replace with Key Vault-backed secret + OIDC in prod.')
@secure()
param sessionSigningKey string

var pgAdmin = 'nexus'
var dbName = 'nexus'

// ---------- Observability ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

// ---------- PostgreSQL Flexible Server ----------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${name}-pg'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: pgAdmin
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' } // enable ZoneRedundant for prod HA
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pg
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// ---------- Container Apps environment ----------
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var adminDbUrl = 'postgres://${pgAdmin}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'
var appDbUrl = 'postgres://nexus_app:${appDbPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

// ---------- API ----------
resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${name}-api'
  location: location
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: { external: true, targetPort: 4000, transport: 'auto' }
      secrets: [
        { name: 'admin-db-url', value: adminDbUrl }
        { name: 'app-db-url', value: appDbUrl }
        { name: 'session-key', value: sessionSigningKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'API_PORT', value: '4000' }
            { name: 'ENCLAVE', value: enclave }
            { name: 'DATABASE_URL', secretRef: 'admin-db-url' }
            { name: 'APP_DATABASE_URL', secretRef: 'app-db-url' }
            { name: 'SESSION_SIGNING_KEY', secretRef: 'session-key' }
            { name: 'WEB_ORIGIN', value: 'https://${name}-web.${cae.properties.defaultDomain}' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 4000 }, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 4000 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 5 }
    }
  }
}

// ---------- Web ----------
resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${name}-web'
  location: location
  properties: {
    managedEnvironmentId: cae.id
    configuration: { ingress: { external: true, targetPort: 3000, transport: 'auto' } }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 5 }
    }
  }
}

output apiUrl string = 'https://${apiApp.properties.configuration.ingress.fqdn}'
output webUrl string = 'https://${webApp.properties.configuration.ingress.fqdn}'
