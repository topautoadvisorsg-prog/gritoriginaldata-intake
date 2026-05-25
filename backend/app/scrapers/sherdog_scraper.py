import re
from datetime import datetime
from typing import Dict, List, Optional
from app.scrapers.base_scraper import BaseScraper


class SherdogScraper(BaseScraper):
    """
    Scraper for sherdog.com fighter pages.
    All selectors validated against live HTML (March 2026).

    Key confirmed selectors:
      - Name:       .fn
      - Nickname:   .nickname em
      - DOB:        span[itemprop="birthDate"]   text: "Jul 19, 1987"
      - Height cm:  .bio-holder table tr[label=HEIGHT] second td
      - Weight class: .association-class a (last link)
      - Gym:        .association (first link in .association-class)
      - Image:      img.profile-image[itemprop="image"]  (src is relative)
      - Record wins/losses/nc: .winloses.win/.lose/.nc span:last-child
      - Win breakdown:
          .wins .meter:nth-of-type(1) .pl  → KO/TKO wins
          .wins .meter:nth-of-type(2) .pl  → Submission wins
          .wins .meter:nth-of-type(3) .pl  → Decision wins
      - Fight history: .fight_history tr (first row is header)
          td[0] .final_result  → 'win' | 'loss' | 'draw' | 'nc'
          td[1] a              → opponent name
          td[2] span[itemprop="award"] → event name
          td[2] .sub_line      → date "Nov / 16 / 2024"
          td[3] .winby b       → method full string e.g. "TKO (Punches)"
          td[3] .sub_line a    → referee
          td[4]                → round number
          td[5]                → time "4:29"
    """

    def __init__(self):
        super().__init__()
        self.base_url = "https://www.sherdog.com"

    def search_event(self, event_name: str) -> str:
        pass

    def get_fighter_profile(self, fighter_url: str) -> dict:
        soup = self.get_soup(fighter_url)
        if not soup:
            return {}

        profile: dict = {}

        # ── Identity ──────────────────────────────────────────────────────────
        fn = soup.select_one(".fn")
        profile["name"] = fn.text.strip() if fn else ""

        nick = soup.select_one(".nickname em")
        profile["nickname"] = nick.text.strip() if nick else ""

        dob_el = soup.select_one("span[itemprop='birthDate']")
        profile["dob"] = self._parse_sherdog_date(dob_el.text.strip()) if dob_el else None

        img = soup.select_one("img.profile-image[itemprop='image']")
        if img and img.get("src"):
            src = img["src"]
            profile["image_url"] = src if src.startswith("http") else f"https://www.sherdog.com{src}"

        # ── Physical ──────────────────────────────────────────────────────────
        bio = soup.select_one(".bio-holder")
        if bio:
            for row in bio.select("table tr"):
                tds = row.select("td")
                if len(tds) < 2:
                    continue
                label = tds[0].text.strip().upper()
                val = tds[1].text.strip()
                if label == "HEIGHT":
                    profile["height_cm"] = self._parse_cm(val)
                elif label == "WEIGHT":
                    profile["weight_kg"] = self._parse_kg(val)

        # ── Career ────────────────────────────────────────────────────────────
        assoc_block = soup.select_one(".association-class")
        if assoc_block:
            links = assoc_block.select("a")
            if links:
                profile["team"] = links[0].text.strip()
                profile["gym"] = links[0].text.strip()
            if len(links) >= 2:
                profile["weight_class"] = links[-1].text.strip()

        # ── Record ────────────────────────────────────────────────────────────
        wins_el = soup.select_one(".winloses.win span:last-child")
        profile["record_wins"] = self._safe_int(wins_el.text if wins_el else "0")

        loss_el = soup.select_one(".winloses.lose span:last-child")
        profile["record_losses"] = self._safe_int(loss_el.text if loss_el else "0")

        nc_el = soup.select_one(".winloses.nc span:last-child")
        profile["record_nc"] = self._safe_int(nc_el.text if nc_el else "0")

        # Sherdog does not expose draws, reach, or stance on fighter pages.
        # Draws: default 0 (Sherdog omits the element when count is 0).
        draw_el = soup.select_one(".winloses.draw span:last-child")
        profile["record_draws"] = self._safe_int(draw_el.text if draw_el else "0")

        # ── Win breakdown (.wins div → ordered .meter divs .pl = count) ───────
        wins_section = soup.select_one(".wins")
        if wins_section:
            meters = wins_section.select(".meter .pl")
            if len(meters) >= 1:
                profile["ko_wins"] = self._safe_int(meters[0].text)
            if len(meters) >= 2:
                profile["sub_wins"] = self._safe_int(meters[1].text)
            if len(meters) >= 3:
                profile["dec_wins"] = self._safe_int(meters[2].text)

        # ── Loss breakdown (.loses div) ────────────────────────────────────────
        loses_section = soup.select_one(".loses")
        if loses_section:
            meters = loses_section.select(".meter .pl")
            if len(meters) >= 1:
                profile["losses_by_ko"] = self._safe_int(meters[0].text)
            if len(meters) >= 2:
                profile["losses_by_submission"] = self._safe_int(meters[1].text)
            if len(meters) >= 3:
                profile["losses_by_decision"] = self._safe_int(meters[2].text)

        return profile

    def get_fighter_history(self, fighter_url: str) -> List[Dict]:
        """
        Extract all historical bouts from a Sherdog fighter page.
        """
        soup = self.get_soup(fighter_url)
        if not soup:
            return []

        hist_section = soup.select_one(".fight_history")
        if not hist_section:
            return []

        bouts = []
        rows = hist_section.select("tr")
        for row in rows[1:]:
            try:
                tds = row.select("td")
                if len(tds) < 4:
                    continue

                result_el = tds[0].select_one(".final_result")
                result = result_el.text.strip() if result_el else ""

                opp_el = tds[1].select_one("a")
                opponent_name = opp_el.text.strip() if opp_el else ""

                event_el = tds[2].select_one("span[itemprop='award']")
                event_name = event_el.text.strip() if event_el else ""

                date_el = tds[2].select_one(".sub_line")
                date_raw = date_el.text.strip() if date_el else ""
                fight_date = self._parse_sherdog_date(date_raw)

                method_el = tds[3].select_one("b")
                method_full = method_el.text.strip() if method_el else ""
                method, method_detail = self._parse_method(method_full)

                referee_el = tds[3].select_one(".sub_line a")
                referee = referee_el.text.strip() if referee_el else ""

                round_num = None
                time_str = ""
                if len(tds) >= 5:
                    rt = tds[4].text.strip()
                    round_num = int(rt) if rt.isdigit() else None
                if len(tds) >= 6:
                    time_str = tds[5].text.strip()

                title_fight = "title" in event_name.lower() or "championship" in event_name.lower()

                bouts.append({
                    "result": result,
                    "opponent_name": opponent_name,
                    "event_name": event_name,
                    "date": fight_date,
                    "fight_date": fight_date,
                    "method": method,
                    "method_detail": method_detail,
                    "referee": referee,
                    "round": round_num,
                    "time": time_str,
                    "title_fight": title_fight,
                })
            except Exception as e:
                print(f"Error parsing Sherdog history row: {e}")
                continue

        return bouts

    def _parse_sherdog_date(self, date_str: str) -> Optional[str]:
        """
        'Nov / 16 / 2024' → '2024-11-16'
        'Jul 19, 1987'    → '1987-07-19'
        """
        if not date_str:
            return None
        clean = date_str.replace(" / ", "/").strip()
        for fmt in ["%b/%d/%Y", "%B/%d/%Y", "%b %d, %Y", "%B %d, %Y"]:
            try:
                return datetime.strptime(clean, fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
        return None

    def _parse_method(self, method_full: str) -> tuple:
        """
        'TKO (Spinning Back Kick and Punches)' → ('TKO', 'Spinning Back Kick and Punches')
        'Decision (Unanimous)'                 → ('Decision', 'Unanimous')
        """
        match = re.match(r"^([^(]+?)(?:\s*\((.+)\))?$", method_full.strip())
        if match:
            method = match.group(1).strip()
            detail = match.group(2).strip() if match.group(2) else ""
            return method, detail
        return method_full, ""

    def _parse_cm(self, text: str) -> Optional[float]:
        """'6\'4" / 193.04 cm' → 193.04"""
        match = re.search(r"([\d.]+)\s*cm", text, re.IGNORECASE)
        return float(match.group(1)) if match else None

    def _parse_kg(self, text: str) -> Optional[float]:
        """'238 lbs / 107.95 kg' → 107.95"""
        match = re.search(r"([\d.]+)\s*kg", text, re.IGNORECASE)
        return float(match.group(1)) if match else None

    def _safe_int(self, text: str) -> int:
        try:
            return int(str(text).strip())
        except (ValueError, TypeError):
            return 0
