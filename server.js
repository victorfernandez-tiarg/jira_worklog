require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const authRouter = require('./routes/auth');
const worklogRouter = require('./routes/worklogs');
const mappingRouter = require('./routes/mapping');
const personasRouter = require('./routes/personas');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8hs
}));

// ── Rutas ──
app.use('/auth', authRouter);
app.use('/api/worklogs', worklogRouter);
app.use('/api/mapping', mappingRouter);
app.use('/api/personas', personasRouter);

// Salud
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

// Fallback → SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Jira Worklog Dashboard corriendo en http://localhost:${PORT} (v2)\n`);
});
