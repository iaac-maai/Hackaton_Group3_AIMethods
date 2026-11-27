"""Extract the deployed keypoint run's results from the saved outputs of keypoint_anomaly.ipynb.

The notebook's saved outputs come from the run whose model was exported to models/keypoint/model.onnx and
published to Hugging Face (see evaluate_deployed_keypoint.py: re-scoring that ONNX reproduces the notebook's
validation MSE 0.207885 and threshold 0.65884). Nothing is re-run here; the values are parsed from the
notebook JSON as saved in Git.

Writes:
  reports/keypoint/deployed_run_training_history.csv  pmin, setup, epoch, train_mse, val_mse (cell 8 log)
  reports/keypoint/deployed_run_setups_table.csv      setups A-C and the two reference methods (cell 10 table)

Run from the repository root:  python 01_autoencoder/extract_notebook_results.py
"""
import csv
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "01_autoencoder" / "keypoint_anomaly.ipynb"
OUT_DIR = ROOT / "reports" / "keypoint"

EPOCH_RE = re.compile(r"^(?P<setup>.+?) \| epoch (?P<epoch>\d+) \| train (?P<train>[\d.]+) \| val (?P<val>[\d.]+)$")
PMIN_RE = re.compile(r"^pmin=(?P<pmin>[\d.]+):")


def cell_by_source(cells, needle):
    matches = [c for c in cells if needle in "".join(c.get("source", []))]
    if len(matches) != 1:
        raise SystemExit(f"expected one cell containing {needle!r}, found {len(matches)}")
    return matches[0]


def main() -> None:
    cells = json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]

    # Training log (cell 8): one line per epoch, per setup, per pmin run, in run order.
    train_cell = cell_by_source(cells, "experiments={p:run(p) for p in PMIN_RUNS}")
    rows, pmin = [], None
    for out in train_cell.get("outputs", []):
        if out.get("output_type") != "stream":
            continue
        for line in "".join(out["text"]).splitlines():
            if m := PMIN_RE.match(line):
                pmin = m["pmin"]
            elif m := EPOCH_RE.match(line.strip()):
                rows.append({"pmin": pmin, "setup": m["setup"], "epoch": int(m["epoch"]),
                             "train_mse": m["train"], "val_mse": m["val"]})
    if not rows or any(r["pmin"] is None for r in rows):
        raise SystemExit("no training log found")
    with open(OUT_DIR / "deployed_run_training_history.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["pmin", "setup", "epoch", "train_mse", "val_mse"])
        w.writeheader(); w.writerows(rows)

    # Setups table (cell 10): the DataFrame's saved HTML output.
    table_cell = cell_by_source(cells, 'default["results"].to_csv(REPORT_DIR/"setups_table.csv"')
    page = next("".join(o["data"]["text/html"]) for o in table_cell["outputs"] if "text/html" in o.get("data", {}))
    cells_of = lambda row, tag: [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                                 for c in re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", row, re.S)]
    trs = re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S)
    header = cells_of(trs[0], "th")[1:]   # drop the index column
    body = [cells_of(tr, "td") for tr in trs[1:] if "<td" in tr]
    with open(OUT_DIR / "deployed_run_setups_table.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in body:
            w.writerow(["" if v == "NaN" else v for v in r])

    print(f"training history: {len(rows)} epoch rows; setups table: {len(body)} rows, columns {header}")


if __name__ == "__main__":
    main()
