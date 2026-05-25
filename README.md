# GRIT Data Engine — MMA Ingestion Pipeline

> 🕒 **Last Updated:** 2026-05-23 by Claudio (Senior CTO)
> 📍 **Current Status:** Manual Ingestion Mode active. Agents 1/2/3/7 are disabled (`MANUAL_INGESTION_MODE = True` in `backend/app/agents/pipeline_manager.py:20`). Agents 4 (Intelligence), 6 (Odds), and the Event Fight Reconciler are LIVE on schedule. Manual ingestion via the operator dashboard (`frontend/src/pages/ManualIngest.tsx`) is the production data path.
> 🧪 **Build State:** CORS now restricted to localhost dev origins (was wildcard) · `event_fight_reconciler.py:346` `TypeError` fixed earlier this week · `.env.example` updated to match real env vars used in code.

The Data Engine is a multi-agent system for collecting, verifying, and enriching MMA fighter data, then pushing clean records to the GRIT main application via webhook.

---

## 🚀 Tomorrow's Testing Checklist

Use this when you sit down to test the pipeline end-to-end.

### Prereqs (do once)
1. **Python 3.11+** installed (`python --version`)
2. From `backend/`, install deps: `pip install -r requirements.txt` (or `uv pip install -r requirements.txt`)
3. **Configure `.env`** in `backend/` — copy `.env.example` and fill in real values:
   - `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (same Supabase project as gritapp; us-west-2)
   - `ANTHROPIC_API_KEY` (for verification + AI briefs + intel parsing)
   - `OPENAI_API_KEY` (for Agent 7 DALL-E 3 portraits — Agent 7 is currently skipped but the key is needed when you re-enable)
   - `BRAVE_API_KEY` (Brave Search for URL discovery)
   - `DATA_ENGINE_API_KEY` — must MATCH the value in gritapp's `.env`
   - `MAIN_APP_API_URL=http://localhost:3001` (or the Railway URL when gritapp is deployed)

### Boot
```bash
# Backend (FastAPI on port 8000)
cd backend
python -m uvicorn app.main:app --host localhost --port 8000 --reload

# Frontend (operator dashboard, Vite, port 5000)
cd frontend
npm install
npm run dev
```

### Smoke checks (do in order)
1. **Health:** open `http://localhost:8000/` → expect `{"status":"ok"}` or similar
2. **Connection test:** open `http://localhost:8000/pipeline/test-connection` → all 5 checks should pass (Supabase, Sherdog scraper, UFCStats scraper, GRIT webhook, env vars)
3. **Operator dashboard:** open `http://localhost:5000` → should load without CORS errors
4. **Manual ingestion smoke:** open `/manual-ingest` page → paste a fighter profile → submit → verify the fighter appears in gritapp's `fighters` table (run the gritapp smoke test: `cd ../gritapp && npm run smoke:pipeline` to confirm end-to-end)

### Known landmines (don't bang your head on these)
- **`MANUAL_INGESTION_MODE = True`** — Agents 1, 2, 3 are intentionally disabled per current launch strategy. The scraping pipeline is OFF; manual ingestion is the live path.
- **Agent 7 (DALL-E 3 portraits)** — code complete but unconditionally skipped at `pipeline_manager.py:142–146`. Re-enable when ready to spend OpenAI quota on portraits.
- **Agent 5 (Social Monitor)** — never built. Planned only.
- **`daily_event_scan` scheduler job** — body is a `pass` no-op even when `MANUAL_INGESTION_MODE` is False. Implement when re-enabling automation.
- **`_SSL_VERIFY` falls back to disabled** in `pipeline_manager.py:23–26` — acceptable for Replit-to-Replit but must be re-enabled before any production deployment.
- **API keys persisted in plaintext at `.api_keys.json`** — fine for local dev, must move to a real secrets store before deploy.

