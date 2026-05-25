import os
import sys

# Set dummy env vars for initialization
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "dummy_key"
os.environ["MAIN_APP_API_URL"] = "https://grit-app.com"

print(f"Python Executable: {sys.executable}")
print(f"Python Path: {sys.path}")

# Add backend to path
sys.path.append(os.path.join(os.getcwd(), "backend"))

from unittest.mock import MagicMock, patch
from app.agents.agent6_odds.agent import OddsAgent
from app.database.supabase_client import get_supabase

def test_odds_agent():
    print("--- Verifying Agent 6 (Odds Agent) ---")
    import sys
    print(f"Python Executable: {sys.executable}")
    print(f"Python Path: {sys.path}")
    
    # Mocking environment and responses
    with patch("requests.get") as mock_get:
        # Mock active cards from main app
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = [
            {
                "id": "event_123",
                "event_name": "UFC 306",
                "bouts": [
                    {
                        "fighter_a": {"name": "Sean O'Malley"},
                        "fighter_b": {"name": "Merab Dvalishvili"}
                    }
                ]
            }
        ]

        agent = OddsAgent()
        
        # Mock Supabase
        agent.supabase = MagicMock()
        agent.supabase.table().insert().execute.return_value = MagicMock(data=[{"id": "odds_123"}])

        print("\n[Step 1] Running OddsAgent.run()...")
        agent.run()
        
        print("\n[Step 2] Verifying calls...")
        # Check if insert was called
        if agent.supabase.table().insert.called:
            print("SUCCESS: Supabase insert was called with odds data.")
            inserted_data = agent.supabase.table().insert.call_args[0][0]
            print(f"Data matches: {inserted_data['fighter_a_line']} (A) vs {inserted_data['fighter_b_line']} (B)")
        else:
            print("FAILURE: Supabase insert was NOT called.")

    print("\n--- Verification Finished ---")

if __name__ == "__main__":
    test_odds_agent()
