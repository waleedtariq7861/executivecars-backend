# Deployment: Railway + Vercel + MongoDB Atlas

Three repositories, three deployments:

| Part | Repository | Where |
|---|---|---|
| Frontend | `executivecars-frontend` | Vercel |
| API | `executivecars-backend` (this repository) | Railway, public domain |
| Valuation service | `executivecars-ml-service` | Railway, **private network only** |

The API and the valuation service live in the **same Railway project and environment**, so the API reaches the valuation service at `http://<service-name>.railway.internal:<port>`. The valuation service gets no public domain.

Do the steps in this order. Values written `<like-this>` are yours; never commit them.

## 1. External services

1. **MongoDB Atlas.** A cluster, a database user, and the connection string for `MONGO_URI` with an explicit database name (`/executivecars`). Railway's outbound addresses are not fixed, so Atlas network access normally has to allow `0.0.0.0/0`; protect the database with a long random user password and a user limited to this database. (A static outbound IP is a paid Railway option.)
2. **Cloudinary.** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Railway's disk is temporary, so images and private documents must live in Cloudinary.
3. **Resend.** A verified sending domain, an API key with sending permission, and `RESEND_FROM_EMAIL` on that domain. Customers confirm their e-mail with a code, so mail must work.

## 2. Valuation service (Railway)

Repository `executivecars-ml-service` has a `Dockerfile` and `railway.json`; Railway builds it as is.

1. New service from the GitHub repository.
2. Attach a **Volume** to it, mount path `/data` (the image keeps trained models in `/data/models` and training reports in `/data/reports`). A volume lets models survive redeploys; redeploying a service that has a volume causes a short downtime.
3. Variables:

   | Variable | Value |
   |---|---|
   | `ML_SERVICE_KEY` | a long random secret (the service refuses to start without it) |
   | `PORT` | `8000` (fixed, so the private address is predictable) |

4. Do not generate a public domain.
5. **Put the model on the volume** (the model file is about 1 GB and is not in Git): see the valuation repository's README, section "Deploying the model". Until a model is active, `/health` answers `modelLoaded: false` and `/predict` answers 503.

Memory: the loaded model needs about 1.2 GB, and about 2.3 GB while loading. Size the service for the peak.

## 3. API (Railway)

1. New service in the same project from `executivecars-backend`. `railway.json` sets the start command and the health check (`/api/health`).
2. Variables:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `REQUIRE_CLOUDINARY` | `true` |
   | `EMAIL_DELIVERY_MODE` | `resend` |
   | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | from step 1 |
   | `MONGO_URI` | from step 1 |
   | `JWT_SECRET` | 32 or more random characters |
   | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | from step 1 |
   | `CLIENT_URL` | the exact HTTPS origin of the frontend, no trailing slash |
   | `ML_SERVICE_URL` | `http://<ml-service-name>.railway.internal:8000` |
   | `ML_SERVICE_KEY` | the same value as on the valuation service |
   | `TRUST_PROXY_HOPS` | `2` (Vercel in front of Railway); see step 6 |
   | `GROQ_API_KEY` | optional: the chat assistant is unavailable without it |

   The API checks these at startup and refuses to run with a placeholder secret, a non-HTTPS client origin, demo mode, and similar mistakes.
3. Generate a public domain for the API (`https://<name>.up.railway.app`). `https://<that-domain>/api/health` must answer `status: ok` and `database: connected`.

## 4. Frontend (Vercel)

1. Import `executivecars-frontend` into Vercel (framework Vite, build `npm run build`, output `dist`; the repository root is the project root).
2. In the frontend's `vercel.json` the three rewrites (`/api`, `/socket.io`, `/uploads`) must point at the Railway API's public domain. Commit that change before deploying. Leave `VITE_API_URL` and `VITE_SOCKET_URL` unset so the browser stays on the Vercel origin, which keeps the HttpOnly session cookie first-party.
3. No variable is required. Optional public contact details: `VITE_BUSINESS_CITY`, `VITE_BUSINESS_ADDRESS`, `VITE_CONTACT_PHONE`, `VITE_CONTACT_PHONE_LABEL`, `VITE_CONTACT_EMAIL`.
4. Copy the production Vercel origin into `CLIENT_URL` on the API if it differs, and redeploy the API.