### If something breaks
- Check `WEEK2_MIGRATION_REVIEW.md` in the gritapp repo if you suspect schema mismatch.
- The reconciler bug (`len(expected_fights)` on int) was fixed earlier this week — should not crash anymore.
- Reset the pipeline queue if it gets stuck: delete `backend/.pipeline_queue.json`.
- Webhook auth: gritapp checks `x-data-engine-api-key` header against its own `DATA_ENGINE_API_KEY`. If pushes 401, both `.env` files must have the same value.

---

## 1. System Overview

```
UFC Event → Agent 1 → File Queue → Agent 2 (Sherdog + Claude) → Agent 3 (History + AI Brief) → Agent 7 (Images) → Webhook → GRIT Main App
                                                                                        ↑
                                                       Agent 4 (News/Intel) ────────────┘ (independent, scheduled)
                                                       Agent 6 (Odds) ──────────────────┘ (independent, scheduled)
                                                       ⚡ Reconciler (Event Fight Integrity) ─┘ (automatic + scheduled)
```

Data is gathered into a dedicated Supabase instance, reconciled via Claude Sonnet, enriched with AI briefs and AI portraits, then pushed to the GRIT main app webhook once complete.

**Event Fight Integrity:** After Agent 2 profiles a fighter, the Reconciler automatically creates missing fight pairings (`event_fights`) where both fighters exist in the database. A scheduled job runs every 6 hours as backup. Manual API endpoints available for operator intervention.

---

## 2. Tech Stack

### Backend (Python)
- **Framework:** FastAPI + Uvicorn
- **Agent Orchestration:** CrewAI (sequential crews per agent)
- **Scheduler:** APScheduler (background, runs news sweep + odds pull)
- **Scraping:** BeautifulSoup4 + Requests
- **AI/LLM:** Claude Sonnet (`claude-sonnet-4-20250514`) via Anthropic SDK
- **Image Generation:** OpenAI DALL-E 3 (`dall-e-3`) via `openai` + `Pillow` (PIL dimension enforcement — scale + center-crop to exact target)
- **Search:** Brave Search API (web + image)
- **Database:** Supabase (PostgreSQL via supabase-py)
- **Queue:** File-based JSON queue (`.pipeline_queue.json`) — NOT a Supabase table

### Frontend (TypeScript/React)
- **Framework:** React 19 + Vite 8
- **Styling:** Tailwind CSS 4
- **Icons:** Lucide-React
- **Animations:** Framer Motion
- **Routing:** React Router Dom v7

---

## 3. Environment Variables

Set these as Replit Secrets (or in `/backend/.env`):

| Variable | Description | Impact if Missing |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase project URL | No data storage or retrieval |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key | Database access denied |
| `ANTHROPIC_API_KEY` | Claude Sonnet API key | Profile verification, AI Briefs, all agent LLM calls fail |
| `BRAVE_API_KEY` | Brave Search API key | Agents cannot find event/fighter URLs; image reference search disabled |
| `OPENAI_API_KEY` | OpenAI API key for DALL-E 3 (get it at platform.openai.com/api-keys) | Agent 7 image generation disabled entirely |
| `DATA_ENGINE_API_KEY` | Auth key for GRIT webhook | Fighter pushes rejected by main app |
| `MAIN_APP_API_URL` | GRIT main app base URL (e.g. `https://grit-1.replit.app`) | No data reaches the main app |

> **Note:** `REPLICATE_API_KEY` and `FIRECRAWL_API_KEY` are NOT used. Any reference to these in older docs is incorrect.

---

## 4. Data Sources — Actual SOP

