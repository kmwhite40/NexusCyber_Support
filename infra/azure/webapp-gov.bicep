// Anchor — Azure GOVERNMENT (Azure US Gov) deployment using App Service / Web App for
// Containers, for a GCC/.us environment. Provisions: ACR, Key Vault, Postgres Flexible
// Server, Log Analytics, a Linux App Service plan, and two container Web Apps (api, web)
// with system-assigned managed identities (AcrPull + Key Vault Secrets User).
//
// Deploy into an Azure Government subscription only:
//   az cloud set --name AzureUSGovernment
//   az deployment group create -g <rg> -f infra/azure/webapp-gov.bicep -p @infra/azure/parameters.gov.json
//
// Hostnames are *.azurewebsites.us, ACR is *.azurecr.us, Key Vault is *.vault.usgovcloudapi.net.
// Built-in role definition GUIDs are identical across clouds.

targetScope = 'resourceGroup'

@description('Azure Government region (e.g. usgovvirginia, usgovtexas, usgovarizona).')
param location string = resourceGroup().location

@description('Resource name prefix.')
param name string = 'anchor'

@description('Container image tag to run (built into ACR by deploy-gov.sh).')
param imageTag string = 'latest'

@description('Postgres admin password.')
@secure()
param pgAdminPassword string

@description('Runtime app DB role password (non-owner; RLS enforced). Matches migration 0001 role nexus_app.')
@secure()
param appDbPassword string

@description('Session signing key (dev JWT). For production, front with real OIDC; this stays in Key Vault.')
@secure()
param sessionSigningKey string

@description('App Service plan SKU.')
param planSku string = 'P1v3'

var pgAdmin = 'nexus'
var dbName = 'nexus'
var acrName = toLower(replace('${name}acr${uniqueString(resourceGroup().id)}', '-', ''))
var kvName = take(toLower('${name}kv${uniqueString(resourceGroup().id)}'), 24)
var apiName = '${name}-api'
var webName = '${name}-web'
// Azure Government public hostname suffix.
var govSiteSuffix = 'azurewebsites.us'
var apiUrl = 'https://${apiName}.${govSiteSuffix}'
var webUrl = 'https://${webName}.${govSiteSuffix}'

// Built-in roles (cloud-agnostic GUIDs).
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKvSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------- Observability ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

// ---------- Container registry (gov: *.azurecr.us) ----------
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Standard' }
  properties: {
    adminUserEnabled: false // pull via managed identity, not admin creds
  }
}

// ---------- Key Vault (gov: *.vault.usgovcloudapi.net) ----------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled' // tighten to Private Endpoint for production
  }
}

resource secretSession 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'session-signing-key'
  properties: { value: sessionSigningKey }
}
resource secretAdminDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'admin-db-url'
  properties: { value: 'postgres://${pgAdmin}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require' }
}
resource secretAppDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'app-db-url'
  properties: { value: 'postgres://nexus_app:${appDbPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require' }
}

// ---------- PostgreSQL Flexible Server ----------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${name}-pg'
  location: location
  sku: { name: 'Standard_B2s', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: pgAdmin
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' } // ZoneRedundant for production HA
  }
}
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pg
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
// Allow other Azure services (App Service, the migrate job) to reach Postgres.
// Production: replace with VNet integration + Private Endpoint and remove this rule.
resource pgFwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------- App Service plan (Linux) ----------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${name}-plan'
  location: location
  sku: { name: planSku }
  kind: 'linux'
  properties: { reserved: true } // Linux
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
        { name: 'WEB_ORIGIN', value: webUrl }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(SecretUri=${secretAdminDb.properties.secretUri})' }
        { name: 'APP_DATABASE_URL', value: '@Microsoft.KeyVault(SecretUri=${secretAppDb.properties.secretUri})' }
        { name: 'SESSION_SIGNING_KEY', value: '@Microsoft.KeyVault(SecretUri=${secretSession.properties.secretUri})' }
        // Microsoft 365 — Government endpoints (validate per tenant before enabling).
        { name: 'M365_ENABLED', value: 'false' }
        { name: 'M365_CLOUD', value: 'gcchigh' }
      ]
    }
  }
}

// ---------- Web (Next.js) Web App (container) ----------
resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/anchor-web:${imageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      healthCheckPath: '/'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '3000' }
        { name: 'NODE_ENV', value: 'production' }
        // NEXT_PUBLIC_API_BASE is baked into the web image at build time
        // (deploy-gov.sh passes --build-arg NEXT_PUBLIC_API_BASE=<apiUrl>/api/v1).
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
resource webAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, web.id, roleAcrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
    principalId: web.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource apiKvUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, api.id, roleKvSecretsUser)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsUser)
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
output webUrl string = webUrl
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output keyVaultName string = kv.name
