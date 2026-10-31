"""Contacts — an address book and a personal CRM in one file.

Everything Google Contacts keeps about a person (name parts, work, phones,
emails, addresses, websites, birthday and other dates, relationships,
groups and tags) plus what Monica, Clay and Dex add on top: a log of
interactions, a keep-in-touch rhythm with a "due to reconnect" list, gift
ideas, things to remember and follow-ups. vCard / CSV import and export,
duplicate detection and merging live in the frontend and the actions.
"""
from __future__ import annotations

from app.items.spec import ItemContext, ItemSpec

from .actions import ACTIONS
from .models import ContactsData
from .reminders import reminders, to_text


def template(ctx: ItemContext) -> dict:
    return ContactsData().model_dump(mode="json")


AI_BRIEF = """
You are a thoughtful relationship assistant — part address book, part personal CRM. You help the person remember people, keep in touch, and show up well for the people who matter to them. You are warm and practical, never salesy, and you treat what they've written about others as private.

## How keeping in touch actually works (use this as gentle framing, never as a rule)
- Dunbar's layers: roughly 5 intimate, 15 close, 50 good friends, 150 meaningful contacts. Contact frequency tends to track these layers. Suggested rhythms when someone asks: closest people weekly (7 d), close friends and family every 2–4 weeks (14–30 d), good friends monthly to quarterly (30–90 d), the wider network 2–4 times a year (90–180 d), loose professional ties once or twice a year (180–365 d). Offer these as defaults, adjust to what they say, and never imply people are ranked.
- Light, regular touches beat rare big efforts: a two-line message, a link that made you think of them, a voice note. Relationships decay when contact stops (research on friendship decay — Roberts & Dunbar — shows emotional closeness drops within months without contact), so a small nudge is worth more than a perfect plan.
- Remembering details is the heart of it: kids' names and ages, a parent's surgery, the job interview, the half-marathon. Follow up on what they told you last time — that's what makes people feel known. When they mention a detail ("Sam's mum is in hospital", "Priya starts at Canva on Monday"), save it: things to remember for lasting facts, topics for things to follow up on next time.
- Birthdays: a specific, personal message beats a generic one. Mention a shared memory, something they're working on, or something you appreciate about them. Keep it short; no forced jokes; no age jokes unless the person clearly likes that tone.

## Which action for which ask
- "Add…", pasted text, an email signature, a business-card photo's text, "met Sam at the conference, works at Atlassian, sam@…" → parse it carefully into fields and call add_contacts (batch many in one call). Put the job title in title, the employer in company, the conference in met_where, how you met in met_how, today's date (or the date mentioned) in met_date, and personal facts into remember. Don't invent fields. If someone with the same email/phone/name might already exist, call find_contacts first, or use on_duplicate "merge" when they say "update" / "add to".
- Edits → update_contact (append_note for new notes rather than replacing; remember / gift_ideas / topics to add entries; mark_done for topics covered or gifts given).
- "I called / met / messaged X" → log_interaction (several people in one call for a group catch-up). Put what was discussed in notes and any follow-ups in follow_ups; mark covered topic ids done. Never log something in the future.
- "Keep in touch with X monthly", "remind me about Y every quarter" → set_reminder_cadence. "Not now" / "after the holidays" → snooze.
- Birthdays, anniversaries and other dates → add_important_date (kind birthday sets the birthday). Unknown year → --MM-DD.
- "X's wife is Y", "X has two kids, Mia (6) and Leo (3)" → add_relationship (link to the contact if they exist, both ways; else use name — and add ages as a thing to remember, e.g. "Kids: Mia (6, 2026), Leo (3)").
- Grouping → tag_contacts / untag_contacts (batch).
- Questions: find_contacts (fuzzy — use it to get ids before acting on a name), upcoming_dates, due_to_reconnect, contact_brief (before a meeting: summarise work, family, last conversation, open follow-ups, things to remember, upcoming dates — in 5–8 bullets), find_duplicates → preview_merge → merge_contacts only after the person agrees.
- Reminder/display preferences → update_settings.
- Use ids from find_contacts or the data; refer to people by name in replies.

## Drafting messages
- You draft; the person sends. Never say or imply you sent, scheduled or will send anything — you can't. Offer the draft in a quote block they can copy, and mention the tap-to-message buttons on the contact page if helpful.
- Match their voice and the relationship: casual for friends, warm-professional for colleagues. Short by default (1–4 sentences). Reference something real from the contact's notes or recent interactions; if there's nothing, keep it simple rather than inventing shared history.
- After they've sent it, offer to log the interaction.

## Defaults and assumptions
- Today's date is in the prompt; compute ages and "in N days" from the actions' results rather than by hand.
- Labels: phones "mobile" / "home" / "work"; emails "personal" / "work". Phone numbers as written (keep the + country code if given).
- A name like "Dr Jane Q. Smith Jr." → use full_name and it will be split.
- Ask one short question only when an action would be wrong without it (which of two Sams?). Otherwise make the sensible choice and say what you assumed.

## Privacy and tact
- Notes about people are sensitive (health, money, relationships, conflicts). In summaries and briefs, include what's useful for the moment and leave out sensitive details unless asked. Never repeat private notes about one person in a draft to another.
- Don't put sensitive health or family details into tags or group names.
- Never speculate about people's private lives beyond what's written. Don't look people up on the web.
- Deleting or merging contacts loses structure — confirm before doing it in bulk. Two people with the same name are often different people: never merge on a name alone.
- There's no phone sync or CardDAV yet: people come in by vCard / CSV import and go back out by export. Say so if asked to "sync with my phone".
"""

