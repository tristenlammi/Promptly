"""Spotting passwords left lying around: in mail, in files, in the words read out of photos.

Plain patterns, no AI. Nothing here touches the database or the vault: it takes text the
server already holds and says what looks like a secret in it. The caller decides what to
keep, which is never the secret itself (see ``stray_scan``).

Wrong answers in one direction cost more than the other. Missing one leaves things as they
were; a false alarm on every newsletter that says "password" would make the whole check
noise. So each pattern wants a secret to look like one: a label and a value, a known key
prefix, a block of codes under a heading, and so on.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

KINDS = (
    "password",  # "Your temporary password is …", "Password: …"
    "wifi",  # a Wi-Fi password, maybe with its network name
    "api_key",  # a key with a well-known prefix, or labelled "API key:"
    "private_key",  # -----BEGIN … PRIVATE KEY-----
    "recovery_codes",  # backup or recovery codes for a 2FA account
    "totp_secret",  # a 2FA setup key or otpauth:// link
    "totp_qr",  # a photo of a 2FA setup screen: the QR is read on the device
    "password_list",  # a table or export with a password column
    "env_secrets",  # NAME_PASSWORD=… lines, as in a .env file
    "password_store",  # a KeePass or other manager's file
    "password_file",  # a file whose name says passwords, which couldn't be read
)

DOT = "•"
MAX_TEXT = 300_000
MAX_LINES = 6000
MAX_LINE = 2000


@dataclass
class Hit:
    kind: str
    value: str  # the secret itself: never stored, never logged
    username: str = ""  # or a Wi-Fi network's name
    label: str = ""  # what the text called it
    count: int = 1  # rows in a list, codes in a set, lines in a .env
    line: int = 0  # where it starts, for an excerpt


def mask(value: str) -> str:
    """A hint of which secret, not the secret: ``pa••••rd``. Always four dots, so the
    length doesn't show, and nothing at all of a short one."""
    v = value.strip()
    if len(v) >= 8:
        return v[:2] + DOT * 4 + v[-2:]
    if len(v) >= 6:
        return v[:1] + DOT * 4
    return DOT * 4


def preview(hit: Hit) -> str:
    if hit.kind in ("private_key", "totp_qr", "password_store", "password_file", "password_list"):
        return ""
    if hit.kind == "recovery_codes":
        return mask(hit.value.split("\n", 1)[0])
    if hit.kind == "env_secrets":
        first = hit.value.split("\n", 1)[0]
        name, _, val = first.partition("=")
        return f"{name}={mask(val)}"
    return mask(hit.value)


# ------------------------------------------------------------------ shared bits

_URL = re.compile(r"(?:https?|ftp)://\S+|\bwww\.\S+", re.IGNORECASE)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")

# Values that stand in for a password rather than being one.
_PLACEHOLDER = re.compile(
    r"^(?:[*•●·.\-_#?xX]+|<[^>]*>|\{\{?[^}]*\}\}?|\[[^\]]*\]|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Za-z_]+%"
    r"|(?:your|my|the|new|enter|example|sample|dummy|fake|test|some|insert|put)[-_ ]?(?:pass(?:word)?|pwd|secret|key|token|value|here|api[-_]?key)\w*"
    r"|pass(?:word)?\d{0,3}|changeme|change[-_]?me|changeit|secret|hidden|redacted|removed|n/?a|none|null|nil|empty|todo|tbd|xxx+|abc123|123456|12345678|qwerty|letmein)$",
    re.IGNORECASE,
)

# Words that follow "password:" or "password is" in mail that isn't handing one over.
_STOP = frozenset(
    """
    is was will must should can could may might has have had here below above reset change changed changes updated update
    expired expire expires expiring expiry required incorrect invalid wrong forgotten forgot forget strength strong
    stronger weak weaker hidden protected sent link click tap the a an your my our their not none same unchanged set to
    of for and or with yes no manager managers policy policies tips requirements requirement reminder hint field box
    length characters chars case-sensitive sensitive redacted see via by in on at as enter entered needs need needed
    that this it you we they from using use used only again now new old current temporary provided attached separately
    later soon example e.g. eg also still being too very more less long short secure safe saved stored encrypted
    known unknown blank empty different similar easy hard simple complex choose chosen create created pick type typed
    given emailed texted shared please kindly confirm confirmed verify verified about due valid invalid locked
    unlocked manage managed generator generated protection security
    """.split()
)

