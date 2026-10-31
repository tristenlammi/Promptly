"""The built-in exercise library (kept in code; a file stores only the
person's custom exercises).

Each entry: id, name, equipment (``"+"`` = all needed, ``"|"`` = any one
of), movement pattern, logging type, primary / secondary muscles, whether
it's a compound lift, a conservative ``start`` ratio and search aliases.

``start`` is a novice's working load for ~10 reps (~3 short of failure) as a fraction of
bodyweight (per hand for dumbbells / kettlebells). It's only used to propose
a *calibration* load when someone has no history for a lift — the logger and
the coach then correct it from what they actually do.

Weekly-volume landmarks per muscle are Mike Israetel / Renaissance
Periodization's population guidelines (hard sets per week): MV (maintain),
MEV (minimum effective), MAV (most adaptive range) and MRV (maximum
recoverable). They're starting points — individuals vary a lot.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any

MUSCLES: dict[str, dict[str, Any]] = {
    #               label            MV MEV MAVlo MAVhi MRV   group
    "chest": {"label": "Chest", "mv": 4, "mev": 8, "mav": (12, 20), "mrv": 22, "group": "push"},
    "front_delts": {"label": "Front delts", "mv": 0, "mev": 0, "mav": (6, 8), "mrv": 12, "group": "push"},
    "side_delts": {"label": "Side delts", "mv": 0, "mev": 8, "mav": (16, 22), "mrv": 26, "group": "push"},
    "rear_delts": {"label": "Rear delts", "mv": 0, "mev": 8, "mav": (16, 22), "mrv": 26, "group": "pull"},
    "triceps": {"label": "Triceps", "mv": 4, "mev": 6, "mav": (10, 14), "mrv": 18, "group": "push"},
    "biceps": {"label": "Biceps", "mv": 5, "mev": 8, "mav": (14, 20), "mrv": 26, "group": "pull"},
    "forearms": {"label": "Forearms", "mv": 0, "mev": 2, "mav": (6, 12), "mrv": 20, "group": "pull"},
    "lats": {"label": "Lats", "mv": 6, "mev": 10, "mav": (14, 22), "mrv": 25, "group": "pull"},
    "upper_back": {"label": "Upper back", "mv": 6, "mev": 10, "mav": (14, 22), "mrv": 25, "group": "pull"},
    "traps": {"label": "Traps", "mv": 0, "mev": 0, "mav": (12, 20), "mrv": 26, "group": "pull"},
    "lower_back": {"label": "Lower back", "mv": 0, "mev": 0, "mav": (4, 8), "mrv": 12, "group": "legs"},
    "abs": {"label": "Abs", "mv": 0, "mev": 0, "mav": (16, 20), "mrv": 25, "group": "core"},
    "obliques": {"label": "Obliques", "mv": 0, "mev": 0, "mav": (6, 12), "mrv": 16, "group": "core"},
    "glutes": {"label": "Glutes", "mv": 0, "mev": 0, "mav": (4, 12), "mrv": 16, "group": "legs"},
    "quads": {"label": "Quads", "mv": 6, "mev": 8, "mav": (12, 18), "mrv": 20, "group": "legs"},
    "hamstrings": {"label": "Hamstrings", "mv": 4, "mev": 6, "mav": (10, 16), "mrv": 20, "group": "legs"},
    "adductors": {"label": "Adductors", "mv": 0, "mev": 0, "mav": (4, 10), "mrv": 14, "group": "legs"},
    "abductors": {"label": "Abductors", "mv": 0, "mev": 0, "mav": (4, 10), "mrv": 14, "group": "legs"},
    "calves": {"label": "Calves", "mv": 6, "mev": 8, "mav": (12, 16), "mrv": 20, "group": "legs"},
}

EQUIPMENT: dict[str, str] = {
    "full_gym": "Full gym (everything)",
    "barbell": "Barbell + plates",
    "rack": "Squat rack",
    "bench": "Bench",
    "dumbbell": "Dumbbells",
    "kettlebell": "Kettlebells",
    "cable": "Cable stack",
    "machine": "Machines",
    "smith": "Smith machine",
    "ez_bar": "EZ bar",
    "trap_bar": "Trap bar",
    "pullup_bar": "Pull-up bar",
    "dip_station": "Dip bars",
    "band": "Resistance bands",
    "rings": "Rings / suspension trainer",
    "cardio": "Cardio machines",
    "sled": "Sled",
    "bodyweight": "Bodyweight",
}

PATTERNS: dict[str, str] = {
    "squat": "Squat",
    "hinge": "Hinge",
    "lunge": "Lunge / single-leg",
    "push_h": "Horizontal push",
    "push_v": "Vertical push",
    "pull_h": "Horizontal pull",
    "pull_v": "Vertical pull",
    "fly": "Chest fly",
    "raise": "Delt raise",
    "curl": "Elbow flexion (curl)",
    "extension": "Elbow extension",
    "knee_ext": "Knee extension",
    "knee_flex": "Knee flexion",
    "hip": "Hip isolation",
    "calf": "Calf",
    "shrug": "Shrug",
    "core": "Core",
    "carry": "Carry",
    "olympic": "Olympic / power",
    "plyo": "Plyometric",
    "cardio": "Cardio",
}

LOG_CODES = {"w": "weight_reps", "bw": "bodyweight_reps", "as": "assisted", "t": "duration", "d": "distance"}
COMPOUND_PATTERNS = {"squat", "hinge", "lunge", "push_h", "push_v", "pull_h", "pull_v", "carry", "olympic"}

# id, name, equipment, pattern, log, primary, secondary, start, aliases
_RAW: list[tuple] = [
    # ---- barbell
    ("back_squat", "Back Squat (Barbell)", "barbell+rack", "squat", "w", "quads,glutes", "adductors,lower_back", 0.6, "squat,high bar squat,low bar squat"),
    ("front_squat", "Front Squat (Barbell)", "barbell+rack", "squat", "w", "quads", "glutes,upper_back,abs", 0.45, ""),
    ("pause_squat", "Pause Squat (Barbell)", "barbell+rack", "squat", "w", "quads,glutes", "adductors,lower_back", 0.5, "paused squat"),
    ("box_squat", "Box Squat (Barbell)", "barbell+rack+bench", "squat", "w", "quads,glutes", "hamstrings,adductors", 0.5, ""),
    ("deadlift", "Deadlift (Barbell)", "barbell", "hinge", "w", "glutes,hamstrings,lower_back", "quads,traps,forearms,lats", 0.8, "conventional deadlift,dl"),
    ("sumo_deadlift", "Sumo Deadlift (Barbell)", "barbell", "hinge", "w", "glutes,quads,adductors", "hamstrings,lower_back,traps", 0.8, "sumo"),
    ("deficit_deadlift", "Deficit Deadlift (Barbell)", "barbell", "hinge", "w", "glutes,hamstrings,lower_back", "quads,traps,forearms", 0.7, ""),
    ("rack_pull", "Rack Pull (Barbell)", "barbell+rack", "hinge", "w", "upper_back,traps,glutes", "lower_back,hamstrings,forearms", 0.9, "block pull"),
    ("rdl", "Romanian Deadlift (Barbell)", "barbell", "hinge", "w", "hamstrings,glutes", "lower_back,forearms", 0.5, "rdl,romanian deadlift,stiff leg deadlift"),
    ("good_morning", "Good Morning (Barbell)", "barbell+rack", "hinge", "w", "hamstrings,lower_back", "glutes", 0.25, ""),
    ("hip_thrust", "Hip Thrust (Barbell)", "barbell+bench", "hip", "w", "glutes", "hamstrings", 0.6, "glute bridge barbell,hip thrusts"),
    ("trap_bar_deadlift", "Trap Bar Deadlift", "trap_bar", "hinge", "w", "quads,glutes,hamstrings", "traps,lower_back,forearms", 0.8, "hex bar deadlift"),
    ("bench_press", "Bench Press (Barbell)", "barbell+bench", "push_h", "w", "chest", "triceps,front_delts", 0.5, "bench,flat bench,bp"),
    ("pause_bench", "Paused Bench Press (Barbell)", "barbell+bench", "push_h", "w", "chest", "triceps,front_delts", 0.45, "pause bench"),
    ("incline_bench", "Incline Bench Press (Barbell)", "barbell+bench", "push_h", "w", "chest", "front_delts,triceps", 0.4, "incline bench,incline press"),
    ("close_grip_bench", "Close-Grip Bench Press (Barbell)", "barbell+bench", "push_h", "w", "triceps,chest", "front_delts", 0.4, "cgbp,close grip bench"),
    ("ohp", "Overhead Press (Barbell)", "barbell", "push_v", "w", "front_delts", "triceps,side_delts,upper_back", 0.3, "ohp,military press,shoulder press barbell,press"),
    ("push_press", "Push Press (Barbell)", "barbell", "push_v", "w", "front_delts,triceps", "side_delts,quads", 0.35, ""),
    ("landmine_press", "Landmine Press", "barbell", "push_v", "w", "front_delts,chest", "triceps", 0.15, ""),
    ("barbell_row", "Bent-Over Row (Barbell)", "barbell", "pull_h", "w", "upper_back,lats", "biceps,rear_delts,lower_back", 0.4, "barbell row,bent over row,bb row"),
    ("pendlay_row", "Pendlay Row (Barbell)", "barbell", "pull_h", "w", "upper_back,lats", "biceps,rear_delts,lower_back", 0.4, ""),
    ("t_bar_row", "T-Bar Row", "barbell|machine", "pull_h", "w", "upper_back,lats", "biceps,rear_delts", 0.35, "landmine row"),
    ("barbell_lunge", "Lunge (Barbell)", "barbell+rack", "lunge", "w", "quads,glutes", "adductors,hamstrings", 0.3, ""),
    ("barbell_curl", "Curl (Barbell)", "barbell", "curl", "w", "biceps", "forearms", 0.2, "bb curl,barbell curl"),
    ("ez_curl", "Curl (EZ Bar)", "ez_bar", "curl", "w", "biceps", "forearms", 0.2, "ez bar curl"),
    ("preacher_curl", "Preacher Curl (EZ Bar)", "ez_bar+bench", "curl", "w", "biceps", "forearms", 0.15, ""),
    ("reverse_curl", "Reverse Curl (EZ Bar)", "ez_bar|barbell", "curl", "w", "forearms", "biceps", 0.12, ""),
    ("skull_crusher", "Skull Crusher (EZ Bar)", "ez_bar+bench", "extension", "w", "triceps", "", 0.15, "lying triceps extension"),
    ("barbell_shrug", "Shrug (Barbell)", "barbell", "shrug", "w", "traps", "forearms", 0.6, "shrugs"),
    ("upright_row", "Upright Row (Barbell)", "barbell|ez_bar", "raise", "w", "side_delts,traps", "biceps", 0.2, ""),
    ("power_clean", "Power Clean", "barbell", "olympic", "w", "glutes,hamstrings,traps", "quads,upper_back,calves", 0.4, "clean"),
    ("hang_clean", "Hang Clean", "barbell", "olympic", "w", "glutes,hamstrings,traps", "quads,upper_back", 0.35, ""),
    # ---- dumbbell
    ("db_bench", "Bench Press (Dumbbell)", "dumbbell+bench", "push_h", "w", "chest", "triceps,front_delts", 0.2, "db bench,dumbbell bench"),
    ("db_incline_bench", "Incline Bench Press (Dumbbell)", "dumbbell+bench", "push_h", "w", "chest", "front_delts,triceps", 0.17, "incline db press,incline dumbbell press"),
    ("db_floor_press", "Floor Press (Dumbbell)", "dumbbell", "push_h", "w", "chest,triceps", "front_delts", 0.17, ""),
    ("db_fly", "Fly (Dumbbell)", "dumbbell+bench", "fly", "w", "chest", "front_delts", 0.06, "dumbbell flye,chest fly"),
    ("db_shoulder_press", "Shoulder Press (Dumbbell)", "dumbbell", "push_v", "w", "front_delts", "triceps,side_delts", 0.15, "db press,seated dumbbell press"),
    ("arnold_press", "Arnold Press (Dumbbell)", "dumbbell", "push_v", "w", "front_delts,side_delts", "triceps", 0.12, ""),
    ("db_lateral_raise", "Lateral Raise (Dumbbell)", "dumbbell", "raise", "w", "side_delts", "traps", 0.05, "side raise,lat raise,lateral raises"),
    ("db_rear_delt_fly", "Rear Delt Fly (Dumbbell)", "dumbbell", "raise", "w", "rear_delts", "upper_back", 0.04, "reverse fly,bent over raise"),
    ("db_front_raise", "Front Raise (Dumbbell)", "dumbbell", "raise", "w", "front_delts", "", 0.05, ""),
    ("db_row", "One-Arm Row (Dumbbell)", "dumbbell+bench", "pull_h", "w", "lats,upper_back", "biceps,rear_delts", 0.22, "db row,dumbbell row,single arm row"),
    ("chest_supported_row", "Chest-Supported Row (Dumbbell)", "dumbbell+bench", "pull_h", "w", "upper_back", "lats,rear_delts,biceps", 0.15, "incline row,seal row"),
    ("db_pullover", "Pullover (Dumbbell)", "dumbbell+bench", "pull_v", "w", "lats,chest", "triceps", 0.12, ""),
    ("db_curl", "Curl (Dumbbell)", "dumbbell", "curl", "w", "biceps", "forearms", 0.08, "bicep curl,dumbbell curl,db curl"),
    ("hammer_curl", "Hammer Curl (Dumbbell)", "dumbbell", "curl", "w", "biceps,forearms", "", 0.09, ""),
    ("incline_db_curl", "Incline Curl (Dumbbell)", "dumbbell+bench", "curl", "w", "biceps", "forearms", 0.06, ""),
    ("concentration_curl", "Concentration Curl (Dumbbell)", "dumbbell", "curl", "w", "biceps", "", 0.06, ""),
    ("db_overhead_ext", "Overhead Triceps Extension (Dumbbell)", "dumbbell", "extension", "w", "triceps", "", 0.12, "french press"),
    ("db_kickback", "Triceps Kickback (Dumbbell)", "dumbbell", "extension", "w", "triceps", "", 0.04, ""),
    ("db_wrist_curl", "Wrist Curl (Dumbbell)", "dumbbell", "curl", "w", "forearms", "", 0.06, ""),
    ("goblet_squat", "Goblet Squat", "dumbbell|kettlebell", "squat", "w", "quads,glutes", "adductors,abs", 0.25, "goblet"),
    ("db_rdl", "Romanian Deadlift (Dumbbell)", "dumbbell", "hinge", "w", "hamstrings,glutes", "lower_back,forearms", 0.2, "db rdl"),
    ("db_single_leg_rdl", "Single-Leg Romanian Deadlift (Dumbbell)", "dumbbell|kettlebell", "hinge", "w", "hamstrings,glutes", "lower_back", 0.12, "single leg rdl"),
    ("db_walking_lunge", "Walking Lunge (Dumbbell)", "dumbbell", "lunge", "w", "quads,glutes", "adductors,hamstrings", 0.12, "lunges,db lunge"),
    ("db_reverse_lunge", "Reverse Lunge (Dumbbell)", "dumbbell", "lunge", "w", "quads,glutes", "adductors,hamstrings", 0.12, ""),
    ("bulgarian_split_squat", "Bulgarian Split Squat (Dumbbell)", "dumbbell+bench", "lunge", "w", "quads,glutes", "adductors", 0.1, "bss,split squat,rear foot elevated split squat"),
    ("db_step_up", "Step-Up (Dumbbell)", "dumbbell+bench", "lunge", "w", "quads,glutes", "hamstrings", 0.1, "step ups"),
    ("db_shrug", "Shrug (Dumbbell)", "dumbbell", "shrug", "w", "traps", "forearms", 0.25, ""),
    ("db_calf_raise", "Calf Raise (Dumbbell)", "dumbbell", "calf", "w", "calves", "", 0.15, ""),
    ("db_hip_thrust", "Hip Thrust (Dumbbell)", "dumbbell+bench", "hip", "w", "glutes", "hamstrings", 0.25, ""),
    ("farmer_carry", "Farmer's Carry", "dumbbell|kettlebell|trap_bar", "carry", "d", "forearms,traps", "abs,glutes,upper_back", 0.3, "farmers walk"),
    ("suitcase_carry", "Suitcase Carry", "dumbbell|kettlebell", "carry", "d", "obliques,forearms", "abs,traps", 0.2, ""),
    # ---- kettlebell
    ("kb_swing", "Swing (Kettlebell)", "kettlebell|dumbbell", "hinge", "w", "glutes,hamstrings", "lower_back,abs", 0.2, "kettlebell swing,kb swing"),
    ("turkish_get_up", "Turkish Get-Up (Kettlebell)", "kettlebell|dumbbell", "core", "w", "front_delts,abs", "glutes,obliques,triceps", 0.1, "tgu,get up"),
    ("kb_press", "Overhead Press (Kettlebell)", "kettlebell", "push_v", "w", "front_delts", "triceps,side_delts", 0.12, ""),
    ("kb_clean", "Clean (Kettlebell)", "kettlebell", "olympic", "w", "glutes,hamstrings", "forearms,traps", 0.15, ""),
    ("kb_snatch", "Snatch (Kettlebell)", "kettlebell", "olympic", "w", "glutes,hamstrings,side_delts", "traps,forearms", 0.12, ""),
    # ---- cable
    ("lat_pulldown", "Lat Pulldown (Cable)", "cable|machine", "pull_v", "w", "lats", "biceps,upper_back,rear_delts", 0.5, "pulldown,lat pull down"),
    ("close_grip_pulldown", "Close-Grip Pulldown (Cable)", "cable|machine", "pull_v", "w", "lats", "biceps,upper_back", 0.5, "neutral grip pulldown,v bar pulldown"),
    ("seated_cable_row", "Seated Row (Cable)", "cable", "pull_h", "w", "upper_back,lats", "biceps,rear_delts", 0.45, "cable row,seated row,low row"),
    ("single_arm_cable_row", "Single-Arm Row (Cable)", "cable", "pull_h", "w", "lats,upper_back", "biceps,rear_delts", 0.2, ""),
    ("straight_arm_pulldown", "Straight-Arm Pulldown (Cable)", "cable", "pull_v", "w", "lats", "triceps", 0.15, "lat prayer"),
    ("cable_fly", "Fly (Cable)", "cable", "fly", "w", "chest", "front_delts", 0.1, "cable crossover,cable flye"),
    ("cable_lateral_raise", "Lateral Raise (Cable)", "cable", "raise", "w", "side_delts", "", 0.03, ""),
    ("cable_rear_delt_fly", "Rear Delt Fly (Cable)", "cable", "raise", "w", "rear_delts", "upper_back", 0.04, "reverse cable fly"),
    ("face_pull", "Face Pull (Cable)", "cable|band", "raise", "w", "rear_delts,upper_back", "traps", 0.12, "face pulls"),
    ("triceps_pushdown", "Triceps Pushdown (Cable)", "cable", "extension", "w", "triceps", "", 0.2, "pushdown,rope pushdown,tricep pushdown"),
    ("overhead_cable_ext", "Overhead Triceps Extension (Cable)", "cable", "extension", "w", "triceps", "", 0.15, ""),
    ("cable_curl", "Curl (Cable)", "cable", "curl", "w", "biceps", "forearms", 0.15, ""),
    ("bayesian_curl", "Bayesian Curl (Cable)", "cable", "curl", "w", "biceps", "", 0.06, ""),
    ("cable_crunch", "Crunch (Cable)", "cable", "core", "w", "abs", "", 0.3, "kneeling cable crunch"),
    ("pallof_press", "Pallof Press (Cable)", "cable|band", "core", "w", "obliques,abs", "", 0.08, "anti rotation press"),
    ("cable_woodchop", "Woodchop (Cable)", "cable|band", "core", "w", "obliques", "abs", 0.1, ""),
    ("cable_kickback", "Glute Kickback (Cable)", "cable", "hip", "w", "glutes", "hamstrings", 0.05, ""),
    ("cable_pull_through", "Pull-Through (Cable)", "cable", "hinge", "w", "glutes,hamstrings", "lower_back", 0.2, ""),
    # ---- machines
    ("leg_press", "Leg Press (Machine)", "machine", "squat", "w", "quads,glutes", "adductors", 1.2, "leg press"),
    ("hack_squat", "Hack Squat (Machine)", "machine", "squat", "w", "quads", "glutes,adductors", 0.6, ""),
    ("pendulum_squat", "Pendulum Squat (Machine)", "machine", "squat", "w", "quads", "glutes", 0.5, ""),
    ("smith_squat", "Squat (Smith Machine)", "smith", "squat", "w", "quads,glutes", "adductors", 0.5, ""),
    ("smith_incline_press", "Incline Press (Smith Machine)", "smith+bench", "push_h", "w", "chest", "front_delts,triceps", 0.35, ""),
    ("leg_extension", "Leg Extension (Machine)", "machine", "knee_ext", "w", "quads", "", 0.3, "quad extension"),
    ("seated_leg_curl", "Seated Leg Curl (Machine)", "machine", "knee_flex", "w", "hamstrings", "calves", 0.3, "leg curl"),
    ("lying_leg_curl", "Lying Leg Curl (Machine)", "machine", "knee_flex", "w", "hamstrings", "calves", 0.25, "prone leg curl"),
    ("machine_chest_press", "Chest Press (Machine)", "machine", "push_h", "w", "chest", "triceps,front_delts", 0.4, "chest press"),
    ("pec_deck", "Pec Deck (Machine)", "machine", "fly", "w", "chest", "front_delts", 0.3, "machine fly,butterfly"),
    ("machine_shoulder_press", "Shoulder Press (Machine)", "machine", "push_v", "w", "front_delts", "triceps,side_delts", 0.3, ""),
    ("machine_lateral_raise", "Lateral Raise (Machine)", "machine", "raise", "w", "side_delts", "", 0.15, ""),
    ("machine_row", "Chest-Supported Row (Machine)", "machine", "pull_h", "w", "upper_back,lats", "biceps,rear_delts", 0.4, "machine row,seated row machine"),
    ("reverse_pec_deck", "Reverse Pec Deck (Machine)", "machine", "raise", "w", "rear_delts", "upper_back", 0.15, "rear delt machine"),
    ("machine_preacher_curl", "Preacher Curl (Machine)", "machine", "curl", "w", "biceps", "", 0.15, ""),
    ("machine_triceps_ext", "Triceps Extension (Machine)", "machine", "extension", "w", "triceps", "", 0.2, ""),
    ("hip_abduction", "Hip Abduction (Machine)", "machine", "hip", "w", "abductors,glutes", "", 0.4, "abductor machine"),
    ("hip_adduction", "Hip Adduction (Machine)", "machine", "hip", "w", "adductors", "", 0.4, "adductor machine"),
    ("standing_calf_raise", "Standing Calf Raise (Machine)", "machine|smith", "calf", "w", "calves", "", 0.6, "calf raise"),
    ("seated_calf_raise", "Seated Calf Raise (Machine)", "machine", "calf", "w", "calves", "", 0.3, ""),
    ("assisted_pullup", "Assisted Pull-Up (Machine)", "machine", "pull_v", "as", "lats", "biceps,upper_back", None, "assisted pull up"),
    ("assisted_dip", "Assisted Dip (Machine)", "machine", "push_v", "as", "chest,triceps", "front_delts", None, ""),
    ("glute_drive", "Hip Thrust (Machine)", "machine", "hip", "w", "glutes", "hamstrings", 0.6, "glute drive"),
    # ---- bodyweight
    ("pullup", "Pull-Up", "pullup_bar", "pull_v", "bw", "lats", "biceps,upper_back,rear_delts", None, "pull up,pullups,weighted pull up"),
    ("chinup", "Chin-Up", "pullup_bar", "pull_v", "bw", "lats,biceps", "upper_back", None, "chin up,chinups"),
    ("neutral_pullup", "Neutral-Grip Pull-Up", "pullup_bar", "pull_v", "bw", "lats", "biceps,upper_back", None, ""),
    ("pushup", "Push-Up", "bodyweight", "push_h", "bw", "chest", "triceps,front_delts,abs", None, "push up,press up,pushups"),
    ("incline_pushup", "Incline Push-Up", "bodyweight", "push_h", "bw", "chest", "triceps,front_delts", None, ""),
    ("diamond_pushup", "Diamond Push-Up", "bodyweight", "push_h", "bw", "triceps,chest", "front_delts", None, "close grip push up"),
    ("pike_pushup", "Pike Push-Up", "bodyweight", "push_v", "bw", "front_delts", "triceps,upper_back", None, ""),
    ("dip", "Dip", "dip_station", "push_v", "bw", "chest,triceps", "front_delts", None, "dips,parallel bar dip,weighted dip"),
    ("bench_dip", "Bench Dip", "bench", "extension", "bw", "triceps", "chest,front_delts", None, ""),
    ("inverted_row", "Inverted Row", "rings|rack|pullup_bar", "pull_h", "bw", "upper_back,lats", "biceps,rear_delts", None, "australian pull up,ring row,bodyweight row"),
    ("bodyweight_squat", "Bodyweight Squat", "bodyweight", "squat", "bw", "quads,glutes", "adductors", None, "air squat"),
    ("pistol_squat", "Pistol Squat", "bodyweight", "lunge", "bw", "quads,glutes", "adductors,abs", None, ""),
    ("cossack_squat", "Cossack Squat", "bodyweight", "lunge", "bw", "adductors,quads", "glutes", None, ""),
    ("walking_lunge", "Walking Lunge", "bodyweight", "lunge", "bw", "quads,glutes", "adductors,hamstrings", None, "lunge"),
    ("glute_bridge", "Glute Bridge", "bodyweight", "hip", "bw", "glutes", "hamstrings", None, ""),
    ("single_leg_glute_bridge", "Single-Leg Glute Bridge", "bodyweight", "hip", "bw", "glutes", "hamstrings", None, ""),
    ("nordic_curl", "Nordic Hamstring Curl", "bodyweight", "knee_flex", "bw", "hamstrings", "", None, "nordic"),
    ("back_extension", "Back Extension", "bodyweight|machine", "hinge", "bw", "lower_back,glutes", "hamstrings", None, "hyperextension,45 degree back extension"),
    ("bw_calf_raise", "Calf Raise (Bodyweight)", "bodyweight", "calf", "bw", "calves", "", None, ""),
    ("hanging_leg_raise", "Hanging Leg Raise", "pullup_bar", "core", "bw", "abs", "obliques,forearms", None, "toes to bar"),
    ("hanging_knee_raise", "Hanging Knee Raise", "pullup_bar", "core", "bw", "abs", "forearms", None, ""),
    ("lying_leg_raise", "Lying Leg Raise", "bodyweight", "core", "bw", "abs", "", None, ""),
    ("crunch", "Crunch", "bodyweight", "core", "bw", "abs", "", None, "sit up,situp"),
    ("reverse_crunch", "Reverse Crunch", "bodyweight", "core", "bw", "abs", "", None, ""),
    ("bicycle_crunch", "Bicycle Crunch", "bodyweight", "core", "bw", "obliques,abs", "", None, ""),
    ("russian_twist", "Russian Twist", "bodyweight", "core", "bw", "obliques", "abs", None, ""),
    ("ab_wheel", "Ab Wheel Rollout", "bodyweight", "core", "bw", "abs", "lats,obliques", None, "rollout"),
    ("dead_bug", "Dead Bug", "bodyweight", "core", "bw", "abs", "", None, ""),
    ("bird_dog", "Bird Dog", "bodyweight", "core", "bw", "lower_back,abs", "glutes", None, ""),
    ("plank", "Plank", "bodyweight", "core", "t", "abs", "obliques,front_delts", None, "front plank"),
    ("side_plank", "Side Plank", "bodyweight", "core", "t", "obliques", "abs,abductors", None, ""),
    ("copenhagen_plank", "Copenhagen Plank", "bench", "core", "t", "adductors", "obliques", None, "copenhagen"),
    ("hollow_hold", "Hollow Hold", "bodyweight", "core", "t", "abs", "", None, ""),
    ("l_sit", "L-Sit", "dip_station|bodyweight", "core", "t", "abs", "triceps", None, ""),
    ("wall_sit", "Wall Sit", "bodyweight", "squat", "t", "quads", "glutes", None, ""),
    ("dead_hang", "Dead Hang", "pullup_bar", "carry", "t", "forearms", "lats", None, "hang"),
    ("burpee", "Burpee", "bodyweight", "plyo", "bw", "quads,chest", "glutes,triceps,abs", None, "burpees"),
    ("box_jump", "Box Jump", "bodyweight", "plyo", "bw", "quads,glutes", "calves", None, ""),
    ("jump_squat", "Jump Squat", "bodyweight", "plyo", "bw", "quads,glutes", "calves", None, "squat jump"),
    # ---- bands
    ("band_pull_apart", "Band Pull-Apart", "band", "raise", "bw", "rear_delts,upper_back", "", None, "pull apart"),
    ("band_row", "Row (Band)", "band", "pull_h", "bw", "upper_back,lats", "biceps,rear_delts", None, ""),
    ("band_pulldown", "Lat Pulldown (Band)", "band", "pull_v", "bw", "lats", "biceps", None, ""),
    ("band_chest_press", "Chest Press (Band)", "band", "push_h", "bw", "chest", "triceps,front_delts", None, ""),
    ("band_overhead_press", "Overhead Press (Band)", "band", "push_v", "bw", "front_delts", "triceps", None, ""),
    ("band_curl", "Curl (Band)", "band", "curl", "bw", "biceps", "forearms", None, ""),
    ("band_pushdown", "Triceps Pushdown (Band)", "band", "extension", "bw", "triceps", "", None, ""),
    ("band_lateral_raise", "Lateral Raise (Band)", "band", "raise", "bw", "side_delts", "", None, ""),
    ("band_good_morning", "Good Morning (Band)", "band", "hinge", "bw", "hamstrings,glutes", "lower_back", None, ""),
    ("band_lateral_walk", "Lateral Band Walk", "band", "hip", "bw", "abductors,glutes", "", None, "monster walk,crab walk"),
    # ---- cardio & conditioning
    ("run", "Running", "bodyweight", "cardio", "d", "", "quads,calves,hamstrings", None, "run,jog,jogging"),
    ("treadmill", "Treadmill", "cardio", "cardio", "d", "", "quads,calves", None, "treadmill run"),
    ("walk", "Walking", "bodyweight", "cardio", "d", "", "calves", None, "walk,hike"),
    ("incline_walk", "Incline Walk (Treadmill)", "cardio", "cardio", "t", "", "glutes,calves", None, ""),
    ("cycling", "Cycling", "bodyweight", "cardio", "d", "", "quads", None, "bike ride,cycle"),
    ("stationary_bike", "Stationary Bike", "cardio", "cardio", "t", "", "quads", None, "exercise bike,spin"),
    ("air_bike", "Air Bike", "cardio", "cardio", "t", "", "quads,front_delts", None, "assault bike,echo bike"),
    ("rowing_machine", "Rowing Machine", "cardio", "cardio", "d", "", "upper_back,quads,lats", None, "rower,erg,row erg"),
    ("elliptical", "Elliptical", "cardio", "cardio", "t", "", "quads", None, "cross trainer"),
    ("stair_climber", "Stair Climber", "cardio", "cardio", "t", "", "glutes,quads,calves", None, "stairmaster,stairs"),
    ("swimming", "Swimming", "bodyweight", "cardio", "d", "", "lats,front_delts", None, "swim"),
    ("jump_rope", "Jump Rope", "bodyweight", "cardio", "t", "", "calves", None, "skipping,skip rope"),
    ("sled_push", "Sled Push", "sled", "carry", "d", "quads,glutes", "calves,front_delts", 0.8, "prowler"),
]


def _equip_spec(raw: str) -> list[list[str]]:
    """``"barbell+rack"`` → [["barbell", "rack"]]; ``"dumbbell|kettlebell"``
    → [["dumbbell"], ["kettlebell"]] (any one alternative satisfies)."""
    return [alt.split("+") for alt in raw.split("|")]


@lru_cache(maxsize=1)
def builtin() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for eid, name, equip, pattern, log, prim, sec, start, aka in _RAW:
        alts = _equip_spec(equip)
        out[eid] = {
            "id": eid,
            "name": name,
            "equipment": alts[0][0],
            "needs": alts,
            "pattern": pattern,
            "log": LOG_CODES[log],
            "primary": [m for m in prim.split(",") if m],
            "secondary": [m for m in sec.split(",") if m],
            "compound": pattern in COMPOUND_PATTERNS,
            "start": start,
            "aliases": [a.strip() for a in aka.split(",") if a.strip()],
            "custom": False,
        }
    return out


def catalog_payload() -> dict[str, Any]:
    """What the frontend loads once (``GET /api/items/k/workout/catalog``)."""
    return {
        "exercises": list(builtin().values()),
        "muscles": {k: {**v, "mav": list(v["mav"])} for k, v in MUSCLES.items()},
        "equipment": EQUIPMENT,
        "patterns": PATTERNS,
    }
