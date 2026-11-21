#!/usr/bin/env python3
"""Build assets/json/eats.json for the /eats/ page from a Beli data export.

usage
    python3 bin/build_eats.py ~/Downloads/<your>_data_export.zip

requirements (analysis only, not needed to build the site)
    pip install pandas numpy scipy statsmodels scikit-learn vaderSentiment

What it reads: rankings.csv, bookmarks.csv, notes_dishes.csv, photos.csv and the
export date from export_details.csv, straight out of the zip. It never opens the
other files in the export (payments, devices, profile, follows, reservations,
comments). What it writes is numbers and place names only: no note text, photo
URLs, emails or phone numbers.

Cities need coordinates. They come from bin/eats_cities.json; if a new city shows
up the script stops and tells you to run bin/match_eats_cities.py first.

Modelling choices were fixed before looking at any results (see ANALYSIS NOTES).

ANALYSIS NOTES
* Beli rankings are ordinal and per category (restaurants, bakeries, coffee, dessert,
  bars each have their own #1). The outcome is the rank percentile score
  100 * (1 - (rank - 1) / (N_category - 1)): 100 = my #1, 0 = my last.
* Predictors: outside the US, New York City, years since the first entry, whether the
  place has a note, note sentiment (VADER with a small food-review lexicon), note
  length, photo count, a favourite-dish photo, plus category fixed effects.
* OLS with HC3 robust standard errors; 95% CIs. Also a restaurants-only version, Spearman
  correlations, and repeated 10-fold cross-validated R^2 for out-of-sample predictability.
* This is exploratory: observational, modest n, no causal claims.
"""
import argparse
import io
import json
import math
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS
from sklearn.model_selection import RepeatedKFold
from statsmodels.nonparametric.smoothers_lowess import lowess
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

HERE = Path(__file__).resolve().parent
CATS = {"RES": "Restaurants", "BAK": "Bakeries", "COF": "Coffee", "DES": "Dessert", "BAR": "Bars"}
NEEDED = ["rankings.csv", "bookmarks.csv", "notes_dishes.csv", "photos.csv", "export_details.csv"]
SEED = 20261028

# A small food-review lexicon on top of VADER, chosen before looking at any rankings.
LEXICON = {
    "mid": -1.5, "forgettable": -2.0, "overpriced": -1.8, "bland": -1.8, "meh": -1.2,
    "underwhelming": -2.0, "average": -0.8, "mediocre": -1.5, "soggy": -1.5, "dry": -1.2,
    "greasy": -1.0, "pricey": -0.8, "overrated": -1.8, "skip": -1.2, "lukewarm": -1.0,
    "touristy": -0.8, "standout": 1.8, "obsessed": 2.0, "craving": 1.2, "comforting": 1.2,
    "flavorful": 1.8, "juicy": 1.2, "crispy": 1.0, "nailed": 1.8, "elite": 1.8, "banger": 2.0,
}

# Rough cuisine tags inferred from restaurant names (restaurants only; most names carry no hint).
CUISINES = {
    "Pizza": r"pizz|pie\b|slice",
    "Japanese": r"sushi|ramen|izakaya|udon|omakase|yakitori|tonkatsu|japan|soba|katsu",
    "Italian": r"trattoria|osteria|pasta|ristorante|italian|enoteca|\bcarbone|rigatoni",
    "Mexican": r"taco|taqueria|mexic|cantina|burrito|cocina|mezcal",
    "Indian & South Asian": r"indian|tandoor|curry|biryani|masala|chaat|kabob|kebab|afghan|bamiyan|punjab|pakistan",
    "Chinese": r"dim sum|noodle|dumpling|szechuan|sichuan|peking|hunan|chinese|\bwok\b|hot pot|hotpot",
    "Korean": r"korean|kbbq|galbi|bulgogi|\bkorea",
    "Southeast Asian": r"thai|\bpho\b|banh|vietnam|bangkok|\bsiam\b|filipino",
    "Burgers": r"burger|shake shack|smash",
    "Seafood": r"oyster|seafood|fish|lobster|crab|raw bar|\bsea\b",
    "Steak": r"steak|chophouse|butcher",
    "Mediterranean": r"mediterran|halal|falafel|shawarma|hummus|greek|turk|lebanese|gyro|souvla|\bpita\b|levant",
}


def load_zip_or_dir(src):
    src = Path(src).expanduser()
    frames = {}
    if src.is_dir():
        for n in NEEDED:
            frames[n] = pd.read_csv(src / n)
    else:
        with zipfile.ZipFile(src) as z:
            for n in NEEDED:  # only these members are ever opened
                with z.open(n) as f:
                    frames[n] = pd.read_csv(io.BytesIO(f.read()))
    return frames


