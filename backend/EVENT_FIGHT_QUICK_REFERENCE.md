# Event Fight Integrity — Quick Reference

## 🚀 Quick Start (For Developers)

### Check If an Event Is Complete

```bash
curl http://localhost:8000/events/check-completeness/{event_id}
```

**Look for:** `"is_complete": true`

---

### Fix an Incomplete Event

```bash
curl -X POST http://localhost:8000/events/reconcile/{event_id}
```

**Expected response:** `"created_fights": N` where N > 0

---

### Monitor All Events

```bash
curl http://localhost:8000/events/completeness-report
```

**Shows:** All events sorted by completeness (incomplete first)

---

## 📊 API Endpoints Cheat Sheet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/events/reconcile/{event_id}` | GET | Fix missing fight pairings for one event |
| `/events/reconcile/all` | POST | Fix all upcoming events |
| `/events/check-completeness/{event_id}` | GET | Diagnostic check (no changes) |
| `/events/completeness-report` | GET | Batch status report |

---

## 🔍 How to Read Responses

### Good Response ✅

```json
{
  "event_id": "uuid",
  "status": "complete",
  "created_fights": 0,
  "missing_fights": 0
}
```

**Meaning:** Event is complete, no action needed.

---

### Action Needed ⚠️

```json
{
  "event_id": "uuid",
  "status": "incomplete",
  "created_fights": 2,
  "missing_fights": 1
}
```

**Meaning:** System created 2 bouts, but 1 still missing (fighter not in DB yet).

---

### Missing Fighters 🔴

```json
{
  "details": [{
    "action": "missing_fighters",
    "bout": "Jon Jones vs TBA",
    "fighter_a_in_db": true,
    "fighter_b_in_db": false
  }]
}
```

**Meaning:** Tom Aspinall not in database yet → wait for Agent 2 to profile him.

---

## ⚙️ Configuration

### Change Reconciliation Interval

Default: Every 6 hours

```sql
-- Change to every 12 hours
UPDATE config SET value = '12' 
WHERE key = 'event_reconcile_interval_hours';

-- Change to every 3 hours
UPDATE config SET value = '3' 
WHERE key = 'event_reconcile_interval_hours';
```

---

### Disable Automatic Reconciliation

```sql
-- Set to very long interval (effectively disabled)
UPDATE config SET value = '999' 
WHERE key = 'event_reconcile_interval_hours';
```

**Note:** Manual endpoints still work.

---

## 🐛 Troubleshooting

### Problem: Event Still Incomplete After Reconciliation

**Step 1: Check what's missing**
```bash
curl http://localhost:8000/events/check-completeness/{event_id}
```

**Step 2: Look for `missing_fighters` in response**

If you see:
```json
"missing_fights": 1,
"details": [{
  "fighter_a_in_db": true,
  "fighter_b_in_db": false
}]
```

**Solution:** Wait for Agent 2 to process the missing fighter, then run reconciliation again.

---

### Problem: Reconciliation Not Running Automatically

**Check scheduler logs:**
```bash
tail -f backend/logs/app.log | grep "event_fight_reconciliation"
```

**Expected output (every 6 hours):**
```
[event_fight_reconciliation] Starting event fight pairing reconciliation...
[event_fight_reconciliation] Completed. Events processed: 5, Fights created: 3
```

**If nothing appears:**
- Scheduler may not have started
- Check `scheduler/tasks.py` line 100 (job registration)
- Restart backend server

---

### Problem: Activity Log Empty

**Query to check:**
```sql
SELECT * FROM activity_log 
WHERE agent_name = 'Reconciler' 
ORDER BY created_at DESC 
LIMIT 5;
```

**If empty:**
1. Verify reconciliation actually ran (check console logs)
2. Check `activity_log` table exists:
   ```sql
   \d activity_log
   ```
3. Verify Supabase connection is working

---

## 📈 Monitoring Queries

### Daily Reconciliation Summary

```sql
SELECT 
    DATE(created_at) as date,
    COUNT(*) as reconciliations,
    SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as successful,
    SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial
FROM activity_log
WHERE agent_name = 'Reconciler'
GROUP BY DATE(created_at)
ORDER BY date DESC
LIMIT 7;
```

---

### Current Incomplete Events

```sql
WITH event_counts AS (
    SELECT 
        e.id,
        e.name,
        COUNT(ef.id) as actual_fights
    FROM events e
    LEFT JOIN event_fights ef ON e.id = ef.event_id
    WHERE e.status = 'Upcoming'
    GROUP BY e.id, e.name
)
SELECT 
    name as event_name,
    actual_fights,
    CASE 
        WHEN actual_fights < 10 THEN 'INCOMPLETE'
        ELSE 'OK'
    END as status
FROM event_counts
WHERE actual_fights < 10
ORDER BY actual_fights ASC;
```

---

### Recent Fighter Processing