| Agent | Source | Notes |
| :--- | :--- | :--- |
| Agent 1 (Events) | **UFCStats** (`ufcstats.com`) | Primary. Brave Search fallback to find event URL. Tapology is Cloudflare-protected and cannot be scraped. |
| Agent 2 (Profiles) | **Sherdog** + Claude | Brave Search finds Sherdog URL. Claude verifies/normalizes. Tapology NOT used. |
| Agent 3 (History) | **Sherdog** | Brave Search finds Sherdog URL. Full fight history ledger. |
| Agent 4 (Intel) | **Brave News Search** + Claude | Runs every 45 min (configurable). |
| Agent 6 (Odds) | **BestFightOdds** + Covers fallback | Runs every 24 hours (configurable). |
| Agent 7 (Images) | **Brave Image Search** (reference) + **OpenAI DALL-E 3** (generation) | All generation via DALL-E 3 text-to-image. Brave finds reference photo for agent context. |

---

## 5. Database Schema (Actual — Supabase)

### Table: `fighters`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `nickname` | TEXT | |
| `gender` | TEXT | Default "Male" |
| `nationality` | TEXT | "Unknown" if not found |
| `date_of_birth` | DATE | |
| `organization` | TEXT | Default "UFC" |
| `weight_class` | TEXT | |
| `height_inch` | NUMERIC | Converted from cm |
| `reach_inch` | NUMERIC | Converted from cm |
| `leg_reach_inch` | NUMERIC | |
| `stance` | TEXT | Default "Orthodox" |
| `style` | TEXT | |
| `gym` | TEXT | |
| `team` | TEXT | |
| `head_coach` | TEXT | |
| `fighting_out_of` | TEXT | |
| `ranking` | INT | |
| `wins` | INT | |
| `losses` | INT | |
| `draws` | INT | |
| `nc` | INT | No Contests |
| `image_url` | TEXT | Headshot (1024×1024, PIL-enforced) |
| `body_image_url` | TEXT | Half-body portrait (1024×1536, PIL-enforced) |
| `is_active` | BOOLEAN | |
| `is_champion` | BOOLEAN | |
| `is_verified` | BOOLEAN | True if Claude reconciled |
| `social_media` | JSONB | `{twitter, instagram, website}` |
| `performance` | JSONB | KO/TKO/sub/dec rates, striking stats, etc. |
| `bio` | TEXT | JSON string of AI Brief (fighting_style, strengths, weaknesses, prediction_insight) |
| `notes` | TEXT | Claude review notes |
| `status` | TEXT | "active" / "inactive" / "retired" |
| `created_at` | TIMESTAMP | |

### Table: `fight_history`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `fighter_id` | UUID (FK → fighters) | |
| `event_id` | UUID (FK → events) | |
| `event_name` | TEXT | |
| `event_date` | DATE | |
| `event_promotion` | TEXT | |
| `fighter_name` | TEXT | |
| `opponent_name` | TEXT | "Unknown" if not found |
| `result` | TEXT | Win/Loss/Draw/NC |
| `method` | TEXT | KO, TKO, Sub, Dec, etc. |
| `method_detail` | TEXT | e.g. "Punches" |
| `referee` | TEXT | |
| `round` | INT | |
| `time` | TEXT | e.g. "4:29" |
| `rounds_scheduled` | INT | |
| `fight_duration_seconds` | INT | Calculated |
| `title_fight` | BOOLEAN | |
| `fight_type` | TEXT | "Title Bout" or "Bout" |
| `weight_class` | TEXT | |
| `billing` | TEXT | |
| `bout_order` | INT | |
| `location` | JSONB | |

### Table: `events`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `name` | TEXT | |
| `date` | DATE | |
| `status` | TEXT | "Upcoming" / "Completed" |
| `organization` | TEXT | Default "UFC" |
| `venue` | TEXT | |
| `city` | TEXT | |
| `state` | TEXT | |
| `country` | TEXT | |

### Table: `event_fights`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `event_id` | UUID (FK → events) | |
| `fighter1_id` | UUID (FK → fighters) | |
| `fighter2_id` | UUID (FK → fighters) | |
| `weight_class` | TEXT | |
| `status` | TEXT | "scheduled" |