def key(name, city):
    return name.astype(str).str.strip().str.lower() + "|" + city.astype(str).str.strip().str.lower()


def zscore(v, mask):
    """z-score using only masked rows; unmasked rows get 0 (the mean)."""
    out = np.zeros(len(v))
    m = v[mask].mean()
    s = v[mask].std(ddof=0)
    out[mask] = (v[mask] - m) / (s if s > 0 else 1)
    return out


def tokens(text):
    words = re.findall(r"[a-z][a-z']+", text.lower())
    return {w.replace("'s", "").strip("'") for w in words}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export", help="Beli export .zip (or an extracted folder)")
    ap.add_argument("--cities", default=str(HERE / "eats_cities.json"))
    ap.add_argument("--out", default=str(HERE.parent / "assets" / "json" / "eats.json"))
    args = ap.parse_args()

    rng = np.random.default_rng(SEED)
    fr = load_zip_or_dir(args.export)

    # ---------------------------------------------------------------- rankings
    rk = fr["rankings.csv"].rename(columns={"Restaurant Name": "name", "City": "city", "Category": "cat", "Rank": "rank"})
    rk["created"] = pd.to_datetime(rk["Created Date"], utc=True)
    rk["key"] = key(rk["name"], rk["city"])
    n_cat = rk.groupby("cat")["rank"].transform("max")
    rk["score"] = 100 * (1 - (rk["rank"] - 1) / (n_cat - 1))
    t0 = rk["created"].min()
    rk["years"] = (rk["created"] - t0).dt.total_seconds() / (365.25 * 86400)
    rk["month"] = rk["created"].dt.strftime("%Y-%m")

    # ------------------------------------------------------------------ cities
    cities_tbl = {c["city"]: c for c in json.load(open(args.cities, encoding="utf-8"))}
    bm = fr["bookmarks.csv"].rename(columns={"Business Name": "name", "City": "city", "Category": "cat"})
    unknown = sorted((set(rk["city"].str.strip()) | set(bm["city"].str.strip())) - set(cities_tbl))
    if unknown:
        sys.exit(f"cities missing coordinates: {unknown}\nrun bin/match_eats_cities.py first")
    rk["city"] = rk["city"].str.strip()
    bm["city"] = bm["city"].str.strip()
    rk["cc"] = rk["city"].map(lambda c: cities_tbl[c]["cc"])

    # ------------------------------------------------------------- notes, photos
    nt = fr["notes_dishes.csv"].rename(columns={"Business Name": "name", "City": "city", "Field Type": "ftype", "Note Text": "text"})
    nt["key"] = key(nt["name"], nt["city"])
    notes = nt[nt["ftype"] == "Notes"].drop_duplicates("key").set_index("key")["text"].fillna("")
    favs = nt[nt["ftype"] == "Favorite Dishes"].drop_duplicates("key").set_index("key")["text"].fillna("")

    ph = fr["photos.csv"].rename(columns={"Business Name": "name", "City": "city"})
    ph["key"] = key(ph["name"], ph["city"])
    n_photos = ph.groupby("key").size()
    fav_photo = ph[ph["Is Favorite Dish"].astype(str).str.lower() == "true"].groupby("key").size()

    rk["note"] = rk["key"].map(notes).fillna("")
    rk["has_note"] = (rk["note"].str.len() > 0).astype(float)
    rk["n_photos"] = rk["key"].map(n_photos).fillna(0)
    rk["fav_photo"] = (rk["key"].map(fav_photo).fillna(0) > 0).astype(float)

    vader = SentimentIntensityAnalyzer()
    vader.lexicon.update(LEXICON)
    rk["sent_raw"] = rk["note"].map(lambda t: vader.polarity_scores(t)["compound"] if t else 0.0)
    rk["len_raw"] = np.log1p(rk["note"].str.len())

    has = rk["has_note"].to_numpy() == 1
    rk["z_sent"] = zscore(rk["sent_raw"].to_numpy(), has)
    rk["z_len"] = zscore(rk["len_raw"].to_numpy(), has)
    lp = np.log1p(rk["n_photos"].to_numpy())
    rk["z_photos"] = (lp - lp.mean()) / lp.std(ddof=0)
    rk["intl"] = (rk["cc"] != "US").astype(float)
    rk["nyc"] = (rk["city"] == "New York, NY").astype(float)

    # ------------------------------------------------------------- regressions
    PRED = [
        ("intl", "Outside the US", "difference vs. US places"),
        ("nyc", "New York City", "difference vs. other places in the US"),
        ("years", "Later in my Beli life", "per additional year of logging"),
        ("z_sent", "Warmer note", "per +1 SD of note sentiment"),
        ("z_len", "Longer note", "per +1 SD of note length"),
        ("z_photos", "More photos", "per +1 SD of (log) photo count"),
        ("fav_photo", "Favourite-dish photo", "difference vs. none"),
        ("has_note", "Wrote a note at all", "difference vs. no note"),
    ]
    cols = [p[0] for p in PRED]

    def design(df, with_cat):
        X = df[cols].astype(float).copy()
        if with_cat:
            for c in list(CATS)[1:]:
                X["cat_" + c] = (df["cat"] == c).astype(float)
        return X

    def fit(df, with_cat):
        X = design(df, with_cat)
        res = sm.OLS(df["score"].astype(float), sm.add_constant(X)).fit(cov_type="HC3")
        out = []
        for key_, label, unit in PRED:
            b = float(res.params[key_])
            lo, hi = [float(v) for v in res.conf_int().loc[key_]]
            out.append({"key": key_, "label": label, "unit": unit, "b": round(b, 2), "lo": round(lo, 2),
                        "hi": round(hi, 2), "p": round(float(res.pvalues[key_]), 4),
                        "n1": int(df[key_].astype(float).gt(0).sum()) if key_ in ("intl", "nyc", "fav_photo", "has_note") else None})
        return out, res

    coef_all, res_all = fit(rk, True)
    res_df = rk[rk["cat"] == "RES"]
    coef_res, _ = fit(res_df, False)

    # out-of-sample predictability (repeated 10-fold CV, same linear model)
    X = sm.add_constant(design(rk, True)).to_numpy()
    y = rk["score"].to_numpy(float)
    r2s, rhos = [], []
    for tr, te in RepeatedKFold(n_splits=10, n_repeats=20, random_state=SEED).split(X):
        beta = np.linalg.lstsq(X[tr], y[tr], rcond=None)[0]
        pred = X[te] @ beta
        ss_res = ((y[te] - pred) ** 2).sum()
        ss_tot = ((y[te] - y[te].mean()) ** 2).sum()
        r2s.append(1 - ss_res / ss_tot)
        rhos.append(stats.spearmanr(y[te], pred)[0])
    fit_stats = {
        "n": int(len(rk)), "r2_in": round(float(res_all.rsquared), 3), "r2_cv": round(float(np.mean(r2s)), 3),
        "r2_cv_sd": round(float(np.std(r2s)), 3), "rho_cv": round(float(np.nanmean(rhos)), 3),
    }

    # Spearman correlations (rank-based, no linearity assumption)
    def sp(x, mask=None):
        m = np.ones(len(rk), bool) if mask is None else mask
        r, p = stats.spearmanr(rk.loc[m, "score"], x[m])
        return {"rho": round(float(r), 3), "p": round(float(p), 4), "n": int(m.sum())}

    spearman = {
        "years": sp(rk["years"].to_numpy()),
        "sentiment": sp(rk["sent_raw"].to_numpy(), has),
        "note_length": sp(rk["len_raw"].to_numpy(), has),
        "photos": sp(rk["n_photos"].to_numpy()),
    }

    # lowess curves with bootstrap bands, for the two scatter plots
    def smooth(xcol, mask, grid_n=30, frac=0.6, B=300):
        d = rk.loc[mask, [xcol, "score"]].to_numpy(float)
        grid = np.linspace(np.percentile(d[:, 0], 2), np.percentile(d[:, 0], 98), grid_n)
        line = lowess(d[:, 1], d[:, 0], frac=frac, xvals=grid)
        boot = np.empty((B, grid_n))
        for i in range(B):
            idx = rng.integers(0, len(d), len(d))
            boot[i] = lowess(d[idx, 1], d[idx, 0], frac=frac, xvals=grid)
        lo, hi = np.nanpercentile(boot, [2.5, 97.5], axis=0)
        return [[round(float(g), 3), round(float(a), 1), round(float(b), 1), round(float(c), 1)]
                for g, a, b, c in zip(grid, line, lo, hi)]

    curves = {
        "years": smooth("years", np.ones(len(rk), bool)),
        "sentiment": smooth("sent_raw", has),
    }

    # ----------------------------------------------- words in loved vs. mid places
    top_g, bot_g = has & (rk["score"] >= 66.7).to_numpy(), has & (rk["score"] <= 33.3).to_numpy()
    docs = rk["note"].map(tokens)
    stop = set(ENGLISH_STOP_WORDS) | {"also", "got", "get", "one", "would", "though", "bit", "lot"}
    c_top, c_bot = Counter(), Counter()
    for d in docs[top_g]:
        c_top.update(w for w in d if w not in stop and len(w) > 2)
    for d in docs[bot_g]:
        c_bot.update(w for w in d if w not in stop and len(w) > 2)
    n_top, n_bot = int(top_g.sum()), int(bot_g.sum())
    vocab = {w for w in set(c_top) | set(c_bot) if c_top[w] + c_bot[w] >= 8}
    a0 = 20.0
    total = sum(c_top[w] + c_bot[w] for w in vocab)
    words = []
    for w in vocab:
        aw = a0 * (c_top[w] + c_bot[w]) / total
        y1, y2 = c_top[w], c_bot[w]
        d1 = math.log((y1 + aw) / (n_top + a0 - y1 - aw)) - math.log((y2 + aw) / (n_bot + a0 - y2 - aw))
        z = d1 / math.sqrt(1 / (y1 + aw) + 1 / (y2 + aw))
        words.append({"w": w, "z": round(z, 2), "top": y1, "bot": y2})
    words.sort(key=lambda r: r["z"])
    word_out = {"n_top": n_top, "n_bottom": n_bot,
                "loved": [r for r in words[::-1][:14]], "mid": [r for r in words[:14]]}

    # ----------------------------------------------------------------- cuisines
    res_names = res_df["name"].str.lower()
    cuisine_rows = []
    tagged = pd.Series(False, index=res_df.index)
    for label, pat in CUISINES.items():
        m = res_names.str.contains(pat, regex=True)
        tagged |= m
        s = res_df.loc[m, "score"].to_numpy(float)
        if len(s) < 5:  # smaller groups are too noisy to show
            continue
        # t-interval: bootstrap percentile intervals are too narrow for groups this small
        half = stats.t.ppf(0.975, len(s) - 1) * s.std(ddof=1) / math.sqrt(len(s))
        cuisine_rows.append({"label": label, "n": int(len(s)), "mean": round(float(s.mean()), 1),
                             "lo": round(float(s.mean() - half), 1),
                             "hi": round(float(s.mean() + half), 1)})
    cuisine_rows.sort(key=lambda r: -r["mean"])
    cuisines = {"rows": cuisine_rows, "coverage": round(float(tagged.mean()), 2),
                "baseline": round(float(res_df["score"].mean()), 1)}

    # ------------------------------------------------------------- places, cities
    city_list = sorted(set(rk["city"]) | set(bm["city"]))
    idx = {c: i for i, c in enumerate(city_list)}
    want = Counter(bm["city"])
    ranked_n = Counter(rk["city"])
    cities_out = [{"city": c, "lat": cities_tbl[c]["lat"], "lng": cities_tbl[c]["lng"], "cc": cities_tbl[c]["cc"],
                   "ranked": ranked_n.get(c, 0), "want": want.get(c, 0)} for c in city_list]

    places = []
    for r in rk.sort_values(["cat", "rank"]).itertuples():
        p = {"n": r.name, "c": idx[r.city], "k": r.cat, "r": int(r.rank), "s": round(float(r.score), 1),
             "d": r.month, "y": round(float(r.years), 2)}
        if r.has_note:
            p["v"] = round(float(r.sent_raw), 2)
        if r.n_photos:
            p["ph"] = int(r.n_photos)
        dish = favs.get(r.key)
        if isinstance(dish, str) and 0 < len(dish) <= 60:  # short, dish-only entries
            p["f"] = dish
        places.append(p)

    export_date = str(fr["export_details.csv"]["export_date"].iloc[0])[:10]
    out = {
        "asOf": export_date,
        "start": t0.strftime("%Y-%m-%d"),  # date of the first ranked entry (x = 0 for the "years" axis)
        "categories": [{"k": k, "label": v, "n": int((rk["cat"] == k).sum())} for k, v in CATS.items()],
        "cities": cities_out,
        "places": places,
        "wantTotal": int(len(bm)),
        "analysis": {
            "fit": fit_stats, "coef": coef_all, "coefRestaurants": coef_res, "spearman": spearman,
            "curves": curves, "words": word_out, "cuisines": cuisines,
            "method": {
                "outcome": "rank percentile within category (100 = my #1, 0 = my last)",
                "model": "OLS, HC3 robust SEs, 95% CI, category fixed effects",
                "sentiment": "VADER compound + small food-review lexicon",
            },
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {args.out}  ({Path(args.out).stat().st_size / 1024:.0f} KB, {len(places)} places, {len(cities_out)} cities)")
    print("fit:", fit_stats)


if __name__ == "__main__":
    main()
