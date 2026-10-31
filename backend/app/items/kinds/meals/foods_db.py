"""A compact built-in list of common generic foods, per 100 g (100 ml for
drinks), rounded from USDA FoodData Central (SR Legacy / FNDDS) reference
values. Branded and regional foods come from Open Food Facts or the
person's own library; these cover the everyday basics so logging works
offline and the AI can use real numbers instead of guessing.

Referenced from a diary as ``b:<slug>``. The list is code, not file data —
improving a value here never rewrites anyone's history (entries keep a
snapshot).

Row: slug, name, category, kcal, protein, carbs, sugar, fibre, fat, sat fat,
sodium mg, servings ("label:grams|…"), micros (short keys, see ``_MICRO``).
"""
from __future__ import annotations

from functools import lru_cache

_MICRO = {
    "k": "potassium_mg",
    "ca": "calcium_mg",
    "fe": "iron_mg",
    "mg": "magnesium_mg",
    "c": "vitamin_c_mg",
    "d": "vitamin_d_ug",
    "b12": "vitamin_b12_ug",
    "chol": "cholesterol_mg",
    "caf": "caffeine_mg",
    "alc": "alcohol_g",
}

# fmt: off
_ROWS: list[tuple] = [
    # --- Eggs & dairy
    ("egg", "Egg, whole", "Eggs & dairy", 143, 12.6, 0.7, 0.4, 0, 9.5, 3.1, 142, "1 large:50|1 medium:44|1 extra large:56", {"k": 138, "ca": 56, "fe": 1.8, "chol": 372, "d": 2.0, "b12": 0.9}),
    ("egg-boiled", "Egg, hard-boiled", "Eggs & dairy", 155, 12.6, 1.1, 1.1, 0, 10.6, 3.3, 124, "1 large:50", {"k": 126, "ca": 50, "fe": 1.2, "chol": 373}),
    ("egg-fried", "Egg, fried", "Eggs & dairy", 196, 13.6, 0.8, 0.4, 0, 14.8, 4.3, 207, "1 large:46", {"chol": 401}),
    ("egg-scrambled", "Eggs, scrambled (with milk)", "Eggs & dairy", 149, 10.0, 1.6, 1.4, 0, 11.0, 3.3, 145, "1 egg's worth:61|1 cup:220", {"chol": 277}),
    ("egg-white", "Egg white", "Eggs & dairy", 52, 10.9, 0.7, 0.7, 0, 0.2, 0, 166, "1 large white:33", {"k": 163}),
    ("milk-whole", "Milk, whole (3.25%)", "Eggs & dairy", 61, 3.2, 4.8, 4.8, 0, 3.3, 1.9, 43, "1 cup:244|1 glass:250|splash:30", {"k": 132, "ca": 113, "d": 1.3, "b12": 0.5}),
    ("milk-2", "Milk, reduced fat (2%)", "Eggs & dairy", 50, 3.3, 4.8, 4.8, 0, 2.0, 1.3, 47, "1 cup:244|1 glass:250|splash:30", {"k": 140, "ca": 120, "d": 1.2, "b12": 0.5}),
    ("milk-skim", "Milk, skim", "Eggs & dairy", 34, 3.4, 5.0, 5.0, 0, 0.1, 0.1, 42, "1 cup:245|1 glass:250", {"k": 156, "ca": 122, "d": 1.2}),
    ("greek-yogurt-0", "Greek yogurt, plain, non-fat", "Eggs & dairy", 59, 10.2, 3.6, 3.2, 0, 0.4, 0.1, 36, "1 pot:170|1 cup:245", {"k": 141, "ca": 110}),
    ("greek-yogurt-full", "Greek yogurt, plain, whole milk", "Eggs & dairy", 97, 9.0, 4.0, 4.0, 0, 5.0, 2.4, 35, "1 pot:170|1 cup:245", {"ca": 100}),
    ("yogurt-plain", "Yogurt, plain, whole milk", "Eggs & dairy", 61, 3.5, 4.7, 4.7, 0, 3.3, 2.1, 46, "1 cup:245|1 pot:150", {"k": 155, "ca": 121}),
    ("yogurt-vanilla", "Yogurt, vanilla, low-fat", "Eggs & dairy", 85, 4.9, 13.8, 13.8, 0, 1.3, 0.8, 66, "1 pot:170", {"ca": 171}),
    ("cheddar", "Cheddar cheese", "Eggs & dairy", 403, 24.9, 1.3, 0.5, 0, 33.1, 21.1, 621, "1 slice:28|1 oz:28|1 cup grated:113", {"ca": 721, "chol": 105}),
    ("mozzarella", "Mozzarella, part-skim", "Eggs & dairy", 254, 24.3, 2.8, 1.1, 0, 15.9, 10.1, 619, "1 oz:28|1 cup grated:113", {"ca": 782}),
    ("parmesan", "Parmesan cheese", "Eggs & dairy", 392, 35.8, 3.2, 0.8, 0, 25.8, 16.4, 1600, "1 tbsp grated:5|1 oz:28", {"ca": 1184}),
    ("feta", "Feta cheese", "Eggs & dairy", 264, 14.2, 4.1, 4.1, 0, 21.3, 14.9, 1116, "1 oz:28|1 cup crumbled:150", {"ca": 493}),
    ("cottage-cheese", "Cottage cheese, low-fat (2%)", "Eggs & dairy", 84, 11.0, 4.3, 4.0, 0, 2.3, 1.4, 321, "1/2 cup:113|1 cup:226", {"ca": 111}),
    ("cream-cheese", "Cream cheese", "Eggs & dairy", 342, 6.0, 4.1, 3.2, 0, 34.2, 19.3, 321, "1 tbsp:14.5", {"ca": 97}),
    ("butter", "Butter, salted", "Eggs & dairy", 717, 0.9, 0.1, 0.1, 0, 81.1, 51.4, 643, "1 tbsp:14|1 tsp:5|1 pat:5", {"chol": 215}),
    ("cream-heavy", "Cream, heavy", "Eggs & dairy", 340, 2.8, 2.7, 2.7, 0, 36.1, 23.0, 27, "1 tbsp:15|splash:15", {"ca": 66}),
    ("sour-cream", "Sour cream", "Eggs & dairy", 198, 2.4, 4.6, 3.4, 0, 19.4, 10.1, 31, "1 tbsp:12", {}),
    ("ice-cream", "Ice cream, vanilla", "Eggs & dairy", 207, 3.5, 23.6, 21.2, 0.7, 11.0, 6.8, 80, "1/2 cup:66|1 scoop:70", {"ca": 128}),
    ("whey", "Whey protein powder", "Eggs & dairy", 400, 78.0, 8.0, 4.0, 0, 6.0, 3.0, 250, "1 scoop:30", {"ca": 400}),
    # --- Meat, fish & protein
    ("chicken-breast", "Chicken breast, skinless, cooked", "Meat & fish", 165, 31.0, 0, 0, 0, 3.6, 1.0, 74, "1 breast:172|1 palm:100", {"k": 256, "fe": 1.0, "chol": 85}),
    ("chicken-breast-raw", "Chicken breast, skinless, raw", "Meat & fish", 120, 22.5, 0, 0, 0, 2.6, 0.6, 45, "1 breast:200", {"k": 334}),
    ("chicken-thigh", "Chicken thigh, skinless, cooked", "Meat & fish", 209, 26.0, 0, 0, 0, 10.9, 3.0, 95, "1 thigh:52", {"fe": 1.3}),
    ("chicken-drumstick", "Chicken drumstick, with skin, roasted", "Meat & fish", 216, 27.0, 0, 0, 0, 11.2, 3.1, 90, "1 drumstick:52", {}),
    ("turkey-mince", "Turkey mince (93% lean), cooked", "Meat & fish", 213, 27.4, 0, 0, 0, 11.6, 3.0, 78, "1 cup:130", {}),
    ("turkey-deli", "Turkey breast, deli slices", "Meat & fish", 104, 17.1, 4.2, 3.5, 0.5, 1.7, 0.4, 1015, "1 slice:28", {}),
    ("beef-mince-85", "Beef mince (85% lean), cooked", "Meat & fish", 250, 25.9, 0, 0, 0, 15.4, 5.9, 72, "1 patty:85|1 cup:130", {"fe": 2.6, "b12": 2.6}),
    ("beef-mince-80-raw", "Beef mince (80% lean), raw", "Meat & fish", 254, 17.2, 0, 0, 0, 20.0, 7.6, 66, "1 lb:454", {"fe": 1.9}),
    ("steak-sirloin", "Beef sirloin steak, lean, cooked", "Meat & fish", 206, 30.0, 0, 0, 0, 8.7, 3.3, 56, "1 steak:200|1 palm:100", {"fe": 2.0, "b12": 1.5}),
    ("pork-chop", "Pork chop, cooked", "Meat & fish", 231, 25.7, 0, 0, 0, 13.5, 4.7, 62, "1 chop:145", {}),
    ("bacon", "Bacon, cooked", "Meat & fish", 541, 37.0, 1.4, 0, 0, 41.8, 13.7, 1717, "1 slice:8|1 rasher (back):12", {}),
    ("ham", "Ham, sliced", "Meat & fish", 145, 21.0, 1.5, 1.3, 0, 6.0, 1.9, 1203, "1 slice:28", {}),
    ("sausage-pork", "Pork sausage, cooked", "Meat & fish", 325, 18.5, 1.4, 0, 0, 27.3, 9.0, 749, "1 sausage:50|1 link:25", {}),
    ("lamb", "Lamb leg, roasted", "Meat & fish", 230, 26.0, 0, 0, 0, 13.6, 5.6, 66, "1 serve:120", {"fe": 2.0}),
    ("beef-jerky", "Beef jerky", "Meat & fish", 410, 33.2, 11.0, 9.0, 1.8, 25.6, 10.9, 1785, "1 oz:28", {}),
    ("salmon", "Salmon, Atlantic, cooked", "Meat & fish", 206, 22.1, 0, 0, 0, 12.4, 2.5, 61, "1 fillet:154|1 palm:100", {"k": 384, "d": 13.1, "b12": 2.8}),
    ("tuna-can", "Tuna, canned in water, drained", "Meat & fish", 116, 25.5, 0, 0, 0, 0.8, 0.2, 247, "1 can drained:120|1 small can:70", {"d": 1.2, "b12": 2.5}),
    ("cod", "Cod, cooked", "Meat & fish", 105, 22.8, 0, 0, 0, 0.9, 0.2, 78, "1 fillet:180", {}),
    ("shrimp", "Shrimp / prawns, cooked", "Meat & fish", 99, 24.0, 0.2, 0, 0, 0.3, 0.1, 111, "1 cup:145|6 large:42", {"chol": 189}),
    ("sardines", "Sardines, canned in oil, drained", "Meat & fish", 208, 24.6, 0, 0, 0, 11.5, 1.5, 307, "1 can:92", {"ca": 382, "d": 4.8, "b12": 8.9}),
    ("chicken-nuggets", "Chicken nuggets", "Meat & fish", 296, 15.3, 15.6, 0.2, 0.9, 19.1, 3.1, 594, "6 nuggets:96|4 nuggets:64", {}),
    # --- Plant protein & legumes
    ("tofu", "Tofu, firm", "Legumes & plant protein", 144, 17.3, 2.8, 0.6, 2.3, 8.7, 1.3, 14, "1/2 block:200|1 cup:250|1 slice:85", {"ca": 683, "fe": 2.7}),
    ("tempeh", "Tempeh", "Legumes & plant protein", 192, 20.3, 7.6, 0, 0, 10.8, 2.2, 9, "1 cup:166", {"fe": 2.7}),
    ("lentils", "Lentils, cooked", "Legumes & plant protein", 116, 9.0, 20.1, 1.8, 7.9, 0.4, 0.1, 2, "1 cup:198|1/2 cup:99", {"k": 369, "fe": 3.3}),
    ("chickpeas", "Chickpeas, cooked", "Legumes & plant protein", 164, 8.9, 27.4, 4.8, 7.6, 2.6, 0.3, 7, "1 cup:164|1 can drained:240", {"k": 291, "fe": 2.9}),
    ("black-beans", "Black beans, cooked", "Legumes & plant protein", 132, 8.9, 23.7, 0.3, 8.7, 0.5, 0.1, 1, "1 cup:172", {"k": 355, "fe": 2.1}),
    ("kidney-beans", "Kidney beans, cooked", "Legumes & plant protein", 127, 8.7, 22.8, 0.3, 6.4, 0.5, 0.1, 2, "1 cup:177", {"k": 405, "fe": 2.9}),
    ("baked-beans", "Baked beans, canned", "Legumes & plant protein", 94, 4.8, 21.1, 7.9, 4.1, 0.4, 0.1, 343, "1/2 can:207|1 cup:254", {}),
    ("edamame", "Edamame, shelled", "Legumes & plant protein", 121, 11.9, 8.9, 2.2, 5.2, 5.2, 0.6, 6, "1 cup:155", {"fe": 2.3}),
    ("hummus", "Hummus", "Legumes & plant protein", 166, 7.9, 14.3, 0.3, 6.0, 9.6, 1.4, 379, "2 tbsp:30|1/4 cup:62", {}),
    # --- Grains, bread & cereal
    ("rice-white", "White rice, cooked", "Grains & bread", 130, 2.7, 28.2, 0.1, 0.4, 0.3, 0.1, 1, "1 cup:158|1/2 cup:79", {}),
    ("rice-brown", "Brown rice, cooked", "Grains & bread", 123, 2.7, 25.6, 0.2, 1.6, 1.0, 0.3, 4, "1 cup:195", {"mg": 39}),
    ("pasta", "Pasta, cooked", "Grains & bread", 158, 5.8, 30.9, 0.6, 1.8, 0.9, 0.2, 1, "1 cup:140|1 plate:250", {}),
    ("pasta-wholewheat", "Wholewheat pasta, cooked", "Grains & bread", 124, 5.3, 26.5, 0.6, 4.5, 0.5, 0.1, 3, "1 cup:140", {}),
    ("quinoa", "Quinoa, cooked", "Grains & bread", 120, 4.4, 21.3, 0.9, 2.8, 1.9, 0.2, 7, "1 cup:185", {"fe": 1.5, "mg": 64}),
    ("couscous", "Couscous, cooked", "Grains & bread", 112, 3.8, 23.2, 0.1, 1.4, 0.2, 0, 5, "1 cup:157", {}),
    ("egg-noodles", "Egg noodles, cooked", "Grains & bread", 138, 4.5, 25.2, 0.4, 1.2, 2.1, 0.4, 5, "1 cup:160", {}),
    ("rice-noodles", "Rice noodles, cooked", "Grains & bread", 108, 1.8, 24.0, 0, 1.0, 0.2, 0, 19, "1 cup:176", {}),
    ("oats", "Rolled oats, dry", "Grains & bread", 379, 13.2, 67.7, 1.0, 10.1, 6.5, 1.1, 6, "1/2 cup:40|1/3 cup:27", {"fe": 4.3, "mg": 138}),
    ("oatmeal", "Oatmeal / porridge, made with water", "Grains & bread", 71, 2.5, 12.0, 0.3, 1.7, 1.5, 0.3, 4, "1 cup:234|1 bowl:250", {}),
    ("bread-white", "White bread", "Grains & bread", 266, 8.9, 49.2, 5.7, 2.7, 3.3, 0.7, 477, "1 slice:28", {"fe": 3.6}),
    ("bread-wholemeal", "Wholemeal bread", "Grains & bread", 252, 12.4, 42.7, 4.4, 6.0, 3.5, 0.7, 450, "1 slice:32", {"fe": 2.5}),
    ("bread-sourdough", "Sourdough bread", "Grains & bread", 272, 10.7, 51.9, 2.5, 2.2, 2.4, 0.5, 602, "1 slice:50", {}),
    ("bagel", "Bagel, plain", "Grains & bread", 250, 10.1, 48.9, 6.1, 2.1, 1.5, 0.2, 439, "1 bagel:105", {}),
    ("english-muffin", "English muffin", "Grains & bread", 235, 8.9, 46.0, 3.5, 3.5, 1.8, 0.3, 425, "1 muffin:57", {}),
    ("pita", "Pita bread, white", "Grains & bread", 275, 9.1, 55.7, 1.3, 2.2, 1.2, 0.2, 536, "1 pita:60", {}),
    ("naan", "Naan bread", "Grains & bread", 291, 9.6, 50.4, 3.2, 2.2, 5.7, 1.4, 465, "1 naan:90", {}),
    ("tortilla-flour", "Tortilla / wrap, flour", "Grains & bread", 306, 8.2, 50.0, 3.6, 3.5, 8.0, 2.3, 717, "1 medium:45|1 large wrap:64", {}),
    ("tortilla-corn", "Tortilla, corn", "Grains & bread", 218, 5.7, 44.6, 0.9, 6.3, 2.9, 0.4, 45, "1 tortilla:26", {}),
    ("burger-bun", "Hamburger bun", "Grains & bread", 279, 9.5, 49.4, 6.6, 2.0, 4.3, 1.0, 479, "1 bun:52", {}),
    ("croissant", "Croissant, butter", "Grains & bread", 406, 8.2, 45.8, 11.3, 2.6, 21.0, 11.7, 467, "1 croissant:57", {}),
    ("cornflakes", "Cornflakes", "Grains & bread", 357, 7.5, 84.1, 9.5, 3.3, 0.4, 0.1, 729, "1 cup:28|1 bowl:30", {"fe": 28.9}),
    ("granola", "Granola", "Grains & bread", 450, 10.0, 64.0, 20.0, 6.6, 17.0, 3.0, 40, "1/2 cup:55|1 serve:45", {}),
    ("muesli", "Muesli", "Grains & bread", 363, 9.7, 66.0, 24.0, 7.3, 5.9, 0.8, 200, "1/2 cup:45", {}),
    ("crackers", "Crackers, saltine", "Grains & bread", 418, 9.5, 74.0, 1.3, 2.8, 8.9, 2.0, 800, "5 crackers:15", {}),
    ("rice-cakes", "Rice cakes", "Grains & bread", 387, 8.2, 81.5, 0.9, 4.2, 2.8, 0.6, 29, "1 cake:9", {}),
    ("popcorn", "Popcorn, air-popped", "Grains & bread", 387, 12.9, 77.8, 0.9, 14.5, 4.5, 0.6, 8, "1 cup:8|1 bag:30", {}),
    # --- Vegetables
    ("broccoli", "Broccoli, raw", "Vegetables", 34, 2.8, 6.6, 1.7, 2.6, 0.4, 0, 33, "1 cup chopped:91", {"k": 316, "ca": 47, "c": 89}),
    ("broccoli-cooked", "Broccoli, cooked", "Vegetables", 35, 2.4, 7.2, 1.4, 3.3, 0.4, 0.1, 41, "1 cup:156", {"c": 65}),
    ("spinach", "Spinach, raw", "Vegetables", 23, 2.9, 3.6, 0.4, 2.2, 0.4, 0.1, 79, "1 cup:30|1 handful:30", {"k": 558, "ca": 99, "fe": 2.7, "c": 28, "mg": 79}),
    ("kale", "Kale, raw", "Vegetables", 35, 2.9, 4.4, 1.0, 4.1, 1.5, 0.2, 53, "1 cup chopped:21", {"c": 93, "ca": 254}),
    ("lettuce-romaine", "Lettuce, romaine", "Vegetables", 17, 1.2, 3.3, 1.2, 2.1, 0.3, 0, 8, "1 cup shredded:47", {}),
    ("lettuce-iceberg", "Lettuce, iceberg", "Vegetables", 14, 0.9, 3.0, 2.0, 1.2, 0.1, 0, 10, "1 cup shredded:72", {}),
    ("tomato", "Tomato", "Vegetables", 18, 0.9, 3.9, 2.6, 1.2, 0.2, 0, 5, "1 medium:123|1 cherry tomato:17", {"k": 237, "c": 13.7}),
    ("cucumber", "Cucumber", "Vegetables", 15, 0.7, 3.6, 1.7, 0.5, 0.1, 0, 2, "1/2 cucumber:150|1 cup sliced:104", {}),
    ("carrot", "Carrot", "Vegetables", 41, 0.9, 9.6, 4.7, 2.8, 0.2, 0, 69, "1 medium:61|1 cup chopped:128", {"k": 320}),
    ("capsicum-red", "Bell pepper / capsicum, red", "Vegetables", 31, 1.0, 6.0, 4.2, 2.1, 0.3, 0, 4, "1 medium:119", {"c": 128}),
    ("onion", "Onion", "Vegetables", 40, 1.1, 9.3, 4.2, 1.7, 0.1, 0, 4, "1 medium:110", {}),
    ("garlic", "Garlic", "Vegetables", 149, 6.4, 33.1, 1.0, 2.1, 0.5, 0.1, 17, "1 clove:3", {}),
    ("potato-baked", "Potato, baked, with skin", "Vegetables", 93, 2.5, 21.2, 1.2, 2.2, 0.1, 0, 10, "1 medium:173", {"k": 535, "c": 9.6}),
    ("potato-boiled", "Potato, boiled", "Vegetables", 87, 1.9, 20.1, 0.9, 1.8, 0.1, 0, 4, "1 medium:136", {"k": 379}),
    ("mashed-potato", "Mashed potato (milk & butter)", "Vegetables", 113, 1.9, 16.8, 1.4, 1.5, 4.2, 1.0, 333, "1 cup:210", {}),
    ("sweet-potato", "Sweet potato, baked", "Vegetables", 90, 2.0, 20.7, 6.5, 3.3, 0.2, 0, 36, "1 medium:114", {"k": 475, "c": 19.6}),
    ("fries", "French fries", "Vegetables", 312, 3.4, 41.4, 0.3, 3.8, 14.7, 2.3, 210, "small:71|medium:117|large:154", {}),
    ("corn", "Sweet corn, cooked", "Vegetables", 96, 3.4, 21.0, 4.5, 2.4, 1.5, 0.2, 1, "1 cob (kernels):77|1 cup:149", {}),
    ("peas", "Green peas, cooked", "Vegetables", 84, 5.4, 15.6, 5.9, 5.5, 0.2, 0, 3, "1 cup:160", {"c": 14}),
    ("green-beans", "Green beans, cooked", "Vegetables", 35, 1.9, 7.9, 3.6, 3.2, 0.3, 0.1, 1, "1 cup:125", {}),
    ("mushrooms", "Mushrooms, white", "Vegetables", 22, 3.1, 3.3, 2.0, 1.0, 0.3, 0, 5, "1 cup sliced:70", {"k": 318}),
    ("zucchini", "Zucchini / courgette", "Vegetables", 17, 1.2, 3.1, 2.5, 1.0, 0.3, 0.1, 8, "1 medium:196", {}),
    ("cauliflower", "Cauliflower", "Vegetables", 25, 1.9, 5.0, 1.9, 2.0, 0.3, 0.1, 30, "1 cup chopped:107", {"c": 48}),
    ("cabbage", "Cabbage", "Vegetables", 25, 1.3, 5.8, 3.2, 2.5, 0.1, 0, 18, "1 cup shredded:89", {"c": 36.6}),
    ("avocado", "Avocado", "Vegetables", 160, 2.0, 8.5, 0.7, 6.7, 14.7, 2.1, 7, "1 whole:136|1/2 avocado:68", {"k": 485}),
    ("butternut", "Butternut squash / pumpkin, baked", "Vegetables", 40, 0.9, 10.5, 2.0, 3.2, 0.1, 0, 4, "1 cup cubed:205", {"c": 15}),
    ("asparagus", "Asparagus", "Vegetables", 20, 2.2, 3.9, 1.9, 2.1, 0.1, 0, 2, "6 spears:96", {}),
    ("celery", "Celery", "Vegetables", 14, 0.7, 3.0, 1.3, 1.6, 0.2, 0, 80, "1 stalk:40", {}),
    ("beetroot", "Beetroot, cooked", "Vegetables", 44, 1.7, 10.0, 8.0, 2.0, 0.2, 0, 77, "1 beet:50", {}),
    ("eggplant", "Eggplant / aubergine, cooked", "Vegetables", 35, 0.8, 8.7, 3.2, 2.5, 0.2, 0, 1, "1 cup:99", {}),
    ("mixed-veg", "Mixed vegetables, frozen, cooked", "Vegetables", 60, 2.9, 13.1, 3.1, 4.4, 0.2, 0, 35, "1 cup:182", {}),
    # --- Fruit
    ("apple", "Apple", "Fruit", 52, 0.3, 13.8, 10.4, 2.4, 0.2, 0, 1, "1 medium:182|1 small:149", {"k": 107, "c": 4.6}),
    ("banana", "Banana", "Fruit", 89, 1.1, 22.8, 12.2, 2.6, 0.3, 0.1, 1, "1 medium:118|1 large:136|1 small:101", {"k": 358, "c": 8.7, "mg": 27}),
    ("orange", "Orange", "Fruit", 47, 0.9, 11.8, 9.4, 2.4, 0.1, 0, 0, "1 medium:131", {"c": 53.2, "k": 181}),
    ("mandarin", "Mandarin", "Fruit", 53, 0.8, 13.3, 10.6, 1.8, 0.3, 0, 2, "1 fruit:88", {"c": 26.7}),
    ("strawberries", "Strawberries", "Fruit", 32, 0.7, 7.7, 4.9, 2.0, 0.3, 0, 1, "1 cup:152|1 berry:12", {"c": 58.8}),
    ("blueberries", "Blueberries", "Fruit", 57, 0.7, 14.5, 10.0, 2.4, 0.3, 0, 1, "1 cup:148|1 handful:50", {"c": 9.7}),
    ("raspberries", "Raspberries", "Fruit", 52, 1.2, 11.9, 4.4, 6.5, 0.7, 0, 1, "1 cup:123", {"c": 26.2}),
    ("grapes", "Grapes", "Fruit", 69, 0.7, 18.1, 15.5, 0.9, 0.2, 0.1, 2, "1 cup:151", {}),
    ("watermelon", "Watermelon", "Fruit", 30, 0.6, 7.6, 6.2, 0.4, 0.2, 0, 1, "1 cup diced:152|1 wedge:286", {}),
    ("pineapple", "Pineapple", "Fruit", 50, 0.5, 13.1, 9.9, 1.4, 0.1, 0, 1, "1 cup:165", {"c": 47.8}),
    ("mango", "Mango", "Fruit", 60, 0.8, 15.0, 13.7, 1.6, 0.4, 0.1, 1, "1 cup:165|1 mango:336", {"c": 36.4}),
    ("pear", "Pear", "Fruit", 57, 0.4, 15.2, 9.8, 3.1, 0.1, 0, 1, "1 medium:178", {}),
    ("peach", "Peach", "Fruit", 39, 0.9, 9.5, 8.4, 1.5, 0.3, 0, 0, "1 medium:150", {}),
    ("kiwi", "Kiwifruit", "Fruit", 61, 1.1, 14.7, 9.0, 3.0, 0.5, 0, 3, "1 kiwi:69", {"c": 92.7}),
    ("cherries", "Cherries", "Fruit", 63, 1.1, 16.0, 12.8, 2.1, 0.2, 0, 0, "1 cup:138", {}),
    ("grapefruit", "Grapefruit", "Fruit", 42, 0.8, 10.7, 6.9, 1.6, 0.1, 0, 0, "1/2 fruit:123", {"c": 31.2}),
    ("dates", "Dates, medjool", "Fruit", 277, 1.8, 75.0, 66.5, 6.7, 0.2, 0, 1, "1 date:24", {"k": 696}),
    ("raisins", "Raisins", "Fruit", 299, 3.1, 79.2, 59.2, 3.7, 0.5, 0.1, 11, "1 small box:28|1 tbsp:9", {}),
    # --- Nuts, seeds & fats
    ("almonds", "Almonds", "Nuts, seeds & fats", 579, 21.2, 21.6, 4.4, 12.5, 49.9, 3.8, 1, "1 handful (23):28", {"ca": 269, "mg": 270}),
    ("peanuts", "Peanuts, dry roasted", "Nuts, seeds & fats", 585, 23.7, 21.5, 4.9, 8.0, 49.7, 6.9, 6, "1 handful:28", {"mg": 176}),
    ("peanut-butter", "Peanut butter", "Nuts, seeds & fats", 588, 25.0, 20.0, 9.2, 6.0, 50.0, 10.3, 430, "1 tbsp:16|2 tbsp:32", {"mg": 168}),
    ("almond-butter", "Almond butter", "Nuts, seeds & fats", 614, 21.0, 18.8, 4.4, 10.3, 55.5, 4.2, 7, "1 tbsp:16", {"ca": 347}),
    ("walnuts", "Walnuts", "Nuts, seeds & fats", 654, 15.2, 13.7, 2.6, 6.7, 65.2, 6.1, 2, "1 handful (7 halves):28", {"mg": 158}),
    ("cashews", "Cashews", "Nuts, seeds & fats", 553, 18.2, 30.2, 5.9, 3.3, 43.9, 7.8, 12, "1 handful:28", {"mg": 292, "fe": 6.7}),
    ("mixed-nuts", "Mixed nuts, unsalted", "Nuts, seeds & fats", 607, 20.0, 21.0, 4.2, 7.0, 54.0, 8.5, 3, "1 handful:28", {}),
    ("chia", "Chia seeds", "Nuts, seeds & fats", 486, 16.5, 42.1, 0, 34.4, 30.7, 3.3, 16, "1 tbsp:12", {"ca": 631}),
    ("flaxseed", "Flaxseed, ground", "Nuts, seeds & fats", 534, 18.3, 28.9, 1.6, 27.3, 42.2, 3.7, 30, "1 tbsp:7", {}),
    ("sunflower-seeds", "Sunflower seeds", "Nuts, seeds & fats", 584, 20.8, 20.0, 2.6, 8.6, 51.5, 4.5, 9, "1 tbsp:9|1/4 cup:35", {}),
    ("pumpkin-seeds", "Pumpkin seeds (pepitas)", "Nuts, seeds & fats", 559, 30.2, 10.7, 1.4, 6.0, 49.1, 8.7, 7, "1 tbsp:9|1/4 cup:32", {"mg": 592, "fe": 8.8}),
    ("olive-oil", "Olive oil", "Nuts, seeds & fats", 884, 0, 0, 0, 0, 100, 13.8, 2, "1 tbsp:13.5|1 tsp:4.5", {}),
    ("canola-oil", "Vegetable / canola oil", "Nuts, seeds & fats", 884, 0, 0, 0, 0, 100, 7.4, 0, "1 tbsp:14|1 tsp:4.5", {}),
    ("coconut-oil", "Coconut oil", "Nuts, seeds & fats", 892, 0, 0, 0, 0, 99.1, 82.5, 0, "1 tbsp:13.6", {}),
    ("mayonnaise", "Mayonnaise", "Nuts, seeds & fats", 680, 1.0, 0.6, 0.6, 0, 74.9, 11.7, 635, "1 tbsp:14", {}),
    # --- Snacks & sweets
    ("dark-chocolate", "Dark chocolate (70–85%)", "Snacks & sweets", 598, 7.8, 45.9, 24.0, 10.9, 42.6, 24.5, 20, "1 square:10|1/4 bar:25", {"fe": 11.9, "mg": 228}),
    ("milk-chocolate", "Milk chocolate", "Snacks & sweets", 535, 7.7, 59.4, 51.5, 3.4, 29.7, 18.5, 79, "1 bar:43|1 square:7", {"ca": 189}),
    ("chips", "Potato chips / crisps", "Snacks & sweets", 536, 7.0, 53.0, 0.4, 4.4, 34.6, 3.1, 525, "1 small bag:28|1 share bag:150", {}),
    ("tortilla-chips", "Tortilla chips", "Snacks & sweets", 489, 7.0, 63.0, 1.0, 5.3, 23.4, 3.0, 420, "1 serve (12 chips):28", {}),
    ("pretzels", "Pretzels, hard, salted", "Snacks & sweets", 380, 10.3, 79.8, 2.8, 2.9, 2.8, 0.6, 1240, "1 serve:28", {}),
    ("cookie", "Chocolate chip cookie", "Snacks & sweets", 488, 5.4, 64.3, 33.5, 2.4, 24.0, 7.8, 343, "1 cookie:30|1 small cookie:16", {}),
    ("donut", "Doughnut, glazed", "Snacks & sweets", 403, 5.7, 50.0, 21.0, 1.4, 20.7, 5.3, 320, "1 doughnut:60", {}),
    ("muffin", "Blueberry muffin", "Snacks & sweets", 377, 4.4, 54.0, 27.0, 1.4, 16.0, 3.4, 349, "1 muffin:113", {}),
    ("protein-bar", "Protein bar", "Snacks & sweets", 360, 31.0, 38.0, 6.0, 12.0, 12.0, 5.0, 250, "1 bar:60", {}),
    ("granola-bar", "Granola / muesli bar", "Snacks & sweets", 433, 7.0, 69.0, 29.0, 4.3, 15.0, 2.5, 294, "1 bar:24|1 large bar:40", {}),
    ("honey", "Honey", "Snacks & sweets", 304, 0.3, 82.4, 82.1, 0.2, 0, 0, 4, "1 tbsp:21|1 tsp:7", {}),
    ("sugar", "Sugar, white", "Snacks & sweets", 387, 0, 100, 100, 0, 0, 0, 1, "1 tsp:4.2|1 tbsp:12.5", {}),
    ("jam", "Jam", "Snacks & sweets", 278, 0.4, 68.9, 48.5, 1.1, 0.1, 0, 32, "1 tbsp:20", {}),
    ("maple-syrup", "Maple syrup", "Snacks & sweets", 260, 0, 67.0, 60.5, 0, 0.1, 0, 12, "1 tbsp:20", {}),
    # --- Meals & fast food
    ("pizza", "Pizza, cheese", "Meals & fast food", 266, 11.4, 33.3, 3.6, 2.3, 9.7, 4.5, 598, "1 slice:107|1 small slice:70", {"ca": 188}),
    ("hamburger", "Hamburger, single patty", "Meals & fast food", 254, 13.0, 29.0, 5.5, 1.3, 9.5, 3.5, 480, "1 burger:110", {}),
    ("sushi", "Sushi rolls (mixed)", "Meals & fast food", 140, 5.0, 24.0, 4.0, 1.0, 2.5, 0.5, 420, "6 pieces:165|1 piece:28", {}),
    ("fried-rice", "Fried rice", "Meals & fast food", 174, 6.3, 31.0, 0.4, 1.2, 4.2, 0.7, 396, "1 cup:137|1 takeaway box:400", {}),
    ("spag-bol", "Spaghetti bolognese", "Meals & fast food", 130, 6.9, 16.0, 2.5, 1.5, 4.3, 1.6, 330, "1 cup:248|1 plate:350", {}),
    ("veg-soup", "Vegetable soup", "Meals & fast food", 30, 1.2, 4.6, 2.0, 1.0, 0.8, 0.1, 250, "1 bowl:250", {}),
    ("pasta-sauce", "Tomato pasta sauce (marinara)", "Meals & fast food", 51, 1.4, 8.1, 5.6, 1.9, 1.5, 0.2, 437, "1/2 cup:125", {}),
    ("guacamole", "Guacamole", "Meals & fast food", 150, 1.9, 8.5, 0.7, 6.0, 13.0, 1.9, 250, "2 tbsp:30", {}),
    # --- Drinks
    ("coffee", "Coffee, black", "Drinks", 1, 0.1, 0, 0, 0, 0, 0, 2, "1 cup:240|1 mug:350", {"caf": 40, "k": 49}),
    ("espresso", "Espresso", "Drinks", 9, 0.1, 1.7, 0, 0, 0.2, 0.1, 14, "1 shot:30|double shot:60", {"caf": 212}),
    ("latte", "Latte / flat white / cappuccino (whole milk)", "Drinks", 54, 2.9, 4.3, 4.3, 0, 2.8, 1.6, 40, "flat white:220|small:240|regular:350|large:470", {"caf": 30, "ca": 100}),
    ("latte-oat", "Latte / flat white (oat milk)", "Drinks", 48, 1.0, 6.4, 3.4, 0.7, 2.0, 0.2, 38, "flat white:220|regular:350", {"caf": 30}),
    ("tea", "Tea, black, unsweetened", "Drinks", 1, 0, 0.3, 0, 0, 0, 0, 3, "1 cup:240", {"caf": 20}),
    ("cola", "Cola", "Drinks", 41, 0, 10.4, 10.0, 0, 0, 0, 4, "1 can:355|1 bottle:600|1 glass:250", {"caf": 10}),
    ("cola-diet", "Cola, diet / zero sugar", "Drinks", 1, 0, 0.1, 0, 0, 0, 0, 12, "1 can:355|1 bottle:600", {"caf": 12}),
    ("orange-juice", "Orange juice", "Drinks", 45, 0.7, 10.4, 8.4, 0.2, 0.2, 0, 1, "1 glass:250|1 cup:248", {"c": 50, "k": 200}),
    ("apple-juice", "Apple juice", "Drinks", 46, 0.1, 11.3, 9.6, 0.2, 0.1, 0, 4, "1 glass:250", {}),
    ("almond-milk", "Almond milk, unsweetened", "Drinks", 15, 0.6, 0.6, 0, 0.2, 1.1, 0.1, 72, "1 cup:240|splash:30", {"ca": 184}),
    ("oat-milk", "Oat milk", "Drinks", 46, 1.0, 6.6, 4.0, 0.8, 1.5, 0.2, 40, "1 cup:240|splash:30", {"ca": 120}),
    ("soy-milk", "Soy milk, unsweetened", "Drinks", 33, 3.3, 1.8, 1.0, 0.5, 1.8, 0.2, 37, "1 cup:243|splash:30", {"ca": 123}),
    ("beer", "Beer, regular", "Drinks", 43, 0.5, 3.6, 0, 0, 0, 0, 4, "1 can/bottle:355|1 pint:568|1 schooner:425", {"alc": 3.9}),
    ("wine-red", "Wine, red", "Drinks", 85, 0.1, 2.6, 0.6, 0, 0, 0, 4, "1 glass:150|1 small glass:100", {"alc": 10.6}),
    ("wine-white", "Wine, white", "Drinks", 82, 0.1, 2.6, 1.0, 0, 0, 0, 5, "1 glass:150|1 small glass:100", {"alc": 10.3}),
    ("spirits", "Spirits (vodka, gin, whisky; 40%)", "Drinks", 231, 0, 0, 0, 0, 0, 0, 1, "1 shot:30|1 US shot:44", {"alc": 33.4}),
    # --- Condiments & sauces
    ("ketchup", "Ketchup", "Condiments", 101, 1.0, 27.4, 22.8, 0.3, 0.1, 0, 907, "1 tbsp:17|1 sachet:10", {}),
    ("soy-sauce", "Soy sauce", "Condiments", 53, 8.1, 4.9, 0.4, 0.8, 0.6, 0.1, 5493, "1 tbsp:16|1 tsp:5", {}),
    ("mustard", "Mustard", "Condiments", 60, 3.7, 5.8, 0.9, 4.0, 3.3, 0.2, 1104, "1 tsp:5", {}),
    ("bbq-sauce", "BBQ sauce", "Condiments", 172, 0.8, 40.8, 33.2, 0.9, 0.6, 0.1, 1027, "1 tbsp:17", {}),
    ("salsa", "Salsa", "Condiments", 36, 1.5, 6.6, 4.0, 1.9, 0.2, 0, 711, "2 tbsp:32", {}),
    ("pesto", "Basil pesto", "Condiments", 400, 5.0, 6.0, 1.0, 1.5, 40.0, 6.5, 1000, "1 tbsp:16", {}),
]
# fmt: on


