#!/usr/bin/env python3
"""
Night Mode Processor
====================
Adaptive preprocessing for low-light and IR camera feeds.
- Auto-detects ambient light level from frame luminance
- Applies adaptive gamma / CLAHE enhancement in low light
- Auto-tunes MOG2 background subtractor parameters for night vs. day
- Provides false-colour mapping for IR/thermal feeds

Usage: imported by detector.py
"""
import numpy as np
import cv2


# Luminance thresholds (mean pixel value in grayscale, 0-255)
NIGHT_THRESHOLD = 60    # Below this = night mode
DAY_THRESHOLD   = 100   # Above this = day mode


class NightModeProcessor:
    """
    Adaptive frame pre-processor that switches between day and night
    processing parameters based on measured frame luminance.
    """

    def __init__(self, ir_mode: bool = False):
        self.ir_mode     = ir_mode
        self._is_night   = False
        self._clahe      = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        self._luma_ema   = None   # Exponential moving average of luminance
        self._luma_alpha = 0.05   # EMA smoothing factor

    @property
    def is_night(self) -> bool:
        return self._is_night

    def process(self, frame: np.ndarray) -> tuple[np.ndarray, dict]:
        """
        Process a frame and return enhanced frame + metadata dict.
        Returns: (enhanced_frame, {'is_night': bool, 'luminance': float, 'mode': str})
        """
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame.copy()

        # Update luminance EMA
        luma = float(np.mean(grey))
        if self._luma_ema is None:
            self._luma_ema = luma
        else:
            self._luma_ema = self._luma_alpha * luma + (1 - self._luma_alpha) * self._luma_ema

        # Update night/day state with hysteresis
        if self._luma_ema < NIGHT_THRESHOLD:
            self._is_night = True
        elif self._luma_ema > DAY_THRESHOLD:
            self._is_night = False

        if self.ir_mode:
            enhanced = self._process_ir(frame)
            mode = 'ir'
        elif self._is_night:
            enhanced = self._process_night(frame, grey)
            mode = 'night'
        else:
            enhanced = frame
            mode = 'day'

        return enhanced, {
            'is_night': self._is_night,
            'luminance': round(self._luma_ema, 1),
            'mode': mode,
        }

    def _process_night(self, frame: np.ndarray, grey: np.ndarray) -> np.ndarray:
        """Enhance a low-light colour frame."""
        # Apply CLAHE to luminance channel (YCrCb colour space)
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        ycrcb[:, :, 0] = self._clahe.apply(ycrcb[:, :, 0])
        enhanced = cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR)
        return enhanced

    def _process_ir(self, frame: np.ndarray) -> np.ndarray:
        """Apply false-colour mapping for IR/thermal frames."""
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        # Apply CLAHE for contrast
        enhanced_grey = self._clahe.apply(grey)
        # Map to INFERNO colourmap (hot objects appear bright)
        false_colour = cv2.applyColorMap(enhanced_grey, cv2.COLORMAP_INFERNO)
        return false_colour

    def get_bg_subtractor_params(self) -> dict:
        """
        Return tuned MOG2 parameters based on current light conditions.
        Night: higher sensitivity, more history, lower threshold.
        Day:   standard parameters.
        """
        if self._is_night:
            return dict(history=300, varThreshold=25, detectShadows=False)
        return dict(history=200, varThreshold=40, detectShadows=False)

    def get_blob_params(self) -> dict:
        """Return tuned blob detection min area based on conditions."""
        # At night, objects may appear smaller due to lower resolution/sensitivity
        return {'min_area': 30 if self._is_night else 40}
