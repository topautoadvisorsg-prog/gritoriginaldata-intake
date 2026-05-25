import json
import os
import re
import requests
from bs4 import BeautifulSoup
from typing import Optional, Dict, Tuple
import logging

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

ODDS_RE = re.compile(r'^[+-]?\d{2,5}$')
MONEYLINE_RE = re.compile(r'([+-]\d{2,4})')


def _name_match(target: str, candidate: str) -> bool:
    t = target.strip().lower()
    c = candidate.strip().lower()
    if t in c or c in t:
        return True
    parts = t.split()
    return any(len(p) > 3 and p in c for p in parts)


def _normalise_odds(raw: str) -> Optional[str]:
    """
    Normalises a raw odds string to American moneyline format.
    Handles arrow indicators (▲/▼), EVEN/PK lines, and numeric values.
    Returns None when the value is clearly not an odds line (e.g. "--").
    """
    clean = raw.replace('\u25b2', '').replace('\u25bc', '').strip()
    if clean.upper() in ("EVEN", "PK", "PK'EM", "PICK"):
        return "+100"
    if ODDS_RE.match(clean):
        return clean
    return None


def _first_valid_odds(spans) -> Optional[str]:
    for s in spans:
        val = s.text.strip()
        normalised = _normalise_odds(val)
        if normalised is not None:
            return normalised
    return None


class BestFightOddsScraper:
    """
    Primary odds source — scrapes bestfightodds.com.

    Two-stage approach:
      Stage 1 — Homepage (fighter discovery):
        div.table-header > a[href*="/events/"] → event URL
        div.table-header.find_next_sibling("table") > tr > th > span.t-b-fcc → fighter names
        (Homepage has NO odds cells — all odds are JS-loaded on the homepage)

      Stage 2 — Event page (actual odds):
        table.odds-table tr > th[scope=row] > span.t-b-fcc → fighter name
        table.odds-table tr > td.but-sg > span[id^="oID"] → moneyline (server-rendered)
        table.odds-table tr.pr > th[scope=row] → method description
        table.odds-table tr.pr > td.but-sg > span[id^="oID"] → method odds (JS-loaded, may be absent)
    """
    BASE_URL = "https://www.bestfightodds.com"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def _fetch_soup(self, url: str) -> Optional[BeautifulSoup]:
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "html.parser")
        except Exception as e:
            logger.error(f"BestFightOdds fetch error ({url}): {e}")
            return None

    def _find_event_url(
        self, homepage_soup: BeautifulSoup, fighter_a: str, fighter_b: str
    ) -> Optional[str]:
        """
        Scans homepage event blocks (div.table-header + next sibling table) to find
        the event listing both fighters. Returns the BFO event page URL.
        """
        headers = homepage_soup.select("div.table-header")
        for header in headers:
            event_link = header.select_one('a[href*="/events/"]')
            if not event_link:
                continue
            table = header.find_next_sibling("table")
            if not table:
                continue

            fighters_in_event = [
                span.text.strip()
                for span in table.select("span.t-b-fcc")
            ]

            a_found = any(_name_match(fighter_a, f) for f in fighters_in_event)
            b_found = any(_name_match(fighter_b, f) for f in fighters_in_event)

            if a_found and b_found:
                event_url = self.BASE_URL + event_link["href"]
                logger.info(f"BFO: '{fighter_a}' vs '{fighter_b}' → {event_url}")
                return event_url
            elif a_found or b_found:
                found = fighter_a if a_found else fighter_b
                logger.debug(
                    f"BFO: found '{found}' in {event_link['href']} but not opponent."
                )

        return None

    def _parse_event_page(
        self, event_url: str, fighter_a: str, fighter_b: str
    ) -> Dict:
        """
        Fetches the BFO event page and extracts:
          - Moneylines from standard fighter rows (td.but-sg > span[id^="oID"], server-rendered)
          - Method odds from tr.pr rows (JS-loaded; values absent server-side, returns None)
        """
        result: Dict = {
            "fighter_a_line": None,
            "fighter_b_line": None,
            "method_ko_tko": None,
            "method_submission": None,
            "method_decision": None,
            "over_under": None,
        }

        soup = self._fetch_soup(event_url)
        if not soup:
            return result

        tables = [
            t for t in soup.select("table.odds-table")
            if "odds-table-responsive-header" not in t.get("class", [])
        ]
        if not tables:
            return result
        table = tables[0]
        rows = table.select("tr")

        a_row_idx: Optional[int] = None
        b_row_idx: Optional[int] = None

        for i, row in enumerate(rows):
            name_el = row.select_one("span.t-b-fcc")
            if not name_el:
                continue
            name = name_el.text.strip()
            odds_spans = row.select("td.but-sg span[id^='oID']")
            line = _first_valid_odds(odds_spans)

            if result["fighter_a_line"] is None and _name_match(fighter_a, name):
                result["fighter_a_line"] = line
                a_row_idx = i
                logger.info(f"BFO event: '{fighter_a}' → '{name}' line={line}")
            elif result["fighter_b_line"] is None and _name_match(fighter_b, name):
                result["fighter_b_line"] = line
                b_row_idx = i
                logger.info(f"BFO event: '{fighter_b}' → '{name}' line={line}")

        if a_row_idx is not None or b_row_idx is not None:
            start = min(x for x in [a_row_idx, b_row_idx] if x is not None)
            for pr_row in rows[start + 1:]:
                pr_classes = pr_row.get("class", [])
                if "pr" not in pr_classes:
                    if pr_row.select_one("span.t-b-fcc"):
                        break
                    continue
                desc_el = pr_row.select_one("th[scope='row']")
                if not desc_el:
                    continue
                desc = desc_el.text.strip().lower()
                odds_spans = pr_row.select("td.but-sg span[id^='oID']")
                line = _first_valid_odds(odds_spans)

                if ("tko" in desc or "ko" in desc) and result["method_ko_tko"] is None:
                    result["method_ko_tko"] = line
                elif "submission" in desc and result["method_submission"] is None:
                    result["method_submission"] = line
                elif "decision" in desc and result["method_decision"] is None:
                    result["method_decision"] = line
                elif (
                    ("over" in desc or "under" in desc) and result["over_under"] is None
                ):
                    result["over_under"] = line

        logger.info(
            f"BFO parsed: a={result['fighter_a_line']} b={result['fighter_b_line']} "
            f"ko={result['method_ko_tko']} sub={result['method_submission']} "
            f"dec={result['method_decision']} ou={result['over_under']}"
        )
        return result

    def get_odds(self, fighter_a: str, fighter_b: str) -> Optional[Dict]:
        homepage_soup = self._fetch_soup(self.BASE_URL)
        if not homepage_soup:
            return None

        event_url = self._find_event_url(homepage_soup, fighter_a, fighter_b)
        if not event_url:
            logger.warning(
                f"BFO: no upcoming event found for '{fighter_a}' vs '{fighter_b}'"
            )
            return None

        data = self._parse_event_page(event_url, fighter_a, fighter_b)
        if data["fighter_a_line"] is None and data["fighter_b_line"] is None:
            logger.warning(
                f"BFO event page had no odds for '{fighter_a}' vs '{fighter_b}'"
            )
            return None

        return {**data, "source": "bestfightodds.com"}


