# Company Checker Proxy

Lightweight Node.js proxy to query a Postgres database (e.g., Supabase) and expose a secure company search endpoint.

Setup

1. Install dependencies:

```bash
cd server
npm install
```

2. Copy `.env.example` -> `.env` and fill `DB_PASSWORD` and `API_KEY`.

3. Run:

```bash
npm start
```

Usage

GET /api/company?q=COMPANY_NAME

Include header `x-api-key` with the `API_KEY` value from `.env`.

Notes
- Adjust the SQL table name/columns in `server.js` if your companies table has a different schema.
- Do NOT commit real credentials to the repo.
