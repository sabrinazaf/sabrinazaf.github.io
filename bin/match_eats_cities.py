"""Match Beli city strings to coordinates using the public GeoNames cities500 dump.

usage (when build_eats.py reports cities missing coordinates):
    1. unzip rankings.csv and bookmarks.csv from the Beli export into a folder
    2. download https://download.geonames.org/export/dump/cities500.zip and unzip it
    3. python3 bin/match_eats_cities.py <folder> <path/to/cities500.txt> bin/eats_cities.json

Only city names are looked up locally; nothing is sent over the network. Places GeoNames
does not list (tiny or unincorporated) go in MANUAL below with approximate coordinates.
"""
import csv
import json
import sys
import unicodedata

beli_dir, gn_path, out_path = sys.argv[1:4]

# International cities appear in Beli without a state, so give the country explicitly.
COUNTRY_HINT = {
    "Nice": "FR", "Antibes": "FR", "Menton": "FR", "Beaune": "FR", "Paris": "FR",
    "Lisbon": "PT", "Bol": "HR", "Hvar": "HR", "Makarska": "HR", "Kaštel Gomilica": "HR",
    "London": "GB", "Ormskirk": "GB", "Seoul": "KR", "Busan": "KR", "Tokyo": "JP",
    "Shibuya": "JP", "Osaka": "JP", "Nara": "JP", "Shanghai": "CN", "Mexico City": "MX",
    "Cabo San Lucas": "MX", "Rome": "IT", "Florence": "IT", "Venice": "IT",
    "Cagliari": "IT", "Olang": "IT", "Copenhagen": "DK", "Marrakech": "MA",
    "George Town": "KY",
}

# Not present in GeoNames at this granularity (or ambiguous): coordinates set by hand.
MANUAL = {
    "Washington, VA": (38.7132, -78.1595, "US"),     # Washington, Rappahannock County
    "Cuauhtémoc": (19.4326, -99.1500, "MX"),         # Cuauhtémoc borough, Mexico City
    "Grand Cayman": (19.3133, -81.2546, "KY"),       # island centre (George Town area)
    # Unincorporated places missing from cities500; approximate centres (+/- ~2 km is
    # irrelevant at city-level map scale).
    "Concordville, PA": (39.8893, -75.5360, "US"),   # Concord Twp, Delaware Co.
    "Newtown Square, PA": (39.9887, -75.4099, "US"),
    "Potomac Falls, VA": (39.0807, -77.3800, "US"),  # Loudoun Co., just N of Sterling
}

# Coarse state bounding boxes (south, west, north, east) used to catch mis-matched cities.
STATE_BBOX = {
    "NY": (40.4, -79.8, 45.1, -71.8), "NJ": (38.9, -75.6, 41.4, -73.8),
    "PA": (39.7, -80.6, 42.3, -74.6), "VA": (36.5, -83.7, 39.5, -75.2),
    "DC": (38.7, -77.2, 39.0, -76.9), "CA": (32.5, -124.5, 42.1, -114.1),
    "MA": (41.2, -73.6, 42.9, -69.9), "FL": (24.4, -87.7, 31.1, -79.9),
    "IL": (36.9, -91.6, 42.6, -87.0), "NV": (35.0, -120.1, 42.1, -114.0),
    "TN": (34.9, -90.4, 36.7, -81.6), "CO": (36.9, -109.1, 41.1, -102.0),
}


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


# load GeoNames rows once, indexed by normalised name / alternate name
by_name = {}
with open(gn_path, encoding="utf-8", newline="") as f:
    for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
        gid, name, ascii_name, alts, lat, lng, fclass, fcode, cc, _cc2, adm1, _a2, _a3, _a4, pop = row[:15]
        rec = {"gid": gid, "name": name, "lat": float(lat), "lng": float(lng), "cc": cc,
               "adm1": adm1, "pop": int(pop or 0), "fcode": fcode}
        keys = {norm(name), norm(ascii_name)}
        for a in alts.split(","):
            if a:
                keys.add(norm(a))
        rec["primary"] = {norm(name), norm(ascii_name)}
        for k in keys:
            by_name.setdefault(k, []).append(rec)


def lookup(city):
    """returns (lat, lng, cc, note)"""
    if city in MANUAL:
        lat, lng, cc = MANUAL[city]
        return lat, lng, cc, "manual"
    if "," in city:
        name, st = [p.strip() for p in city.rsplit(",", 1)]
        cc, adm1 = "US", st
    else:
        name, cc, adm1 = city, COUNTRY_HINT.get(city), None
        if cc is None:
            return None
    cands = [r for r in by_name.get(norm(name), []) if r["cc"] == cc and (adm1 is None or r["adm1"] == adm1)]
    if not cands:
        return None
    # prefer places whose primary name equals the query, then population
    cands.sort(key=lambda r: (norm(name) in r["primary"], r["pop"]), reverse=True)
    r = cands[0]
    return r["lat"], r["lng"], r["cc"], f'{r["name"]} ({r["adm1"]}) pop {r["pop"]}'


cities = {}
for fname, col in (("rankings.csv", "City"), ("bookmarks.csv", "City")):
    with open(f"{beli_dir}/{fname}", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            cities[row[col].strip()] = None

out, missing = [], []
for c in sorted(cities):
    res = lookup(c)
    if res is None:
        missing.append(c)
        continue
    lat, lng, cc, note = res
    if cc == "US" and "," in c:
        st = c.rsplit(",", 1)[1].strip()
        s, w, n, e = STATE_BBOX[st]
        assert s <= lat <= n and w <= lng <= e, f"{c} placed outside {st}: {lat},{lng}"
    out.append({"city": c, "lat": round(lat, 4), "lng": round(lng, 4), "cc": cc})
    print(f"{c:24s} -> {lat:9.4f} {lng:10.4f} {cc}  {note}")

print("\nUNMATCHED:", missing)
json.dump(out, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("matched", len(out), "of", len(cities))
