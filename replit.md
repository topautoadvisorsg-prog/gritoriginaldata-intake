# GRIT Data Engine

An AI-powered data pipeline for MMA fighter and event data, built for the GRIT platform.

## Architecture

- **Frontend**: React + TypeScript + Vite (port 5000), TailwindCSS, Lucide icons
- **Backend**: FastAPI Python (port 8000), plain Python agents (no CrewAI)
- **Database**: Supabase (external PostgreSQL)
- **Main App**: https://grit-1.replit.app (receives data via webhook — must be live)

## Project Structure

```
frontend/
  src/
    pages/
      Dashboard.tsx         — stat cards + event scan trigger
      ManualIngest.tsx      — MAIN WORKFLOW: paste raw text → AI parse → preview → approve
      PipelineReview.tsx    — 5-tab admin pipeline review UI (main admin view)
      Fighters.tsx          — fighter list
      Events.tsx            — event list
      News.tsx              — news articles
      Odds.tsx              — odds management
      Images.tsx            — operator image upload/preview/approve workflow + filter tabs
      Monitor.tsx           — pipeline monitor + API key config
    components/
      Layout.tsx            — sidebar nav
      ApiKeyPanel.tsx       — API key configuration panel
    api/index.ts            — all API calls

backend/
  app/
    main.py                 — FastAPI app with all routes + ingest router
    routers/
      ingest.py             — POST /ingest/raw (parse) + POST /ingest/approve (save)
    agents/
      agent1_event/         — Event scanner (DISABLED — MANUAL_INGESTION_MODE=True)
      agent2_profile/       — Fighter profile builder (DISABLED — MANUAL_INGESTION_MODE=True)
      agent3_history/       — Fight history builder (DISABLED — MANUAL_INGESTION_MODE=True)
      agent4_intelligence/  — News + signal detection (Brave + Claude) ← ACTIVE
      agent6_odds/          — Odds scraper (BestFightOdds + OddsShark) ← ACTIVE
      agent7_image/         — DISABLED — replaced by operator manual upload workflow
      pipeline_manager.py   — Orchestrates agents; MANUAL_INGESTION_MODE flag controls Agents 1-3
    database/
      supabase_client.py    — Supabase connection
      pipeline_queue.py     — File-based pipeline queue (.pipeline_queue.json)
    scheduler/tasks.py      — APScheduler background jobs (news + odds still active)
    scrapers/               — BeautifulSoup scrapers (kept, not called in manual mode)
    utils/
      ingest_validator.py   — Validates fighter profiles + fight history before DB insert
      claude_utils.py       — Claude API wrapper
      search_utils.py       — Brave Search wrapper
      firecrawl_utils.py    — Firecrawl wrapper
    prompts.py              — All Claude prompts (PROFILE_VERIFICATION, RAW_FIGHTER_PROFILE, RAW_FIGHT_HISTORY)
  migrations/
    002_odds_and_pipeline_jobs.sql
    003_fighters_aliases.sql         ← NOT APPLIED — aliases column missing (warning noise only)
    004_fight_history_dedup_and_news_source_url.sql
    005_pipeline_review_infrastructure.sql
    011_fighter_images.sql           ← NOT APPLIED — image_source/ai_generated columns missing
```

## Agents

| Agent | Purpose | Status |
|---|---|---|
| Agent 1 | Scans upcoming UFC events, builds fight card + `event_fights` rows | Active |
| Agent 2 | Builds fighter profile (Sherdog + UFCStats + Claude) — does NOT populate `reach_inch` | Active |
| Agent 3 | Scrapes full fight history from Sherdog | Active |
| Agent 4 | Hunts MMA news + intelligence signals (Brave + Claude) | Active |
| Agent 6 | Scrapes moneylines from BestFightOdds / OddsShark | Active |
| Agent 7 | DISABLED — pipeline_manager.py skips `self.image_agent.run()` | Disabled |

## Image Workflow (Operator Manual Upload)

Agent 7 is permanently disabled. Images are uploaded manually by the operator via the Images page.

- **Headshot** (`headshot.jpg`): Operator uploads 1024×1024 portrait, previews in modal, clicks "Approve & Import"
- **Body shot** (`half-body.jpg`): Operator uploads 1024×1536 half-body portrait, same approve flow
- Endpoint: `POST /images/upload/{fighter_id}` (multipart, field names: `headshot` or `body`)
- Images page has SOP panel with prompts, sizes, Copy buttons, and 5-step workflow
- Filters: All / Missing Headshot / Missing Body / Complete
- Graceful fallback if migration 011 columns absent

## Pipeline Review Dashboard

The admin reviews all scraped records before they go live. Located at `/review`.

**Tabs:**
- **Pending Review** — fighters, news, odds awaiting admin decision. Approve (pushes to GRIT), Reject buttons.
- **Activity Log** — searchable + filterable log of every pipeline action.
- **Approved** — all approved records, view-only preview.
- **Rejected** — rejected records, fighters can be restored to pending.
- **Needs Attention** — fighters with `needs_image=true`, errors, flags.

## Push Mechanism

Push to GRIT via `POST /pipeline/push/fighter/{fighter_id}`:
- Checks if fighter exists in GRIT (`/api/fighters/discover?name=...`) — times out to 5s
- If exists → `actionType: "update"`; if not → `actionType: "create"`
- Sends payload to `https://grit-1.replit.app/api/data-engine/webhook`
- Authenticates with `DATA_ENGINE_API_KEY` in `X-Data-Engine-Key` header

