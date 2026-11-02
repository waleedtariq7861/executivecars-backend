# Executive Cars: backend

Express, MongoDB/Mongoose and Socket.IO API for Executive Cars: used-car listings, auction membership and live bidding, seller workflows, administration, document handling, payments (sandbox) and price prediction.

It is one of three separately deployed services:

| Service | Repository | Runs on |
|---|---|---|
| Web application (React, Vite) | [executivecars-frontend](https://github.com/waleedtariq7861/executivecars-frontend) | Vercel |
| **API (this repository)** | executivecars-backend | Railway |
| Valuation service (FastAPI, scikit-learn) | [executivecars-ml-service](https://github.com/waleedtariq7861/executivecars-ml-service) | Railway (private network) |

The browser talks only to the frontend's origin; Vercel forwards `/api`, `/socket.io` and `/uploads` to this API (see the frontend's `vercel.json`). The API calls the valuation service over HTTP with a shared service key (`ML_SERVICE_KEY`), both for price predictions and for the list of vehicles the model was trained on (`GET /vehicle-options`).

## Requirements

- Node.js 22 or newer (developed and tested on 24) and npm
- A MongoDB 8 replica set (transactions are used): a local Docker replica set for development and tests, MongoDB Atlas in production

## Configure

```bash
cp .env.example .env
```

At minimum set `MONGO_URI` and a strong `JWT_SECRET`. Development uses `mongodb://127.0.0.1:27017/executivecars_dev?directConnection=true&replicaSet=executivecars-local`; tests use the separate `executivecars_test` database on the same server. Add Cloudinary, e-mail and Groq credentials only when those integrations are needed. Never commit real credentials. Every variable is explained in `.env.example`.

Local defaults: frontend `http://localhost:5173`, this API `http://127.0.0.1:5082`, valuation service `http://127.0.0.1:8000`. Keep `ML_SERVICE_KEY` identical here and in the valuation service.

## Run

```bash
npm ci
npm run dev        # nodemon
npm start          # production style
```

`GET /api/health` reports `status` and the database connection.

## Tests

```bash
npm test           # node --test, needs the local replica set PRIMARY
npm run check      # syntax check of every source file
```

`npm test` defaults to `executivecars_test`; an optional `TEST_MONGO_URI` must still identify that exact database on localhost port 27017. The harness refuses Atlas, development, production and restore targets before connecting or resetting, drops the disposable database between tests, and cleans up afterwards. Do not run parallel API suites or keep development data in `executivecars_test`. The valuation service is simulated by a small local HTTP server (`test/helpers/fakeModelService.js`), so no model is needed.

## Application modes and payments

`APP_MODE=demo` selects the local FYP demonstration setup (the demo seed and development email delivery). Payments do not depend on it: auction membership is bought through a complete payment flow whose provider is the **sandbox** (`PAYMENT_PROVIDER=sandbox`). It offers three methods (card, JazzCash/Easypaisa wallet, bank transfer confirmed by an administrator), stores every attempt as a `Payment` record, activates the membership and issues a numbered invoice (`EC-INV-<year>-<number>`, printable, also emailed), and has a payments page for customers and one for administrators. It moves no money: the sandbox accepts only published test credentials (card `4242 4242 4242 4242`, wallet `03000000001`) and refuses any real card or wallet number before reading it; card numbers, CVCs and wallet numbers are never stored, only the card brand and last four digits (the wallet number masked). Every payment screen and invoice says it is a sandbox. A real provider would replace `src/services/sandboxGateway.js` behind the same payment records.

The local demo seed (`npm run seed:demo`, `seed:demo:reset`) creates its accounts from the `DEMO_*` variables in `.env.example` (defaults in `src/config/demoAccounts.js`); there is no demo-account shortcut on the sign-in pages. The seed records what it created in its own `demoseedentries` collection, so a reset removes only that and never touches real accounts.

For a real deployment, set `APP_MODE=production` and `NODE_ENV=production`; use HTTPS client origins, production email delivery, a strong secret, and keep `ENABLE_DEMO_SEED=false`. The backend validates these boundaries at startup.

For hosting on Railway (with the frontend on Vercel), follow [DEPLOYMENT.md](DEPLOYMENT.md).

## Security model

- Browser authentication uses an HttpOnly, SameSite=Strict session cookie (`__Host-ec_session` in production) holding a random token; only its SHA-256 is stored server-side in the `Session` collection, so sessions can be ended individually or all at once.
- Sessions expire after inactivity and after an absolute lifetime (customers 7 / 14 days, administrators 30 minutes / 8 hours; configurable with the `SESSION_*` variables in `.env.example`). Logging out, changing a password or resetting it revokes sessions on the server, not just in the browser.
- Passwords are stored as Argon2id hashes; an account whose password is in any other format cannot sign in until its owner resets the password. A password must be 8-128 characters, any characters allowed, not on the bundled common-password list, not built from the person's name/email or the site name, and (in production) not found in the Have I Been Pwned breach corpus. Only a 5-character hash prefix is sent to that service and an outage never blocks sign-up (`HIBP_ENABLED` overrides the default).
- Failed sign-ins are throttled per account and address in MongoDB with a growing delay (no permanent lockout), and every sign-in attempt does the same hashing work whether or not the email exists.
- Password reset works for customers and administrators with a 6-digit code mailed to the account address (no link): the code lasts 10 minutes, works once, is tied to that address and only a keyed digest is stored; five wrong guesses use it up (counted atomically, so parallel guesses cannot exceed that); a new request replaces the old code; each account may request 3 codes an hour (more are answered the same way but send nothing); every failure to complete a reset (unknown address, no code, expired, used up, wrong) gets the same answer, and the answer to a request is identical for known and unknown addresses and never waits for the mail provider. A rejected new password does not cost an attempt. Completing a reset ends every session of that account and clears its sign-in delay. Every password change or reset sends a "password changed" notice to the account address.
- Security page for customers (`/account/security`) and administrators (`/admin/security`): change password, see every device the account is signed in on and sign any other device out (or all of them), and read the account's recent activity. Account-security events (sign-up, sign-in, failed sign-in on a real account, sign-out, password change, reset requested/completed, email verified, other devices signed out, and security email that could not be delivered) are kept in an `AuthEvent` audit trail that stores no secrets (the address is masked, there are no codes or tokens) and expires after 180 days. Administrators see the whole trail with 24-hour counts under **Admin > Security**; a security email that failed to send (reset or verification code, password-changed notice, invoice) shows up there, and is never revealed to the person who asked, so the neutral answers stay neutral.
- Administrators can turn on two-step sign-in (Admin > Security): an authenticator app (any TOTP app; RFC 6238, 30-second codes, 160-bit secret) plus eight single-use recovery codes shown once. With it on, the password alone gives only a short-lived challenge (5 minutes, five guesses, no session); a session exists only after a valid code. A code cannot be used twice (the newest accepted 30-second step is remembered, and recovery codes are spent atomically), a wrong code slows the account down like a wrong password, and the password step does not reset that delay. The secret is stored encrypted (AES-256-GCM, bound to the administrator's id) and recovery codes only as keyed digests. Turning it on or off, and making new recovery codes, needs the password and a current code, and signs the other devices out. If an administrator loses both the phone and the recovery codes, someone with database access removes that administrator's document from the `adminmfas` collection; the password then signs in on its own again.
- Security hardening (2026-11 audit): public used-car listings and member auction views are built from allow-lists (no owner id, seller e-mail or reserve price; bidders see only whether a reserve exists and is met); query strings are parsed as flat text and every filter is validated, so database operators cannot be injected; e-mail addresses must match a strict pattern; booking identity documents are uploaded only after the e-mail code is confirmed and the submissions are rate limited; the booking code and the live-auction socket limit attempts atomically/by rate and the socket checks the browser `Origin`; the chat assistant accepts only bounded plain text; the stored password hash is excluded from every serialized account; ownership of a listing means its assigned account, never an e-mail match; the frontend is served with a Content-Security-Policy (no inline or third-party script, style or font; the typeface is bundled), `frame-ancestors 'none'`, `nosniff` and a strict referrer/permissions policy (`vercel.json`). `TRUST_PROXY_HOPS` must match the real proxy chain (see `.env.example`).
- Customers confirm their email address with a 6-digit code mailed to it (valid 10 minutes, 5 tries per code, one new code a minute and five a day; only a keyed digest is stored). Sign-up sends the first code and says so when it could not be sent. Until verified a customer can use the account but cannot place bids or activate auction membership (`403 EMAIL_NOT_VERIFIED`); a successful booking code also verifies the address.
- State-changing browser requests require CSRF protection (token plus Origin check).
- Auction inventory and bidding APIs enforce authenticated membership/role checks server-side.
- Private documents are served through authorized API routes rather than a public static folder.
- Secrets, local uploads, dependency folders, caches, reports, and local environment files are excluded from Git.

## Deployment

Railway (this API and the valuation service), Vercel (the frontend), MongoDB Atlas, Cloudinary and Resend: see [DEPLOYMENT.md](DEPLOYMENT.md).

## Data notes

- Generated uploads and private documents must live outside Git; in production they are stored in Cloudinary (`REQUIRE_CLOUDINARY=true`), because the host's disk is temporary.
- The training dataset and the model belong to the valuation service repository.
- `npm run seed:catalog` puts the platform's sample used cars and auctions, with photographs and sample inspection reports, into an empty database (dry run by default; see DEPLOYMENT.md, section 5b). `npm run seed:demo` is the separate local demonstration seed and refuses to run in production.
