# GRIT Data Engine — Complete Audit Report
**Date:** March 25, 2026  
**Status:** Pre-production review

---

## 1. System Architecture Overview

```
[UFCStats]──────────────────────────────────────────────────────────┐
                   Agent 1 (EventAgent)                             │
                   Scans fight cards → events table                 │
                   Queues new fighters → .pipeline_queue.json       │
                                                                    ▼
[Sherdog]──────────────────────────────────────────────────────[Pipeline Queue]
                   Agent 2 (ProfileAgent)                      (file-based)
                   Scrapes profile → Claude verify → fighters table
                            │
                            ▼
                   Agent 7 (ImageAgent)
                   Sherdog photo → image_url (400×400)
                   DALL-E 3 → body_image_url (1024×1536)
                            │
                            ▼
                   Agent 3 (HistoryAgent)
                   Sherdog bouts → fight_history table
                   Claude → fighters.bio (AI Brief)
                            │
                            ▼
                [Admin Review Dashboard]  ←  /review
                   admin_status: pending → approved/rejected
                            │
                            ▼ (on approve)
                   Webhook → https://grit-1.replit.app
                   /api/webhooks/data-engine/webhook

[Brave Search]─────────────────────────────────────────────────────────────────
                   Agent 4 (IntelligenceAgent)
                   3 queries × 3 results → Claude → news_articles table
                   (Scheduled: every 45 min)

[BestFightOdds + OddsShark]────────────────────────────────────────────────────
                   Agent 6 (OddsAgent)
                   Scrapes moneylines → odds table (status: staging)
                   (Scheduled: every 24 hrs)
```

**Scheduler (APScheduler — BackgroundScheduler):**
| Job | Interval | Source |
|---|---|---|
| `daily_event_scan` | Daily @ 8AM UTC | UFCStats upcoming events (30 days ahead) |
| `process_queue` | Every 5 min | Runs Agents 2, 7, 3 on queued fighters |
| `news_sweep` | Every 45 min | Agent 4 — Brave Search + Claude |
| `odds_pull` | Every 24 hrs | Agent 6 — BestFightOdds + OddsShark |

**Scheduler intervals** are read from a `config` Supabase table at startup with hardcoded defaults.

---

## 2. Agent-by-Agent Audit

### Agent 1 — EventAgent
**Purpose:** Discovers UFC fight cards on UFCStats, records event + bouts in the DB, and queues new fighters for processing.

**Inputs:** Event name (string), optional UFCStats URL  
**Outputs:** `events` row, `event_fights` rows, entries in `.pipeline_queue.json`

**Workflow:**
1. URL resolution: provided URL → UFCStats internal search → Brave Search fallback
2. Scrapes fight card (`UFCStatsScraper.get_fight_card()`)
3. Upserts event record with full location parsing
4. 3-stage fighter dedup (exact name → alias → fuzzy 0.75) — skips known fighters
5. Queues new fighters in `.pipeline_queue.json` (file-based, thread-safe)
6. Records `event_fights` rows for known fighter pairs

**Tools/Libraries:** `requests`, `BeautifulSoup4`, `BraveSearch`, `supabase-py`  
**Data Source:** http://ufcstats.com (no Cloudflare, validated selectors)

**Issues:**
- `UFCStatsScraper.search_event()` and `get_fighter_profile()` both return `None` — dead stub methods that were never implemented (low priority, not called anywhere)
- `event_fights` only records bouts where BOTH fighters already exist in the DB at time of scan. New fighters get queued but their bouts won't be recorded until Agent 2 completes — and Agent 1 isn't re-run after that. **This means `event_fights` is often empty for new events.**
- Location parsing assumes "Venue, City, State, Country" format but falls back to putting the venue in both `venue` and `city` fields for 3-part strings (minor data quality issue)

---

### Agent 2 — ProfileAgent
**Purpose:** Scrapes Sherdog for fighter profile data, verifies and enriches it with Claude Sonnet, and upserts the fighter record.

**Inputs:** Fighter name (from queue)  
**Outputs:** Row in `fighters` table (or UPDATE if fighter already exists)

**Workflow:**
1. Brave Search to find Sherdog URL (`site:sherdog.com {name} fighter`)
2. `SherdogScraper.get_fighter_profile()` — extracts identity, physical, record, win/loss breakdown
3. Claude Sonnet verification: reconciles data, extracts stats Sherdog doesn't expose (strike accuracy, reach, stance)
4. 3-stage dedup on DB before upsert
5. Updates queue with `fighter_id`

