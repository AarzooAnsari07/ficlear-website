/**
 * FICLEAR – CIBIL REPORT EXTRACTION MODULE (PRODUCTION-READY)
 * Supports: CIBIL.com, Paisabazaar, Wishfin, BankBazaar
 * 
 * 🧠 PARSING FLOW:
 * 1. Password decryption
 * 2. Page-wise text extraction
 * 3. Section detection
 * 4. Field extraction (regex + rules)
 * 5. Normalization
 * 6. Validation & confidence score
 */

/**
 * Main extraction function - Parses CIBIL PDF text into structured data
 * @param {object} pdfData - PDF parse output with text and page info
 * @param {string} reportSource - Source of the report (PAISABAZAAR, CIBIL, etc.)
 * @returns {object} - Structured CIBIL data
 */
function extractCibilData(pdfData, reportSource = 'CIBIL') {
  // Step 1: Extract text page-wise
  const pages = extractPageWiseText(pdfData);
  
  // Step 2: Identify sections
  const sections = identifySections(pages);
  
  // Step 3: Extract data from identified sections
  const extractedData = {
    // 1️⃣ META INFORMATION
    cibil_meta: {
      report_source: reportSource.toUpperCase(),
      report_date: extractReportDate(pages, sections),
      pdf_password_used: true,
      total_pages: pages.length,
      confidence_score: 0.0 // Will be calculated
    },

    // 2️⃣ PERSONAL DETAILS
    personal_details: extractPersonalDetails(pages, sections),

    // 3️⃣ ADDRESS DETAILS
    addresses: extractAddresses(pages, sections),

    // 4️⃣ CREDIT SCORE SUMMARY
    credit_score: extractCreditScoreSummary(pages, sections),

    // 5️⃣ CREDIT ACCOUNTS (Most Important)
    credit_accounts: extractCreditAccounts(pages, sections),

    // 6️⃣ OBLIGATIONS (calculated with policy rules)
    obligations: null,

    // 7️⃣ REPAYMENT BEHAVIOR
    repayment_behavior: extractRepaymentBehavior(pages, sections),

    // 8️⃣ ENQUIRY DETAILS (filtered)
    enquiries: extractEnquiries(pages, sections),

    // 9️⃣ ACCOUNT TAGS
    account_tags: null,

    // 🔟 FINAL SNAPSHOT
    cibil_snapshot: null,
    
    // 🔐 SECURITY
    _sections: sections, // For debugging/audit
    _raw_page_count: pages.length
  };

  // Calculate derived fields
  extractedData.obligations = calculateObligationsWithRules(extractedData.credit_accounts);
  extractedData.account_tags = classifyAccounts(extractedData.credit_accounts);
  extractedData.cibil_snapshot = generateSnapshot(extractedData);
  extractedData.cibil_meta.confidence_score = calculateConfidence(extractedData);

  return extractedData;
}

/**
 * STEP 2: Extract text page-wise
 */
function extractPageWiseText(pdfData) {
  const pages = [];
  
  if (typeof pdfData === 'string') {
    // Legacy: Single string input
    pages.push({ page: 1, text: pdfData });
  } else if (pdfData.text) {
    // Try to split by page markers or use full text
    const fullText = pdfData.text;
    
    // Common page markers in CIBIL PDFs
    const pageMarkers = fullText.split(/Page\s+\d+\s+of\s+\d+|═{3,}/gi);
    
    if (pageMarkers.length > 1) {
      pageMarkers.forEach((text, idx) => {
        if (text.trim().length > 50) {
          pages.push({ page: idx + 1, text: text.trim() });
        }
      });
    } else {
      // Single page or no markers
      pages.push({ page: 1, text: fullText });
    }
  }
  
  return pages;
}

/**
 * STEP 3: Section identification (MOST IMPORTANT)
 * Detects where each section is located in the PDF
 */
function identifySections(pages) {
  const sections = {
    personal_section_pages: [],
    address_section_pages: [],
    score_section_pages: [],
    account_summary_pages: [],
    account_detail_pages: [],
    enquiry_section_pages: []
  };
  
  pages.forEach(({ page, text }) => {
    // Personal Details - Usually page 1-2
    if (/PERSONAL\s+INFORMATION|CONSUMER\s+DETAILS|NAME\s*:|PAN\s*:/i.test(text)) {
      sections.personal_section_pages.push(page);
    }
    
    // Address Section
    if (/ADDRESS\s+INFORMATION|CURRENT\s+ADDRESS|PERMANENT\s+ADDRESS/i.test(text)) {
      sections.address_section_pages.push(page);
    }
    
    // Score Section - Always page 1
    if (/CIBIL\s+SCORE|CREDIT\s+SCORE|SCORE\s+SUMMARY/i.test(text)) {
      sections.score_section_pages.push(page);
    }
    
    // Account Summary
    if (/ACCOUNT\s+SUMMARY|TOTAL\s+ACCOUNTS|CREDIT\s+SUMMARY/i.test(text)) {
      sections.account_summary_pages.push(page);
    }
    
    // Account Details - Usually starts page 3-4
    if (/ACCOUNT\s+(?:INFORMATION|DETAILS|NUMBER)|MEMBER\s+NAME/i.test(text)) {
      sections.account_detail_pages.push(page);
    }
    
    // Enquiry Section
    if (/ENQUIR(?:Y|IES)\s+INFORMATION|RECENT\s+ENQUIR/i.test(text)) {
      sections.enquiry_section_pages.push(page);
    }
  });
  
  return sections;
}

/**
 * Get text from specific section pages
 */