class OddsSharkScraper:
    """
    Fallback odds source — scrapes oddsshark.com/ufc/odds.

    OddsShark reliably server-renders opening moneylines.

    Structure (confirmed working):
      div.odds--group__event-container
        div.odds--group__event-participants > div.participant-name[title] — fighter names
        div.odds--group__event-books
          div.odds-moneyline.moneyline-only
            div[data-odds-moneyline='{"fullgame":"VALUE"}'] — moneyline per fighter
    """
    ODDSSHARK_URL = "https://www.oddsshark.com/ufc/odds"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def _fetch(self, url: str, timeout: int = 12) -> Optional[requests.Response]:
        try:
            resp = self.session.get(url, timeout=timeout)
            return resp
        except Exception as e:
            logger.error(f"OddsSharkScraper fetch error ({url}): {e}")
            return None

    def get_odds(self, fighter_a: str, fighter_b: str) -> Optional[Dict]:
        resp = self._fetch(self.ODDSSHARK_URL)
        if not resp or resp.status_code != 200 or len(resp.content) == 0:
            logger.error("OddsShark unavailable.")
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        containers = soup.select("div.odds--group__event-container")
        logger.info(f"OddsShark: {len(containers)} event containers")

        for container in containers:
            participant_divs = container.select("div.participant-name")
            if len(participant_divs) < 2:
                continue

            name_a = participant_divs[0].get("title", "")
            name_b = participant_divs[1].get("title", "")

            a_found = _name_match(fighter_a, name_a) or _name_match(fighter_a, name_b)
            b_found = _name_match(fighter_b, name_a) or _name_match(fighter_b, name_b)
            if not (a_found and b_found):
                continue

            first_row = container.select_one("div.first-row")
            second_row = container.select_one("div.second-row")

            def _extract_from_row(row) -> Optional[str]:
                if not row:
                    return None
                for el in row.select("[data-odds-moneyline]"):
                    raw = el.get("data-odds-moneyline", "")
                    try:
                        val = json.loads(raw).get("fullgame", "")
                        normalised = _normalise_odds(val)
                        if normalised is not None:
                            return normalised
                    except (json.JSONDecodeError, AttributeError):
                        pass
                    normalised = _normalise_odds(el.text.strip())
                    if normalised is not None:
                        return normalised
                return None

            line_1 = _extract_from_row(first_row)
            line_2 = _extract_from_row(second_row)

            if _name_match(fighter_a, name_a):
                a_line, b_line = line_1, line_2
            else:
                a_line, b_line = line_2, line_1

            logger.info(
                f"OddsShark: '{fighter_a}'={a_line} '{fighter_b}'={b_line} "
                f"(event container: {name_a} vs {name_b})"
            )
            return {
                "fighter_a_line": a_line,
                "fighter_b_line": b_line,
                "source": "oddsshark.com",
            }

        logger.warning(
            f"OddsShark: no matchup found for '{fighter_a}' vs '{fighter_b}'"
        )
        return None
