#!/usr/bin/env python3
"""Grid CO₂ intensity model for Germany – standard library only.

There is no clean, key-free real-time carbon API, so we use a transparent
*model*: a base intensity anchored to the published German grid average
(~380 g CO₂eq/kWh in recent years, trending down) shaped by month and hour of
day. The shape follows renewable availability – lower around midday and in
summer (much solar/wind on the grid), higher on winter evenings (more fossil
back-up). The consuming code weights this with the user's own load profile.

If a real feed is ever wired in, only ``month_hour_grid`` needs to change; the
front-end contract stays the same.
"""

from __future__ import annotations

import time

# German grid average, g CO₂eq/kWh. Umweltbundesamt: ~434 (2022), ~380 (2023),
# ~363 (2024). We use a slightly conservative round figure.
BASE_G = 380.0

# Seasonal shape (mean ≈ 1): winters lean fossil, summers lean solar.
MONTH_FACTOR = [1.14, 1.11, 1.02, 0.93, 0.85, 0.81, 0.82, 0.85, 0.94, 1.04, 1.12, 1.17]

# Hour-of-day shape (mean ≈ 1): a solar dip around noon, an evening fossil peak.
HOUR_FACTOR = [1.05, 1.07, 1.07, 1.06, 1.05, 1.03, 0.99, 0.94, 0.88, 0.82, 0.77, 0.74,
               0.73, 0.75, 0.80, 0.88, 0.98, 1.09, 1.15, 1.16, 1.13, 1.10, 1.08, 1.06]


def month_hour_grid(base: float = BASE_G) -> list[list[float]]:
    """12×24 grid of g CO₂eq/kWh (month × hour)."""
    return [[round(base * MONTH_FACTOR[m] * HOUR_FACTOR[h], 1) for h in range(24)]
            for m in range(12)]


def payload(base: float = BASE_G) -> dict:
    """Everything the front-end needs: the grid, its month/annual averages and
    the intensity curve for the current month (for a 'today' chart)."""
    grid = month_hour_grid(base)
    month_avg = [round(sum(grid[m]) / 24, 1) for m in range(12)]
    annual = round(sum(month_avg) / 12, 1)
    m = time.localtime().tm_mon - 1
    return {"ok": True, "base_g": round(base, 1), "annual_g": annual,
            "month_hour_g": grid, "month_avg_g": month_avg,
            "hour_g": grid[m], "month": m + 1}
