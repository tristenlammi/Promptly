import type { MarkupShape } from "@/api/photos";

/** Photo markup (PH-7): drawing the marks in the editor, the same way the
 *  server does (app/photos/edits.py ``draw_markup``) — blur boxes first,
 *  then the rest in order; points are 0–1 of the finished picture, widths
 *  and sizes a fraction of its shorter side. */

export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"] as const;
/** Stroke widths (fraction of the shorter side): thin, medium, thick. */
export const WIDTHS = [0.006, 0.012, 0.024] as const;
/** Text sizes for the same three steps. */
export const TEXT_SIZES = [0.04, 0.065, 0.1] as const;
export const HIGHLIGHT_ALPHA = 0.4;
export const HIGHLIGHT_FACTOR = 3;
const PIXEL_BLOCK = 0.03;
export const TEXT_FONT = `"DejaVu Sans", Verdana, "Segoe UI", Arial, sans-serif`;
const EMOJI_FONT = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif`;

/** The built-in stickers — the same PNGs the server draws
 *  (backend/app/photos/stickers, made by make_stickers.py). Tintable ones
 *  are white and take the chosen colour. */
export const STICKERS: { id: string; label: string; tint: boolean }[] = [
  { id: "circle", label: "Hand-drawn circle", tint: true },
  { id: "arrow", label: "Arrow", tint: true },
  { id: "curved-arrow", label: "Curved arrow", tint: true },
  { id: "check", label: "Tick", tint: true },
  { id: "cross", label: "Cross", tint: true },
  { id: "star", label: "Star", tint: true },
  { id: "heart", label: "Heart", tint: true },
  { id: "sparkle", label: "Sparkle", tint: true },
  { id: "squiggle", label: "Squiggle", tint: true },
  { id: "speech", label: "Speech bubble", tint: false },
  { id: "thought", label: "Thought bubble", tint: false },
  { id: "exclaim", label: "! badge", tint: false },
  { id: "question", label: "? badge", tint: false },
  { id: "new", label: "NEW", tint: false },
  { id: "sold", label: "SOLD", tint: false },
  { id: "price", label: "Price tag", tint: false },
];
const TINTABLE = new Set(STICKERS.filter((s) => s.tint).map((s) => s.id));
export const stickerUrl = (id: string) => `/photo-stickers/${id}.png`;

// Sticker pictures, loaded once; whoever draws is told when one arrives.
const pictures = new Map<string, HTMLImageElement>();
const tinted = new Map<string, HTMLCanvasElement>();
const waiting = new Set<() => void>();
export function onStickerLoad(fn: () => void): () => void {
  waiting.add(fn);
  return () => waiting.delete(fn);
}
function sticker(id: string, color: string | undefined): CanvasImageSource | null {
  let im = pictures.get(id);
  if (!im) {
    im = new Image();
    im.onload = () => waiting.forEach((fn) => fn());
    im.src = stickerUrl(id);
    pictures.set(id, im);
  }
  if (!im.complete || !im.naturalWidth) return null;
  if (!TINTABLE.has(id) || !color) return im;
  const key = `${id}|${color}`;
  let c = tinted.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    tinted.set(key, c);
  }
  return c;
}

/** The emoji's ink box at 100 px (left, right, ascent, descent from the
 *  alphabetic origin) — it's scaled so the ink is ``size`` wide, as the
 *  server does with Noto Color Emoji. */
function emojiInk(ctx: CanvasRenderingContext2D, em: string) {
  ctx.font = `100px ${EMOJI_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(em);
  const l = m.actualBoundingBoxLeft || 0;
  const r = m.actualBoundingBoxRight || m.width;
  const a = m.actualBoundingBoxAscent || 80;
  const d = m.actualBoundingBoxDescent || 20;
  return { l, r, a, d, w: Math.max(1, l + r), h: Math.max(1, a + d) };
}

