/**
 * FiClear AI Eligibility Engine v2
 * Maps parsed CIBIL data → Normalized Credit Profile → Bank-specific Eligibility
 * 
 * Flow:
 * 1. Normalize CIBIL parsed data
 * 2. Merge with customer profile
 * 3. Calculate FOIR and available EMI
 * 4. Apply bank policies
 * 5. Generate eligibility results with rejection reasons
 */

// ========================================
// 1️⃣ NORMALIZE CIBIL DATA TO CREDIT PROFILE
// ========================================

/**
 * Converts parsed CIBIL JSON to normalized credit profile
 * @param {Object} parsedCibil - Output from cibil-extractor.js
 * @returns {Object} - Normalized credit profile for engine
 */
function normalizeCreditProfile(parsedCibil) {
  const creditScore = parsedCibil.credit_score || {};
  const accounts = parsedCibil.credit_accounts || [];
  const repayment = parsedCibil.repayment_behavior || {};
  const enquiries = parsedCibil.enquiries || {};

  // Calculate total obligations (only obligated EMIs)
  const netMonthlyObligation = accounts
    .filter(acc => acc.is_obligated === true)
    .reduce((sum, acc) => sum + (acc.emi_amount || 0), 0);

  // Count live loans
  const totalLiveLoans = accounts.filter(acc => acc.account_status === 'LIVE').length;

  // Check for specific loan types
  const hasHomeLoan = accounts.some(acc => 
    acc.account_type === 'HOME_LOAN' && acc.account_status === 'LIVE'
  );
  const hasODFlexi = accounts.some(acc => 
    (acc.account_type === 'OVERDRAFT' || acc.account_type === 'FLEXI_LOAN') && 
    acc.account_status === 'LIVE'
  );

  // Determine if NTC (New To Credit)
  const creditAgeMonths = creditScore.credit_vintage_months || 0;
  const isNTC = creditAgeMonths < 6 || totalLiveLoans === 0;

  // Determine risk band based on CIBIL score and DPD
  const cibilScore = creditScore.cibil_score || 0;
  const maxDPD12m = repayment.max_dpd_12m || 0;
  const riskBand = determineRiskBand(cibilScore, maxDPD12m, repayment);

  return {
    cibil_score: cibilScore,
    risk_band: riskBand,
    credit_age_months: creditAgeMonths,
    total_live_loans: totalLiveLoans,
    net_monthly_obligation: Math.round(netMonthlyObligation),
    max_dpd_12m: maxDPD12m,
    enquiries_30_days: enquiries.total_enquiries_30_days || 0,
    enquiries_90_days: enquiries.total_enquiries_90_days || 0,
    has_home_loan: hasHomeLoan,
    has_od_flexi: hasODFlexi,
    is_ntc: isNTC,
    has_writeoff: repayment.has_writeoff || false,
    has_settlement: repayment.has_settlement || false,
    has_restructured: repayment.has_restructured || false,
    legal_status_flag: repayment.legal_status_flag || false
  };
}

/**
 * Determine risk band based on CIBIL score, DPD, and negative flags
 */
function determineRiskBand(cibilScore, maxDPD12m, repayment) {
  // Immediate HIGH risk conditions
  if (repayment.has_writeoff || repayment.has_settlement || repayment.legal_status_flag) {
    return 'HIGH';
  }

  // Score-based risk bands with DPD consideration
  if (cibilScore >= 750 && maxDPD12m === 0) return 'LOW';
  if (cibilScore >= 700 && maxDPD12m <= 30) return 'MEDIUM';
  if (cibilScore >= 650 && maxDPD12m <= 60) return 'MEDIUM_HIGH';
  
  return 'HIGH';
}

// ========================================
// 2️⃣ CREATE ELIGIBILITY ENGINE INPUT
// ========================================

/**
 * Merges customer profile, normalized credit, and loan request into engine input
 * @param {Object} customerProfile - From frontend (age, company, salary, etc.)
 * @param {Object} normalizedCredit - Output from normalizeCreditProfile()
 * @param {Object} loanRequest - Product type and tenure preferences
 * @returns {Object} - Complete eligibility engine input
 */