**Event Fight Integrity:** Created by Agent 1 during initial scan (if both fighters exist). Automatically backfilled by Reconciler after Agent 2 profiles missing fighters. Scheduled job runs every 6 hours as backup.

### Table: `news_articles`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `fighter_id` | UUID (FK → fighters) | Nullable — linked fighter |
| `headline` | TEXT | Article headline (Migration 007) |
| `summary` | TEXT | Article body/summary (Migration 007) |
| `source_url` | TEXT | Original article URL (Migration 007) |
| `layer` | TEXT | "standard" or "intelligence" (Migration 007) |
| `signal_type` | TEXT | e.g. "injury", "camp-change" (Migration 007) |
| `topic_tags` | TEXT[] | Spec-aligned tags array (Migration 007) |
| `author` | TEXT | |
| `published_at` | TIMESTAMPTZ | |
| `is_published` | BOOLEAN | |
| `admin_status` | TEXT | "pending", "approved", "rejected" |

### Table: `odds`
| Field | Type | Notes |
| :--- | :--- | :--- |
| `id` | UUID (PK) | |
| `fight_card_id` | UUID (FK → event_fights) | |
| `fighter_a_line` | TEXT | Moneyline |
| `fighter_b_line` | TEXT | Moneyline |
| `over_under` | TEXT | |
| `method_ko_tko` | TEXT | |
| `method_submission` | TEXT | |
| `method_decision` | TEXT | |
| `round_betting` | TEXT | |
| `source` | TEXT | "BestFightOdds" or "Covers" |
| `status` | TEXT | "staging" → "approved" → "live" |
| `pulled_at` | TIMESTAMP | |

### File-Based Queue: `.pipeline_queue.json`
Replaces the old `pipeline_jobs` Supabase table. Stored in repo root.
Tracks: `fighter_name`, `status`, `event_id`, `event_name`, `event_date`, `fighter_id`.

### Table: `config`
Key-value store for scheduler settings (e.g. `news_sweep_interval_minutes`).

---

## 6. Agent Documentation

### Agent 1 — Event Specialist
- **Trigger:** Manual via Dashboard or API (`POST /events/scan`)
- **Source:** UFCStats (primary), Brave Search (URL discovery fallback)
- **Does:**
  1. Finds event URL on UFCStats
  2. Scrapes fight card (fighter names + bout pairings)
  3. Upserts event record to `events` table
  4. Adds bout pairings to `event_fights` (only for fighters already in DB)
  5. Queues new fighters in file-based queue
- **Deduplication:** Checks `fighters` table by first+last name before queuing

### Agent 2 — Profile Collector
- **Trigger:** Queue processor (manual via Monitor or auto every 5 min)
- **Source:** Brave Search (to find Sherdog URL) + Sherdog + Claude Sonnet
- **Does:**
  1. Finds fighter's Sherdog profile URL via Brave
  2. Scrapes demographics, physical stats, record, social handles, image
  3. Claude normalizes and verifies the data into a strict JSON schema
  4. Upserts fighter to `fighters` table (first+last name key)
  5. Updates queue status to `profiling`
- **AI Fallback:** If Claude returns `{}`, raw Sherdog values are used as fallback

### Agent 3 — History Analyst
- **Trigger:** Runs immediately after Agent 2 in the pipeline chain
- **Source:** Sherdog (full fight history tab)
- **Does:**
  1. Scrapes all historical bouts from Sherdog
  2. Inserts each bout into `fight_history`
  3. Generates AI Brief (fighting style, strengths, weaknesses, prediction insight) via Claude
  4. Stores AI Brief as JSON string in `fighters.bio`
  5. Marks queue job as `complete`

### Agent 4 — Intelligence ("The Connect")
- **Trigger:** Scheduled every 45 minutes
- **Source:** Brave News Search + Claude
- **Does:** Scans for MMA news, extracts intelligence signals (injuries, camp changes, weight struggles), stores in `news_articles`
- **Layers:** `standard` (general news) or `intelligence` (high-value signal)

