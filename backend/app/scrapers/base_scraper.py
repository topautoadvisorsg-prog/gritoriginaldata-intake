import requests
from bs4 import BeautifulSoup
from typing import Optional, List
import abc

class BaseScraper(abc.ABC):
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        })

    def get_soup(self, url: str) -> Optional[BeautifulSoup]:
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return BeautifulSoup(response.text, "html.parser")
        except Exception as e:
            print(f"Error scraping {url}: {e}")
            return None

    @abc.abstractmethod
    def search_event(self, event_name: str) -> List[str]:
        """Search for an event and return fighter names."""
        pass

    @abc.abstractmethod
    def get_fighter_profile(self, fighter_name: str) -> dict:
        """Collect profile data for a fighter."""
        pass