function createEligibilityInput(customerProfile, normalizedCredit, loanRequest) {
  return {
    customer: {
      age: customerProfile.age,
      company_category: customerProfile.company_category,
      location_type: customerProfile.location_type || 'STANDARD',
      city_tier: customerProfile.city_tier || 'TIER_2',
      net_salary: customerProfile.net_salary,
      salary_mode: customerProfile.salary_mode || 'BANK_TRANSFER',
      employment_type: customerProfile.employment_type || 'SALARIED',
      company_name: customerProfile.company_name
    },
    credit: normalizedCredit,
    loan_request: {
      product: loanRequest.product || 'PL',
      preferred_tenure_years: loanRequest.preferred_tenure_years || 5,
      requested_amount: loanRequest.requested_amount || null
    },
    timestamp: new Date().toISOString()
  };
}

// ========================================
// 3️⃣ FOIR CALCULATION ENGINE
// ========================================

/**
 * Calculate FOIR-based available EMI
 * @param {Number} netSalary - Monthly net salary
 * @param {Number} netMonthlyObligation - Existing EMI obligations
 * @param {Number} foirPercent - FOIR percentage (default 60%)
 * @returns {Object} - FOIR calculation results
 */
function calculateFOIR(netSalary, netMonthlyObligation, foirPercent = 60) {
  const allowedEMI = Math.round((netSalary * foirPercent) / 100);
  const availableEMI = Math.max(0, allowedEMI - netMonthlyObligation);

  return {
    net_salary: netSalary,
    foir_percent: foirPercent,
    allowed_emi: allowedEMI,
    current_obligation: netMonthlyObligation,
    available_emi: availableEMI,
    foir_utilization: netSalary > 0 ? Math.round((netMonthlyObligation / allowedEMI) * 100) : 0
  };
}

// ========================================
// 4️⃣ EMI SLAB CONVERSION
// ========================================

/**
 * Convert available EMI to loan amounts for different products
 * Standard EMI multipliers (per ₹1000 loan):
 * - PL 5Y: ₹1950/lakh
 * - PL 6Y: ₹2150/lakh
 * - OD: ₹2250/lakh
 */
const EMI_SLABS = {
  PL_5Y: 1950,  // EMI per lakh for 5-year PL @ ~12%
  PL_6Y: 2150,  // EMI per lakh for 6-year PL @ ~12%
  PL_7Y: 2300,  // EMI per lakh for 7-year PL @ ~12%
  OD: 2250,     // EMI per lakh for OD (1% + 1.25% buffer)
  BL_5Y: 2000,  // Business loan 5Y
  BL_7Y: 2350   // Business loan 7Y
};

/**
 * Convert available EMI to loan amounts across all products
 * @param {Number} availableEMI - Available monthly EMI after obligations
 * @returns {Object} - Loan amounts for each product
 */
function convertEMIToLoanAmount(availableEMI) {
  const eligibility = {};

  Object.keys(EMI_SLABS).forEach(product => {
    const emiPerLakh = EMI_SLABS[product];
    const loanInLakhs = availableEMI / emiPerLakh;
    const loanAmount = Math.round(loanInLakhs * 100000);
    eligibility[product] = loanAmount;
  });

  return eligibility;
}

// ========================================
// 5️⃣ BANK POLICY APPLICATION
// ========================================

/**
 * Apply bank-specific hard rules and policy checks
 * @param {Object} eligibilityInput - Complete eligibility engine input
 * @param {Object} bankPolicy - Bank-specific policy configuration
 * @returns {Object} - Bank eligibility result with pass/fail and reasons
 */