**Tools/Libraries:** `anthropic` (claude-sonnet-4-20250514), `BraveSearch`, `SherdogScraper`, `supabase-py`

**Issues:**
- `reach_cm`, `leg_reach_cm`: Sherdog doesn't expose reach. Claude can't infer this from the input data it receives (just Sherdog scraped fields). These will always be `null` unless UFCStats stats are added as a data source.
- `strike_accuracy`, `strike_defense`, `takedown_avg`, etc.: Same problem — Sherdog doesn't have these. Claude is guessing or leaving them null. The prompt asks for them but the data source doesn't provide them.
- `social_media` (twitter, instagram): Always null. Sherdog doesn't expose these. Will need separate search logic.
- `head_coach`: Sherdog rarely exposes this. Often defaults to "Unknown".
- `is_verified=True` is set based on Claude's response flag, but new fighters should ideally start as `admin_status='pending'` — currently they do via the DB default but the pipeline auto-pushes them to GRIT before admin review (see Critical Blocker #1).
- `max_tokens=1024` in ClaudeClient is tight for long Sherdog profiles. Rarely causes truncation, but long bios risk it.

---

### Agent 3 — HistoryAgent
**Purpose:** Scrapes complete fight history from Sherdog, stores each bout in `fight_history`, and generates an AI Brief (bio) for the fighter using Claude.

**Inputs:** `fighter_id`, `fighter_name`  
**Outputs:** Rows in `fight_history` table; `bio` field update on `fighters`

**Workflow:**
1. Brave Search to find Sherdog URL
2. `SherdogScraper.get_fighter_history()` — parses all historical bouts
3. **Validates with Claude FIRST** — if Claude fails, no DB writes happen (correct design)
4. Batch upserts bouts with `ON CONFLICT (fighter_id, event_name, opponent_name) DO UPDATE`
5. Writes AI Brief JSON to `fighters.bio`
6. Marks queue job as "complete"

**Tools/Libraries:** `anthropic` (Claude Sonnet), `BraveSearch`, `SherdogScraper`, `supabase-py`

**Issues:**
- `title_fight` detection is based on the event name containing "title" or "championship". This will miss interim title fights and non-English championship names.
- `weight_class` on history rows defaults to "Unknown" — Sherdog history rows don't always include weight class. This is a data quality gap.
- `fight_duration_seconds` formula assumes 5-minute rounds for all divisions — incorrect for women's 3-round non-title fights (same) but technically correct for most cases.
- Double Brave Search on Agent 3 (same search already done in Agent 2) — minor inefficiency. Could pass the Sherdog URL from Agent 2 through the queue.
- `max_tokens=1024` for the history brief — for fighters with 40+ bouts, the summary passed to Claude is already truncated to 10 bouts (intentional, but worth noting).

---

### Agent 4 — IntelligenceAgent
**Purpose:** Scans MMA news sources via Brave Search, extracts high-value intelligence signals with Claude, and records them in `news_articles`.

**Inputs:** None (self-contained, runs on schedule)  
**Outputs:** Rows in `news_articles` table

**Workflow:**
1. 3 hardcoded search queries, 3 results each = up to 9 articles evaluated per sweep
2. Claude extracts: headline, summary, layer, signal_type, tags
3. Dedup by title (ilike) then by source URL before inserting
4. Sets `is_published=True` immediately on insert

**Tools/Libraries:** `anthropic` (Claude Sonnet), `BraveSearch`, `supabase-py`

**Issues:**
- Only 3 hardcoded queries — very narrow coverage. Missing: weight cuts, visa issues, fight announcement, card changes, title implications.
- Brave snippets (not full article content) are what Claude sees — analysis quality is limited by how informative the snippet is.
- `admin_status` defaults to 'pending' via the DB column default. But `is_published=True` is set by Agent 4 at insert time. These two signals conflict — is the article published before admin reviews it? The `is_published` flag needs to be decoupled from `admin_status` or the main app should gate on `admin_status=approved` rather than `is_published`.
- No `fighter_reference` or `event_reference` is set — the tags array has fighter names but they're not linked to fighter UUIDs. The push to GRIT also sends `fighterReference: None`.
- `subtitle` field is reused as the "layer" field (standard/intelligence) — awkward schema reuse.

---

### Agent 6 — OddsAgent
**Purpose:** Pulls betting moneylines for upcoming UFC fights from BestFightOdds (primary) and OddsShark (fallback), stores in `odds` table.

