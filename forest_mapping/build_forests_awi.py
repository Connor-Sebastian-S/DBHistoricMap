#!/usr/bin/env python3
"""Build the editable woodland/tree layer and spatially enrich it with Scottish AWI.

AWI areas are overlaid onto the existing forest layer. Where an AWI polygon covers only
part of an existing forest polygon, that area is split into its own feature so it can
have its own historical start year. The remainder retains the original forest dates.

Dating policy:
  * AWI 1a / 2a: shown from --ancient-from (default 1200), explicitly extrapolated.
  * AWI 1b / 2b: shown from the map evidence year (normally 1750 or 1860).
  * AWI 3 / OtherRoy: shown from --roy-map-from (default 1750), mapped presence only.
  * Unclassified AWI with a dated map origin: use that map evidence year.
  * Undated OSM woodland retains the project's 1600 viewer fallback.

The importer preserves pre-existing manual features and explicit dates. It is safe to run
again on its own output: it removes/reconstructs its previous AWI-derived partitions and
fragments before rebuilding them from the source AWI file. Original geometry/property
snapshots are stored on partitioned features to permit that reconstruction.

Example:
    python build_forests_awi.py --base base.geojson --out forests.geojson \\
        --add-new --awi awi_woodland.geojson --ancient-from 1200 \\
        --awi-source-out awi_source.geojson

Dependencies:
    pip install shapely
"""
import argparse
import json
import os
import re
import sys
from copy import deepcopy

from shapely.geometry import shape, mapping, MultiPolygon, GeometryCollection
from shapely.ops import unary_union

TYPE_FROM_LEAF = {"needleleaved": "conifer", "broadleaved": "broadleaf", "mixed": "mixed"}
HEIGHT = {"conifer": 14, "broadleaf": 12, "mixed": 13}
DEFAULT_OSM_FROM = 1600
MATCH_OVERLAP = 0.08
MIN_INTERSECTION_M2 = 20.0
MIN_FRAGMENT_M2 = 25.0
M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON_EQ = 111320.0

# Importer-owned fields. These are stripped when rebuilding from a previous output.
AWI_FIELDS = {
    "awi_records", "awi_count", "awi_ids", "awi_categories", "awi_map_origins",
    "awi_evidence_years", "awi_site_names", "awi_site_ids", "awi_wood_ids",
    "awi_districts", "awi_parishes", "awi_antiquity_labels", "awi_source_id",
    "awi_category", "awi_antiquity", "awi_map_origin", "awi_evidence_year",
    "awi_site_id", "awi_comp_id", "awi_wood_id", "awi_site_name", "awi_hectare",
    "awi_district", "awi_parish", "awi_grid_ref", "awi_raw", "awi_fragment",
    "awi_partitioned", "awi_partition_group", "awi_base_properties",
}


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
    geom_data = feature.get("geometry")
    if not geom_data:
        return None
    geom = shape(geom_data)
    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    return geom


def polygonal_only(geom):
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        parts = []
        for part in geom.geoms:
            if part.geom_type == "Polygon":
                parts.append(part)
            elif part.geom_type == "MultiPolygon":
                parts.extend(list(part.geoms))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return None


def area_m2(geom):
    """Approximate area in square metres for small Dunkeld-area lon/lat polygons."""
    if geom is None or geom.is_empty:
        return 0.0
    minx, miny, maxx, maxy = geom.bounds
    lat = (miny + maxy) / 2.0
    import math
    m_lon = M_PER_DEG_LON_EQ * max(0.01, abs(math.cos(lat * math.pi / 180.0)))
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
        return f"awi:{wood}" + (f":{comp}" if comp is not None else "")
    if oid is not None:
        return f"awi:oid:{oid}"
    if comp is not None:
        return f"awi:comp:{comp}"
    return f"awi:record:{index + 1}"