function getSectionText(pages, sectionPages) {
  return pages
    .filter(p => sectionPages.includes(p.page))
    .map(p => p.text)
    .join('\n');
}

/**
 * Extract report date
 */
function extractReportDate(pages, sections) {
  // Score section usually has report date
  const text = getSectionText(pages, sections.score_section_pages.length > 0 
    ? sections.score_section_pages 
    : [1]);
  
  const patterns = [
    /REPORT\s+DATE\s*[:\-]?\s*(\d{1,2}[-\/]\w{3}[-\/]\d{4})/i,
    /DATE\s+OF\s+ISSUE\s*[:\-]?\s*(\d{1,2}[-\/]\w{3}[-\/]\d{4})/i,
    /GENERATED\s+ON\s*[:\-]?\s*(\d{1,2}[-\/]\w{3}[-\/]\d{4})/i,
    /(\d{1,2}[-\/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\/]\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return normalizeDate(match[1]);
    }
  }

  return new Date().toISOString().split('T')[0];
}

/**
 * STEP 4: Extract personal details with robust patterns
 */
function extractPersonalDetails(pages, sections) {
  const text = getSectionText(pages, sections.personal_section_pages.length > 0 
    ? sections.personal_section_pages 
    : [1]);
  
  return {
    full_name: extractFullName(text),
    date_of_birth: extractDOB(text),
    pan: extractPAN(text),
    mobile_numbers: extractMobileNumbers(text),
    email_ids: extractEmails(text),
    gender: extractGender(text)
  };
}

function extractFullName(text) {
  const patterns = [
    /(?:NAME|CONSUMER\s+NAME|BORROWER\s+NAME)\s*[:\-]?\s*([A-Z][A-Z\s]{2,50})(?:\n|PAN|DOB|DATE)/i,
    /NAME\s*[:\-]?\s*([A-Z][A-Z\s]{2,50})\s*(?:PAN|DOB)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Validate name (at least 2 words, all caps)
      if (name.split(/\s+/).length >= 2 && /^[A-Z\s]+$/.test(name)) {
        return name;
      }
    }
  }
  return "UNKNOWN";
}

function extractDOB(text) {
  // Pattern: DOB: 12-Mar-1996 or DOB: 12/03/1996
  const patterns = [
    /(?:DATE\s+OF\s+BIRTH|DOB|BIRTH\s+DATE)\s*[:\-]?\s*(\d{1,2}[-\/](?:\w{3}|\d{2})[-\/]\d{4})/i,
    /DOB\s*[:\-]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return normalizeDate(match[1]);
    }
  }
  return null;
}

function extractPAN(text) {
  // PAN pattern: ABCDE1234F
  const match = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z]{1})\b/);
  if (match) {
    // Validate PAN checksum logic (optional)
    return match[1].toUpperCase();
  }
  return null;
}

function extractMobileNumbers(text) {
  // Indian mobile: starts with 6-9, 10 digits
  const pattern = /\b([6-9]\d{9})\b/g;
  const matches = text.match(pattern) || [];
  
  // Remove duplicates
  const unique = [...new Set(matches)];
  
  // Validate (should be exactly 10 digits)
  return unique.filter(num => num.length === 10);
}

function extractEmails(text) {
  const pattern = /\b([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)\b/g;
  const matches = text.match(pattern) || [];
  return [...new Set(matches)];
}

function extractGender(text) {
  if (/GENDER\s*[:\-]?\s*M(?:ALE)?(?:\s|$)/i.test(text)) return 'MALE';
  if (/GENDER\s*[:\-]?\s*F(?:EMALE)?(?:\s|$)/i.test(text)) return 'FEMALE';
  return 'UNKNOWN';
}

/**
 * Extract addresses with pincode detection
 */
function extractAddresses(pages, sections) {
  const text = getSectionText(pages, sections.address_section_pages.length > 0 
    ? sections.address_section_pages 
    : sections.personal_section_pages);
  
  const addresses = [];
  
  // Pattern: Address blocks with PIN code
  const addressRegex = /(?:CURRENT|PERMANENT|OFFICE|RESIDENTIAL)\s+ADDRESS\s*[:\-]?\s*([\s\S]{10,200}?)(?:PIN\s*CODE|PINCODE)\s*[:\-]?\s*(\d{6})/gi;
  
  let match;
  while ((match = addressRegex.exec(text)) !== null) {
    const type = match[0].match(/(CURRENT|PERMANENT|OFFICE|RESIDENTIAL)/i)[1].toUpperCase();
    const addressText = match[1];
    const pincode = match[2];
    
    // Extract city and state from address text
    const cityMatch = addressText.match(/CITY\s*[:\-]?\s*([A-Z\s]+)/i);
    const stateMatch = addressText.match(/STATE\s*[:\-]?\s*([A-Z\s]+)/i);
    
    addresses.push({
      type: type,
      address: extractAddressLine(addressText),
      city: cityMatch ? cityMatch[1].trim() : 'Unknown',
      state: stateMatch ? stateMatch[1].trim() : 'Unknown',
      pincode: pincode
    });
  }

  // Fallback: Find any 6-digit pincode
  if (addresses.length === 0) {
    const pincodeMatch = text.match(/\b(\d{6})\b/);
    if (pincodeMatch) {
      addresses.push({
        type: 'CURRENT',
        address: 'Address not parsed',
        city: 'Unknown',
        state: 'Unknown',
        pincode: pincodeMatch[1]
      });
    }
  }
  
  return addresses;
}

function extractAddressLine(addressText) {
  const lines = addressText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 5 && !/^(ADDRESS|CITY|STATE|PIN)/i.test(l));
  
  return lines.slice(0, 2).join(', ').substring(0, 150);
}

