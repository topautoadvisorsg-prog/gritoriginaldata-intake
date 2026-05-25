import os
from dotenv import load_dotenv
from app.agents.pipeline_manager import PipelineManager
import time

load_dotenv()

def run_test():
    pm = PipelineManager()
    event_name = "UFC 300: Pereira vs. Hill" # A major recent event
    
    print(f"--- Starting Live E2E Test: {event_name} ---")
    
    # 1. Trigger Event Scan (Agent 1)
    print("\n[Step 1] Triggering Event Agent...")
    result = pm.run_event_scan(event_name)
    print(f"Result: {result}")
    
    # 2. Process the results (Agent 2 and 3)
    # The scan will have queued fighters in pipeline_jobs.
    # Normally the scheduler picks this up, but we'll trigger it manually.
    print("\n[Step 2] Processing Queued Fighters (Agents 2 & 3)...")
    pm.process_queued_fighters()
    
    print("\n--- E2E Test Sequence Finished ---")

if __name__ == "__main__":
    run_test()