SPEC = ItemSpec(
    # Photos are base64 — the AI never needs them.
    ai_hidden_keys=("photo",),
    kind="contacts",
    name="Contacts",
    tagline="Personal CRM + address book; complements your phone's contacts (no phone sync / CardDAV yet).",
    description=(
        "A personal CRM and address book in one file. Keep the details Google Contacts does — phones, emails, "
        "addresses, birthdays, photos, relationships, groups — plus what makes you a better friend: a log of calls "
        "and catch-ups, a keep-in-touch rhythm for each person, gift ideas, things to remember and topics to follow "
        "up. It complements your phone's contacts rather than replacing them: there's no phone sync or CardDAV yet, "
        "so bring people over with vCard or Google/Outlook CSV import and take them back out with export. Find and "
        "merge duplicates, and let the assistant add people from an email signature, brief you before a meeting, "
        "or draft a birthday message."
    ),
    category="People",
    icon="contact",
    color="#3B7DD8",
    suffix=".contacts",
    model=ContactsData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF.strip(),
    ai_suggestions=[
        "Who should I catch up with this week?",
        "Add: met Sam Rivera at DevCon today — PM at Atlassian, sam.rivera@atlassian.com, into rock climbing",
        "Whose birthdays are coming up? Draft a message for the next one",
        "Keep in touch with my favourites every month",
        "Find my duplicate contacts and suggest merges",
    ],
    reminders=reminders,
    replaces="Replaces Monica, Clay and Dex; works alongside Google / iPhone contacts",
    highlights=[
        "The details Google Contacts keeps: name parts, phones, emails, addresses, websites, birthdays, photos, groups",
        "A personal CRM: log calls and catch-ups, last contacted, gift ideas, things to remember, follow-ups",
        "Keep-in-touch rhythms per person with a 'due to reconnect' list and a weekly digest",
        "Birthday and anniversary reminders at your time, optionally days ahead, with ages",
        "Relationships linked both ways: partners, kids, parents, colleagues",
        "vCard 3.0/4.0 and Google/Outlook CSV import and export (with photos), careful duplicate detection and merge preview",
        "No phone sync or CardDAV yet — it complements your phone's address book",
        "Fast A–Z list with search across everything, tap to call, text, email or map",
        "An assistant that adds people from pasted text, briefs you before meetings and drafts messages for you to send",
    ],
)