/**
 * STEP 5: Credit score summary (Page 1)
 */
function extractCreditScoreSummary(pages, sections) {
  const text = getSectionText(pages, sections.score_section_pages.length > 0 
    ? sections.score_section_pages 
    : [1]);
  
  let score = extractCibilScore(text);
  // Fallback: if score not found on score section, scan entire PDF text
  if (score === 0 && Array.isArray(pages)) {
    const fullText = pages.map(p => p.text || '').join('\n');
    score = extractCibilScore(fullText);
  }
  const vintage = extractCreditVintage(text);
  
  return {
    cibil_score: score,
    score_band: getScoreBand(score),
    credit_vintage_months: vintage,
    total_live_accounts: countAccountsByStatus(text, 'LIVE|ACTIVE'),
    total_closed_accounts: countAccountsByStatus(text, 'CLOSED'),
    recent_enquiries_30_days: extractRecentEnquiries(text, 30)
  };
}

function extractCibilScore(text) {
  const patterns = [
    /CIBIL\s+TRANSUNION\s+SCORE\s*[:\-]?\s*(\d{3})/i,
    /TRANSUNION\s+SCORE\s*[:\-]?\s*(\d{3})/i,
    /CIBIL\s*TRANSUNION\s*[:\-]?\s*(\d{3})/i,
    /CIBIL\s+SCORE\s*2\.0\s*[:\-]?\s*(\d{3})/i,
    /YOUR\s+CIBIL\s+SCORE\s*[:\-]?\s*(\d{3})/i,
    /CIBIL\s+SCORE\s+IS\s*[:\-]?\s*(\d{3})/i,
    /CIBIL\s+SCORE\s*[:\-]?\s*(\d{3})/i,
    /CREDIT\s+SCORE\s*[:\-]?\s*(\d{3})/i,
    /SCORE\s*[:\-]?\s*(\d{3})/i,
    /(\d{3})\s*(?:out\s+of|\/)\s*900/i,
    // Additional patterns for different report formats
    /\*\s*(\d{3})\s*\*/i,  // Score in asterisks: *750*
    /Score\s+(\d{3})/i,     // Capital S Score
    /^\s*(\d{3})\s*$/m,     // Score on its own line (check near "CIBIL" or "Score" keywords)
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const score = parseInt(match[1], 10);
      if (score >= 300 && score <= 900) {
        return score;
      }
    }
  }
  
  // Last resort: Look for any 3-digit number near "CIBIL" or "Score" text
  const contextPatterns = text.match(/(?:CIBIL|Score|TRANSUNION)[\s\S]{0,50}(\d{3})[\s\S]{0,20}(?:CIBIL|Score|TRANSUNION|account)/i);
  if (contextPatterns && contextPatterns[1]) {
    const score = parseInt(contextPatterns[1], 10);
    if (score >= 300 && score <= 900) {
      return score;
    }
  }
  
  return 0;
}

function getScoreBand(score) {
  if (score >= 750) return 'EXCELLENT';
  if (score >= 700) return 'GOOD';
  if (score >= 650) return 'FAIR';
  if (score >= 550) return 'POOR';
  return 'VERY_POOR';
}

function extractCreditVintage(text) {
  const patterns = [
    /CREDIT\s+AGE\s*[:\-]?\s*(\d+)\s*(?:MONTHS|MOS|M)/i,
    /VINTAGE\s*[:\-]?\s*(\d+)\s*(?:MONTHS|MOS)/i,
    /AGE\s+OF\s+ACCOUNTS\s*[:\-]?\s*(\d+)\s*YEARS?\s*(?:AND|&)?\s*(\d+)\s*MONTHS?/i,
    /(\d+)\s*(?:YEARS?|YRS?)\s+(\d+)\s*(?:MONTHS?|MOS?)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[2]) {
        // Years and months format
        const years = parseInt(match[1], 10);
        const months = parseInt(match[2], 10);
        return (years * 12) + months;
      } else {
        // Just months
        return parseInt(match[1], 10);
      }
    }
  }
  
  return 0;
}

function countAccountsByStatus(text, statusPattern) {
  const regex = new RegExp(`STATUS\\s*[:\\-]?\\s*(?:${statusPattern})`, 'gi');
  const matches = text.match(regex) || [];
  return matches.length;
}