**Inputs:** Active event cards (from main app API or local Supabase events)  
**Outputs:** Rows in `odds` table with `status: "staging"`

**Workflow:**
1. Fetches active cards — tries main app `/api/events/active` first, falls back to local events
2. For each bout, resolves fighter names from `fighter1_id`/`fighter2_id`
3. `BestFightOddsScraper` — 2-stage: homepage scan to find event URL, then event page parse
4. `OddsSharkScraper` — fallback, parses moneylines from server-rendered HTML
5. Stores odds as `status: "staging"`

**Tools/Libraries:** `requests`, `BeautifulSoup4`, `supabase-py`

**Issues — CRITICAL:**
- **The `odds` table does not exist in Supabase.** The DB query fails with error `PGRST205: Could not find table 'public.odds'`. Agent 6 cannot store anything and will error on every run. **Migration needed before Agent 6 can be used.**
- **Column name mismatch:** Agent 6 stores `fighter_a_line` / `fighter_b_line` but the frontend `OddsRow` component reads `fighter1_ml` / `fighter2_ml`. These field names don't match — odds will never display correctly even after the table is created.
- BestFightOdds method odds (KO/TKO, submission, decision) are JavaScript-rendered client-side. Static HTTP scraping cannot get them — `method_ko_tko`, `method_submission`, `method_decision` will always be `null`.
- No `fight_id` linkage — odds are stored with `fight_card_id` but there's no direct FK to an `event_fights` row. This makes matching odds to specific bouts difficult.
- No deduplication on odds — re-running Agent 6 on the same card inserts duplicate rows.
- The push to GRIT via `push_odds()` is never called automatically — it's only called manually.

---

### Agent 7 — ImageAgent
**Purpose:** Processes two images per fighter: a real Sherdog headshot (400×400) and a DALL-E 3 styled body shot (1024×1536).

**Inputs:** `fighter_id`, `fighter_name`  
**Outputs:** Updates `fighters.image_url` (headshot) and `fighters.body_image_url` (body shot)

**Workflow:**
1. Verifies `fighter-images` Supabase Storage bucket exists and is public on startup
2. Checks `image_url` for placeholder markers
3. **Headshot:** Rewrites Sherdog crop URL to 400×400, downloads, falls back to PIL resize
4. **Body shot:** DALL-E 3 with standard prompt (dark bg, dramatic lighting, fighting stance), center-crops 1024×1792 → 1024×1536, uploads to Storage
5. One DB update call with both fields

**Tools/Libraries:** `openai` (DALL-E 3), `Pillow`, `requests`, `supabase-py`

**Issues:**
- **Bucket check:** If `fighter-images` bucket doesn't exist in Supabase Storage, ALL image processing is silently skipped for all fighters (logged as error, not raised). This is intentional safety behavior but the bucket must be created manually.
- **DB field fetch includes `name` column but the fighters table uses `first_name`/`last_name`.** `record.get("name")` will always return `None` — falls back to `fighter_name` parameter (which is correct), but the DB query is wasteful.
- **DALL-E 3 cost:** ~$0.04 per fighter for the body shot. At scale (e.g., 100 fighters), that's $4. Not a blocker, but worth budgeting.
- The DALL-E prompt in `prompts.py` doesn't mention specific fighter nationality or weight class prominently — the resulting body shots will be anatomically generic (no differentiation between a Flyweight and a Heavyweight). This is intentional for consistency but reduces realism.

---

## 3. Shared Infrastructure

### PipelineManager
Orchestrates Agents 1, 2, 3, 7. Handles all webhook pushes to the GRIT main app.

**CRITICAL ISSUE — Admin Review Bypass:**  
`_process_single_fighter()` calls `push_to_main_app()` **automatically after Agent 3 completes**. This bypasses the admin review dashboard entirely. Fighters are pushed to GRIT the moment the pipeline finishes, regardless of `admin_status`. The review dashboard was built to gate this push, but the pipeline ignores it.

**Fix required:** Remove the `push_to_main_app()` call from `_process_single_fighter()`. Pushes should only happen when an admin clicks "Approve" in the review dashboard, which already has this logic.

### Pipeline Queue
File-based JSON queue (`backend/.pipeline_queue.json`), thread-safe with `threading.Lock()`.

**Current state:** 27 fighters processed, 1 stuck at "history" (Yousri Belgaroui), 1 stuck at "profiling" (Mansur Abdul-Malik with `fighter_id: null`).

