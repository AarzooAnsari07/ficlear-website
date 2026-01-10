require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Serve static files from parent directory
app.use(express.static(path.join(__dirname, '..')));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST || 'db.vhdwwhnmxbdqpsonhjhy.supabase.co',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT,10) : 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || undefined,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000
});

// Simple API key check to avoid open access. Set API_KEY in .env
function requireApiKey(req, res, next){
  const key = process.env.API_KEY;
  if(!key) return res.status(500).json({ error: 'Server not configured with API_KEY' });
  const sent = req.get('x-api-key') || req.query.api_key;
  if(!sent || sent !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Admin credentials (in production, use database)
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  // Validate credentials
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    // Store user info in session
    req.session.user = {
      id: 1,
      username: username,
      role: 'admin'
    };
    return res.json({ success: true, message: 'Login successful' });
  }
  
  return res.status(401).json({ success: false, error: 'Invalid username or password' });
});

// Check authentication status
app.get('/api/check-auth', (req, res) => {
  if (req.session.user) {
    return res.json({ 
      authenticated: true, 
      username: req.session.user.username,
      role: req.session.user.role 
    });
  }
  return res.json({ authenticated: false });
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    return res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Basic company search endpoint. Query param: q (company name or CIN). Optional: limit
app.get('/api/company', requireApiKey, async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(50, parseInt(req.query.limit || '5', 10));
  if(!q) return res.status(400).json({ error: 'Missing query parameter `q`' });
  let client;
  try{
    client = await pool.connect();
  }catch(connErr){
    console.error('DB connect error', connErr && connErr.message ? connErr.message : connErr);
    return res.status(502).json({ error: 'Unable to connect to database', details: connErr && connErr.code ? connErr.code : 'connect_error' });
  }

  try{
    // Attempt to match by CIN exactly OR name LIKE search
    const sql = `
      SELECT * FROM companies
      WHERE (lower(name) LIKE $1 OR lower(company_name) LIKE $1)
      OR (cin = $2)
      LIMIT $3
    `;
    const like = '%' + q.toLowerCase() + '%';
    const candCin = q.toUpperCase();
    const result = await client.query(sql, [like, candCin, limit]);
    return res.json({ count: result.rowCount, records: result.rows });
  }catch(err){
    console.error('DB query error', err);
    return res.status(500).json({ error: 'DB query failed' });
  }finally{
    try{ if(client) client.release(); }catch(e){}
  }
});

app.get('/health', (req,res)=> res.json({ok:true}));
// Accept contact form submissions. Tries to persist to `contacts` table if available,
// otherwise logs the submission and returns success. CORS is enabled for the static site.
app.post('/api/contact', async (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields: name, email, message' });

  // Try to insert into DB if possible; fall back to logging when DB/table is not available.
  let client;
  try {
    client = await pool.connect();
    try {
      const insertSql = `INSERT INTO contacts (name, email, phone, subject, message, created_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`;
      const result = await client.query(insertSql, [name, email, phone || null, subject || null, message]);
      const id = result && result.rows && result.rows[0] && result.rows[0].id;
      return res.status(201).json({ ok: true, stored: true, id });
    } catch (dbErr) {
      console.warn('Contact insert failed (table may be missing). Falling back to logging.', dbErr && dbErr.message ? dbErr.message : dbErr);
      // release client and continue to fallback
      try { client.release(); } catch (e) {}
      console.log('Contact submission:', { name, email, phone, subject, message });
      return res.status(201).json({ ok: true, stored: false });
    }
  } catch (connErr) {
    console.warn('DB connection failed for contact endpoint; logging submission.', connErr && connErr.message ? connErr.message : connErr);
    console.log('Contact submission:', { name, email, phone, subject, message });
    return res.status(201).json({ ok: true, stored: false });
  } finally {
    try { if (client) client.release(); } catch (e) {}
  }
});

app.listen(PORT, ()=>{
  console.log('Server listening on', PORT);
});