# A line that's talking about passwords in general: an article, tips, an example.
_NOT_REAL = re.compile(
    r"\b(?:e\.g\.|for example|for instance|example|examples|such as|never use|don'?t use|do not use|avoid|most common|"
    r"commonly used|worst|weakest|top \d+|instead of|bad password|weak password|strong password|good password|"
    r"password tips|tips? for)\b|\blike\s+[\"'“‘]",
    re.IGNORECASE,
)
# "One-time password" is a code, which Mail codes already handles.
_ONE_TIME = re.compile(r"(?:one[- ]?time|\botp|\bsms|\bverification|\baccess)\s*$", re.IGNORECASE)


def _lines(text: str) -> list[str]:
    return [ln[:MAX_LINE] for ln in text[:MAX_TEXT].splitlines()][:MAX_LINES]


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def _bare(v: str) -> str:
    return v.strip("\"'“”‘’`«»")


def _plausible_password(v: str, *, sentence: bool) -> bool:
    if not 4 <= len(v) <= 128:
        return False
    low = v.lower()
    if "://" in v or low.startswith("www.") or _EMAIL.match(v):
        return False
    if _PLACEHOLDER.match(v) or low.strip(".,;:!?()") in _STOP:
        return False
    if sentence:
        # Said in a sentence, it has to look made up: a digit, a symbol, or a capital
        # somewhere other than the start. "Your password is strong" isn't one.
        if not (any(c.isdigit() for c in v) or any(not c.isalnum() for c in v) or any(c.isupper() for c in v[1:])):
            return False
    return True


# ------------------------------------------------------------------ passwords and Wi-Fi

_PW_WORD = (
    r"(?:pass\s?words?|passwd|pass\s?phrase|pwd|pw|kennwort|passwort|contrase[ñn]a|mot\s+de\s+passe|senha|"
    r"wachtwoord|l[öo]senord|passord|adgangskode|salasana|has[łl]o|пароль)"
)
_QUAL = (
    r"(?:(?:your|my|the|a|new|temporary|temp|initial|default|current|account|admin|administrator|login|log-in|user|guest|"
    r"master|root|app|email|e-mail|portal|database|db|ftp|vpn|server)\s+)*"
)
_WIFI_Q = r"(?P<wifi>(?:wi-?fi|wlan|wireless|network|wpa[23]?|router|hotspot)\s+)?"
_LABELLED = re.compile(
    rf"^\s*(?:[-*•>]\s*)?(?P<before>{_QUAL}){_WIFI_Q}(?:{_PW_WORD}|(?P<key>network\s+key|wpa2?\s+key|psk|pre-?shared\s+key))"
    rf"\s*(?:\([^)]{{0,30}}\))?\s*[:=：]\s*(?P<value>.*)$",
    re.IGNORECASE,
)
_SENTENCE = re.compile(
    rf"(?P<before>\b{_QUAL}){_WIFI_Q}{_PW_WORD}(?:\s+for\s+[^\s:]{{1,60}}(?:\s+[^\s:]{{1,30}})?)?\s+"
    r"(?:is|was|is\s+now|will\s+be|has\s+been\s+(?:set|changed|reset)\s+to|(?:set|reset|changed)\s+to)\s*[:\-–]?\s*(?P<value>\S+)",
    re.IGNORECASE,
)
_USER = re.compile(
    r"^\s*(?:[-*•]\s*)?(?:your\s+)?(?:user\s?(?:name|id)?|login(?:\s+(?:name|id))?|e-?mail(?:\s+address)?|account(?:\s+(?:name|id))?|"
    r"benutzer(?:name)?|usuario|nom d'utilisateur|identifiant)\s*[:=：]\s*(?P<value>\S{1,200})",
    re.IGNORECASE,
)
_SSID = re.compile(
    r"^\s*(?:[-*•]\s*)?(?:ssid|network(?:\s+name)?|wi-?fi(?:\s+(?:name|network))?|wlan(?:\s+name)?)\s*[:=：]\s*(?P<value>.{1,64}?)\s*$",
    re.IGNORECASE,
)
_WIFI_NEAR = re.compile(r"\b(?:wi-?fi|wlan|ssid|wireless|router|hotspot)\b", re.IGNORECASE)
_WIFI_QR = re.compile(r"WIFI:((?:[A-Za-z]:(?:\\.|[^;\\])*;)+)")


def _labelled_value(raw: str) -> str:
    """The value after "Password:", without the commentary people put after it."""
    v = raw.strip()
    for cut in (" (", " - ", " – ", "  ", "\t", " |", " // "):
        if cut in v:
            v = v.split(cut, 1)[0]
    words = v.split()
    if len(words) > 4:
        v = words[0]
    return _bare(v.strip())


