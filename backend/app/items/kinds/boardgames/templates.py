"""Built-in game templates: popular games with their official scoring sheets.

Each template is a ready ``Game`` (minus ``id``): player counts, play time,
BGG weight (approximate), tags, BGG id and the scoring setup taken from the
publisher's score pad / rulebook. ``aliases`` help match what people type
("TTR", "Settlers").
"""
from __future__ import annotations

import re
from typing import Any


def slug(text: str, n: int = 30) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:n].strip("-") or "x"


def cat(
    name: str,
    hint: str = "",
    *,
    mult: float = 1,
    sub: bool = False,
    options: list[int] | None = None,
    section: str = "",
    step: int = 1,
    cid: str | None = None,
    min: int | None = None,
    max: int | None = None,
    requires: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"id": cid or slug(name, 24), "name": name, "hint": hint, "section": section}
    if mult != 1:
        out["multiplier"] = mult
    if sub:
        out["subtract"] = True
    if options:
        out["options"] = options
    if step != 1:
        out["step"] = step
    if min is not None:
        out["min"] = min
    if max is not None:
        out["max"] = max
    if requires:
        out["requires"] = requires
    return out


def ex(name: str, categories: list[dict] | None = None, factions: list[str] | None = None) -> dict:
    return {"id": slug(name, 24), "name": name, "categories": categories or [], "factions": factions or []}


def T(
    tid: str,
    name: str,
    *,
    year: int,
    players: tuple[int, int],
    minutes: int,
    weight: float,
    tags: list[str],
    bgg: int | None,
    win: str = "high",
    pad: str = "categories",
    categories: list[dict] | None = None,
    bonuses: list[dict] | None = None,
    rounds: int | None = None,
    target: int | None = None,
    tiebreaker: str = "",
    notes: str = "",
    factions: list[str] | None = None,
    expansions: list[dict] | None = None,
    aliases: list[str] | None = None,
) -> dict:
    return {
        "id": tid,
        "name": name,
        "year": year,
        "min_players": players[0],
        "max_players": players[1],
        "play_minutes": minutes,
        "weight": weight,
        "categories": tags,
        "bgg_id": bgg,
        "scoring": {
            "win": win,
            "pad": pad,
            "categories": categories or [],
            "bonuses": bonuses or [],
            "rounds": rounds,
            "target_score": target,
            "tiebreaker": tiebreaker,
            "notes": notes,
            "factions": factions or [],
        },
        "expansions": expansions or [],
        "aliases": aliases or [],
    }


def _yahtzee() -> dict:
    upper = [
        cat("Ones", "Total of all 1s", options=[0, 1, 2, 3, 4, 5], section="Upper", max=5),
        cat("Twos", "Total of all 2s", options=[0, 2, 4, 6, 8, 10], section="Upper", max=10),
        cat("Threes", "Total of all 3s", options=[0, 3, 6, 9, 12, 15], section="Upper", max=15),
        cat("Fours", "Total of all 4s", options=[0, 4, 8, 12, 16, 20], section="Upper", max=20),
        cat("Fives", "Total of all 5s", options=[0, 5, 10, 15, 20, 25], section="Upper", max=25),
        cat("Sixes", "Total of all 6s", options=[0, 6, 12, 18, 24, 30], section="Upper", max=30),
    ]
    lower = [
        cat("3 of a kind", "Total of all five dice", section="Lower", max=30),
        cat("4 of a kind", "Total of all five dice", section="Lower", max=30),
        cat("Full house", "Scores 25", options=[0, 25], section="Lower", max=25),
        cat("Small straight", "Four in a row — scores 30", cid="sm-straight", options=[0, 30], section="Lower", max=30),
        cat("Large straight", "Five in a row — scores 40", cid="lg-straight", options=[0, 40], section="Lower", max=40),
        cat("Yahtzee", "Five of a kind — scores 50", options=[0, 50], section="Lower", max=50),
        cat("Chance", "Total of all five dice", section="Lower", max=30),
        cat("Yahtzee bonus", "100 for each extra Yahtzee — only once the Yahtzee box scored 50", cid="yahtzee-bonus", options=[0, 100, 200, 300], step=100, section="Lower", requires="yahtzee"),
    ]
    return T(
        "yahtzee", "Yahtzee", year=1956, players=(1, 10), minutes=30, weight=1.2,
        tags=["Dice", "Family"], bgg=2243, pad="categories",
        categories=upper + lower,
        bonuses=[{"id": "upper-bonus", "name": "Upper bonus", "categories": [c["id"] for c in upper], "threshold": 63, "points": 35}],
        tiebreaker="Ties are shared.",
        notes="13 rounds; each box is filled once (a 0 if you must scratch). 63+ in the upper section earns a 35 bonus.",
        aliases=["yatzy", "yahtzee scorecard"],
    )