function applyBankPolicy(eligibilityInput, bankPolicy) {
  const customer = eligibilityInput.customer;
  const credit = eligibilityInput.credit;
  const loanRequest = eligibilityInput.loan_request;

  const rejectionReasons = [];
  let eligible = true;

  // Check hard rules
  const rules = bankPolicy.hard_rules || {};

  // Minimum CIBIL score
  if (rules.min_cibil_score && credit.cibil_score < rules.min_cibil_score) {
    eligible = false;
    rejectionReasons.push(`CIBIL score ${credit.cibil_score} below minimum ${rules.min_cibil_score}`);
  }

  // Minimum salary
  if (rules.min_salary && customer.net_salary < rules.min_salary) {
    eligible = false;
    rejectionReasons.push(`Salary ₹${customer.net_salary} below minimum ₹${rules.min_salary}`);
  }

  // Company category restrictions
  if (rules.allowed_company_categories && 
      !rules.allowed_company_categories.includes(customer.company_category)) {
    eligible = false;
    rejectionReasons.push(`Company category ${customer.company_category} not allowed`);
  }

  // Credit age minimum
  if (rules.min_credit_age_months && credit.credit_age_months < rules.min_credit_age_months) {
    eligible = false;
    rejectionReasons.push(`Credit vintage ${credit.credit_age_months} months below minimum ${rules.min_credit_age_months}`);
  }

  // NTC restrictions
  if (rules.ntc_allowed === false && credit.is_ntc) {
    eligible = false;
    rejectionReasons.push('New to credit not allowed');
  }

  // DPD restrictions
  if (rules.max_dpd_allowed !== undefined && credit.max_dpd_12m > rules.max_dpd_allowed) {
    eligible = false;
    rejectionReasons.push(`DPD ${credit.max_dpd_12m} exceeds maximum ${rules.max_dpd_allowed}`);
  }

  // Negative flags
  if (rules.allow_writeoff === false && credit.has_writeoff) {
    eligible = false;
    rejectionReasons.push('Write-off detected');
  }

  if (rules.allow_settlement === false && credit.has_settlement) {
    eligible = false;
    rejectionReasons.push('Settlement detected');
  }

  if (rules.allow_legal_status === false && credit.legal_status_flag) {
    eligible = false;
    rejectionReasons.push('Legal status flag detected');
  }

  // Enquiry limits
  if (rules.max_enquiries_30_days && credit.enquiries_30_days > rules.max_enquiries_30_days) {
    eligible = false;
    rejectionReasons.push(`${credit.enquiries_30_days} enquiries in 30 days exceeds limit ${rules.max_enquiries_30_days}`);
  }

  // Age restrictions
  if (rules.min_age && customer.age < rules.min_age) {
    eligible = false;
    rejectionReasons.push(`Age ${customer.age} below minimum ${rules.min_age}`);
  }

  if (rules.max_age && customer.age > rules.max_age) {
    eligible = false;
    rejectionReasons.push(`Age ${customer.age} above maximum ${rules.max_age}`);
  }

  return {
    eligible,
    rejection_reasons: rejectionReasons,
    policy_checks_passed: rejectionReasons.length === 0
  };
}

/**
 * Calculate bank-specific FOIR and caps
 * @param {Object} eligibilityInput - Complete eligibility engine input
 * @param {Object} bankPolicy - Bank-specific policy configuration
 * @returns {Object} - Adjusted FOIR and eligibility amounts
 */
function calculateBankSpecificEligibility(eligibilityInput, bankPolicy) {
  const customer = eligibilityInput.customer;
  const credit = eligibilityInput.credit;

  // Determine FOIR based on bank policy
  let foirPercent = bankPolicy.default_foir || 60;

  // Adjust FOIR based on company category
  if (bankPolicy.foir_by_category && bankPolicy.foir_by_category[customer.company_category]) {
    foirPercent = bankPolicy.foir_by_category[customer.company_category];
  }

  // Adjust FOIR based on CIBIL score
  if (bankPolicy.foir_by_cibil_band) {
    if (credit.cibil_score >= 750 && bankPolicy.foir_by_cibil_band.high) {
      foirPercent = Math.max(foirPercent, bankPolicy.foir_by_cibil_band.high);
    } else if (credit.cibil_score >= 700 && bankPolicy.foir_by_cibil_band.medium) {
      foirPercent = Math.max(foirPercent, bankPolicy.foir_by_cibil_band.medium);
    }
  }

  // Calculate FOIR
  const foirResult = calculateFOIR(customer.net_salary, credit.net_monthly_obligation, foirPercent);

  // Convert to loan amounts
  let eligibility = convertEMIToLoanAmount(foirResult.available_emi);

  // Apply caps
  if (bankPolicy.max_loan_amount) {
    Object.keys(eligibility).forEach(product => {
      const cap = bankPolicy.max_loan_amount[product] || bankPolicy.max_loan_amount.default;
      if (cap) {
        eligibility[product] = Math.min(eligibility[product], cap);
      }
    });
  }

  // Apply salary multiplier caps
  if (bankPolicy.max_salary_multiplier) {
    const maxByMultiplier = customer.net_salary * bankPolicy.max_salary_multiplier;
    Object.keys(eligibility).forEach(product => {
      eligibility[product] = Math.min(eligibility[product], maxByMultiplier);
    });
  }

  return {
    foir_result: foirResult,
    eligibility,
    foir_percent_applied: foirPercent
  };
}

/**
 * Calculate approval probability based on profile strength
 * @param {Object} eligibilityInput - Complete eligibility engine input
 * @param {Object} bankPolicy - Bank-specific policy configuration
 * @returns {Number} - Approval probability (0-100)
 */
