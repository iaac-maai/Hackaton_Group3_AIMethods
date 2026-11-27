"""Draw the README figures for the deployed keypoint autoencoder from saved artifacts only.

Inputs (all in reports/keypoint/):
  deployed_run_training_history.csv  from extract_notebook_results.py (notebook training log)
  deployed_run_setups_table.csv      from extract_notebook_results.py (notebook results table)
  deployed_window_errors.csv         from evaluate_deployed_keypoint.py (deployed ONNX re-scored)
  deployed_eval_summary.json         from evaluate_deployed_keypoint.py
and models/keypoint/config.json (the deployed threshold).

Writes docs/images/model/keypoint_training_loss.png, keypoint_setup_comparison.png, keypoint_test_errors.png.
Run from the repository root:  python 01_autoencoder/make_readme_figures.py
"""
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REP = ROOT / "reports" / "keypoint"
OUT = ROOT / "docs" / "images" / "model"

INK, MUTED, GRID = "#1f2328", "#59636e", "#d8dee4"
DEPLOYED, OTHER, REF = "#d9480f", "#4c6ef5", "#868e96"
REF_COL, CMP_COL = "#4c6ef5", "#d9480f"

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 11, "axes.edgecolor": GRID, "axes.labelcolor": INK,
    "axes.titlecolor": INK, "xtick.color": MUTED, "ytick.color": MUTED, "axes.grid": True,
    "grid.color": GRID, "grid.linewidth": 0.7, "axes.spines.top": False, "axes.spines.right": False,
    "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
})


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def footer(fig, text: str) -> None:
    fig.text(0.01, 0.012, text, fontsize=8.5, color=MUTED, ha="left", va="bottom")


def training_loss() -> None:
    hist = [r for r in read_csv(REP / "deployed_run_training_history.csv") if r["pmin"] == "0.02"]
    setups = ["A Dense, latent 16", "B Conv1d, latent 16", "C Conv1d, latent 8"]
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2), sharey=True)
    for ax, name in zip(axes, setups):
        rows = [r for r in hist if r["setup"] == name]
        ep = np.array([int(r["epoch"]) for r in rows])
        tr = np.array([float(r["train_mse"]) for r in rows]); va = np.array([float(r["val_mse"]) for r in rows])
        col = DEPLOYED if name.startswith("A") else OTHER
        ax.plot(ep, tr, color=col, lw=2, label="training MSE")
        ax.plot(ep, va, color=col, lw=2, ls="--", label="validation MSE")
        best = int(np.argmin(va))
        ax.scatter([ep[best]], [va[best]], s=46, color=col, zorder=3)
        ax.annotate(f"kept: epoch {ep[best]}\nval {va[best]:.4f}", (ep[best], va[best]), xytext=(-8, 26),
                    textcoords="offset points", ha="right", fontsize=9, color=INK,
                    arrowprops={"arrowstyle": "-", "color": MUTED, "lw": 0.8})
        ax.set_title(name + ("  (deployed)" if name.startswith("A") else ""), fontsize=11.5,
                     fontweight="bold" if name.startswith("A") else "normal")
        ax.set_xlabel("epoch")
        ax.set_xlim(0, 41)
    axes[0].set_ylabel("reconstruction MSE (standardized units)")
    axes[0].legend(frameon=False, loc="upper right")
    fig.suptitle("Keypoint autoencoders: training and validation loss per epoch (pmin = 0.02)", x=0.01, ha="left",
                 fontsize=13, fontweight="bold", color=INK)
    footer(fig, "Training = reference-task windows (tasks 13–15) of users 1–9, 1,473 windows; validation = users 10–11, "
                "225 windows.\nTraining MSE is the mean over each epoch's mini-batches; the weights from the epoch with the "
                "lowest validation MSE are kept.\nSource: training log saved in 01_autoencoder/keypoint_anomaly.ipynb "
                "(cell 8) → reports/keypoint/deployed_run_training_history.csv")
    fig.tight_layout(rect=(0, 0.14, 1, 0.94))
    fig.savefig(OUT / "keypoint_training_loss.png", dpi=150)
    plt.close(fig)


