/**
 * AI-POWERED CIBIL ANALYZER
 * Uses Anthropic Claude to analyze CIBIL reports and calculate eligibility
 * 
 * Features:
 * 1. Intelligent PDF text parsing using AI
 * 2. Structured data extraction
 * 3. Risk assessment
 * 4. Eligibility calculation with AI reasoning
 */

const Anthropic = require('@anthropic-ai/sdk');

// Initialize Anthropic client for Claude API
let client = null;
const apiKey = process.env.OPENAI_API_KEY; // Using OPENAI_API_KEY for Anthropic key (for compatibility)
const aiEnabled = apiKey && process.env.AI_ENABLED !== 'false';

if (aiEnabled) {
  try {
    client = new Anthropic({
      apiKey: apiKey
    });
    console.log('✅ AI Features Enabled - Anthropic Claude client initialized');
  } catch (error) {
    console.error('❌ Failed to initialize AI client:', error.message);
    console.log('⚠️  AI Features will be disabled');
  }
} else {
  console.log('⚠️  AI Features Disabled - OPENAI_API_KEY not configured');
}

async function analyzeCibilWithAI(pdfText, reportSource = 'CIBIL') {
  try {
    if (!aiEnabled || !client) {
      throw new Error('AI features not enabled. Set OPENAI_API_KEY in .env');
    }

    console.log('🤖 AI: Starting CIBIL analysis...');

    const prompt = `You are a credit analysis expert. Analyze the following CIBIL report and extract structured financial data.

REPORT TEXT:
${pdfText.substring(0, 4000)}

Please extract and return VALID JSON with this exact structure (no markdown, just JSON):
{
  "personal_info": {
    "name": "Full Name",
    "pan": "PAN card number",
    "dob": "DD-MM-YYYY",
    "mobile": "10-digit number",
    "email": "email address"
  },
  "credit_score": {
    "cibil_score": 750,
    "score_band": "GOOD",
    "report_date": "DD-MM-YYYY",
    "credit_vintage_months": 60
  },
  "tradelines": [
    {
      "bank": "Bank Name",
      "account_type": "Personal Loan",
      "ownership": "Individual",
      "sanction_amount": 500000,
      "current_balance": 300000,
      "emi_amount": 10000,
      "opened_date": "DD-MM-YYYY",
      "status": "LIVE",
      "dpd_count": 0,
      "last_payment_date": "DD-MM-YYYY"
    }
  ],
  "credit_enquiries": {
    "enquiries_30_days": 1,
    "enquiries_90_days": 3,
    "enquiries_12_months": 8
  },
  "repayment_health": {
    "max_dpd_12m": 0,
    "delinquencies": 0,
    "defaults": false,
    "summary": "Excellent payment history"
  },
  "risk_assessment": {
    "risk_level": "LOW",
    "key_concerns": [],
    "strengths": [
      "Good credit score",
      "No delinquencies",
      "Regular payments"
    ]
  }
}

Return ONLY valid JSON, no other text.`;

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const content = response.content[0].text;
    console.log('🤖 AI Response received');

    // Parse JSON response
    let parsedData;
    try {
      parsedData = JSON.parse(content);
    } catch (e) {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse AI response as JSON');
      }
    }

    // Build structured result
    const result = {
      success: true,
      source: 'AI_ANALYZER',
      cibil_data: {
        credit_score: {
          cibil_score: parsedData.credit_score?.cibil_score || 0,
          score_band: parsedData.credit_score?.score_band || 'UNKNOWN',
          credit_vintage_months: parsedData.credit_score?.credit_vintage_months || 0,
          report_date: parsedData.credit_score?.report_date
        },
        personal_details: {
          full_name: parsedData.personal_info?.name || 'UNKNOWN',
          pan: parsedData.personal_info?.pan,
          dob: parsedData.personal_info?.dob,
          mobile: parsedData.personal_info?.mobile,
          email: parsedData.personal_info?.email
        },
        credit_accounts: (parsedData.tradelines || []).map(acc => ({
          bank_name: acc.bank || 'Unknown',
          account_type: acc.account_type || 'UNKNOWN',
          loan_amount: acc.sanction_amount || 0,
          current_outstanding: acc.current_balance || 0,
          emi_amount: acc.emi_amount || 0,
          opened_date: acc.opened_date,
          account_status: acc.status || 'UNKNOWN',
          dpd_12m: acc.dpd_count || 0,
          last_payment_date: acc.last_payment_date,
          is_obligated: (acc.emi_amount || 0) > 0
        })),
        enquiries: {
          total_enquiries_30_days: parsedData.credit_enquiries?.enquiries_30_days || 0,
          total_enquiries_90_days: parsedData.credit_enquiries?.enquiries_90_days || 0,
          total_enquiries_12_months: parsedData.credit_enquiries?.enquiries_12_months || 0
        },
        repayment_behavior: {
          max_dpd_12m: parsedData.repayment_health?.max_dpd_12m || 0,
          delinquencies: parsedData.repayment_health?.delinquencies || 0,
          defaults: parsedData.repayment_health?.defaults || false,
          summary: parsedData.repayment_health?.summary || 'N/A'
        },
        risk_assessment: {
          risk_level: parsedData.risk_assessment?.risk_level || 'UNKNOWN',
          concerns: parsedData.risk_assessment?.key_concerns || [],
          strengths: parsedData.risk_assessment?.strengths || []
        },
        obligations: {
          total_emi_from_cibil: (parsedData.tradelines || []).reduce((sum, acc) => sum + (acc.emi_amount || 0), 0),
          net_obligation_for_foir: (parsedData.tradelines || []).reduce((sum, acc) => sum + (acc.emi_amount || 0), 0)
        }
      }
    };

    console.log('✅ AI Analysis complete');
    return result;
  } catch (error) {
    console.error('❌ AI Analysis error:', error.message);
    throw error;
  }
}