function extractRecentEnquiries(text, days) {
  const pattern = new RegExp(`ENQUIR(?:Y|IES)\\s+(?:IN\\s+)?LAST\\s+${days}\\s+DAYS\\s*[:\\-]?\\s*(\\d+)`, 'i');
  const match = text.match(pattern);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * STEP 6: Extract credit accounts (CORE LOGIC)
 * Split by account blocks and parse each
 */
function extractCreditAccounts(pages, sections) {
  const text = getSectionText(pages, sections.account_detail_pages.length > 0 
    ? sections.account_detail_pages 
    : pages.map(p => p.page));
  
  const accounts = [];
  
  // Remove enquiry sections first
  let cleanText = text.replace(/Sr\.\s*No\.[\s\S]*?(?=ACCOUNT\s+NUMBER|Account\s+Number|$)/i, '');
  
  // Try Paisabazaar table format first (common format with tabular data)
  const paisabazaarAccounts = extractPaisabazaarTableFormat(cleanText);
  if (paisabazaarAccounts.length > 0) {
    return paisabazaarAccounts;
  }

  // Try loose-row Paisabazaar format (rows flattened by PDF parser)
  const paisaLoose = extractPaisabazaarLooseRows(cleanText);
  if (paisaLoose.length > 0) {
    return paisaLoose;
  }
  
  // Try multiple splitting patterns
  let accountBlocks = [];
  
  // Pattern 1: Modern CIBIL format - Account Number
  if (cleanText.match(/Account\s+Number\s*[:\-]/i)) {
    accountBlocks = cleanText.split(/(?=Account\s+Number\s*[:\-])/i);
  }
  // Pattern 2: ACCOUNT TYPE header
  else if (cleanText.match(/ACCOUNT\s+TYPE\s*[:\-]?/i)) {
    accountBlocks = cleanText.split(/(?=ACCOUNT\s+TYPE\s*[:\-]?)/i);
  }
  // Pattern 3: MEMBER NAME (alternative format)
  else if (cleanText.match(/MEMBER\s+NAME\s*[:\-]/i)) {
    accountBlocks = cleanText.split(/(?=MEMBER\s+NAME\s*[:\-])/i);
  }
  // Pattern 4: INSTITUTION NAME (alternative format)
  else if (cleanText.match(/INSTITUTION\s+NAME\s*[:\-]/i)) {
    accountBlocks = cleanText.split(/(?=INSTITUTION\s+NAME\s*[:\-])/i);
  }
  // Pattern 5: Fallback - split by empty lines followed by uppercase
  else if (cleanText.split(/\n\s*\n/).length > 3) {
    accountBlocks = cleanText.split(/\n\s*\n/);
  }
  
  for (const block of accountBlocks) {
    if (block.length < 100) continue;
    
    // Additional filter: skip if this looks like an enquiry section
    if (block.includes('ENQUIRED ON') || block.includes('enquiry') || 
        (block.includes('Sr.') && block.includes('Purpose'))) {
      continue;
    }
    
    const account = parseAccountBlock(block);
    if (account && account.account_type && account.bank_name) {
      accounts.push(account);
    }
  }
  
  return accounts;
}

/**
 * Fallback for Paisabazaar when table formatting is flattened by PDF parser.
 * Detects rows that contain status + opened date + amounts on a single line.
 */
function extractPaisabazaarLooseRows(text) {
  const accounts = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 25);

  // Skip obvious header lines
  const headerRegex = /Financial\s+Institution|Account\s+type|Account\s+No|Ownership|Opened\s+Date|Last\s+Bank|Summary:\s+Loan/i;

  for (const line of lines) {
    if (headerRegex.test(line)) continue;

    // Need status and a date on the line to consider it
    const statusMatch = line.match(/Active|Closed|Settled|Live/i);
    const openedDateMatch = line.match(/\d{2}[-\/]\d{2}[-\/]\d{4}/);
    if (!statusMatch || !openedDateMatch) continue;

    // Collect numeric amounts (₹ or comma separated)
    const amountMatches = [...line.matchAll(/[₹]?[0-9][0-9,]{3,}/g)].map(m => parseFloat(m[0].replace(/[₹,]/g, '')));

    // Try to find an account number token (XXXX or digits)
    const accNumMatch = line.match(/X{2,}\d{2,}|\b\d{8,16}\b/);

    // Detect account type from known keywords
    const accountType = normalizeAccountType(line) || extractAccountType(line);
    if (!accountType) continue;

    // Bank name: take substring before account type keyword occurrence
    let bankName = null;
    const typeIdx = line.toUpperCase().indexOf(accountType.replace('_', ' ').split(' ')[0]);
    if (typeIdx > 0) {
      bankName = line.substring(0, typeIdx).trim();
    }
    if (!bankName || bankName.length < 3) {
      // fallback: first words until status token
      const statusIdx = line.indexOf(statusMatch[0]);
      if (statusIdx > 0) bankName = line.substring(0, statusIdx).trim();
    }

    const normalizedBank = normalizeBankName(bankName || '');
    if (!normalizedBank) continue;

    let loanAmount = 0;
    let outstanding = 0;
    if (amountMatches.length > 0) loanAmount = amountMatches[0];
    if (amountMatches.length > 1) outstanding = amountMatches[1];

    accounts.push({
      bank_name: normalizedBank,
      account_type: accountType,
      account_number: accNumMatch ? accNumMatch[0] : null,
      account_status: /Closed/i.test(statusMatch[0]) ? 'CLOSED' : (/Settled/i.test(statusMatch[0]) ? 'SETTLED' : 'LIVE'),
      opened_date: normalizeDate(openedDateMatch[0]),
      ownership: 'Individual',
      loan_amount: loanAmount,
      current_outstanding: outstanding,
      emi_amount: 0,
      tenure_months: null,
      interest_rate: null,
      dpd_last_12m: 0,
      is_obligated: outstanding > 0
    });
  }

  return accounts;
}

/**
 * Extract accounts from Paisabazaar table format
 * Expected format: Financial Institution | Account Type | Account No | Ownership | Opened Date | Status | Loan Amount | Outstanding
 */