**Issues:**
- **Stuck jobs are never retried.** The `process_queue()` scheduler only picks up `status == "queued"` jobs. A job stuck in "profiling" or "history" will stay there forever unless manually reset.
- **State is lost on redeploy.** If the server restarts mid-pipeline run, jobs in "profiling" or "history" state are permanently stuck. A Supabase-backed queue would be more resilient.
- Queue never clears completed jobs automatically — `clear_complete()` exists but is never called by the scheduler.

### ClaudeClient
Singleton Claude Sonnet client with JSON extraction and required-key validation.

**Issues:**
- `max_tokens=1024` — potentially too low for complex profiles. Claude Sonnet 4 supports 64K output tokens.
- Model is hardcoded as `claude-sonnet-4-20250514` — will need updating when model versions change.
- No retry logic on API errors — a single timeout or rate-limit error marks the whole job as "error".

### BraveSearch
Simple wrapper — no retry, no rate limiting, no caching.

**Issues:**
- No retry on failure — transient network errors permanently fail the pipeline step.
- Agents 2 and 3 both search for the same Sherdog URL for the same fighter. This is a redundant paid API call.
- Default `count=5` returns a lot of results that are usually discarded (only the first sherdog.com match is used).

### SherdogScraper
Validated against live HTML (March 2026). Selectors are accurate.

**Issues:**
- No caching — same fighter page fetched twice (once by Agent 2, once by Agent 3).
- No retry on network errors.
- `search_event()` is a stub that returns `None` (pass statement) — never implemented.
- Sherdog doesn't expose: reach, stance, striking stats, takedown stats, leg reach. These are silently left null.

---

## 4. Database State

| Table | Record Count | Notes |
|---|---|---|
| `fighters` | 27 | All `admin_status = 'approved'` (backfilled) |
| `fight_history` | Unknown | Populated by Agent 3 runs |
| `events` | 1 | UFC Fight Night: Adesanya vs. Pyfer |
| `event_fights` | Unknown | Bouts for known fighters at scan time |
| `news_articles` | Unknown | Populated by Agent 4 sweeps |
| `odds` | **TABLE DOES NOT EXIST** | Blocker for Agent 6 |
| `activity_log` | 0 | Just created, pipeline doesn't write to it |

---

## 5. Dependencies Audit

| Package | Used | Where | Status |
|---|---|---|---|
| `fastapi` | Yes | main.py | Required |
| `uvicorn` | Yes | server runner | Required |
| `crewai` | **No** | Nowhere | **Dead dependency — remove** |
| `supabase` | Yes | all agents | Required |
| `beautifulsoup4` | Yes | scrapers, odds | Required |
| `firecrawl-py` | **No** | Nowhere | **Dead dependency — remove** |
| `anthropic` | Yes | Agents 2, 3, 4 | Required |
| `apscheduler` | Yes | scheduler/tasks.py | Required |
| `python-dotenv` | Yes | claude_utils.py | Required |
| `pydantic` | Yes | main.py request models | Required |
| `pydantic-settings` | Minimal | Can be dropped | Low priority |
| `requests` | Yes | scrapers, pipeline | Required |
| `openai` | Yes | Agent 7 DALL-E 3 | Required |
| `Pillow` | Yes | Agent 7 image resize | Required |

`crewai` and `firecrawl-py` were in an earlier design but were replaced. They add ~15-20s to cold start and ~200MB to the dependency footprint. Remove them.

---

## 6. Recommendations

### 🔴 HIGH — Must fix before production

| # | Issue | Fix |
|---|---|---|
| H1 | **Admin review bypass** — pipeline auto-pushes to GRIT without waiting for admin approval | Remove `push_to_main_app()` call from `_process_single_fighter()` in `pipeline_manager.py`. Gate all pushes on admin approval from the review dashboard. |
| H2 | **`odds` table doesn't exist** — Agent 6 errors on every run | Create `odds` table in Supabase with correct schema |
| H3 | **Odds column name mismatch** — stored as `fighter_a_line`/`fighter_b_line`, read as `fighter1_ml`/`fighter2_ml` | Standardize column names across Agent 6 storage, API endpoint, and frontend |
| H4 | **Stuck queue jobs** — "Yousri Belgaroui" (history) and "Mansur Abdul-Malik" (profiling) are permanently stuck | Add a retry mechanism in the queue processor for jobs stuck >30min in non-terminal states. Manually reset these two jobs to "queued". |
| H5 | **`news_articles.is_published=True`** set by Agent 4 before admin review — conflicts with `admin_status` gating | Set `is_published=False` on Agent 4 insert; only set `True` when admin approves. Or remove `is_published` and have the main app gate on `admin_status`. |