def _servings(spec: str, slug: str) -> list[dict]:
    out = []
    for i, part in enumerate(p for p in spec.split("|") if p):
        label, _, grams = part.rpartition(":")
        out.append({"id": f"s{i + 1}", "label": label.strip(), "grams": float(grams)})
    return out


# Grams per ml for foods people measure by the cup / spoon (drinks are per
# 100 ml already). Lets "1 tbsp olive oil" or "1 cup milk" work.
DENSITY = {
    "olive-oil": 0.91,
    "canola-oil": 0.92,
    "coconut-oil": 0.92,
    "honey": 1.42,
    "maple-syrup": 1.32,
    "milk-whole": 1.03,
    "milk-2": 1.03,
    "milk-skim": 1.03,
    "cream-heavy": 0.99,
    "soy-sauce": 1.15,
}


@lru_cache(maxsize=1)
def builtin_foods() -> dict[str, dict]:
    """``{"b:<slug>": food}`` in the same shape as a library food."""
    out: dict[str, dict] = {}
    for row in _ROWS:
        slug, name, cat, kcal, p, c, sug, fib, fat, sat, na, servings, micros = row
        ref = f"b:{slug}"
        out[ref] = {
            "id": ref,
            "name": name,
            "brand": "",
            "category": cat,
            "servings": _servings(servings, slug),
            "default_serving": "s1" if servings else None,
            "per100": {
                "kcal": float(kcal),
                "protein": float(p),
                "carbs": float(c),
                "sugar": float(sug),
                "fibre": float(fib),
                "fat": float(fat),
                "sat_fat": float(sat),
                "sodium": float(na),
                "micros": {_MICRO[k]: float(v) for k, v in micros.items()},
            },
            "liquid": cat == "Drinks",
            "source": "builtin",
        }
        if slug in DENSITY:
            out[ref]["density"] = DENSITY[slug]
    return out


def categories() -> list[str]:
    seen: list[str] = []
    for row in _ROWS:
        if row[2] not in seen:
            seen.append(row[2])
    return seen
