"""Re-score the deployed keypoint autoencoder on the VTT-ConIoT splits and write its per-window errors.

Reads only existing artifacts: the dataset keypoint CSVs (data/, not in Git), models/keypoint/model.onnx,
models/keypoint/scaler.npz and models/keypoint/config.json (the files published to Hugging Face and loaded by
the Render API). Nothing is trained and no model file is changed.

Writes:
  reports/keypoint/deployed_window_errors.csv   one row per validation/test window: split, user, task, label, mse
  reports/keypoint/deployed_eval_summary.json   counts, mean MSEs, both thresholds and the test metrics at each

Run from the repository root:  python 01_autoencoder/evaluate_deployed_keypoint.py
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from sklearn.decomposition import PCA
from sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "01_autoencoder"))
import keypoint_utils as ku  # noqa: E402

DATA_DIR = ROOT / "data" / "VTT_ConIot_Dataset" / "VTT-ConIoT-Video-Keypoints"
MODEL_DIR = ROOT / "models" / "keypoint"
OUT_DIR = ROOT / "reports" / "keypoint"
SEED = 42  # as in keypoint_anomaly.ipynb


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    config = json.loads((MODEL_DIR / "config.json").read_text(encoding="utf-8"))
    pmin = float(config["pmin"])
    d = ku.build_splits(DATA_DIR, pmin=pmin)

    # build_splits standardizes with a scaler fitted on the normal training windows; check it is the deployed one.
    with np.load(MODEL_DIR / "scaler.npz") as s:
        mean, scale = s["mean"], s["scale"]
    scaler_matches = bool(np.allclose(mean, d["mean"]) and np.allclose(scale, d["scale"]))
    # Always score with the deployed scaler (undo the rebuilt one first), exactly as the API does.
    restd = lambda a: (((a * d["scale"] + d["mean"]) - mean) / scale).astype(np.float32)
    d["val_x"], d["test_x"] = restd(d["val_x"]), restd(d["test_x"])

    session = ort.InferenceSession(str(MODEL_DIR / "model.onnx"), providers=["CPUExecutionProvider"])

    def mse(x: np.ndarray) -> np.ndarray:
        out = []
        for i in range(0, len(x), 256):
            batch = x[i:i + 256].astype(np.float32)
            _, rec = session.run(["embedding", "reconstruction"], {"keypoint_window": batch})
            out.append(((rec - batch) ** 2).mean(axis=(1, 2)))
        return np.concatenate(out)

    val_err, test_err = mse(d["val_x"]), mse(d["test_x"])
    labels = d["test_label"].astype(int)

    def at(cut: float) -> dict:
        pred = (test_err > cut).astype(int)
        tn, fp, fn, tp = confusion_matrix(labels, pred, labels=[0, 1]).ravel()
        return {"threshold": cut, "precision": float(precision_score(labels, pred, zero_division=0)),
                "recall": float(recall_score(labels, pred, zero_division=0)),
                "f1": float(f1_score(labels, pred, zero_division=0)),
                "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}

    # The two reference methods, recomputed exactly as in keypoint_anomaly.ipynb (cell 8), to cross-check its table.
    flat = lambda a: a.reshape(len(a), -1)
    pca = PCA(8, random_state=SEED).fit(flat(d["train_x"]))
    pca_err = lambda a: ((flat(a) - pca.inverse_transform(pca.transform(flat(a)))) ** 2).mean(1)
    dev = lambda a: (a ** 2).mean(axis=(1, 2))
    references = {}
    for name, fn in [("Reference: PCA, 8 components", pca_err), ("Reference: pose deviation", dev)]:
        v, t = fn(d["val_x"]), fn(d["test_x"])
        cut = float(np.percentile(v, 90)); pred = (t > cut).astype(int)
        references[name] = {"validation_mse_mean": float(v.mean()) if "PCA" in name else None,
                            "test_roc_auc": float(roc_auc_score(labels, t)), "threshold": cut,
                            "precision": float(precision_score(labels, pred, zero_division=0)),
                            "recall": float(recall_score(labels, pred, zero_division=0))}

    p90 = float(np.percentile(val_err, 90))
    summary = {
        "model_file": "models/keypoint/model.onnx", "model_sha256": sha256(MODEL_DIR / "model.onnx"),
        "scaler_sha256": sha256(MODEL_DIR / "scaler.npz"), "scaler_matches_rebuilt_training_scaler": scaler_matches,
        "pmin": pmin,
        "windows": {"train": int(len(d["train_x"])), "validation": int(len(val_err)), "test": int(len(test_err)),
                    "test_reference": int((labels == 0).sum()), "test_comparison": int((labels == 1).sum())},
        "validation_mse_mean": float(val_err.mean()), "test_mse_mean": float(test_err.mean()),
        "test_roc_auc": float(roc_auc_score(labels, test_err)),
        "validation_p90_recomputed": at(p90),
        "deployed_config_threshold": at(float(config["threshold_mse"])),
        "reference_methods_recomputed": references,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = ["split,user,task,label,mse"]
    rows += [f"validation,{int(u)},{int(t)},0,{e:.6f}" for (u, t), e in zip(d["val_meta"][:, :2], val_err)]
    rows += [f"test,{int(u)},{int(t)},{int(l)},{e:.6f}" for (u, t), l, e in zip(d["test_meta"][:, :2], labels, test_err)]
    (OUT_DIR / "deployed_window_errors.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (OUT_DIR / "deployed_eval_summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
