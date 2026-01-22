require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { exec, spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { extractCibilData, extractCibilScore, extractCreditAccounts } = require('./cibil-extractor');
const { calculateEligibility } = require('./eligibility-engine');
const { analyzeCibilWithAI, calculateAIEligibility, getAIInsights } = require('./ai-analyzer');
const bankPolicies = require('./bank-policies.json');

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

// Redirect /index.html to /
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

// Rewrite URLs to serve .html files without extension
app.use((req, res, next) => {
  // Skip if it's an API route, has a file extension, or is root
  if (req.path.startsWith('/api/') || req.path.includes('.') || req.path === '/') {
    return next();
  }
  
  // Try serving the .html file
  const filePath = path.join(__dirname, '..', req.path + '.html');
  
  // Check if file exists
  const fs = require('fs');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  
  next();
});

const PORT = process.env.PORT || 3000;

// Multer for file uploads (memory storage to avoid saving files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'));
    }
  }
});

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

// ============ CIBIL PARSING LOGIC ============

// Helper function to decrypt PDF using Python (as fallback)
const decryptPdfWithPython = async (pdfBuffer, password) => {
  return new Promise((resolve, reject) => {
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `input_${Date.now()}.pdf`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.pdf`);

    try {
      // Write input PDF to temp file
      fs.writeFileSync(inputPath, pdfBuffer);

      // Run Python decryption script using execSync for synchronous execution
      const pythonScript = path.join(__dirname, 'decrypt_pdf.py');
      const pythonExe = "C:/Users/aarzo/Downloads/New VS CODE/.venv/Scripts/python.exe";
      const cmd = `"${pythonExe}" "${pythonScript}" "${inputPath}" "${password}" "${outputPath}"`;

      console.log('   - Using Python (pikepdf) fallback for decryption...');
      
      try {
        // Use execSync to wait for completion
        const output = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
        
        if (output.includes('SUCCESS')) {
          console.log('   ✅ Python decryption successful');
          const decrypted = fs.readFileSync(outputPath);
          
          // Clean up temp files
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
          
          resolve(decrypted);
        } else {
          const errorMsg = output.includes('ERROR:') ? output.split('ERROR:')[1].trim() : output.trim();
          console.log('   ❌ Python decryption failed:', errorMsg);
          
          // Clean up temp files
          if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          
          reject(new Error(errorMsg || 'Python decryption failed'));
        }
      } catch (execError) {
        console.log('   ❌ Python execution error:', execError.message);
        
        // Clean up temp files
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        
        reject(execError);
      }
    } catch (err) {
      // Clean up temp files on error
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      
      reject(err);
    }
  });
};

// Build a compact Excel workbook from parsed CIBIL data
function buildCibilWorkbook(cibilData) {
  const wb = XLSX.utils.book_new();

  const metaSheet = XLSX.utils.json_to_sheet([
    { field: 'report_source', value: cibilData.cibil_meta?.report_source || '' },
    { field: 'report_date', value: cibilData.cibil_meta?.report_date || '' },
    { field: 'cibil_score', value: cibilData.credit_score?.cibil_score || '' },
    { field: 'score_band', value: cibilData.credit_score?.score_band || '' },
    { field: 'risk_band', value: cibilData.cibil_snapshot?.risk_band || '' },
    { field: 'total_accounts', value: (cibilData.credit_accounts || []).length },
    { field: 'live_emi_total', value: cibilData.obligations?.net_obligation_for_foir || 0 }
  ]);
  XLSX.utils.book_append_sheet(wb, metaSheet, 'summary');

  const accounts = (cibilData.credit_accounts || []).map(acc => ({
    bank: acc.bank_name || '',
    type: acc.account_type || '',
    status: acc.account_status || '',
    emi: acc.emi_amount || 0,
    current_outstanding: acc.current_outstanding || 0,
    sanctioned: acc.sanction_amount || acc.high_credit || '',
    opened: acc.opened_date || '',
    closed: acc.closed_date || '',
    dpd_12m: acc.max_dpd_12m || acc.dpd_12m || '',
    overdue_amount: acc.overdue_amount || 0
  }));
  const accSheet = XLSX.utils.json_to_sheet(accounts.length ? accounts : [{ info: 'No accounts parsed' }]);
  XLSX.utils.book_append_sheet(wb, accSheet, 'accounts');

  const enquiries = (cibilData.enquiries?.records || []).map(enq => ({
    date: enq.date || '',
    product: enq.purpose || enq.product || '',
    amount: enq.amount || '',
    bureau: enq.bureau || '',
    member: enq.member_name || ''
  }));
  const enqSheet = XLSX.utils.json_to_sheet(enquiries.length ? enquiries : [{ info: 'No enquiries parsed' }]);
  XLSX.utils.book_append_sheet(wb, enqSheet, 'enquiries');

  const addresses = (cibilData.addresses || []).map(addr => ({
    type: addr.type || '',
    address: addr.address || '',
    city: addr.city || '',
    state: addr.state || '',
    pincode: addr.pincode || ''
  }));
  const addrSheet = XLSX.utils.json_to_sheet(addresses.length ? addresses : [{ info: 'No addresses parsed' }]);
  XLSX.utils.book_append_sheet(wb, addrSheet, 'addresses');

  return wb;
}

// Main CIBIL scanning endpoint
app.post('/api/scan-cibil', upload.single('file'), async (req, res) => {
  try {
    // Validate file
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    let password = (req.body.password || '').trim();
    let pdfBuffer = req.file.buffer;
    
    console.log('📄 CIBIL Scan Started');
    console.log('   File size:', (pdfBuffer.length / 1024).toFixed(2), 'KB');
    console.log('   Password provided:', password.length > 0 ? `yes (${password.length} chars)` : 'no');
    
    // Step 1: Decrypt PDF if password protected
    let decryptedBuffer = null;
    
    try {
      // Try loading without password first
      console.log('   Trying to load PDF without password...');
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      console.log('   ✅ PDF loaded - not encrypted');
      decryptedBuffer = pdfBuffer;
    } catch (decryptErr) {
      console.log('   ⚠️  PDF is encrypted');
      
      if (!password) {
        console.log('   ℹ️  No password provided - asking user');
        return res.status(400).json({ 
          error: 'This PDF is password protected. Please enter the password to proceed.' 
        });
      }
      
      console.log('   Attempting to decrypt with password: "' + password + '"');
      
      let decrypted = false;
      
      // Try pdf-lib first
      try {
        console.log('   - Trying pdf-lib (userPassword field)...');
        const pdfDoc = await PDFDocument.load(pdfBuffer, { userPassword: password });
        console.log('   ✅ pdf-lib decrypted successfully (userPassword)');
        decryptedBuffer = await pdfDoc.save();
        decrypted = true;
      } catch (userErr) {
        console.log('   ❌ pdf-lib userPassword failed');
      }
      
      // Try pdf-lib ownerPassword
      if (!decrypted) {
        try {
          console.log('   - Trying pdf-lib (ownerPassword field)...');
          const pdfDoc = await PDFDocument.load(pdfBuffer, { ownerPassword: password });
          console.log('   ✅ pdf-lib decrypted successfully (ownerPassword)');
          decryptedBuffer = await pdfDoc.save();
          decrypted = true;
        } catch (ownerErr) {
          console.log('   ❌ pdf-lib ownerPassword failed');
        }
      }
      
      // Try Python fallback (pikepdf) if pdf-lib failed
      if (!decrypted) {
        try {
          console.log('   - Trying Python (pikepdf) fallback...');
          decryptedBuffer = await decryptPdfWithPython(pdfBuffer, password);
          console.log('   ✅ pikepdf decrypted successfully');
          decrypted = true;
        } catch (pythonErr) {
          console.log('   ❌ pikepdf also failed:', pythonErr.message.substring(0, 80));
        }
      }
      
      if (!decrypted) {
        console.log('   ❌ All decryption methods failed');
        return res.status(400).json({ 
          error: 'Unable to decrypt PDF with the provided password. Please verify the password is correct.' 
        });
      }
    }
    
    // Step 2: Extract text from PDF
    let pdfData;
    try {
      console.log('   Extracting text from PDF...');
      pdfData = await pdfParse(decryptedBuffer);
      console.log('   ✅ Text extracted:', pdfData.text.length, 'characters');
    } catch (parseErr) {
      console.error('   ❌ PDF parsing error:', parseErr.message);
      return res.status(400).json({ 
        error: 'Failed to extract text from PDF. Ensure it is a valid CIBIL report.' 
      });
    }
    
    const text = pdfData.text || '';
    
    if (text.length < 100) {
      console.log('❌ Extracted text too short:', text.length, 'chars');
      return res.status(400).json({ 
        error: 'PDF appears to be empty or not a valid CIBIL report.' 
      });
    }
    
    // Step 3: Parse CIBIL data using comprehensive extractor
    console.log('   Parsing CIBIL data with comprehensive extractor...');
    console.log('   Text length:', text.length, 'characters');
    
    // Detect report source from PDF text
    let reportSource = 'CIBIL';
    if (text.includes('PAISABAZAAR') || text.includes('Paisabazaar')) reportSource = 'PAISABAZAAR';
    else if (text.includes('WISHFIN') || text.includes('Wishfin')) reportSource = 'WISHFIN';
    else if (text.includes('BANKBAZAAR') || text.includes('BankBazaar')) reportSource = 'BANKBAZAAR';
    
    console.log('   Report source detected:', reportSource);
    
    // Extract comprehensive CIBIL data with page-wise processing
    const cibilData = extractCibilData(pdfData, reportSource);
    
    console.log('   ✅ CIBIL Score:', cibilData.credit_score.cibil_score);
    console.log('   ✅ Credit accounts:', cibilData.credit_accounts.length);
    console.log('   ✅ Confidence score:', cibilData.cibil_meta.confidence_score);
    
    // Improved validation: Accept data if we have accounts, even if score not found
    const hasAccounts = cibilData.credit_accounts.length > 0;
    const hasScore = cibilData.credit_score.cibil_score > 0;
    const hasPersonalDetails = cibilData.personal_details.full_name !== 'UNKNOWN';
    
    console.log('   📊 Validation - Has Accounts:', hasAccounts, '| Has Score:', hasScore, '| Has Personal:', hasPersonalDetails);
    
    // Accept even if no accounts - as long as we have score or personal details
    if (!hasScore && !hasPersonalDetails) {
      console.log('❌ No CIBIL data found - No score and no personal details');
      return res.status(400).json({ 
        error: 'No CIBIL data found. Please check if this is a valid CIBIL report.' 
      });
    }
    
    // If score is missing but we have accounts, try to extract score from accounts
    if (!hasScore && hasAccounts) {
      console.log('⚠️  CIBIL Score not detected, will use AI to enhance data...');
    }
    
    // If no accounts but have personal details or score, that's still valid
    if (!hasAccounts && (hasScore || hasPersonalDetails)) {
      console.log('✅ Valid CIBIL data found (score or personal details) even without accounts');
    }
    
    // Step 4: Return comprehensive structured data
    const result = {
      success: true,
      
      // Legacy format (for backward compatibility)
      cibilScore: cibilData.credit_score.cibil_score,
      accounts: cibilData.credit_accounts.map(acc => ({
        bank: acc.bank_name,
        loanType: acc.account_type,
        emi: acc.emi_amount || 0,
        outstanding: acc.current_outstanding || 0,
        openDate: acc.opened_date,
        status: acc.account_status
      })),
      totalLiveEmi: cibilData.obligations.net_obligation_for_foir,
      
      // NEW: Comprehensive structured format
      cibil_data: cibilData,
      
      message: `CIBIL report scanned successfully. Score: ${cibilData.credit_score.cibil_score}, Risk Band: ${cibilData.cibil_snapshot.risk_band}`
    };
    
    const wantsExcel = ((req.query.format || '').toLowerCase() === 'excel') || ((req.query.format || '').toLowerCase() === 'xlsx');
    if (wantsExcel) {
      const workbook = buildCibilWorkbook(cibilData);
      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="cibil-summary.xlsx"');
      return res.send(buffer);
    }
    
    return res.json(result);
    
  } catch (err) {
    console.error('CIBIL scan error:', err);
    return res.status(500).json({ 
      error: 'Server error while processing CIBIL report. Please try again.' 
    });
  }
});

// ============ END CIBIL PARSING ============

// Diagnostic endpoint - return raw PDF text for debugging
app.get('/api/debug-pdf-text', async (req, res) => {
  try {
    const samplePdfPath = path.join(__dirname, '..', 'assets', '8949461984.pdf');
    if (!fs.existsSync(samplePdfPath)) {
      return res.status(404).json({ error: 'Sample PDF not found' });
    }
    
    const pdfBuffer = fs.readFileSync(samplePdfPath);
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text || '';
    
    // Return first 5000 chars for inspection
    return res.json({
      text_sample: text.substring(0, 5000),
      total_length: text.length,
      contains_emi: text.includes('EMI') || text.includes('emi'),
      contains_credit_age: text.includes('CREDIT AGE') || text.includes('VINTAGE'),
      contains_member_name: text.includes('MEMBER NAME') || text.includes('BANK NAME')
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Test endpoint to extract from sample PDF
app.get('/api/test-cibil-extract', async (req, res) => {
  try {
    const samplePdfPath = path.join(__dirname, '..', 'assets', '8949461984.pdf');
    
    if (!fs.existsSync(samplePdfPath)) {
      return res.status(404).json({ error: 'Sample PDF not found' });
    }
    
    console.log('📄 Testing CIBIL extraction from sample PDF');
    
    const pdfBuffer = fs.readFileSync(samplePdfPath);
    let password = ''; // Add password if needed
    
    // Try to load and decrypt
    let pdfData;
    try {
      pdfData = await pdfParse(pdfBuffer);
    } catch (err) {
      return res.status(400).json({ error: 'Failed to parse PDF', details: err.message });
    }
    
    const text = pdfData.text || '';
    
    // Extract using comprehensive module
    let reportSource = 'CIBIL';
    if (text.includes('PAISABAZAAR')) reportSource = 'PAISABAZAAR';
    else if (text.includes('WISHFIN')) reportSource = 'WISHFIN';
    else if (text.includes('BANKBAZAAR')) reportSource = 'BANKBAZAAR';
    
    const cibilData = extractCibilData(text, reportSource);
    
    return res.json({
      success: true,
      extraction: cibilData,
      raw_text_length: text.length,
      raw_text_sample: text.substring(0, 500)
    });
    
  } catch (err) {
    console.error('Test extraction error:', err);
    return res.status(500).json({ error: 'Extraction failed', details: err.message });
  }
});

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

// ========================================
// NEW ENDPOINT: Calculate loan eligibility
// ========================================
/**
 * POST /api/calculate-eligibility
 * 
 * Maps parsed CIBIL data + customer profile → Bank-specific eligibility
 * 
 * Request body:
 * {
 *   "parsed_cibil": { ... CIBIL extraction result ... },
 *   "customer_profile": {
 *     "age": 29,
 *     "company_category": "CAT_A",
 *     "company_name": "TCS",
 *     "location_type": "PRIME",
 *     "city_tier": "METRO",
 *     "net_salary": 65000,
 *     "salary_mode": "BANK_TRANSFER",
 *     "employment_type": "SALARIED"
 *   },
 *   "loan_request": {
 *     "product": "PL",
 *     "preferred_tenure_years": 5,
 *     "requested_amount": 500000
 *   }
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "normalized_credit": { ... },
 *   "bank_results": [
 *     {
 *       "bank": "Bajaj Finance",
 *       "eligible": true,
 *       "available_emi": 27250,
 *       "foir_percent": 65,
 *       "eligibility": {
 *         "PL_5Y": 1397000,
 *         "PL_6Y": 1267000,
 *         "OD": 1211000
 *       },
 *       "approval_probability": 84,
 *       "recommended": true
 *     }
 *   ],
 *   "best_recommendation": { ... },
 *   "audit_trail": { ... }
 * }
 */
app.post('/api/calculate-eligibility', async (req, res) => {
  try {
    const { parsed_cibil, customer_profile, loan_request } = req.body;

    // Validate required fields
    if (!parsed_cibil) {
      return res.status(400).json({ 
        error: 'Missing parsed_cibil data. Please scan CIBIL first.' 
      });
    }

    if (!customer_profile || !customer_profile.net_salary) {
      return res.status(400).json({ 
        error: 'Missing customer_profile. Required: net_salary, company_category, age' 
      });
    }

    console.log('📊 Calculating eligibility...');
    console.log('   Customer salary:', customer_profile.net_salary);
    console.log('   CIBIL score:', parsed_cibil.credit_score?.cibil_score);
    console.log('   Active banks:', bankPolicies.banks.filter(b => b.active).length);

    // Calculate eligibility across all active banks
    const activeBanks = bankPolicies.banks.filter(bank => bank.active);
    
    const eligibilityResult = await calculateEligibility(
      parsed_cibil,
      customer_profile,
      loan_request || { product: 'PL', preferred_tenure_years: 5 },
      activeBanks
    );

    console.log('   ✅ Eligible banks:', eligibilityResult.eligible_banks_count, '/', eligibilityResult.total_banks_checked);
    if (eligibilityResult.best_recommendation) {
      console.log('   ✅ Best recommendation:', eligibilityResult.best_recommendation.bank);
      console.log('   ✅ Max eligibility:', Math.max(...Object.values(eligibilityResult.best_recommendation.eligibility || {})));
    }

    return res.json(eligibilityResult);

  } catch (error) {
    console.error('❌ Eligibility calculation error:', error);
    return res.status(500).json({ 
      error: 'Failed to calculate eligibility',
      details: error.message 
    });
  }
});

// ========================================
// AI-POWERED ENDPOINTS
// ========================================

// AI CIBIL Analysis Endpoint
app.post('/api/ai/analyze-cibil', upload.single('file'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ 
        error: 'AI features not configured',
        details: 'Set OPENAI_API_KEY in .env file'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    let password = (req.body.password || '').trim();
    let pdfBuffer = req.file.buffer;

    console.log('🤖 AI CIBIL Analysis Started');
    console.log('   File size:', (pdfBuffer.length / 1024).toFixed(2), 'KB');

    // Decrypt if needed
    let decryptedBuffer = null;
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      decryptedBuffer = pdfBuffer;
    } catch (err) {
      if (!password) {
        return res.status(400).json({ 
          error: 'This PDF is password protected. Please enter the password.' 
        });
      }

      try {
        const pdfDoc = await PDFDocument.load(pdfBuffer, { userPassword: password });
        decryptedBuffer = await pdfDoc.save();
      } catch {
        try {
          const pdfDoc = await PDFDocument.load(pdfBuffer, { ownerPassword: password });
          decryptedBuffer = await pdfDoc.save();
        } catch {
          return res.status(400).json({ 
            error: 'Unable to decrypt PDF with the provided password.' 
          });
        }
      }
    }

    // Extract text
    let pdfData;
    try {
      pdfData = await pdfParse(decryptedBuffer);
    } catch (err) {
      return res.status(400).json({ 
        error: 'Failed to extract text from PDF' 
      });
    }

    const text = pdfData.text || '';
    if (text.length < 100) {
      return res.status(400).json({ 
        error: 'PDF appears to be empty or not a valid CIBIL report.' 
      });
    }

    // Detect report source
    let reportSource = 'CIBIL';
    if (text.includes('PAISABAZAAR')) reportSource = 'PAISABAZAAR';
    else if (text.includes('WISHFIN')) reportSource = 'WISHFIN';
    else if (text.includes('BANKBAZAAR')) reportSource = 'BANKBAZAAR';

    // Use AI to analyze
    const cibilAnalysis = await analyzeCibilWithAI(text, reportSource);

    // Get AI insights
    const insights = await getAIInsights(cibilAnalysis);

    const result = {
      success: true,
      source: 'AI_ANALYZER',
      cibil_data: cibilAnalysis,
      ai_insights: insights,
      message: `✅ CIBIL report analyzed by AI. Score: ${cibilAnalysis.credit_score.cibil_score}, Risk: ${cibilAnalysis.risk_assessment.risk_level}`
    };

    return res.json(result);
  } catch (error) {
    console.error('🤖 AI Analysis error:', error);
    return res.status(500).json({ 
      error: 'AI analysis failed',
      details: error.message
    });
  }
});

// AI Eligibility Calculation Endpoint
app.post('/api/ai/calculate-eligibility', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ 
        error: 'AI features not configured'
      });
    }

    const { cibil_data, customer_profile } = req.body;

    if (!cibil_data || !customer_profile) {
      return res.status(400).json({ 
        error: 'Missing cibil_data or customer_profile' 
      });
    }

    console.log('🤖 AI Eligibility Calculation Started');

    // Use AI to calculate eligibility
    const aiEligibility = await calculateAIEligibility(cibil_data, customer_profile);

    const result = {
      success: true,
      source: 'AI_ELIGIBILITY',
      eligibility: aiEligibility,
      timestamp: new Date().toISOString(),
      message: `Eligibility Status: ${aiEligibility.eligibility_status} | Risk: ${aiEligibility.risk_rating} | Approval: ${aiEligibility.approval_probability}%`
    };

    return res.json(result);
  } catch (error) {
    console.error('🤖 AI Eligibility error:', error);
    return res.status(500).json({ 
      error: 'AI eligibility calculation failed',
      details: error.message
    });
  }
});

// Combined: Upload CIBIL + Analyze + Calculate Eligibility (All-in-One)
app.post('/api/ai/full-analysis', upload.single('file'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ 
        error: 'AI features not configured'
      });
    }

    const { password = '', customer_name = '', net_salary = 0, company_name = '' } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided' });
    }

    console.log('🤖 Full AI Analysis Pipeline Started');

    // Step 1: Extract & Decrypt PDF
    let pdfBuffer = req.file.buffer;
    let decryptedBuffer = null;

    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      decryptedBuffer = pdfBuffer;
    } catch {
      if (password) {
        try {
          const pdfDoc = await PDFDocument.load(pdfBuffer, { userPassword: password });
          decryptedBuffer = await pdfDoc.save();
        } catch {
          try {
            const pdfDoc = await PDFDocument.load(pdfBuffer, { ownerPassword: password });
            decryptedBuffer = await pdfDoc.save();
          } catch {
            return res.status(400).json({ error: 'Failed to decrypt PDF' });
          }
        }
      } else {
        return res.status(400).json({ error: 'PDF is protected. Please provide password.' });
      }
    }

    // Step 2: Extract text
    let pdfData = await pdfParse(decryptedBuffer);
    const text = pdfData.text || '';

    if (text.length < 100) {
      return res.status(400).json({ error: 'PDF is empty or invalid' });
    }

    // Step 3: AI Analysis
    console.log('   📊 Step 1: AI CIBIL Analysis...');
    let reportSource = 'CIBIL';
    if (text.includes('PAISABAZAAR')) reportSource = 'PAISABAZAAR';
    
    const cibilAnalysis = await analyzeCibilWithAI(text, reportSource);

    // Step 4: Get insights
    console.log('   💡 Step 2: AI Insights Generation...');
    const insights = await getAIInsights(cibilAnalysis);

    // Step 5: AI Eligibility
    console.log('   🎯 Step 3: AI Eligibility Calculation...');
    const customerProfile = {
      name: customer_name || cibilAnalysis.personal_details?.name || 'Applicant',
      net_salary: parseFloat(net_salary) || 50000,
      company_name: company_name || 'N/A'
    };

    const aiEligibility = await calculateAIEligibility(cibilAnalysis, customerProfile);

    const result = {
      success: true,
      pipeline: 'FULL_AI_ANALYSIS',
      
      // CIBIL Data
      cibil_data: {
        score: cibilAnalysis.credit_score.cibil_score,
        band: cibilAnalysis.credit_score.score_band,
        accounts: cibilAnalysis.credit_accounts.length,
        risk_level: cibilAnalysis.risk_assessment.risk_level,
        personal_details: cibilAnalysis.personal_details
      },

      // AI Insights
      ai_insights: insights,

      // Eligibility
      eligibility: aiEligibility,

      // Summary
      summary: {
        cibil_score: cibilAnalysis.credit_score.cibil_score,
        risk_level: cibilAnalysis.risk_assessment.risk_level,
        eligibility_status: aiEligibility.eligibility_status,
        approval_probability: aiEligibility.approval_probability,
        available_emi: aiEligibility.available_emi,
        processing_days: aiEligibility.processing_days
      },

      timestamp: new Date().toISOString()
    };

    console.log('   ✅ Full analysis complete!');
    return res.json(result);

  } catch (error) {
    console.error('🤖 Full analysis error:', error);
    return res.status(500).json({ 
      error: 'Full analysis failed',
      details: error.message
    });
  }
});

app.listen(PORT, ()=>{
  console.log('Server listening on', PORT);
});
