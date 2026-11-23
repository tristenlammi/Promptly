// The photographs fetch-photos.mjs downloads: title on Wikimedia Commons →
// [the date it is filed under in the demo library, album]. All were marked
// CC0 or public domain on Commons when picked; the fetch checks again and
// skips any that no longer are.
const T = "Tasmania 2025";
const B = "Biscuit";
const F = "Food";
const park = (n) => `File:Dove Lake Circuit Walking Track, Cradle Mountain - Lake St Clair National Park ${n}.jpg`;
const coast = (n) => `File:Freycinet National Park, Tasmania ${n}.jpg`;

export const PICKS = {
  "File:Dove Lake and Cradle Mountain.jpg": ["2025-01-12T09:14", T],
  [park("91")]: ["2025-01-12T09:40", T],
  [park("68")]: ["2025-01-12T10:05", T],
  [park("64")]: ["2025-01-12T10:31", T],
  [park("16")]: ["2025-01-12T11:02", T],
  [park("03")]: ["2025-01-12T11:26", T],
  [park("12")]: ["2025-01-12T11:48", T],
  [park("04")]: ["2025-01-12T12:20", T],
  "File:Wombat Pool, Cradle Mountain.jpg": ["2025-01-13T08:52", T],
  [coast("19")]: ["2025-01-15T08:10", T],
  [coast("20")]: ["2025-01-15T08:34", T],
  [coast("18")]: ["2025-01-15T08:41", T],
  [coast("17")]: ["2025-01-15T11:15", T],
  [coast("13")]: ["2025-01-15T11:22", T],
  [coast("12")]: ["2025-01-15T11:40", T],
  [coast("11")]: ["2025-01-15T15:03", T],
  [coast("08")]: ["2025-01-16T07:25", T],
  "File:Macquarie Wharf, Hobart, Tasmania.jpg": ["2025-01-17T10:12", T],
  "File:Golden-retriever-1827903 1920.jpg": ["2023-09-02T10:20", B],
  "File:Golden Retriever puppy (3813393).jpg": ["2023-09-10T16:45", B],
  "File:Golden Retriever adult.jpg": ["2024-10-19T08:05", B],
  "File:Golden Retriever Yardie.jpg": ["2026-10-03T12:31", B],
  "File:Golden Retriever shaking off water.jpg": ["2026-11-22T15:42", B],
  "File:Golden Retriever Swimming.jpg": ["2026-11-22T15:40", B],
  "File:Golden-retriever-dog.jpg": ["2026-10-03T13:20", B],
  "File:Sitting golden retriever.jpg": ["2026-11-22T17:05", B],
  "File:Foodiesfeed.com pouring-honey-on-pancakes-with-walnuts.jpg": ["2026-11-22T08:48", F],
  "File:The Smoking Stack Pancakes - Laughing Dog 2026-08-25.jpg": ["2026-11-22T08:51", F],
  "File:Burger Brothers picnic in Royal Pavilion Gardens 2024-03-30.jpg": ["2026-10-03T12:55", F],
  "File:Birthday Cake with Candles (Unsplash M20ylqCzSZw).jpg": ["2025-12-12T15:20", null],
  "File:Happy birthday candles (Unsplash).jpg": ["2025-12-12T15:21", null],
  "File:Children enjoying the beach (Unsplash).jpg": ["2026-01-04T17:50", null],
  "File:Cable Beach Sunset by Kate Branch.jpg": ["2026-01-04T19:32", null],
  "File:Sunset, Lone Ranch Beach, Oregon.jpg": ["2026-04-04T18:40", "Easter camping"],
  "File:Brighton beach at sunset 2025-02-27.jpg": ["2026-10-03T18:02", null],
  "File:Sunset on the beach in Colonia del Sacramento.jpg": ["2026-11-22T19:31", null],
  "File:Tangle Lakes campsite (51297923239).jpg": ["2026-04-04T16:12", "Easter camping"],
  "File:Tangle Lakes campsite (51296477492).jpg": ["2026-04-04T09:30", "Easter camping"],
  "File:Fish Lake (43678300911).jpg": ["2026-04-05T07:44", "Easter camping"],
  "File:Christmas tree London 2012 04.jpg": ["2025-12-24T19:15", null],
};
