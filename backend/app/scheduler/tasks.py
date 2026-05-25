from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()


def daily_event_scan():
    """
    Scheduled daily at 8 AM UTC.
    Scrapes UFCStats for all upcoming events within the next 30 days and
    runs the EventAgent pipeline for each one.

    This is idempotent: Agent 1 checks for existing event records and
    existing fighters before inserting, so re-running on an already-scanned
    event is safe and will only pick up new fighters.
    """
    print("[daily_event_scan] Starting automatic UFC event scan...")
    try:
        from app.scrapers.ufcstats_scraper import UFCStatsScraper
        from app.agents.pipeline_manager import PipelineManager

        scraper = UFCStatsScraper()
        upcoming = scraper.list_upcoming_events(days_ahead=30)

        if not upcoming:
            print("[daily_event_scan] No upcoming events found within 30 days.")
            return

        pipeline = PipelineManager()
        scanned = 0
        for event_name, event_url in upcoming:
            try:
                print(f"[daily_event_scan] Scanning event: {event_name} (url: {event_url})")
                result = pipeline.run_event_scan(event_name, event_url=event_url)
                print(f"[daily_event_scan] Result for '{event_name}': {result}")
                scanned += 1
            except Exception as e:
                print(f"[daily_event_scan] Error scanning '{event_name}': {e}")

        print(f"[daily_event_scan] Completed. Scanned {scanned}/{len(upcoming)} events.")

    except Exception as e:
        print(f"[daily_event_scan] Fatal error: {e}")


def odds_pull():
    from app.agents.agent6_odds.agent import OddsAgent
    agent = OddsAgent()
    agent.run()


def news_sweep():
    from app.agents.agent4_intelligence.agent import IntelligenceAgent
    intel = IntelligenceAgent()
    intel.run()


def process_queue():
    """
    Main queue tick:
    1. Auto-clear complete jobs older than 7 days.
    2. Detect stuck jobs (> 30 min in non-terminal state) and auto-retry or fail.
    3. Run pending queued fighters through the pipeline.
    """
    from app.database import pipeline_queue as pq

    pq.clear_old_complete(days=7)
    stuck = pq.check_stuck_jobs(timeout_minutes=30, max_attempts=3)
    if stuck:
        print(f"[Scheduler] Resolved {len(stuck)} stuck job(s): {stuck}")

    from app.agents.pipeline_manager import PipelineManager
    pipeline = PipelineManager()
    pipeline.process_queued_fighters()


def event_fight_reconciliation():
    """
    Scheduled integrity check: Reconcile missing event_fights for all upcoming events.
    Runs every 6 hours (configurable) to ensure fight pairings are created as fighters are added.
    """
    from app.services.event_fight_reconciler import EventFightReconciler
    
    print("[event_fight_reconciliation] Starting event fight pairing reconciliation...")
    try:
        reconciler = EventFightReconciler()
        results = reconciler.reconcile_all_upcoming_events()
        
        total_created = sum(r.get("created_fights", 0) for r in results)
        total_missing = sum(r.get("missing_fights", 0) for r in results)
        
        print(
            f"[event_fight_reconciliation] Completed. "
            f"Events processed: {len(results)}, "
            f"Fights created: {total_created}, "
            f"Still missing: {total_missing}"
        )
        
        # Log summary to activity_log
        try:
            from app.database.supabase_client import get_supabase
            supabase = get_supabase()
            supabase.table("activity_log").insert({
                "agent_name": "Scheduler",
                "action": "reconciled",
                "entity_type": "event_batch",
                "status": "success" if total_missing == 0 else "partial",
                "detail": (
                    f"Reconciled {len(results)} events. "
                    f"Created {total_created} event_fights records. "
                    f"{total_missing} fights still missing (fighters not in DB)."
                ),
            }).execute()
        except Exception as log_err:
            print(f"[event_fight_reconciliation] Failed to log activity: {log_err}")
            
    except Exception as e:
        print(f"[event_fight_reconciliation] Fatal error: {e}")


def start_scheduler():
    from app.database.supabase_client import get_supabase

    def get_config(key, default):
        try:
            supabase = get_supabase()
            res = supabase.table("config").select("value").eq("key", key).execute()
            return res.data[0]["value"] if res.data else default
        except Exception:
            return default

    news_min = int(get_config("news_sweep_interval_minutes", 360))
    scheduler.add_job(news_sweep, 'interval', minutes=news_min)

    queue_min = int(get_config("process_queue_interval_minutes", 5))
    scheduler.add_job(process_queue, 'interval', minutes=queue_min)

    scan_hour = int(get_config("daily_scan_hour_utc", 8))
    scheduler.add_job(daily_event_scan, 'cron', hour=scan_hour)

    odds_hours = int(get_config("odds_pull_interval_hours", 24))
    scheduler.add_job(odds_pull, 'interval', hours=odds_hours)
    
    # Add event fight reconciliation job (every 6 hours, configurable)
    reconcile_hours = int(get_config("event_reconcile_interval_hours", 6))
    scheduler.add_job(event_fight_reconciliation, 'interval', hours=reconcile_hours)

    scheduler.start()
