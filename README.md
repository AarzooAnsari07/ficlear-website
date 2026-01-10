# FiClear Fintech Website

A modern fintech platform with loan eligibility checking, policy details, and admin dashboard.

## Features

- 💰 Loan Eligibility Checker
- 📍 PIN Code Serviceability
- 🏢 Company Information Lookup
- 📋 Policy Details & Terms
- 👤 Admin Dashboard
- 💬 Contact & Support

## Live Demo

[Visit FiClear](https://ficlear-website.vercel.app)

## Tech Stack

- **Frontend:** HTML, CSS, Tailwind CSS, JavaScript
- **Backend:** Node.js, Express.js
- **Database:** Supabase PostgreSQL
- **Hosting:** Vercel

## Local Development

```bash
# Install dependencies
npm install
cd server && npm install

# Start backend server
cd server
npm start

# Server runs on http://localhost:3000
```

## Environment Variables

Create `.env` file in the `server/` folder with:

```
DB_HOST=your-supabase-host
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=your-password
DB_SSL=true
API_KEY=your-api-key
```

## Project Structure

```
├── index.html                 # Home page
├── AdminLogin.html           # Admin login page
├── PolicyDetails.html        # Policy information
├── CompanyChecker.html       # Company lookup
├── PINCodeChecker.html       # Serviceability check
├── styles.css                # Global styles
├── server/                   # Backend server
│   ├── server.js            # Express server
│   └── .env                 # Environment config
└── assets/                   # JavaScript & resources
```

## GitHub Repository

[AarzooAnsari07/ficlear-website](https://github.com/AarzooAnsari07/ficlear-website)

## License

All rights reserved © 2026 FiClear