TEMPLATES: list[dict] = [
    T(
        "wingspan", "Wingspan", year=2019, players=(1, 5), minutes=60, weight=2.45,
        tags=["Engine building", "Card drafting", "Animals"], bgg=266192,
        categories=[
            cat("Birds", "Points printed on your birds"),
            cat("Bonus cards"),
            cat("End-of-round goals"),
            cat("Eggs", "1 per egg"),
            cat("Food on cards", "1 per cached food token", cid="food"),
            cat("Tucked cards", "1 per tucked card", cid="tucked"),
        ],
        tiebreaker="The tied player with the most unused food tokens wins; if still tied, share the victory.",
        notes="4 rounds; the game ends after round 4.",
        expansions=[
            ex("European Expansion"),
            ex("Oceania Expansion", [cat("Nectar", "Majority of nectar per habitat (5 / 2)")]),
            ex("Asia"),
        ],
    ),
    T(
        "catan", "Catan", year=1995, players=(3, 4), minutes=90, weight=2.29,
        tags=["Trading", "Dice", "Classic"], bgg=13, target=10,
        categories=[
            cat("Settlements", "Count — 1 VP each"),
            cat("Cities", "Count — 2 VP each", mult=2),
            cat("Victory point cards", "Count — 1 VP each", cid="vp-cards"),
            cat("Longest Road", "2 VP", options=[0, 2], max=2),
            cat("Largest Army", "2 VP", options=[0, 2], max=2),
        ],
        tiebreaker="No tiebreak: the first player to reach 10 VP on their own turn wins.",
        notes="First to 10 victory points on their turn wins.",
        expansions=[
            ex("5–6 Player Extension"),
            ex("Seafarers"),
            ex("Cities & Knights", [
                cat("Metropolises", "Count — 2 VP each", mult=2),
                cat("Defender of Catan", "Count — 1 VP each", cid="defender"),
                cat("Merchant", "1 VP", options=[0, 1], max=1),
            ]),
        ],
        aliases=["settlers of catan", "settlers"],
    ),
    T(
        "ticket-to-ride", "Ticket to Ride", year=2004, players=(2, 5), minutes=45, weight=1.84,
        tags=["Route building", "Family", "Trains"], bgg=9209,
        categories=[
            cat("Routes claimed", "Points from your routes", cid="routes"),
            cat("Completed tickets", "Sum of completed destination tickets", cid="tickets"),
            cat("Incomplete tickets", "Sum of failed tickets (subtracted)", cid="failed", sub=True),
            cat("Longest path", "10 points", cid="longest", options=[0, 10], max=10),
        ],
        tiebreaker="Most completed destination tickets; then the holder of the Longest Path bonus.",
        aliases=["ttr", "ticket to ride usa"],
    ),
    T(
        "7-wonders", "7 Wonders", year=2010, players=(3, 7), minutes=30, weight=2.32,
        tags=["Card drafting", "Civilization"], bgg=68448,
        categories=[
            cat("Military", "Conflict tokens (defeats −1)", min=-6),
            cat("Treasury", "1 per 3 coins", cid="coins"),
            cat("Wonder", "Wonder stages built"),
            cat("Civilian", "Blue structures", cid="civilian"),
            cat("Commercial", "Yellow structures", cid="commercial"),
            cat("Guilds", "Purple guilds", cid="guilds"),
            cat("Science", "Sets of 7 + identical symbols²", cid="science"),
        ],
        tiebreaker="The tied player with the most coins wins; if still tied, share the victory.",
        expansions=[
            ex("Leaders", [cat("Leaders", "Leader cards")]),
            ex("Cities", [cat("Cities", "Black city cards"), cat("Debt", "Debt tokens (subtracted)", sub=True)]),
            ex("Armada", [cat("Naval", "Naval conflict tokens"), cat("Islands", "Island cards")]),
        ],
    ),
    T(
        "7-wonders-duel", "7 Wonders Duel", year=2015, players=(2, 2), minutes=30, weight=2.22,
        tags=["Card drafting", "Two-player"], bgg=173346,
        categories=[
            cat("Civilian", "Blue cards", cid="civilian"),
            cat("Science", "Green cards", cid="science"),
            cat("Commercial", "Yellow cards", cid="commercial"),
            cat("Guilds", "Purple guilds", cid="guilds"),
            cat("Wonders", "Your built wonders"),
            cat("Progress tokens", cid="progress"),
            cat("Coins", "1 per 3 coins"),
            cat("Military", "Conflict pawn position: 0 / 2 / 5 / 10", options=[0, 2, 5, 10], max=10),
        ],
        tiebreaker="Most civilian (blue) points wins; if still tied, share the victory.",
        notes="Military or scientific supremacy wins instantly — record those as a manual result (pick the winner).",
        expansions=[ex("Pantheon", [cat("Divinities", "Divinity cards", cid="gods")]), ex("Agora")],
        aliases=["duel"],
    ),
    T(
        "carcassonne", "Carcassonne", year=2000, players=(2, 5), minutes=40, weight=1.9,
        tags=["Tile placement", "Family", "Classic"], bgg=822,
        categories=[
            cat("Roads", "During play + incomplete at the end"),
            cat("Cities", "During play + incomplete at the end"),
            cat("Monasteries", "During play + incomplete at the end"),
            cat("Fields", "Farmers: 3 per completed city", cid="fields"),
        ],
        tiebreaker="Ties are shared.",
        expansions=[
            ex("Inns & Cathedrals"),
            ex("Traders & Builders", [cat("Trade goods", "10 per good-type majority")]),
            ex("The River"),
        ],
    ),
    T(
        "terraforming-mars", "Terraforming Mars", year=2016, players=(1, 5), minutes=120, weight=3.26,
        tags=["Engine building", "Space", "Economic"], bgg=167791,
        categories=[
            cat("Terraform rating", cid="tr"),
            cat("Awards", "5 for first, 2 for second (each funded award)"),
            cat("Milestones", "Count — 5 VP each", mult=5, max=3),
            cat("Greenery tiles", "1 per greenery", cid="greenery"),
            cat("Cities", "1 per adjacent greenery", cid="cities"),
            cat("Cards", "VP on your cards"),
        ],
        tiebreaker="The tied player with the most MegaCredits wins.",
        expansions=[ex("Prelude"), ex("Venus Next"), ex("Colonies"), ex("Turmoil"), ex("Hellas & Elysium")],
        aliases=["tfm"],
    ),
    T(
        "azul", "Azul", year=2017, players=(2, 4), minutes=40, weight=1.76,
        tags=["Abstract", "Pattern building", "Family"], bgg=230802,
        categories=[
            cat("Wall points", "Scored while tiling, rounds 1–last", cid="wall"),
            cat("Floor penalties", "Total lost on the floor line (subtracted)", cid="floor", sub=True),
            cat("Complete rows", "Count — 2 each", cid="rows", mult=2, max=5),
            cat("Complete columns", "Count — 7 each", cid="columns", mult=7, max=5),
            cat("Complete colours", "Count — 10 each", cid="colours", mult=10, max=5),
        ],
        tiebreaker="Most complete horizontal rows wins; if still tied, share the victory.",
    ),
    T(
        "scythe", "Scythe", year=2016, players=(1, 5), minutes=105, weight=3.44,
        tags=["Engine building", "Area control"], bgg=169786,
        categories=[
            cat("Coins in hand", cid="coins"),
            cat("Stars", "Coins for stars placed (by popularity tier)"),
            cat("Territories", "Coins per territory controlled (by tier)"),
            cat("Resources", "Coins per 2 resources controlled (by tier)"),
            cat("Structure bonus", "Per the structure bonus tile", cid="structures"),
        ],
        tiebreaker="Workers, then mechs, structures, recruits, resource tokens, combat cards and popularity.",
        notes="The game ends when someone places their 6th star.",
        factions=["Nordic", "Rusviet", "Polania", "Crimea", "Saxony"],
        expansions=[ex("Invaders from Afar", factions=["Albion", "Togawa"]), ex("The Wind Gambit"), ex("The Rise of Fenris")],
    ),
    T(
        "everdell", "Everdell", year=2018, players=(1, 4), minutes=60, weight=2.81,
        tags=["Worker placement", "Tableau", "Animals"], bgg=199792,
        categories=[
            cat("Base cards", "Printed points on your cards", cid="cards"),
            cat("Point tokens", cid="tokens"),
            cat("Basic events", "Count — 3 each", cid="basic-events", mult=3, max=4),
            cat("Special events", cid="special-events"),
            cat("Prosperity cards", "Purple card bonuses", cid="prosperity"),
            cat("Journey"),
        ],
        tiebreaker="Most events achieved; then most leftover resources.",
        expansions=[
            ex("Pearlbrook", [cat("Pearls", "Count — 2 each", mult=2), cat("Wonders"), cat("Adornments")]),
            ex("Spirecrest"), ex("Bellfaire"), ex("Newleaf"),
        ],
    ),
    T(
        "splendor", "Splendor", year=2014, players=(2, 4), minutes=30, weight=1.79,
        tags=["Engine building", "Family"], bgg=148228, target=15,
        categories=[
            cat("Development cards", "Prestige on your cards", cid="cards"),
            cat("Nobles", "Count — 3 each", mult=3, max=5),
        ],
        tiebreaker="Fewest development cards purchased wins.",
        notes="Reaching 15 prestige triggers the end of the round.",
        expansions=[ex("Cities of Splendor")],
    ),
    T(
        "dominion", "Dominion", year=2008, players=(2, 4), minutes=30, weight=2.35,
        tags=["Deck building", "Card game"], bgg=36218,
        categories=[
            cat("Estates", "Count — 1 VP each"),
            cat("Duchies", "Count — 3 VP each", mult=3),
            cat("Provinces", "Count — 6 VP each", mult=6),
            cat("Curses", "Count — −1 each", sub=True),
            cat("Other VP cards", "Gardens and the like", cid="other"),
            cat("VP tokens", cid="tokens"),
        ],
        tiebreaker="The tied player who had fewer turns wins; if still tied, share the victory.",
        expansions=[ex("Intrigue"), ex("Seaside"), ex("Prosperity", [cat("Colonies", "Count — 10 VP each", mult=10)])],
    ),
    T(
        "cascadia", "Cascadia", year=2021, players=(1, 4), minutes=40, weight=1.85,
        tags=["Tile placement", "Animals", "Puzzle"], bgg=295947,
        categories=[
            cat("Bear", section="Wildlife"), cat("Elk", section="Wildlife"), cat("Salmon", section="Wildlife"),
            cat("Hawk", section="Wildlife"), cat("Fox", section="Wildlife"),
            cat("Mountains", "Largest corridor", section="Habitats"), cat("Forests", section="Habitats"),
            cat("Prairies", section="Habitats"), cat("Wetlands", section="Habitats"), cat("Rivers", section="Habitats"),
            cat("Habitat bonuses", "Largest corridor majorities", cid="habitat-bonus", section="Habitats"),
            cat("Nature tokens", "1 each unused", cid="nature"),
        ],
        tiebreaker="Most nature tokens remaining; if still tied, share the victory.",
    ),
    T(
        "agricola", "Agricola", year=2007, players=(1, 4), minutes=120, weight=3.64,
        tags=["Worker placement", "Farming"], bgg=31260,
        categories=[
            cat("Fields", "−1 to 4 by field tiles", min=-1, max=4, section="Farm"),
            cat("Pastures", "−1 to 4", min=-1, max=4, section="Farm"),
            cat("Grain", "−1 to 4", min=-1, max=4, section="Farm"),
            cat("Vegetables", "−1 to 4", min=-1, max=4, section="Farm"),
            cat("Sheep", "−1 to 4", min=-1, max=4, section="Animals"),
            cat("Wild boar", "−1 to 4", cid="boar", min=-1, max=4, section="Animals"),
            cat("Cattle", "−1 to 4", min=-1, max=4, section="Animals"),
            cat("Unused spaces", "Count — −1 each", cid="unused", sub=True, section="Farm"),
            cat("Fenced stables", "Count — 1 each", cid="stables", section="Farm"),
            cat("Clay rooms", "Count — 1 each", cid="clay", section="House"),
            cat("Stone rooms", "Count — 2 each", cid="stone", mult=2, section="House"),
            cat("Family members", "Count — 3 each", cid="family", mult=3, max=5, section="House"),
            cat("Card points", "Improvements and occupations", cid="cards"),
            cat("Bonus points", cid="bonus"),
            cat("Begging cards", "Count — −3 each", cid="begging", mult=3, sub=True),
        ],
        tiebreaker="Ties are shared.",
    ),
    T(
        "viticulture", "Viticulture Essential Edition", year=2015, players=(1, 6), minutes=90, weight=2.89,
        tags=["Worker placement", "Economic"], bgg=183394, pad="total", target=20,
        tiebreaker="Most lira; then the most total value of wine in cellars; then grapes on crush pads.",
        notes="Reaching 20 VP triggers the end of the year.",
        expansions=[ex("Tuscany Essential Edition")],
        aliases=["viticulture"],
    ),
    T(
        "scrabble", "Scrabble", year=1948, players=(2, 4), minutes=90, weight=2.0,
        tags=["Word", "Classic"], bgg=320, pad="rounds",
        categories=[
            cat("Unplayed tiles", "Value of tiles left on your rack (subtracted)", cid="unplayed", sub=True),
            cat("Going out bonus", "Sum of opponents' unplayed tiles", cid="going-out"),
        ],
        tiebreaker="The player with the higher score before adding or subtracting unplayed tiles wins.",
        notes="One round = one turn each. A bingo (all 7 tiles) scores +50.",
    ),
    _yahtzee(),
    T(
        "uno", "UNO", year=1971, players=(2, 10), minutes=30, weight=1.1,
        tags=["Card game", "Party", "Classic"], bgg=2223, pad="rounds", target=500,
        tiebreaker="Play another hand.",
        notes="The hand winner scores the cards left in everyone else's hands. First to 500 wins.",
    ),
    T(
        "rummikub", "Rummikub", year=1977, players=(2, 4), minutes=60, weight=1.75,
        tags=["Tile game", "Classic"], bgg=811, pad="rounds",
        tiebreaker="Ties are shared.",
        notes="Each round: losers score minus the value of their remaining tiles; the winner scores the total of everyone's minuses.",
    ),
    T(
        "codenames", "Codenames", year=2015, players=(2, 8), minutes=15, weight=1.27,
        tags=["Party", "Word", "Teams"], bgg=178900, win="teams", pad="total",
        notes="Two teams; pick the winning team. Contacting the assassin loses at once.",
    ),
    T(
        "pandemic", "Pandemic", year=2008, players=(2, 4), minutes=45, weight=2.4,
        tags=["Co-operative", "Medical"], bgg=30549, win="coop", pad="total",
        notes="Win by curing all four diseases. Lose at 8 outbreaks, running out of cubes, or the player deck.",
        factions=["Contingency Planner", "Dispatcher", "Medic", "Operations Expert", "Quarantine Specialist", "Researcher", "Scientist"],
        expansions=[ex("On the Brink"), ex("In the Lab"), ex("State of Emergency")],
    ),
    T(
        "sushi-go", "Sushi Go!", year=2013, players=(2, 5), minutes=15, weight=1.16,
        tags=["Card drafting", "Family"], bgg=133473, pad="rounds", rounds=3,
        categories=[cat("Pudding", "Most +6, fewest −6 (not in 2-player)", options=[-6, -3, 0, 3, 6])],
        tiebreaker="The tied player with the most pudding cards wins.",
        notes="3 rounds; pudding scores after round 3.",
    ),
    T(
        "kingdomino", "Kingdomino", year=2016, players=(2, 4), minutes=15, weight=1.22,
        tags=["Tile placement", "Family"], bgg=204583,
        categories=[
            cat("Wheat fields", "Squares × crowns per property", cid="wheat"),
            cat("Forests"), cat("Lakes"), cat("Grasslands"), cat("Swamps"), cat("Mines"),
            cat("Middle Kingdom", "10 if the castle is centred", cid="middle", options=[0, 10]),
            cat("Harmony", "5 if no domino was discarded", options=[0, 5]),
        ],
        tiebreaker="Largest single property; then most crowns; otherwise share the victory.",
        expansions=[ex("Age of Giants")],
    ),
    T(
        "dixit", "Dixit", year=2008, players=(3, 6), minutes=30, weight=1.2,
        tags=["Party", "Storytelling"], bgg=39856, pad="rounds", target=30,
        tiebreaker="Ties are shared.",
        notes="The game ends when the deck runs out or someone reaches 30 points.",
    ),
    T(
        "love-letter", "Love Letter", year=2012, players=(2, 6), minutes=20, weight=1.18,
        tags=["Card game", "Deduction"], bgg=129622, pad="total",
        tiebreaker="Play another round.",
        notes="Tokens of affection to win (2019 edition): 2p 6, 3p 5, 4p 4, 5–6p 3. Original: 2p 7, 3p 5, 4p 4.",
    ),
    T(
        "quacks", "The Quacks of Quedlinburg", year=2018, players=(2, 4), minutes=45, weight=1.94,
        tags=["Push your luck", "Bag building"], bgg=244521, pad="rounds", rounds=9,
        categories=[cat("Final conversion", "Leftover coins & rubies → VP after round 9", cid="final")],
        tiebreaker="Check the rulebook for your edition.",
        notes="9 rounds. Track VP gained each round.",
        expansions=[ex("The Herb Witches")],
        aliases=["quacks of quedlinburg"],
    ),
    T(
        "brass-birmingham", "Brass: Birmingham", year=2018, players=(2, 4), minutes=120, weight=3.9,
        tags=["Economic", "Network building"], bgg=224517,
        categories=[
            cat("Canal links", "Scored at the end of the Canal era", cid="canal-links", section="Canal era"),
            cat("Canal industries", cid="canal-industries", section="Canal era"),
            cat("Rail links", "Scored at the end of the Rail era", cid="rail-links", section="Rail era"),
            cat("Rail industries", cid="rail-industries", section="Rail era"),
        ],
        tiebreaker="Highest income; then most money.",
    ),
    T(
        "root", "Root", year=2018, players=(2, 4), minutes=90, weight=3.7,
        tags=["Asymmetric", "Area control"], bgg=237182, pad="total", target=30,
        tiebreaker="The first to 30 wins at once (or by fulfilling a dominance card).",
        notes="Race to 30 VP. A dominance win is a manual result.",
        factions=["Marquise de Cat", "Eyrie Dynasties", "Woodland Alliance", "Vagabond"],
        expansions=[
            ex("The Riverfolk Expansion", factions=["Riverfolk Company", "Lizard Cult", "Second Vagabond"]),
            ex("The Underworld Expansion", factions=["Underground Duchy", "Corvid Conspiracy"]),
            ex("The Marauder Expansion", factions=["Lord of the Hundreds", "Keepers in Iron"]),
            ex("The Homeland Expansion", factions=["Lilypad Diaspora", "Twilight Council", "Knaves of the Deepwood"]),
        ],
    ),
    T(
        "heat", "Heat: Pedal to the Metal", year=2022, players=(1, 6), minutes=45, weight=2.2,
        tags=["Racing", "Hand management"], bgg=366013, win="ranked", pad="total",
        notes="Record the finishing order. For a championship, use points per race in the notes or a total.",
        expansions=[ex("Heavy Rain"), ex("Tunnel Vision")],
        aliases=["heat pedal to the metal"],
    ),
    T(
        "lost-cities", "Lost Cities", year=1999, players=(2, 2), minutes=30, weight=1.5,
        tags=["Card game", "Two-player"], bgg=50, pad="rounds", rounds=3,
        tiebreaker="Ties are shared.",
        notes="Usually 3 rounds; each expedition: (sum − 20) × (wagers + 1), +20 for 8+ cards. Rounds can be negative.",
    ),
    T(
        "hanabi", "Hanabi", year=2010, players=(2, 5), minutes=25, weight=1.7,
        tags=["Co-operative", "Card game"], bgg=98778, win="coop", pad="total",
        notes="Score = the sum of the highest card in each firework (max 25). Count a 'win' at your table's target.",
    ),
    T(
        "spirit-island", "Spirit Island", year=2017, players=(1, 4), minutes=120, weight=4.07,
        tags=["Co-operative", "Area control"], bgg=162886, win="coop", pad="total",
        notes="Optional score from the rulebook: difficulty-based. Record win/loss and adversary in notes.",
        factions=["Lightning's Swift Strike", "River Surges in Sunlight", "Shadows Flicker Like Flame", "Vital Strength of the Earth", "A Spread of Rampant Green", "Thunderspeaker", "Bringer of Dreams and Nightmares", "Ocean's Hungry Grasp"],
    ),
    T(
        "ark-nova", "Ark Nova", year=2021, players=(1, 4), minutes=150, weight=3.76,
        tags=["Engine building", "Animals"], bgg=342942, pad="total",
        tiebreaker="Ties are shared.",
        notes="Final score = the gap between your appeal and conservation markers (conservation counts ×2 past 10). Type each player's final number.",
    ),
    # --- generic sheets for anything else
    T("generic-high", "Highest score wins (any game)", year=2000, players=(1, 12), minutes=45, weight=2.0, tags=["Generic"], bgg=None, pad="total"),
    T("generic-rounds", "Round-by-round scores", year=2000, players=(1, 12), minutes=45, weight=2.0, tags=["Generic"], bgg=None, pad="rounds"),
    T("generic-low", "Lowest score wins (golf style)", year=2000, players=(1, 12), minutes=45, weight=2.0, tags=["Generic"], bgg=None, win="low", pad="rounds"),
    T("generic-winlose", "Win / lose", year=2000, players=(2, 12), minutes=30, weight=2.0, tags=["Generic"], bgg=None, win="winlose", pad="total"),
    T("generic-coop", "Co-operative", year=2000, players=(1, 8), minutes=60, weight=2.5, tags=["Generic", "Co-operative"], bgg=None, win="coop", pad="total"),
    T("generic-teams", "Teams", year=2000, players=(4, 12), minutes=30, weight=1.5, tags=["Generic", "Teams"], bgg=None, win="teams", pad="total"),
    T("generic-ranked", "Finishing order (race)", year=2000, players=(2, 12), minutes=45, weight=2.0, tags=["Generic"], bgg=None, win="ranked", pad="total"),
]