function extractPaisabazaarTableFormat(text) {
  const accounts = [];
  
  // Look for table header (key indicator of Paisabazaar format)
  if (!text.match(/Financial\s+Institution|Account\s+type|Account\s+No|Ownership/i)) {
    console.log('   📋 Not Paisabazaar table format - skipping');
    return [];
  }
  
  console.log('   📋 Detected Paisabazaar table format');
  
  // Split by lines and find data rows (skip headers and separators)
  const lines = text.split('\n');
  let inTable = false;
  let rowCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Detect table start (headers like "Financial Institution", "Account type")
    if (line.match(/Financial\s+Institution|Summary:\s+Loan|Account\s+type/i)) {
      console.log('   📋 Found table header at line', i, ':', line.substring(0, 50));
      inTable = true;
      continue;
    }
    
    // Skip empty lines and separator lines
    if (!line || line.match(/^[\-=\s]+$/) || line.match(/^Page\s+\d+/i)) {
      continue;
    }
    
    // Skip header lines
    if (line.match(/Account\s+type|Ownership|Opened\s+Date|Last\s+Bank/i)) {
      console.log('   📋 Skipping header line:', line.substring(0, 50));
      continue;
    }
    
    // Try to parse as account row
    if (inTable && line.length > 20) {
      console.log('   📋 Parsing row', rowCount, ':', line.substring(0, 60));
      const account = parsePaisabazaarTableRow(line);
      if (account && account.bank_name && account.account_type) {
        console.log('   ✅ Extracted account:', account.bank_name, account.account_type);
        accounts.push(account);
        rowCount++;
      } else {
        console.log('   ❌ Failed to parse row');
      }
    }
  }
  
  console.log('   📋 Paisabazaar extraction complete:', accounts.length, 'accounts found');
  return accounts;
}

/**
 * Parse a single row from Paisabazaar table format
 * Row format: Bank Name | Account Type | Account No | Ownership | Opened Date | Status | Loan Amount | Outstanding
 */
function parsePaisabazaarTableRow(row) {
  // Split by multiple spaces or pipe character (table delimiters)
  const cells = row.split(/\s{2,}|\|/).map(c => c.trim()).filter(c => c);
  
  console.log('      Split cells:', cells.length, cells.map(c => c.substring(0, 20)));
  
  if (cells.length < 5) {
    console.log('      Not enough cells:', cells.length, '< 5');
    return null;
  }
  
  // Extract fields from cells
  const bankName = cells[0];
  const accountType = cells[1];
  const accountNumber = cells[2];
  const ownership = cells.length > 3 ? cells[3] : 'Individual';
  const openedDate = cells.length > 4 ? cells[4] : null;
  
  console.log('      Bank:', bankName, 'Type:', accountType, 'No:', accountNumber);
  
  // Find status, loan amount, outstanding in remaining cells
  let status = 'LIVE';
  let loanAmount = 0;
  let outstanding = 0;
  let accountStatus = 'LIVE';
  
  for (let i = 5; i < cells.length; i++) {
    const cell = cells[i];
    
    // Check for status
    if (cell.match(/Active|Closed|Settled|Live/i)) {
      status = cell.match(/Active|Live/i) ? 'LIVE' : (cell.match(/Closed/i) ? 'CLOSED' : 'SETTLED');
      accountStatus = status;
      console.log('      Status found:', status);
    }
    
    // Try to parse amounts (look for currency or numbers)
    if (cell.match(/^\d+[,\d]*$|₹/) && !cell.match(/^0+$|^\d{2,4}$/)) {
      const amount = parseFloat(cell.replace(/[₹,]/g, ''));
      
      // First large amount is likely loan amount, second is outstanding
      if (loanAmount === 0 && amount > 1000) {
        loanAmount = amount;
        console.log('      Loan amount found:', amount);
      } else if (outstanding === 0 && amount > 0) {
        outstanding = amount;
        console.log('      Outstanding found:', amount);
      }
    }
  }
  
  // Validate and normalize
  const normalizedBankName = normalizeBankName(bankName);
  const normalizedAccountType = normalizeAccountType(accountType);
  
  console.log('      Normalized bank:', normalizedBankName, 'Type:', normalizedAccountType);
  
  if (!normalizedBankName || !normalizedAccountType) {
    console.log('      Validation failed - bank or type');
    return null;
  }
  
  return {
    bank_name: normalizedBankName,
    account_type: normalizedAccountType,
    account_number: accountNumber,
    account_status: accountStatus,
    opened_date: openedDate ? normalizeDate(openedDate) : null,
    ownership: ownership,
    loan_amount: loanAmount,
    current_outstanding: outstanding,
    emi_amount: 0,
    tenure_months: null,
    interest_rate: null,
    dpd_last_12m: 0,
    is_obligated: (accountStatus === 'LIVE' && outstanding > 0)
  };
}

/**
 * Normalize account type string
 */
function normalizeAccountType(typeStr) {
  const typeMap = {
    'PERSONAL': 'PERSONAL_LOAN',
    'HOME': 'HOME_LOAN',
    'HOUSING': 'HOME_LOAN',
    'AUTO': 'AUTO_LOAN',
    'CREDIT CARD': 'CREDIT_CARD',
    'GOLD': 'GOLD_LOAN',
    'BUSINESS': 'BUSINESS_LOAN',
    'EDUCATION': 'EDUCATION_LOAN',
    'TWO WHEELER': 'TWO_WHEELER_LOAN',
    'CONSUMER': 'CONSUMER_LOAN',
    'OVERDRAFT': 'OVERDRAFT',
    'FLEXI': 'FLEXI_LOAN',
    'PROPERTY': 'PROPERTY_LOAN'
  };
  
  const upper = typeStr.toUpperCase().trim();
  for (const [key, value] of Object.entries(typeMap)) {
    if (upper.includes(key)) {
      return value;
    }
  }
  
  return null;
}

