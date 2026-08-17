#!/usr/bin/env python3
"""
Generate Shopify color-swatch images by cropping "front" product photos.

Usage:
    python3 generate_swatches.py --library-root "/path/to/Products by SKU" --sample 6
    python3 generate_swatches.py --library-root "/path/to/Products by SKU"
    python3 generate_swatches.py --library-root "/path/to/Products by SKU" --overwrite

Re-run safely as new products are added: existing swatch files are skipped
by default (use --overwrite to replace them).
"""

import argparse
import csv
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from PIL import Image

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

SCRIPT_DIR = Path(__file__).resolve().parent
MODEL_PATH = SCRIPT_DIR / "pose_landmarker_lite.task"

FRONT_RE = re.compile(r"(?P<sep>[ _])front(?P<digit>\d*)(?=\.[^.]+$)", re.IGNORECASE)

MIN_LANDMARK_CONF = 0.5  # minimum visibility/presence to trust a landmark

# Tunable crop constants (adjust after reviewing the sample batch)
JACKET_HEAD_FACTOR = 0.6       # head_top_y ~= nose_y - factor * (shoulder_mid_y - nose_y)
JACKET_HEADROOM_FRAC = 0.03    # extra headroom above estimated head top, as frac of image height
JACKET_HAND_MARGIN_FRAC = 0.05 # margin below the lower wrist, as frac of image height, so fingers aren't clipped
PANT_BELLY_FACTOR = 0.08       # belly_y ~= hip_mid_y - factor * (hip_mid_y - shoulder_mid_y)
FOOT_MARGIN_FRAC = 0.05        # margin below ankles, as frac of image height, for Pant/Bib
BIB_SHOULDER_HEADROOM_FRAC = 0.03  # small margin above shoulder line for Bib top edge

GARMENT_KEYWORDS = {
    "Bib": [r"bib"],
    "Pant": [r"pants?", r"joggers?", r"shorts?"],
    "Jacket": [r"jacket", r"parka", r"crew", r"hoodie", r"fleece", r"tshirt", r"t-shirt"],
}

LANDMARK_INDEX = {
    "nose": 0,
    "l_shoulder": 11,
    "r_shoulder": 12,
    "l_wrist": 15,
    "r_wrist": 16,
    "l_hip": 23,
    "r_hip": 24,
    "l_ankle": 27,
    "r_ankle": 28,
}


@dataclass
class Row:
    original_path: str
    swatch_path: str = ""
    garment_type: str = ""
    status: str = ""
    reason: str = ""


def classify_garment_name(folder_name: str) -> Optional[str]:
    name_lower = folder_name.lower()
    for garment_type, keywords in GARMENT_KEYWORDS.items():
        for kw in keywords:
            if re.search(rf"\b{kw}\b", name_lower):
                return garment_type
    return None


def classify_garment(path: Path, library_root: Path) -> Optional[str]:
    """Classify by scanning every ancestor folder name (between library_root
    and the file) for a keyword match, since the garment-type folder is
    typically the grandparent (a colorway subfolder sits in between)."""
    rel = path.relative_to(library_root)
    for part in rel.parts[:-1]:
        gt = classify_garment_name(part)
        if gt is not None:
            return gt
    return None


def is_accessories_path(path: Path, library_root: Path) -> bool:
    rel = path.relative_to(library_root)
    for part in rel.parts[:-1]:  # exclude the filename itself
        if "accessories" in part.lower():
            return True
    return False


def find_front_targets(library_root: Path):
    for path in sorted(library_root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        if is_accessories_path(path, library_root):
            continue
        m = FRONT_RE.search(path.name)
        if not m:
            continue
        yield path, m


def swatch_path_for(path: Path, m: re.Match) -> Path:
    sep = m.group("sep")
    digit = m.group("digit")
    new_token = f"{sep}swatch{digit}"
    new_name = path.name[: m.start()] + new_token + path.name[m.end():]
    return path.with_name(new_name)


class PoseDetector:
    def __init__(self, model_path: Path):
        base_options = mp_python.BaseOptions(model_asset_path=str(model_path))
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            output_segmentation_masks=False,
            running_mode=vision.RunningMode.IMAGE,
        )
        self.landmarker = vision.PoseLandmarker.create_from_options(options)

    def detect(self, image_path: Path):
        mp_image = mp.Image.create_from_file(str(image_path))
        result = self.landmarker.detect(mp_image)
        if not result.pose_landmarks:
            return None
        lm = result.pose_landmarks[0]
        landmarks = {}
        for name, idx in LANDMARK_INDEX.items():
            p = lm[idx]
            vis = getattr(p, "visibility", 1.0)
            pres = getattr(p, "presence", 1.0)
            landmarks[name] = {
                "x": p.x * mp_image.width,
                "y": p.y * mp_image.height,
                "conf": min(vis, pres),
            }
        return landmarks, mp_image.width, mp_image.height


