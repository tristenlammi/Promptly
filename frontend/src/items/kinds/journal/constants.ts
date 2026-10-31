/* Moods, the curated emotions (mirrors models.py EMOTIONS) and the prompt library. */

export interface MoodInfo {
  value: number;
  label: string;
  /** A calm, semantic hue — mixed with the surface for fills so it works in both themes. */
  color: string;
}

export const MOODS: MoodInfo[] = [
  { value: 1, label: "Awful", color: "#7C83B8" },
  { value: 2, label: "Low", color: "#6E9CC4" },
  { value: 3, label: "Okay", color: "#C2A867" },
  { value: 4, label: "Good", color: "#7FB069" },
  { value: 5, label: "Great", color: "#E39A4C" },
];

export const ENERGY = ["Drained", "Low", "Steady", "Energised", "Buzzing"];

export function moodInfo(v: number | null | undefined): MoodInfo | null {
  if (!v) return null;
  return MOODS[Math.max(1, Math.min(5, Math.round(v))) - 1];
}

/** A colour for an average mood (interpolated between the two nearest). */
export function moodColor(avg: number): string {
  const lo = Math.max(1, Math.min(5, Math.floor(avg)));
  const hi = Math.min(5, lo + 1);
  const t = Math.round((avg - lo) * 100);
  if (lo === hi || t <= 0) return MOODS[lo - 1].color;
  return `color-mix(in srgb, ${MOODS[hi - 1].color} ${t}%, ${MOODS[lo - 1].color})`;
}

export interface EmotionFamily {
  id: string;
  label: string;
  color: string;
  words: string[];
}

/** Feelings-wheel based (Plutchik's primaries + Willcox's wheel), grouped. */
export const EMOTION_FAMILIES: EmotionFamily[] = [
  { id: "joyful", label: "Joyful", color: "#E39A4C", words: ["happy", "content", "grateful", "proud", "hopeful", "excited", "playful", "loved", "inspired", "confident", "relieved", "amused"] },
  { id: "calm", label: "Calm", color: "#5FA59A", words: ["calm", "peaceful", "relaxed", "safe", "centred", "focused"] },
  { id: "sad", label: "Sad", color: "#6E9CC4", words: ["sad", "lonely", "disappointed", "hurt", "grieving", "guilty", "ashamed", "empty", "nostalgic", "homesick"] },
  { id: "anxious", label: "Anxious", color: "#9B7FC4", words: ["anxious", "worried", "overwhelmed", "insecure", "nervous", "scared", "stressed", "restless"] },
  { id: "angry", label: "Angry", color: "#D0675B", words: ["angry", "frustrated", "irritated", "resentful", "jealous", "annoyed"] },
  { id: "surprised", label: "Surprised", color: "#C9A23E", words: ["surprised", "amazed", "confused", "curious", "moved"] },
  { id: "tired", label: "Tired", color: "#8E8A80", words: ["tired", "bored", "numb", "drained", "unmotivated"] },
];

export const FAMILY_OF: Record<string, EmotionFamily> = Object.fromEntries(
  EMOTION_FAMILIES.flatMap((f) => f.words.map((w) => [w, f] as const)),
);

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface PromptGroup {
  theme: string;
  prompts: string[];
}

/** The reflective prompt library. */
export const PROMPT_LIBRARY: PromptGroup[] = [
  {
    theme: "Today",
    prompts: [
      "What's one moment from today you'd like to remember?",
      "What took your energy today — and what gave some back?",
      "When did you feel most like yourself today?",
      "What surprised you today?",
      "What did you learn today, about anything?",
      "What's still on your mind as the day ends?",
      "If today had a title, what would it be?",
      "Who did you connect with today, and how did it feel?",
    ],
  },
  {
    theme: "Gratitude",
    prompts: [
      "What small thing went right today, and why did it happen?",
      "Who made your life a little easier lately? What did they do?",
      "What's something you usually take for granted that you're glad of today?",
      "Which place makes you feel at home, and why?",
      "What ability or strength of yours are you thankful for?",
      "What made you laugh recently?",
    ],
  },
  {
    theme: "Feelings",
    prompts: [
      "What are you feeling right now? Try to name it precisely.",
      "Where do you notice this feeling in your body?",
      "What has been weighing on you? Write it all out — no one else will read it.",
      "What do you need right now that you're not getting?",
      "What would you say to a friend who felt the way you do?",
      "What's a worry you can set down for tonight?",
      "When did you last feel truly at ease? What was happening?",
    ],
  },
  {
    theme: "Thoughts",
    prompts: [
      "What story are you telling yourself about a situation right now? Is it the only one?",
      "What's a thought that keeps coming back? What evidence supports it — and what doesn't?",
      "Is there a 'should' you're holding yourself to? Whose voice is it?",
      "What would this look like if it were easy?",
      "What's in your control here, and what isn't?",
      "What's the kindest honest thing you could tell yourself right now?",
    ],
  },
  {
    theme: "Values & growth",
    prompts: [
      "What mattered most to you this week? Did your time reflect it?",
      "When did you act in a way you're proud of recently?",
      "What would you like more of in your life? Less of?",
      "What's a small step toward something you care about that you could take tomorrow?",
      "What are you learning to let go of?",
      "What does a good day look like for you, honestly?",
      "Which of your habits is quietly serving you well?",
      "What's a fear that's been holding you back? What would you do without it?",
    ],
  },
  {
    theme: "Relationships",
    prompts: [
      "Who do you miss? What would you tell them?",
      "Which conversation do you keep putting off? What would you want to say?",
      "Who brings out the best in you, and how?",
      "How did you show care for someone recently?",
      "Is there someone you'd like to forgive — including yourself?",
    ],
  },
  {
    theme: "Looking back & ahead",
    prompts: [
      "What would you tell yourself from a year ago?",
      "What's changed in you over the last few months?",
      "Describe a memory that still makes you smile.",
      "Imagine it's a year from now and things went well. What happened?",
      "What are you looking forward to?",
      "What chapter of your life are you in right now? What's it about?",
    ],
  },
];

export const ALL_PROMPTS = PROMPT_LIBRARY.flatMap((g) => g.prompts);
