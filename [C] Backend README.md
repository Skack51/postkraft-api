# PostKraft API — Backend

Node.js/Express server handling auth, billing, OAuth, and AI for the PostKraft SaaS.

---

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js + Express |
| Database | PostgreSQL (via Railway) |
| Auth | JWT + bcrypt |
| Billing | Stripe Subscriptions |
| OAuth | Meta (FB/IG) + LinkedIn proxy |
| AI | Anthropic Claude API |
| Hosting | Railway |

---

## Local Setup

```bash
cd backend
npm install
cp .env.example .env
# Fill in .env with your keys (see sections below)

# Create DB tables (requires psql or Railway query console)
psql $DATABASE_URL < db/schema.sql

npm run dev
# Server runs on http://localhost:3000
```

---

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Railway → Postgres plugin → Connect tab |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `STRIPE_SECRET_KEY` | dashboard.stripe.com → API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe CLI: `stripe listen --forward-to localhost:3000/billing/webhook` |
| `STRIPE_PRICE_ID` | dashboard.stripe.com → Products → PostKraft $79/mo |
| `META_APP_ID` + `META_APP_SECRET` | developers.facebook.com → your app |
| `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` | linkedin.com/developers → your app |
| `ANTHROPIC_API_KEY` | console.anthropic.com |

---

## API Endpoints

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Get JWT token |
| GET | `/auth/me` | JWT | Get current user |
| POST | `/auth/change-password` | JWT | Change password |

### Billing
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/billing/subscribe` | JWT | Create Stripe Checkout session |
| GET | `/billing/status` | JWT | Get subscription status |
| POST | `/billing/portal` | JWT | Open Stripe Customer Portal |
| POST | `/billing/webhook` | Stripe sig | Handle Stripe events |

### OAuth (requires active subscription)
| Method | Path | Description |
|---|---|---|
| GET | `/oauth/meta/start` | Begin Meta OAuth flow |
| GET | `/oauth/meta/callback` | Meta OAuth callback |
| GET | `/oauth/meta/token` | Get stored Meta token |
| DELETE | `/oauth/meta/disconnect` | Remove Meta connection |
| GET | `/oauth/linkedin/start` | Begin LinkedIn OAuth flow |
| GET | `/oauth/linkedin/callback` | LinkedIn OAuth callback |
| GET | `/oauth/linkedin/token` | Get stored LinkedIn token |
| DELETE | `/oauth/linkedin/disconnect` | Remove LinkedIn connection |

### AI (requires active subscription)
| Method | Path | Description |
|---|---|---|
| POST | `/ai/caption` | Generate captions from photo |

---

## Deploy to Railway

1. Push this `backend/` folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add a Postgres plugin (Railway dashboard → + → Database → Postgres)
4. Set all environment variables in Railway → Variables tab
5. Run the schema: Railway → Postgres → Query → paste `db/schema.sql`
6. Copy your Railway domain (e.g. `postkraft-api.railway.app`)
7. Update `META_REDIRECT_URI` and `LINKEDIN_REDIRECT_URI` in Railway vars to use that domain
8. Add the same redirect URIs to your Meta and LinkedIn developer apps

Railway auto-deploys on every git push to main. 

---

## Stripe Webhook Setup

**Development:**
```bash
stripe login
stripe listen --forward-to localhost:3000/billing/webhook
# Copy the webhook signing secret and put it in STRIPE_WEBHOOK_SECRET
```

**Production:**
- Stripe Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://your-railway-domain.railway.app/billing/webhook`
- Events to listen for:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

---

## Subscription Flow (end-to-end)

1. User registers in Electron app → `POST /auth/register` → gets JWT
2. User clicks Subscribe → `POST /billing/subscribe` → gets Stripe Checkout URL
3. Electron opens URL in browser → user enters card → Stripe processes
4. Stripe fires `checkout.session.completed` webhook → DB updated to `active`/`trialing`
5. Electron calls `GET /billing/status` → sees active → unlocks app features
6. On subsequent launches: `POST /auth/login` → `GET /billing/status` → proceed

---

## File Structure

```
backend/
  server.js           — Express app entry point
  railway.json        — Railway deploy config
  .env.example        — Environment variable template
  package.json
  db/
    schema.sql        — Postgres table definitions (run once)
    index.js          — pg connection pool
  routes/
    auth.js           — Register, login, me, change-password
    billing.js        — Stripe checkout, webhook, portal
    oauth.js          — Meta + LinkedIn OAuth proxy
    ai.js             — Claude API proxy (caption generation)
  middleware/
    requireAuth.js    — JWT verification
    requireSubscription.js — Active/trialing subscription check
  lib/
    jwt.js            — Token signing helper
    stripe.js         — Stripe singleton
```