def landmark_ok(landmarks, name) -> bool:
    lm = landmarks.get(name)
    return lm is not None and lm["conf"] >= MIN_LANDMARK_CONF


def horizontal_center(landmarks, width) -> Optional[float]:
    if landmark_ok(landmarks, "l_shoulder") and landmark_ok(landmarks, "r_shoulder"):
        return (landmarks["l_shoulder"]["x"] + landmarks["r_shoulder"]["x"]) / 2
    if landmark_ok(landmarks, "l_hip") and landmark_ok(landmarks, "r_hip"):
        return (landmarks["l_hip"]["x"] + landmarks["r_hip"]["x"]) / 2
    return None


def compute_crop_box(garment_type, landmarks, width, height):
    """Returns (top, bottom, reason_if_failed). top/bottom are None on failure."""

    required = {
        "Jacket": ["nose", "l_shoulder", "r_shoulder"],
        "Pant": ["l_hip", "r_hip", "l_shoulder", "r_shoulder"],
        "Bib": ["l_shoulder", "r_shoulder"],
    }[garment_type]

    for name in required:
        if not landmark_ok(landmarks, name):
            return None, None, f"low-confidence or missing landmark: {name}"

    shoulder_mid_y = (landmarks["l_shoulder"]["y"] + landmarks["r_shoulder"]["y"]) / 2

    if garment_type == "Jacket":
        if not (landmark_ok(landmarks, "l_wrist") or landmark_ok(landmarks, "r_wrist")):
            return None, None, "no wrist landmark visible for Jacket crop"
        nose_y = landmarks["nose"]["y"]
        head_top_y = nose_y - JACKET_HEAD_FACTOR * (shoulder_mid_y - nose_y)
        head_top_y -= JACKET_HEADROOM_FRAC * height
        wrist_ys = []
        if landmark_ok(landmarks, "l_wrist"):
            wrist_ys.append(landmarks["l_wrist"]["y"])
        if landmark_ok(landmarks, "r_wrist"):
            wrist_ys.append(landmarks["r_wrist"]["y"])
        bottom_y = max(wrist_ys) + JACKET_HAND_MARGIN_FRAC * height
        top, bottom = head_top_y, bottom_y

    elif garment_type == "Pant":
        if not (landmark_ok(landmarks, "l_ankle") or landmark_ok(landmarks, "r_ankle")):
            return None, None, "no ankle landmark visible for Pant crop"
        hip_mid_y = (landmarks["l_hip"]["y"] + landmarks["r_hip"]["y"]) / 2
        belly_y = hip_mid_y - PANT_BELLY_FACTOR * (hip_mid_y - shoulder_mid_y)
        ankle_ys = []
        if landmark_ok(landmarks, "l_ankle"):
            ankle_ys.append(landmarks["l_ankle"]["y"])
        if landmark_ok(landmarks, "r_ankle"):
            ankle_ys.append(landmarks["r_ankle"]["y"])
        bottom_y = max(ankle_ys) + FOOT_MARGIN_FRAC * height
        top, bottom = belly_y, bottom_y

    elif garment_type == "Bib":
        if not (landmark_ok(landmarks, "l_ankle") or landmark_ok(landmarks, "r_ankle")):
            return None, None, "no ankle landmark visible for Bib crop"
        top_y = shoulder_mid_y - BIB_SHOULDER_HEADROOM_FRAC * height
        ankle_ys = []
        if landmark_ok(landmarks, "l_ankle"):
            ankle_ys.append(landmarks["l_ankle"]["y"])
        if landmark_ok(landmarks, "r_ankle"):
            ankle_ys.append(landmarks["r_ankle"]["y"])
        bottom_y = max(ankle_ys) + FOOT_MARGIN_FRAC * height
        top, bottom = top_y, bottom_y

    else:
        return None, None, f"unknown garment type: {garment_type}"

    top = max(0, top)
    bottom = min(height, bottom)
    if bottom <= top:
        return None, None, "computed crop box has non-positive height"

    return top, bottom, None


def fit_crop_box(top, bottom, center_x, width, height, orig_aspect):
    """Given a vertical range and horizontal center, derive a width-matching
    box preserving orig_aspect, centered on center_x, clamped to image bounds.
    Returns (left, top, right, bottom) or None if it can't fit."""
    crop_h = bottom - top
    crop_w = crop_h * orig_aspect

    if crop_w > width:
        # Can't widen further without distorting the vertical range; the
        # image isn't wide enough for this height at the original aspect.
        return None

    left = center_x - crop_w / 2
    right = center_x + crop_w / 2

    if left < 0:
        shift = -left
        left += shift
        right += shift
    if right > width:
        shift = right - width
        left -= shift
        right -= shift

    if left < 0 or right > width:
        return None

    return left, top, right, bottom