BY_ID = {t["id"]: t for t in TEMPLATES}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def find_template(query: str) -> dict | None:
    """By id, exact name/alias, or a unique prefix/containment match."""
    q = _norm(query)
    if not q:
        return None
    if query in BY_ID:
        return BY_ID[query]
    for t in TEMPLATES:
        if q == _norm(t["name"]) or q == _norm(t["id"]) or q in (_norm(a) for a in t["aliases"]):
            return t
    hits = [t for t in TEMPLATES if not t["id"].startswith("generic") and (_norm(t["name"]).startswith(q) or q in _norm(t["name"]))]
    return hits[0] if len(hits) == 1 else None


def search_templates(query: str = "") -> list[dict]:
    q = _norm(query)
    out = []
    for t in TEMPLATES:
        if q and q not in _norm(t["name"]) and not any(q in _norm(a) for a in t["aliases"]) and not any(q in _norm(x) for x in t["categories"]):
            continue
        out.append(t)
    return out


def game_from_template(t: dict) -> dict:
    """A Game dict (without id) from a template."""
    import copy

    g = copy.deepcopy({k: v for k, v in t.items() if k not in ("id", "aliases")})
    g["template_id"] = t["id"]
    if t["id"].startswith("generic"):
        g["categories"] = [c for c in g["categories"] if c != "Generic"]
    return g
