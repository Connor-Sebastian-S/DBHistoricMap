#!/usr/bin/env python3
"""Build the editable forest-tree layer and optionally enrich it with Scottish AWI data.

The output is designed for the Dunkeld through time viewer. Existing forests.geojson
features (including manual edits) are retained. AWI polygons are matched to existing
woodland where they overlap; only the previously uncovered part is added as a new
AWI-derived tree feature, preventing duplicate trees where the datasets overlap.

Example:
    python build_forests_awi.py --base base.geojson --out forests.geojson \
        --add-new --awi awi_woodland.geojson --ancient-from 1200

The AWI source can be a GeoJSON FeatureCollection, a single Feature, or a list of
Features. The raw input can also be copied unchanged to --awi-source-out for reference.

Dating policy:
  * AWI 1a / 2a (ancient semi-natural): shown from --ancient-from (default 1200),
    but explicitly marked as an extrapolation before the AWI map evidence date.
  * AWI 1b / 2b (long-established plantation origin): shown from the map evidence
    date (1750 / 1860), not backdated to 1200.
  * Undated OSM woods retain the project's 1600 viewer fallback. That is not treated
    as historical evidence; the original date_src note is retained.

Dependencies:
    pip install shapely
"""
import argparse
import json
import os
import re
import shutil
import sys
from copy import deepcopy

from shapely.geometry import shape, mapping, Polygon, MultiPolygon, GeometryCollection
from shapely.ops import unary_union

TYPE_FROM_LEAF = {"needleleaved": "conifer", "broadleaved": "broadleaf", "mixed": "mixed"}
HEIGHT = {"conifer": 14, "broadleaf": 12, "mixed": 13}
DEFAULT_OSM_FROM = 1600
MATCH_OVERLAP = 0.08       # fraction of the smaller polygon covered
MIN_INTERSECTION_M2 = 20.0
MIN_FRAGMENT_M2 = 25.0
M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON_EQ = 111320.0