def _near(lines: list[str], i: int, pattern: re.Pattern[str], span: int = 4) -> str:
    for j in list(range(i - 1, max(-1, i - span - 1), -1)) + list(range(i + 1, min(len(lines), i + span + 1))):
        m = pattern.match(lines[j])
        if m:
            return _bare(m.group("value").strip())[:200]
    return ""


def _passwords(lines: list[str]) -> list[Hit]:
    out: list[Hit] = []
    for i, raw in enumerate(lines):
        line = _URL.sub(" ", raw)
        if _NOT_REAL.search(line):
            continue
        found: list[tuple[str, bool, re.Match[str]]] = []
        m = _LABELLED.match(line)
        if m:
            value = _labelled_value(m.group("value"))
            if not value and i + 1 < len(lines):
                # A table cell: the label on one line, the value on the next.
                nxt = lines[i + 1].strip()
                value = _bare(nxt) if nxt and len(nxt.split()) == 1 else ""
            found.append((value, False, m))
        else:
            for m in _SENTENCE.finditer(line):
                found.append((_bare(m.group("value")).rstrip(".,;"), True, m))
        for value, sentence, m in found:
            if _ONE_TIME.search(line[: m.start()] + (m.group("before") or "")):
                continue
            if not _plausible_password(value, sentence=sentence):
                continue
            wifi = bool(m.group("wifi") or m.groupdict().get("key"))
            ssid = _near(lines, i, _SSID)
            if not wifi and (ssid or any(_WIFI_NEAR.search(lines[j]) for j in range(max(0, i - 2), min(len(lines), i + 3)))):
                wifi = True
            if wifi:
                out.append(Hit("wifi", value, username=ssid, label="Wi-Fi password", line=i))
            else:
                out.append(Hit("password", value, username=_near(lines, i, _USER), label="Password", line=i))
    return out


def _wifi_qr(lines: list[str]) -> list[Hit]:
    out: list[Hit] = []
    for i, line in enumerate(lines):
        for m in _WIFI_QR.finditer(line):
            fields: dict[str, str] = {}
            for part in re.findall(r"([A-Za-z]):((?:\\.|[^;\\])*);", m.group(1)):
                fields[part[0].upper()] = re.sub(r"\\(.)", r"\1", part[1])
            if fields.get("P"):
                out.append(Hit("wifi", fields["P"], username=fields.get("S", ""), label="Wi-Fi QR text", line=i))
    return out


# ------------------------------------------------------------------ keys and tokens

_KNOWN_KEYS: list[tuple[str, re.Pattern[str]]] = [
    ("OpenAI or Anthropic key", re.compile(r"\bsk-(?:proj-|ant-(?:api\d\d-)?|svcacct-)?[A-Za-z0-9_\-]{32,}")),
    ("Stripe key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}")),
    ("SendGrid key", re.compile(r"\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}")),
    ("Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{30,}")),
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}")),
]
_KEY_LABEL = re.compile(
    r"(?:^|[\s\"'{,(])(?P<label>api[ _-]?key|api[ _-]?token|api[ _-]?secret|access[ _-]?token|access[ _-]?key(?:[ _-]?id)?|"
    r"secret[ _-]?(?:access[ _-]?)?key|client[ _-]?secret|auth[ _-]?token|bearer[ _-]?token|private[ _-]?token|"
    r"personal[ _-]?access[ _-]?token|app[ _-]?secret|consumer[ _-]?secret|webhook[ _-]?secret|signing[ _-]?secret)"
    r"[\"']?\s*[:=：]\s*[\"']?(?P<value>[A-Za-z0-9_\-./+=]{16,256})",
    re.IGNORECASE,
)
_PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")


def _keyish(v: str) -> bool:
    return (
        any(c.isdigit() for c in v)
        and any(c.isalpha() for c in v)
        and _entropy(v) >= 3.2
        and not _PLACEHOLDER.match(v)
        and "://" not in v
    )


def _api_keys(lines: list[str], taken: set[str]) -> list[Hit]:
    out: list[Hit] = []
    for i, raw in enumerate(lines):
        line = _URL.sub(" ", raw)
        for label, pattern in _KNOWN_KEYS:
            for m in pattern.finditer(line):
                v = m.group(0)
                if v not in taken:
                    taken.add(v)
                    out.append(Hit("api_key", v, label=label, line=i))
        for m in _KEY_LABEL.finditer(line):
            v = m.group("value").rstrip(".,;")
            if v in taken or not _keyish(v):
                continue
            taken.add(v)
            out.append(Hit("api_key", v, label=m.group("label").strip(), line=i))
    return out