## 5. First administrator

On your own computer, allow your IP in Atlas, put the production `MONGO_URI` in the ignored `.env` of this repository together with `BOOTSTRAP_ADMIN_CONFIRM=create-first-admin`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` (12 or more characters), then run `npm run bootstrap:admin`. It refuses to run if an administrator already exists. Remove the four `BOOTSTRAP_*` lines afterwards.

## 5b. Optional: the platform's sample catalogue

`scripts/seedCatalog.js` fills an **empty** database with the platform's own sample catalogue: four used cars and two car auctions (one running, one upcoming), with photos already hosted on Cloudinary (credits in the descriptions) and a **sample inspection report** (PDF) for each. It creates no accounts, bids, bookings or payments, and no listing has an owner or seller e-mail: everything belongs to the platform. It refuses to run if any used car or auction already exists, so it never overwrites or duplicates listings.

The reports are generated, not real: every page says *"SAMPLE REPORT FOR DEMONSTRATION. This vehicle was not physically inspected"*, the findings only follow the condition stated in the listing, and no inspection score is stored. They are stored exactly like a report an administrator uploads (private Cloudinary storage, opened only through the authorised document routes: signed-in members for used cars, active auction members for auctions). The script refuses to store reports on a local disk when `NODE_ENV=production`. The PDF library (`pdfkit`) is a development dependency, so run the script from a checkout of this repository after `npm ci`.

Run it from your own computer; `railway run` supplies the production variables (including `MONGO_URI` and the Cloudinary credentials) without you handling them. First a dry run, which writes nothing, and prints the target database name (check that it is `executivecars`), where reports would be stored, and the listings:

```powershell
cd <path-to>\executivecars-backend
railway run -p <project-id> -e production -s executivecars-backend node scripts/seedCatalog.js
```

Then, to write it:

```powershell
$env:CONFIRM_CATALOG_SEED = "seed-platform-catalog"
railway run -p <project-id> -e production -s executivecars-backend node scripts/seedCatalog.js --execute
Remove-Item Env:CONFIRM_CATALOG_SEED
```

The auction dates follow the day it is run (the running auction has two weeks left). To start over, delete the listings in the admin area (deleting a listing also removes its report) and run it again. The photos and reports are samples, not the exact cars, which the descriptions and the reports say.

## 6. Verify

1. The Vercel URL and a deep link such as `/used-cars` load.
2. `https://<vercel-host>/api/health` shows `database: connected` (a 404 or HTML page means the rewrite target is wrong).
3. Register an account: the verification code mail arrives. Sign out, sign in, refresh `/account`. A 403 on mutations means `CLIENT_URL` differs from the address bar's origin.
4. Open the security page (or Admin > Security) and compare the address shown in "Recent activity" with your real public address. If it shows a Vercel or Railway address, change `TRUST_PROXY_HOPS`; a wrong value makes every visitor share one rate-limit bucket.
5. Open the price predictor, choose a make and model (the list comes from the valuation service) and request an estimate.
6. Open the site with the browser console open: there must be no "Content Security Policy" violations.
7. Two browser sessions on a live auction: bids appear in both (Socket.IO over HTTP polling through the Vercel rewrite; WebSocket upgrades through Vercel rewrites are unverified).
8. Upload a listing image and confirm it survives a redeploy (Cloudinary).
9. Sandbox payment: card `4242 4242 4242 4242` activates a membership and produces an invoice.

## Notes

- Auction closing runs inside the API process every minute and catches up after a restart.
- Rate limits are kept per API process. Run one API instance, or move them to a shared store before scaling out.
- Costs are usage based on Railway; the valuation service's memory dominates.