def load_geojson(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("type") == "FeatureCollection":
        return data, list(data.get("features") or [])
    if data.get("type") == "Feature":
        return {"type": "FeatureCollection", "features": [data]}, [data]
    if isinstance(data, list) and all(isinstance(x, dict) and x.get("type") == "Feature" for x in data):
        return {"type": "FeatureCollection", "features": data}, data
    raise ValueError(f"{path} is not a GeoJSON FeatureCollection, Feature, or Feature list")


def clean_geom(feature):
    geom = shape(feature["geometry"])
    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    return geom


def area_m2(geom):
    """Approximate area in square metres for small Dunkeld-area lon/lat polygons."""
    if geom is None or geom.is_empty:
        return 0.0
    minx, miny, maxx, maxy = geom.bounds
    lat = (miny + maxy) / 2.0
    m_lon = M_PER_DEG_LON_EQ * max(0.01, abs(__import__('math').cos(lat * __import__('math').pi / 180.0)))
    return geom.area * m_lon * M_PER_DEG_LAT


def overlap_ratio(a, b):
    if not a.intersects(b):
        return 0.0
    denom = min(a.area, b.area)
    return a.intersection(b).area / denom if denom > 0 else 0.0


def as_text(value):
    return "" if value is None else str(value).strip()


def first_value(props, *keys):
    for key in keys:
        value = props.get(key)
        if value not in (None, ""):
            return value
    return None


def source_identity(props, index):
    wood = first_value(props, "WOOD_ID", "wood_id")
    comp = first_value(props, "COMP_ID", "comp_id")
    oid = first_value(props, "OID_T", "oid_t")
    if wood is not None:
        # WOOD_ID is the preferred identity; add COMP_ID only if present to avoid
        # collapsing separate components if the source repeats a WOOD_ID.
        return f"awi:{wood}" + (f":{comp}" if comp is not None else "")
    if oid is not None:
        return f"awi:oid:{oid}"
    if comp is not None:
        return f"awi:comp:{comp}"
    return f"awi:record:{index + 1}"


def classify_awi(props):
    code = as_text(first_value(props, "ANTIQUITY_", "antiquity_code", "ANTIQUITY" )).lower()
    origin = as_text(first_value(props, "MAP_ORIGIN", "map_origin")).upper()

    if code in {"1a", "2a", "1b", "2b"}:
        category = code
    elif origin.startswith("ASNO"):
        category = "1a" if "1750" in origin else "2a" if "1860" in origin else None
    elif origin.startswith("LEPO"):
        category = "1b" if "1750" in origin else "2b" if "1860" in origin else None
    else:
        category = None

    m = re.search(r"(1750|1860)", origin)
    evidence_year = int(m.group(1)) if m else None
    if evidence_year is None and category:
        evidence_year = 1750 if category.startswith("1") else 1860

    if category in {"1a", "2a"}:
        history_type = "ancient_semi_natural"
        confidence = "medium_extrapolation" if evidence_year == 1750 else "low_extrapolation"
        classification = "Ancient woodland, semi-natural origin"
    elif category in {"1b", "2b"}:
        history_type = "long_established_plantation_origin"
        confidence = "mapped_evidence"
        classification = "Long-established woodland, plantation origin"
    else:
        history_type = "unclassified_awi"
        confidence = "unknown"
        classification = "AWI category not recognised"

    return {
        "category": category,
        "map_origin": origin or None,
        "evidence_year": evidence_year,
        "history_type": history_type,
        "confidence": confidence,
        "classification": classification,
    }


def awi_record(feature, index, ancient_from):
    raw = feature.get("properties") or {}
    identity = source_identity(raw, index)
    info = classify_awi(raw)
    if info["history_type"] == "ancient_semi_natural":
        display_from = int(ancient_from)
        date_src = (
            f"AWI {info['category']} ({info['map_origin'] or info['evidence_year']}); "
            f"pre-evidence woodland continuity extrapolated back to {display_from}"
        )
        basis = (
            f"Mapped as semi-natural woodland by {info['evidence_year'] or 'the AWI source'}; "
            f"continuous woodland status is documented only from the AWI evidence period. "
            f"Visibility from {display_from} is a historical reconstruction, not a mapped date."
        )
    elif info["history_type"] == "long_established_plantation_origin":
        display_from = info["evidence_year"] or 1750
        date_src = f"AWI {info['category']} ({info['map_origin'] or display_from}); mapped evidence"
        basis = (
            f"Plantation-origin woodland shown by {display_from}; not extrapolated to 1200 "
            "because the inventory records plantation origin, not medieval woodland continuity."
        )
    else:
        display_from = info["evidence_year"] or 2000
        date_src = "AWI category not recognised; inspect source attributes"
        basis = "Unclassified AWI record; historical display date requires review."

    return {
        "source_id": identity,
        **info,
        "display_from": display_from,
        "date_src": date_src,
        "history_basis": basis,
        "raw": deepcopy(raw),
    }


def parse_awi_records(features, ancient_from):
    records = []
    skipped = 0
    for i, f in enumerate(features):
        if not f.get("geometry"):
            skipped += 1
            continue
        g = clean_geom(f)
        if g is None:
            skipped += 1
            continue
        rec = awi_record(f, i, ancient_from)
        records.append({"geom": g, "record": rec, "source_feature": f})
    return records, skipped


def append_note(old, note):
    old = as_text(old)
    if not old:
        return note
    if note in old:
        return old
    return old.rstrip("; ") + "; " + note


def attach_awi(props, rec):
    records = []
    old_json = props.get("awi_records")
    if old_json:
        try:
            records = json.loads(old_json) if isinstance(old_json, str) else list(old_json)
        except (ValueError, TypeError):
            records = []
    if any(x.get("source_id") == rec["source_id"] for x in records):
        return False

    # Store a compact record while retaining every original AWI attribute.
    records.append(rec)
    props["awi_records"] = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
    props["awi_count"] = len(records)
    props["awi_ids"] = ",".join(x["source_id"] for x in records)
    props["awi_categories"] = ",".join(sorted({as_text(x.get("category")) for x in records if x.get("category")}))
    props["awi_map_origins"] = ",".join(sorted({as_text(x.get("map_origin")) for x in records if x.get("map_origin")}))
    props["awi_evidence_years"] = ",".join(str(x["evidence_year"]) for x in records if x.get("evidence_year"))
    # Convenient flat fields for QGIS attribute-table filtering. The complete original
    # attributes remain preserved in the awi_records JSON field.
    for out_key, raw_key in (("awi_site_names", "SITE_NAME"), ("awi_site_ids", "SITE_ID"),
                             ("awi_wood_ids", "WOOD_ID"), ("awi_districts", "DISTRICT"),
                             ("awi_parishes", "PARISH"), ("awi_antiquity_labels", "ANTIQUITY")):
        vals = sorted({as_text(x.get("raw", {}).get(raw_key)) for x in records
                       if x.get("raw", {}).get(raw_key) not in (None, "")})
        props[out_key] = " | ".join(vals) if vals else None
    props["history_basis"] = append_note(props.get("history_basis"), rec["history_basis"])

    ancient = [x for x in records if x.get("history_type") == "ancient_semi_natural"]
    if ancient:
        props["history_class"] = "ancient_semi_natural"
        props["history_confidence"] = "medium_extrapolation" if any(x.get("confidence") == "medium_extrapolation" for x in ancient) else "low_extrapolation"
    elif records:
        props["history_class"] = "long_established_plantation_origin"
        props["history_confidence"] = "mapped_evidence"

    # Replace only the builder's undated OSM placeholder. Do not overwrite manual dates
    # or any date explicitly researched by the user.
    date_src = as_text(props.get("date_src")).lower()
    placeholder = ("placeholder" in date_src or
                   (not props.get("manual") and date_src.startswith("osm") and
                    props.get("from_year") in (None, 1600, 2000)))
    already_awi_dated = date_src.startswith("awi")
    if (placeholder or already_awi_dated) and not props.get("manual"):
        if placeholder:
            props["osm_date_src"] = props.get("date_src")
        props["from_year"] = min(x["display_from"] for x in records)
        props["date_src"] = "; ".join(sorted({x["date_src"] for x in records}))
    elif props.get("from_year") is None and not props.get("manual"):
        props["from_year"] = min(x["display_from"] for x in records)
        props["date_src"] = "; ".join(sorted({x["date_src"] for x in records}))

    names = [as_text(x["raw"].get("SITE_NAME")) for x in records if x.get("raw", {}).get("SITE_NAME")]
    if not props.get("name") and names:
        props["name"] = names[0]
    return True


def polygonal_only(geom):
    if geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        parts = []
        for g in geom.geoms:
            if g.geom_type == "Polygon":
                parts.append(g)
            elif g.geom_type == "MultiPolygon":
                parts.extend(list(g.geoms))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return None


def main():
    ap = argparse.ArgumentParser(description="Build / extend editable woodland tree features.")
    ap.add_argument("--base", default="base.geojson", help="OSM/OHM base.geojson")
    ap.add_argument("--out", default="forests.geojson", help="Output forest tree features")
    ap.add_argument("--awi", help="Scottish AWI GeoJSON (optional)")
    ap.add_argument("--awi-source-out", help="Optional path to copy the raw AWI GeoJSON unchanged")
    ap.add_argument("--add-new", action="store_true", help="Append missing source features and enrich existing output")
    ap.add_argument("--ancient-from", type=int, default=1200,
                    help="Timeline start for ancient semi-natural AWI woodland (default: 1200; explicitly extrapolated)")
    ap.add_argument("--undated-osm-from", type=int, default=DEFAULT_OSM_FROM,
                    help=f"Viewer fallback for undated OSM woods (default: {DEFAULT_OSM_FROM})")
    ap.add_argument("--min-fragment-m2", type=float, default=MIN_FRAGMENT_M2,
                    help=f"Ignore uncovered AWI slivers smaller than this area in m² (default: {MIN_FRAGMENT_M2})")
    a = ap.parse_args()

    if os.path.exists(a.out) and not a.add_new:
        sys.exit(f"{a.out} already exists. Use --add-new to preserve it and add missing data.")

    _, base_features = load_geojson(a.base)
    woods = [f for f in base_features
             if (f.get("properties") or {}).get("kind") == "wood"
             and f.get("geometry")
             and f["geometry"].get("type") in ("Polygon", "MultiPolygon")]

    features = []
    known_sources = set()
    if os.path.exists(a.out):
        _, old_features = load_geojson(a.out)
        for f in old_features:
            props = deepcopy(f.get("properties") or {})
            geom = clean_geom(f)
            if geom is None:
                # Preserve unusual or malformed existing feature content verbatim.
                features.append({"feature": deepcopy(f), "props": props, "geom": None})
            else:
                features.append({"feature": deepcopy(f), "props": props, "geom": geom})
            for src in as_text(props.get("src")).split(","):
                if src:
                    known_sources.add(src)
            try:
                old_awi = json.loads(props.get("awi_records") or "[]")
            except (ValueError, TypeError):
                old_awi = []
            known_sources.update(x.get("source_id") for x in old_awi if x.get("source_id"))
            if props.get("awi_source_id"):
                known_sources.add(props["awi_source_id"])

    next_id = 1 + max([
        int(str(x["props"].get("id", ""))[1:])
        for x in features
        if str(x["props"].get("id", ""))[1:].isdigit()
    ] or [0])

    stats = {"osm_added": 0, "osm_skipped_known": 0, "awi_matched": 0,
             "awi_fragments_added": 0, "awi_skipped_known": 0, "awi_invalid": 0}

    # Add any OSM/OHM woodland not already present. Existing features are never replaced.
    for w in woods:
        p = w.get("properties") or {}
        src = as_text(p.get("src"))
        if not src or src in known_sources:
            stats["osm_skipped_known"] += 1
            continue
        leaf = TYPE_FROM_LEAF.get(p.get("leaf_type"), "mixed")
        raw_from = p.get("from_year")
        placeholder = raw_from in (None, 2000)
        props = {
            "id": f"f{next_id:06d}",
            "name": p.get("name"),
            "tree_type": leaf,
            "density": 80,
            "tree_h": HEIGHT[leaf],
            "from_year": a.undated_osm_from if placeholder else raw_from,
            "to_year": p.get("to_year"),
            "date_src": "osm (undated: viewer fallback, not historical evidence)" if placeholder else "ohm tag",
            "src": src,
            "manual": False,
            "notes": None,
        }
        features.append({"feature": {"type": "Feature", "properties": props,
                                     "geometry": deepcopy(w["geometry"])},
                         "props": props, "geom": clean_geom(w)})
        known_sources.add(src)
        next_id += 1
        stats["osm_added"] += 1

    # Enrich the tree layer with AWI. Exact source features are optionally copied separately.
    if a.awi:
        awi_data, awi_features = load_geojson(a.awi)
        if a.awi_source_out:
            os.makedirs(os.path.dirname(os.path.abspath(a.awi_source_out)), exist_ok=True)
            with open(a.awi_source_out, "w", encoding="utf-8") as fh:
                json.dump(awi_data, fh, ensure_ascii=False, separators=(",", ":"))

        awi_records, invalid = parse_awi_records(awi_features, a.ancient_from)
        stats["awi_invalid"] = invalid

        # Current tree coverage. Expired historic phases are deliberately excluded.
        current_geoms = [x["geom"] for x in features
                         if x["geom"] is not None and x["props"].get("to_year") is None]
        coverage = unary_union(current_geoms) if current_geoms else None

        for item in awi_records:
            g, rec = item["geom"], item["record"]
            if rec["source_id"] in known_sources:
                stats["awi_skipped_known"] += 1
                continue

            # Attach provenance to every existing current-wood feature with meaningful
            # overlap. Manual dates/geometry are retained; AWI evidence is additive.
            matched = 0
            for entry in features:
                eg = entry["geom"]
                if eg is None or entry["props"].get("to_year") is not None or not eg.intersects(g):
                    continue
                inter_area = area_m2(eg.intersection(g))
                if inter_area < MIN_INTERSECTION_M2:
                    continue
                if overlap_ratio(eg, g) < MATCH_OVERLAP:
                    continue
                if attach_awi(entry["props"], rec):
                    matched += 1
            if matched:
                stats["awi_matched"] += 1
                known_sources.add(rec["source_id"])

            # Add only the part not represented by current forest polygons, so the
            # tree generator does not plant two crowns in the same location.
            residual = g.difference(coverage) if coverage is not None else g
            residual = polygonal_only(residual)
            if residual is not None and area_m2(residual) >= a.min_fragment_m2:
                raw = rec["raw"]
                info = rec
                props = {
                    "id": f"f{next_id:06d}",
                    "name": first_value(raw, "SITE_NAME", "name"),
                    "tree_type": "mixed",  # AWI records woodland origin, not current species mix
                    "density": 80,
                    "tree_h": 13,
                    "from_year": info["display_from"],
                    "to_year": None,
                    "date_src": info["date_src"],
                    "src": rec["source_id"] + ":uncovered",
                    "manual": False,
                    "notes": "AWI woodland polygon portion not covered by existing current forest features. "
                             "Species mix is unknown; mixed is a neutral visual default.",
                    "history_class": info["history_type"],
                    "history_confidence": info["confidence"],
                    "history_basis": info["history_basis"],
                    "awi_source_id": rec["source_id"],
                    "awi_category": info["category"],
                    "awi_antiquity": first_value(raw, "ANTIQUITY", "ANTIQ"),
                    "awi_map_origin": info["map_origin"],
                    "awi_evidence_year": info["evidence_year"],
                    "awi_site_id": first_value(raw, "SITE_ID"),
                    "awi_comp_id": first_value(raw, "COMP_ID"),
                    "awi_wood_id": first_value(raw, "WOOD_ID"),
                    "awi_site_name": first_value(raw, "SITE_NAME"),
                    "awi_hectare": first_value(raw, "HECTARE"),
                    "awi_district": first_value(raw, "DISTRICT"),
                    "awi_parish": first_value(raw, "PARISH"),
                    "awi_grid_ref": first_value(raw, "GRID_REF"),
                    "awi_raw": json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
                    "awi_fragment": True,
                }
                feat = {"type": "Feature", "properties": props, "geometry": mapping(residual)}
                features.append({"feature": feat, "props": props, "geom": residual})
                known_sources.add(rec["source_id"])
                next_id += 1
                stats["awi_fragments_added"] += 1
                coverage = unary_union([coverage, residual]) if coverage is not None else residual
            elif matched == 0:
                # Completely covered but no match can occur only for extremely thin
                # slivers. Record the source as processed rather than silently looping.
                known_sources.add(rec["source_id"])

    out_features = []
    for entry in features:
        f = entry["feature"]
        props = entry["props"]
        # Keep any original geometry exactly as it was. Newly created AWI residuals use
        # their polygonal difference geometry; existing coordinates are not rewritten.
        f["properties"] = props
        out_features.append(f)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": out_features},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(out_features)} forest features to {a.out}")
    print("  " + " | ".join(f"{k}: {v}" for k, v in stats.items()))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        sys.exit(f"ERROR: {exc}")