### Agent 5 — Social Monitor
- **Status: NOT BUILT.** Planned but not implemented.

### Agent 6 — Odds Agent
- **Trigger:** Scheduled every 24 hours (configurable)
- **Source:** BestFightOdds (primary), Covers/OddsShark (fallback)
- **Does:** Pulls moneylines and method odds for all upcoming event bouts, stores as `staging` in `odds` table
- **Fallback:** If `MAIN_APP_API_URL` is not set, reads upcoming events from local Supabase

### Agent 7 — Image Generator
- **Trigger:** Runs in pipeline after Agent 2, also triggerable manually via Images page
- **Source:** OpenAI DALL-E 3 (generation). Brave Image Search used for reference photo context only.
- **Does:**
  1. Searches Brave for a real fighter reference photo (used for logging/context — DALL-E 3 is text-only)
  2. Generates **headshot** at "1024x1024" → PIL-enforced to exact 1024×1024 → stored in `image_url`
  3. Generates **half-body** at "1024x1792" → PIL center-cropped to exact 1024×1536 → stored in `body_image_url`
  4. No fallback providers. No mixed models. OpenAI only.
- **Requires:** `OPENAI_API_KEY` (DALL-E 3), `BRAVE_API_KEY` (optional reference context)

---

## 7. API Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Health check |
| `GET` | `/pipeline/stats` | Dashboard stat counters |
| `GET` | `/pipeline/test-connection` | Tests Supabase, scrapers, GRIT webhook reachability, env vars |
| `GET` | `/pipeline/jobs` | All pipeline queue entries |
| `POST` | `/pipeline/process-queue` | Manually trigger queue processor (Agent 2→3→7 chain) |
| `POST` | `/pipeline/push/fighter/{id}` | Push a single fighter to GRIT main app |
| `POST` | `/pipeline/push/news/{id}` | Push a news item to GRIT main app |
| `GET` | `/fighters` | List fighters in local DB |
| `GET` | `/events` | List events in local DB |
| `POST` | `/events/scan` | Trigger Agent 1 for a named event |
| `GET` | `/news` | List news articles |
| `GET` | `/odds` | List odds (optional `?status=staging`) |
| `POST` | `/odds/pull` | Manually trigger Agent 6 odds pull |
| `PATCH` | `/odds/{id}/approve` | Approve staged odds |
| `PATCH` | `/odds/{id}/reject` | Reject staged odds |
| `DELETE` | `/odds/{id}` | Delete odds record |
| `GET` | `/images/pending` | Fighters missing `image_url` |
| `GET` | `/images/all` | All fighters with image fields |
| `POST` | `/images/generate/{id}` | Generate images for one fighter |
| `POST` | `/images/generate-all` | Bulk generate for all fighters missing images |
| `PATCH` | `/images/clear/{id}` | Clear both image fields for a fighter |
| `GET` | `/config/keys/status` | Which API keys are configured |
| `POST` | `/config/keys` | Set API keys at runtime (persisted to `.api_keys.json`) |

---

## 8. Webhook — Outbound to GRIT Main App

All data pushes use a single endpoint on the main app:

```
POST {MAIN_APP_API_URL}/api/webhooks/data-engine/webhook
Header: x-data-engine-api-key: {DATA_ENGINE_API_KEY}
```

Payload shape:
```json
{
  "sourceType": "fighter" | "fight" | "event" | "news" | "odds",
  "actionType": "create" | "update",
  "sourceId": "<grit-uuid>",  // only on update
  "data": { ... }
}
```

Fighter discovery uses `GET {MAIN_APP_API_URL}/api/fighters?firstName=&lastName=` to check if a fighter already exists before deciding create vs update.

---

## 9. Scheduler

Runs on startup (requires Supabase to be connected for config lookup):

