import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from app.scrapers.base_scraper import BaseScraper


class UFCStatsScraper(BaseScraper):
    """
    Scraper for http://ufcstats.com — publicly accessible, no Cloudflare protection.
    Used for event fight cards (Agent 1) and fighter stat lookups.
    """

    BASE_URL = "http://ufcstats.com"

    def __init__(self):
        super().__init__()

    def search_event(self, event_name: str) -> str:
        pass

    def get_fighter_profile(self, fighter_url: str) -> dict:
        return {}

    def get_fight_card(self, event_url: str) -> Dict:
        """
        Parse an ufcstats.com event page.
        Returns { fighters: [...], bouts: [...], metadata: {...} }

        Confirmed structure (validated against live pages):
          - Event title: h2.b-content__title-highlight
          - Date/Location: li.b-list__box-list-item  ("Date: March 28, 2026")
          - Bouts: tr.b-fight-details__table-row__hover
              col[1]: two fighter <a> links
              col[6]: weight class text
        """
        soup = self.get_soup(event_url)
        if not soup:
            return {"fighters": [], "bouts": [], "metadata": {}}

        title_el = soup.select_one(".b-content__title-highlight")
        event_name = title_el.text.strip() if title_el else ""

        date_str = ""
        location_str = ""
        for item in soup.select(".b-list__box-list-item"):
            text = item.text.strip()
            if text.startswith("Date:"):
                date_str = text.replace("Date:", "").strip()
            elif text.startswith("Location:"):
                location_str = text.replace("Location:", "").strip()

        iso_date = self._parse_date(date_str)

        metadata = {
            "event_name": event_name,
            "date": iso_date or date_str,
            "location": location_str,
            "poster_url": None,
            "lock_time": iso_date,
            "status": "Completed" if iso_date and iso_date < datetime.today().strftime("%Y-%m-%d") else "Upcoming",
        }

        fighters: list = []
        bouts: list = []

        rows = soup.select("tr.b-fight-details__table-row__hover")
        for row in rows:
            tds = row.select("td")
            if len(tds) < 7:
                continue

            fighter_links = tds[1].select("a.b-link")
            if len(fighter_links) < 2:
                continue

            name_a = fighter_links[0].text.strip()
            name_b = fighter_links[1].text.strip()

            weight_class = tds[6].text.strip().strip("\n").split("\n")[0].strip()

            fighters.extend([name_a, name_b])
            bouts.append({
                "fighter_a": name_a,
                "fighter_b": name_b,
                "weight_class": weight_class,
            })

        return {
            "fighters": list(set(f for f in fighters if f)),
            "bouts": bouts,
            "metadata": metadata,
        }

    def find_event_url(self, event_name: str) -> Optional[str]:
        """
        Search UFCStats events list for a matching event URL.
        Falls back to iterating completed + upcoming pages.
        """
        for path in ["/statistics/events/completed", "/statistics/events/upcoming"]:
            soup = self.get_soup(f"{self.BASE_URL}{path}")
            if not soup:
                continue
            for link in soup.select("a.b-link"):
                if event_name.lower() in link.text.lower():
                    href = link.get("href", "")
                    if "event-details" in href:
                        return href
        return None

    def list_upcoming_events(self, days_ahead: int = 30) -> List[Tuple[str, str]]:
        """
        Scrape the UFCStats upcoming events page and return a list of
        (event_name, event_url) tuples for events within the next `days_ahead` days.

        UFCStats upcoming page structure:
          - Rows: tr.b-statistics__table-row (skip the header row)
          - Event link: td:first-child a.b-link (text = event name, href = event URL)
          - Date: td:nth-child(2) span (text like "March 28, 2026")

        Returns an empty list if the page cannot be scraped.
        """
        soup = self.get_soup(f"{self.BASE_URL}/statistics/events/upcoming")
        if not soup:
            print("[UFCStatsScraper] Could not fetch upcoming events page.")
            return []

        cutoff = datetime.today() + timedelta(days=days_ahead)
        results: List[Tuple[str, str]] = []

        rows = soup.select("tr.b-statistics__table-row")
        for row in rows:
            cells = row.select("td")
            if not cells:
                continue

            link_el = cells[0].select_one("a.b-link") if len(cells) > 0 else None
            if not link_el:
                continue

            event_name = link_el.text.strip()
            event_url = link_el.get("href", "")

            if not event_url or "event-details" not in event_url:
                continue

            date_str = ""
            if len(cells) > 1:
                date_span = cells[1].select_one("span")
                if date_span:
                    date_str = date_span.text.strip()
                else:
                    date_str = cells[1].text.strip()

            iso_date = self._parse_date(date_str)
            if iso_date:
                try:
                    event_dt = datetime.strptime(iso_date, "%Y-%m-%d")
                    if event_dt > cutoff:
                        continue
                except ValueError:
                    pass

            if event_name and event_url:
                results.append((event_name, event_url))

        print(f"[UFCStatsScraper] Found {len(results)} upcoming events within {days_ahead} days.")
        return results

    def _parse_date(self, date_str: str) -> Optional[str]:
        """Convert 'March 28, 2026' → '2026-03-28'."""
        date_str = date_str.strip()
        for fmt in ["%B %d, %Y", "%b %d, %Y", "%b. %d, %Y"]:
            try:
                return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
        return None