Approve endpoint (`PATCH /pipeline/review/fighters/{id}/approve`) sets `admin_status=approved` AND triggers push.

**Note**: Push silently returns 200 even when GRIT is unreachable — errors are logged but not surfaced to caller.

## Known Issues

| Issue | Severity | Status |
|---|---|---|
| `reach_inch` missing for all fighters | Medium | Agent 2 doesn't scrape Sherdog reach field |
| Migration 003 not applied (`aliases` column) | Low | Warning noise only, doesn't break pipeline |
| Migration 011 not applied (`image_source`, `ai_generated`) | Low | Images page has fallback, status badges default to "AI-Generated" |
| GRIT webhook path was wrong (`/api/webhooks/data-engine/webhook`) | FIXED | Corrected to `/api/data-engine/webhook` |
| No event push endpoint (`/pipeline/push/event/`) | Low | Events not pushed to GRIT, only fighters and news |

## Latest Cody Review Notes (May 23, 2026)

- Manual ingest now autosaves the operator draft in browser storage: raw paste, selected fighter, parsed session, audit result, add-fighter hint, and event cross-reference state survive refresh.
- `POST /ingest/approve` now saves records as pending review and returns `push_status: "review_required"`; it no longer pushes fighters or fight history directly to GRIT.
- `/review` remains the publishing gate: approving a fighter there sets `admin_status=approved` and triggers the GRIT push.
- Backend syntax check passed: `python -m py_compile backend\app\routers\ingest.py`.
- Frontend build is still blocked by pre-existing TypeScript errors outside this change in `Events.tsx`, `FighterDetail.tsx`, `Fighters.tsx`, `News.tsx`, `Odds.tsx`, and `PipelineReview.tsx`. `ManualIngest.tsx` did not appear in the build failure list.

## Full Pipeline Test Results (March 25, 2026)

**Event**: UFC Fight Night: Adesanya vs. Pyfer (Event ID: de19f02f)

| Step | Result |
|---|---|
| Event scan (Agent 1) | ✅ 28 fighters identified, all deduplicated correctly |
| Fighter profiles (Agent 2) | ✅ 28/28 with wins/losses/bio/height — reach_inch MISSING for all |
| Fight history (Agent 3) | ✅ Fight history records populated |
| `event_fights` bouts | ✅ 11 bouts recorded (card_placement + bout_order both set) |
| Agent 7 image | ✅ Skipped (operator upload flow) |
| Push to GRIT | ✅ 28/28 fighters → GRIT 201 "Data received and queued for review" |

## Data Sources (Validated March 2026)

| Source | Accessible | Used By |
|---|---|---|
| sherdog.com | ✅ | Agent 2 (profile + image), Agent 3 (history) |
| ufcstats.com | ✅ | Agent 1 (event fight cards) |
| BestFightOdds | ✅ | Agent 6 (odds) |
| OddsShark | ✅ | Agent 6 (fallback) |
| Brave Search API | ✅ | Agents 2, 4 (URL discovery) |
| Claude (Anthropic) | ✅ | Agents 2, 3, 4 (verification + AI brief) |
| DALL-E 3 (OpenAI) | ⛔ | Agent 7 DISABLED |

## Environment Variables Required

```
SUPABASE_URL             — Supabase project URL
SUPABASE_SERVICE_KEY     — Supabase service role key
ANTHROPIC_API_KEY        — Claude API key
BRAVE_API_KEY            — Brave Search API key
OPENAI_API_KEY           — (reserved, Agent 7 disabled)
DATA_ENGINE_API_KEY      — Auth key for GRIT webhook
MAIN_APP_API_URL         — https://grit-1.replit.app
```

## Key Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /pipeline/stats | Dashboard stat counts |
| GET | /pipeline/review/counts | Review tab badge counts |
| GET | /pipeline/review/fighters | Fighters by admin_status |
| GET | /pipeline/review/fighters/{id} | Full fighter + fight history |
| PATCH | /pipeline/review/fighters/{id}/approve | Approve + push to GRIT |
| PATCH | /pipeline/review/fighters/{id}/reject | Reject fighter |
| POST | /pipeline/push/fighter/{id} | Direct push (no admin_status gate) |
| GET | /pipeline/review/news | News by admin_status |
| PATCH | /pipeline/review/news/{id}/approve | Approve news |
| GET | /pipeline/activity-log | Full activity log |
| POST | /events/scan | Trigger event scan |
| POST | /pipeline/process-queue | Process pending fighter queue |
| POST | /images/upload/{fighter_id} | Upload headshot or body image (multipart) |
| GET | /images/all | All fighter image records |

## Deduplication

- **Fighters**: 3-stage fuzzy match (exact → normalized → fuzzy ratio) before insert
- **Fight history**: ON CONFLICT (fighter_id, event_name, opponent_name) DO UPDATE
- **News**: URL uniqueness check + title ilike check before insert

## Pipeline Queue

File-based at `backend/.pipeline_queue.json`. Each entry: `{fighter_name, event_id, event_name, event_date, status}`.

## `event_fights` Schema Note

Both `card_placement` AND `bout_order` are NOT NULL. Agent 1 sets both to the 1-based card position index.