def classify_awi(props, roy_map_from=1750):
    code = as_text(first_value(props, "ANTIQUITY_", "antiquity_code", "ANTIQUITY")).lower()
    origin = as_text(first_value(props, "MAP_ORIGIN", "map_origin")).upper()

    match = re.search(r"(17\d{2}|18\d{2})", origin)
    evidence_year = int(match.group(1)) if match else None

    # Roy-map records are code 3 / OtherRoy. The map is evidence of presence by
    # approximately 1750, not a date of woodland establishment.
    if code == "3" or origin in {"OTHERROY", "OTHER_ROY", "ROY"} or "OTHERROY" in origin:
        category = "3"
        evidence_year = int(roy_map_from)
        history_type = "other_roy_map"
        confidence = "mapped_evidence"
        classification = "Other woodland mapped on Roy's Military Survey"
    elif code in {"1a", "2a", "1b", "2b"}:
        category = code
        if category in {"1a", "2a"}:
            history_type = "ancient_semi_natural"
            confidence = "medium_extrapolation" if evidence_year == 1750 else "low_extrapolation"
            classification = "Ancient woodland, semi-natural origin"
        else:
            history_type = "long_established_plantation_origin"
            confidence = "mapped_evidence"
            classification = "Long-established woodland, plantation origin"
    elif origin.startswith("ASNO"):
        category = "1a" if "1750" in origin else "2a" if "1860" in origin else None
        history_type = "ancient_semi_natural" if category else "other_awi_mapped"
        confidence = "medium_extrapolation" if evidence_year == 1750 else "low_extrapolation"
        classification = "Ancient woodland, semi-natural origin" if category else "Other AWI mapped woodland"
    elif origin.startswith("LEPO"):
        category = "1b" if "1750" in origin else "2b" if "1860" in origin else None
        history_type = "long_established_plantation_origin" if category else "other_awi_mapped"
        confidence = "mapped_evidence"
        classification = "Long-established woodland, plantation origin" if category else "Other AWI mapped woodland"
    else:
        category = code or None
        history_type = "other_awi_mapped" if evidence_year else "unclassified_awi"
        confidence = "mapped_evidence" if evidence_year else "unknown"
        classification = "Other AWI mapped woodland" if evidence_year else "AWI category not recognised"

    return {
        "category": category,
        "map_origin": origin or None,
        "evidence_year": evidence_year,
        "history_type": history_type,
        "confidence": confidence,
        "classification": classification,
    }


def awi_record(feature, index, ancient_from, roy_map_from):
    raw = feature.get("properties") or {}
    identity = source_identity(raw, index)
    info = classify_awi(raw, roy_map_from)

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
        display_from = info["evidence_year"] or (1750 if info["category"] == "1b" else 1860)
        date_src = f"AWI {info['category']} ({info['map_origin'] or display_from}); mapped by {display_from}"
        basis = (
            f"Plantation-origin woodland mapped by {display_from}; this is evidence of presence, "
            "not an exact planting date, and is not extrapolated to 1200."
        )
    elif info["history_type"] == "other_roy_map":
        display_from = int(roy_map_from)
        date_src = f"AWI 3 ({info['map_origin'] or 'OtherRoy'}); mapped on Roy's Military Survey (c.{display_from})"
        basis = (
            f"Woodland is represented on Roy's Military Survey (c.{display_from}); this is "
            "evidence of presence by that period, not an exact establishment date."
        )
    elif info["history_type"] == "other_awi_mapped":
        display_from = info["evidence_year"] or 2000
        date_src = f"AWI {info['category'] or 'unclassified'} ({info['map_origin'] or display_from}); mapped evidence"
        basis = f"AWI source provides mapped presence evidence by {display_from}; woodland origin is not classified here."
    else:
        display_from = 2000
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


def parse_awi_records(features, ancient_from, roy_map_from):
    records = []
    skipped = 0
    for i, feature in enumerate(features):
        if not feature.get("geometry"):
            skipped += 1
            continue
        geom = clean_geom(feature)
        if geom is None:
            skipped += 1
            continue
        rec = awi_record(feature, i, ancient_from, roy_map_from)
        records.append({"geom": geom, "record": rec, "source_feature": feature})
    return records, skipped