function parseAccountBlock(block) {
  const accountType = extractAccountType(block);
  if (!accountType) return null;
  
  // Skip if this looks like an enquiry header (ENQUIRED ON, etc)
  if (block.includes('ENQUIRED ON') || !block.match(/Account\s*Number|Personal\s*Loan|Credit\s*Card|ACCOUNT/i)) {
    return null;
  }
  
  const bankName = extractBankName(block);
  if (!bankName) return null; // Skip if no valid bank name
  
  const status = extractAccountStatus(block);
  const openedDate = extractOpenedDate(block);
  const accountNumber = extractAccountNumber(block);
  const ownership = extractOwnership(block);
  
  const account = {
    account_type: accountType,
    bank_name: bankName,
    account_status: status,
    opened_date: openedDate,
    account_number: accountNumber,
    ownership: ownership
  };
  
  // For loans
  if (accountType !== 'CREDIT_CARD') {
    account.loan_amount = extractAmount(block, 'LOAN\s+AMOUNT|SANCTIONED|DISBURSED|LOAN');
    account.current_outstanding = extractAmount(block, 'OUTSTANDING\s+BALANCE|CURRENT\s+BALANCE|BALANCE|OUTSTANDING');
    account.emi_amount = extractAmount(block, 'EMI|MONTHLY\s+PAYMENT|Monthly|payment');
    account.tenure_months = extractTenure(block);
    account.interest_rate = extractInterestRate(block);
    account.dpd_last_12m = extractMaxDPD(block);
    account.is_obligated = (status === 'LIVE' && account.emi_amount > 0);

    // Fallback: if loan amount was not captured but we have a sensible outstanding, use the largest number in block
    if ((!account.loan_amount || account.loan_amount === 0) && account.current_outstanding > 0) {
      account.loan_amount = account.current_outstanding;
    }
    if (!account.loan_amount || account.loan_amount === 0) {
      const largest = extractLargestAmount(block);
      if (largest > 0) account.loan_amount = largest;
    }
  } else {
    // For credit cards
    account.credit_limit = extractAmount(block, 'CREDIT\s+LIMIT|SANCTIONED|LIMIT|MAXIMUM\s+UTILIZATION|UTILIZATION');
    account.current_outstanding = extractAmount(block, 'OUTSTANDING\s+BALANCE|CURRENT\s+BALANCE|BALANCE|OUTSTANDING');
    // Fallback: if limit not captured, try largest amount in block
    if (!account.credit_limit || account.credit_limit === 0) {
      const largest = extractLargestAmount(block);
      if (largest > 0) account.credit_limit = largest;
    }
    account.is_obligated = false;
  }
  
  return account;
}

function extractAccountType(block) {
  const typeMap = {
    'PERSONAL': 'PERSONAL_LOAN',
    'HOME': 'HOME_LOAN',
    'AUTO': 'AUTO_LOAN',
    'CREDIT CARD': 'CREDIT_CARD',
    'GOLD': 'GOLD_LOAN',
    'BUSINESS': 'BUSINESS_LOAN',
    'EDUCATION': 'EDUCATION_LOAN',
    'TWO WHEELER': 'TWO_WHEELER_LOAN',
    'CONSUMER': 'CONSUMER_LOAN',
    'OVERDRAFT': 'OVERDRAFT',
    'FLEXI': 'FLEXI_LOAN'
  };
  
  // Try new format: "Account type:Personal Loan"
  let match = block.match(/Account\s+type\s*[:\-]?\s*(.+?)(?:\n|Account|$)/i);
  
  // Try legacy format: "ACCOUNT TYPE : Personal Loan"
  if (!match) {
    match = block.match(/ACCOUNT\s+TYPE\s*[:\-]?\s*(.+?)(?:\n|$)/i);
  }
  
  if (!match) return null;
  
  const type = match[1].trim().toUpperCase();
  for (const [key, value] of Object.entries(typeMap)) {
    if (type.includes(key)) {
      return value;
    }
  }
  
  // Return the type as-is if it has "LOAN" in it
  if (type.includes('LOAN')) {
    return type.replace(/\s+/g, '_');
  }
  
  return 'OTHER_LOAN';
}

function extractBankName(block) {
  // Filter out noise first - MOST IMPORTANT
  if (block.includes('ENQUIRED ON') || block.includes('enquiry') || 
      block.includes('Sr. No') || block.includes('Sr.No') ||
      block.match(/Sr\.\s*No\.|Enquiry\s+Purpose/i) || 
      block.length < 50) {
    return null;
  }
  
  // Try patterns for different field names
  let match = block.match(/(?:Financial\s+Institution|Member\s+Name|Institution\s+Name|Bank\s+Name)\s*[:\-]?\s*([^\n]+)/i);
  if (match && match[1]) {
    const name = match[1].trim();
    if (name.length > 2 && !name.match(/^(NA|\-|\s|ENQUIRED)$/i)) {
      return normalizeBankName(name);
    }
  }
  
  // Try direct pattern: "AXIS BANK" or similar - major banks list
  match = block.match(/\b(AXIS|HDFC|ICICI|SBI|YES|KOTAK|FEDERAL|IDBI|INDUSIND|BOB|PNB|CANARA|UNION|ABHYUDAYA|HSBC|DEUTSCHE|CITI|CREDIT\s+SUISSE|AMEX|AMERICAN\s+EXPRESS|STANDARD\s+CHARTERED|BANK\s+OF\s+BARODA|RBL|BAJAJ|AMAZON|FLIPKART|PAYTM)\s+(?:BANK)?/i);
  if (match && match[1]) {
    let name = match[1].toUpperCase();
    if (!name.includes('BANK') && !name.includes('EXPRESS')) name += ' BANK';
    return name;
  }
  
  // Extract first line if it looks like a bank name
  const firstLine = block.split('\n')[0]?.trim() || '';
  if (firstLine && firstLine.length > 3 && firstLine.length < 40 && 
      !firstLine.match(/^(Account|Status|Opened|Date|ACCOUNT|NUMBER|TYPE|ENQUIRED|Sr)/i)) {
    return normalizeBankName(firstLine);
  }
  
  return null;
}

