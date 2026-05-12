const express = require('express');
const axios = require('axios');
const router = express.Router();

const AUTH_MODE = process.env.AUTH_MODE || 'token';

// ─── Helper: cliente Jira autenticado ──────────────────────────────────────
function buildJiraClient(req) {
  if (AUTH_MODE === 'oauth' && req.session.accessToken) {
    return axios.create({
      baseURL: `https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3`,
      headers: {
        Authorization: `Bearer ${req.session.accessToken}`,
        Accept: 'application/json'
      }
    });
  }
  // API Token (Basic Auth)
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return axios.create({
    baseURL: `${process.env.JIRA_BASE_URL}/rest/api/3`,
    headers: {
      Authorization: `Basic ${token}`,
      Accept: 'application/json'
    }
  });
}

// ─── GET /auth/status ──────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  if (AUTH_MODE === 'token') {
    const configured = !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_BASE_URL);
    return res.json({ authenticated: configured, mode: 'token' });
  }
  return res.json({
    authenticated: !!req.session.accessToken,
    mode: 'oauth',
    user: req.session.jiraUser || null
  });
});

// ─── OAuth 2.0 ─────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (AUTH_MODE !== 'oauth') {
    return res.json({ message: 'Modo token: no se requiere login OAuth.' });
  }
  const scopes = [
    'read:jira-work',
    'read:jira-user',
    'offline_access'
  ].join('%20');
  const url = `https://auth.atlassian.com/authorize` +
    `?audience=api.atlassian.com` +
    `&client_id=${process.env.JIRA_OAUTH_CLIENT_ID}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(process.env.JIRA_OAUTH_REDIRECT_URI)}` +
    `&state=jira-dashboard` +
    `&response_type=code` +
    `&prompt=consent`;
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    // Intercambiar código por tokens
    const tokenRes = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: process.env.JIRA_OAUTH_CLIENT_ID,
      client_secret: process.env.JIRA_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: process.env.JIRA_OAUTH_REDIRECT_URI
    });

    req.session.accessToken = tokenRes.data.access_token;
    req.session.refreshToken = tokenRes.data.refresh_token;

    // Obtener cloudId
    const resourcesRes = await axios.get('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });
    req.session.cloudId = resourcesRes.data[0].id;

    // Datos del usuario
    const meRes = await axios.get(`https://api.atlassian.com/ex/jira/${req.session.cloudId}/rest/api/3/myself`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });
    req.session.jiraUser = { displayName: meRes.data.displayName, email: meRes.data.emailAddress };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('Error durante la autenticación OAuth.');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Middleware exportable para proteger rutas
function requireAuth(req, res, next) {
  if (AUTH_MODE === 'token') {
    if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      return res.status(401).json({ error: 'Configurá JIRA_EMAIL y JIRA_API_TOKEN en el archivo .env' });
    }
    return next();
  }
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'No autenticado. Visitá /auth/login' });
  }
  next();
}

module.exports = router;
module.exports.buildJiraClient = buildJiraClient;
module.exports.requireAuth = requireAuth;
