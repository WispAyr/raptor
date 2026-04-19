#!/usr/bin/env python3
"""
Constellation Mask Generator
=============================
Samples the night sky background to identify static bright points (stars)
and generates a binary exclusion mask to suppress flickering-star false triggers.

Matches the UFODAP OTDAU "background sky sampling" feature.

Usage:
  mask = ConstellationMask(frame_w=1280, frame_h=720)
  for frame in first_30_frames:
      mask.add_frame(frame)
  mask.build()
  masked_fg = mask.apply(fg_mask)
"""
import numpy as np
import cv2
from pathlib import Path


class ConstellationMask:
    """
    Builds a static-object exclusion mask by accumulating bright pixel positions
    across the first N frames of a night-sky feed.
    """

    def __init__(self, frame_w: int, frame_h: int, sample_frames: int = 60,
                 star_brightness_threshold: int = 200, dilation_radius: int = 4):
        self.frame_w  = frame_w
        self.frame_h  = frame_h
        self.sample_frames = sample_frames
        self.star_thresh   = star_brightness_threshold
        self.dilation      = dilation_radius

        self._accumulator = np.zeros((frame_h, frame_w), dtype=np.float32)
        self._frames_added = 0
        self._mask = None       # White = detect here; Black = ignore
        self._built = False

    @property
    def ready(self) -> bool:
        return self._built

    def add_frame(self, frame: np.ndarray):
        """Add a raw camera frame to the accumulator. Call for each frame during sampling."""
        if self._built or self._frames_added >= self.sample_frames:
            return
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        resized = cv2.resize(grey, (self.frame_w, self.frame_h))
        # Accumulate: bright pixels that persist across frames are stars
        bright = (resized > self.star_thresh).astype(np.float32)
        self._accumulator += bright
        self._frames_added += 1

        if self._frames_added >= self.sample_frames:
            self.build()

    def build(self):
        """Build the mask from accumulated frames."""
        if self._frames_added == 0:
            self._mask = np.ones((self.frame_h, self.frame_w), dtype=np.uint8) * 255
            self._built = True
            return

        # Pixels bright in >60% of sampled frames are considered static stars
        threshold_frames = self._frames_added * 0.6
        star_map = (self._accumulator >= threshold_frames).astype(np.uint8) * 255

        # Dilate star positions slightly — stars flicker into neighbouring pixels
        if self.dilation > 0:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (self.dilation*2+1, self.dilation*2+1))
            star_map = cv2.dilate(star_map, kernel)

        # Invert: mask = white where we SHOULD detect (i.e. non-star pixels)
        self._mask = cv2.bitwise_not(star_map)
        self._built = True

    def apply(self, fg_mask: np.ndarray) -> np.ndarray:
        """Apply the exclusion mask to a foreground mask. Returns masked result."""
        if not self._built or self._mask is None:
            return fg_mask
        mask_resized = cv2.resize(self._mask, (fg_mask.shape[1], fg_mask.shape[0]))
        return cv2.bitwise_and(fg_mask, mask_resized)

    def save(self, path: str):
        if self._mask is not None:
            cv2.imwrite(path, self._mask)

    def load(self, path: str) -> bool:
        if Path(path).exists():
            self._mask = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            self._built = True
            return True
        return False

    def visualise(self) -> np.ndarray:
        """Return a colour visualisation of the mask for debugging."""
        if self._mask is None:
            return np.zeros((self.frame_h, self.frame_w, 3), dtype=np.uint8)
        vis = cv2.cvtColor(self._mask, cv2.COLOR_GRAY2BGR)
        # Overlay red where stars were detected
        star_overlay = cv2.bitwise_not(self._mask)
        vis[star_overlay > 0] = [0, 0, 180]
        return vis