function extractAccountStatus(block) {
  if (/STATUS\s*[:\-]?\s*CLOSED/i.test(block)) return 'CLOSED';
  if (/STATUS\s*[:\-]?\s*SETTLED/i.test(block)) return 'SETTLED';
  if (/STATUS\s*[:\-]?\s*WRITTEN[\s\-]OFF/i.test(block)) return 'WRITTEN_OFF';
  if (/STATUS\s*[:\-]?\s*(?:LIVE|ACTIVE|STANDARD)/i.test(block)) return 'LIVE';
  return 'LIVE';
}

function extractOpenedDate(block) {
  // Modern format: "Opened Date31-12-2022"
  let match = block.match(/(?:Opened\s+Date|Opened\s+on)\s*[:\-]?\s*(\d{2}[-\/]\d{2}[-\/]\d{4})/i);
  if (match) return normalizeDate(match[1]);
  
  // Legacy format
  match = block.match(/OPEN(?:ED)?\s+(?:ON|DATE)\s*[:\-]?\s*(\d{1,2}[-\/]\w{3}[-\/]\d{4})/i);
  return match ? normalizeDate(match[1]) : null;
}

function extractAccountNumber(block) {
  const match = block.match(/Account\s+Number\s*[:\-]?\s*(?:XXXX)?(\d{4})/i);
  return match ? match[1] : null;
}

function extractOwnership(block) {
  // Extract ownership type (Individual, Joint, etc.)
  const match = block.match(/Ownership\s*[:\-]?\s*([^\n]+)/i);
  return match ? match[1].trim() : 'Individual';
}

function extractAmount(block, keyword) {
  // Multiple patterns to try - more flexible matching
  const patterns = [
    // Pattern 1: "EMI: ₹15,000" or "EMI 15000"
    new RegExp(`(?:${keyword})\\s*[:\\-]?\\s*₹?\\s*([\\d,]+)`, 'i'),
    // Pattern 2: "₹15,000 EMI" 
    new RegExp(`₹\\s*([\\d,]+)\\s*.*?(?:${keyword})`, 'i'),
    // Pattern 3: "EMI 15,000" with spaces
    new RegExp(`(?:${keyword})\\s*[:\\-]?\\s*([\\d,]+)\\s*(?:₹|rupee)?`, 'i'),
    // Pattern 4: Look for numbers near keyword
    new RegExp(`[^\\d]*([\\d,]+)\\s*(?:${keyword}|₹)`, 'i')
  ];
  
  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match && match[1]) {
      const num = parseInt(match[1].replace(/,/g, ''), 10);
      return num;
    }
  }
  
  return 0;
}

function extractLargestAmount(block) {
  const matches = block.match(/\b(\d{1,3}(?:,\d{2,3})+)\b/g) || [];
  let max = 0;
  for (const m of matches) {
    const val = parseInt(m.replace(/,/g, ''), 10);
    if (val > max) max = val;
  }
  return max;
}