| Job | Default Interval | Override Key |
| :--- | :--- | :--- |
| News Sweep (Agent 4) | Every 6 hours | `news_sweep_interval_minutes` |
| Process Queue (Agent 2→3→7) | Every 5 minutes | `process_queue_interval_minutes` |
| Daily Event Scan | 08:00 UTC daily | `daily_scan_hour_utc` — **currently a no-op** |
| Odds Pull (Agent 6) | Every 24 hours | `odds_pull_interval_hours` |
| **Event Fight Reconciliation** | **Every 6 hours** | **`event_reconcile_interval_hours`** |

> **Flag:** The `daily_event_scan` scheduler job exists but the function body is `pass` — it does nothing. Requires implementation.

**Event Fight Reconciliation:** After Agent 2 profiles each fighter, automatically triggers reconciliation for that fighter's event. Scheduler job runs every 6 hours as backup safety net.

---

## 10. Dashboard — Screen by Screen

### Dashboard
Stats (Total Fighters, Verified, Unverified, News Today, Odds Staging, Images Pending) + Event Scan trigger. Stats poll every 30 seconds.

### Fighters
Card grid with headshot, weight class, name, record, verification badge. Push button per fighter. "View Profile" button renders but is **currently a no-op** — no detail panel implemented.

### Events
List of scanned events from local DB.

### News
News feed from `news_articles` table.

### Odds
Full odds management: list, approve, reject, delete.

### Images
Dual-slot image manager per fighter. Shows headshot + half-body status. Per-fighter and bulk generation. Filter by headshot missing / half-body missing / complete.

### Monitor
Pipeline queue table with live status (10-second poll). Test Connection button (checks Supabase, Sherdog scraper, UFCStats scraper, GRIT webhook, env vars). Process Queue button. Push button for completed fighters.

---

## 11. Current Status

### Latest Cody Review Notes (May 23, 2026)

- Manual ingest draft recovery added: raw paste, selected fighter, parsed session, audit result, add-fighter hint, and event cross-reference state now survive refresh in browser storage.
- Manual ingest approval now saves to the intake DB for review and returns `push_status: "review_required"`; it no longer pushes fighters or fight history straight to GRIT.
- The `/review` dashboard remains the publish gate for GRIT pushes.
- Backend syntax check passed for `backend\app\routers\ingest.py`.
- Frontend build is currently blocked by existing TypeScript errors outside this change; see `replit.md` latest notes for the file list.

### What Is Working
- Agent 1: Event scan from UFCStats ✓
- Agent 2: Fighter profile scrape from Sherdog + Claude verification ✓
- Agent 3: Fight history scrape from Sherdog + AI Brief generation ✓
- Agent 4: News/intelligence sweep (scheduled + manual) ✓
- Agent 6: Odds pull from BestFightOdds/Covers (scheduled + manual) ✓
- Agent 7: Dual image generation via OpenAI DALL-E 3 (headshot 1024×1024 + half-body 1024×1536, PIL-enforced) ✓
- Webhook push to GRIT main app (fighter, fight history, news, event, odds) ✓
- File-based pipeline queue with status tracking ✓
- API key management via dashboard (hot-updated, persisted to `.api_keys.json`) ✓
- Connection test endpoint (Supabase + scrapers + webhook + env vars) ✓
- Full dashboard with all pages ✓
- **Event Fight Reconciliation** (automatic trigger after Agent 2 + scheduled every 6h + manual endpoints) ✓

### What Is Partially Working
- **Deduplication:** Queue and DB use exact first+last name match. Name normalization is NOT applied — "Jon Jones" vs "Jonathan Jones" would create duplicates. No secondary match fallback.
- **AI Failure Handling:** Claude failure returns `{}` silently — pipeline continues with empty/default values. No hard fail, no retry, no pre-insert schema validation.
- **Image Dimensions:** PIL dimension enforcement is applied (scale + center-crop to exact target). Supabase Storage bucket `fighter-images` must exist with public read access for uploads to succeed.
- **event_fights population:** Bout pairings are only written if both fighters already exist in the DB at scan time. Newly queued fighters won't have their bouts linked until after Agent 2 runs — **FIXED by automatic reconciliation trigger**.