/** An emoji's or sticker's box (pixels): centre, half width / height, turn. */
export function itemBox(ctx: CanvasRenderingContext2D, s: MarkupShape, W: number, H: number) {
  const short = Math.min(W, H);
  const w = (s.size ?? 0.2) * short;
  let h = w;
  if (s.type === "emoji") {
    const ink = emojiInk(ctx, s.emoji ?? "");
    h = (w * ink.h) / ink.w;
  }
  return { cx: s.points[0][0] * W, cy: s.points[0][1] * H, hw: w / 2, hh: h / 2, rot: ((s.rotation ?? 0) * Math.PI) / 180 };
}

export function arrowHead(x0: number, y0: number, x1: number, y1: number, w: number, short: number): [number, number][] {
  const length = Math.max(4 * w, 0.025 * short);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const spread = (28 * Math.PI) / 180;
  return [
    [x1, y1],
    [x1 - length * Math.cos(ang - spread), y1 - length * Math.sin(ang - spread)],
    [x1 - length * Math.cos(ang + spread), y1 - length * Math.sin(ang + spread)],
  ];
}

function outlineFor(color: string): string {
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 60 ? "#ffffff" : "#000000";
}

function pixelate(ctx: CanvasRenderingContext2D, base: CanvasImageSource, x0: number, y0: number, x1: number, y1: number, block: number, filter: string) {
  const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
  if (w < 1 || h < 1) return;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const s = small.getContext("2d")!;
  // The picture as shown (its adjustments are a CSS filter on the stage).
  if ("filter" in s) s.filter = filter;
  s.imageSmoothingQuality = "high";
  s.drawImage(base, Math.round(x0), Math.round(y0), w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, Math.round(x0), Math.round(y0), w, h);
  ctx.restore();
}

/** Draw the marks on ``ctx`` (W×H pixels). ``base`` is the picture under
 *  them, for blur boxes. */