function extractTenure(block) {
  const match = block.match(/TENURE\s*[:\-]?\s*(\d+)\s*(?:MONTHS|MOS)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function extractInterestRate(block) {
  const match = block.match(/(?:INTEREST\s+RATE|RATE)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/i);
  return match ? parseFloat(match[1]) : 0;
}

function extractMaxDPD(block) {
  const matches = block.match(/DPD\s*[:\-]?\s*(\d+)/gi) || [];
  const dpds = matches.map(m => parseInt(m.match(/(\d+)/)[1], 10));
  return dpds.length > 0 ? Math.max(...dpds) : 0;
}

/**
 * STEP 7: Calculate obligations with POLICY RULES
 */
function calculateObligationsWithRules(accounts) {
  const liveAccounts = accounts.filter(a => a.account_status === 'LIVE');
  
  let totalEMI = 0;
  let netObligation = 0;
  const excluded = {
    credit_card_upto_3L: 0,
    gold_loan_excluded: 0,
    od_flexi_1_percent: 0,
    last_6_emi_excluded: 0
  };
  
  liveAccounts.forEach(acc => {
    const emi = acc.emi_amount || 0;
    
    // Rule 1: Credit Card ≤ 3L → NOT obligated
    if (acc.account_type === 'CREDIT_CARD' && (acc.credit_limit || 0) <= 300000) {
      excluded.credit_card_upto_3L += acc.credit_limit || 0;
      return;
    }
    
    // Rule 2: Gold Loan → NOT obligated
    if (acc.account_type === 'GOLD_LOAN') {
      excluded.gold_loan_excluded += emi;
      return;
    }
    
    // Rule 3: OD/Flexi → 1% of outstanding as obligation
    if (acc.account_type === 'OVERDRAFT' || acc.account_type === 'FLEXI_LOAN') {
      const onePercent = Math.round((acc.current_outstanding || 0) * 0.01);
      netObligation += onePercent;
      excluded.od_flexi_1_percent += onePercent;
      return;
    }
    
    // Rule 4: Last 6 EMIs → NOT obligated (BT logic)
    if (acc.current_outstanding && emi > 0) {
      const remainingEMIs = Math.ceil(acc.current_outstanding / emi);
      if (remainingEMIs <= 6) {
        excluded.last_6_emi_excluded += emi;
        return;
      }
    }
    
    // Count as obligation
    netObligation += emi;
    totalEMI += emi;
  });
  
  return {
    total_monthly_emi: totalEMI + Object.values(excluded).reduce((a, b) => typeof b === 'number' ? a + b : a, 0),
    excluded_obligations: excluded,
    net_obligation_for_foir: netObligation
  };
}

/**
 * STEP 8: Extract repayment behavior & risk flags
 */
function extractRepaymentBehavior(pages, sections) {
  const text = pages.map(p => p.text).join('\n');
  
  return {
    max_dpd_12_months: extractMaxDPDFromText(text),
    ever_written_off: /WRITTEN[\s\-]OFF/i.test(text),
    ever_settled: /SETTLED/i.test(text),
    legal_flag: /LEGAL|SUIT\s+FILED/i.test(text),
    sma_status: /SMA/i.test(text)
  };
}

function extractMaxDPDFromText(text) {
  const matches = text.match(/DPD\s*[:\-]?\s*(\d+)/gi) || [];
  const dpds = matches.map(m => parseInt(m.match(/(\d+)/)[1], 10));
  return dpds.length > 0 ? Math.max(...dpds) : 0;
}

/**
 * STEP 9: Extract enquiries with filtering
 */
function extractEnquiries(pages, sections) {
  const text = getSectionText(pages, sections.enquiry_section_pages.length > 0 
    ? sections.enquiry_section_pages 
    : pages.map(p => p.page));
  
  return {
    total_enquiries_30_days: extractRecentEnquiries(text, 30),
    total_enquiries_90_days: extractRecentEnquiries(text, 90),
    ignored_enquiries: {
      topup: /TOP[\s\-]?UP/i.test(text),
      duplicate: false // Would need logic to detect duplicates
    }
  };
}

/**
 * Classify accounts for tags
 */
function classifyAccounts(accounts) {
  return {
    has_home_loan: accounts.some(a => a.account_type === 'HOME_LOAN' && a.account_status === 'LIVE'),
    has_gold_loan: accounts.some(a => a.account_type === 'GOLD_LOAN' && a.account_status === 'LIVE'),
    has_od_flexi: accounts.some(a => (a.account_type === 'OVERDRAFT' || a.account_type === 'FLEXI_LOAN') && a.account_status === 'LIVE'),
    is_ntc: accounts.filter(a => a.account_status === 'LIVE').length === 0
  };
}

/**
 * Generate final snapshot
 */
function generateSnapshot(data) {
  const score = data.credit_score.cibil_score;
  const obligations = data.obligations.net_obligation_for_foir;
  const vintage = data.credit_score.credit_vintage_months;
  const liveLoans = data.credit_score.total_live_accounts;
  
  return {
    cibil_score: score,
    risk_band: score >= 750 ? 'LOW' : score >= 700 ? 'MEDIUM' : 'HIGH',
    total_live_loans: liveLoans,
    net_monthly_obligation: obligations,
    credit_age_months: vintage,
    eligible_for_bt: score >= 700 && 
                     !data.repayment_behavior.ever_settled && 
                     !data.repayment_behavior.ever_written_off &&
                     data.repayment_behavior.max_dpd_12_months === 0
  };
}

/**
 * STEP 10: Calculate confidence score (VALIDATION)
 */
function calculateConfidence(data) {
  let score = 0;
  let maxScore = 1.0;
  
  // Personal details completeness (30%)
  if (data.personal_details.full_name !== 'UNKNOWN') score += 0.10;
  if (data.personal_details.pan) score += 0.10;
  if (data.personal_details.date_of_birth) score += 0.10;
  
  // Credit score (25%)
  if (data.credit_score.cibil_score > 0) score += 0.25;
  
  // Accounts (25%)
  if (data.credit_accounts.length > 0) score += 0.15;
  if (data.credit_accounts.length >= 3) score += 0.10;
  
  // Addresses (10%)
  if (data.addresses.length > 0) score += 0.10;
  
  // Obligations calculated (10%)
  if (data.obligations && data.obligations.net_obligation_for_foir >= 0) score += 0.10;
  
  return parseFloat(Math.min(score, maxScore).toFixed(2));
}

/**
 * Helper: Normalize date to YYYY-MM-DD
 */
function normalizeDate(dateStr) {
  try {
    // Handle formats: DD-MMM-YYYY, DD/MM/YYYY
    const monthMap = {
      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };
    
    const parts = dateStr.split(/[-\/]/);
    if (parts.length === 3) {
      let day = parts[0].padStart(2, '0');
      let month = parts[1];
      let year = parts[2];
      
      // If month is text, convert to number
      if (isNaN(month)) {
        month = monthMap[month.toUpperCase()];
      } else {
        month = month.padStart(2, '0');
      }
      
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    console.error('Date normalization error:', e);
  }
  return null;
}

/**
 * Helper: Normalize bank name
 */
function normalizeBankName(name) {
  const bankMap = {
    'HDFC': 'HDFC BANK',
    'ICICI': 'ICICI BANK',
    'AXIS': 'AXIS BANK',
    'SBI': 'STATE BANK OF INDIA',
    'KOTAK': 'KOTAK MAHINDRA BANK',
    'IDFC': 'IDFC FIRST BANK',
    'YES': 'YES BANK',
    'INDUSIND': 'INDUSIND BANK',
    'BAJAJ': 'BAJAJ FINSERV',
    'TATA': 'TATA CAPITAL'
  };
  
  const upper = name.toUpperCase().trim();
  
  // Remove ID numbers
  const cleanName = upper.replace(/\d+/g, '').trim();
  
  for (const [key, value] of Object.entries(bankMap)) {
    if (cleanName.includes(key)) {
      return value;
    }
  }
  
  return cleanName.substring(0, 50);
}

module.exports = {
  extractCibilData,
  extractCibilScore,
  extractCreditAccounts
};
