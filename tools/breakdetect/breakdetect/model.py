import json
from dataclasses import dataclass

import numpy as np

from breakdetect.signals import SIGNAL_NAMES

MAX_ITERATIONS = 100
TOLERANCE = 1e-8


@dataclass
class LogisticModel:
    mean: np.ndarray
    std: np.ndarray
    weights: np.ndarray
    bias: float
    l2: float

    @classmethod
    def fit(cls, X: np.ndarray, y: np.ndarray, l2: float = 1.0) -> "LogisticModel":
        mean = X.mean(axis=0)
        std = np.where(X.std(axis=0) == 0, 1.0, X.std(axis=0))
        design = np.hstack([(X - mean) / std, np.ones((len(X), 1))])
        theta = _newton(design, y.astype(np.float64), _class_weights(y), l2)
        return cls(mean, std, theta[:-1], float(theta[-1]), l2)

    def predict(self, X: np.ndarray) -> np.ndarray:
        return _sigmoid(((X - self.mean) / self.std) @ self.weights + self.bias)

    def to_json(self) -> str:
        return json.dumps(
            {
                "signal_names": SIGNAL_NAMES,
                "mean": self.mean.tolist(),
                "std": self.std.tolist(),
                "weights": self.weights.tolist(),
                "bias": self.bias,
                "l2": self.l2,
            },
            indent=2,
        )

    @classmethod
    def from_json(cls, raw: str) -> "LogisticModel":
        data = json.loads(raw)
        if data["signal_names"] != SIGNAL_NAMES:
            raise ValueError(f"model signals {data['signal_names']} do not match {SIGNAL_NAMES}")
        return cls(np.array(data["mean"]), np.array(data["std"]), np.array(data["weights"]), data["bias"], data["l2"])


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -500, 500)))


def _class_weights(y: np.ndarray) -> np.ndarray:
    positives = y == 1
    return np.where(positives, 0.5 / positives.sum(), 0.5 / (~positives).sum()) * len(y)


def _newton(design: np.ndarray, y: np.ndarray, sample_weights: np.ndarray, l2: float) -> np.ndarray:
    theta = np.zeros(design.shape[1])
    penalty = np.full(design.shape[1], l2)
    penalty[-1] = 0.0
    for _ in range(MAX_ITERATIONS):
        p = _sigmoid(design @ theta)
        gradient = design.T @ (sample_weights * (p - y)) + penalty * theta
        hessian = (design * (sample_weights * p * (1 - p))[:, None]).T @ design + np.diag(penalty)
        step = np.linalg.solve(hessian + 1e-10 * np.eye(len(theta)), gradient)
        theta -= step
        if np.abs(step).max() < TOLERANCE:
            break
    return theta