export function drawMarkup(ctx: CanvasRenderingContext2D, shapes: MarkupShape[], W: number, H: number, base: CanvasImageSource | null, filter = "none") {
  const short = Math.min(W, H);
  const block = Math.max(2, Math.round(PIXEL_BLOCK * short));
  for (const s of shapes) {
    if (s.type !== "blur" || !base || s.points.length < 2) continue;
    const [[ax, ay], [bx, by]] = s.points;
    const x0 = Math.min(ax, bx) * W, x1 = Math.max(ax, bx) * W, y0 = Math.min(ay, by) * H, y1 = Math.max(ay, by) * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.round(x0), Math.round(y0), Math.round(x1) - Math.round(x0), Math.round(y1) - Math.round(y0));
    ctx.clip();
    pixelate(ctx, base, x0, y0, x1, y1, block, filter);
    ctx.restore();
  }
  for (const s of shapes) {
    if (s.type === "blur") continue;
    const P = s.points.map(([x, y]) => [x * W, y * H] as [number, number]);
    if (!P.length) continue;
    ctx.save();
    if (s.type === "emoji" || s.type === "sticker") {
      const b = itemBox(ctx, s, W, H);
      ctx.translate(b.cx, b.cy);
      ctx.rotate(b.rot);
      if (s.type === "sticker") {
        const pic = sticker(s.sticker ?? "", s.color);
        if (pic) ctx.drawImage(pic, -b.hw, -b.hh, b.hw * 2, b.hh * 2);
      } else {
        const ink = emojiInk(ctx, s.emoji ?? "");
        const k = (b.hw * 2) / ink.w;
        ctx.scale(k, k);
        ctx.fillText(s.emoji ?? "", -(ink.r - ink.l) / 2, -(ink.d - ink.a) / 2);
      }
      ctx.restore();
      continue;
    }
    const color = s.color ?? "#ff0000";
    if (s.type === "text") {
      const size = Math.max(4, Math.round((s.size ?? 0.05) * short));
      ctx.font = `bold ${size}px ${TEXT_FONT}`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2 * Math.max(1, Math.round(size * 0.06));
      ctx.strokeStyle = outlineFor(color);
      ctx.strokeText(s.text ?? "", P[0][0], P[0][1]);
      ctx.fillStyle = color;
      ctx.fillText(s.text ?? "", P[0][0], P[0][1]);
      ctx.restore();
      continue;
    }
    const w = Math.max(1, (s.width ?? 0.01) * short);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.type === "pen" || s.type === "highlighter") {
      if (s.type === "highlighter") ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      if (P.length === 1) ctx.lineTo(P[0][0] + 0.01, P[0][1]);
      for (const [x, y] of P.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    } else if (P.length >= 2) {
      const [[x0, y0], [x1, y1]] = P;
      if (s.type === "line") {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else if (s.type === "arrow") {
        const head = arrowHead(x0, y0, x1, y1, w, short);
        const bx = (head[1][0] + head[2][0]) / 2, by = (head[1][1] + head[2][1]) / 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo((bx + x1) / 2, (by + y1) / 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(head[0][0], head[0][1]);
        ctx.lineTo(head[1][0], head[1][1]);
        ctx.lineTo(head[2][0], head[2][1]);
        ctx.closePath();
        ctx.fill();
      } else if (s.type === "rect") {
        ctx.lineJoin = "miter";
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else if (s.type === "ellipse") {
        ctx.beginPath();
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Roughly where a mark is (pixels) — for picking one to move or delete. */
export function shapeBounds(ctx: CanvasRenderingContext2D, s: MarkupShape, W: number, H: number) {
  const short = Math.min(W, H);
  if (s.type === "emoji" || s.type === "sticker") {
    const b = itemBox(ctx, s, W, H);
    const r = Math.hypot(b.hw, b.hh);
    return { x0: b.cx - r, y0: b.cy - r, x1: b.cx + r, y1: b.cy + r };
  }
  if (s.type === "text") {
    const size = Math.max(4, Math.round((s.size ?? 0.05) * short));
    ctx.font = `bold ${size}px ${TEXT_FONT}`;
    const w = ctx.measureText(s.text ?? "").width;
    const [x, y] = [s.points[0][0] * W, s.points[0][1] * H];
    return { x0: x, y0: y, x1: x + w, y1: y + size * 1.2 };
  }
  const pad = s.type === "blur" ? 0 : ((s.width ?? 0.01) * short * (s.type === "highlighter" ? 1 : 1)) / 2;
  const xs = s.points.map((p) => p[0] * W), ys = s.points.map((p) => p[1] * H);
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The topmost mark under (x, y) pixels, within ``slop`` — or -1. */
export function hitTest(ctx: CanvasRenderingContext2D, shapes: MarkupShape[], x: number, y: number, W: number, H: number, slop: number): number {
  const short = Math.min(W, H);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === "emoji" || s.type === "sticker") {
      const b = itemBox(ctx, s, W, H);
      const dx = x - b.cx, dy = y - b.cy;
      const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
      if (Math.abs(lx) <= b.hw + slop && Math.abs(ly) <= b.hh + slop) return i;
      continue;
    }
    if (s.type === "pen" || s.type === "highlighter" || s.type === "line" || s.type === "arrow") {
      const w = ((s.width ?? 0.01) * short * (s.type === "highlighter" ? 1 : 1)) / 2;
      const P = s.points.map(([px, py]) => [px * W, py * H]);
      if (P.length === 1 && Math.hypot(x - P[0][0], y - P[0][1]) <= w + slop) return i;
      for (let k = 1; k < P.length; k++) {
        if (distToSegment(x, y, P[k - 1][0], P[k - 1][1], P[k][0], P[k][1]) <= w + slop) return i;
      }
      continue;
    }
    if (s.type === "ellipse" || s.type === "rect") {
      // The outline, not the inside (so what's under a circle can be picked).
      const b = shapeBounds(ctx, s, W, H);
      const w = (s.width ?? 0.01) * short;
      const inner = x > b.x0 + w + slop && x < b.x1 - w - slop && y > b.y0 + w + slop && y < b.y1 - w - slop;
      if (x >= b.x0 - slop && x <= b.x1 + slop && y >= b.y0 - slop && y <= b.y1 + slop && !inner) return i;
      continue;
    }
    const b = shapeBounds(ctx, s, W, H);
    if (x >= b.x0 - slop && x <= b.x1 + slop && y >= b.y0 - slop && y <= b.y1 + slop) return i;
  }
  return -1;
}

/** A curated set of emoji: [emoji, search words]. */
export const EMOJI: { group: string; items: [string, string][] }[] = [
  { group: "Smileys", items: [
    ["😀", "grin smile happy"], ["😃", "smile happy"], ["😄", "smile laugh"], ["😁", "grin beam"], ["😆", "laugh squint"],
    ["😅", "sweat relief"], ["😂", "joy tears laugh lol"], ["🤣", "rofl laugh"], ["🙂", "slight smile"], ["🙃", "upside down"],
    ["😉", "wink"], ["😊", "blush smile"], ["😇", "angel halo"], ["🥰", "love hearts"], ["😍", "heart eyes love"],
    ["🤩", "star struck wow"], ["😘", "kiss"], ["😋", "yum tasty"], ["😛", "tongue"], ["😜", "wink tongue crazy"],
    ["🤪", "zany crazy"], ["🤑", "money"], ["🤗", "hug"], ["🤭", "oops giggle"], ["🤫", "shush quiet"],
    ["🤔", "thinking hmm"], ["🤐", "zip mouth"], ["🤨", "raised eyebrow sus"], ["😐", "neutral"], ["😑", "expressionless"],
    ["😶", "no mouth"], ["😏", "smirk"], ["😒", "unamused"], ["🙄", "eye roll"], ["😬", "grimace awkward"],
    ["😌", "relieved"], ["😔", "pensive sad"], ["😪", "sleepy"], ["🤤", "drool"], ["😴", "sleep zzz"],
    ["😷", "mask sick"], ["🤒", "thermometer sick"], ["🤕", "hurt bandage"], ["🤢", "nauseated sick"], ["🤮", "vomit"],
    ["🥵", "hot"], ["🥶", "cold freezing"], ["🥴", "woozy"], ["😵", "dizzy"], ["🤯", "mind blown"],
    ["🤠", "cowboy"], ["🥳", "party celebrate"], ["😎", "cool sunglasses"], ["🤓", "nerd"], ["🧐", "monocle inspect"],
    ["😕", "confused"], ["😟", "worried"], ["🙁", "frown"], ["😮", "open mouth wow"], ["😯", "hushed"],
    ["😲", "astonished shock"], ["😳", "flushed embarrassed"], ["🥺", "pleading puppy eyes"], ["😦", "frowning"], ["😨", "fearful scared"],
    ["😰", "anxious sweat"], ["😥", "sad relieved"], ["😢", "cry sad tear"], ["😭", "sob cry"], ["😱", "scream fear"],
    ["😖", "confounded"], ["😣", "persevere"], ["😞", "disappointed"], ["😓", "downcast sweat"], ["😩", "weary"],
    ["😫", "tired"], ["🥱", "yawn bored"], ["😤", "triumph huff"], ["😡", "angry mad rage"], ["😠", "angry"],
    ["🤬", "swearing cursing"], ["😈", "devil smiling"], ["💀", "skull dead"], ["💩", "poop"], ["🤡", "clown"],
    ["👻", "ghost"], ["👽", "alien"], ["🤖", "robot"], ["😺", "cat smile"], ["🙈", "see no evil monkey"],
  ] },
  { group: "People", items: [
    ["👍", "thumbs up yes like good"], ["👎", "thumbs down no bad"], ["👌", "ok perfect"], ["✌️", "victory peace"], ["🤞", "fingers crossed luck"],
    ["🤟", "love you"], ["🤘", "rock horns"], ["🤙", "call me shaka"], ["👈", "point left"], ["👉", "point right"],
    ["👆", "point up"], ["👇", "point down"], ["☝️", "index up"], ["✋", "raised hand stop"], ["🖐️", "hand fingers"],
    ["👋", "wave hello bye"], ["👏", "clap applause"], ["🙌", "raise hands hooray"], ["👐", "open hands"], ["🤲", "palms up"],
    ["🙏", "pray thanks please"], ["✍️", "writing"], ["💪", "muscle strong flex"], ["🦵", "leg"], ["👀", "eyes look"],
    ["👁️", "eye"], ["👂", "ear"], ["👃", "nose"], ["👄", "mouth lips"], ["🧠", "brain"],
    ["👶", "baby"], ["🧒", "child"], ["👦", "boy"], ["👧", "girl"], ["🧑", "person"],
    ["👨", "man"], ["👩", "woman"], ["🧓", "older person"], ["👴", "old man grandpa"], ["👵", "old woman grandma"],
    ["👮", "police"], ["👷", "construction worker"], ["💂", "guard"], ["🕵️", "detective"], ["🎅", "santa christmas"],
    ["🤶", "mrs claus"], ["🦸", "superhero"], ["🧙", "wizard mage"], ["🧚", "fairy"], ["💃", "dance woman"],
    ["🕺", "dance man"], ["🚶", "walk"], ["🏃", "run"], ["🧘", "yoga"], ["👑", "crown king queen"],
  ] },
  { group: "Hearts & symbols", items: [
    ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"],
    ["💜", "purple heart"], ["🖤", "black heart"], ["🤍", "white heart"], ["💔", "broken heart"], ["💕", "two hearts"],
    ["💖", "sparkling heart"], ["💯", "hundred 100 perfect"], ["💢", "anger"], ["💥", "boom collision"], ["💫", "dizzy star"],
    ["💦", "sweat drops water"], ["💨", "dash wind"], ["💬", "speech bubble"], ["💭", "thought bubble"], ["💤", "zzz sleep"],
    ["✅", "check done yes"], ["❌", "cross no wrong"], ["❗", "exclamation important"], ["❓", "question"], ["⚠️", "warning caution"],
    ["⛔", "no entry"], ["🚫", "prohibited no"], ["⭕", "circle"], ["🔴", "red circle"], ["🟢", "green circle"],
    ["🔵", "blue circle"], ["⭐", "star"], ["🌟", "glowing star"], ["✨", "sparkles"], ["⚡", "lightning zap"],
    ["🔥", "fire hot lit"], ["🎯", "target bullseye"], ["➡️", "right arrow"], ["⬅️", "left arrow"], ["⬆️", "up arrow"],
    ["⬇️", "down arrow"], ["↗️", "up right arrow"], ["🔄", "repeat cycle"], ["🆕", "new"], ["🆗", "ok"],
    ["🆒", "cool"], ["🆓", "free"], ["🔝", "top"], ["💲", "dollar price"], ["♻️", "recycle"],
  ] },
  { group: "Animals & nature", items: [
    ["🐶", "dog puppy"], ["🐱", "cat kitten"], ["🐭", "mouse"], ["🐹", "hamster"], ["🐰", "rabbit bunny"],
    ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"], ["🐨", "koala"], ["🐯", "tiger"],
    ["🦁", "lion"], ["🐮", "cow"], ["🐷", "pig"], ["🐸", "frog"], ["🐵", "monkey"],
    ["🐔", "chicken"], ["🐧", "penguin"], ["🐦", "bird"], ["🦆", "duck"], ["🦉", "owl"],
    ["🐴", "horse"], ["🦄", "unicorn"], ["🐝", "bee"], ["🦋", "butterfly"], ["🐌", "snail"],
    ["🐞", "ladybug"], ["🐢", "turtle"], ["🐍", "snake"], ["🐙", "octopus"], ["🐠", "fish"],
    ["🐬", "dolphin"], ["🐳", "whale"], ["🦈", "shark"], ["🐘", "elephant"], ["🦒", "giraffe"],
    ["🌸", "blossom flower"], ["🌹", "rose"], ["🌻", "sunflower"], ["🌷", "tulip"], ["🌲", "tree evergreen"],
    ["🌴", "palm tree beach"], ["🌵", "cactus"], ["🍀", "clover luck"], ["🍁", "maple leaf autumn"], ["🍄", "mushroom"],
    ["🌍", "earth world globe"], ["🌙", "moon night"], ["☀️", "sun sunny"], ["⛅", "cloud sun"], ["🌧️", "rain"],
    ["❄️", "snow cold"], ["🌈", "rainbow"], ["🌊", "wave ocean sea"], ["💧", "drop water"], ["🌋", "volcano"],
  ] },
  { group: "Food & drink", items: [
    ["🍎", "apple"], ["🍌", "banana"], ["🍇", "grapes"], ["🍓", "strawberry"], ["🍉", "watermelon"],
    ["🍑", "peach"], ["🍍", "pineapple"], ["🥑", "avocado"], ["🥕", "carrot"], ["🌽", "corn"],
    ["🌶️", "chili pepper hot"], ["🍞", "bread"], ["🧀", "cheese"], ["🥚", "egg"], ["🥓", "bacon"],
    ["🍔", "burger"], ["🍟", "fries"], ["🍕", "pizza"], ["🌭", "hot dog"], ["🌮", "taco"],
    ["🍝", "pasta spaghetti"], ["🍜", "noodles ramen"], ["🍣", "sushi"], ["🍦", "ice cream"], ["🍩", "donut"],
    ["🍪", "cookie"], ["🎂", "birthday cake"], ["🍰", "cake"], ["🍫", "chocolate"], ["🍿", "popcorn"],
    ["☕", "coffee"], ["🍵", "tea"], ["🍺", "beer"], ["🍷", "wine"], ["🥂", "cheers champagne"],
  ] },
  { group: "Activities & travel", items: [
    ["⚽", "soccer football"], ["🏀", "basketball"], ["🏈", "american football"], ["⚾", "baseball"], ["🎾", "tennis"],
    ["🏐", "volleyball"], ["🏉", "rugby"], ["🎱", "pool 8 ball"], ["🏓", "ping pong"], ["⛳", "golf"],
    ["🎣", "fishing"], ["🏆", "trophy win"], ["🥇", "gold medal first"], ["🎉", "party popper celebrate"], ["🎊", "confetti"],
    ["🎈", "balloon"], ["🎁", "gift present"], ["🎄", "christmas tree"], ["🎃", "pumpkin halloween"], ["🎆", "fireworks"],
    ["🎮", "video game"], ["🎲", "dice"], ["🎨", "art palette"], ["🎵", "music note"], ["🎸", "guitar"],
    ["🚗", "car"], ["🚕", "taxi"], ["🚌", "bus"], ["🚲", "bike bicycle"], ["✈️", "plane flight"],
    ["🚀", "rocket"], ["🚢", "ship"], ["⛵", "sailboat"], ["🏠", "house home"], ["🏖️", "beach"],
    ["🏔️", "mountain"], ["⛺", "tent camping"], ["🗽", "statue of liberty"], ["🗼", "tower"], ["📍", "pin location"],
  ] },
  { group: "Objects", items: [
    ["📷", "camera photo"], ["📸", "camera flash"], ["📱", "phone mobile"], ["💻", "laptop"], ["⌚", "watch"],
    ["💡", "idea bulb"], ["🔦", "torch flashlight"], ["📚", "books"], ["✏️", "pencil"], ["📌", "pushpin"],
    ["📎", "paperclip"], ["✂️", "scissors"], ["🔑", "key"], ["🔒", "lock"], ["🔔", "bell"],
    ["📣", "megaphone"], ["💰", "money bag"], ["💵", "dollar cash"], ["💳", "card"], ["🛒", "cart shopping"],
    ["🎀", "ribbon bow"], ["🏷️", "label tag price"], ["📦", "package box"], ["✉️", "envelope mail"], ["📅", "calendar date"],
    ["⏰", "alarm clock"], ["⌛", "hourglass"], ["🔍", "search magnify"], ["🧸", "teddy bear"], ["💎", "gem diamond"],
  ] },
];