def _private_keys(lines: list[str]) -> list[Hit]:
    out: list[Hit] = []
    i = 0
    while i < len(lines):
        m = _PRIVATE_KEY.search(lines[i])
        if not m:
            i += 1
            continue
        block = [lines[i][m.start():]]
        end = i
        for j in range(i + 1, min(len(lines), i + 200)):
            block.append(lines[j])
            end = j
            if "-----END" in lines[j]:
                break
        out.append(Hit("private_key", "\n".join(block)[:16_000], label="Private key", line=i))
        i = end + 1
    return out


# ------------------------------------------------------------------ .env lines

_ENV = re.compile(
    r"^\s*(?:export\s+)?(?P<name>(?=[A-Z])[A-Z0-9_.]*?(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*)"
    r"\s*=\s*(?P<value>.*?)\s*$"
)


def _env(lines: list[str], taken: set[str]) -> list[Hit]:
    found: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        m = _ENV.match(line)
        if not m:
            continue
        v = m.group("value")
        if v[:1] in "\"'":
            q = v[0]
            v = v[1:].split(q, 1)[0]
        else:
            v = v.split(" #", 1)[0].strip()
        if len(v) < 4 or _PLACEHOLDER.match(v) or v.lower() in _STOP or v.lower() in ("true", "false"):
            continue
        found.append((i, m.group("name"), v))
        taken.add(v)
    if not found:
        return []
    return [Hit("env_secrets", "\n".join(f"{n}={v}" for _, n, v in found), label=found[0][1], count=len(found), line=found[0][0])]


# ------------------------------------------------------------------ 2FA

