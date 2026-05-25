import requests
import os

class BraveSearch:
    def __init__(self):
        self.api_key = os.getenv("BRAVE_API_KEY")
        self.base_url = "https://api.search.brave.com/res/v1/web/search"

    def search(self, query: str, count: int = 5):
        if not self.api_key:
            print("Brave API Key not found.")
            return []

        headers = {
            "Accept": "application/json",
            "X-Subscription-Token": self.api_key
        }
        params = {
            "q": query,
            "count": count
        }

        try:
            response = requests.get(
                self.base_url,
                headers=headers,
                params=params,
                timeout=15,  # Prevent indefinite hangs that would freeze the pipeline
            )
            response.raise_for_status()
            data = response.json()
            return data.get("web", {}).get("results", [])
        except requests.exceptions.Timeout:
            print(f"Brave Search Timeout (>15s) for query: {query!r}")
            return []
        except Exception as e:
            print(f"Brave Search Error: {e}")
            return []
