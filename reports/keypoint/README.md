# Keypoint model reports

This folder holds evidence from **two** training runs. Only one of them is deployed.

## Deployed model (use these)

The deployed model is `models/keypoint/model.onnx` (SHA-256 `67fc9551…`), with the live threshold 0.6588 from `models/keypoint/config.json`.

| File | Contents |
|---|---|
| [`deployed_eval_summary.json`](deployed_eval_summary.json) | Re-scored metrics for the deployed ONNX file: validation MSE 0.2079, test ROC AUC 0.784, precision 0.846, recall 0.419, confusion TN 129 / FP 19 / FN 144 / TP 104 |
| [`deployed_run_setups_table.csv`](deployed_run_setups_table.csv) | Setups A–C and the two reference methods from the deployed run |
| [`deployed_run_training_history.csv`](deployed_run_training_history.csv) | Per-epoch training and validation loss from the deployed run |
| [`deployed_window_errors.csv`](deployed_window_errors.csv) | Per-window reconstruction error from the deployed model (validation and test splits) |

## Legacy evidence from the non-deployed run (do not cite as deployed results)

These files are kept for the record. They come from a different training run whose weights are not in this repository, so they cannot be reproduced. They do **not** describe the deployed model.

| File | Contents |
|---|---|
| [`setups_table.csv`](setups_table.csv) | **Legacy.** Setup comparison from the non-deployed run (setup A: validation MSE 0.2086, threshold 0.6765, ROC AUC 0.788, precision 0.881, recall 0.536) |
| [`pmin_sensitivity.csv`](pmin_sensitivity.csv) | **Legacy.** `pmin` sensitivity check from the non-deployed run |
| [`keypoint_anomaly_figure.png`](keypoint_anomaly_figure.png) | **Legacy.** Evaluation figure from the non-deployed run |

## Other

[`posture_angles_by_task.csv`](posture_angles_by_task.csv) and [`posture_angles_figure.png`](posture_angles_figure.png) describe the keypoint data itself (posture angles by activity). They are not model outputs.