def append_note(old, note):
    old = as_text(old)
    if not old:
        return note
    if note in old:
        return old
    return old.rstrip("; ") + "; " + note


def set_awi_metadata(props, recs):
    """Attach only the AWI records that actually cover this particular geometry piece."""
    unique = {}
    for rec in recs:
        unique[rec["source_id"]] = rec
    records = list(unique.values())
    if not records:
        return

    props["awi_records"] = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
    props["awi_count"] = len(records)
    props["awi_ids"] = ",".join(x["source_id"] for x in records)
    props["awi_categories"] = ",".join(sorted({as_text(x.get("category")) for x in records if x.get("category")}))
    props["awi_map_origins"] = ",".join(sorted({as_text(x.get("map_origin")) for x in records if x.get("map_origin")}))
    props["awi_evidence_years"] = ",".join(str(x["evidence_year"]) for x in records if x.get("evidence_year"))

    for out_key, raw_key in (
        ("awi_site_names", "SITE_NAME"), ("awi_site_ids", "SITE_ID"),
        ("awi_wood_ids", "WOOD_ID"), ("awi_districts", "DISTRICT"),
        ("awi_parishes", "PARISH"), ("awi_antiquity_labels", "ANTIQUITY"),
    ):
        vals = sorted({as_text(x.get("raw", {}).get(raw_key)) for x in records
                       if x.get("raw", {}).get(raw_key) not in (None, "")})
        props[out_key] = " | ".join(vals) if vals else None

    props["history_basis"] = append_note(
        props.get("history_basis"), " | ".join(sorted({x["history_basis"] for x in records}))
    )
    types = {x.get("history_type") for x in records}
    if len(types) == 1:
        props["history_class"] = next(iter(types))
    else:
        props["history_class"] = "mixed_awi_evidence"
    confidences = {x.get("confidence") for x in records}
    props["history_confidence"] = next(iter(confidences)) if len(confidences) == 1 else "mixed"

    names = [as_text(x["raw"].get("SITE_NAME")) for x in records if x.get("raw", {}).get("SITE_NAME")]
    if not props.get("name") and names:
        props["name"] = names[0]


def strip_awi_fields(props):
    for key in list(props):
        if key in AWI_FIELDS or key in {"history_basis", "history_class", "history_confidence", "osm_date_src"}:
            props.pop(key, None)


def rebuild_previous_import(features, undated_osm_from):
    """Undo this import's previous fragments/partitions before applying a fresh overlay."""
    kept = []
    partition_groups = {}

    for feature in features:
        props = deepcopy(feature.get("properties") or {})
        if props.get("awi_fragment"):
            # AWI-only residual pieces are recreated from the source AWI on each run.
            continue
        group = props.get("awi_partition_group")
        if group:
            geom = clean_geom(feature)
            if geom is None:
                continue
            partition_groups.setdefault(str(group), {"geoms": [], "base": None})["geoms"].append(geom)
            if props.get("awi_base_properties") and not partition_groups[str(group)]["base"]:
                try:
                    partition_groups[str(group)]["base"] = json.loads(props["awi_base_properties"])
                except (ValueError, TypeError):
                    pass
            continue

        if props.get("awi_records") or props.get("awi_source_id"):
            old_date_src = props.get("osm_date_src")
            old_src_text = as_text(props.get("date_src"))
            strip_awi_fields(props)
            if old_date_src:
                props["date_src"] = old_date_src
                props["from_year"] = int(undated_osm_from)
            elif old_src_text.lower().startswith("awi"):
                props["date_src"] = "osm (undated: viewer fallback, not historical evidence)"
                props["from_year"] = int(undated_osm_from)

        geom = clean_geom(feature)
        kept.append({"feature": {"type": "Feature", "properties": props,
                                 "geometry": deepcopy(feature.get("geometry"))},
                     "props": props, "geom": geom, "awi_assignments": [], "is_fragment": False})

    # Reconstitute each previously partitioned original feature by unioning its pieces.
    for group, data in partition_groups.items():
        geom = polygonal_only(unary_union(data["geoms"]))
        if geom is None:
            continue
        props = data["base"] or {"id": group, "manual": False}
        props = deepcopy(props)
        feature = {"type": "Feature", "properties": props, "geometry": mapping(geom)}
        kept.append({"feature": feature, "props": props, "geom": geom,
                     "awi_assignments": [], "is_fragment": False})

    return kept