### What Is Not Built
- **Agent 5 (Social Monitor):** Not implemented. Planned only.
- **Daily Event Scan:** Scheduler job exists but is a `pass` (no-op).
- **Fighter Profile Detail Panel:** "View Profile" button on Fighters page is a dead no-op. No expanded view with field-by-field data, source attribution, or confidence indicators.
- **Retry Logic:** No automatic retry on pipeline failure.
- **Pre-insert Validation:** No schema validation before writing to Supabase.

---

## 12. Blockers

| # | Blocker | Severity |
| :--- | :--- | :--- |
| 1 | Fighter profile detail panel missing ("View Profile" is dead) | High |
| 2 | Name normalization absent → duplicate fighter risk | High |
| 3 | `daily_event_scan` is a no-op | Medium |
| 4 | AI failure silent → corrupted/empty DB writes possible | Medium |
| 5 | Image pixel dimensions not enforced | Low |

**Note:** Event fight pairing integrity issue resolved by reconciliation system (automatic trigger + scheduled backup + manual endpoints).

---

## 13. How to Run

### Backend
```bash
cd backend
# All packages installed via Replit (uv / pip into .pythonlibs)
python -m uvicorn app.main:app --host localhost --port 8000 --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
# Runs on port 5000, proxies /api → localhost:8000
```

### Required Secrets (Replit Secrets tab)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`
- `BRAVE_API_KEY`
- `OPENAI_API_KEY`
- `DATA_ENGINE_API_KEY`
- (`MAIN_APP_API_URL` is pre-set to `https://grit-1.replit.app` via `.replit` userenv)

---

## 14. Event Fight Integrity System

**Implemented:** March 26, 2026  
**Status:** Production Ready ✅

### Overview

Ensures all UFC event fight cards reach complete state by automatically creating missing `event_fights` records as fighters are profiled.

### How It Works

**Primary Mechanism (Agent 2 Trigger):**
```
Agent 2 profiles fighter → adds to DB
   ↓
Triggers Reconciler for that event
   ↓
Checks: Are BOTH fighters in DB? (EXACT MATCH ONLY)
   ↓
YES → Create event_fight ✓
NO  → Wait for manual intervention
```

**Backup Mechanism (Scheduler):**
- Runs every 6 hours (configurable via `event_reconcile_interval_hours`)
- Scans all upcoming events
- Creates any remaining missing pairings
- Logs summary to activity_log

**Manual Override (API Endpoints):**
- `GET /events/reconcile/{event_id}` — Fix single event
- `POST /events/reconcile/all` — Fix all events
- `GET /events/check-completeness/{event_id}` — Diagnostic check
- `GET /events/completeness-report` — Batch status report

### Key Design Decisions

✅ **Exact Match Only** — No fuzzy logic, no alias matching in reconciler  
✅ **Deterministic Behavior** — Either fighter exists or doesn't; no guessing  
✅ **Idempotent Operations** — Safe unlimited runs, no duplicates  
✅ **Multi-Layer Recovery** — Agent 2 trigger (primary) + Scheduler (backup) + Manual (override)

### Configuration

```sql
-- Change reconciliation interval (default: 6 hours)
UPDATE config SET value = '12' 
WHERE key = 'event_reconcile_interval_hours';
-- Now runs every 12 hours
```

### Documentation

- Full implementation guide: `backend/EVENT_FIGHT_INTEGRITY.md`
- Corrected understanding: `backend/RECONCILER_CORRECTED_UNDERSTANDING.md`
- Quick reference: `backend/EVENT_FIGHT_QUICK_REFERENCE.md`
- Implementation summary: `backend/IMPLEMENTATION_SUMMARY.md`