### 🟡 MEDIUM — Fix soon

| # | Issue | Fix |
|---|---|---|
| M1 | **Dead dependencies** (`crewai`, `firecrawl-py`) slow startup by ~20s and bloat environment | Remove from requirements.txt |
| M2 | **Double Brave Search** — Agents 2 and 3 both search for the same Sherdog URL | Pass the Sherdog URL from Agent 2 through the queue JSON so Agent 3 can skip the search |
| M3 | **Agent 6 odds dedup** — re-running inserts duplicate rows | Add `ON CONFLICT (fight_card_id, source)` check before insert |
| M4 | **`activity_log` never written by pipeline agents** — Activity Log tab always empty | Add `activity_log` inserts to Agents 2, 3, 4, 6, 7 and PipelineManager on key events |
| M5 | **`max_tokens=1024` in ClaudeClient** — low for profiles with many fields | Raise to 4096 |
| M6 | **Brave search not retried** — transient errors permanently fail pipeline steps | Add 2-retry with 3s backoff in `BraveSearch.search()` |
| M7 | **`event_fights` incomplete** — bouts only recorded for fighters already in DB at scan time | After Agent 2 completes, check if the opponent is now in DB and backfill `event_fights` |
| M8 | **`agent7: record.get("name")` fetches non-existent column** — always returns None | Fix DB select in agent7 to use `first_name, last_name` instead of `name` |

### 🟢 LOW — Nice to have

| # | Issue | Fix |
|---|---|---|
| L1 | Sherdog not cached between Agent 2 and Agent 3 | Add in-memory or Redis cache for Sherdog fetches within the same pipeline run |
| L2 | `reach_cm`, `leg_reach_cm` always null | Add UFCStats fighter stats as a secondary source for physical measurements |
| L3 | Agent 4 only 3 hardcoded queries | Expand to 8–10 dynamic queries including fighter names from upcoming events |
| L4 | No retry on Claude API errors | Add exponential backoff retry for rate limits and timeouts |
| L5 | `dry_run.py`, `test_e2e.py`, `verify_agent6.py` loose in root | Move to `backend/scripts/` or `backend/tests/` |
| L6 | Queue never clears completed jobs | Call `pq.clear_complete()` in the queue scheduler to prune the file |
| L7 | `pydantic-settings` imported but barely used | Can be removed |
| L8 | Claude model hardcoded as string | Move to a config constant for easy version updates |

---

## 7. Status Summary

| Component | Status | Notes |
|---|---|---|
| Agent 1 — Event Scanner | ✅ Working | Minor: incomplete event_fights backfill |
| Agent 2 — Profile Collector | ✅ Working | Some stats always null (reach, strike %) |
| Agent 3 — History Builder | ✅ Working | Minor: weight_class gaps in history rows |
| Agent 4 — Intelligence Hunter | ✅ Working | Needs is_published fix before production |
| Agent 5 | — | Does not exist |
| Agent 6 — Odds Agent | ❌ Broken | `odds` table missing; column name mismatch |
| Agent 7 — Image Processor | ✅ Working | Requires `fighter-images` bucket in Supabase Storage |
| PipelineManager | ⚠️ Partial | Auto-pushes bypass admin review — must fix |
| Admin Review Dashboard | ✅ Working | Live at /review |
| APScheduler | ✅ Working | 4 jobs configured and running |
| Webhook to GRIT | ✅ Working | SSL handled via system CA |
| Pipeline Queue | ⚠️ Partial | 2 stuck jobs; no retry mechanism |
| Supabase DB | ⚠️ Partial | `odds` table missing; `activity_log` empty |

---

## 8. Immediate Action Checklist

Before pushing any new fighters to production:

1. **[ ] Fix auto-push bypass** — remove `push_to_main_app()` from `_process_single_fighter()` 
2. **[ ] Create `odds` table** in Supabase and fix column name alignment
3. **[ ] Reset stuck queue jobs** — Yousri Belgaroui and Mansur Abdul-Malik
4. **[ ] Fix `news_articles.is_published`** — set False at insert, True on admin approve
5. **[ ] Remove `crewai` and `firecrawl-py`** from requirements.txt
6. **[ ] Verify `fighter-images` bucket** exists in Supabase Storage and is public
7. **[ ] Fix Agent 7 DB select** — `name` column doesn't exist, use `first_name, last_name`