async function calculateAIEligibility(cibilData, customerProfile = {}) {
  try {
    if (!aiEnabled || !client) {
      throw new Error('AI features not enabled');
    }

    console.log('🤖 AI: Calculating eligibility...');

    const creditScore = cibilData.credit_score?.cibil_score || 0;
    const netEMI = cibilData.obligations?.net_obligation_for_foir || 0;
    const salary = customerProfile.net_salary || 50000;

    const prompt = `Based on the following financial profile, provide eligibility assessment for personal loans:

Credit Score: ${creditScore}
Monthly EMI: ₹${netEMI.toLocaleString('en-IN')}
Monthly Salary: ₹${salary.toLocaleString('en-IN')}
Company: ${customerProfile.company_name || 'Unknown'}
Employment Type: ${customerProfile.employment_type || 'Salaried'}

Provide response as JSON:
{
  "eligibility_status": "APPROVE/REVIEW/REJECT",
  "risk_rating": "LOW/MEDIUM/HIGH",
  "foir_percent": 35.5,
  "available_emi": 25000,
  "approval_probability": 85,
  "recommended_products": {
    "personal_loan_5y": {
      "max_amount": 750000,
      "monthly_emi": 15000,
      "approval_probability": 95
    }
  },
  "reasoning": "Brief explanation",
  "conditions": ["List", "of", "conditions"],
  "processing_days": 3
}`;

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const content = response.content[0].text;

    let parsedData;
    try {
      parsedData = JSON.parse(content);
    } catch (e) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse AI eligibility response');
      }
    }

    console.log('✅ AI Eligibility calculation complete');

    return {
      success: true,
      eligibility: parsedData
    };
  } catch (error) {
    console.error('❌ AI Eligibility error:', error.message);
    throw error;
  }
}

async function getAIInsights(cibilData) {
  try {
    if (!aiEnabled || !client) {
      throw new Error('AI features not enabled');
    }

    const creditScore = cibilData.credit_score?.cibil_score || 0;
    const accounts = cibilData.credit_accounts || [];
    const dpd = accounts.reduce((max, acc) => Math.max(max, acc.dpd_12m || 0), 0);

    const prompt = `Based on this credit profile, provide insights and recommendations:
- CIBIL Score: ${creditScore}
- Active Accounts: ${accounts.length}
- Max DPD: ${dpd}
- Payment History: ${accounts.filter(a => a.dpd_12m === 0).length}/${accounts.length} accounts with 0 DPD

Provide as JSON:
{
  "insights": ["insight 1", "insight 2"],
  "recommendations": ["recommendation 1", "recommendation 2"],
  "next_steps": ["step 1", "step 2"]
}`;

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const content = response.content[0].text;

    let parsedData;
    try {
      parsedData = JSON.parse(content);
    } catch (e) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse AI insights');
      }
    }

    return parsedData;
  } catch (error) {
    console.warn('⚠️  AI Insights failed:', error.message);
    return {
      insights: ['Unable to generate AI insights'],
      recommendations: [],
      next_steps: []
    };
  }
}

module.exports = {
  analyzeCibilWithAI,
  calculateAIEligibility,
  getAIInsights
};