def setup_comparison() -> None:
    table = read_csv(REP / "deployed_run_setups_table.csv")
    short = {"A Dense, latent 16": "A  Dense, latent 16 (deployed)", "B Conv1d, latent 16": "B  Conv1d, latent 16",
             "C Conv1d, latent 8": "C  Conv1d, latent 8", "Reference: PCA, 8 components": "Reference: PCA, 8 components",
             "Reference: pose deviation": "Reference: pose deviation"}
    names = [short[r["Setup"]] for r in table]
    colors = [DEPLOYED if r["Setup"].startswith("A") else REF if r["Setup"].startswith("Reference") else OTHER for r in table]
    auc = [float(r["Test ROC AUC"]) for r in table]
    val = [float(r["Val MSE (normal)"]) if r["Val MSE (normal)"] else None for r in table]

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(14, 4.8), sharey=True)
    y = np.arange(len(names))[::-1]
    a1.barh(y, auc, color=colors, height=0.6)
    for yi, v in zip(y, auc):
        a1.text(v + 0.006, yi, f"{v:.3f}", va="center", fontsize=10, color=INK)
    a1.axvline(0.5, color=MUTED, lw=1, ls=":")
    a1.text(0.503, y[0] + 0.45, "chance", fontsize=8.5, color=MUTED)
    a1.set_xlim(0.45, 0.9); a1.set_yticks(y, names)
    a1.set_title("Test ROC AUC  —  higher is better", loc="left", fontsize=11.5, fontweight="bold")
    a1.set_xlabel("separation of comparison from reference test windows")

    for yi, v, c in zip(y, val, colors):
        if v is None:
            a2.text(0.005, yi, "n/a (no reconstruction)", va="center", fontsize=9.5, color=MUTED)
        else:
            a2.barh(yi, v, color=c, height=0.6)
            a2.text(v + 0.005, yi, f"{v:.4f}", va="center", fontsize=10, color=INK)
    a2.set_xlim(0, 0.38)
    a2.set_title("Validation MSE  —  lower is better", loc="left", fontsize=11.5, fontweight="bold")
    a2.set_xlabel("mean reconstruction error, reference windows of users 10–11")
    fig.suptitle("Setups A–C against two reference methods (pmin = 0.02)", x=0.01, ha="left", fontsize=13,
                 fontweight="bold", color=INK)
    footer(fig, "Test = held-out users 12–13: 396 windows (148 reference-task, 248 comparison-task). Validation = users 10–11, "
                "225 reference-task windows. The model was chosen on validation MSE only.\nSource: results table saved in "
                "01_autoencoder/keypoint_anomaly.ipynb (cell 10) → reports/keypoint/deployed_run_setups_table.csv; "
                "A and both references re-checked in reports/keypoint/deployed_eval_summary.json")
    fig.tight_layout(rect=(0, 0.1, 1, 0.94), w_pad=4)
    fig.savefig(OUT / "keypoint_setup_comparison.png", dpi=150)
    plt.close(fig)


def test_errors() -> None:
    rows = [r for r in read_csv(REP / "deployed_window_errors.csv") if r["split"] == "test"]
    err = np.array([float(r["mse"]) for r in rows]); lab = np.array([int(r["label"]) for r in rows])
    cut = float(json.loads((ROOT / "models" / "keypoint" / "config.json").read_text(encoding="utf-8"))["threshold_mse"])
    summ = json.loads((REP / "deployed_eval_summary.json").read_text(encoding="utf-8"))["deployed_config_threshold"]
    cm = summ["confusion"]
    assert abs(summ["threshold"] - cut) < 1e-12

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.6), gridspec_kw={"width_ratios": [2.1, 1]})
    bins = np.logspace(np.log10(err.min() * 0.9), np.log10(err.max() * 1.1), 36)
    a1.hist(err[lab == 0], bins=bins, color=REF_COL, alpha=0.75, label=f"reference tasks 13–15 ({(lab == 0).sum()} windows)")
    a1.hist(err[lab == 1], bins=bins, color=CMP_COL, alpha=0.6, label=f"comparison tasks 7, 8, 11, 12 ({(lab == 1).sum()} windows)")
    a1.axvline(cut, color=INK, lw=2, ls="--")
    top = a1.get_ylim()[1]
    a1.annotate(f"deployed threshold\nMSE {cut:.4f}", (cut, top * 0.55), xytext=(cut * 1.6, top * 0.6), fontsize=9.5,
                color=INK, va="center", bbox={"boxstyle": "round,pad=0.3", "fc": "white", "ec": GRID},
                arrowprops={"arrowstyle": "->", "color": INK, "lw": 1})
    a1.set_xscale("log")
    a1.set_xlabel("reconstruction MSE per 1.92 s window (log scale); above the threshold = flagged")
    a1.set_ylabel("windows")
    a1.legend(frameon=False, loc="upper left", fontsize=9.5)
    a1.set_title("Test-window reconstruction error, deployed model", loc="left", fontsize=11.5, fontweight="bold")

    m = np.array([[cm["tn"], cm["fp"]], [cm["fn"], cm["tp"]]])
    a2.imshow(m, cmap="Oranges", vmin=0, vmax=m.max() * 1.25)
    a2.grid(False)
    for (i, j), v in np.ndenumerate(m):
        a2.text(j, i, str(v), ha="center", va="center", fontsize=16, fontweight="bold", color=INK)
    a2.set_xticks([0, 1], ["not flagged", "flagged"]); a2.set_yticks([0, 1], ["reference\ntask", "comparison\ntask"])
    a2.set_xlabel("model at the deployed threshold"); a2.set_ylabel("window's task group")
    a2.set_title(f"precision {summ['precision']:.3f} · recall {summ['recall']:.3f}", loc="left", fontsize=11.5,
                 fontweight="bold")
    fig.suptitle("Held-out test workers 12–13: errors and the deployed threshold", x=0.01, ha="left", fontsize=13,
                 fontweight="bold", color=INK)
    footer(fig, "Threshold = 90th percentile of reference-task validation error (users 10–11), stored in models/keypoint/config.json "
                "and used by the API. 'Comparison' is a task group, not a label of unsafe or abnormal movement.\nSource: "
                "models/keypoint/model.onnx re-scored by 01_autoencoder/evaluate_deployed_keypoint.py → "
                "reports/keypoint/deployed_window_errors.csv, deployed_eval_summary.json")
    fig.tight_layout(rect=(0, 0.1, 1, 0.94))
    fig.savefig(OUT / "keypoint_test_errors.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    training_loss(); setup_comparison(); test_errors()
    print("wrote", sorted(p.name for p in OUT.glob("*.png")))