function calculateApprovalProbability(eligibilityInput, bankPolicy) {
  const credit = eligibilityInput.credit;
  const customer = eligibilityInput.customer;

  let score = 50; // Base score

  // CIBIL score impact (max +30)
  if (credit.cibil_score >= 750) score += 30;
  else if (credit.cibil_score >= 700) score += 20;
  else if (credit.cibil_score >= 650) score += 10;

  // DPD impact (max +10)
  if (credit.max_dpd_12m === 0) score += 10;
  else if (credit.max_dpd_12m <= 30) score += 5;

  // Company category impact (max +10)
  if (customer.company_category === 'CAT_A') score += 10;
  else if (customer.company_category === 'CAT_B') score += 5;

  // Credit vintage impact (max +10)
  if (credit.credit_age_months >= 60) score += 10;
  else if (credit.credit_age_months >= 36) score += 5;

  // Salary mode impact (max +5)
  if (customer.salary_mode === 'BANK_TRANSFER') score += 5;

  // Negative impacts
  if (credit.has_writeoff) score -= 30;
  if (credit.has_settlement) score -= 20;
  if (credit.has_restructured) score -= 15;
  if (credit.enquiries_30_days > 3) score -= 10;

  return Math.min(100, Math.max(0, score));
}

// ========================================
// 6️⃣ MAIN ELIGIBILITY ENGINE FUNCTION
// ========================================

/**
 * Complete eligibility calculation across all banks
 * @param {Object} parsedCibil - Output from cibil-extractor.js
 * @param {Object} customerProfile - Customer information from frontend
 * @param {Object} loanRequest - Loan request details
 * @param {Array} bankPolicies - Array of bank policy configurations
 * @returns {Object} - Complete eligibility results with audit trail
 */
async function calculateEligibility(parsedCibil, customerProfile, loanRequest, bankPolicies) {
  // Step 1: Normalize CIBIL data
  const normalizedCredit = normalizeCreditProfile(parsedCibil);

  // Step 2: Create engine input
  const eligibilityInput = createEligibilityInput(customerProfile, normalizedCredit, loanRequest);

  // Step 3: Process each bank
  const bankResults = [];

  for (const bankPolicy of bankPolicies) {
    const bankName = bankPolicy.bank_name;

    // Check hard rules
    const policyCheck = applyBankPolicy(eligibilityInput, bankPolicy);

    if (!policyCheck.eligible) {
      // Bank rejected - store rejection reasons
      bankResults.push({
        bank: bankName,
        eligible: false,
        rejection_reasons: policyCheck.rejection_reasons,
        approval_probability: 0
      });
      continue;
    }

    // Calculate eligibility
    const eligibilityCalc = calculateBankSpecificEligibility(eligibilityInput, bankPolicy);

    // Calculate approval probability
    const approvalProbability = calculateApprovalProbability(eligibilityInput, bankPolicy);

    // Store bank result
    bankResults.push({
      bank: bankName,
      eligible: true,
      available_emi: eligibilityCalc.foir_result.available_emi,
      foir_percent: eligibilityCalc.foir_percent_applied,
      eligibility: eligibilityCalc.eligibility,
      approval_probability: approvalProbability,
      recommended: approvalProbability >= 70
    });
  }

  // Sort by approval probability (highest first)
  bankResults.sort((a, b) => (b.approval_probability || 0) - (a.approval_probability || 0));

  // Return complete results with audit trail
  return {
    success: true,
    timestamp: new Date().toISOString(),
    
    // Input snapshot (for audit)
    audit_trail: {
      parsed_cibil_snapshot: {
        cibil_score: parsedCibil.credit_score?.cibil_score,
        total_accounts: parsedCibil.credit_accounts?.length,
        confidence_score: parsedCibil.confidence_score
      },
      normalized_credit_profile: normalizedCredit,
      eligibility_engine_input: eligibilityInput
    },

    // Results
    normalized_credit: normalizedCredit,
    bank_results: bankResults,
    total_banks_checked: bankPolicies.length,
    eligible_banks_count: bankResults.filter(b => b.eligible).length,
    
    // Best recommendation
    best_recommendation: bankResults.find(b => b.eligible) || null
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  normalizeCreditProfile,
  createEligibilityInput,
  calculateFOIR,
  convertEMIToLoanAmount,
  applyBankPolicy,
  calculateBankSpecificEligibility,
  calculateApprovalProbability,
  calculateEligibility,
  EMI_SLABS
};