def make_awi_fragment(item, next_id):
    rec = item["record"]
    raw = rec["raw"]
    props = {
        "id": f"f{next_id:06d}",
        "name": first_value(raw, "SITE_NAME", "name"),
        "tree_type": "mixed",  # AWI records woodland origin, not current species mix
        "density": 80,
        "tree_h": 13,
        "from_year": rec["display_from"],
        "to_year": None,
        "date_src": rec["date_src"],
        "src": rec["source_id"] + ":uncovered",
        "manual": False,
        "notes": "AWI woodland polygon portion not covered by existing current forest features. "
                 "Species mix is unknown; mixed is a neutral visual default.",
        "awi_source_id": rec["source_id"],
        "awi_category": rec["category"],
        "awi_antiquity": first_value(raw, "ANTIQUITY", "ANTIQ"),
        "awi_map_origin": rec["map_origin"],
        "awi_evidence_year": rec["evidence_year"],
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
    set_awi_metadata(props, [rec])
    geom = item["geom"]
    return {"feature": {"type": "Feature", "properties": props, "geometry": mapping(geom)},
            "props": props, "geom": geom, "awi_assignments": [(rec, geom)], "is_fragment": True}


def split_entry_by_awi(entry, next_id, min_piece_m2):
    """Split a placeholder forest into non-overlapping pieces by AWI display year."""
    geom = entry["geom"]
    assignments = entry["awi_assignments"]
    props = deepcopy(entry["props"])
    if geom is None or not assignments:
        return [entry], next_id, 0

    manual = bool(props.get("manual"))
    date_src = as_text(props.get("date_src")).lower()
    placeholder = (
        "placeholder" in date_src or
        (not manual and date_src.startswith("osm") and props.get("from_year") in (None, 1600, 2000))
    )
    can_split = not manual and (placeholder or entry.get("is_fragment"))

    if not can_split:
        set_awi_metadata(props, [x[0] for x in assignments])
        f = deepcopy(entry["feature"])
        f["properties"] = props
        return [{**entry, "feature": f, "props": props}], next_id, 0

    # Group intersected AWI geometry by its intended first-visible year. Earlier
    # evidence has priority in any overlapping AWI polygons, so resulting features
    # cannot overlap one another and generate duplicate virtual trees.
    by_year = {}
    for rec, intersection in assignments:
        if intersection is not None and not intersection.is_empty:
            by_year.setdefault(int(rec["display_from"]), []).append((rec, intersection))

    remaining = geom
    pieces = []
    for year in sorted(by_year):
        year_items = by_year[year]
        year_mask = polygonal_only(unary_union([x[1] for x in year_items]))
        if year_mask is None or remaining.is_empty:
            continue
        piece = polygonal_only(remaining.intersection(year_mask))
        if piece is None or piece.is_empty:
            continue
        # Don't create tiny sliver features. Keep those slivers in the undated/base
        # remainder rather than losing geometry or allowing later dates to overlap.
        if area_m2(piece) < min_piece_m2:
            continue

        active_records = []
        for rec, _intersection in year_items:
            overlap = piece.intersection(_intersection)
            if not overlap.is_empty and area_m2(overlap) > 0.01:
                active_records.append(rec)
        if not active_records:
            continue
        pieces.append((year, piece, active_records))
        remaining = polygonal_only(remaining.difference(piece))
        if remaining is None:
            remaining = GeometryCollection()

    if not pieces:
        set_awi_metadata(props, [x[0] for x in assignments])
        f = deepcopy(entry["feature"])
        f["properties"] = props
        return [{**entry, "feature": f, "props": props}], next_id, 0

    if remaining is not None and not remaining.is_empty:
        pieces.append((None, remaining, []))

    # Keep the original feature id on the largest resulting piece; allocate new IDs
    # to the others. This preserves a stable identifier for the bulk of the feature.
    pieces.sort(key=lambda x: area_m2(x[1]), reverse=True)
    original_id = props.get("id")
    base_snapshot = json.dumps(props, ensure_ascii=False, separators=(",", ":"))
    output = []
    for index, (year, part_geom, active_records) in enumerate(pieces):
        part_props = deepcopy(props)
        part_props["id"] = original_id if index == 0 else f"f{next_id:06d}"
        if index != 0:
            next_id += 1
        if year is not None:
            part_props["from_year"] = year
            part_props["date_src"] = "; ".join(sorted({r["date_src"] for r in active_records}))
            set_awi_metadata(part_props, active_records)
        part_props["awi_partitioned"] = True
        part_props["awi_partition_group"] = str(original_id or part_props["id"])
        part_props["awi_base_properties"] = base_snapshot
        if entry.get("is_fragment"):
            part_props["awi_fragment"] = True
        feature = {"type": "Feature", "properties": part_props, "geometry": mapping(part_geom)}
        output.append({"feature": feature, "props": part_props, "geom": part_geom,
                       "awi_assignments": [], "is_fragment": entry.get("is_fragment", False)})

    return output, next_id, max(0, len(output) - 1)


def main():
    ap = argparse.ArgumentParser(description="Build / extend editable woodland tree features with spatial AWI dates.")
    ap.add_argument("--base", default="base.geojson", help="OSM/OHM base.geojson")
    ap.add_argument("--out", default="forests.geojson", help="Output forest tree features")
    ap.add_argument("--awi", help="Scottish AWI GeoJSON (optional)")
    ap.add_argument("--awi-source-out", help="Optional path to copy raw AWI GeoJSON unchanged")
    ap.add_argument("--add-new", action="store_true", help="Append missing source features and enrich existing output")
    ap.add_argument("--ancient-from", type=int, default=1200,
                    help="Timeline start for ancient semi-natural AWI woodland (default: 1200, extrapolated)")
    ap.add_argument("--roy-map-from", type=int, default=1750,
                    help="Timeline start for Other (on Roy map) AWI records (default: 1750)")
    ap.add_argument("--undated-osm-from", type=int, default=DEFAULT_OSM_FROM,
                    help=f"Viewer fallback for undated OSM woods (default: {DEFAULT_OSM_FROM})")
    ap.add_argument("--min-fragment-m2", type=float, default=MIN_FRAGMENT_M2,
                    help=f"Ignore uncovered AWI slivers smaller than this area in m² (default: {MIN_FRAGMENT_M2})")
    ap.add_argument("--min-split-piece-m2", type=float, default=MIN_FRAGMENT_M2,
                    help=f"Keep AWI split pieces at least this large (default: {MIN_FRAGMENT_M2})")
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
        features = rebuild_previous_import(old_features, a.undated_osm_from)
        for entry in features:
            props = entry["props"]
            for src in as_text(props.get("src")).split(","):
                if src:
                    known_sources.add(src)

    next_id = 1 + max([
        int(str(x["props"].get("id", ""))[1:])
        for x in features
        if str(x["props"].get("id", ""))[1:].isdigit()
    ] or [0])

    stats = {
        "osm_added": 0, "osm_skipped_known": 0, "awi_matched": 0,
        "awi_fragments_added": 0, "awi_skipped_known": 0, "awi_invalid": 0,
        "forest_features_split": 0, "split_features_created": 0,
    }

    # Add missing OSM/OHM woodland. Existing features and manual edits remain intact.
    for wood in woods:
        p = wood.get("properties") or {}
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
        geom = clean_geom(wood)
        features.append({"feature": {"type": "Feature", "properties": props,
                                     "geometry": deepcopy(wood["geometry"])},
                         "props": props, "geom": geom, "awi_assignments": [], "is_fragment": False})
        known_sources.add(src)
        next_id += 1
        stats["osm_added"] += 1

    if a.awi:
        awi_data, awi_features = load_geojson(a.awi)
        if a.awi_source_out:
            os.makedirs(os.path.dirname(os.path.abspath(a.awi_source_out)), exist_ok=True)
            with open(a.awi_source_out, "w", encoding="utf-8") as fh:
                json.dump(awi_data, fh, ensure_ascii=False, separators=(",", ":"))

        awi_records, invalid = parse_awi_records(awi_features, a.ancient_from, a.roy_map_from)
        stats["awi_invalid"] = invalid

        current_geoms = [x["geom"] for x in features
                         if x["geom"] is not None and x["props"].get("to_year") is None]
        coverage = unary_union(current_geoms) if current_geoms else None

        # Process the oldest historical claims first. This also gives ancient records
        # priority where source polygons overlap one another.
        awi_records.sort(key=lambda x: (x["record"]["display_from"], x["record"]["source_id"]))

        for item in awi_records:
            geom, rec = item["geom"], item["record"]
            if rec["source_id"] in known_sources:
                stats["awi_skipped_known"] += 1
                continue

            matched = 0
            for entry in features:
                existing_geom = entry["geom"]
                if (existing_geom is None or entry["props"].get("to_year") is not None
                        or not existing_geom.intersects(geom)):
                    continue
                intersection = polygonal_only(existing_geom.intersection(geom))
                if intersection is None or area_m2(intersection) < MIN_INTERSECTION_M2:
                    continue
                if overlap_ratio(existing_geom, geom) < MATCH_OVERLAP:
                    continue
                entry["awi_assignments"].append((rec, intersection))
                matched += 1

            if matched:
                stats["awi_matched"] += 1
                known_sources.add(rec["source_id"])

            # Add only uncovered AWI geometry, ensuring each place gets one tree layer.
            residual = polygonal_only(geom.difference(coverage)) if coverage is not None else geom
            if residual is not None and area_m2(residual) >= a.min_fragment_m2:
                fragment = make_awi_fragment({"record": rec, "geom": residual}, next_id)
                features.append(fragment)
                next_id += 1
                stats["awi_fragments_added"] += 1
                known_sources.add(rec["source_id"])
                coverage = unary_union([coverage, residual]) if coverage is not None else residual
            elif matched == 0:
                # Avoid repeatedly reconsidering a source represented only by a tiny sliver.
                known_sources.add(rec["source_id"])

    # Finally partition every eligible forest by the AWI dates of the pieces covering it.
    partitioned = []
    for entry in features:
        new_entries, next_id, made = split_entry_by_awi(entry, next_id, a.min_split_piece_m2)
        if made:
            stats["forest_features_split"] += 1
            stats["split_features_created"] += made
        partitioned.extend(new_entries)

    out_features = []
    for entry in partitioned:
        feature = entry["feature"]
        feature["properties"] = entry["props"]
        # Keep unchanged source geometries byte-for-byte where possible; split pieces
        # and AWI residuals use the calculated polygon geometry.
        if entry.get("geom") is not None and (entry["props"].get("awi_partitioned") or entry.get("is_fragment")):
            feature["geometry"] = mapping(entry["geom"])
        out_features.append(feature)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": out_features},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(out_features)} forest features to {a.out}")
    print("  " + " | ".join(f"{key}: {value}" for key, value in stats.items()))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        sys.exit(f"ERROR: {exc}")
