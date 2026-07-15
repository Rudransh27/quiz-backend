// src/utils/msalClient.js
// Single ConfidentialClientApplication instance for Microsoft Entra ID (Azure
// AD) SSO — used by the /api/auth/microsoft and /api/auth/microsoft/callback
// routes in authRoutes.js. Uses @azure/msal-node (Microsoft's actively
// maintained library) rather than the deprecated passport-azure-ad.
const { ConfidentialClientApplication } = require('@azure/msal-node');

const msalClient = new ConfidentialClientApplication({
    auth: {
        clientId: process.env.MICROSOFT_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    },
});

const MICROSOFT_SCOPES = ['openid', 'profile', 'email', 'User.Read'];

const getMicrosoftRedirectUri = () => `${process.env.SERVER_URL}/api/auth/microsoft/callback`;

module.exports = { msalClient, MICROSOFT_SCOPES, getMicrosoftRedirectUri };
