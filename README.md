# Motion Atlas: movement deviation review for construction work

**Project:** AI Methods I hackathon, Group 3 (IAAC, MaAI 2026/27)
**Dataset:** [VTT-ConIoT](https://doi.org/10.5281/zenodo.4683703): 13 construction workers, 16 activities, wearable IMU and video pose keypoints

Motion Atlas lets a site lead pick a work video and see **when a worker's movement differs from reference movement**. The video is processed in the browser and is never uploaded: only body keypoints are sent for scoring. An autoencoder trained on reference movement rebuilds each 1.92-second pose window, and windows it rebuilds badly are flagged for review.

> **What the score is, and is not.** The score is a reconstruction error: how far a movement is from the model's reference data. It is not a measure of fatigue, workload, injury risk or safety, and it is not a diagnosis. The dataset has no such labels.

![System architecture: browser, Cloudflare Worker, Render scoring API and D1](04_final/diagrams/system-architecture.png)

## Status

| Part | Folder | Status |
|---|---|---|
| IMU autoencoders (Day 1) | `src/`, `models/`, `reports/` | Done: three models compared (see [Day 1](#day-1-imu-autoencoders)) |
| Video-keypoint autoencoder | `01_autoencoder/` | Done: three autoencoders and two reference methods compared; the dense AE (16-value code) is deployed |
| Scoring API (FastAPI + ONNX, on Render) | `02_model_server/` | Deployed; keypoint model in use by the app |
| Web app (React + Cloudflare Worker + D1) | `03_app/` | Deployed: login, video analysis, History, Schedule, multi-person (experimental) |
| Model evaluation tab (interactive 3D graphs) | `03_app/public/graphs/` | Added in this branch, local tests pass, not yet deployed |
| Final diagrams | `04_final/diagrams/` | Done: four SVG + PNG diagrams |

Checks: the app's test suite (`npm test` in `03_app`) passes, 145 tests; the app and Worker typecheck cleanly.

## How it works

1. **In the browser:** MoveNet (TensorFlow.js) extracts 17 body keypoints per frame at 25 fps. The video never leaves the browser.
2. **Cloudflare Worker** (`03_app/worker/`): checks the login session and forwards the keypoints to the scoring API.
3. **Scoring API on Render** (`02_model_server/`): normalizes the pose, cuts 48-frame windows, runs the ONNX autoencoder and returns one score per window, the threshold, and an approximate 2D posture summary.
4. **Back in the browser:** a score timeline, flagged moments you can jump to in the local video, the skeleton drawn over the video, and input-quality warnings.
5. **History (Cloudflare D1):** each analysis summary is saved to the user's account (scores and times only; never video, keypoints or file names).

The **Schedule** tab drafts a shift plan with breaks; it stays on the page and is not saved. **Multi-person** analysis tracks several people (A, B, C…) and scores each track; it is experimental and is not saved to History.

## The keypoint model

Each input is a window of **48 frames (1.92 s at 25 fps) × 17 joints × (x, y) = 1,632 values**. Coordinates are centered on the hips, scaled by torso length and standardized with training statistics. Low-confidence points are interpolated, and windows with more than 30% missing points are dropped.

- **Reference ("normal") movement:** tasks 13, 14 and 15 (walking straight, winding walking, pushing a cart). The model is trained only on these.
- **Comparison movement:** tasks 7, 8, 11 and 12, used only for evaluation.
- **Participant split:** users 1–9 train, 10–11 validation, 12–13 test. No participant appears in two splits.
- **Threshold:** the 90th percentile of reference validation error. A window above it is flagged.

| Setup | Parameters | Val MSE (reference) | Test ROC AUC | Test precision | Test recall | Threshold |
|---|---:|---:|---:|---:|---:|---:|
| **A Dense, latent 16 (deployed)** | 423,792 | 0.2086 | 0.788 | 0.881 | 0.536 | 0.6765 |
| B Conv1d, latent 16 | 78,066 | 0.3073 | 0.801 | 0.885 | 0.496 | 1.1696 |
| C Conv1d, latent 8 | 71,914 | 0.3067 | 0.809 | 0.895 | 0.552 | 1.1584 |
| Reference: PCA, 8 components | 13,056 | 0.267 | 0.766 | 0.238 | 0.02 | 1.0259 |
| Reference: pose deviation | — | — | 0.843 | 0.891 | 0.657 | 1.8396 |

Source: [`reports/keypoint/setups_table.csv`](reports/keypoint/setups_table.csv). On the held-out test workers (396 windows), the deployed model flags 133 of 248 comparison windows and 18 of 148 reference windows (F1 0.667).

**Threshold note:** re-scoring the saved ONNX model gives a validation 90th percentile of **0.67649**, the value in the table above. The deployed `config.json` stores **0.65884**, from a different calibration. The API uses the stored value.

The **Model** tab in the app shows this evaluation as interactive 3D graphs: input vs reconstruction motion tracks, the validation error distribution, a per-window score track for one held-out recording, the confusion matrix with a movable threshold, and split coverage. Drag a graph to rotate it. In the motion track, trails are drawn on a schematic body layout; each joint's displacement is its standardized coordinate, not a real-world position.

## Repository map

| Path | Contents |
|---|---|
| `01_autoencoder/` | Keypoint autoencoder notebook, video-to-keypoints converter, scoring utilities |
| `02_model_server/` | FastAPI + Gradio scoring service, Render blueprint, tests ([README](02_model_server/README.md)) |
| `03_app/` | Motion Atlas web app: React (Vite), Cloudflare Worker, D1 migrations, tests ([README](03_app/README.md)) |
| `04_final/diagrams/` | Final presentation diagrams, editable SVG + PNG ([README](04_final/diagrams/README.md)) |
| `hf_upload/` | Model files (`model.onnx`, `scaler.npz`, `config.json`) as published to Hugging Face for the API |
| `models/`, `reports/` | Model weights, scalers, configs, metrics and figures (IMU and keypoint) |
| `src/` | Day 1 IMU training scripts |
| `slides/` | Day 1 presentation |
| `model_app/` | The course's example model server (Fashion-MNIST); a reference, not part of Motion Atlas |
| `data/` | Local dataset files; not in Git |

## Running it locally

Model API (Python), from the repository root:

```powershell
python -m pip install -r 02_model_server/requirements.txt
python -m uvicorn app:app --app-dir 02_model_server --host 127.0.0.1 --port 8000
```

Web app (Node.js 22.6 or newer), in a second terminal:

```powershell
cd 03_app
npm install
copy .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET (npx @better-auth/cli secret)
npm run db:migrate:local
npm run dev                        # open http://localhost:5173 and sign up
```

The local database is separate from the deployed one, so create a local account. Deployment steps (D1, secrets, `npm run deploy`) are in [`03_app/README.md`](03_app/README.md).

## Limits

- **One reference activity group.** The model learned walking and cart pushing; any other activity scores as "different", by design. A flag means "review this window", not "this movement is wrong".
- **Recall is moderate.** About half of the comparison windows stay under the threshold (recall 0.536).
- **Two test workers.** Only participants 12 and 13 were held out, so results may not generalize to other people or camera setups.
- **2D pose from one camera.** MoveNet keypoints are approximate; knees and ankles are often missed, and the app warns when they are. The training data's pose detector is unknown.
- **Prototype security.** Sign-up is open and emails are not verified. Do not analyse confidential footage or sensitive personal data.

## Day 1: IMU autoencoders

*Monday 16 November 2026.* The first day explored the wearable-sensor (IMU) recordings before the project moved to video keypoints.

- Loaded and audited **207 IMU recordings** from 13 participants performing up to 16 activities.
- Prepared fixed-length sensor windows and split participants, not individual windows, between training, validation and test sets.
- Trained and compared a dense autoencoder and two 1D convolutional autoencoders.
- Saved model weights, input-scaling values, configuration files, metrics, loss curves and test reconstruction plots.

### Dataset

VTT-ConIoT contains wearable inertial-sensor measurements from **13 people** performing **16 activities** relevant to construction work. Sensors are worn at the **trousers, back, and hand**. The archive also contains video-derived body-pose keypoint CSVs.

The activities are roll painting, spraying paint, levelling paint, vacuum cleaning, picking objects, climbing stairs, jumping down, laying back, hands-up work at high and low levels, crouching on the floor, kneeling on the floor, walking straight, walking winding, pushing a cart, and stairs up-down.

The models use **18 channels**: acceleration (`Ax`, `Ay`, `Az`) and gyroscope (`Gx`, `Gy`, `Gz`) at each of the three sensor locations. Timestamps, magnetometer, barometer, and precomputed total-magnitude fields are not model inputs in these runs.

### Preprocessing and splits

- Sampling rate: **100 Hz**.
- Window length: **200 samples (2 seconds)**.
- Training stride: **100 samples (1 second)**; evaluation stride: **200 samples (2 seconds)**.
- Each channel is standardized using the mean and standard deviation from training participants only.
- Participant split: users **1–9** for training, **10–11** for validation, and **12–13** for testing. Participants do not overlap between splits.
- Random seed: **42**; batch size: **128**; maximum: **30 epochs**; early-stopping patience: **5**.
- Resulting windows: **8,295 train / 929 validation / 928 test**.

Activity labels are retained as metadata for analysis; the autoencoders learn by reconstructing their input windows.

### Model comparison

All three models used the same sensor channels, participant split, windowing, and standardization. MSE is calculated on standardized sensor signals; lower values mean more accurate reconstruction. The baseline reconstructs each channel as zero after standardization (the training-set mean).

| Setup | Architecture | Latent size | Parameters | Best validation MSE | Test MSE |
|---|---|---:|---:|---:|---:|
| 1 | Dense autoencoder | 32 | 1,884,336 | **0.43460** | **0.34056** |
| 2 | 1D convolutional autoencoder | 32 | 164,786 | 0.46382 | 0.36872 |
| 3 | 1D convolutional autoencoder | 16 | 113,570 | 0.56310 | 0.45708 |
| Baseline | Training-channel mean | — | — | — | 1.01121 |

Parameter counts are derived from each model’s layer dimensions. The dense AE has the lowest test MSE in these runs, about **66% below the baseline**. The 32-value convolutional AE is close, with about **64% lower** test MSE, while using substantially fewer parameters. Reducing the convolutional latent size to 16 increases test error to 0.45708, showing a reconstruction trade-off from stronger compression.

Training time was not recorded in the metrics files, so it is not included here.

### Training curves

Training and validation loss both fall across the runs. Validation loss stays above training loss, but does not turn upward late in training. This shows a generalization gap without a clear late-epoch validation collapse.

| Dense AE | Conv AE, latent 32 | Conv AE, latent 16 |
|---|---|---|
| ![Dense AE training and validation loss](reports/loss_curve.png) | ![Convolutional AE with 32 latent values: training and validation loss](reports/conv1d_v2/loss_curve.png) | ![Convolutional AE with 16 latent values: training and validation loss](reports/conv1d_latent16/loss_curve.png) |

### Test reconstructions

These plots compare original and reconstructed signals for one fixed test window from `activity_10_user_12_combined.csv`. The models generally follow broad trends, but smooth or miss some abrupt peaks and dips. This is visible in all three plots and is an important limitation for short, sharp movements.

| Dense AE | Conv AE, latent 32 | Conv AE, latent 16 |
|---|---|---|
| ![Dense AE test-window reconstruction](reports/reconstruction.png) | ![Convolutional AE with 32 latent values: test-window reconstruction](reports/conv1d_v2/reconstruction.png) | ![Convolutional AE with 16 latent values: test-window reconstruction](reports/conv1d_latent16/reconstruction.png) |

### Re-running the IMU models

Run from the repository root in a Python environment with PyTorch, NumPy, pandas and Matplotlib installed (`requirements-train.txt`). The dataset must be extracted under `data/VTT_ConIot_Dataset/`.

```powershell
python .\src\train_autoencoder.py
python ".\src\train_autoencoder v2.py"
python .\src\train_autoencoder_conv16.py
```

Each script writes its model artifacts and reports to the corresponding folders under `models/` and `reports/`.

## Source and attribution

Dataset: [VTT-ConIoT on Zenodo](https://doi.org/10.5281/zenodo.4683703). The course `DATASETS.md` lists the dataset as CC BY 4.0; cite the dataset and paper when using it, and check the source record before redistributing raw files.

Mäkelä, S.-M., Lämsä, A., Keränen, J. S., Liikka, J., Ronkainen, J., Peltola, J., Häikiö, J., Järvinen, S., & López, M. B. (2022). “Introducing VTT-ConIoT: A Realistic Dataset for Activity Recognition of Construction Workers Using IMU Devices.” *Sustainability, 14*(1), 220. [https://doi.org/10.3390/su14010220](https://doi.org/10.3390/su14010220).
