"""The starting categories (Australian household), how Up's categories map
onto them, and merchants that are almost always subscriptions or bills."""
from __future__ import annotations

# (group id, group name, [(category id, name, emoji, kind, bucket)])
DEFAULT_GROUPS: list[tuple[str, str, list[tuple[str, str, str, str, str]]]] = [
    ("income", "Income", [
        ("salary", "Salary & wages", "💼", "income", "none"),
        ("other_income", "Other income", "💸", "income", "none"),
    ]),
    ("bills", "Bills & housing", [
        ("rent", "Rent & mortgage", "🏠", "expense", "needs"),
        ("utilities", "Utilities", "💡", "expense", "needs"),
        ("internet", "Internet", "🌐", "expense", "needs"),
        ("mobile", "Mobile phone", "📱", "expense", "needs"),
        ("insurance", "Insurance", "🛡️", "expense", "needs"),
        ("rates", "Rates & strata", "🧾", "expense", "needs"),
    ]),
    ("everyday", "Everyday", [
        ("groceries", "Groceries", "🛒", "expense", "needs"),
        ("eating_out", "Eating out", "🍽️", "expense", "wants"),
        ("takeaway", "Takeaway & delivery", "🥡", "expense", "wants"),
        ("fuel", "Fuel", "⛽", "expense", "needs"),
        ("public_transport", "Public transport", "🚆", "expense", "needs"),
        ("rideshare", "Taxis & rideshare", "🚕", "expense", "wants"),
        ("parking_tolls", "Parking & tolls", "🅿️", "expense", "needs"),
        ("health", "Health & medical", "🩺", "expense", "needs"),
        ("personal_care", "Hair & beauty", "💇", "expense", "wants"),
    ]),
    ("lifestyle", "Lifestyle", [
        ("subscriptions", "Subscriptions & streaming", "📺", "expense", "wants"),
        ("shopping", "Clothing & shopping", "🛍️", "expense", "wants"),
        ("entertainment", "Events & entertainment", "🎟️", "expense", "wants"),
        ("drinks", "Pubs, bars & booze", "🍻", "expense", "wants"),
        ("hobbies", "Hobbies & games", "🎮", "expense", "wants"),
        ("fitness", "Fitness & wellbeing", "🏋️", "expense", "wants"),
        ("travel", "Holidays & travel", "✈️", "expense", "wants"),
        ("gifts", "Gifts & charity", "🎁", "expense", "wants"),
        ("technology", "Technology", "💻", "expense", "wants"),
        ("books_news", "News & books", "📚", "expense", "wants"),
    ]),
    ("home_family", "Home & family", [
        ("homewares", "Homewares & appliances", "🛋️", "expense", "wants"),
        ("home_maintenance", "Home maintenance", "🔧", "expense", "needs"),
        ("kids", "Kids & family", "🧸", "expense", "needs"),
        ("pets", "Pets", "🐾", "expense", "needs"),
        ("education", "Education", "🎓", "expense", "needs"),
        ("car", "Car costs & repayments", "🚗", "expense", "needs"),
        ("life_admin", "Fees & life admin", "📎", "expense", "needs"),
    ]),
    ("savings", "Savings & goals", [
        ("emergency_fund", "Emergency fund", "🛟", "expense", "savings"),
        ("investments", "Investments", "📈", "expense", "savings"),
        ("sinking_funds", "Sinking funds", "🪣", "expense", "savings"),
    ]),
    ("other", "Other", [
        ("gambling", "Lottery & gambling", "🎲", "expense", "wants"),
        ("tobacco", "Tobacco & vaping", "🚬", "expense", "wants"),
        ("misc", "Everything else", "📦", "expense", "wants"),
    ]),
]