def process_image(path: Path, m: re.Match, library_root: Path, detector: PoseDetector,
                   overwrite: bool) -> Row:
    row = Row(original_path=str(path))

    garment_type = classify_garment(path, library_root)
    if garment_type is None:
        row.status = "skipped-unclassified"
        row.reason = f"no garment keyword match in ancestor folder names: {path.parent.name!r}"
        return row
    row.garment_type = garment_type

    out_path = swatch_path_for(path, m)
    row.swatch_path = str(out_path)

    if out_path.exists() and not overwrite:
        row.status = "skipped-already-exists"
        row.reason = "swatch file already exists"
        return row

    try:
        detection = detector.detect(path)
    except Exception as e:
        row.status = "skipped-low-confidence"
        row.reason = f"pose detection error: {e}"
        return row

    if detection is None:
        row.status = "skipped-low-confidence"
        row.reason = "no pose detected"
        return row

    landmarks, width, height = detection

    top, bottom, fail_reason = compute_crop_box(garment_type, landmarks, width, height)
    if top is None:
        row.status = "skipped-low-confidence"
        row.reason = fail_reason
        return row

    center_x = horizontal_center(landmarks, width)
    if center_x is None:
        row.status = "skipped-low-confidence"
        row.reason = "no reliable shoulder or hip landmarks for horizontal center"
        return row

    with Image.open(path) as im:
        orig_w, orig_h = im.size
        orig_aspect = orig_w / orig_h

        box = fit_crop_box(top, bottom, center_x, width, height, orig_aspect)
        if box is None:
            row.status = "skipped-out-of-bounds"
            row.reason = "crop box could not fit within image bounds at original aspect ratio"
            return row

        left, top_f, right, bottom_f = box
        crop_box = (round(left), round(top_f), round(right), round(bottom_f))
        cropped = im.crop(crop_box)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(out_path, quality=95)

    row.status = "created"
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-root", required=True, type=Path)
    parser.add_argument("--sample", type=int, default=0,
                         help="Only process up to N target images (evenly spread across garment types) and stop.")
    parser.add_argument("--overwrite", action="store_true",
                         help="Overwrite existing swatch files instead of skipping them.")
    parser.add_argument("--log-csv", type=Path, default=None,
                         help="Path to manifest CSV (default: <library-root>/swatch_run_log.csv)")
    args = parser.parse_args()

    library_root = args.library_root.resolve()
    if not library_root.is_dir():
        print(f"Library root not found: {library_root}", file=sys.stderr)
        sys.exit(1)

    if not MODEL_PATH.exists():
        print(f"Pose model not found at {MODEL_PATH}. Download pose_landmarker_lite.task first.",
              file=sys.stderr)
        sys.exit(1)

    log_csv = args.log_csv or (library_root / "swatch_run_log.csv")

    targets = list(find_front_targets(library_root))
    print(f"Found {len(targets)} front-numbered image(s).")

    if args.sample:
        # Spread the sample across garment types by pre-classifying folder names.
        by_type = {"Jacket": [], "Pant": [], "Bib": [], None: []}
        for path, m in targets:
            gt = classify_garment(path, library_root)
            by_type[gt].append((path, m))
        sampled = []
        i = 0
        type_order = ["Jacket", "Pant", "Bib"]
        while len(sampled) < args.sample and any(by_type[t] for t in type_order):
            t = type_order[i % len(type_order)]
            if by_type[t]:
                sampled.append(by_type[t].pop(0))
            i += 1
        targets = sampled[: args.sample]
        print(f"Sample mode: processing {len(targets)} image(s).")

    detector = PoseDetector(MODEL_PATH)

    rows = []
    for path, m in targets:
        row = process_image(path, m, library_root, detector, args.overwrite)
        rows.append(row)
        rel = path.relative_to(library_root)
        print(f"[{row.status}] {rel} -> {row.garment_type or '-'}"
              + (f" ({row.reason})" if row.reason else ""))

    with open(log_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["original_path", "swatch_path", "garment_type", "status", "reason"])
        for row in rows:
            writer.writerow([row.original_path,
                              row.swatch_path if row.status == "created" else "",
                              row.garment_type, row.status, row.reason])

    print(f"\nManifest written to {log_csv}")

    counts = {}
    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1
    for status, count in sorted(counts.items()):
        print(f"  {status}: {count}")


if __name__ == "__main__":
    main()
