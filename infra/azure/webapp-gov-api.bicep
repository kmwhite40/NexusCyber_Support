// Anchor — Azure GOVERNMENT API-only deployment (Azure US Gov, GCC/.us).
//
// Trimmed variant of webapp-gov.bicep for when the WEB tier is already deployed
// separately (e.g. as a Code/Node App Service named "Anchor"). Provisions only the
// backend: ACR, PostgreSQL Flexible Server, Log Analytics, a Linux App Service plan,
// and ONE container Web App (the API) with a system-assigned managed identity (AcrPull).
// Economical SKUs by default.
//
// NOTE: This subscription enforces NIST SP 800-53 Rev. 5 Azure Policy, which DENIES a
// Key Vault unless it has purge protection AND a locked-down firewall (no public access).
// A locked-down KV can't serve App Service Key Vault references without VNet integration
// + a private endpoint. To keep this deploy self-contained, secrets are set as App Service
// app settings (encrypted at rest) instead of KV references. HARDENING FOLLOW-UP: add a
// VNet + private-endpoint Key Vault and switch these back to @Microsoft.KeyVault(...) refs.
//
//   az cloud set --name AzureUSGovernment
//   az deployment group create -g <rg> -f infra/azure/webapp-gov-api.bicep \
//     -p name=anchor pgAdminPassword=... appDbPassword=... sessionSigningKey=... \
//        webOrigin=https://anchor.azurewebsites.us

targetScope = 'resourceGroup'

@description('Azure Government region (e.g. usgovvirginia).')
param location string = resourceGroup().location

@description('Resource name prefix.')
param name string = 'anchor'

@description('Container image tag to run (built into ACR by the deploy script).')
param imageTag string = 'latest'

@secure()
param pgAdminPassword string

@description('Runtime app DB role password (non-owner; RLS enforced). The migrate step ALTERs nexus_app to this value.')
@secure()
param appDbPassword string

@secure()
param sessionSigningKey string

@description('App Service plan SKU. B1 is the cheapest tier that supports alwaysOn + containers.')
param planSku string = 'B1'

@description('Public origin of the already-deployed web app, for CORS.')
param webOrigin string = 'https://anchor.azurewebsites.us'

@description('Enable Entra ID (Azure Gov) OIDC for the agent plane.')
param oidcEnabled bool = false

@description('Entra tenant id for agent OIDC (defaults to the M365 tenant if blank).')
param oidcTenantId string = ''

@description('Entra app (client) id for agent OIDC.')
param oidcClientId string = ''

@description('Entra client secret for agent OIDC (use a cert/Key Vault ref in production).')
@secure()
param oidcClientSecret string = ''

@description('Comma-separated app roles allowed to sign in / self-provision (e.g. Anchor.Tier2,Anchor.SecurityAnalyst).')
param oidcAllowedAppRoles string = ''

var pgAdmin = 'nexus'
var dbName = 'nexus'
var acrName = toLower(replace('${name}acr${uniqueString(resourceGroup().id)}', '-', ''))
var apiName = '${name}-api'
var govSiteSuffix = 'azurewebsites.us'
var apiUrl = 'https://${apiName}.${govSiteSuffix}'

var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var adminDbUrl = 'postgres://${pgAdmin}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'
var appDbUrl = 'postgres://nexus_app:${appDbPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

// ---------- Observability ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------- Container registry (gov: *.azurecr.us) ----------
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false // pull via managed identity; admin toggled briefly only for the one-off migrate ACI
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
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pg
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
// Azure PG allow-lists extensions; migration 0001 needs pgcrypto + citext.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: pg
  name: 'azure.extensions'
  properties: { value: 'PGCRYPTO,CITEXT', source: 'user-override' }
}
resource pgFwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------- App Service plan (Linux) ----------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${name}-api-plan'
  location: location
  sku: { name: planSku }
  kind: 'linux'
  properties: { reserved: true }
}

// ---------- API Web App (container) ----------
resource api 'Microsoft.Web/sites@2023-12-01' = {
  name: apiName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/anchor-api:${imageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      healthCheckPath: '/healthz'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '4000' }
        { name: 'API_PORT', value: '4000' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'ENCLAVE', value: 'gov' }
        { name: 'WEB_ORIGIN', value: webOrigin }
        { name: 'DATABASE_URL', value: adminDbUrl }
        { name: 'APP_DATABASE_URL', value: appDbUrl }
        { name: 'SESSION_SIGNING_KEY', value: sessionSigningKey }
        { name: 'M365_ENABLED', value: 'false' }
        { name: 'M365_CLOUD', value: 'gcchigh' }
        // Entra OIDC (agent plane) — disabled until an app registration is wired.
        { name: 'OIDC_ENABLED', value: string(oidcEnabled) }
        { name: 'OIDC_TENANT_ID', value: oidcTenantId }
        { name: 'OIDC_CLIENT_ID', value: oidcClientId }
        { name: 'OIDC_CLIENT_SECRET', value: oidcClientSecret }
        { name: 'OIDC_REDIRECT_URI', value: '${apiUrl}/api/v1/auth/oidc/callback' }
        { name: 'OIDC_POST_LOGIN_REDIRECT', value: '${webOrigin}/auth/callback' }
        { name: 'OIDC_ALLOWED_APP_ROLES', value: oidcAllowedAppRoles }
      ]
    }
  }
}

// ---------- Role assignments (managed identity) ----------
resource apiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, api.id, roleAcrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
    principalId: api.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Diagnostics ----------
resource apiDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-logs'
  scope: api
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output acrLoginServer string = acr.properties.loginServer
output apiUrl string = apiUrl
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