# Up's category ids (``GET /categories``) → the default categories above.
UP_CATEGORY_MAP: dict[str, str] = {
    # good-life
    "games-and-software": "hobbies",
    "booze": "drinks",
    "events-and-gigs": "entertainment",
    "hobbies": "hobbies",
    "holidays-and-travel": "travel",
    "lottery-and-gambling": "gambling",
    "pubs-and-bars": "drinks",
    "restaurants-and-cafes": "eating_out",
    "takeaway": "takeaway",
    "tobacco-and-vaping": "tobacco",
    "tv-and-music": "subscriptions",
    "adult": "misc",
    "apps-games-and-software": "subscriptions",
    # home
    "groceries": "groceries",
    "homeware-and-appliances": "homewares",
    "internet": "internet",
    "home-maintenance-and-improvements": "home_maintenance",
    "pets": "pets",
    "home-insurance-and-rates": "rates",
    "rent-and-mortgage": "rent",
    "utilities": "utilities",
    # personal
    "children-and-family": "kids",
    "clothing-and-accessories": "shopping",
    "education-and-student-loans": "education",
    "fitness-and-wellbeing": "fitness",
    "gifts-and-charity": "gifts",
    "hair-and-beauty": "personal_care",
    "health-and-medical": "health",
    "investments": "investments",
    "life-admin": "life_admin",
    "mobile-phone": "mobile",
    "news-magazines-and-books": "books_news",
    "technology": "technology",
    # transport
    "car-insurance-and-maintenance": "car",
    "cycling": "hobbies",
    "fuel": "fuel",
    "parking": "parking_tolls",
    "public-transport": "public_transport",
    "car-repayments": "car",
    "taxis-and-share-cars": "rideshare",
    "toll-roads": "parking_tolls",
}

# An Up parent category, when the child isn't one we know.
UP_PARENT_FALLBACK: dict[str, str] = {
    "good-life": "entertainment",
    "home": "homewares",
    "personal": "misc",
    "transport": "car",
}

# Merchant keys (normalised, see ``logic.merchant_key``) that are subscriptions
# or bills nearly every time — a confidence boost, never a requirement.
KNOWN_RECURRING: dict[str, str] = {
    "netflix": "subscription", "spotify": "subscription", "disney": "subscription", "stan": "subscription",
    "binge": "subscription", "kayo": "subscription", "foxtel": "subscription", "paramount": "subscription",
    "youtube": "subscription", "apple": "subscription", "itunes": "subscription", "google": "subscription",
    "amazon prime": "subscription", "prime video": "subscription", "audible": "subscription",
    "microsoft": "subscription", "xbox": "subscription", "playstation": "subscription", "nintendo": "subscription",
    "adobe": "subscription", "dropbox": "subscription", "icloud": "subscription", "chatgpt": "subscription",
    "openai": "subscription", "anthropic": "subscription", "claude": "subscription", "canva": "subscription",
    "patreon": "subscription", "linkedin": "subscription", "duolingo": "subscription", "headspace": "subscription",
    "hellofresh": "subscription", "marley spoon": "subscription", "youfoodz": "subscription",
    "anytime fitness": "subscription", "fitness first": "subscription", "f45": "subscription", "goodlife": "subscription",
    "jetts": "subscription", "snap fitness": "subscription", "plus fitness": "subscription",
    "telstra": "bill", "optus": "bill", "vodafone": "bill", "belong": "bill", "boost": "bill", "amaysim": "bill",
    "aussie broadband": "bill", "tpg": "bill", "iinet": "bill", "superloop": "bill", "launtel": "bill",
    "agl": "bill", "origin": "bill", "energyaustralia": "bill", "energy australia": "bill", "red energy": "bill",
    "alinta": "bill", "powershop": "bill", "amber": "bill", "simply energy": "bill", "momentum": "bill",
    "sydney water": "bill", "yarra valley water": "bill", "sa water": "bill", "icon water": "bill",
    "nrma": "bill", "racv": "bill", "racq": "bill", "aami": "bill", "budget direct": "bill", "allianz": "bill",
    "bupa": "bill", "medibank": "bill", "hcf": "bill", "nib": "bill", "ahm": "bill",
}

RECURRING_CATEGORIES = {"subscriptions", "utilities", "internet", "mobile", "insurance", "rates", "rent", "fitness"}
# Everyday spending that repeats by habit, not by contract.
HABIT_CATEGORIES = {"groceries", "eating_out", "takeaway", "fuel", "drinks", "public_transport", "rideshare", "parking_tolls"}


def default_structure() -> tuple[list[dict], list[dict]]:
    groups: list[dict] = []
    cats: list[dict] = []
    for gid, gname, items in DEFAULT_GROUPS:
        groups.append({"id": gid, "name": gname, "hidden": False})
        for cid, name, emoji, kind, bucket in items:
            cats.append(
                {
                    "id": cid, "group_id": gid, "name": name, "kind": kind, "emoji": emoji,
                    "budget_cents": 0, "rollover": gid == "savings", "hidden": False, "bucket": bucket,
                }
            )
    return groups, cats