```sql
-- Shows fighters added in last 24 hours
SELECT 
    first_name || ' ' || last_name as fighter,
    created_at,
    admin_status
FROM fighters
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

---

## 🎯 Common Workflows

### Workflow 1: New Event Just Scanned

**Scenario:** Agent 1 just scanned "UFC 300", some fighters queued

**Steps:**
1. Wait for Agent 2 to process queued fighters (automatic, ~5 min intervals)
2. Monitor progress:
   ```bash
   curl http://localhost:8000/pipeline/jobs
   ```
3. Once fighters show `status: "complete"`, verify event:
   ```bash
   curl http://localhost:8000/events/check-completeness/{event_id}
   ```
4. If still incomplete, manually trigger:
   ```bash
   curl -X POST http://localhost:8000/events/reconcile/{event_id}
   ```

---

### Workflow 2: Old Event Needs Repair

**Scenario:** Historical event missing fight pairings

**Steps:**
1. Get event ID:
   ```bash
   curl http://localhost:8000/events
   ```
2. Check completeness:
   ```bash
   curl http://localhost:8000/events/check-completeness/{event_id}
   ```
3. Trigger reconciliation:
   ```bash
   curl -X POST http://localhost:8000/events/reconcile/{event_id}
   ```
4. Verify fix:
   ```bash
   curl http://localhost:8000/events/check-completeness/{event_id}
   ```

---

### Workflow 3: Batch Health Check

**Scenario:** Want to see status of all events

**Steps:**
1. Get batch report:
   ```bash
   curl http://localhost:8000/events/completeness-report
   ```
2. Look for `"incomplete_count": N` where N > 0
3. Review individual reports for problem events
4. Fix all at once:
   ```bash
   curl -X POST http://localhost:8000/events/reconcile/all
   ```

---

## 📝 Code Examples

### Python: Check and Fix

```python
import requests

BASE_URL = "http://localhost:8000"

def ensure_event_complete(event_id: str):
    # Step 1: Check current status
    resp = requests.get(f"{BASE_URL}/events/check-completeness/{event_id}")
    data = resp.json()
    
    if data.get("is_complete"):
        print(f"✅ Event {data['event_name']} is already complete")
        return True
    
    # Step 2: Trigger reconciliation
    print(f"⚠️  Event incomplete. Missing {len(data.get('missing_bouts', []))} bouts")
    print("🔧 Running reconciliation...")
    
    resp = requests.post(f"{BASE_URL}/events/reconcile/{event_id}")
    result = resp.json()
    
    created = result.get("created_fights", 0)
    missing = result.get("missing_fights", 0)
    
    print(f"✓ Created {created} new fight records")
    
    if missing > 0:
        print(f"⚠️  Still missing {missing} fights (fighters not in DB)")
        return False
    
    print(f"✅ Event {result['event_name']} now complete!")
    return True

# Usage
ensure_event_complete("your-event-id-here")
```

---

### Python: Monitor All Events

```python
def monitor_all_events():
    resp = requests.get(f"{BASE_URL}/events/completeness-report")
    data = resp.json()
    
    print(f"Total Events: {data['total_events']}")
    print(f"Complete: {data['complete_count']}")
    print(f"Incomplete: {data['incomplete_count']}\n")
    
    for report in data['reports']:
        status_icon = "✅" if report.get('is_complete') else "❌"
        print(f"{status_icon} {report['event_name']}")
        
        if not report.get('is_complete'):
            missing = len(report.get('missing_bouts', []))
            print(f"   └─ Missing {missing} bout(s)")
    
    return data['incomplete_count'] == 0

# Usage
all_good = monitor_all_events()
if not all_good:
    print("\n⚠️  Some events need attention!")
else:
    print("\n✅ All events complete!")
```

---

## 🎓 Understanding the System

### Key Concepts

**Event Fight Reconciliation:**
- Process of ensuring `event_fights` table matches actual fight card
- Creates missing pairings when both fighters exist in database
- Runs automatically and on-demand

**Completeness Status:**
- `is_complete: true` → All expected bouts recorded
- `is_complete: false` → Some bouts missing (usually fighters not in DB yet)

**Idempotency:**
- Safe to run unlimited times
- No duplicate records created
- Only adds what's missing

---

### Data Flow Diagram

```
Agent 1 scans event
   ↓
Creates event_fights for known fighters
   ↓
Queues new fighters for Agent 2
   ↓
Agent 2 profiles fighter
   ↓
⚡ RECONCILIATION TRIGGERED
   ↓
Checks: Are BOTH fighters now in DB?
   ↓
YES → Create event_fights ✓
NO  → Wait for next trigger
   ↓
Scheduler runs every 6h (backup)
   ↓
Manual endpoints (final fallback)
```

---

## 🔐 Permissions & Access

All reconciliation endpoints are **unauthenticated** in development mode.

For production deployment, consider adding:

```python
# Add authentication middleware
@app.post("/events/reconcile/{event_id}")
async def reconcile_event(event_id: str, user: User = Depends(get_current_admin_user)):
    ...
```

---

## 📚 Related Documentation

- Full implementation guide: `EVENT_FIGHT_INTEGRITY.md`
- Implementation summary: `IMPLEMENTATION_SUMMARY.md`
- Original audit report: `DATA_ENGINE_AUDIT.md`
- Main README: `README.md`

---

## 🆘 Getting Help

**Issue:** Something's not working

**First steps:**
1. Check logs: `tail -f backend/logs/app.log`
2. Check activity_log table
3. Test with single event endpoint
4. Review error messages

**Still stuck?**
- Consult `EVENT_FIGHT_INTEGRITY.md` troubleshooting section
- Check if scheduler is running
- Verify Supabase connection
- Review recent code changes

---

**Last Updated:** March 26, 2026  
**Version:** 1.0  
**Status:** Production Ready ✅