_TWO_FA = re.compile(
    r"\b(?:authenticator|2fa|two[- ]factor|2-step|two[- ]step|totp|mfa|multi[- ]factor|google authenticator|authy|"
    r"microsoft authenticator|one[- ]time (?:password|code))\b",
    re.IGNORECASE,
)
_OTPAUTH = re.compile(r"otpauth://(?:totp|hotp)/[^\s\"'<>]+", re.IGNORECASE)
_TOTP_LABEL = re.compile(
    r"(?:secret\s+key|setup\s+key|2fa\s+(?:key|secret)|two[- ]factor\s+(?:key|secret)|authenticator\s+(?:key|secret)|"
    r"totp\s+(?:key|secret)|otp\s+(?:key|secret)|mfa\s+(?:key|secret)|manual(?:ly)?\s+(?:entry\s+)?(?:key|code)|"
    r"enter\s+this\s+(?:key|code)|\bsecret|\bkey)\s*[:=：]?\s*(?P<v>(?:[A-Za-z2-7]{4}[ -]?){3,15}[A-Za-z2-7]{0,4}=*)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_SCAN_QR = re.compile(r"\b(?:scan|qr)\b", re.IGNORECASE)


def _totp(lines: list[str], text: str, taken: set[str]) -> list[Hit]:
    out: list[Hit] = []
    for i, line in enumerate(lines):
        for m in _OTPAUTH.finditer(line):
            uri = m.group(0)
            if "secret=" in uri.lower() and uri not in taken:
                taken.add(uri)
                out.append(Hit("totp_secret", uri, label="otpauth link", line=i))
    if not _TWO_FA.search(text[:MAX_TEXT]):
        return out
    for i, line in enumerate(lines):
        for m in _TOTP_LABEL.finditer(_OTPAUTH.sub(" ", line)):
            raw = m.group("v").strip()
            v = re.sub(r"[\s=-]", "", raw).upper()
            if not 16 <= len(v) <= 64 or not re.fullmatch(r"[A-Z2-7]+", v):
                continue
            # A run of capitals isn't a key unless it has the digits a random one would.
            if not any(c.isdigit() for c in v) and len(v) < 24:
                continue
            # Words broken into fours ("this code here") aren't a key either.
            if raw.lower() == raw and " " not in raw and not any(c.isdigit() for c in raw):
                continue
            if v in taken:
                continue
            taken.add(v)
            out.append(Hit("totp_secret", v, label="2FA setup key", line=i))
    return out


def totp_screen(text: str) -> bool:
    """A photo's words say it's a 2FA setup screen, with a QR to scan."""
    return bool(_TWO_FA.search(text)) and bool(_SCAN_QR.search(text))


# ------------------------------------------------------------------ recovery codes

_CODES_HEAD = re.compile(
    r"\b(?:recovery|backup|emergency|scratch|rescue)\s+(?:codes?|keys?)\b|\b(?:2fa|two[- ]factor|2-step)\s+(?:backup|recovery)\b|"
    r"wiederherstellungscodes?|backup-codes?|c[oó]digos?\s+de\s+(?:recuperaci[oó]n|respaldo)|codes?\s+de\s+(?:secours|r[ée]cup[ée]ration)",
    re.IGNORECASE,
)
_CODE_TOKEN = re.compile(
    r"^(?=[A-Za-z0-9-]*\d)(?:[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,6}(?:-[A-Za-z0-9]{4,6}){0,6}|[a-z0-9]{8,12}|[A-Z0-9]{8,12}|\d{8,10})$"
)
_CODE_PAIR = re.compile(r"(?<![\d-])\d{4} \d{4}(?![\d-])")
_RECOVERY_KEY = re.compile(
    r"(?:recovery\s+key|wiederherstellungsschl[üu]ssel)\s*[:=：]?\s*(?P<v>(?:[A-Z0-9]{4,6}-){4,}[A-Z0-9]{4,6})", re.IGNORECASE
)
_CODES_SPAN = 30
_MIN_CODES = 4


def _codes_after(lines: list[str], start: int) -> list[str]:
    codes: list[str] = []
    for line in lines[start : start + _CODES_SPAN]:
        line = re.sub(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+", "", line)
        pairs = _CODE_PAIR.findall(line)
        if pairs:
            codes.extend(pairs)
            continue
        for token in re.split(r"[\s,;|]+", line.strip()):
            if _CODE_TOKEN.match(token):
                codes.append(token)
    seen: list[str] = []
    for c in codes:
        if c not in seen:
            seen.append(c)
    return seen


def _recovery(lines: list[str], *, assume: bool) -> list[Hit]:
    out: list[Hit] = []
    starts = [i for i, line in enumerate(lines) if _CODES_HEAD.search(line)]
    if assume:
        starts = [0] + starts
    used = -1
    for i in starts:
        if i <= used:
            continue
        codes = _codes_after(lines, i)
        if len(codes) >= _MIN_CODES:
            out.append(Hit("recovery_codes", "\n".join(codes[:40]), label="Recovery codes", count=len(codes), line=i))
            used = i + _CODES_SPAN
    for i, line in enumerate(lines):
        for m in _RECOVERY_KEY.finditer(line):
            out.append(Hit("recovery_codes", m.group("v"), label="Recovery key", line=i))
    return out


# ------------------------------------------------------------------ tables and exports

_HDR_PW = frozenset({"password", "passwords", "pass", "pwd", "passwort", "kennwort", "contraseña", "mot de passe", "senha", "login_password", "login password"})
_HDR_ID = frozenset(
    {"username", "user", "user name", "login", "login_username", "login name", "email", "e-mail", "account", "site", "website", "url",
     "login_uri", "name", "title", "service", "hostname", "origin", "origin_url", "web site"}
)
_JSON_PW = re.compile(r"\"(?:password|pass|pwd)\"\s*:\s*\"(?P<v>(?:[^\"\\]|\\.){1,128})\"", re.IGNORECASE)
_LIST_ROWS = 20


def _table(lines: list[str]) -> list[Hit]:
    for i, line in enumerate(lines[:60]):
        for sep in (",", "\t", ";", "|"):
            cells = [c.strip().strip("\"'").lower() for c in line.split(sep)]
            if len(cells) < 2:
                continue
            pw = next((j for j, c in enumerate(cells) if c in _HDR_PW), None)
            if pw is None or not any(c in _HDR_ID for c in cells):
                continue
            rows: list[str] = []
            values: list[str] = []
            for row in lines[i + 1 :]:
                parts = [c.strip().strip('"') for c in row.split(sep)]
                if len(parts) > pw and parts[pw] and not _PLACEHOLDER.match(parts[pw]):
                    values.append(parts[pw])
                    if len(rows) < _LIST_ROWS:
                        rows.append(row.strip())
            if values:
                block = "\n".join([line.strip(), *rows])
                return [Hit("password_list", block[:6000], label="A list with a password column", count=len(values), line=i)]
    return []


def _json_list(text: str, lines: list[str]) -> list[Hit]:
    values = [m.group("v") for m in _JSON_PW.finditer(text[:MAX_TEXT])]
    values = [v for v in values if not _PLACEHOLDER.match(v) and len(v) >= 4]
    if not values:
        return []
    line = next((i for i, ln in enumerate(lines) if _JSON_PW.search(ln)), 0)
    if len(values) >= 2:
        return [Hit("password_list", "\n".join(values[:_LIST_ROWS]), label="Saved passwords", count=len(values), line=line)]
    return [Hit("password", values[0], label="Password", line=line)]


# ------------------------------------------------------------------ the whole thing


def scan_text(text: str, *, subject: str = "", codes_file: bool = False) -> list[Hit]:
    """Everything that looks like a secret in some text, most specific first. A value
    found by one detector isn't reported again by a vaguer one."""
    if not text and not subject:
        return []
    full = f"{subject}\n{text}" if subject else text
    lines = _lines(full)
    taken: set[str] = set()
    hits: list[Hit] = []
    hits += _private_keys(lines)
    hits += _env(lines, taken)
    hits += _totp(lines, full, taken)
    hits += _api_keys(lines, taken)
    hits += _recovery(lines, assume=codes_file)
    hits += _table(lines) or _json_list(full, lines)
    hits += _wifi_qr(lines)
    for h in _passwords(lines):
        if h.value in taken or any(h.value in x.value for x in hits if x.kind in ("password_list", "recovery_codes", "private_key")):
            continue
        taken.add(h.value)
        hits.append(h)
    return hits


# ------------------------------------------------------------------ files by name

STORE_EXTS = (".kdbx", ".kdb", ".1pux", ".1pif", ".opvault", ".agilekeychain", ".psafe3", ".keychain", ".keychain-db")
_NAME_PASSWORDS = re.compile(
    r"pass\s?words?|passwd|\blogins?\b|credentials?|\bcreds\b|kennw[öo]rter|passw[öo]rter|contrase[ñn]as|mots?[ _-]de[ _-]passe|"
    r"bitwarden|lastpass|1password|dashlane|keeper|nordpass|roboform|enpass|proton[ _-]?pass|promptly-vault-",
    re.IGNORECASE,
)
_NAME_CODES = re.compile(r"(?:recovery|backup)[-_ ]?(?:codes?|keys?)|codes?[-_ ]de[-_ ]secours", re.IGNORECASE)
_NAME_SECRETS = re.compile(r"^\.env(?:\..+)?$|\.env$|^\.?(?:pgpass|netrc|npmrc|pypirc|htpasswd|git-credentials)$|^id_(?:rsa|dsa|ecdsa|ed25519)$", re.IGNORECASE)


def name_kind(name: str) -> str | None:
    """What a file's name alone says, used when its contents can't be read."""
    low = name.lower()
    if low.endswith(STORE_EXTS):
        return "password_store"
    if _NAME_PASSWORDS.search(name) or _NAME_CODES.search(name) or _NAME_SECRETS.search(name):
        return "password_file"
    return None


def scan_file(name: str, text: str | None) -> list[Hit]:
    """A file: by what's in it where that can be read, by its name where it can't. A
    password manager's own file is worth saying even though it's encrypted: it's a copy
    outside the vault."""
    if name.lower().endswith(STORE_EXTS):
        return [Hit("password_store", "", label=name.rsplit(".", 1)[-1].upper())]
    if text is None:
        kind = name_kind(name)
        return [Hit(kind, "", label="File name")] if kind else []
    return scan_text(text, codes_file=bool(_NAME_CODES.search(name)))


def scan_photo(text: str) -> list[Hit]:
    """The words read out of a photo. A 2FA setup screen gets its own finding, since its
    QR is the secret, and that's read on the device when someone opens it."""
    hits = scan_text(text)
    if totp_screen(text) and not any(h.kind == "totp_secret" for h in hits):
        hits.append(Hit("totp_qr", "", label="2FA setup screen"))
    return hits


def excerpt(text: str, line: int, *, subject: str = "", before: int = 3, after: int = 8, limit: int = 1500) -> str:
    """A few lines around where it was found, for the person to see why."""
    lines = _lines(f"{subject}\n{text}" if subject else text)
    part = "\n".join(ln.rstrip() for ln in lines[max(0, line - before) : line + after + 1]).strip()
    return part[:limit]


__all__ = ["Hit", "KINDS", "STORE_EXTS", "excerpt", "mask", "name_kind", "preview", "scan_file", "scan_photo", "scan_text", "totp_screen"]
